import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const constants = readFileSync(join(root, 'src/shared/constants.ts'), 'utf8');
const slotMatch = constants.match(/SLOT_KEY = '([^']+)'/);
if (!slotMatch) throw new Error('SLOT_KEY missing from constants.ts');
const slot = slotMatch[1];

await build({
  absWorkingDir: root,
  entryPoints: ['src/patch/entry.ts'],
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  legalComments: 'none',
  tsconfigRaw: {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true,
    },
  },
  minify: false,
  sourcemap: false,
  outfile: 'public/injected/patch.js',
  banner: {
    js: `globalThis.__slcCfg=globalThis.${slot};delete globalThis.${slot};try{`,
  },
  footer: {
    js: '}finally{delete globalThis.__slcCfg;}',
  },
});

const text = readFileSync(join(root, 'public/injected/patch.js'), 'utf8');
const first = text.split('\n', 1)[0];
if (!first.includes(`globalThis.${slot}`) || !first.includes(`delete globalThis.${slot}`)) {
  throw new Error('patch.js first line does not read and delete the slot');
}
if (/\beval\s*\(/.test(text) || /\bnew\s+Function\b/.test(text)) {
  throw new Error('patch.js contains eval or new Function');
}
console.log('patch.js', text.length, 'bytes');
