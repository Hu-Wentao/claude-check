// （环境：background/onboarding 共用, 原因/备注：检测页各打分项 → 扩展设置补丁的
// 唯一映射；同组联动开启，避免只开一半被 mismatch 识破）
import { CHECKER_ORIGIN_PATTERNS } from './origins';
import {
  DEFAULT_LANGUAGE,
  DEFAULT_TIME_ZONE,
  mergeSites,
  suggestedSites,
  type Settings,
} from './settings';

export { CHECKER_ORIGIN_PATTERNS };

/** The checker-site signal ids this bridge knows how to fix. */
export const FIXABLE_SIGNALS = [
  'timezone',
  'timezoneOffset',
  'language',
  'intlLocale',
  'fonts',
  'vendorFonts',
  'cnBrowser',
  'deviceVendor',
  'webrtcLeak',
] as const;

export function settingsPatchFor(signal: string): Partial<Settings> | null {
  switch (signal) {
    case 'timezone':
    case 'timezoneOffset':
      return { timezone: true, timezoneOffset: true, timeZoneId: DEFAULT_TIME_ZONE };
    case 'language':
    case 'intlLocale':
      return { language: true, intlLocale: true, languageTag: DEFAULT_LANGUAGE };
    case 'fonts':
    case 'vendorFonts':
      return { fonts: true };
    case 'cnBrowser':
    case 'deviceVendor':
      return { uaPreset: 'desktop-chrome' as const };
    case 'webrtcLeak':
      return { webrtc: true };
    default:
      return null;
  }
}

/** Only the clicked signal's group is enabled; other toggles stay untouched. */
export function applySignalFix(current: Settings, signal: string): Settings | null {
  const patch = settingsPatchFor(signal);
  if (!patch) return null;
  return {
    ...current,
    enabled: true,
    sites: mergeSites(current.sites, suggestedSites()),
    ...patch,
  };
}

/** Fold every requested group into one settings patch set (一键修复 aggregate). */
export function applySignalFixes(current: Settings, signals: string[]): Settings | null {
  const patches: Partial<Settings>[] = [];
  let sawWebrtc = false;
  for (const signal of signals) {
    const patch = settingsPatchFor(signal);
    if (!patch) return null;
    if (signal === 'webrtcLeak') sawWebrtc = true;
    patches.push(patch);
  }
  return {
    ...current,
    enabled: true,
    sites: mergeSites(current.sites, suggestedSites()),
    ...(sawWebrtc ? { webrtc: true } : {}),
    ...Object.assign({}, ...patches),
  };
}
