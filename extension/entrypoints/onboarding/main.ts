// （环境：扩展确认页, 原因/备注：站点 origin / chrome.privacy 授权都必须来自扩展
// 页面里的用户手势，检测页一键修复在缺权限时打开本页完成最后一次确认；确认后
// 应用对应设置组、重建注入并回载发起修复的检测页标签）
import './style.css';
import { scheduleRebuild } from '../../src/lib/apply';
import { CHECKER_ORIGIN_PATTERN, applySignalFix } from '../../src/lib/fix-map';
import { loadSettings, saveSettings } from '../../src/lib/settings';
import { setWebrtcPolicy } from '../../src/lib/webrtc-policy';
import { formatUiMessage, loadUiMessages, type UiLang } from '../../src/lib/ui-lang';

const params = new URLSearchParams(location.search);
const param = params.get('lang');
const lang: UiLang =
  param === 'zh' || param === 'en'
    ? param
    : chrome.i18n.getUILanguage().toLowerCase().startsWith('zh')
      ? 'zh'
      : 'en';
const messages = await loadUiMessages(lang);
document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';

function t(key: string, subs?: string[]): string {
  return formatUiMessage(messages, key, subs) || chrome.i18n.getMessage(key, subs) || key;
}

function el(tag: 'h1' | 'p' | 'button', className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

const app = document.getElementById('app');
if (!app) throw new Error('missing #app');

const signal = params.get('signal') || '';
const isWebrtc = signal === 'webrtcLeak';
const reloadTabId = Number(params.get('tab'));

const title = el('h1', undefined, t(isWebrtc ? 'onbTitle' : 'onbFixTitle'));
const body = el('p', 'body', t(isWebrtc ? 'onbWebrtcBody' : 'onbFixBody'));
const status = el('p', 'status');
const button = el('button', undefined, t('onbEnable'));
button.type = 'button';

async function closeSoon(): Promise<void> {
  status.classList.add('done');
  await new Promise((r) => setTimeout(r, 1500));
  const tab = await chrome.tabs.getCurrent();
  if (tab?.id != null) await chrome.tabs.remove(tab.id);
}

async function reloadCheckerTab(): Promise<void> {
  if (!Number.isInteger(reloadTabId) || reloadTabId <= 0) return;
  try {
    await chrome.tabs.reload(reloadTabId);
  } catch {
    /* 检测页标签可能已被关闭；设置已生效，无需报错 */
  }
}

async function enable(): Promise<void> {
  let granted = false;
  try {
    granted = await chrome.permissions.request({
      origins: [CHECKER_ORIGIN_PATTERN],
      ...(isWebrtc ? { permissions: ['privacy'] } : {}),
    });
  } catch {
    granted = false;
  }
  if (!granted) {
    status.textContent = t('policyDenied');
    status.classList.add('error');
    return;
  }

  const settings = await loadSettings();
  const next = applySignalFix(settings, signal);
  if (!next) {
    status.textContent = t('policyDenied');
    status.classList.add('error');
    return;
  }
  await saveSettings(next);
  scheduleRebuild();
  if (isWebrtc) {
    const result = await setWebrtcPolicy();
    if (!result.ok) {
      status.textContent = t('policyBlocked');
      status.classList.add('error');
      return;
    }
  }
  status.textContent = t('onbDone');
  await reloadCheckerTab();
  void closeSoon();
}

app.append(title, body, status, button);
button.addEventListener('click', () => {
  void enable();
});
