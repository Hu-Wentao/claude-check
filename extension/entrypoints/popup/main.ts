import { LANGUAGES, TIME_ZONES } from '../../src/generated/catalog';
import { formatUtcOffsetLabel, getOffsetMinutes } from '../../src/patch/time';
import {
  normalizeSettings,
  recommendedSettings,
  saveSettings,
  loadSettings,
  type Settings,
} from '../../src/lib/settings';
import { originPatterns, parseSiteInput, requestablePatterns, urlMatchesSite, type SiteEntry } from '../../src/lib/sites';
import './style.css';

let current: Settings = {
  enabled: false,
  timezone: false,
  timezoneOffset: false,
  language: false,
  intlLocale: false,
  timeZoneId: 'America/Los_Angeles',
  languageTag: 'en-US',
  sites: [],
};

function t(key: string, subs?: string[]): string {
  const value = subs ? chrome.i18n.getMessage(key, subs) : chrome.i18n.getMessage(key);
  return value || key;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function requestOrigins(sites: SiteEntry[]): void {
  const origins = requestablePatterns(sites, __SLC_E2E__);
  if (!origins.length) {
    document.body.dataset.perm = 'skipped';
    return;
  }
  try {
    const pending = chrome.permissions.request({ origins });
    void pending.then(
      (ok) => {
        document.body.dataset.perm = ok ? 'granted' : 'denied';
        const note = document.querySelector('[data-field="perm"]');
        if (note) note.textContent = ok ? t('permOk') : t('permPartial');
      },
      () => {
        document.body.dataset.perm = 'error';
        const note = document.querySelector('[data-field="perm"]');
        if (note) note.textContent = t('permPartial');
      },
    );
  } catch {
    document.body.dataset.perm = 'error';
  }
}

function dropOrigins(sites: SiteEntry[]): void {
  removePatterns(requestablePatterns(sites, __SLC_E2E__));
}

function removePatterns(patterns: string[]): void {
  const origins = patterns.filter((pattern) => {
    if (pattern === 'https://*/*' || pattern === 'http://*/*' || pattern === '<all_urls>') return false;
    if (__SLC_E2E__ && /^http:\/\/(\*\.)?(localhost|127\.0\.0\.1)\//.test(pattern)) return false;
    return true;
  });
  if (!origins.length) return;
  try {
    void chrome.permissions.remove({ origins }).catch(() => {});
  } catch {
    /* required host permissions cannot be removed */
  }
}

async function persist(next: Settings): Promise<void> {
  document.body.dataset.applied = '0';
  current = next;
  sync();
  try {
    await saveSettings(next);
    document.body.dataset.applied = '1';
  } catch (err) {
    document.body.dataset.applied = 'error';
    console.error('slc', err);
  }
}

function zoneLabel(id: string): string {
  try {
    const offset = getOffsetMinutes(Date.now(), id, { Date, DateTimeFormat: Intl.DateTimeFormat });
    const note = offset === -480 ? t('utc8Yes') : t('utc8No');
    return t('tzMeta', [id, formatUtcOffsetLabel(offset), note]);
  } catch {
    return id;
  }
}

function warningText(): string {
  const parts: string[] = [];
  if (current.timezone !== current.timezoneOffset) parts.push(t('mismatchTz'));
  if (current.language !== current.intlLocale) parts.push(t('mismatchLocale'));
  return parts.join('\n');
}

async function fillStatus(): Promise<void> {
  const node = document.querySelector('[data-field="status"]');
  if (!node) return;
  if (!current.enabled) {
    node.textContent = `${t('statusPrefix')}${t('statusOff')}`;
    return;
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url || '';
    if (!url || !urlMatchesSite(url, current.sites)) {
      node.textContent = `${t('statusPrefix')}${t('statusUnauth')}`;
      return;
    }
    const host = new URL(url).hostname.toLowerCase();
    const site = current.sites.find((item) => item.host === host || (item.includeSubdomains && host.endsWith(`.${item.host}`)));
    const pattern = site ? originPatterns(site)[0] : '';
    const ok = pattern ? await chrome.permissions.contains({ origins: [pattern] }) : false;
    node.textContent = `${t('statusPrefix')}${ok ? t('statusOn') : t('statusUnauth')}`;
  } catch {
    node.textContent = `${t('statusPrefix')}${t('statusUnauth')}`;
  }
}

function renderSites(): void {
  const list = document.querySelector('[data-field="site-list"]');
  if (!list) return;
  list.replaceChildren();
  for (const site of current.sites) {
    const row = el('div', 'site');
    row.dataset.host = site.host;
    const name = el('span', undefined, site.host);
    row.append(name);
    const sub = el('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = site.includeSubdomains;
    box.addEventListener('change', () => {
      const nextSites = current.sites.map((item) =>
        item.host === site.host ? { ...item, includeSubdomains: box.checked } : item,
      );
      const updated = nextSites.find((item) => item.host === site.host);
      if (box.checked && updated) requestOrigins([updated]);
      if (!box.checked) {
        const wildcards = originPatterns({ host: site.host, includeSubdomains: true }).filter((pattern) => pattern.includes('://*.'));
        removePatterns(wildcards);
      }
      void persist({ ...current, sites: nextSites });
    });
    sub.append(box, document.createTextNode(t('includeSub')));
    row.append(sub);
    if (site.host === 'fuck-claude.vercel.app') row.append(el('span', 'tag', t('selfTest')));
    else if (site.suggested) row.append(el('span', 'tag', t('suggested')));
    const remove = el('button', undefined, t('remove'));
    remove.type = 'button';
    remove.dataset.action = 'remove-site';
    remove.addEventListener('click', () => {
      dropOrigins([site]);
      void persist({ ...current, sites: current.sites.filter((item) => item.host !== site.host) });
    });
    row.append(remove);
    list.append(row);
  }
}

function sync(): void {
  const master = document.querySelector<HTMLInputElement>('[data-field="master"]');
  const timezone = document.querySelector<HTMLInputElement>('[data-field="timezone"]');
  const offset = document.querySelector<HTMLInputElement>('[data-field="timezone-offset"]');
  const language = document.querySelector<HTMLInputElement>('[data-field="language"]');
  const intl = document.querySelector<HTMLInputElement>('[data-field="intl"]');
  const tz = document.querySelector<HTMLSelectElement>('[data-field="tz"]');
  const lang = document.querySelector<HTMLSelectElement>('[data-field="lang"]');
  const warning = document.querySelector('[data-field="warning"]');
  if (master) master.checked = current.enabled;
  if (timezone) timezone.checked = current.timezone;
  if (offset) offset.checked = current.timezoneOffset;
  if (language) language.checked = current.language;
  if (intl) intl.checked = current.intlLocale;
  if (tz) tz.value = current.timeZoneId;
  if (lang) lang.value = current.languageTag;
  if (warning) {
    warning.textContent = warningText();
    warning.toggleAttribute('hidden', warning.textContent.length === 0);
  }
  renderSites();
  void fillStatus();
}

function checkbox(field: string, label: string, onChange: (checked: boolean) => void): HTMLLabelElement {
  const row = el('label', 'row');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.dataset.field = field;
  input.addEventListener('change', () => onChange(input.checked));
  row.append(input, document.createTextNode(label));
  return row;
}

function build(): void {
  const app = document.querySelector('#app');
  if (!app) return;
  app.replaceChildren();
  document.documentElement.lang = chrome.i18n.getUILanguage() || 'en';
  document.title = t('extName');

  app.append(el('h1', undefined, t('extName')));

  const switches = el('section');
  switches.append(
    checkbox('master', t('master'), (checked) => {
      if (checked) requestOrigins(current.sites);
      void persist({ ...current, enabled: checked });
    }),
    checkbox('timezone', t('sigTimezone'), (checked) => {
      void persist({ ...current, timezone: checked });
    }),
    checkbox('timezone-offset', t('sigOffset'), (checked) => {
      void persist({ ...current, timezoneOffset: checked });
    }),
    checkbox('language', t('sigLanguage'), (checked) => {
      void persist({ ...current, language: checked });
    }),
    checkbox('intl', t('sigIntl'), (checked) => {
      void persist({ ...current, intlLocale: checked });
    }),
  );
  const warning = el('p', 'warning');
  warning.dataset.field = 'warning';
  warning.setAttribute('role', 'status');
  switches.append(warning);
  app.append(switches);

  const picks = el('section');
  const tzLabel = el('label', 'field', t('tzLabel'));
  const tz = document.createElement('select');
  tz.dataset.field = 'tz';
  for (const zone of TIME_ZONES) {
    const option = document.createElement('option');
    option.value = zone.id;
    option.textContent = zoneLabel(zone.id);
    tz.append(option);
  }
  tz.addEventListener('change', () => {
    void persist({ ...current, timeZoneId: tz.value });
  });
  tzLabel.append(tz);

  const langLabel = el('label', 'field', t('langLabel'));
  const lang = document.createElement('select');
  lang.dataset.field = 'lang';
  for (const item of LANGUAGES) {
    const option = document.createElement('option');
    option.value = item.tag;
    option.textContent = item.tag;
    lang.append(option);
  }
  lang.addEventListener('change', () => {
    void persist({ ...current, languageTag: lang.value });
  });
  langLabel.append(lang);
  picks.append(tzLabel, langLabel);
  app.append(picks);

  const actions = el('section');
  const row = el('div', 'actions');
  const apply = el('button', 'primary', t('apply'));
  apply.type = 'button';
  apply.dataset.action = 'apply-recommended';
  apply.addEventListener('click', () => {
    const next = recommendedSettings(current);
    requestOrigins(next.sites);
    void persist(next);
  });
  const enable = el('button', undefined, t('enable'));
  enable.type = 'button';
  enable.dataset.action = 'enable';
  enable.addEventListener('click', () => {
    requestOrigins(current.sites);
    void persist({ ...current, enabled: true });
  });
  const restore = el('button', undefined, t('restore'));
  restore.type = 'button';
  restore.dataset.action = 'restore';
  restore.addEventListener('click', () => {
    void persist({ ...current, enabled: false });
  });
  row.append(apply, enable, restore);
  const status = el('p', 'status');
  status.dataset.field = 'status';
  const refresh = el('p', 'hint', t('refreshHint'));
  refresh.dataset.field = 'refresh';
  const unchanged = el('p', 'hint', t('unchanged'));
  unchanged.dataset.field = 'unchanged';
  const perm = el('p', 'perm');
  perm.dataset.field = 'perm';
  actions.append(row, status, refresh, unchanged, perm);
  app.append(actions);

  const sites = el('section');
  sites.append(el('p', 'sites-title', t('sites')));
  const addRow = el('div', 'add');
  const input = document.createElement('input');
  input.type = 'text';
  input.dataset.field = 'site-input';
  input.placeholder = t('addPlaceholder');
  input.spellcheck = false;
  const add = el('button', undefined, t('add'));
  add.type = 'button';
  add.dataset.action = 'add-site';
  const error = el('p', 'error');
  error.dataset.field = 'form-error';
  const submit = () => {
    const parsed = parseSiteInput(input.value);
    if (!parsed.ok) {
      error.textContent = t('invalidSite');
      return;
    }
    if (current.sites.some((site) => site.host === parsed.host)) {
      error.textContent = '';
      input.value = '';
      return;
    }
    const site: SiteEntry = { host: parsed.host, includeSubdomains: false };
    error.textContent = '';
    input.value = '';
    requestOrigins([site]);
    void persist({ ...current, sites: [...current.sites, site] });
  };
  add.addEventListener('click', submit);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
  });
  addRow.append(input, add);
  const list = el('div');
  list.dataset.field = 'site-list';
  sites.append(addRow, error, list);
  app.append(sites);
}

async function main(): Promise<void> {
  current = await loadSettings();
  build();
  sync();
  document.body.dataset.ready = '1';
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes['slc-settings']) return;
    current = normalizeSettings(changes['slc-settings'].newValue);
    sync();
  });
}

void main();
