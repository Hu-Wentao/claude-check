import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const constants = readFileSync(join(root, 'src/shared/constants.ts'), 'utf8');
const slotMatch = constants.match(/SLOT_KEY = '([^']+)'/);
if (!slotMatch) throw new Error('SLOT_KEY missing from constants.ts');
const SLOT = slotMatch[1];

/** Common IANA zones. None of these are UTC+8 in January or July. */
const ZONES = [
  'America/Los_Angeles',
  'America/Denver',
  'America/Phoenix',
  'America/Chicago',
  'America/New_York',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Toronto',
  'America/Vancouver',
  'America/Sao_Paulo',
  'America/Mexico_City',
  'America/Bogota',
  'America/Argentina/Buenos_Aires',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Lisbon',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Madrid',
  'Europe/Rome',
  'Europe/Amsterdam',
  'Europe/Zurich',
  'Europe/Stockholm',
  'Europe/Warsaw',
  'Europe/Athens',
  'Europe/Helsinki',
  'Europe/Moscow',
  'Africa/Cairo',
  'Africa/Johannesburg',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Bangkok',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Australia/Sydney',
  'Australia/Melbourne',
  'Pacific/Auckland',
  'Etc/UTC',
  'Atlantic/Reykjavik',
];

const BANNED_ZONES = [
  'Asia/Shanghai',
  'Asia/Chongqing',
  'Asia/Harbin',
  'Asia/Kashgar',
  'Asia/Urumqi',
  'Asia/Hong_Kong',
  'Asia/Macau',
  'Asia/Taipei',
  'Asia/Singapore',
  'Asia/Kuala_Lumpur',
  'Asia/Manila',
  'Australia/Perth',
  'Asia/Irkutsk',
  'Asia/Makassar',
];

const LANGUAGES = [
  'en-US',
  'en-GB',
  'en',
  'fr-FR',
  'de-DE',
  'es-ES',
  'es-MX',
  'pt-BR',
  'it-IT',
  'nl-NL',
  'pl-PL',
  'sv-SE',
  'da-DK',
  'fi-FI',
  'nb-NO',
  'ja-JP',
  'ko-KR',
  'tr-TR',
];

function offsetAt(timeZone, iso) {
  const instant = Date.parse(iso);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const map = {};
  for (const part of dtf.formatToParts(instant)) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  let year = Number(map.year);
  let month = Number(map.month);
  let day = Number(map.day);
  let hour = Number(map.hour);
  if (hour === 24) {
    hour = 0;
    const next = new Date(Date.UTC(year, month - 1, day + 1));
    year = next.getUTCFullYear();
    month = next.getUTCMonth() + 1;
    day = next.getUTCDate();
  }
  const ms = new Date(instant).getUTCMilliseconds();
  const asUTC = Date.UTC(year, month - 1, day, hour, Number(map.minute), Number(map.second), ms);
  return -Math.round((asUTC - instant) / 60000);
}

if (ZONES.length < 30) throw new Error('need at least 30 time zones');
if (LANGUAGES.length < 12) throw new Error('need at least 12 languages');
if (!ZONES.includes('America/Los_Angeles')) throw new Error('default zone missing');
if (!LANGUAGES.includes('en-US')) throw new Error('default language missing');

for (const zone of ZONES) {
  if (BANNED_ZONES.includes(zone)) throw new Error(`banned zone ${zone}`);
  for (const iso of ['2026-01-15T12:00:00Z', '2026-07-15T12:00:00Z']) {
    let offset;
    try {
      offset = offsetAt(zone, iso);
    } catch (err) {
      throw new Error(`${zone} is not a valid time zone (${err.message})`);
    }
    if (offset === -480) throw new Error(`${zone} is UTC+8 at ${iso}`);
  }
}

for (const tag of LANGUAGES) {
  if (tag.toLowerCase().startsWith('zh')) throw new Error(`language ${tag} is not allowed`);
}

function languagePack(tag) {
  const primary = tag.split('-')[0];
  if (primary && primary !== tag) {
    return { languages: [tag, primary], acceptLanguage: `${tag},${primary};q=0.9` };
  }
  return { languages: [tag], acceptLanguage: tag };
}

function write(file, text) {
  const abs = join(root, file);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text.endsWith('\n') ? text : `${text}\n`);
}

function slotLine(value) {
  return `globalThis.${SLOT}=Object.assign(globalThis.${SLOT}||{},${JSON.stringify(value)});`;
}

rmSync(join(root, 'public/snippets'), { recursive: true, force: true });

const zoneItems = ZONES.map((id) => {
  const file = `snippets/tz/${id.replaceAll('/', '__')}.js`;
  write(join('public', file), slotLine({ tz: id }));
  return { id, file };
});

const languageItems = LANGUAGES.map((tag) => {
  const pack = languagePack(tag);
  const file = `snippets/lang/${tag}.js`;
  write(join('public', file), slotLine({ lang: tag, langs: pack.languages }));
  return { tag, languages: pack.languages, acceptLanguage: pack.acceptLanguage, file };
});

const switchPairs = [
  ['timezone', 'timezone'],
  ['offset', 'timezoneOffset'],
  ['language', 'language'],
  ['intl', 'intlLocale'],
];
const switchFiles = {};
for (const [stem, key] of switchPairs) {
  const on = `snippets/sw/${stem}-on.js`;
  const off = `snippets/sw/${stem}-off.js`;
  write(join('public', on), slotLine({ [key]: 1 }));
  write(join('public', off), slotLine({ [key]: 0 }));
  const catalogKey = key === 'timezoneOffset' ? 'timezoneOffset' : key === 'intlLocale' ? 'intlLocale' : key;
  switchFiles[catalogKey] = { on, off };
}

const catalog = `/* Generated by scripts/gen-snippets.mjs. Do not edit. */
export interface TimeZoneItem {
  id: string;
  file: string;
}

export interface LanguageItem {
  tag: string;
  languages: string[];
  acceptLanguage: string;
  file: string;
}

export const TIME_ZONES: TimeZoneItem[] = ${JSON.stringify(zoneItems, null, 2)};

export const LANGUAGES: LanguageItem[] = ${JSON.stringify(languageItems, null, 2)};

export const SWITCH_FILES = ${JSON.stringify(
  {
    timezone: switchFiles.timezone,
    timezoneOffset: switchFiles.timezoneOffset,
    language: switchFiles.language,
    intlLocale: switchFiles.intlLocale,
  },
  null,
  2,
)} as const;
`;

write('src/generated/catalog.ts', catalog);
console.log(`snippets: ${zoneItems.length} zones, ${languageItems.length} languages, slot ${SLOT}`);
