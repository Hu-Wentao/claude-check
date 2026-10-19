import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseFontArray, parseFontArrays } from '../scripts/parse-fonts.mjs';
import { HIDDEN_FONTS } from '../src/generated/fonts';
import { fontSpecHasHidden, fontWithoutHidden, installFonts } from '../src/patch/fonts';
import { install } from '../src/patch/install';

const source = readFileSync('../src/config/signals.ts', 'utf8');

describe('font list parsed from signals.ts', () => {
  it('reads the three arrays and fails closed when one is missing', () => {
    const fonts = parseFontArrays(source);
    expect(fonts).toEqual(HIDDEN_FONTS);
    expect(fonts).toContain('Noto Sans CJK SC');
    expect(fonts).toContain('Microsoft YaHei');
    expect(fonts).toContain('PingFang TC');
    expect(fonts).toContain('MiSans');
    expect(fonts).toContain('HarmonyOS Sans');
    expect(fonts.filter((name: string) => name === 'MiSans')).toEqual(['MiSans']);
    expect(parseFontArrays("const FONTS_SC = [\n  'Microsoft YaHei', // 'Ignored Font'\n];\nconst FONTS_TC = ['PingFang TC'];\nconst FONTS_CN_VENDOR = ['MiSans'];\n")).toEqual([
      'Microsoft YaHei',
      'PingFang TC',
      'MiSans',
    ]);
    expect(() => parseFontArray('const FONTS_TC = [];', 'FONTS_SC')).toThrow(/FONTS_SC/);
    expect(() => parseFontArray('const FONTS_SC = [];', 'FONTS_SC')).toThrow(/empty/);
    expect(() => parseFontArrays('const FONTS_SC = ["A"];')).toThrow(/FONTS_TC/);
  });

  it('strips quoted and unquoted hidden families before measureText', () => {
    const hidden = ['Microsoft YaHei', 'MiSans', 'Noto Sans CJK SC'];
    expect(fontWithoutHidden('72px "Microsoft YaHei", monospace', hidden)).toBe('72px monospace');
    expect(fontWithoutHidden('72px Microsoft YaHei, monospace', hidden)).toBe('72px monospace');
    expect(fontWithoutHidden('italic 72px "MiSans", "Noto Sans CJK SC", serif', hidden)).toBe('italic 72px serif');
    expect(fontWithoutHidden('72px monospace', hidden)).toBeNull();
    expect(fontWithoutHidden('72px "Comic Sans MS", sans-serif', hidden)).toBeNull();
    expect(fontSpecHasHidden('72px "MiSans"', hidden)).toBe(true);
    expect(fontSpecHasHidden('16px sans-serif', hidden)).toBe(false);

    const seen: string[] = [];
    const proto = {
      measureText(this: { font: string }) {
        seen.push(this.font);
        return { width: this.font.includes('YaHei') || this.font.includes('MiSans') ? 80 : 10 };
      },
    };
    const offscreen = {
      measureText(this: { font: string }) {
        return { width: this.font.includes('MiSans') ? 80 : 10 };
      },
    };
    const fontSet = {
      check(font: string) {
        return !font.includes('missing');
      },
    };
    installFonts({
      CanvasRenderingContext2D: { prototype: proto },
      OffscreenCanvasRenderingContext2D: { prototype: offscreen },
      FontFaceSet: { prototype: fontSet },
    });
    const ctx = Object.create(proto) as { font: string; measureText: (text: string) => { width: number } };
    ctx.font = '72px "Microsoft YaHei", monospace';
    expect(ctx.measureText('中文字体检测ABCabc012').width).toBe(10);
    expect(ctx.font).toBe('72px "Microsoft YaHei", monospace');
    const off = Object.create(offscreen) as { font: string; measureText: (text: string) => { width: number } };
    off.font = '72px "MiSans", sans-serif';
    expect(off.measureText('x').width).toBe(10);
    expect(fontSet.check('72px "Noto Sans CJK SC"')).toBe(false);
    expect(fontSet.check('72px monospace')).toBe(true);
    expect(seen[0]).toBe('72px monospace');
  });

  it('falls back to the original measureText when the wrapper cannot rewrite the font', () => {
    let reads = 0;
    const proto = {
      measureText(this: { font: string }) {
        return { width: this.font === 'monospace' ? 4 : 80 };
      },
    };
    const ctx = Object.create(proto) as { font: string; measureText: (text: string) => { width: number } };
    Object.defineProperty(ctx, 'font', {
      configurable: true,
      get() {
        reads += 1;
        if (reads === 1) throw new Error('font getter');
        return 'monospace';
      },
      set() {
        /* the failed rewrite must not be required */
      },
    });
    installFonts({ CanvasRenderingContext2D: { prototype: proto } });
    expect(ctx.measureText('x').width).toBe(4);
  });

  it('does nothing until the fonts switch is on', () => {
    const proto = {
      measureText() {
        return { width: 3 };
      },
    };
    const original = proto.measureText;
    install(
      {
        Date,
        Intl,
        Object,
        Number,
        String,
        Symbol,
        Reflect,
        CanvasRenderingContext2D: { prototype: proto },
      },
      { fonts: 0, tz: 'America/Los_Angeles' },
    );
    expect(proto.measureText).toBe(original);
  });
});
