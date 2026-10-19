import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(root, 'assets/icon.svg'));
const dir = join(root, 'public/icons');
mkdirSync(dir, { recursive: true });

for (const size of [16, 32, 48, 128]) {
  const file = join(dir, `icon-${size}.png`);
  await sharp(svg).resize(size, size).png().toFile(file);
  console.log(`icon ${size}`, file);
}
