// （环境：一次性插桩, 原因/备注：fix-all 按钮是否被粘性导航遮挡导致点击丢失）
import puppeteer from 'puppeteer';
const CHROME = '/Users/wyatt/.cache/puppeteer/chrome/mac_arm-156.0.8078.47/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const browser = await puppeteer.launch({
  headless: false, executablePath: CHROME, defaultViewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=/tmp/slc-test2`, `--load-extension=/tmp/slc-test2`,
    '--proxy-server=http://127.0.0.1:7890', '--lang=en-US', '--no-first-run', '--timezone=Asia/Shanghai'],
});
try {
  const site = await browser.newPage();
  await site.goto('https://claudecheck.frely.cloud/', { waitUntil: 'networkidle2', timeout: 60000 });
  await site.click('#retest');
  await site.waitForFunction(() => document.querySelector('#score-value')?.textContent !== '0' && !document.querySelector('#score-gauge')?.hasAttribute('data-scanning'), { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 600));
  const probe = await site.evaluate(() => {
    const b = document.querySelector('#fix-all');
    const r = b.getBoundingClientRect();
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    const header = document.querySelector('header')?.getBoundingClientRect();
    return {
      btnRect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      hitIsButton: hit === b || b.contains(hit),
      hitTag: hit ? `${hit.tagName}.${hit.className || ''}`.slice(0, 60) : null,
      header: header ? { y: Math.round(header.y), h: Math.round(header.height) } : null,
    };
  });
  console.log('overlap:', JSON.stringify(probe));
  // 真点一次看 storage 是否变
  await site.click('#fix-all');
  await new Promise((r) => setTimeout(r, 2000));
  const ext = (await browser.targets()).find((t) => t.url().startsWith('popup.html'));
  const anyExt = (await browser.targets()).find((t) => t.url().startsWith('chrome-extension://'));
  const pp = await browser.newPage();
  await pp.goto(`chrome-extension://${new URL(anyExt.url()).host}/popup.html`, { waitUntil: 'domcontentloaded' });
  const st = await pp.evaluate(async () => (await chrome.storage.local.get('slc-settings'))['slc-settings']);
  console.log('click-effect:', JSON.stringify({ enabled: st?.enabled, tz: st?.timezone, fonts: st?.fonts }));
} finally { await browser.close(); }
