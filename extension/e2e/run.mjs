import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { renderWebRtcCftSection, runWebRtcCftAndMerge } from './webrtc-cft.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = join(HERE, '..');
const REPO_ROOT = join(EXTENSION_DIR, '..');
const OUT = '/workspace/fc-ext-e2e2';
const TMP = '/workspace/.fc-e2e-tmp';
const PORT = 4321;
const EXTENSION_OUTPUT = join(EXTENSION_DIR, '.output-e2e');

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

const ACCEPT_CH = [
  'Sec-CH-UA',
  'Sec-CH-UA-Mobile',
  'Sec-CH-UA-Platform',
  'Sec-CH-UA-Full-Version-List',
  'Sec-CH-UA-Platform-Version',
  'Sec-CH-UA-Model',
  'Sec-CH-UA-Arch',
  'Sec-CH-UA-Bitness',
  'Sec-CH-UA-WoW64',
].join(', ');

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
  const probe = (win) => {
    const canvas = win.document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const text = '中文字体检测ABCabc012';
    const fontHit = (name) => {
      ctx.font = '72px monospace';
      const base = ctx.measureText(text).width;
      ctx.font = '72px "' + name + '", monospace';
      const width = ctx.measureText(text).width;
      let check = null;
      try { check = win.document.fonts.check('72px "' + name + '"'); } catch (err) { check = String(err); }
      return { diff: Math.abs(width - base), hit: Math.abs(width - base) > 0.5, check };
    };
    return {
      tz: win.Intl.DateTimeFormat().resolvedOptions().timeZone,
      off: new win.Date().getTimezoneOffset(),
      langs: Array.from(win.navigator.languages || []),
      loc: win.Intl.DateTimeFormat().resolvedOptions().locale,
      ua: win.navigator.userAgent,
      platform: win.navigator.platform,
      noto: fontHit('Noto Sans CJK SC'),
      mi: fontHit('MiSans'),
    };
  };
  window.__readFrames = () => {
    const read = (id) => {
      const frame = document.getElementById(id);
      const win = frame && frame.contentWindow;
      if (!win) return { error: 'missing frame' };
      try { return probe(win); } catch (err) { return { error: String(err) }; }
    };
    const data = { same: read('same'), srcdoc: read('srcdoc'), blank: read('blank') };
    document.getElementById('log').textContent = JSON.stringify(data, null, 2);
    return data;
  };
</script>
`;

const FRAME_INNER = '<!doctype html><meta charset="utf-8"><title>inner</title><p>same-origin</p>';

const WEBRTC_HTML = `<!doctype html>
<meta charset="utf-8">
<title>webrtc</title>
<pre id="out">collecting</pre>
<script>
  window.__webrtcDone = false;
  window.__webrtc = null;
  const ipRe = /([0-9]{1,3}(\\.[0-9]{1,3}){3}|[a-f0-9]{0,4}(?::[a-f0-9]{0,4}){2,7})/i;
  function tally(lines) {
    const counts = { host: 0, srflx: 0, prflx: 0, relay: 0, mdns: 0 };
    for (const line of lines) {
      if (!line) continue;
      if (line.includes('.local')) counts.mdns += 1;
      const typ = / typ (host|srflx|prflx|relay)/.exec(line);
      if (!typ || !ipRe.test(line)) continue;
      counts[typ[1]] += 1;
    }
    return counts;
  }
  function finish(pc, error) {
    if (window.__webrtcDone) return;
    window.__webrtcDone = true;
    const sdp = (pc && pc.localDescription && pc.localDescription.sdp) || '';
    window.__webrtc = {
      candidates: window.__candidates,
      sdp,
      counts: tally(window.__candidates),
      sdpCounts: tally(sdp.split(/\\r?\\n/)),
      error: error || '',
      gathering: pc ? pc.iceGatheringState : '',
    };
    document.getElementById('out').textContent = JSON.stringify(window.__webrtc, null, 2);
    try { if (pc) pc.close(); } catch (err) {}
  }
  window.__candidates = [];
  try {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    pc.onicecandidate = (event) => {
      window.__candidates.push(event.candidate && event.candidate.candidate ? event.candidate.candidate : '');
      if (!event.candidate) finish(pc, '');
    };
    pc.createDataChannel('');
    pc.createOffer().then((offer) => pc.setLocalDescription(offer)).catch((err) => finish(pc, String(err)));
    setTimeout(() => finish(pc, ''), 3500);
  } catch (err) {
    window.__webrtcDone = true;
    window.__webrtc = { error: String(err), candidates: [], sdp: '', counts: {}, sdpCounts: {} };
  }
</script>
`;

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
  for (const dir of [join(REPO_ROOT, '.vercel/output/static'), join(REPO_ROOT, 'dist')]) {
    if (existsSync(join(dir, 'index.html'))) return dir;
  }
  throw new Error(`website build output not found under ${REPO_ROOT}`);
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
  walk(EXTENSION_OUTPUT);
  if (hits.length !== 1) throw new Error(`expected one e2e manifest, found ${hits.join(', ') || 'none'}`);
  return hits[0];
}

function interestingHeaders(req) {
  const out = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (key === 'user-agent' || key === 'accept-language' || key.startsWith('sec-ch-ua')) out[key] = value;
  }
  return out;
}

function startServer(siteRoot) {
  const root = normalize(siteRoot);
  const seen = { document: null };
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const headers = interestingHeaders(req);
    if (url.pathname === '/' || url.pathname === '/index.html') seen.document = headers;
    const common = {
      'cache-control': 'no-store',
      'accept-ch': ACCEPT_CH,
    };
    if (url.pathname === '/__e2e/echo') {
      res.writeHead(200, { ...common, 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(headers));
      return;
    }
    if (url.pathname === '/__e2e/frames.html') {
      res.writeHead(200, { ...common, 'content-type': 'text/html; charset=utf-8' });
      res.end(FRAMES_HTML);
      return;
    }
    if (url.pathname === '/__e2e/frame-inner.html') {
      res.writeHead(200, { ...common, 'content-type': 'text/html; charset=utf-8' });
      res.end(FRAME_INNER);
      return;
    }
    if (url.pathname === '/__e2e/webrtc.html') {
      res.writeHead(200, { ...common, 'content-type': 'text/html; charset=utf-8' });
      res.end(WEBRTC_HTML);
      return;
    }
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
    res.writeHead(200, { ...common, 'content-type': MIME[extname(target).toLowerCase()] || 'application/octet-stream' });
    createReadStream(target).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, () => resolve({ server, seen }));
  });
}

function chromeMajor() {
  const text = execFileSync('/usr/bin/google-chrome', ['--version'], { encoding: 'utf8' }).trim();
  const match = /(\d+)\./.exec(text);
  if (!match) throw new Error(`chrome version: ${text}`);
  return { text, major: Number(match[1]) };
}

function prepareVendorFont() {
  const note = { ok: false, detail: '' };
  try {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(join(TMP, 'fonts'), { recursive: true });
    mkdirSync(join(TMP, 'py'), { recursive: true });
    mkdirSync(join(TMP, 'cache'), { recursive: true });
    execFileSync('pip', ['install', '--disable-pip-version-check', '--target', join(TMP, 'py'), 'fonttools'], {
      stdio: 'inherit',
    });
    const src = '/usr/share/fonts/opentype/urw-base35/NimbusSans-Regular.otf';
    const dst = join(TMP, 'fonts', 'MiSans.otf');
    const script = `
from fontTools.ttLib import TTFont
font = TTFont(${JSON.stringify(src)})
name = font['name']
for rec in list(name.names):
    if rec.nameID in (1, 4, 6, 16):
        name.setName('MiSans', rec.nameID, rec.platformID, rec.platEncID, rec.langID)
font.save(${JSON.stringify(dst)})
print('saved')
`;
    execFileSync('python3', ['-c', script], {
      env: { ...process.env, PYTHONPATH: join(TMP, 'py') },
      stdio: 'inherit',
    });
    const fontsConf = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <dir>${join(TMP, 'fonts')}</dir>
  <cachedir>${join(TMP, 'cache')}</cachedir>
</fontconfig>
`;
    writeFileSync(join(TMP, 'fonts.conf'), fontsConf);
    const listed = execFileSync('fc-list', [':', 'family'], {
      env: { ...process.env, FONTCONFIG_FILE: join(TMP, 'fonts.conf') },
      encoding: 'utf8',
    });
    note.ok = listed.split('\n').some((line) => line.trim() === 'MiSans' || line.includes('MiSans'));
    note.detail = note.ok ? 'fc-list reports MiSans' : 'fc-list did not report MiSans';
    note.sample = listed.split('\n').filter((line) => /MiSans|Noto Sans CJK SC/.test(line)).slice(0, 8);
  } catch (err) {
    note.ok = false;
    note.detail = err?.stack || String(err);
  }
  return note;
}

function chromeArgs(userAgent) {
  const args = [
    '--lang=zh-CN',
    '--accept-lang=zh-CN,zh,en',
    '--disable-features=WebRtcHideLocalIpsWithMdns',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-translate',
  ];
  if (userAgent) args.push(`--user-agent=${userAgent}`);
  return args;
}

function chromeEnv(fontconfig) {
  const env = { ...process.env, TZ: 'Asia/Shanghai', LANG: 'zh_CN.UTF-8' };
  if (fontconfig) env.FONTCONFIG_FILE = fontconfig;
  return env;
}

async function launchChrome({ extensionDir, userAgent, fontconfig, label }) {
  if (!existsSync('/usr/bin/google-chrome')) throw new Error('missing /usr/bin/google-chrome');
  const userDataDir = join('/tmp', `slc-e2e-${label}-${Date.now()}`);
  if (userDataDir.includes('chrome-profile')) throw new Error('refusing the desktop chrome profile');
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: true,
    pipe: true,
    enableExtensions: Boolean(extensionDir),
    userDataDir,
    args: chromeArgs(userAgent),
    env: chromeEnv(fontconfig),
    timeout: 60000,
  });
  let id = '';
  if (extensionDir) {
    if (typeof browser.installExtension !== 'function') throw new Error('browser.installExtension is missing');
    id = await browser.installExtension(extensionDir);
  }
  return { browser, id, userDataDir };
}

async function closeBrowser(session) {
  if (!session) return;
  await session.browser.close().catch(() => {});
  rmSync(session.userDataDir, { recursive: true, force: true });
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
    leaks: Object.getOwnPropertyNames(window).filter((name) => /slc|9f3e2a/i.test(name)),
    zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    languages: [...navigator.languages],
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
  }));
  const echo = await page.evaluate(async () => {
    await fetch('/__e2e/echo', { cache: 'no-store' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const res = await fetch('/__e2e/echo', { cache: 'no-store' });
    return res.json();
  });
  const navigatorProbe = await page.evaluate(async () => {
    const data = navigator.userAgentData;
    let high = null;
    try {
      high = data ? await data.getHighEntropyValues(['model', 'platform', 'platformVersion', 'fullVersionList', 'architecture', 'bitness', 'wow64']) : null;
    } catch (err) {
      high = { error: String(err) };
    }
    return {
      userAgent: navigator.userAgent,
      appVersion: navigator.appVersion,
      platform: navigator.platform,
      vendor: navigator.vendor,
      brands: data ? data.brands : null,
      mobile: data ? data.mobile : null,
      uaPlatform: data ? data.platform : null,
      high,
    };
  });
  const fonts = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const text = '中文字体检测ABCabc012';
    return ['Noto Sans CJK SC', 'MiSans', 'monospace'].map((font) => {
      ctx.font = '72px monospace';
      const base = ctx.measureText(text).width;
      ctx.font = `72px "${font}", monospace`;
      const width = ctx.measureText(text).width;
      let check = null;
      try { check = document.fonts.check(`72px "${font}"`); } catch (err) { check = String(err); }
      return { font, base, width, diff: Math.abs(width - base), hit: Math.abs(width - base) > 0.5, check };
    });
  });
  const toStringProbe = await page.evaluate(() => {
    const desc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent');
    const text = (fn) => {
      try { return Function.prototype.toString.call(fn); } catch (err) { return String(err); }
    };
    const dtf = text(Intl.DateTimeFormat);
    const measure = text(CanvasRenderingContext2D.prototype.measureText);
    const rtc = text(window.RTCPeerConnection);
    const getter = desc && desc.get ? text(desc.get) : '';
    return {
      dateTimeFormatNative: dtf.includes('[native code]'),
      measureTextNative: measure.includes('[native code]'),
      rtcNative: rtc.includes('[native code]'),
      uaGetterNative: getter.includes('[native code]'),
      dateTimeFormat: dtf.slice(0, 160),
      measureText: measure.slice(0, 160),
      rtc: rtc.slice(0, 160),
      uaGetter: getter.slice(0, 160),
    };
  });
  const workerUa = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const url = URL.createObjectURL(new Blob(['postMessage(navigator.userAgent)'], { type: 'text/javascript' }));
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
  return { scan, echo, navigatorProbe, fonts, toStringProbe, workerUa };
}

async function readFrames(page) {
  await page.goto('http://localhost:4321/__e2e/frames.html', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForFunction(() => document.getElementById('same')?.contentDocument?.readyState === 'complete', { timeout: 10000 }).catch(() => {});
  let data = null;
  for (let i = 0; i < 20; i += 1) {
    data = await page.evaluate(() => window.__readFrames());
    if (data?.same?.ua && data?.srcdoc?.ua && data?.blank?.ua) break;
    await sleep(200);
  }
  return data;
}

async function readWebrtc(page) {
  await page.goto('http://localhost:4321/__e2e/webrtc.html', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForFunction(() => window.__webrtcDone === true, { timeout: 8000 }).catch(() => {});
  return page.evaluate(() => window.__webrtc);
}

async function configurePopup(browser, id, mode, shot) {
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (msg) => logs.push(msg.text()));
  page.on('pageerror', (err) => logs.push(String(err)));
  await page.setViewport({ width: 460, height: 1100 });
  await page.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForFunction(() => document.body.dataset.ready === '1', { timeout: 15000 });
  await page.evaluate(() => {
    const main = document.querySelector('main');
    if (main) main.style.maxHeight = 'none';
  });
  const hosts = await page.$$eval('[data-host]', (nodes) => nodes.map((node) => node.getAttribute('data-host')));
  if (!hosts.includes('localhost')) throw new Error(`localhost missing from popup sites: ${hosts.join(', ')}`);
  if (mode === 'phase1') {
    for (const field of ['timezone', 'timezone-offset', 'language', 'intl', 'master']) {
      await page.evaluate(() => { document.body.dataset.applied = ''; });
      await page.click(`[data-field="${field}"]`);
      await page.waitForFunction(() => document.body.dataset.applied === '1', { timeout: 15000 });
    }
  } else {
    await page.evaluate(() => { document.body.dataset.applied = ''; });
    await page.click('[data-action="apply-recommended"]');
    await page.waitForFunction(() => document.body.dataset.applied === '1', { timeout: 15000 });
  }
  await page.screenshot({ path: shot, fullPage: true });
  const registration = await page.evaluate(async (phase) => {
    const deadline = Date.now() + 15000;
    let scripts = [];
    let rules = [];
    while (Date.now() < deadline) {
      scripts = await chrome.scripting.getRegisteredContentScripts();
      rules = await chrome.declarativeNetRequest.getDynamicRules();
      const files = scripts.flatMap((script) => script.js || []);
      const matched = scripts.some((script) => (script.matches || []).some((match) => String(match).includes('localhost')));
      const phase1 = files.some((file) => String(file).includes('timezone-on')) && !files.some((file) => /fonts-on|webrtc-on|snippets\/ua\//.test(String(file)));
      const phase2 = files.some((file) => String(file).includes('fonts-on')) && files.some((file) => String(file).includes('webrtc-on'));
      if (matched && (phase === 'phase1' ? phase1 : phase2)) {
        const notes = await chrome.storage.local.get('slc-dnr-notes');
        return { ok: true, scripts, rules, notes };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return { ok: false, scripts, rules };
  }, mode);
  const meta = await page.evaluate(() => ({
    perm: document.body.dataset.perm || '',
    suggestDesktop: document.body.dataset.suggestDesktop || '',
    uaPreset: document.body.dataset.uaPreset || '',
    cnBrowser: document.querySelector('[data-field="cn-browser"]')?.textContent || '',
    cnDevice: document.querySelector('[data-field="cn-device"]')?.textContent || '',
    uaPreview: document.querySelector('[data-field="ua-preview"]')?.textContent || '',
    platform: document.querySelector('[data-field="ua-platform"]')?.textContent || '',
    suggest: document.querySelector('[data-field="ua-suggest"]')?.textContent || '',
    status: document.querySelector('[data-field="status"]')?.textContent || '',
  }));
  await page.close();
  if (!registration.ok) throw new Error(`registration failed ${JSON.stringify({ meta, registration, logs }).slice(0, 4000)}`);
  return { meta, logs, registration };
}

async function runRound({ extensionDir, userAgent, fontconfig, label, mode }) {
  await waitForMemory();
  const session = await launchChrome({
    extensionDir: mode === 'off' ? '' : extensionDir,
    userAgent,
    fontconfig,
    label,
  });
  try {
    let popup = null;
    if (mode !== 'off') {
      await session.browser.waitForTarget((target) => target.type() === 'service_worker' && target.url().includes(session.id), { timeout: 20000 }).catch(() => null);
      await sleep(400);
      popup = await configurePopup(session.browser, session.id, mode, join(OUT, `${label}-popup.png`));
    }
    const page = await session.browser.newPage();
    await page.goto('http://localhost:4321/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const home = await readScan(page);
    await page.screenshot({ path: join(OUT, `${label}-home.png`) });
    const scan = await page.$('#scan');
    if (scan) await scan.screenshot({ path: join(OUT, `${label}-scan.png`) });
    const frames = await readFrames(page);
    const webrtc = await readWebrtc(page);
    await page.screenshot({ path: join(OUT, `${label}-webrtc.png`) });
    await page.close();
    return { label, mode, popup, ...home, frames, webrtc };
  } finally {
    await closeBrowser(session);
  }
}

async function runPolicy(extensionDir, fontconfig) {
  await waitForMemory();
  const session = await launchChrome({ extensionDir, fontconfig, label: 'policy' });
  try {
    await session.browser.waitForTarget((target) => target.type() === 'service_worker' && target.url().includes(session.id), { timeout: 20000 }).catch(() => null);
    const page = await session.browser.newPage();
    await page.setViewport({ width: 460, height: 1100 });
    await page.goto(`chrome-extension://${session.id}/popup.html`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForFunction(() => document.body.dataset.ready === '1', { timeout: 15000 });
    await page.evaluate(() => {
      const main = document.querySelector('main');
      if (main) main.style.maxHeight = 'none';
    });
    await page.click('[data-action="webrtc-policy"]');
    await page.waitForSelector('[data-field="webrtc-confirm"]', { visible: true, timeout: 5000 });
    const confirmText = await page.$eval('[data-field="webrtc-confirm"]', (node) => node.textContent || '');
    const before = await page.evaluate(async () => {
      const got = await chrome.privacy.network.webRTCIPHandlingPolicy.get({});
      return { value: got.value, levelOfControl: got.levelOfControl };
    });
    await page.click('[data-action="confirm-webrtc-policy"]');
    await page.waitForFunction((previous) => {
      const value = document.body.dataset.webrtcPolicy || '';
      const error = document.querySelector('[data-field="webrtc-error"]')?.textContent || '';
      return value === 'disable_non_proxied_udp' || value === 'denied' || value === 'error' || error.length > 0 || (value && value === previous);
    }, { timeout: 10000 }, before.value);
    const ui = await page.evaluate(() => ({
      policy: document.body.dataset.webrtcPolicy || '',
      error: document.querySelector('[data-field="webrtc-error"]')?.textContent || '',
      now: document.querySelector('[data-field="webrtc-state"]')?.textContent || '',
    }));
    const setValue = await page.evaluate(async () => {
      const got = await chrome.privacy.network.webRTCIPHandlingPolicy.get({});
      return { value: got.value, levelOfControl: got.levelOfControl };
    });
    const readPolicy = async () => page.evaluate(async () => {
      try {
        const got = await chrome.privacy.network.webRTCIPHandlingPolicy.get({});
        return { value: got.value, levelOfControl: got.levelOfControl };
      } catch (err) {
        return { error: String(err) };
      }
    });
    let cleared;
    if (setValue.value === 'disable_non_proxied_udp') {
      await page.click('[data-action="revoke-webrtc-policy"]');
      await page.waitForFunction(() => {
        const value = document.body.dataset.webrtcPolicy || '';
        return value && value !== 'disable_non_proxied_udp';
      }, { timeout: 10000 });
      cleared = await readPolicy();
    } else {
      await page.click('[data-action="revoke-webrtc-policy"]');
      await sleep(600);
      cleared = await readPolicy();
      cleared.note = 'set was not applied; clear cannot override a policy the extension does not control';
    }
    await page.screenshot({ path: join(OUT, 'webrtc-policy.png'), fullPage: true });
    await page.close();
    return { confirmText, before, setValue, cleared, ui };
  } finally {
    await closeBrowser(session);
  }
}

function row(round, id) {
  return round?.scan?.signals?.find((item) => item.id === id) || { raw: '', contribution: '' };
}

function cell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function signalTable(rounds) {
  const ids = rounds.off?.scan?.signals?.map((item) => item.id) || [];
  const lines = [
    '| 信号 | off raw | off 贡献 | phase-1 raw | phase-1 贡献 | phase-2 raw | phase-2 贡献 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const id of ids) {
    lines.push(`| ${id} | ${cell(row(rounds.off, id).raw)} | ${cell(row(rounds.off, id).contribution)} | ${cell(row(rounds.phase1, id).raw)} | ${cell(row(rounds.phase1, id).contribution)} | ${cell(row(rounds.phase2, id).raw)} | ${cell(row(rounds.phase2, id).contribution)} |`);
  }
  lines.push(`| 总分 |  | ${cell(rounds.off?.scan?.total)} |  | ${cell(rounds.phase1?.scan?.total)} |  | ${cell(rounds.phase2?.scan?.total)} |`);
  return lines;
}

function headerTable(rounds) {
  const keys = ['user-agent', 'accept-language', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'sec-ch-ua-full-version-list', 'sec-ch-ua-platform-version', 'sec-ch-ua-model', 'sec-ch-ua-arch', 'sec-ch-ua-bitness', 'sec-ch-ua-wow64'];
  const lines = ['| 请求头 | off | phase-1 | phase-2 |', '| --- | --- | --- | --- |'];
  for (const key of keys) {
    lines.push(`| ${key} | ${cell(rounds.off?.echo?.[key])} | ${cell(rounds.phase1?.echo?.[key])} | ${cell(rounds.phase2?.echo?.[key])} |`);
  }
  lines.push(`| 页面 UA | ${cell(rounds.off?.navigatorProbe?.userAgent)} | ${cell(rounds.phase1?.navigatorProbe?.userAgent)} | ${cell(rounds.phase2?.navigatorProbe?.userAgent)} |`);
  lines.push(`| 页面 platform | ${cell(rounds.off?.navigatorProbe?.platform)} | ${cell(rounds.phase1?.navigatorProbe?.platform)} | ${cell(rounds.phase2?.navigatorProbe?.platform)} |`);
  lines.push(`| brands | ${cell(JSON.stringify(rounds.off?.navigatorProbe?.brands))} | ${cell(JSON.stringify(rounds.phase1?.navigatorProbe?.brands))} | ${cell(JSON.stringify(rounds.phase2?.navigatorProbe?.brands))} |`);
  lines.push(`| high entropy | ${cell(JSON.stringify(rounds.off?.navigatorProbe?.high))} | ${cell(JSON.stringify(rounds.phase1?.navigatorProbe?.high))} | ${cell(JSON.stringify(rounds.phase2?.navigatorProbe?.high))} |`);
  lines.push(`| Worker UA | ${cell(rounds.off?.workerUa)} | ${cell(rounds.phase1?.workerUa)} | ${cell(rounds.phase2?.workerUa)} |`);
  return lines;
}

function webrtcTable(rounds) {
  const lines = ['| 项目 | off | phase-1 | phase-2 |', '| --- | --- | --- | --- |'];
  for (const key of ['host', 'srflx', 'prflx', 'relay', 'mdns']) {
    lines.push(`| 事件中含 IP 的 ${key} | ${rounds.off?.webrtc?.counts?.[key] ?? ''} | ${rounds.phase1?.webrtc?.counts?.[key] ?? ''} | ${rounds.phase2?.webrtc?.counts?.[key] ?? ''} |`);
    lines.push(`| SDP 中含 IP 的 ${key} | ${rounds.off?.webrtc?.sdpCounts?.[key] ?? ''} | ${rounds.phase1?.webrtc?.sdpCounts?.[key] ?? ''} | ${rounds.phase2?.webrtc?.sdpCounts?.[key] ?? ''} |`);
  }
  lines.push(`| 收集状态 | ${cell(rounds.off?.webrtc?.gathering)} | ${cell(rounds.phase1?.webrtc?.gathering)} | ${cell(rounds.phase2?.webrtc?.gathering)} |`);
  lines.push(`| 错误 | ${cell(rounds.off?.webrtc?.error)} | ${cell(rounds.phase1?.webrtc?.error)} | ${cell(rounds.phase2?.webrtc?.error)} |`);
  return lines;
}

function markdown(results, failures) {
  const lines = [
    '# Site Locale Control 第二期端到端对比',
    '',
    '环境：`TZ=Asia/Shanghai`，`--lang=zh-CN`，`--accept-lang=zh-CN,zh,en`，`--disable-features=WebRtcHideLocalIpsWithMdns`。',
    '',
    `Chrome：${results.chrome?.text || ''}`,
    '',
    `厂商字体：${results.vendorFont?.ok ? '已让 fc-list 看到 MiSans' : '未生效'}。${results.vendorFont?.detail || ''}`,
    '',
  ];
  for (const name of ['A', 'B']) {
    const scenario = results.scenarios?.[name];
    if (!scenario) continue;
    lines.push(`## 场景 ${name}`, '', scenario.note || '', '');
    lines.push(...signalTable(scenario.rounds), '');
    lines.push('### 请求头与 navigator', '', ...headerTable(scenario.rounds), '');
    lines.push('### WebRTC 候选', '', ...webrtcTable(scenario.rounds), '');
    lines.push('### 字体探针与帧', '');
    lines.push('| 项目 | off | phase-1 | phase-2 |');
    lines.push('| --- | --- | --- | --- |');
    const font = (round, name) => {
      const hit = round?.fonts?.find((item) => item.font === name);
      return hit ? `hit=${hit.hit} check=${hit.check} diff=${hit.diff}` : '';
    };
    lines.push(`| measureText Noto Sans CJK SC | ${font(scenario.rounds.off, 'Noto Sans CJK SC')} | ${font(scenario.rounds.phase1, 'Noto Sans CJK SC')} | ${font(scenario.rounds.phase2, 'Noto Sans CJK SC')} |`);
    lines.push(`| measureText MiSans | ${font(scenario.rounds.off, 'MiSans')} | ${font(scenario.rounds.phase1, 'MiSans')} | ${font(scenario.rounds.phase2, 'MiSans')} |`);
    lines.push(`| 同源 iframe UA | ${cell(scenario.rounds.off?.frames?.same?.ua)} | ${cell(scenario.rounds.phase1?.frames?.same?.ua)} | ${cell(scenario.rounds.phase2?.frames?.same?.ua)} |`);
    lines.push(`| srcdoc iframe UA | ${cell(scenario.rounds.off?.frames?.srcdoc?.ua)} | ${cell(scenario.rounds.phase1?.frames?.srcdoc?.ua)} | ${cell(scenario.rounds.phase2?.frames?.srcdoc?.ua)} |`);
    lines.push(`| about:blank iframe UA | ${cell(scenario.rounds.off?.frames?.blank?.ua)} | ${cell(scenario.rounds.phase1?.frames?.blank?.ua)} | ${cell(scenario.rounds.phase2?.frames?.blank?.ua)} |`);
    lines.push(`| 同源 iframe Noto hit | ${scenario.rounds.off?.frames?.same?.noto?.hit ?? ''} | ${scenario.rounds.phase1?.frames?.same?.noto?.hit ?? ''} | ${scenario.rounds.phase2?.frames?.same?.noto?.hit ?? ''} |`);
    lines.push(`| DateTimeFormat 仍像原生 | ${scenario.rounds.off?.toStringProbe?.dateTimeFormatNative ?? ''} | ${scenario.rounds.phase1?.toStringProbe?.dateTimeFormatNative ?? ''} | ${scenario.rounds.phase2?.toStringProbe?.dateTimeFormatNative ?? ''} |`);
    lines.push(`| measureText 仍像原生 | ${scenario.rounds.off?.toStringProbe?.measureTextNative ?? ''} | ${scenario.rounds.phase1?.toStringProbe?.measureTextNative ?? ''} | ${scenario.rounds.phase2?.toStringProbe?.measureTextNative ?? ''} |`);
    lines.push(`| RTCPeerConnection 仍像原生 | ${scenario.rounds.off?.toStringProbe?.rtcNative ?? ''} | ${scenario.rounds.phase1?.toStringProbe?.rtcNative ?? ''} | ${scenario.rounds.phase2?.toStringProbe?.rtcNative ?? ''} |`);
    lines.push(`| userAgent getter 仍像原生 | ${scenario.rounds.off?.toStringProbe?.uaGetterNative ?? ''} | ${scenario.rounds.phase1?.toStringProbe?.uaGetterNative ?? ''} | ${scenario.rounds.phase2?.toStringProbe?.uaGetterNative ?? ''} |`);
    lines.push('');
  }
  lines.push('## 浏览器级 WebRTC 策略', '');
  if (results.webrtcPolicyBlocked) lines.push(results.webrtcPolicyBlocked, '');
  if (results.webrtcBaseline) lines.push(results.webrtcBaseline, '');
  lines.push('```json');
  lines.push(JSON.stringify(results.webrtcPolicy || {}, null, 2));
  lines.push('```', '');
  if (results.webrtcCft) lines.push(...renderWebRtcCftSection(results.webrtcCft));
  lines.push('## 已知缺口', '');
  lines.push('- Worker 里的 `navigator.userAgent` 不会被页面补丁改写。场景 B 的 Worker UA 应保持启动参数里的值。');
  lines.push('- 包装后的函数 `toString()` 不是 `[native code]`。');
  lines.push('- 字体钩子只影响 `measureText` 和 `fonts.check`。DOM 尺寸和像素比对不受影响。');
  lines.push('- 表情符号按站点公式最低仍有 1 到 2 分。本机是 Linux，贡献通常是 2。');
  lines.push('- 高熵 Client Hint 使用 set。没请求这些 hint 的请求也会带上它们。被 Chrome 拒绝的头记在 `slc-dnr-notes`，回显里能看到原值。');
  if (failures.length) {
    lines.push('', '## 失败', '');
    for (const failure of failures) lines.push(`- ${failure}`);
  }
  return `${lines.join('\n')}\n`;
}

function assertResults(results) {
  const failures = [];
  const check = (ok, message) => {
    if (!ok) failures.push(message);
  };
  const major = results.chrome.major;
  const a = results.scenarios.A.rounds;
  const b = results.scenarios.B.rounds;
  check(row(a.off, 'timezone').raw === 'Asia/Shanghai', `A off timezone ${row(a.off, 'timezone').raw}`);
  check(row(a.off, 'timezoneOffset').contribution === '+2', `A off offset ${row(a.off, 'timezoneOffset').contribution}`);
  check(row(a.phase1, 'timezone').raw === 'America/Los_Angeles', `A phase1 timezone ${row(a.phase1, 'timezone').raw}`);
  check(row(a.phase1, 'timezone').contribution === '+0', 'A phase1 timezone contribution');
  check(row(a.phase1, 'timezoneOffset').contribution === '+0', 'A phase1 offset contribution');
  check(row(a.phase1, 'language').contribution === '+0', `A phase1 language ${row(a.phase1, 'language').raw}`);
  check(row(a.phase1, 'intlLocale').contribution === '+0', `A phase1 intl ${row(a.phase1, 'intlLocale').raw}`);
  check((a.phase1?.echo?.['accept-language'] || '').toLowerCase() === 'en-us,en;q=0.9', `A phase1 accept-language ${a.phase1?.echo?.['accept-language']}`);
  check(row(a.phase1, 'fonts').contribution === row(a.off, 'fonts').contribution, 'A phase1 should not hide fonts');
  check(row(a.off, 'fonts').contribution !== '+0', `A off fonts did not hit ${row(a.off, 'fonts').raw}`);
  check(row(a.phase2, 'fonts').contribution === '+0', `A phase2 fonts ${row(a.phase2, 'fonts').raw} ${row(a.phase2, 'fonts').contribution}`);
  check(row(a.phase2, 'vendorFonts').contribution === '+0', `A phase2 vendor fonts ${row(a.phase2, 'vendorFonts').raw}`);
  check(row(a.phase2, 'cnBrowser').contribution === '+0', 'A phase2 cnBrowser');
  check(row(a.phase2, 'deviceVendor').contribution === '+0', 'A phase2 device');
  check(row(a.phase2, 'webrtcLeak').contribution === '+0', `A phase2 webrtc ${row(a.phase2, 'webrtcLeak').raw}`);
  check(['+1', '+2'].includes(row(a.phase2, 'emoji').contribution), `A phase2 emoji ${row(a.phase2, 'emoji').contribution}`);
  check(!a.phase2?.echo?.['user-agent'] || a.phase2.echo['user-agent'] === a.off?.echo?.['user-agent'], `A phase2 rewrote UA ${a.phase2?.echo?.['user-agent']}`);
  check(a.phase2?.popup?.meta?.uaPreset === 'native', `A phase2 preset ${a.phase2?.popup?.meta?.uaPreset}`);
  check(a.phase2?.workerUa === a.off?.workerUa, `A worker changed ${a.phase2?.workerUa}`);
  check(a.phase2?.frames?.same?.tz === 'America/Los_Angeles', `A same-origin tz ${a.phase2?.frames?.same?.tz}`);
  check(a.phase2?.frames?.srcdoc?.tz === 'America/Los_Angeles', `A srcdoc tz ${JSON.stringify(a.phase2?.frames?.srcdoc)}`);
  check(a.phase2?.frames?.blank?.tz === 'America/Los_Angeles', `A blank tz ${JSON.stringify(a.phase2?.frames?.blank)}`);
  check(a.phase2?.toStringProbe?.dateTimeFormatNative === false, 'A phase2 DateTimeFormat still looks native');
  check((a.phase2?.scan?.leaks || []).length === 0, `A leaked globals ${a.phase2?.scan?.leaks}`);
  check(/qqbrowser/i.test(b.off?.navigatorProbe?.userAgent || ''), `B off UA ${b.off?.navigatorProbe?.userAgent}`);
  check(row(b.off, 'cnBrowser').contribution !== '+0', `B off cnBrowser ${row(b.off, 'cnBrowser').raw}`);
  check(row(b.off, 'deviceVendor').contribution !== '+0', `B off device ${row(b.off, 'deviceVendor').raw}`);
  check(row(b.phase1, 'cnBrowser').contribution !== '+0', `B phase1 still should show the domestic browser ${row(b.phase1, 'cnBrowser').raw}`);
  check(b.phase2?.popup?.meta?.suggestDesktop === '1', `B suggestDesktop ${b.phase2?.popup?.meta?.suggestDesktop} ${b.phase2?.popup?.meta?.cnBrowser}`);
  check(b.phase2?.popup?.meta?.uaPreset === 'desktop-chrome', `B preset ${b.phase2?.popup?.meta?.uaPreset}`);
  check(row(b.phase2, 'cnBrowser').contribution === '+0', `B phase2 cnBrowser ${row(b.phase2, 'cnBrowser').raw}`);
  check(row(b.phase2, 'deviceVendor').contribution === '+0', `B phase2 device ${row(b.phase2, 'deviceVendor').raw}`);
  check(!/qqbrowser|huawei/i.test(b.phase2?.navigatorProbe?.userAgent || ''), `B phase2 page UA ${b.phase2?.navigatorProbe?.userAgent}`);
  check((b.phase2?.navigatorProbe?.userAgent || '').includes(`Chrome/${major}.0.0.0`), `B phase2 major ${b.phase2?.navigatorProbe?.userAgent}`);
  check(b.phase2?.navigatorProbe?.platform === 'Linux x86_64', `B phase2 platform ${b.phase2?.navigatorProbe?.platform}`);
  check(!/qqbrowser|huawei/i.test(b.phase2?.echo?.['user-agent'] || ''), `B phase2 header UA ${b.phase2?.echo?.['user-agent']}`);
  check(/Chromium|Google Chrome/.test(b.phase2?.echo?.['sec-ch-ua'] || ''), `B phase2 sec-ch-ua ${b.phase2?.echo?.['sec-ch-ua']}`);
  check(b.phase2?.workerUa === b.off?.workerUa, `B worker was patched ${b.phase2?.workerUa}`);
  check(b.phase2?.workerUa !== b.phase2?.navigatorProbe?.userAgent, 'B worker UA matches the patched page');
  check(b.phase2?.frames?.same?.ua === b.phase2?.navigatorProbe?.userAgent, `B same-origin UA ${b.phase2?.frames?.same?.ua}`);
  const offHost = (a.off?.webrtc?.counts?.host || 0) + (a.off?.webrtc?.counts?.srflx || 0);
  check(a.phase1?.toStringProbe?.measureTextNative === true, 'A phase1 measureText was wrapped');
  check(a.phase2?.toStringProbe?.measureTextNative === false, 'A phase2 measureText still looks native');
  check(a.phase1?.toStringProbe?.rtcNative === true, 'A phase1 RTCPeerConnection was wrapped');
  check(a.phase2?.toStringProbe?.rtcNative === false, 'A phase2 RTCPeerConnection still looks native');
  if (offHost > 0) {
    const left = (a.phase2?.webrtc?.counts?.host || 0) + (a.phase2?.webrtc?.counts?.srflx || 0) + (a.phase2?.webrtc?.counts?.prflx || 0);
    check(left === 0, `A phase2 still exposed ${left} address candidates`);
    check((a.phase1?.webrtc?.counts?.host || 0) + (a.phase1?.webrtc?.counts?.srflx || 0) > 0, 'A phase1 filter was on too early');
  } else {
    results.webrtcBaseline = 'off 轮没有收集到含 IP 的 host 或 srflx 候选。本环境的 Chrome 企业策略把 WebRtcIPHandling 固定为 default_public_interface_only，私网 host 候选不会出现；STUN 的 srflx 也没有在时限内到达。phase-2 仍然装上了过滤包装，RTCPeerConnection 的 toString 不再是原生代码。';
  }
  if (results.vendorFont?.ok) {
    check(row(a.off, 'vendorFonts').contribution !== '+0', `vendor font was installed but the site did not hit it ${row(a.off, 'vendorFonts').raw}`);
  }
  const policy = results.webrtcPolicy || {};
  check(/所有网站|every site/i.test(policy.confirmText || ''), 'policy confirm copy missing');
  const control = policy.setValue?.levelOfControl || policy.before?.levelOfControl || '';
  if (control === 'controllable_by_this_extension' || control === 'controlled_by_this_extension') {
    check(policy.setValue?.value === 'disable_non_proxied_udp', `policy set ${JSON.stringify(policy.setValue)}`);
    check(policy.cleared?.value === 'default', `policy clear ${JSON.stringify(policy.cleared)}`);
  } else {
    check(control === 'not_controllable', `policy level ${control} ${JSON.stringify(policy.setValue)}`);
    check(policy.setValue?.value === policy.before?.value, `policy changed while not controllable ${policy.before?.value} -> ${policy.setValue?.value}`);
    check(policy.setValue?.value !== 'disable_non_proxied_udp', 'policy was set despite not_controllable');
    check(/不受本扩展控制|controlled elsewhere/i.test(policy.ui?.error || ''), `policy blocked copy ${policy.ui?.error}`);
    results.webrtcPolicyBlocked = '本环境 /etc/opt/chrome/policies/managed/sand-webrtc.json 把 WebRtcIPHandling 固定为 default_public_interface_only。扩展读到 levelOfControl=not_controllable 后没有调用 set，策略值保持不变。因此这里不能演示 set 为 disable_non_proxied_udp 再 clear 回 default。';
  }
  return failures;
}

function attachPreviousCft(results) {
  if (results.webrtcCft) return;
  try {
    const prev = JSON.parse(readFileSync(join(OUT, 'results.json'), 'utf8'));
    if (prev && prev.webrtcCft) results.webrtcCft = prev.webrtcCft;
  } catch {
    /* the first full run has no Chrome for Testing section yet */
  }
}

function writeOutputs(results, failures) {
  mkdirSync(OUT, { recursive: true });
  attachPreviousCft(results);
  writeFileSync(join(OUT, 'results.json'), JSON.stringify({ ...results, failures }, null, 2));
  writeFileSync(join(OUT, 'results.md'), markdown(results, failures));
}

if (process.env.SLC_E2E_CFT === '1') {
  try {
    await runWebRtcCftAndMerge();
  } catch (err) {
    console.error(err?.stack || err);
    process.exitCode = 1;
  }
  process.exit(process.exitCode || 0);
}

const results = { startedAt: new Date().toISOString(), scenarios: {} };
let server;
try {
  mkdirSync(OUT, { recursive: true });
  await waitForMemory();
  const siteRoot = findSiteRoot();
  const extensionDir = findExtensionDir();
  results.chrome = chromeMajor();
  results.vendorFont = prepareVendorFont();
  const fontconfig = results.vendorFont.ok ? join(TMP, 'fonts.conf') : '';
  console.log('site', siteRoot);
  console.log('extension', extensionDir);
  console.log('chrome', results.chrome.text);
  console.log('vendor font', results.vendorFont.ok, results.vendorFont.detail);
  const started = await startServer(siteRoot);
  server = started.server;
  const probe = await fetch('http://127.0.0.1:4321/');
  if (!probe.ok) throw new Error(`local server status ${probe.status}`);
  const domesticUa = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${results.chrome.major}.0.0.0 Safari/537.36 QQBrowser/13.3.2 HUAWEI`;
  results.scenarios.A = {
    note: '本机默认 UA。',
    rounds: {
      off: await runRound({ fontconfig, label: 'A-off', mode: 'off' }),
      phase1: await runRound({ extensionDir, fontconfig, label: 'A-phase1', mode: 'phase1' }),
      phase2: await runRound({ extensionDir, fontconfig, label: 'A-phase2', mode: 'phase2' }),
    },
  };
  results.scenarios.B = {
    note: `启动参数 UA：${domesticUa}`,
    userAgent: domesticUa,
    rounds: {
      off: await runRound({ userAgent: domesticUa, fontconfig, label: 'B-off', mode: 'off' }),
      phase1: await runRound({ extensionDir, userAgent: domesticUa, fontconfig, label: 'B-phase1', mode: 'phase1' }),
      phase2: await runRound({ extensionDir, userAgent: domesticUa, fontconfig, label: 'B-phase2', mode: 'phase2' }),
    },
  };
  results.webrtcPolicy = await runPolicy(extensionDir, fontconfig);
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
  rmSync(TMP, { recursive: true, force: true });
}
process.exit(process.exitCode || 0);
