/**
 * Generates the site's visual assets (Claude palette + thumbs-up mark):
 *   public/favicon.svg          – orange tile + white thumbs-up
 *   public/apple-touch-icon.png – 180×180, square (iOS applies its own mask)
 *   public/icon-192.png / icon-512.png – PWA/manifest icons
 *   public/og.png               – 1200×630 Open Graph card
 *
 * Run: node scripts/gen-assets.mjs
 */
import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';

const ORANGE = '#D97757'; // Claude terracotta
const CREAM = '#FAF9F5'; // ivory
const BONE = '#F0EEE6';
const SLATE = '#1F1E1D';
const MUTED = '#63615B';
const FAINT = '#8A887F';

/**
 * Thumbs-up hand (fist left, thumb raised), drawn in a 24×24 box and scaled
 * into the 64×64 tile; single path keeps it crisp at favicon sizes.
 */
function hand(color) {
  return `<g fill="${color}" transform="translate(56 10) scale(-2 2)">
    <path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/>
  </g>`;
}

function tileSvg(rx) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <rect width="64" height="64" rx="${rx}" fill="${ORANGE}"/>
  ${hand(CREAM)}
</svg>`;
}

const OG_HAND_SCALE = 4.6;
const ogSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${CREAM}"/>
  <circle cx="280" cy="315" r="205" fill="${BONE}"/>
  <g transform="translate(${(280 - 32 * OG_HAND_SCALE).toFixed(1)} ${(315 - 32 * OG_HAND_SCALE).toFixed(1)}) scale(${OG_HAND_SCALE})">${hand(ORANGE)}</g>
  <text x="530" y="190" font-family="Helvetica, Arial, sans-serif" font-size="25" font-weight="700" letter-spacing="8" fill="${ORANGE}">CLAUDE CHECK</text>
  <text x="525" y="280" font-family="Georgia, 'Times New Roman', serif" font-size="70" font-weight="700" fill="${SLATE}">Are you a Claude</text>
  <text x="525" y="370" font-family="Georgia, 'Times New Roman', serif" font-size="70" font-weight="700" font-style="italic" fill="${ORANGE}">“China user”?</text>
  <text x="530" y="442" font-family="Helvetica, Arial, sans-serif" font-size="25" fill="${MUTED}">Timezone · Language · Fonts · Locale</text>
  <text x="530" y="482" font-family="Helvetica, Arial, sans-serif" font-size="25" fill="${MUTED}">Checked 100% locally in your browser</text>
  <text x="530" y="556" font-family="Menlo, monospace" font-size="23" fill="${FAINT}">claudecheck.frely.cloud</text>
</svg>`;

const px = (svg, size) =>
  sharp(Buffer.from(svg), { density: 72 * (size / 64) }).resize(size, size);

await writeFile('public/favicon.svg', tileSvg(14) + '\n');
await px(tileSvg(0), 180).png().toFile('public/apple-touch-icon.png');
await px(tileSvg(14), 192).png().toFile('public/icon-192.png');
await px(tileSvg(14), 512).png().toFile('public/icon-512.png');
await sharp(Buffer.from(ogSvg)).png().toFile('public/og.png');

console.log('assets written to public/');
