import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { scoreCnBrowser, scoreCnDevice } from '../../src/config/signals';
import { recommendedSettings } from '../src/lib/settings';
import {
  buildUaProfile,
  detectChromeMajor,
  detectDesktopOs,
  greaseBrand,
  UA_MAJOR_MAX,
  UA_MAJOR_MIN,
} from '../src/lib/ua-profile.js';

describe('desktop chrome presets', () => {
  it('keeps the major version and the operating system in the reduced UA', () => {
    const windows = buildUaProfile('windows', 131);
    expect(windows.userAgent).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    );
    expect(windows.appVersion.startsWith('5.0 (Windows NT 10.0; Win64; x64)')).toBe(true);
    expect(windows.navPlatform).toBe('Win32');
    expect(windows.uaPlatform).toBe('Windows');
    expect(windows.vendor).toBe('Google Inc.');
    expect(windows.mobile).toBe(false);
    expect(windows.model).toBe('');
    expect(windows.headers['User-Agent']).toBe(windows.userAgent);
    expect(windows.headers['Sec-CH-UA-Mobile']).toBe('?0');
    expect(windows.headers['Sec-CH-UA-Platform']).toBe('"Windows"');
    expect(windows.headers['Sec-CH-UA-Model']).toBe('""');
    expect(windows.headers['Sec-CH-UA-Platform-Version']).toBe('"10.0.0"');
    expect(windows.headers['Sec-CH-UA-Arch']).toBe('"x86"');
    expect(windows.headers['Sec-CH-UA-Bitness']).toBe('"64"');
    expect(windows.headers['Sec-CH-UA-WoW64']).toBe('?0');
    expect(windows.brands.map((item) => item.brand)).toEqual(['Google Chrome', 'Chromium', 'Not_A Brand']);
    expect(windows.brands.find((item) => item.brand === 'Google Chrome')?.version).toBe('131');
    expect(windows.brands.find((item) => item.brand === 'Chromium')?.version).toBe('131');
    expect(windows.fullVersionList.find((item) => item.brand === 'Chromium')?.version).toBe('131.0.0.0');
    expect(windows.headers['Sec-CH-UA']).toContain('"Google Chrome";v="131"');
    expect(windows.headers['Sec-CH-UA-Full-Version-List']).toContain('"Chromium";v="131.0.0.0"');

    const mac = buildUaProfile('mac', 120);
    expect(mac.userAgent).toContain('Macintosh; Intel Mac OS X 10_15_7');
    expect(mac.userAgent).toContain('Chrome/120.0.0.0');
    expect(mac.navPlatform).toBe('MacIntel');
    expect(mac.uaPlatform).toBe('macOS');
    expect(mac.headers['Sec-CH-UA-Platform']).toBe('"macOS"');
    expect(mac.headers['Sec-CH-UA-Platform-Version']).toBe('"10.15.7"');
    expect(mac.brands.map((item) => item.brand)).toEqual(['Not_A Brand', 'Chromium', 'Google Chrome']);
    expect(greaseBrand(120)).toEqual({ brand: 'Not_A Brand', version: '8' });

    const linux = buildUaProfile('linux', 170);
    expect(linux.userAgent).toContain('X11; Linux x86_64');
    expect(linux.userAgent).toContain('Chrome/170.0.0.0');
    expect(linux.navPlatform).toBe('Linux x86_64');
    expect(linux.uaPlatform).toBe('Linux');
    expect(linux.platformVersion).toBe('');
    expect(linux.headers['Sec-CH-UA-Platform']).toBe('"Linux"');
    expect(linux.headers['Sec-CH-UA-Platform-Version']).toBe('""');
  });

  it('matches the generated snippet for that os and major', () => {
    const profile = buildUaProfile('linux', 128);
    const sandbox: Record<string, unknown> = {};
    vm.runInNewContext(readFileSync('public/snippets/ua/linux-128.js', 'utf8'), sandbox);
    const slot = sandbox.__slcSlot9f3e2a7c as { ua: string; navPlatform: string; brands: { brand: string }[] };
    expect(slot.ua).toBe(profile.userAgent);
    expect(slot.navPlatform).toBe('Linux x86_64');
    expect(slot.brands.map((item) => item.brand)).toEqual(profile.brands.map((item) => item.brand));
    expect(readFileSync('public/snippets/ua/windows-120.js', 'utf8')).toContain('Chrome/120.0.0.0');
    expect(readFileSync('public/snippets/ua/mac-145.js', 'utf8')).toContain('Mac OS X 10_15_7');
  });

  it('rejects majors outside the generated table', () => {
    expect(() => buildUaProfile('linux', UA_MAJOR_MIN - 1)).toThrow();
    expect(() => buildUaProfile('linux', UA_MAJOR_MAX + 1)).toThrow();
  });

  it('reads the chrome major and desktop os from a real UA', () => {
    const ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    expect(detectChromeMajor(ua, [{ brand: 'Chromium', version: '131' }])).toBe(131);
    expect(detectChromeMajor('QQBrowser', [{ brand: 'Google Chrome', version: '128.0.0.0' }])).toBe(128);
    expect(detectDesktopOs(ua, 'Linux')).toBe('linux');
    expect(detectDesktopOs('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0', '')).toBe('windows');
    expect(detectDesktopOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0.0.0', 'macOS')).toBe('mac');
    expect(detectDesktopOs('Mozilla/5.0 (Linux; Android 14) Chrome/120.0.0.0', 'Android')).toBeNull();
  });

  it('selects desktop chrome only when the shared score functions hit', () => {
    expect(scoreCnBrowser('Mozilla/5.0 Chrome/131.0.0.0 QQBrowser/13').name).toBe('QQ Browser');
    expect(scoreCnDevice('Mozilla/5.0 HUAWEI Chrome/131').name).toBe('Huawei / Honor');
    expect(scoreCnBrowser('Mozilla/5.0 Chrome/131.0.0.0').score).toBe(0);
    expect(scoreCnDevice('Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0.0.0').score).toBe(0);
    expect(recommendedSettings(undefined, false).uaPreset).toBe('native');
    expect(recommendedSettings(undefined, false).fonts).toBe(true);
    expect(recommendedSettings(undefined, false).webrtc).toBe(true);
    expect(recommendedSettings(undefined, true).uaPreset).toBe('desktop-chrome');
  });
});
