// （环境：一次性复现, 原因/备注：0.1.6 一键修复全链路——预授权变体绕开原生授权弹窗）
import puppeteer from 'puppeteer';

const EXT = '/tmp/slc-test';
const browser = await puppeteer.launch({
  headless: false,
  executablePath: '/Users/wyatt/.cache/puppeteer/chrome/mac_arm-156.0.8078.47/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--lang=en-US', '--no-first-run',
    '--proxy-server=http://127.0.0.1:7890',
    '--timezone=Asia/Shanghai',
  ],
});
try {
  let id = '';
  for (let i = 0; i < 50 && !id; i++) {
    const ext = (await browser.targets()).find((t) => t.url().startsWith('chrome-extension://'));
    if (ext) id = new URL(ext.url()).host;
    else await new Promise((r) => setTimeout(r, 200));
  }
  console.log('ext id:', id);
  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 800));

  const site = await browser.newPage();
  await site.goto('https://claudecheck.frely.cloud/', { waitUntil: 'networkidle2', timeout: 60000 });
  await site.click('#retest');
  await site.waitForFunction(() => document.querySelector('#score-value')?.textContent !== '0' && !document.querySelector('#score-gauge')?.hasAttribute('data-scanning'), { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 800));
  const before = await site.evaluate(() => {
    const get = (sid) => document.querySelector(`[data-signal="${sid}"] [data-field="value"]`)?.textContent;
    return {
      score: document.querySelector('#score-value')?.textContent,
      timezone: get('timezone'), timezoneOffset: get('timezoneOffset'),
      language: get('language'), fonts: get('fonts'), webrtc: get('webrtcLeak'),
    };
  });
  console.log('BEFORE :', JSON.stringify(before));

  // 点击一键修复
  await site.click('#fix-all');
  await new Promise((r) => setTimeout(r, 2500));
  const storage = await popup.evaluate(async () => (await chrome.storage.local.get('slc-settings'))['slc-settings']);
  const tabs = await popup.evaluate(async () => (await chrome.tabs.query({})).map((t) => t.url?.slice(0, 60)));
  console.log('STORAGE:', JSON.stringify({ enabled: storage?.enabled, tz: [storage?.timezone, storage?.timezoneOffset], lang: [storage?.language, storage?.intlLocale], fonts: storage?.fonts, webrtc: storage?.webrtc, ua: storage?.uaPreset, sites: storage?.sites?.map((s) => s.host) }));
  console.log('TABS   :', JSON.stringify(tabs));

  // 刷新检测页（toast 提示的动作）
  await site.reload({ waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 3500)); // 等静默重扫
  const after = await site.evaluate(() => {
    const get = (sid) => document.querySelector(`[data-signal="${sid}"] [data-field="value"]`)?.textContent;
    return {
      score: document.querySelector('#score-value')?.textContent,
      timezone: get('timezone'), timezoneOffset: get('timezoneOffset'),
      language: get('language'), fonts: get('fonts'), webrtc: get('webrtcLeak'),
    };
  });
  console.log('AFTER  :', JSON.stringify(after));
  console.log('VERDICT: timezone-changed =', before.timezone !== after.timezone, '| score-dropped =', Number(after.score) < Number(before.score));
} finally { await browser.close(); }
