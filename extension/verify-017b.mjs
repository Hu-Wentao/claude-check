// （环境：一次性插桩, 原因/备注：定位聚合修复为何未生效）
import puppeteer from 'puppeteer';
const CHROME = '/Users/wyatt/.cache/puppeteer/chrome/mac_arm-156.0.8078.47/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const browser = await puppeteer.launch({
  headless: false, executablePath: CHROME,
  args: [`--disable-extensions-except=/tmp/slc-test2`, `--load-extension=/tmp/slc-test2`,
    '--proxy-server=http://127.0.0.1:7890', '--lang=en-US', '--no-first-run', '--timezone=Asia/Shanghai'],
});
try {
  let id = '';
  for (let i = 0; i < 40 && !id; i++) {
    const ext = (await browser.targets()).find((t) => t.url().startsWith('chrome-extension://'));
    if (ext) id = new URL(ext.url()).host;
    else await new Promise((r) => setTimeout(r, 200));
  }
  const site = await browser.newPage();
  site.on('console', (m) => { const t = m.text(); if (t.includes('slc') || t.includes('fix')) console.log('console>', t.slice(0, 200)); });
  await site.goto('https://claudecheck.frely.cloud/', { waitUntil: 'networkidle2', timeout: 60000 });
  await site.click('#retest');
  await site.waitForFunction(() => document.querySelector('#score-value')?.textContent !== '0' && !document.querySelector('#score-gauge')?.hasAttribute('data-scanning'), { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 600));
  const btn = await site.evaluate(() => {
    const b = document.querySelector('#fix-all');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { hidden: b.hidden, visible: !!(r.width && r.height), text: b.textContent?.trim(), mid: { x: r.x + r.width / 2, y: r.y + r.height / 2 } };
  });
  console.log('button:', JSON.stringify(btn));
  const manual = await site.evaluate(() => new Promise((res) => {
    chrome.runtime.sendMessage('oohedadoopeimapnbghdogplahnhihdg', { type: 'slc-fix-signal', signals: ['timezone', 'fonts'], lang: 'en' }, (r) => res(r ?? null));
  }));
  console.log('manual-agg:', JSON.stringify(manual));
  const pp = await browser.newPage();
  await pp.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 400));
  const st = await pp.evaluate(async () => { const s = (await chrome.storage.local.get('slc-settings'))['slc-settings']; return { enabled: s?.enabled, tz: s?.timezone, fonts: s?.fonts, sites: s?.sites?.map((x) => x.host) }; });
  console.log('storage:', JSON.stringify(st));
  await site.reload({ waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 3500));
  const after = await site.evaluate(() => ({
    score: document.querySelector('#score-value')?.textContent,
    tz: document.querySelector('[data-signal="timezone"] [data-field="value"]')?.textContent,
  }));
  console.log('after:', JSON.stringify(after));
} finally { await browser.close(); }
