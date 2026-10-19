import { scoreCnBrowser, scoreCnDevice } from '../../../src/config/signals';
import { detectChromeMajor, detectDesktopOs, majorCovered, type DesktopOs, type UaBrand } from './ua-profile.js';

interface UaData {
  brands?: UaBrand[];
  platform?: string;
  getHighEntropyValues?: (hints: string[]) => Promise<Record<string, unknown>>;
}

export interface RealEnv {
  ua: string;
  brands: UaBrand[];
  platform: string;
  navPlatform: string;
  model: string;
  platformVersion: string;
  architecture: string;
  bitness: string;
  fullVersionList: UaBrand[];
  os: DesktopOs | null;
  major: number | null;
  cnBrowserName: string | null;
  cnBrowserScore: number;
  cnDeviceName: string | null;
  cnDeviceScore: number;
  suggestDesktop: boolean;
}

function asBrands(value: unknown): UaBrand[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const brand = item as { brand?: unknown; version?: unknown };
      return { brand: String(brand.brand ?? ''), version: String(brand.version ?? '') };
    })
    .filter((item) => item.brand);
}

/** Read the real browser identity. Called from the service worker, not from a page. */
export async function readRealEnv(): Promise<RealEnv> {
  const ua = navigator.userAgent || '';
  const nav = navigator as Navigator & { userAgentData?: UaData };
  const uad = nav.userAgentData;
  const brands = asBrands(uad?.brands);
  let high: Record<string, unknown> = {};
  try {
    high = (await uad?.getHighEntropyValues?.(['model', 'platform', 'platformVersion', 'fullVersionList', 'architecture', 'bitness'])) || {};
  } catch {
    high = {};
  }
  const platform = String(uad?.platform || high.platform || '');
  const model = String(high.model ?? '');
  const fullVersionList = asBrands(high.fullVersionList);
  const browser = scoreCnBrowser(`${ua} ${brands.map((item) => item.brand).join(' ')}`);
  const device = scoreCnDevice(`${ua} ${model} ${platform}`);
  const os = detectDesktopOs(ua, platform) || detectDesktopOs(navigator.platform || '', navigator.platform || '');
  const major = detectChromeMajor(ua, brands, fullVersionList);
  const hit = browser.score > 0 || device.score > 0;
  return {
    ua,
    brands,
    platform,
    navPlatform: navigator.platform || '',
    model,
    platformVersion: String(high.platformVersion ?? ''),
    architecture: String(high.architecture ?? ''),
    bitness: String(high.bitness ?? ''),
    fullVersionList,
    os,
    major,
    cnBrowserName: browser.name,
    cnBrowserScore: browser.score,
    cnDeviceName: device.name,
    cnDeviceScore: device.score,
    suggestDesktop: hit && os != null && majorCovered(major),
  };
}
