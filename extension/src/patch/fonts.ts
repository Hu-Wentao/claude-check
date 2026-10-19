import { HIDDEN_FONTS } from '../generated/fonts';

type MeasureProto = {
  measureText?: (text: string) => { width: number };
  font?: string;
};

export interface FontScope {
  CanvasRenderingContext2D?: { prototype: MeasureProto };
  OffscreenCanvasRenderingContext2D?: { prototype: MeasureProto };
  FontFaceSet?: { prototype: { check?: (font: string, text?: string) => boolean } };
}

const SIZE =
  /^(?:xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|larger|smaller|(?:\d+(?:\.\d+)?(?:px|em|rem|pt|pc|ex|ch|vh|vw|vmin|vmax|%))(?:\/(?:normal|\d+(?:\.\d+)?(?:px|em|rem|%)?))?)$/i;

function tokenizeFont(font: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote = '';
  for (let i = 0; i < font.length; i += 1) {
    const ch = font[i] ?? '';
    if (quote) {
      cur += ch;
      if (ch === '\\' && i + 1 < font.length) {
        cur += font[i + 1];
        i += 1;
        continue;
      }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (cur) tokens.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

function splitFamilies(src: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote = '';
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i] ?? '';
    if (quote) {
      cur += ch;
      if (ch === '\\' && i + 1 < src.length) {
        cur += src[i + 1];
        i += 1;
        continue;
      }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === ',') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function unquoteFamily(family: string): string {
  const text = family.trim().replace(/\s+/g, ' ');
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text
      .slice(1, -1)
      .replace(/\\(.)/g, '$1')
      .trim();
  }
  return text;
}

function hiddenSet(hidden: ReadonlySet<string> | readonly string[]): Set<string> {
  if (Array.isArray(hidden)) return new Set(hidden.map((name) => name.toLowerCase()));
  return hidden instanceof Set ? hidden : new Set(hidden);
}

interface ParsedFont {
  prefix: string;
  families: string[];
}

function parseFontShorthand(font: string): ParsedFont | null {
  const tokens = tokenizeFont(font);
  let sizeIdx = -1;
  for (let i = 0; i < tokens.length; i += 1) {
    if (SIZE.test(tokens[i] || '')) {
      sizeIdx = i;
      break;
    }
  }
  if (sizeIdx < 0) return null;
  return {
    prefix: tokens.slice(0, sizeIdx + 1).join(' '),
    families: splitFamilies(tokens.slice(sizeIdx + 1).join(' ')),
  };
}

/** Font shorthand with hidden families removed. Null when nothing changes or the shorthand cannot be parsed. */
export function fontWithoutHidden(font: string, hidden: ReadonlySet<string> | readonly string[]): string | null {
  const parsed = parseFontShorthand(font);
  if (!parsed) return null;
  const names = hiddenSet(hidden);
  let removed = false;
  const kept: string[] = [];
  for (const family of parsed.families) {
    if (names.has(unquoteFamily(family).toLowerCase())) removed = true;
    else kept.push(family);
  }
  if (!removed) return null;
  const families = kept.length ? kept.join(', ') : 'sans-serif';
  return `${parsed.prefix} ${families}`;
}

export function fontSpecHasHidden(font: string, hidden: ReadonlySet<string> | readonly string[]): boolean {
  const names = hiddenSet(hidden);
  const parsed = parseFontShorthand(font);
  if (parsed) return parsed.families.some((family) => names.has(unquoteFamily(family).toLowerCase()));
  const lower = font.toLowerCase();
  for (const name of names) {
    if (lower.includes(`"${name}"`) || lower.includes(`'${name}'`)) return true;
  }
  return false;
}

function replaceMethod(proto: object, key: string, fn: (...args: any[]) => unknown): void {
  Object.defineProperty(proto, key, {
    value: fn,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

function wrapMeasure(proto: MeasureProto | undefined, hidden: Set<string>): void {
  if (!proto || typeof proto.measureText !== 'function') return;
  const orig = proto.measureText;
  replaceMethod(proto, 'measureText', function (this: { font?: string }, text: string) {
    let rewritten = false;
    let prev = '';
    try {
      const next = fontWithoutHidden(String(this.font ?? ''), hidden);
      if (next) {
        prev = String(this.font ?? '');
        this.font = next;
        rewritten = true;
      }
    } catch {
      rewritten = false;
    }
    try {
      return orig.call(this, text);
    } finally {
      if (rewritten) {
        try {
          this.font = prev;
        } catch {
          /* restoring the font must not surface as a wrapper error */
        }
      }
    }
  });
}

const HIDDEN = new Set(HIDDEN_FONTS.map((name) => name.toLowerCase()));

export function installFonts(scope: FontScope): void {
  wrapMeasure(scope.CanvasRenderingContext2D?.prototype, HIDDEN);
  wrapMeasure(scope.OffscreenCanvasRenderingContext2D?.prototype, HIDDEN);
  const fonts = scope.FontFaceSet?.prototype;
  if (!fonts || typeof fonts.check !== 'function') return;
  const orig = fonts.check;
  replaceMethod(fonts, 'check', function (this: unknown, font: string, text?: string) {
    try {
      if (fontSpecHasHidden(String(font), HIDDEN)) return false;
    } catch {
      /* fall through to the original check */
    }
    return orig.call(this, font, text);
  });
}
