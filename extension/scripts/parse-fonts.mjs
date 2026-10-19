const FONT_ARRAYS = ['FONTS_SC', 'FONTS_TC', 'FONTS_CN_VENDOR'];

function stripComments(body) {
  return body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Pull one `const NAME = [ ... ]` string array out of signals.ts source. */
export function parseFontArray(source, name) {
  const re = new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\];`);
  const match = re.exec(source);
  if (!match) throw new Error(`failed to parse ${name} from signals.ts`);
  const body = stripComments(match[1]);
  const fonts = [];
  const str = /'(?:\\'|[^'])*'|"(?:\\"|[^"])*"/g;
  let found;
  while ((found = str.exec(body))) {
    const raw = found[0];
    const inner = raw
      .slice(1, -1)
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
    if (!inner) throw new Error(`${name} contains an empty font name`);
    fonts.push(inner);
  }
  if (!fonts.length) throw new Error(`${name} is empty`);
  return fonts;
}

/** FONTS_SC + FONTS_TC + FONTS_CN_VENDOR, in source order, with duplicates removed. */
export function parseFontArrays(source) {
  if (!source || !source.includes('FONTS_SC')) throw new Error('signals.ts font arrays are missing');
  const all = [];
  for (const name of FONT_ARRAYS) {
    for (const font of parseFontArray(source, name)) {
      if (!all.includes(font)) all.push(font);
    }
  }
  return all;
}
