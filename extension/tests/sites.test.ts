import { describe, expect, it } from 'vitest';
import { exactHostRegex, originPatterns, parseSiteInput, requestablePatterns } from '../src/lib/sites';
import { contentScriptFiles } from '../src/lib/apply';
import { recommendedSettings } from '../src/lib/settings';

describe('site parser', () => {
  it('accepts a concrete https host', () => {
    expect(parseSiteInput('https://example.com/path')).toEqual({ ok: true, host: 'example.com' });
    expect(parseSiteInput('Example.COM')).toEqual({ ok: true, host: 'example.com' });
    expect(parseSiteInput('https://claude.ai')).toEqual({ ok: true, host: 'claude.ai' });
    expect(parseSiteInput('https://foo.com.cn')).toEqual({ ok: true, host: 'foo.com.cn' });
  });

  it('rejects wildcards, bare domains, and non-https urls', () => {
    for (const input of ['', '*', 'https://*/*', '<all_urls>', '*.example.com', 'https://*.claude.ai', 'com', 'https://com', 'co.uk', 'https://co.uk', 'https://com.cn', 'http://example.com', 'https://user:pass@example.com', 'not a host']) {
      expect(parseSiteInput(input).ok, input).toBe(false);
    }
  });

  it('builds match patterns and an exact-host filter', () => {
    expect(originPatterns({ host: 'claude.ai', includeSubdomains: true })).toEqual(['https://claude.ai/*', 'https://*.claude.ai/*']);
    expect(originPatterns({ host: 'localhost', includeSubdomains: false })).toEqual(['http://localhost/*']);
    const re = new RegExp(exactHostRegex({ host: 'localhost', includeSubdomains: false }));
    expect(re.test('http://localhost:4321/__e2e/echo')).toBe(true);
    expect(re.test('http://localhost/')).toBe(true);
    expect(re.test('https://localhost/')).toBe(false);
    expect(re.test('http://sub.localhost/')).toBe(false);
    expect(re.test('http://evil.com/')).toBe(false);
  });

  it('never requests the catch-all origin', () => {
    const patterns = requestablePatterns(
      [
        { host: 'claude.ai', includeSubdomains: true },
        { host: 'localhost', includeSubdomains: true },
        { host: '127.0.0.1', includeSubdomains: false },
      ],
      true,
    );
    expect(patterns).toEqual(['https://claude.ai/*', 'https://*.claude.ai/*']);
    expect(patterns).not.toContain('https://*/*');
    expect(patterns.join(' ')).not.toContain('localhost');
  });

  it('orders content scripts as config, switches, then the patch', () => {
    const files = contentScriptFiles(recommendedSettings());
    expect(files[0]).toBe('snippets/tz/America__Los_Angeles.js');
    expect(files[1]).toBe('snippets/lang/en-US.js');
    expect(files.slice(2, 6)).toEqual([
      'snippets/sw/timezone-on.js',
      'snippets/sw/offset-on.js',
      'snippets/sw/language-on.js',
      'snippets/sw/intl-on.js',
    ]);
    expect(files.at(-1)).toBe('injected/patch.js');
    const partial = contentScriptFiles({ ...recommendedSettings(), timezoneOffset: false, language: false });
    expect(partial).toContain('snippets/sw/offset-off.js');
    expect(partial).toContain('snippets/sw/language-off.js');
    expect(partial).not.toContain('snippets/sw/offset-on.js');
  });
});
