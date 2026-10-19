export const UA_MAJOR_MIN: number;
export const UA_MAJOR_MAX: number;
export const DESKTOP_OS: readonly ['windows', 'mac', 'linux'];

export type DesktopOs = 'windows' | 'mac' | 'linux';

export interface UaBrand {
  brand: string;
  version: string;
}

export interface UaProfile {
  os: DesktopOs;
  major: number;
  userAgent: string;
  appVersion: string;
  navPlatform: string;
  vendor: string;
  uaPlatform: string;
  platformVersion: string;
  architecture: string;
  bitness: string;
  model: string;
  mobile: false;
  wow64: false;
  brands: UaBrand[];
  fullVersionList: UaBrand[];
  headers: Record<string, string>;
  file: string;
}

export function formatBrandList(brands: UaBrand[]): string;
export function greaseBrand(major: number): UaBrand;
export function orderedBrands(major: number, grease: UaBrand, chromium: UaBrand, chrome: UaBrand): UaBrand[];
export function uaSnippetFile(os: DesktopOs, major: number): string;
export function buildUaProfile(os: DesktopOs, major: number): UaProfile;
export function detectDesktopOs(ua: string, uaPlatform?: string): DesktopOs | null;
export function detectChromeMajor(
  ua: string,
  brands?: UaBrand[],
  fullVersionList?: UaBrand[],
): number | null;
export function majorCovered(major: number | null): boolean;
