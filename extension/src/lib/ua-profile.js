/**
 * Desktop Chrome preset. One profile per OS and major version.
 * GREASE brand and brand order follow the Chromium algorithm that has matched
 * shipped Chrome since the updated UA-CH grease (major % 11 characters, major % 6 order).
 * Versions stay on the reduced UA form: Chrome/<major>.0.0.0.
 */

export const UA_MAJOR_MIN = 120;
export const UA_MAJOR_MAX = 170;

export const DESKTOP_OS = ['windows', 'mac', 'linux'];

const GREASE_CHARS = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
const GREASE_VERSIONS = ['8', '99', '24'];
const BRAND_ORDERS = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

const OS_TABLE = {
  windows: {
    token: 'Windows NT 10.0; Win64; x64',
    navPlatform: 'Win32',
    uaPlatform: 'Windows',
    platformVersion: '10.0.0',
  },
  mac: {
    token: 'Macintosh; Intel Mac OS X 10_15_7',
    navPlatform: 'MacIntel',
    uaPlatform: 'macOS',
    platformVersion: '10.15.7',
  },
  linux: {
    token: 'X11; Linux x86_64',
    navPlatform: 'Linux x86_64',
    uaPlatform: 'Linux',
    platformVersion: '',
  },
};

function quoteItem(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function formatBrandList(brands) {
  return brands.map((item) => `${quoteItem(item.brand)};v=${quoteItem(item.version)}`).join(', ');
}

export function greaseBrand(major) {
  const brand = `Not${GREASE_CHARS[major % GREASE_CHARS.length]}A${GREASE_CHARS[(major + 1) % GREASE_CHARS.length]}Brand`;
  const version = GREASE_VERSIONS[major % GREASE_VERSIONS.length];
  return { brand, version };
}

export function orderedBrands(major, grease, chromium, chrome) {
  const order = BRAND_ORDERS[major % BRAND_ORDERS.length];
  const list = new Array(3);
  list[order[0]] = grease;
  list[order[1]] = chromium;
  list[order[2]] = chrome;
  return list;
}

export function uaSnippetFile(os, major) {
  return `snippets/ua/${os}-${major}.js`;
}

export function buildUaProfile(os, major) {
  if (!OS_TABLE[os]) throw new Error(`unsupported os ${os}`);
  if (!Number.isInteger(major) || major < UA_MAJOR_MIN || major > UA_MAJOR_MAX) {
    throw new Error(`chrome major ${major} is outside ${UA_MAJOR_MIN}-${UA_MAJOR_MAX}`);
  }
  const spec = OS_TABLE[os];
  const version = `${major}.0.0.0`;
  const userAgent = `Mozilla/5.0 (${spec.token}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
  const grease = greaseBrand(major);
  const brands = orderedBrands(
    major,
    { brand: grease.brand, version: grease.version },
    { brand: 'Chromium', version: String(major) },
    { brand: 'Google Chrome', version: String(major) },
  );
  const fullVersionList = orderedBrands(
    major,
    { brand: grease.brand, version: `${grease.version}.0.0.0` },
    { brand: 'Chromium', version },
    { brand: 'Google Chrome', version },
  );
  const headers = {
    'User-Agent': userAgent,
    'Sec-CH-UA': formatBrandList(brands),
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': quoteItem(spec.uaPlatform),
    'Sec-CH-UA-Full-Version-List': formatBrandList(fullVersionList),
    'Sec-CH-UA-Platform-Version': quoteItem(spec.platformVersion),
    'Sec-CH-UA-Model': quoteItem(''),
    'Sec-CH-UA-Arch': quoteItem('x86'),
    'Sec-CH-UA-Bitness': quoteItem('64'),
    'Sec-CH-UA-WoW64': '?0',
  };
  return {
    os,
    major,
    userAgent,
    appVersion: userAgent.replace(/^Mozilla\//, ''),
    navPlatform: spec.navPlatform,
    vendor: 'Google Inc.',
    uaPlatform: spec.uaPlatform,
    platformVersion: spec.platformVersion,
    architecture: 'x86',
    bitness: '64',
    model: '',
    mobile: false,
    wow64: false,
    brands,
    fullVersionList,
    headers,
    file: uaSnippetFile(os, major),
  };
}

export function detectDesktopOs(ua, uaPlatform = '') {
  const platform = String(uaPlatform || '').toLowerCase();
  const text = `${platform} ${ua || ''}`.toLowerCase();
  if (platform === 'android' || /\bandroid\b/.test(text)) return null;
  if (platform === 'chrome os' || platform === 'cros' || /\bcros\b/.test(text)) return null;
  if (platform === 'windows' || platform === 'win32' || platform.startsWith('win') || /windows nt/.test(text)) return 'windows';
  if (platform === 'macos' || platform === 'mac' || platform === 'macintel' || /mac os x|macintosh/.test(text)) return 'mac';
  if (platform === 'linux' || platform.startsWith('linux') || /\blinux\b/.test(text)) return 'linux';
  return null;
}

export function detectChromeMajor(ua, brands = [], fullVersionList = []) {
  const fromUa = /(?:Chrome|Chromium)\/(\d+)\./.exec(ua || '');
  if (fromUa) return Number(fromUa[1]);
  for (const item of [...brands, ...fullVersionList]) {
    if (!item || !/^(Google Chrome|Chromium|Chrome)$/i.test(item.brand || '')) continue;
    const major = Number(String(item.version || '').split('.')[0]);
    if (Number.isInteger(major) && major > 0) return major;
  }
  return null;
}

export function majorCovered(major) {
  return Number.isInteger(major) && major >= UA_MAJOR_MIN && major <= UA_MAJOR_MAX;
}
