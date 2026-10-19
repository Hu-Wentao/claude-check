import { LANGUAGES, SWITCH_FILES, TIME_ZONES } from '../generated/catalog';
import { DNR_NOTES_KEY, PATCH_FILE, RESOURCE_TYPES, SCRIPT_ID } from '../shared/constants';
import { buildUaProfile, type UaProfile } from './ua-profile.js';
import { readRealEnv } from './real-env';
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
  const profile = await desktopProfile(settings);
  await syncRules(settings, grantedSites, profile);
  await syncScripts(settings, grantedSites, profile);
  await updateBadges(settings);
}

async function desktopProfile(settings: Settings): Promise<UaProfile | null> {
  if (!settings.enabled || settings.uaPreset !== 'desktop-chrome') return null;
  const env = await readRealEnv();
  if (!env.os || env.major == null) {
    console.error('slc ua preset skipped', env.os, env.major);
    return null;
  }
  try {
    return buildUaProfile(env.os, env.major);
  } catch (err) {
    console.error('slc ua preset skipped', err);
    return null;
  }
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

type HeaderOp = chrome.declarativeNetRequest.ModifyHeaderInfo;
type Rule = chrome.declarativeNetRequest.Rule;

function isIpHost(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function headersFor(settings: Settings, profile: UaProfile | null): HeaderOp[] {
  const headers: HeaderOp[] = [];
  if (settings.language) {
    headers.push({ header: 'Accept-Language', operation: 'set', value: acceptLanguage(settings) });
  }
  if (profile) {
    for (const [header, value] of Object.entries(profile.headers)) {
      headers.push({ header, operation: 'set', value });
    }
  }
  return headers;
}

function buildRules(settings: Settings, sites: GrantedSite[], profile: UaProfile | null): Rule[] {
  const headers = headersFor(settings, profile);
  if (!settings.enabled || !headers.length) return [];
  return sites.map((site, index) => {
    const condition: chrome.declarativeNetRequest.RuleCondition = {
      requestDomains: [site.host],
      resourceTypes: [...RESOURCE_TYPES] as chrome.declarativeNetRequest.ResourceType[],
    };
    if (!site.includeSubdomains) condition.regexFilter = exactHostRegex(site);
    return {
      id: index + 1,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: headers.map((item) => ({ ...item })) },
      condition,
    };
  });
}

function reindex(rules: Rule[]): Rule[] {
  return rules.map((rule, index) => ({ ...rule, id: index + 1 }));
}

function stripIpRules(rules: Rule[]): Rule[] {
  return reindex(rules.filter((rule) => !isIpHost(rule.condition.requestDomains?.[0] || '')));
}

function stripHeader(rules: Rule[], header: string): Rule[] {
  const name = header.toLowerCase();
  return reindex(
    rules
      .map((rule) => ({
        ...rule,
        action: {
          ...rule.action,
          requestHeaders: (rule.action.requestHeaders || []).filter((item) => item.header.toLowerCase() !== name),
        },
      }))
      .filter((rule) => (rule.action.requestHeaders || []).length > 0),
  );
}

function headerNames(rules: Rule[]): string[] {
  const names: string[] = [];
  for (const rule of rules) {
    for (const item of rule.action.requestHeaders || []) {
      if (!names.some((name) => name.toLowerCase() === item.header.toLowerCase())) names.push(item.header);
    }
  }
  return names;
}

async function commitRules(addRules: Rule[]): Promise<string[]> {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((rule) => rule.id);
  let current = addRules;
  const rejected: string[] = [];
  let droppedIp = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: current });
      return rejected;
    } catch (err) {
      const message = String(err).toLowerCase();
      if (!droppedIp && current.some((rule) => isIpHost(rule.condition.requestDomains?.[0] || ''))) {
        droppedIp = true;
        const next = stripIpRules(current);
        if (next.length !== current.length) {
          current = next;
          continue;
        }
      }
      const headers = headerNames(current);
      if (!headers.length) {
        await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: [] });
        return rejected;
      }
      const named = headers.find((header) => message.includes(header.toLowerCase()));
      const drop = named || headers[headers.length - 1] || '';
      rejected.push(drop);
      const next = stripHeader(current, drop);
      if (!next.length) {
        await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: [] });
        return rejected;
      }
      if (headerNames(next).length === headers.length) throw err;
      current = next;
    }
  }
  throw new Error('declarativeNetRequest update failed');
}

async function syncRules(settings: Settings, sites: GrantedSite[], profile: UaProfile | null): Promise<void> {
  const rejected = await commitRules(buildRules(settings, sites, profile));
  if (rejected.length) console.warn('slc dnr rejected headers', rejected.join(', '));
  try {
    await chrome.storage.local.set({ [DNR_NOTES_KEY]: { rejectedHeaders: rejected } });
  } catch {
    /* notes are diagnostic */
  }
}

export function contentScriptFiles(settings: Settings, uaFile?: string): string[] {
  const tz = TIME_ZONES.find((item) => item.id === settings.timeZoneId) ?? TIME_ZONES[0];
  const lang = LANGUAGES.find((item) => item.tag === settings.languageTag) ?? LANGUAGES[0];
  const file = (on: boolean, pair: { on: string; off: string }) => (on ? pair.on : pair.off);
  const files = [
    tz.file,
    lang.file,
    file(settings.timezone, SWITCH_FILES.timezone),
    file(settings.timezoneOffset, SWITCH_FILES.timezoneOffset),
    file(settings.language, SWITCH_FILES.language),
    file(settings.intlLocale, SWITCH_FILES.intlLocale),
    file(settings.fonts, SWITCH_FILES.fonts),
    file(settings.webrtc, SWITCH_FILES.webrtc),
  ];
  if (settings.uaPreset === 'desktop-chrome' && uaFile) files.push(uaFile);
  files.push(PATCH_FILE);
  return files;
}

async function syncScripts(settings: Settings, sites: GrantedSite[], profile: UaProfile | null): Promise<void> {
  const existing = await chrome.scripting.getRegisteredContentScripts();
  const ids = existing.map((script) => script.id);
  if (ids.length) await chrome.scripting.unregisterContentScripts({ ids });

  const matches = [...new Set(sites.flatMap((site) => site.matches))];
  const uaOn = settings.uaPreset === 'desktop-chrome' && !!profile;
  const active =
    settings.enabled &&
    (settings.timezone || settings.timezoneOffset || settings.language || settings.intlLocale || settings.fonts || settings.webrtc || uaOn);
  if (!active || !matches.length) return;

  // Chrome's dynamic API has rejected matchAboutBlank since the scripting schema
  // dropped it. matchOriginAsFallback still injects about:blank and srcdoc frames.
  // Older builds that accept the property keep it.
  const script: chrome.scripting.RegisteredContentScript & { matchAboutBlank?: boolean } = {
    id: SCRIPT_ID,
    js: contentScriptFiles(settings, profile?.file),
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
