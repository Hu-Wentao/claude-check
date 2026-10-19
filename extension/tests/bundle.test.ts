import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { LANGUAGES, TIME_ZONES } from '../src/generated/catalog';
import { getOffsetMinutes } from '../src/patch/time';

const banned = [/fuck/i, /claude/i, /anthropic/i, /防封/, /绕过/, /风控/];

describe('generated snippets and patch', () => {
  it('covers the curated zones and languages', () => {
    expect(TIME_ZONES.length).toBeGreaterThanOrEqual(30);
    expect(LANGUAGES.length).toBeGreaterThanOrEqual(12);
    expect(TIME_ZONES[0]?.id).toBe('America/Los_Angeles');
    expect(LANGUAGES[0]?.tag).toBe('en-US');
    expect(LANGUAGES[0]?.acceptLanguage).toBe('en-US,en;q=0.9');
    expect(LANGUAGES.find((item) => item.tag === 'en')?.acceptLanguage).toBe('en');
    const bannedZones = ['Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Singapore', 'Australia/Perth', 'Asia/Urumqi'];
    const deps = { Date, DateTimeFormat: Intl.DateTimeFormat };
    for (const zone of TIME_ZONES) {
      expect(bannedZones).not.toContain(zone.id);
      for (const iso of ['2026-01-15T12:00:00.000Z', '2026-07-15T12:00:00.000Z']) {
        expect(getOffsetMinutes(Date.parse(iso), zone.id, deps)).not.toBe(-480);
      }
    }
    expect(LANGUAGES.some((item) => item.tag.toLowerCase().startsWith('zh'))).toBe(false);
    expect(readdirSync('public/snippets/tz').length).toBe(TIME_ZONES.length);
    expect(readdirSync('public/snippets/lang').length).toBe(LANGUAGES.length);
  });

  it('reads the slot on the first line and deletes both globals', () => {
    const patch = readFileSync('public/injected/patch.js', 'utf8');
    const first = patch.split('\n', 1)[0] ?? '';
    expect(first.startsWith('globalThis.__slcCfg=globalThis.__slcSlot9f3e2a7c;delete globalThis.__slcSlot9f3e2a7c;')).toBe(true);
    expect(patch).toContain('finally{delete globalThis.__slcCfg;}');
    expect(patch).not.toMatch(/\beval\s*\(/);
    expect(patch).not.toMatch(/\bnew\s+Function\b/);
    expect(patch).not.toMatch(/https?:\/\//);

    const files = [
      'public/snippets/tz/America__Los_Angeles.js',
      'public/snippets/lang/en-US.js',
      'public/snippets/sw/timezone-on.js',
      'public/snippets/sw/offset-on.js',
      'public/snippets/sw/language-on.js',
      'public/snippets/sw/intl-on.js',
      'public/injected/patch.js',
    ];
    const context = vm.createContext({ console });
    vm.runInContext(
      `
      function Navigator() {}
      Object.defineProperty(Navigator.prototype, 'language', { configurable: true, get() { return 'zh-CN'; } });
      Object.defineProperty(Navigator.prototype, 'languages', { configurable: true, get() { return ['zh-CN']; } });
      this.Navigator = Navigator;
      this.navigator = new Navigator();
      `,
      context,
    );
    for (const file of files) vm.runInContext(readFileSync(file, 'utf8'), context);
    expect(vm.runInContext('typeof globalThis.__slcSlot9f3e2a7c + "|" + typeof globalThis.__slcCfg', context)).toBe('undefined|undefined');
    expect(vm.runInContext('Intl.DateTimeFormat().resolvedOptions().timeZone', context)).toBe('America/Los_Angeles');
    expect(vm.runInContext('new Date(2026,9,19,3,0,0).toString()', context)).toBe('Mon Oct 19 2026 03:00:00 GMT-0700 (Pacific Daylight Time)');
    expect(vm.runInContext('navigator.language + "|" + navigator.languages[0]', context)).toBe('en-US|en-US');
    const names = vm.runInContext('Object.getOwnPropertyNames(globalThis)', context) as string[];
    expect(names.filter((name) => /slc|9f3e2a/i.test(name))).toEqual([]);
  });

  it('keeps store copy neutral in both locales', () => {
    const en = JSON.parse(readFileSync('public/_locales/en/messages.json', 'utf8')) as Record<string, { message: string }>;
    const zh = JSON.parse(readFileSync('public/_locales/zh_CN/messages.json', 'utf8')) as Record<string, { message: string }>;
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
    expect(en.extName?.message).toBe('Site Locale Control');
    expect(zh.extName?.message).toBe('站点区域控制');
    expect(en.extDesc?.message.length).toBeLessThanOrEqual(132);
    expect(zh.extDesc?.message.length).toBeLessThanOrEqual(132);
    expect(zh.mismatchTz?.message).toContain('两项不一致会被识别');
    expect(zh.mismatchLocale?.message).toContain('两项不一致会被识别');
    expect(zh.refreshHint?.message).toContain('已打开的页面需刷新后生效');
    expect(zh.unchanged?.message).toContain('系统时区和 IP 地址不会改变');
    expect(zh.statusOn?.message).toBe('已启用');
    expect(zh.statusOff?.message).toBe('已关闭');
    expect(zh.statusUnauth?.message).toBe('未授权');
    for (const [key, value] of Object.entries(zh)) {
      if (key === 'addPlaceholder') continue;
      const prose = value.message.replace(/\$[A-Z0-9_]+\$/g, '').replace(/[A-Za-z0-9+\s]/g, '');
      expect(prose, key).not.toMatch(/[,.:;!?]/);
      for (const pattern of banned) expect(value.message).not.toMatch(pattern);
    }
    for (const value of Object.values(en)) {
      for (const pattern of banned) expect(value.message).not.toMatch(pattern);
    }
  });
});
