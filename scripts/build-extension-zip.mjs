/**
 * Build the production Site Locale Control zip before `astro build`.
 *
 * Vercel uses the default install (`bun install` at the repo root) and
 * `bun run build`. extension/ is standalone (no workspaces) with its own
 * bun.lock, so this script installs it here. trustedDependencies in
 * extension/package.json covers the native postinstalls.
 * PUPPETEER_SKIP_DOWNLOAD skips the Chrome download; the extension build
 * does not need a browser.
 *
 * SLC_E2E must stay unset. A failure exits non-zero so Astro does not publish
 * a page whose download link points at a missing or test build.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const extensionDir = join(root, 'extension');
const downloadsDir = join(root, 'public', 'downloads');

const pkg = JSON.parse(readFileSync(join(extensionDir, 'package.json'), 'utf8'));
const version = pkg.version;
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) {
  fail(`extension/package.json version is not usable: ${JSON.stringify(version)}`);
}

const env = { ...process.env, PUPPETEER_SKIP_DOWNLOAD: '1' };
delete env.SLC_E2E;

function fail(message) {
  console.error(`\nbuild-extension-zip: ${message}`);
  process.exit(1);
}

function run(args) {
  console.log(`\n> bun ${args.join(' ')}`);
  try {
    execFileSync('bun', args, { cwd: extensionDir, env, stdio: 'inherit' });
  } catch (err) {
    const status = typeof err.status === 'number' ? err.status : 1;
    fail(`bun ${args.join(' ')} exited ${status}`);
  }
}

rmSync(downloadsDir, { recursive: true, force: true });
mkdirSync(downloadsDir, { recursive: true });

run(['install', '--frozen-lockfile']);
run(['run', 'build']);
run(['scripts/check-manifest.mjs', 'prod']);
run(['x', 'wxt', 'zip']);

const zipName = findZip(join(extensionDir, '.output'));
const zipPath = join(extensionDir, '.output', zipName);
const zipBuf = readFileSync(zipPath);
const packed = readZip(zipBuf);
const names = packed.entries.map((entry) => entry.name.replace(/\\/g, '/'));
if (!names.includes('manifest.json')) {
  fail(`zip root has no manifest.json (entries: ${names.slice(0, 12).join(', ')})`);
}

const manifest = JSON.parse(unzipEntry(packed, 'manifest.json').toString('utf8'));
const permissions = ['storage', 'scripting', 'declarativeNetRequestWithHostAccess', 'activeTab'];
if (JSON.stringify(manifest.permissions) !== JSON.stringify(permissions)) {
  fail(`permissions ${JSON.stringify(manifest.permissions)}`);
}
if (JSON.stringify(manifest.optional_permissions) !== JSON.stringify(['privacy'])) {
  fail(`optional_permissions ${JSON.stringify(manifest.optional_permissions)}`);
}
if ('host_permissions' in manifest) fail('prod zip has host_permissions');
if ((manifest.permissions || []).includes('privacy')) fail('prod zip grants privacy');
if (/localhost|127\.0\.0\.1/i.test(JSON.stringify(manifest))) fail('prod zip mentions localhost');
if (manifest.version !== version) {
  fail(`manifest version ${manifest.version} does not match package.json ${version}`);
}

const iconEntry = manifest.icons?.['128'];
if (!iconEntry || iconEntry.includes('..')) fail(`manifest icon 128 is ${JSON.stringify(iconEntry)}`);
const iconBytes = unzipEntry(packed, iconEntry.replace(/\\/g, '/'));

const outName = `site-locale-control-${version}.zip`;
writeFileSync(join(downloadsDir, outName), zipBuf);
writeFileSync(join(downloadsDir, 'icon-128.png'), iconBytes);
assertZipDownloadHeader(outName);
console.log(`\nbuild-extension-zip: wrote public/downloads/${outName} (${zipBuf.length} bytes)`);

/**
 * vercel.json names the attachment with :file. @vercel/routing-utils rewrites
 * that token to $1 before the deployment, and the router substitutes the
 * capture. Assert the built zip still matches the source pattern so a version
 * bump cannot ship a file the header does not cover. Content-Type stays the
 * platform default for .zip (application/zip); this rule does not set it.
 */
function assertZipDownloadHeader(outName) {
  const configPath = join(root, 'vercel.json');
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    fail('vercel.json is missing or invalid; the zip download header is not declared');
  }
  const rules = Array.isArray(config.headers) ? config.headers : [];
  const rule = rules.find((entry) =>
    (entry.headers || []).some((item) => String(item.key).toLowerCase() === 'content-disposition'),
  );
  if (!rule) fail('vercel.json has no Content-Disposition header for the extension zip');
  const disposition = rule.headers.find(
    (item) => String(item.key).toLowerCase() === 'content-disposition',
  ).value;
  if (disposition !== 'attachment; filename=":file"') {
    fail(`Content-Disposition must be attachment; filename=":file" (got ${JSON.stringify(disposition)})`);
  }
  const match = String(rule.source || '').match(/:file\((.*)\)\s*$/);
  if (!match) fail(`vercel.json header source has no :file() group: ${rule.source}`);
  let pattern;
  try {
    pattern = new RegExp(`^${match[1]}$`);
  } catch {
    fail(`vercel.json :file() pattern is not a regex: ${match[1]}`);
  }
  if (!pattern.test(outName)) {
    fail(`public/downloads/${outName} does not match vercel.json header source ${rule.source}`);
  }
}

function findZip(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    fail(`missing ${dir} after wxt zip`);
  }
  const zips = names.filter((name) => name.endsWith('.zip') && !name.includes('sources'));
  if (zips.length !== 1) fail(`expected one extension zip in ${dir}, found ${zips.join(', ') || 'none'}`);
  return zips[0];
}

function readZip(buf) {
  let eocd = -1;
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) fail('zip has no end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) fail('zip64 archives are not supported');
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) fail('zip central directory is truncated');
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
    entries.push({ name, method, compSize, localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return { buf, entries };
}

function unzipEntry(packed, name) {
  const entry = packed.entries.find((item) => item.name.replace(/\\/g, '/') === name);
  if (!entry) fail(`zip is missing ${name}`);
  const local = entry.localOffset;
  if (packed.buf.readUInt32LE(local) !== 0x04034b50) fail(`bad local header for ${name}`);
  const nameLen = packed.buf.readUInt16LE(local + 26);
  const extraLen = packed.buf.readUInt16LE(local + 28);
  const start = local + 30 + nameLen + extraLen;
  const data = packed.buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return inflateRawSync(data);
  fail(`unsupported compression method ${entry.method} for ${name}`);
}
