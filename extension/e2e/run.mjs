import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { extname, join, normalize, sep } from 'node:path';
import puppeteer from 'puppeteer';

const OUT = '/workspace/fc-ext-e2e';
const PORT = 4321;
const EXTENSION_ROOT = '/workspace/fc-ext-phase1/extension/.output-e2e';
const seen = { document: '', echo: '' };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

const FRAMES_HTML = `<!doctype html>
<meta charset="utf-8">
<title>frames</title>
<pre id="log"></pre>
<iframe id="same" src="/__e2e/frame-inner.html"></iframe>
<iframe id="srcdoc" srcdoc="<!doctype html><p>srcdoc</p>"></iframe>
<script>
  const blank = document.createElement('iframe');
  blank.id = 'blank';
  document.body.appendChild(blank);
  window.__readFrames = () => {
    const read = (id) => {
      const frame = document.getElementById(id);
      const win = frame && frame.contentWindow;
      if (!win) return { error: 'missing frame' };
      try {
        return {
          tz: win.Intl.DateTimeFormat().resolvedOptions().timeZone,
          off: new win.Date().getTimezoneOffset(),
          langs: Array.from(win.navigator.languages || []),
          loc: win.Intl.DateTimeFormat().resolvedOptions().locale,
        };
      } catch (err) {
        return { error: String(err) };
      }
    };
    const data = { same: read('same'), srcdoc: read('srcdoc'), blank: read('blank') };
    document.getElementById('log').textContent = JSON.stringify(data, null, 2);
    return data;
  };
</script>
`;

const FRAME_INNER = '<!doctype html><meta charset="utf-8"><title>inner</title><p>same-origin</p>';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function availableMb() {
  const text = execFileSync('free', ['-m'], { encoding: 'utf8' });
  const line = text.split('\n').find((row) => row.startsWith('Mem:'));
  if (!line) throw new Error('free -m failed');
  return Number(line.trim().split(/\s+/)[6]);
}

async function waitForMemory() {
  for (let i = 0; i < 40; i += 1) {
    const avail = availableMb();
    console.log(`memory available ${avail} MB`);
    if (avail >= 1500) return avail;
    await sleep(5000);
  }
  throw new Error('available memory stayed below 1500 MB');
}

function findSiteRoot() {
  for (const dir of ['/workspace/fc-ext-phase1/.vercel/output/static', '/workspace/fc-ext-phase1/dist']) {
    if (existsSync(join(dir, 'index.html'))) return dir;
  }
  throw new Error('website build output not found');
}

function findExtensionDir() {
  const hits = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (name === 'manifest.json') hits.push(dir);
    }
  };
  walk(EXTENSION_ROOT);
  if (hits.length !== 1) throw new Error(`expected one e2e manifest, found ${hits.join(', ') || 'none'}`);
  return hits[0];
}

function startServer(siteRoot) {
  const root = normalize(siteRoot);
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const header = String(req.headers['accept-language'] || '');
    if (url.pathname === '/__e2e/echo') {
      seen.echo = header;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ acceptLanguage: header }));
      return;
    }
    if (url.pathname === '/__e2e/frames.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(FRAMES_HTML);
      return;
    }
    if (url.pathname === '/__e2e/frame-inner.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(FRAME_INNER);
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') seen.document = header;
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = normalize(join(root, rel));
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    let target = file;
    if (existsSync(target) && statSync(target).isDirectory()) target = join(target, 'index.html');
    if (!existsSync(target) || !statSync(target).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(target).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, () => resolve(server));
  });
}

function chromeArgs() {
  return [
    '--lang=zh-CN',
    '--accept-lang=zh-CN,zh,en',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-translate',
  ];
}

function chromeEnv() {
  return { ...process.env, TZ: 'Asia/Shanghai', LANG: 'zh_CN.UTF-8' };
}

function findDownloadedChrome() {
  const root = '/workspace/.e2e-cache';
  if (!existsSync(root)) return '';
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > 7) return;
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      let info;
      try {
        info = statSync(abs);
      } catch {
        continue;
      }
      if (info.isDirectory()) walk(abs, depth + 1);
      else if (name === 'chrome') hits.push(abs);
    }
  };
  walk(root, 0);
  return hits.sort((a, b) => b.length - a.length)[0] || '';
}

async function launchChrome(extensionDir) {
  const candidates = [];
  if (existsSync('/usr/bin/google-chrome')) candidates.push('/usr/bin/google-chrome');
  const errors = [];
  for (const executablePath of candidates) {
    let browser;
    try {
      browser = await puppeteer.launch({
        executablePath,
        headless: true,
        pipe: true,
        enableExtensions: Boolean(extensionDir),
        args: chromeArgs(),
        env: chromeEnv(),
        timeout: 60000,
      });
      let id = '';
      if (extensionDir) {
        if (typeof browser.installExtension !== 'function') throw new Error('browser.installExtension is missing');
        id = await browser.installExtension(extensionDir);
      }
      return { browser, id, executablePath };
    } catch (err) {
      errors.push(`${executablePath}: ${err?.stack || err}`);
      if (browser) await browser.close().catch(() => {});
    }
  }
  console.log('system Chrome could not load the extension, downloading Chrome for Testing');
  execFileSync('npx', ['--yes', '@puppeteer/browsers', 'install', 'chrome@stable', '--path', '/workspace/.e2e-cache'], {
    stdio: 'inherit',
  });
  const executablePath = findDownloadedChrome();
  if (!executablePath) throw new Error(`no downloaded chrome\n${errors.join('\n')}`);
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      pipe: true,
      enableExtensions: Boolean(extensionDir),
      args: chromeArgs(),
      env: chromeEnv(),
      timeout: 90000,
    });
    let id = '';
    if (extensionDir) id = await browser.installExtension(extensionDir);
    return { browser, id, executablePath };
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    throw err;
  }
}

async function dismissBanner(page) {
  const banner = await page.$('#locale-banner');
  if (!banner) return;
  const visible = await page
    .$eval('#locale-banner', (node) => getComputedStyle(node).display !== 'none' && node.getClientRects().length > 0)
    .catch(() => false);
  if (visible) await page.click('#locale-banner-close').catch(() => {});
}

async function readScan(page) {
  await page.waitForSelector('#retest', { timeout: 20000 });
  await dismissBanner(page);
  await page.click('#retest');
  await page.waitForFunction(
    () => {
      const rows = [...document.querySelectorAll('[data-signal]')];
      const button = document.querySelector('#retest');
      return rows.length >= 10 && rows.every((row) => row.classList.contains('is-done')) && button && !button.disabled;
    },
    { timeout: 45000 },
  );
  const scan = await page.evaluate(() => ({
    signals: [...document.querySelectorAll('[data-signal]')].map((row) => ({
      id: row.getAttribute('data-signal'),
      raw: row.querySelector('[data-field="value"]')?.textContent?.trim() || '',
      contribution: row.querySelector('[data-field="contribution"]')?.textContent?.trim() || '',
    })),
    total: document.querySelector('#score-value')?.textContent?.trim() || '',
    nativeCode: Intl.DateTimeFormat.toString().includes('[native code]'),
    dateTimeFormatToString: Intl.DateTimeFormat.toString().slice(0, 220),
    leaks: Object.getOwnPropertyNames(window).filter((name) => /slc|9f3e2a/i.test(name)),
    zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    languages: [...navigator.languages],
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
  }));
  const echo = await page.evaluate(async () => {
    const res = await fetch('/__e2e/echo', { cache: 'no-store' });
    return res.json();
  });
  const workerZone = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const url = URL.createObjectURL(new Blob(['postMessage(Intl.DateTimeFormat().resolvedOptions().timeZone)'], { type: 'text/javascript' }));
        const worker = new Worker(url);
        const timer = setTimeout(() => reject(new Error('worker timeout')), 8000);
        worker.onmessage = (event) => {
          clearTimeout(timer);
          worker.terminate();
          resolve(event.data);
        };
        worker.onerror = () => {
          clearTimeout(timer);
          reject(new Error('worker error'));
        };
      }),
  );
  return { scan, echo, workerZone, documentLanguage: seen.document };
}

async function openHome(page, expectZone) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    seen.document = '';
    seen.echo = '';
    await page.goto('http://localhost:4321/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const zone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    if (!expectZone || zone === expectZone) {
      last = await readScan(page);
      return last;
    }
    await sleep(500);
    last = { zone };
  }
  const final = await readScan(page);
  final.retriesExhausted = true;
  return final;
}

async function readFrames(page) {
  await page.goto('http://localhost:4321/__e2e/frames.html', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForFunction(() => document.getElementById('same')?.contentDocument?.readyState === 'complete', { timeout: 10000 }).catch(() => {});
  let data = null;
  for (let i = 0; i < 20; i += 1) {
    data = await page.evaluate(() => window.__readFrames());
    if (data?.same?.tz && data?.srcdoc?.tz && data?.blank?.tz) break;
    await sleep(200);
  }
  return data;
}

async function enableExtension(browser, id) {
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (msg) => logs.push(msg.text()));
  page.on('pageerror', (err) => logs.push(String(err)));
  await page.setViewport({ width: 420, height: 900 });
  await page.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForFunction(() => document.body.dataset.ready === '1', { timeout: 15000 });
  await page.evaluate(() => {
    const main = document.querySelector('main');
    if (main) main.style.maxHeight = 'none';
  });
  await page.screenshot({ path: join(OUT, 'popup.png'), fullPage: true });
  const hosts = await page.$$eval('[data-host]', (nodes) => nodes.map((node) => node.getAttribute('data-host')));
  if (!hosts.includes('localhost')) throw new Error(`localhost missing from popup sites: ${hosts.join(', ')}`);
  await page.click('[data-action="apply-recommended"]');
  await page.waitForFunction(() => document.body.dataset.applied === '1', { timeout: 15000 });
  await page.screenshot({ path: join(OUT, 'popup-applied.png'), fullPage: true });
  const registration = await page.evaluate(async () => {
    const deadline = Date.now() + 15000;
    let scripts = [];
    let rules = [];
    while (Date.now() < deadline) {
      scripts = await chrome.scripting.getRegisteredContentScripts();
      rules = await chrome.declarativeNetRequest.getDynamicRules();
      const scriptReady = scripts.some((script) => (script.matches || []).some((match) => String(match).includes('localhost')));
      const ruleReady = rules.some((rule) => (rule.condition?.requestDomains || []).includes('localhost'));
      if (scriptReady && ruleReady) return { ok: true, scripts, rules };
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return { ok: false, scripts, rules };
  });
  const meta = await page.evaluate(() => ({
    perm: document.body.dataset.perm || '',
    status: document.querySelector('[data-field="status"]')?.textContent || '',
    warning: document.querySelector('[data-field="warning"]')?.textContent || '',
  }));
  await page.close();
  if (!registration.ok) {
    throw new Error(`localhost script or rule missing ${JSON.stringify({ meta, registration, logs }).slice(0, 4000)}`);
  }
  return { ...meta, logs, scriptCount: registration.scripts.length, ruleCount: registration.rules.length };
}

async function runRound({ extension, extensionDir, label }) {
  await waitForMemory();
  const { browser, id, executablePath } = await launchChrome(extension ? extensionDir : '');
  const logs = [];
  try {
    let popup = null;
    if (extension) {
      const worker = await browser.waitForTarget((target) => target.type() === 'service_worker' && target.url().includes(id), { timeout: 20000 }).catch(() => null);
      if (!worker) console.log('service worker target not visible yet');
      await sleep(500);
      popup = await enableExtension(browser, id);
    }
    const page = await browser.newPage();
    page.on('console', (msg) => logs.push(`${label}: ${msg.text()}`));
    page.on('pageerror', (err) => logs.push(`${label} error: ${err}`));
    const home = await openHome(page, extension ? 'America/Los_Angeles' : '');
    await page.screenshot({ path: join(OUT, `${label}-home.png`) });
    const scan = await page.$('#scan');
    if (scan) await scan.screenshot({ path: join(OUT, `${label}-scan.png`) });
    const frames = await readFrames(page);
    await page.screenshot({ path: join(OUT, `${label}-frames.png`) });
    await page.close();
    return {
      label,
      executablePath,
      extensionId: id,
      popup,
      ...home,
      frames,
      logs: logs.slice(0, 40),
    };
  } finally {
    await browser.close();
  }
}

function row(round, id) {
  return round?.scan?.signals?.find((item) => item.id === id) || { raw: '', contribution: '' };
}

function markdown(results, failures) {
  const ids = results.baseline?.scan?.signals?.map((item) => item.id) || results.enabled?.scan?.signals?.map((item) => item.id) || [];
  const lines = [
    '# Site Locale Control 端到端对比',
    '',
    `浏览器时区环境：\`TZ=Asia/Shanghai\`，启动参数 \`--lang=zh-CN\`。`,
    '',
    '| 信号 | 基线 raw | 基线贡献 | 启用后 raw | 启用后贡献 |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const id of ids) {
    const before = row(results.baseline, id);
    const after = row(results.enabled, id);
    lines.push(`| ${id} | ${before.raw} | ${before.contribution} | ${after.raw} | ${after.contribution} |`);
  }
  lines.push(`| 总分 |  | ${results.baseline?.scan?.total || ''} |  | ${results.enabled?.scan?.total || ''} |`);
  lines.push('');
  lines.push('## 请求头与帧');
  lines.push('');
  lines.push('| 项目 | 基线 | 启用后 |');
  lines.push('| --- | --- | --- |');
  const fields = [
    ['文档 Accept-Language', results.baseline?.documentLanguage, results.enabled?.documentLanguage],
    ['/__e2e/echo Accept-Language', results.baseline?.echo?.acceptLanguage, results.enabled?.echo?.acceptLanguage],
    ['页面 Intl 时区', results.baseline?.scan?.zone, results.enabled?.scan?.zone],
    ['Worker Intl 时区', results.baseline?.workerZone, results.enabled?.workerZone],
    ['DateTimeFormat.toString 含 [native code]', results.baseline?.scan?.nativeCode, results.enabled?.scan?.nativeCode],
    ['同源 iframe 时区', results.baseline?.frames?.same?.tz, results.enabled?.frames?.same?.tz],
    ['srcdoc iframe 时区', results.baseline?.frames?.srcdoc?.tz, results.enabled?.frames?.srcdoc?.tz],
    ['about:blank iframe 时区', results.baseline?.frames?.blank?.tz, results.enabled?.frames?.blank?.tz],
    ['同源 iframe 语言', (results.baseline?.frames?.same?.langs || []).join(', '), (results.enabled?.frames?.same?.langs || []).join(', ')],
    ['泄露的全局名', (results.baseline?.scan?.leaks || []).join(', '), (results.enabled?.scan?.leaks || []).join(', ')],
  ];
  for (const [name, before, after] of fields) lines.push(`| ${name} | ${before ?? ''} | ${after ?? ''} |`);
  lines.push('');
  lines.push('## 已知缺口');
  lines.push('');
  lines.push('- Worker 有自己的原生环境，扩展没有改 Worker 里的 `Intl` 时区。');
  lines.push('- 包装后的 `Intl.DateTimeFormat.toString()` 不再是 `[native code]`，页面可以据此发现补丁。');
  lines.push('- 已经打开的页面要刷新后才吃到新配置。扩展不会自动刷新，也不会用 `postMessage` 传配置。');
  lines.push('- 跨源 iframe 只有在该源已被授权时才会注入。未授权的跨源帧保持原样。');
  if (failures.length) {
    lines.push('');
    lines.push('## 失败');
    lines.push('');
    for (const failure of failures) lines.push(`- ${failure}`);
  }
  return `${lines.join('\n')}\n`;
}

function assertResults(results) {
  const failures = [];
  const check = (ok, message) => {
    if (!ok) failures.push(message);
  };
  const baseTz = row(results.baseline, 'timezone');
  const baseOff = row(results.baseline, 'timezoneOffset');
  const nextTz = row(results.enabled, 'timezone');
  const nextOff = row(results.enabled, 'timezoneOffset');
  const nextLang = row(results.enabled, 'language');
  const nextIntl = row(results.enabled, 'intlLocale');
  check(baseTz.raw === 'Asia/Shanghai', `baseline timezone ${baseTz.raw}`);
  check(baseOff.raw === 'UTC+8', `baseline offset ${baseOff.raw}`);
  check(baseOff.contribution === '+2', `baseline offset contribution ${baseOff.contribution}`);
  check(/zh/i.test(results.baseline?.documentLanguage || ''), `baseline document language ${results.baseline?.documentLanguage}`);
  check(/zh/i.test(results.baseline?.echo?.acceptLanguage || ''), `baseline echo language ${results.baseline?.echo?.acceptLanguage}`);
  check(results.baseline?.scan?.nativeCode === true, 'baseline DateTimeFormat.toString lost [native code]');
  check(results.baseline?.workerZone === results.baseline?.scan?.zone, `baseline worker ${results.baseline?.workerZone}`);
  check(nextTz.raw === 'America/Los_Angeles', `enabled timezone ${nextTz.raw}`);
  check(nextTz.contribution === '+0', `enabled timezone contribution ${nextTz.contribution}`);
  check(nextOff.contribution === '+0', `enabled offset contribution ${nextOff.contribution}`);
  check(nextOff.raw !== 'UTC+8' && nextOff.raw === 'UTC-7', `enabled offset raw ${nextOff.raw}`);
  // The site lowercases navigator.languages before writing the row. The live list stays en-US.
  check(/^en-us\b/i.test(nextLang.raw), `enabled language ${nextLang.raw}`);
  check(results.enabled?.scan?.languages?.[0] === 'en-US', `enabled navigator.languages ${results.enabled?.scan?.languages}`);
  check(nextLang.contribution === '+0', `enabled language contribution ${nextLang.contribution}`);
  check(nextIntl.raw.toLowerCase().startsWith('en'), `enabled intl ${nextIntl.raw}`);
  check(nextIntl.contribution === '+0', `enabled intl contribution ${nextIntl.contribution}`);
  check((results.enabled?.documentLanguage || '').toLowerCase() === 'en-us,en;q=0.9', `enabled document language ${results.enabled?.documentLanguage}`);
  check((results.enabled?.echo?.acceptLanguage || '').toLowerCase() === 'en-us,en;q=0.9', `enabled echo language ${results.enabled?.echo?.acceptLanguage}`);
  check(results.enabled?.frames?.same?.tz === 'America/Los_Angeles', `same-origin frame ${results.enabled?.frames?.same?.tz}`);
  check(results.enabled?.frames?.same?.langs?.[0] === 'en-US', `same-origin langs ${results.enabled?.frames?.same?.langs}`);
  check(results.enabled?.frames?.srcdoc?.tz === 'America/Los_Angeles', `srcdoc frame ${JSON.stringify(results.enabled?.frames?.srcdoc)}`);
  check(results.enabled?.frames?.blank?.tz === 'America/Los_Angeles', `about:blank frame ${JSON.stringify(results.enabled?.frames?.blank)}`);
  check(results.enabled?.workerZone === 'Asia/Shanghai', `worker was patched: ${results.enabled?.workerZone}`);
  check(results.enabled?.scan?.nativeCode === false, 'enabled DateTimeFormat.toString still looks native');
  check((results.enabled?.scan?.leaks || []).length === 0, `leaked globals ${results.enabled?.scan?.leaks}`);
  check(/zh/i.test(row(results.baseline, 'language').raw), `baseline language ${row(results.baseline, 'language').raw}`);
  return failures;
}

function writeOutputs(results, failures) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'results.json'), JSON.stringify({ ...results, failures }, null, 2));
  writeFileSync(join(OUT, 'results.md'), markdown(results, failures));
}

const results = { startedAt: new Date().toISOString() };
let server;
try {
  mkdirSync(OUT, { recursive: true });
  await waitForMemory();
  const siteRoot = findSiteRoot();
  const extensionDir = findExtensionDir();
  console.log('site', siteRoot);
  console.log('extension', extensionDir);
  server = await startServer(siteRoot);
  const probe = await fetch('http://127.0.0.1:4321/');
  if (!probe.ok) throw new Error(`local server status ${probe.status}`);
  const viaLocalhost = await fetch('http://localhost:4321/');
  if (!viaLocalhost.ok) throw new Error('localhost did not reach the server');
  results.baseline = await runRound({ extension: false, label: 'baseline' });
  results.enabled = await runRound({ extension: true, extensionDir, label: 'enabled' });
  const failures = assertResults(results);
  results.finishedAt = new Date().toISOString();
  writeOutputs(results, failures);
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('e2e passed');
  }
} catch (err) {
  results.error = err?.stack || String(err);
  results.finishedAt = new Date().toISOString();
  try {
    writeOutputs(results, [results.error]);
  } catch (writeErr) {
    console.error(writeErr);
  }
  console.error(results.error);
  process.exitCode = 1;
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
}
process.exit(process.exitCode || 0);
