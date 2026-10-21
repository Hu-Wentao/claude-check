// （环境：扩展确认页, 原因/备注：chrome.privacy 授权必须来自扩展页面里的用户手势，
// 站点一键修复在缺权限时会打开本页完成最后一次点击确认）
import './style.css';
import { loadSettings } from '../../src/lib/settings';
import { setWebrtcPolicy } from '../../src/lib/webrtc-policy';

function t(key: string): string {
  return chrome.i18n.getMessage(key) || key;
}

function el(tag: 'h1' | 'p' | 'button', className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

const app = document.getElementById('app');
if (!app) throw new Error('missing #app');

const intent = new URLSearchParams(location.search).get('intent') || 'webrtc';
const uiLang = chrome.i18n.getUILanguage();
document.documentElement.lang = uiLang.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';

const title = el('h1', undefined, t('onbTitle'));
const body = el('p', 'body', t(intent === 'webrtc' ? 'onbWebrtcBody' : 'onbTitle'));
const status = el('p', 'status');
const button = el('button', undefined, t('onbEnable'));
button.type = 'button';

async function closeSoon(): Promise<void> {
  status.classList.add('done');
  await new Promise((r) => setTimeout(r, 1500));
  const tab = await chrome.tabs.getCurrent();
  if (tab?.id != null) await chrome.tabs.remove(tab.id);
}

async function enable(): Promise<void> {
  let granted = false;
  try {
    granted = await chrome.permissions.contains({ permissions: ['privacy'] });
    if (!granted) granted = await chrome.permissions.request({ permissions: ['privacy'] });
  } catch {
    granted = false;
  }
  if (!granted) {
    status.textContent = t('policyDenied');
    status.classList.add('error');
    return;
  }
  const result = await setWebrtcPolicy();
  if (!result.ok) {
    status.textContent = t(result.error === 'not-controllable' ? 'policyBlocked' : 'policyDenied');
    status.classList.add('error');
    return;
  }
  status.textContent = t('onbDone');
  void closeSoon();
}

void (async () => {
  app.append(title, body, status, button);
  const settings = await loadSettings();
  if (!settings.webrtc) status.textContent = t('onbAlreadyNote');

  // 权限已给过时无需再点，直接生效
  if (await chrome.permissions.contains({ permissions: ['privacy'] })) {
    button.hidden = true;
    await enable();
    return;
  }
  button.addEventListener('click', () => {
    void enable();
  });
})();
