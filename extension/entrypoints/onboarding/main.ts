// （环境：扩展确认页, 原因/备注：站点 origin / chrome.privacy 授权都必须来自扩展
// 页面里的用户手势，检测页一键修复在缺权限时打开本页完成最后一次确认；确认后
// 应用对应设置组并重建注入，页面刷新由检测页的 toast 提示用户自己完成）
import './style.css';
import { scheduleRebuild } from '../../src/lib/apply';
import { CHECKER_ORIGIN_PATTERN, applySignalFix, applySignalFixes } from '../../src/lib/fix-map';
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
// 聚合模式：signals=a,b,c（一键修复缺权限时一次确认修完全部）
const signalList = (params.get('signals') || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const isWebrtc = signal === 'webrtcLeak' || signalList.includes('webrtcLeak');

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
  const next = signalList.length > 1 ? applySignalFixes(settings, signalList) : applySignalFix(settings, signal);
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
  void closeSoon();
}

app.append(title, body, status, button);
button.addEventListener('click', () => {
  void enable();
});
