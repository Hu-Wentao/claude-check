import { LANGUAGES, SWITCH_FILES, TIME_ZONES } from '../generated/catalog';
import { PATCH_FILE, RESOURCE_TYPES, SCRIPT_ID } from '../shared/constants';
import { exactHostRegex, originPatterns, urlMatchesSite, type SiteEntry } from './sites';
import { loadSettings, type Settings } from './settings';

let chain: Promise<void> = Promise.resolve();

export function scheduleRebuild(): void {
  chain = chain.then(() => rebuildAll()).catch((err) => console.error('slc', err));
}

interface GrantedSite extends SiteEntry {
  matches: string[];
}

export async function rebuildAll(): Promise<void> {
  const settings = await loadSettings();
  const grantedSites = await filterGranted(settings.sites);
  await syncRules(settings, grantedSites);
  await syncScripts(settings, grantedSites);
  await updateBadges(settings);
}

async function filterGranted(sites: SiteEntry[]): Promise<GrantedSite[]> {
  const kept: GrantedSite[] = [];
  for (const site of sites) {
    const matches: string[] = [];
    for (const pattern of originPatterns(site)) {
      if (await chrome.permissions.contains({ origins: [pattern] })) matches.push(pattern);
    }
    if (!matches.length) continue;
    kept.push({
      ...site,
      matches,
      includeSubdomains: matches.some((pattern) => pattern.includes('://*.')),
    });
  }
  return kept;
}

function acceptLanguage(settings: Settings): string {
  const found = LANGUAGES.find((item) => item.tag === settings.languageTag);
  if (found) return found.acceptLanguage;
  const primary = settings.languageTag.split('-')[0] || settings.languageTag;
  if (primary && primary !== settings.languageTag) return `${settings.languageTag},${primary};q=0.9`;
  return settings.languageTag || 'en-US,en;q=0.9';
}

async function syncRules(settings: Settings, sites: GrantedSite[]): Promise<void> {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((rule) => rule.id);
  const addRules: chrome.declarativeNetRequest.Rule[] = [];
  if (settings.enabled && settings.language) {
    const value = acceptLanguage(settings);
    sites.forEach((site, index) => {
      const condition: chrome.declarativeNetRequest.RuleCondition = {
        requestDomains: [site.host],
        resourceTypes: [...RESOURCE_TYPES] as chrome.declarativeNetRequest.ResourceType[],
      };
      if (!site.includeSubdomains) condition.regexFilter = exactHostRegex(site);
      addRules.push({
        id: index + 1,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{ header: 'Accept-Language', operation: 'set', value }],
        },
        condition,
      });
    });
  }
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  } catch (err) {
    const filtered = addRules.filter((rule) => !/^\d{1,3}(\.\d{1,3}){3}$/.test(rule.condition.requestDomains?.[0] || ''));
    if (filtered.length === addRules.length) throw err;
    filtered.forEach((rule, index) => {
      rule.id = index + 1;
    });
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: filtered });
  }
}

export function contentScriptFiles(settings: Settings): string[] {
  const tz = TIME_ZONES.find((item) => item.id === settings.timeZoneId) ?? TIME_ZONES[0];
  const lang = LANGUAGES.find((item) => item.tag === settings.languageTag) ?? LANGUAGES[0];
  const file = (on: boolean, pair: { on: string; off: string }) => (on ? pair.on : pair.off);
  return [
    tz.file,
    lang.file,
    file(settings.timezone, SWITCH_FILES.timezone),
    file(settings.timezoneOffset, SWITCH_FILES.timezoneOffset),
    file(settings.language, SWITCH_FILES.language),
    file(settings.intlLocale, SWITCH_FILES.intlLocale),
    PATCH_FILE,
  ];
}

async function syncScripts(settings: Settings, sites: GrantedSite[]): Promise<void> {
  const existing = await chrome.scripting.getRegisteredContentScripts();
  const ids = existing.map((script) => script.id);
  if (ids.length) await chrome.scripting.unregisterContentScripts({ ids });

  const matches = [...new Set(sites.flatMap((site) => site.matches))];
  const active = settings.enabled && (settings.timezone || settings.timezoneOffset || settings.language || settings.intlLocale);
  if (!active || !matches.length) return;

  // Chrome's dynamic API has rejected matchAboutBlank since the scripting schema
  // dropped it. matchOriginAsFallback still injects about:blank and srcdoc frames.
  // Older builds that accept the property keep it.
  const script: chrome.scripting.RegisteredContentScript & { matchAboutBlank?: boolean } = {
    id: SCRIPT_ID,
    js: contentScriptFiles(settings),
    matches,
    allFrames: true,
    matchAboutBlank: true,
    matchOriginAsFallback: true,
    runAt: 'document_start',
    world: 'MAIN',
    persistAcrossSessions: true,
  };
  await registerMain(script);
}

async function registerMain(script: chrome.scripting.RegisteredContentScript & { matchAboutBlank?: boolean }): Promise<void> {
  try {
    await chrome.scripting.registerContentScripts([script]);
  } catch (err) {
    if (!script.matchAboutBlank || !/matchAboutBlank/i.test(String(err))) throw err;
    const { matchAboutBlank: _ignored, ...fallback } = script;
    await chrome.scripting.registerContentScripts([fallback]);
  }
}

function badgeText(kind: 'on' | 'off' | 'unknown'): string {
  if (kind === 'on') return chrome.i18n.getMessage('badgeOn') || 'ON';
  if (kind === 'unknown') return chrome.i18n.getMessage('badgeUnknown') || '?';
  return chrome.i18n.getMessage('badgeOff') || 'OFF';
}

export async function updateBadges(settings?: Settings): Promise<void> {
  const current = settings ?? (await loadSettings());
  const master = current.enabled ? 'on' : 'off';
  await chrome.action.setBadgeText({ text: badgeText(master) });
  await chrome.action.setBadgeBackgroundColor({ color: current.enabled ? '#0f7b3a' : '#5c6570' });
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id == null) continue;
    let kind: 'on' | 'off' | 'unknown' = 'off';
    if (current.enabled) {
      if (!tab.url) kind = 'unknown';
      else if (urlMatchesSite(tab.url, current.sites)) kind = 'on';
    }
    const color = kind === 'on' ? '#0f7b3a' : kind === 'unknown' ? '#8a6a00' : '#5c6570';
    await chrome.action.setBadgeText({ tabId: tab.id, text: badgeText(kind) });
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color });
  }
}

export function patternsForSites(sites: SiteEntry[]): string[] {
  return [...new Set(sites.flatMap((site) => originPatterns(site)))];
}
