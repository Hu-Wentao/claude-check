import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = join(HERE, '..');
const REPO_ROOT = join(EXTENSION_DIR, '..');
const OUT = '/workspace/fc-ext-e2e2';
const TMP = '/workspace/.fc-e2e-tmp';
const CFT_ROOT = join(TMP, 'cft');
const PORT = 4321;
const EXTENSION_OUTPUT = join(EXTENSION_DIR, '.output-e2e');
const DESKTOP_PROFILE = '/home/box/chrome-profile';

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
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function cell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function availableMb() {
  const text = execFileSync('free', ['-m'], { encoding: 'utf8' });
  const line = text.split('\n').find((row) => row.startsWith('Mem:'));
  if (!line) throw new Error('free -m failed');
  return { text: text.trim(), availableMb: Number(line.trim().split(/\s+/)[6]) };
}

function nicLine() {
  try {
    return execFileSync('ip', ['-4', '-o', 'addr', 'show', 'enp0s4'], { encoding: 'utf8' }).trim();
  } catch (err) {
    return String(err?.message || err);
  }
}

function chromeMajor() {
  const text = execFileSync('/usr/bin/google-chrome', ['--version'], { encoding: 'utf8' }).trim();
  const match = /(\d+)\./.exec(text);
  if (!match) throw new Error(`chrome version: ${text}`);
  return { text, major: Number(match[1]) };
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

function startServer(siteRoot) {
  const root = normalize(siteRoot);
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const common = { 'cache-control': 'no-store' };
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
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(PORT, () => resolvePromise(server));
  });
}

function installChromeForTesting(major) {
  mkdirSync(CFT_ROOT, { recursive: true });
  const spec = `chrome@${major}`;
  const command = `npx @puppeteer/browsers install ${spec} --path ${CFT_ROOT}`;
  console.log(command);
  // pnpm does not hoist this transitive bin, so npx's `browsers` shim is missing
  // until the package's own bin directory is on PATH.
  const browsersBin = join(EXTENSION_DIR, 'node_modules/.pnpm/node_modules/.bin');
  const output = execFileSync('npx', ['--yes', '@puppeteer/browsers', 'install', spec, '--path', CFT_ROOT], {
    cwd: EXTENSION_DIR,
    encoding: 'utf8',
    timeout: 600000,
    env: { ...process.env, PATH: `${browsersBin}:${process.env.PATH || ''}` },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  console.log(output.trim());
  const line = output.trim().split('\n').filter(Boolean).pop() || '';
  const match = /^chrome@(\S+)\s+(\S+)/.exec(line.trim());
  let executablePath = match ? match[2] : '';
  const buildId = match ? match[1] : '';
  if (!executablePath || !existsSync(executablePath)) executablePath = findChromeBinary(CFT_ROOT);
  if (!executablePath || !existsSync(executablePath)) throw new Error(`Chrome for Testing binary missing after install: ${output}`);
  if (executablePath === '/usr/bin/google-chrome' || executablePath.includes('/opt/google/chrome') || executablePath.includes(DESKTOP_PROFILE)) {
    throw new Error(`refusing branded Chrome at ${executablePath}`);
  }
  const versionText = execFileSync(executablePath, ['--version'], { encoding: 'utf8' }).trim();
  return { command, spec, buildId, executablePath, versionText, output: line.trim() };
}

function findChromeBinary(root) {
  const hits = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) walk(abs);
      else if (name === 'chrome') hits.push(abs);
    }
  };
  walk(root);
  return hits.find((file) => file.includes(`${sep}chrome-linux64${sep}chrome`)) || hits[0] || '';
}

function assertSafePath(file, label) {
  const text = String(file || '');
  if (!text || text.includes(DESKTOP_PROFILE) || text.includes('chrome-profile')) {
    throw new Error(`${label} touches the desktop Chrome profile: ${text}`);
  }
}

function launchArgs(headed) {
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
  if (headed) args.push('--ozone-platform=x11');
  return args;
}

function startXvfb() {
  let display = '';
  for (let n = 80; n < 110; n += 1) {
    if (!existsSync(`/tmp/.X11-unix/X${n}`)) {
      display = `:${n}`;
      break;
    }
  }
  if (!display) throw new Error('no free X display for the headed retry');
  const child = spawn('Xvfb', [display, '-screen', '0', '1280x900x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
  return { display, child };
}

async function waitForXvfb(display) {
  const socket = `/tmp/.X11-unix/X${display.slice(1)}`;
  for (let i = 0; i < 50; i += 1) {
    if (existsSync(socket)) return;
    await sleep(100);
  }
  throw new Error(`Xvfb did not create ${socket}`);
}

async function launchCft({ executablePath, extensionDir, label, headless, display }) {
  assertSafePath(executablePath, 'executable');
  const userDataDir = join('/tmp', `slc-e2e-cft-${label}-${Date.now()}`);
  assertSafePath(userDataDir, 'user-data-dir');
  const env = { ...process.env, TZ: 'Asia/Shanghai', LANG: 'zh_CN.UTF-8' };
  if (display) env.DISPLAY = display;
  const browser = await puppeteer.launch({
    executablePath,
    headless,
    pipe: true,
    enableExtensions: Boolean(extensionDir),
    userDataDir,
    args: launchArgs(!headless),
    env,
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
  const proc = typeof session.browser.process === 'function' ? session.browser.process() : null;
  await Promise.race([session.browser.close().catch(() => {}), sleep(8000)]);
  if (proc && proc.exitCode == null && !proc.killed) {
    try { proc.kill('SIGTERM'); } catch { /* already gone */ }
  }
  rmSync(session.userDataDir, { recursive: true, force: true });
}

function sweepCftProcesses() {
  let text = '';
  try {
    text = execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' });
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const ours = line.includes('/chrome-linux64/chrome') || line.includes('--user-data-dir=/tmp/slc-e2e-cft-');
    if (!ours) continue;
    if (line.includes(DESKTOP_PROFILE) || line.includes('chrome-profile')) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (!pid || pid === process.pid) continue;
    try { process.kill(pid, 'SIGTERM'); } catch { /* already exited */ }
  }
}

async function extensionCall(browser, id, action) {
  const run = async (target) => target.evaluate(async (name) => {
    const item = chrome.privacy && chrome.privacy.network && chrome.privacy.network.webRTCIPHandlingPolicy;
    const manifest = chrome.runtime.getManifest();
    const base = {
      permissions: manifest.permissions || [],
      optionalPermissions: manifest.optional_permissions || [],
      value: '',
      levelOfControl: '',
      error: '',
    };
    if (!item) return { ...base, error: 'missing webRTCIPHandlingPolicy' };
    const read = async () => {
      const got = await item.get({});
      return { value: String(got.value ?? ''), levelOfControl: got.levelOfControl || '' };
    };
    try {
      if (name === 'set') await item.set({ value: 'disable_non_proxied_udp' });
      else if (name === 'clear') await item.clear({});
      const got = await read();
      return { ...base, ...got };
    } catch (err) {
      let got = { value: '', levelOfControl: '' };
      try { got = await read(); } catch { /* keep the action error */ }
      return { ...base, ...got, error: String(err) };
    }
  }, action);

  const target = await browser.waitForTarget((entry) => entry.type() === 'service_worker' && entry.url().includes(id), { timeout: 20000 }).catch(() => null);
  if (target) {
    const worker = await target.worker();
    if (worker) {
      try { return await run(worker); } catch (err) {
        console.log('service worker privacy call failed', err?.message || err);
      }
    }
  }
  const page = await browser.newPage();
  try {
    await page.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForFunction(() => document.body.dataset.ready === '1', { timeout: 15000 });
    return await run(page);
  } finally {
    await page.close().catch(() => {});
  }
}

async function readPolicyPage(browser) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1100, height: 900 });
    await page.goto('chrome://policy', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForFunction(() => (document.body?.innerText || '').length > 40, { timeout: 8000 }).catch(() => {});
    await sleep(800);
    const text = await page.evaluate(() => {
      const parts = [];
      const visit = (root) => {
        if (!root) return;
        if (root.innerText) parts.push(root.innerText);
        const nodes = root.querySelectorAll ? root.querySelectorAll('*') : [];
        for (const el of nodes) {
          if (el.shadowRoot) visit(el.shadowRoot);
        }
      };
      visit(document.documentElement);
      return parts.join('\n');
    });
    await page.screenshot({ path: join(OUT, 'cft-policy.png'), fullPage: true });
    const lower = text.toLowerCase();
    const idx = lower.indexOf('webrtciplhandling');
    const excerpt = idx >= 0 ? text.slice(Math.max(0, idx - 120), idx + 280).replace(/\s+/g, ' ').trim() : '';
    const valueMatch = excerpt ? /default_public_interface_only|default_public_and_private_interfaces|disable_non_proxied_udp|\bdefault\b/.exec(excerpt) : null;
    return { ok: true, listed: idx >= 0, value: valueMatch ? valueMatch[0] : '', excerpt, error: '' };
  } catch (err) {
    return { ok: false, listed: false, value: '', excerpt: '', error: String(err) };
  } finally {
    await page.close().catch(() => {});
  }
}

function concludePolicy(chromePolicy, privacyGet) {
  const level = privacyGet?.levelOfControl || '';
  const value = privacyGet?.value || '';
  const listed = Boolean(chromePolicy?.listed);
  if (level === 'not_controllable') {
    return { readsManagedPolicy: true, note: `chrome.privacy get 的 levelOfControl=not_controllable，value=${value || '（空）'}。Chrome for Testing 受更高优先级策略约束。` };
  }
  if (listed && chromePolicy.value && chromePolicy.value !== 'default') {
    return { readsManagedPolicy: true, note: `chrome://policy 列出 WebRtcIPHandling=${chromePolicy.value}。` };
  }
  if (level === 'controllable_by_this_extension' || level === 'controlled_by_this_extension') {
    const page = listed ? `chrome://policy 出现了 WebRtcIPHandling=${chromePolicy.value || '（无值）'}。` : 'chrome://policy 没有列出 WebRtcIPHandling。';
    return {
      readsManagedPolicy: false,
      note: `${page} 扩展 get：value=${value || '（空）'}，levelOfControl=${level}。Chrome for Testing 没有采用 /etc/opt/chrome/policies/managed/sand-webrtc.json 的 WebRtcIPHandling=default_public_interface_only。`,
    };
  }
  if (level === 'controlled_by_other_extensions') {
    return { readsManagedPolicy: null, note: `levelOfControl=controlled_by_other_extensions，value=${value || '（空）'}。这不是本扩展可控，也没有把它写成企业策略。` };
  }
  return { readsManagedPolicy: null, note: `没能判断是否读取托管策略。chrome://policy listed=${listed}，levelOfControl=${level || '（空）'}，value=${value || '（空）'}。` };
}

function trimWebrtc(data) {
  if (!data) return { counts: {}, sdpCounts: {}, gathering: '', error: 'missing', candidates: [], sdpCandidateLines: [] };
  const candidates = (data.candidates || []).filter(Boolean).slice(0, 12);
  const sdpCandidateLines = String(data.sdp || '').split(/\r?\n/).filter((line) => /^a=candidate:/i.test(line)).slice(0, 12);
  return {
    counts: data.counts || {},
    sdpCounts: data.sdpCounts || {},
    gathering: data.gathering || '',
    error: data.error || '',
    candidates,
    sdpCandidateLines,
  };
}

function ipCount(webrtc, bucket, key) {
  return Number(webrtc?.[bucket]?.[key] || 0);
}

async function dismissBanner(page) {
  const banner = await page.$('#locale-banner');
  if (!banner) return;
  const visible = await page.$eval('#locale-banner', (node) => getComputedStyle(node).display !== 'none' && node.getClientRects().length > 0).catch(() => false);
  if (visible) await page.click('#locale-banner-close').catch(() => {});
}

async function readWebrtc(page) {
  await page.goto('http://localhost:4321/__e2e/webrtc.html', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForFunction(() => window.__webrtcDone === true, { timeout: 8000 }).catch(() => {});
  const data = await page.evaluate(() => window.__webrtc);
  return trimWebrtc(data);
}

async function readLeak(page) {
  await page.goto('http://localhost:4321/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#retest', { timeout: 20000 });
  await dismissBanner(page);
  await page.click('#retest');
  await page.waitForFunction(() => {
    const row = document.querySelector('[data-signal="webrtcLeak"]');
    const button = document.querySelector('#retest');
    return row && row.classList.contains('is-done') && button && !button.disabled;
  }, { timeout: 45000 });
  return page.evaluate(() => {
    const row = document.querySelector('[data-signal="webrtcLeak"]');
    return {
      raw: row?.querySelector('[data-field="value"]')?.textContent?.trim() || '',
      contribution: row?.querySelector('[data-field="contribution"]')?.textContent?.trim() || '',
    };
  });
}

async function readRtcNative(page) {
  return page.evaluate(() => {
    try { return Function.prototype.toString.call(window.RTCPeerConnection).includes('[native code]'); }
    catch (err) { return String(err); }
  });
}

async function shot(page, name) {
  await page.screenshot({ path: join(OUT, name), fullPage: true }).catch(() => {});
}

async function applyPhase2(browser, id) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 460, height: 1100 });
    await page.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForFunction(() => document.body.dataset.ready === '1', { timeout: 15000 });
    await page.evaluate(() => { document.body.dataset.applied = ''; });
    await page.click('[data-action="apply-recommended"]');
    await page.waitForFunction(() => document.body.dataset.applied === '1', { timeout: 15000 });
    const registration = await page.evaluate(async () => {
      const deadline = Date.now() + 15000;
      let scripts = [];
      while (Date.now() < deadline) {
        scripts = await chrome.scripting.getRegisteredContentScripts();
        const files = scripts.flatMap((script) => script.js || []);
        const matched = scripts.some((script) => (script.matches || []).some((match) => String(match).includes('localhost')));
        const phase2 = files.some((file) => String(file).includes('fonts-on')) && files.some((file) => String(file).includes('webrtc-on'));
        if (matched && phase2) return { ok: true, files };
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
      }
      return { ok: false, files: scripts.flatMap((script) => script.js || []) };
    });
    await page.screenshot({ path: join(OUT, 'cft-phase2-popup.png'), fullPage: true });
    if (!registration.ok) throw new Error(`phase-2 registration failed ${JSON.stringify(registration.files).slice(0, 800)}`);
    return registration;
  } finally {
    await page.close().catch(() => {});
  }
}

async function probePages(browser, label, homeShot) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1100, height: 900 });
    const webrtc = await readWebrtc(page);
    await shot(page, `${label}-webrtc.png`);
    const leak = await readLeak(page);
    const rtcNative = await readRtcNative(page);
    const scan = await page.$('#scan');
    if (scan) await scan.screenshot({ path: join(OUT, homeShot) });
    else await shot(page, homeShot);
    return { webrtc, leak, rtcNative };
  } finally {
    await page.close().catch(() => {});
  }
}

async function withBrowser(launchOptions, fn) {
  const session = await launchCft(launchOptions);
  try {
    return await fn(session);
  } finally {
    await closeBrowser(session);
  }
}

function countPair(round) {
  const webrtc = round?.webrtc;
  return {
    eventHost: ipCount(webrtc, 'counts', 'host'),
    eventSrflx: ipCount(webrtc, 'counts', 'srflx'),
    sdpHost: ipCount(webrtc, 'sdpCounts', 'host'),
    sdpSrflx: ipCount(webrtc, 'sdpCounts', 'srflx'),
  };
}

function exposed(round) {
  const pair = countPair(round);
  return pair.eventHost + pair.eventSrflx + pair.sdpHost + pair.sdpSrflx;
}

export function renderWebRtcCftSection(cft) {
  if (!cft) return [];
  const off = cft.rounds?.off;
  const phase2 = cft.rounds?.phase2;
  const during = cft.rounds?.policy?.during;
  const after = cft.rounds?.policy?.afterClear;
  const lines = [
    '## WebRTC（Chrome for Testing）',
    '',
    `可选子测试。主流程仍使用 \`/usr/bin/google-chrome\`。这里的浏览器是 Chrome for Testing（\`${cell(cft.install?.versionText || cft.install?.buildId)}\`）。`,
    '',
    `安装：\`${cell(cft.install?.command)}\``,
    '',
    `可执行文件：\`${cell(cft.install?.executablePath)}\``,
    '',
    `内存：可用 ${cft.memory?.availableMb ?? ''} MB。网卡：\`${cell(String(cft.nic || '').split('\\')[0].replace(/\s+/g, ' ').trim())}\`。`,
    '',
    `启动参数包含 \`--disable-features=WebRtcHideLocalIpsWithMdns\`${cft.headless === false ? '。off 轮在 headless 下没有含 IP 的候选，后面的轮次改在独立 Xvfb 里有头运行。' : '。三轮都是 headless。'}`,
    '',
    '### 是否读取托管策略',
    '',
    cft.managedPolicy?.note || '',
    '',
    `chrome://policy 摘录：${cell(cft.managedPolicy?.chromePolicy?.excerpt || cft.managedPolicy?.chromePolicy?.error || '（无）')}`,
    '',
    '| | value | levelOfControl |',
    '| --- | --- | --- |',
    `| 扩展 get（探针） | ${cell(cft.managedPolicy?.privacyGet?.value)} | ${cell(cft.managedPolicy?.privacyGet?.levelOfControl)} |`,
    `| set 之前 | ${cell(cft.rounds?.policy?.before?.value)} | ${cell(cft.rounds?.policy?.before?.levelOfControl)} |`,
    `| set 之后 | ${cell(cft.rounds?.policy?.setResult?.value)} | ${cell(cft.rounds?.policy?.setResult?.levelOfControl)} |`,
    `| clear 之后 | ${cell(cft.rounds?.policy?.clearResult?.value)} | ${cell(cft.rounds?.policy?.clearResult?.levelOfControl)} |`,
    '',
  ];
  if (cft.rounds?.policy?.setResult?.error) lines.push(`set 错误：${cell(cft.rounds.policy.setResult.error)}`, '');
  if (cft.rounds?.policy?.clearResult?.error) lines.push(`clear 错误：${cell(cft.rounds.policy.clearResult.error)}`, '');
  lines.push(
    '### 候选与站点检测',
    '',
    '计数只包括含 IP 的 host / srflx `a=candidate` 行，以及 icecandidate 事件里的对应候选。SDP 的 `o=` / `c=` 行不计入。',
    '',
    '| 项目 | off | phase-2 | 策略 disable_non_proxied_udp | clear 之后 |',
    '| --- | --- | --- | --- | --- |',
  );
  const col = (round, bucket, key) => {
    if (!round) return '';
    const value = round.webrtc?.[bucket]?.[key];
    return value == null ? '' : String(value);
  };
  lines.push(`| 事件中含 IP 的 host | ${col(off, 'counts', 'host')} | ${col(phase2, 'counts', 'host')} | ${col(during, 'counts', 'host')} | ${col(after, 'counts', 'host')} |`);
  lines.push(`| 事件中含 IP 的 srflx | ${col(off, 'counts', 'srflx')} | ${col(phase2, 'counts', 'srflx')} | ${col(during, 'counts', 'srflx')} | ${col(after, 'counts', 'srflx')} |`);
  lines.push(`| SDP 中含 IP 的 host | ${col(off, 'sdpCounts', 'host')} | ${col(phase2, 'sdpCounts', 'host')} | ${col(during, 'sdpCounts', 'host')} | ${col(after, 'sdpCounts', 'host')} |`);
  lines.push(`| SDP 中含 IP 的 srflx | ${col(off, 'sdpCounts', 'srflx')} | ${col(phase2, 'sdpCounts', 'srflx')} | ${col(during, 'sdpCounts', 'srflx')} | ${col(after, 'sdpCounts', 'srflx')} |`);
  lines.push(`| webrtcLeak raw | ${cell(off?.leak?.raw)} | ${cell(phase2?.leak?.raw)} | ${cell(during?.leak?.raw)} | ${cell(after?.leak?.raw)} |`);
  lines.push(`| webrtcLeak 贡献 | ${cell(off?.leak?.contribution)} | ${cell(phase2?.leak?.contribution)} | ${cell(during?.leak?.contribution)} | ${cell(after?.leak?.contribution)} |`);
  lines.push(`| 收集状态 | ${cell(off?.webrtc?.gathering)} | ${cell(phase2?.webrtc?.gathering)} | ${cell(during?.webrtc?.gathering)} | ${cell(after?.webrtc?.gathering)} |`);
  lines.push(`| 错误 | ${cell(off?.webrtc?.error)} | ${cell(phase2?.webrtc?.error)} | ${cell(during?.webrtc?.error)} | ${cell(after?.webrtc?.error)} |`);
  lines.push('');
  for (const paragraph of cft.summary || []) lines.push(paragraph, '');
  lines.push('截图：`cft-policy.png`、`cft-off-webrtc.png`、`cft-off-home.png`、`cft-phase2-popup.png`、`cft-phase2-webrtc.png`、`cft-phase2-home.png`、`cft-policy-webrtc.png`、`cft-policy-home.png`、`cft-policy-cleared-webrtc.png`、`cft-policy-cleared-home.png`。', '');
  if (cft.failures?.length) {
    lines.push('这一节的检查没有全部通过：', '');
    for (const failure of cft.failures) lines.push(`- ${failure}`);
    lines.push('');
  }
  return lines;
}

function spliceResultsMd(sectionLines) {
  const section = `${sectionLines.join('\n').replace(/\n+$/, '')}\n`;
  let md = '';
  try { md = readFileSync(join(OUT, 'results.md'), 'utf8'); } catch { md = ''; }
  const header = '## WebRTC（Chrome for Testing）';
  if (md.includes(header)) {
    md = md.replace(new RegExp(`${header}[\\s\\S]*?(?=\\n## |$)`), section.replace(/\n$/, ''));
    if (!md.endsWith('\n')) md += '\n';
  } else if (md.includes('## 已知缺口')) {
    md = md.replace('## 已知缺口', `${section}\n## 已知缺口`);
  } else {
    md = `${md.trim()}\n\n${section}`;
  }
  writeFileSync(join(OUT, 'results.md'), md.endsWith('\n') ? md : `${md}\n`);
}

function mergeReport(report) {
  mkdirSync(OUT, { recursive: true });
  let prev = {};
  try { prev = JSON.parse(readFileSync(join(OUT, 'results.json'), 'utf8')); } catch { prev = {}; }
  prev.webrtcCft = report;
  writeFileSync(join(OUT, 'results.json'), `${JSON.stringify(prev, null, 2)}\n`);
  spliceResultsMd(renderWebRtcCftSection(report));
}

function buildSummary(report) {
  const off = countPair(report.rounds?.off);
  const phase2 = countPair(report.rounds?.phase2);
  const during = countPair(report.rounds?.policy?.during);
  const after = countPair(report.rounds?.policy?.afterClear);
  const paragraphs = [];
  const offEvent = off.eventHost + off.eventSrflx;
  const offSdp = off.sdpHost + off.sdpSrflx;
  if (offEvent === 0 && offSdp === 0) {
    paragraphs.push('off 轮的 icecandidate 事件和 localDescription.sdp 里都没有含 IP 的 host 或 srflx。没有伪造候选。');
  } else {
    let text = `off 轮事件里含 IP 的 host ${off.eventHost} 条、srflx ${off.eventSrflx} 条；SDP 里含 IP 的 a=candidate host ${off.sdpHost} 条、srflx ${off.sdpSrflx} 条。`;
    if (off.eventSrflx === 0 && off.sdpSrflx === 0) text += ' STUN 的 srflx 没有在时限内到达，host 候选足以证明。';
    text += ` phase-2 事件 host/srflx 为 ${phase2.eventHost}/${phase2.eventSrflx}，SDP host/srflx 为 ${phase2.sdpHost}/${phase2.sdpSrflx}。`;
    paragraphs.push(text);
  }
  const policy = report.rounds?.policy;
  if (policy) {
    const set = policy.setResult || {};
    const cleared = policy.clearResult || {};
    let text = `E2E 构建的 permissions 已含 privacy。直接 set('disable_non_proxied_udp') 后 get 为 value=${set.value || '（空）'}、levelOfControl=${set.levelOfControl || '（空）'}。`;
    text += ` 策略生效时事件 host/srflx 为 ${during.eventHost}/${during.eventSrflx}，SDP host/srflx 为 ${during.sdpHost}/${during.sdpSrflx}。`;
    text += ` clear() 后 get 为 value=${cleared.value || '（空）'}、levelOfControl=${cleared.levelOfControl || '（空）'}。`;
    text += policy.valueRestored ? ' 策略值已回到 set 之前。' : ' 策略值没有回到 set 之前。';
    text += ` clear 之后事件 host/srflx 为 ${after.eventHost}/${after.eventSrflx}，SDP host/srflx 为 ${after.sdpHost}/${after.sdpSrflx}。`;
    paragraphs.push(text);
  }
  const sample = (report.rounds?.off?.webrtc?.candidates || []).find((line) => / typ host/.test(line) && /\d+\.\d+\.\d+\.\d+/.test(line));
  if (sample) paragraphs.push(`off 轮一条 host 候选：\`${sample}\``);
  return paragraphs;
}

function assertReport(report) {
  const failures = [];
  const controllable = report.managedPolicy?.readsManagedPolicy === false
    && (report.managedPolicy?.privacyGet?.levelOfControl === 'controllable_by_this_extension'
      || report.managedPolicy?.privacyGet?.levelOfControl === 'controlled_by_this_extension');
  if (!controllable) return failures;
  const perms = report.managedPolicy?.privacyGet?.permissions || [];
  if (!perms.includes('privacy')) failures.push('e2e manifest is missing the privacy permission');
  if (exposed(report.rounds?.off) === 0) failures.push('controllable CfT off round collected no IP host or srflx candidate');
  if (report.rounds?.off?.rtcNative !== true) failures.push('off round RTCPeerConnection was already wrapped');
  if (exposed(report.rounds?.off) > 0) {
    const phase = report.rounds?.phase2;
    if (ipCount(phase?.webrtc, 'counts', 'host') + ipCount(phase?.webrtc, 'counts', 'srflx') + ipCount(phase?.webrtc, 'counts', 'prflx') !== 0) {
      failures.push('phase-2 still delivered IP candidates in icecandidate events');
    }
    if (ipCount(phase?.webrtc, 'sdpCounts', 'host') + ipCount(phase?.webrtc, 'sdpCounts', 'srflx') + ipCount(phase?.webrtc, 'sdpCounts', 'prflx') !== 0) {
      failures.push('phase-2 localDescription.sdp still contained IP a=candidate lines');
    }
    if (phase?.leak?.contribution !== '+0') failures.push(`phase-2 webrtcLeak contribution ${phase?.leak?.contribution} raw ${phase?.leak?.raw}`);
    if (phase?.rtcNative !== false) failures.push('phase-2 RTCPeerConnection still looks native');
  }
  const policy = report.rounds?.policy;
  if (!policy?.setApplied) failures.push(`set did not stick ${JSON.stringify(policy?.setResult || {})}`);
  if (policy?.setApplied && !policy?.valueRestored) failures.push(`clear did not restore ${JSON.stringify(policy?.clearResult || {})}`);
  if (policy?.during?.rtcNative !== true) failures.push('browser-policy round had the page filter wrapped around RTCPeerConnection');
  if (policy?.setApplied && exposed(report.rounds?.off) > 0 && exposed(policy?.afterClear) === 0) {
    failures.push('candidates did not return after clear()');
  }
  return failures;
}

async function runOffRound(common, headless, display, prefix) {
  return withBrowser({ ...common, extensionDir: '', label: prefix, headless, display }, async (session) => {
    const probed = await probePages(session.browser, prefix, `${prefix}-home.png`);
    return { ...probed, headless };
  });
}

export async function runWebRtcCftAndMerge() {
  mkdirSync(OUT, { recursive: true });
  const memory = availableMb();
  console.log(memory.text);
  if (memory.availableMb < 1500) throw new Error(`available memory ${memory.availableMb} MB is below 1500 MB`);
  const branded = chromeMajor();
  const nic = nicLine();
  const install = installChromeForTesting(branded.major);
  console.log('cft', install.versionText, install.executablePath);
  const siteRoot = findSiteRoot();
  const extensionDir = findExtensionDir();
  const server = await startServer(siteRoot);
  const report = {
    startedAt: new Date().toISOString(),
    memory,
    nic,
    brandedChrome: branded.text,
    install,
    flags: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
    headless: true,
    retriedHeaded: false,
    managedPolicy: null,
    rounds: {},
    summary: [],
    failures: [],
  };
  let xvfb = null;
  try {
    const probe = await fetch('http://127.0.0.1:4321/');
    if (!probe.ok) throw new Error(`local server status ${probe.status}`);
    const common = { executablePath: install.executablePath };
    report.managedPolicy = await withBrowser({ ...common, extensionDir, label: 'probe', headless: true }, async (session) => {
      const chromePolicy = await readPolicyPage(session.browser);
      const privacyGet = await extensionCall(session.browser, session.id, 'get');
      const concluded = concludePolicy(chromePolicy, privacyGet);
      console.log('policy', concluded.note);
      return { chromePolicy, privacyGet, ...concluded };
    });

    let off = await runOffRound(common, true, '', 'cft-off');
    if (report.managedPolicy.readsManagedPolicy === false && exposed(off) === 0) {
      console.log('headless off round had no IP candidate; retrying headed on a private Xvfb');
      xvfb = startXvfb();
      await waitForXvfb(xvfb.display);
      const headed = await runOffRound(common, false, xvfb.display, 'cft-off-headed');
      report.retriedHeaded = true;
      if (exposed(headed) > 0) {
        report.headless = false;
        off = headed;
        for (const name of ['cft-off-headed-webrtc.png', 'cft-off-headed-home.png']) {
          const src = join(OUT, name);
          if (existsSync(src)) copyFileSync(src, join(OUT, name.replace('-headed', '')));
        }
      } else {
        off.headedRetry = { webrtc: headed.webrtc, leak: headed.leak, rtcNative: headed.rtcNative };
      }
    }
    report.rounds.off = off;
    console.log('off', JSON.stringify(countPair(off)), off.leak);

    const headed = report.headless === false;
    const display = headed ? xvfb.display : '';
    report.rounds.phase2 = await withBrowser({ ...common, extensionDir, label: 'phase2', headless: !headed, display }, async (session) => {
      await session.browser.waitForTarget((target) => target.type() === 'service_worker' && target.url().includes(session.id), { timeout: 20000 }).catch(() => null);
      await applyPhase2(session.browser, session.id);
      const probed = await probePages(session.browser, 'cft-phase2', 'cft-phase2-home.png');
      return probed;
    });
    console.log('phase2', JSON.stringify(countPair(report.rounds.phase2)), report.rounds.phase2.leak, 'native', report.rounds.phase2.rtcNative);

    report.rounds.policy = await withBrowser({ ...common, extensionDir, label: 'policy', headless: !headed, display }, async (session) => {
      await session.browser.waitForTarget((target) => target.type() === 'service_worker' && target.url().includes(session.id), { timeout: 20000 }).catch(() => null);
      await sleep(300);
      const before = await extensionCall(session.browser, session.id, 'get');
      const registered = await (async () => {
        const target = await session.browser.waitForTarget((entry) => entry.type() === 'service_worker' && entry.url().includes(session.id), { timeout: 10000 }).catch(() => null);
        const worker = target ? await target.worker() : null;
        if (!worker) return -1;
        return worker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length);
      })();
      const setResult = await extensionCall(session.browser, session.id, 'set');
      await sleep(300);
      const during = await probePages(session.browser, 'cft-policy', 'cft-policy-home.png');
      const clearResult = await extensionCall(session.browser, session.id, 'clear');
      await sleep(300);
      const afterClear = await probePages(session.browser, 'cft-policy-cleared', 'cft-policy-cleared-home.png');
      const setApplied = setResult.value === 'disable_non_proxied_udp' && setResult.levelOfControl === 'controlled_by_this_extension' && !setResult.error;
      const valueRestored = Boolean(before.value) && clearResult.value === before.value && !clearResult.error;
      return { before, setResult, during, clearResult, afterClear, setApplied, valueRestored, registeredScripts: registered };
    });
    console.log('policy set', report.rounds.policy.setResult, 'clear', report.rounds.policy.clearResult);

    report.summary = buildSummary(report);
    report.failures = assertReport(report);
    report.finishedAt = new Date().toISOString();
    mergeReport(report);
    if (report.failures.length) {
      console.error(report.failures.join('\n'));
      process.exitCode = 1;
    } else {
      console.log('cft webrtc recorded');
    }
    return report;
  } catch (err) {
    report.error = err?.stack || String(err);
    report.finishedAt = new Date().toISOString();
    report.summary = buildSummary(report);
    report.failures = [report.error];
    try { mergeReport(report); } catch (writeErr) { console.error(writeErr); }
    throw err;
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
    if (xvfb?.child && xvfb.child.exitCode == null) {
      try { xvfb.child.kill('SIGTERM'); } catch { /* already exited */ }
    }
    sweepCftProcesses();
    rmSync(TMP, { recursive: true, force: true });
  }
}

function isDirectRun() {
  const arg = process.argv[1];
  if (!arg) return false;
  try { return realpathSync(arg) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isDirectRun()) {
  runWebRtcCftAndMerge().catch((err) => {
    console.error(err?.stack || err);
    process.exitCode = 1;
  }).finally(() => {
    process.exit(process.exitCode || 0);
  });
}
