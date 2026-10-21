// （环境：一次性线上验证 0.1.7, 原因/备注：语言持久化 + 单确认页 + 聚合修复全链路）
import puppeteer from 'puppeteer';
const CHROME = '/Users/wyatt/.cache/puppeteer/chrome/mac_arm-156.0.8078.47/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const PROXY = ['--proxy-server=http://127.0.0.1:7890', '--lang=en-US', '--no-first-run', '--timezone=Asia/Shanghai'];

async function boot(extDir) {
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: CHROME,
    args: extDir ? [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, ...PROXY] : PROXY,
  });
  let id = '';
  for (let i = 0; i < 50 && !id; i++) {
    const ext = (await browser.targets()).find((t) => t.url().startsWith('chrome-extension://'));
    if (ext) id = new URL(ext.url()).host;
    else await new Promise((r) => setTimeout(r, 200));
  }
  return { browser, id };
}

// ---- 1) 语言持久化（真实 zip）
{
  const { browser, id } = await boot('/Users/wyatt/_proj/claude-check/extension/.output/chrome-mv3');
  try {
    const p1 = await browser.newPage();
    await p1.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'domcontentloaded' });
    await p1.waitForSelector('[data-field="ui-lang"]');
    await p1.select('[data-field="ui-lang"]', 'zh');
    await new Promise((r) => setTimeout(r, 600));
    const store = await p1.evaluate(async () => (await chrome.storage.local.get('slc-ui-lang'))['slc-ui-lang']);
    await p1.close();
    // 重开 popup（新文档 = 新会话）
    const p2 = await browser.newPage();
    await p2.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'domcontentloaded' });
    await p2.waitForFunction(() => document.body.dataset.ready === '1');
    const reopened = await p2.evaluate(() => ({
      h1: document.querySelector('h1')?.textContent,
      sel: document.querySelector('[data-field="ui-lang"]')?.value,
    }));
    console.log('1.lang-persist :', JSON.stringify({ store, reopened }));
    await p2.close();
  } finally { await browser.close(); }
}

// ---- 2) 真实 zip（无预授权）：一键修复 → 恰好一个确认页
{
  const { browser, id } = await boot('/Users/wyatt/_proj/claude-check/extension/.output/chrome-mv3');
  try {
    const site = await browser.newPage();
    await site.goto('https://claudecheck.frely.cloud/', { waitUntil: 'networkidle2', timeout: 60000 });
    await site.click('#retest');
    await site.waitForFunction(() => document.querySelector('#score-value')?.textContent !== '0' && !document.querySelector('#score-gauge')?.hasAttribute('data-scanning'), { timeout: 30000 });
    await site.click('#fix-all');
    await new Promise((r) => setTimeout(r, 2500));
    const probe = await site.evaluate(async () => {
      const send = (msg) => new Promise((res) => { try { chrome.runtime.sendMessage('oohedadoopeimapnbghdogplahnhihdg', msg, (r) => res(r ?? null)); } catch { res(null); } });
      return await send({ type: 'slc-ping' });
    });
    const popup = await browser.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 500));
    const tabs = await popup.evaluate(async () => (await chrome.tabs.query({})).filter((t) => t.url?.includes('onboarding')).map((t) => t.url));
    console.log('2.single-confirm:', JSON.stringify({ version: probe?.version, onboardingTabs: tabs.length, url: tabs[0]?.split('?')[1]?.slice(0, 90) }));
  } finally { await browser.close(); }
}

// ---- 3) 预授权变体：聚合修复全链路（含分数下降）
{
  const { browser } = await boot('/tmp/slc-test2');
  try {
    const site = await browser.newPage();
    await site.goto('https://claudecheck.frely.cloud/', { waitUntil: 'networkidle2', timeout: 60000 });
    await site.click('#retest');
    await site.waitForFunction(() => document.querySelector('#score-value')?.textContent !== '0' && !document.querySelector('#score-gauge')?.hasAttribute('data-scanning'), { timeout: 30000 });
    await new Promise((r) => setTimeout(r, 600));
    const before = await site.evaluate(() => ({
      score: document.querySelector('#score-value')?.textContent,
      tz: document.querySelector('[data-signal="timezone"] [data-field="value"]')?.textContent,
      fonts: document.querySelector('[data-signal="fonts"] [data-field="value"]')?.textContent,
    }));
    await site.click('#fix-all');
    await new Promise((r) => setTimeout(r, 2500));
    await site.reload({ waitUntil: 'networkidle2' });
    await new Promise((r) => setTimeout(r, 3500));
    const after = await site.evaluate(() => ({
      score: document.querySelector('#score-value')?.textContent,
      tz: document.querySelector('[data-signal="timezone"] [data-field="value"]')?.textContent,
      fonts: document.querySelector('[data-signal="fonts"] [data-field="value"]')?.textContent,
    }));
    const popup = await browser.newPage();
    const id2 = (await browser.targets()).find((t) => t.url().includes('popup.html')) ? '' : '';
    await popup.close();
    console.log('3.agg-fix     :', JSON.stringify({ before, after, tzChanged: before.tz !== after.tz, scoreDropped: Number(after.score) < Number(before.score) }));
  } finally { await browser.close(); }
}
