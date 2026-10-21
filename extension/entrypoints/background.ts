import { scheduleRebuild, updateBadges } from '../src/lib/apply';
import { CHECKER_ORIGIN_PATTERN, applySignalFix } from '../src/lib/fix-map';
import { readRealEnv } from '../src/lib/real-env';
import { ensureDefaults, loadSettings, saveSettings } from '../src/lib/settings';
import { setWebrtcPolicy } from '../src/lib/webrtc-policy';

// （环境：prod 域名固定, 原因/备注：检测页一键修复的合法来源；preview/localhost 一律忽略）
const BRIDGE_ORIGIN = 'https://claudecheck.frely.cloud';

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== 'slc-real-env') return;
    void readRealEnv().then(sendResponse, (err) => sendResponse({ error: String(err) }));
    return true;
  });
  chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
    if (sender.origin !== BRIDGE_ORIGIN) return;
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'slc-ping') {
      void loadSettings().then((settings) => {
        sendResponse({ ok: true, version: chrome.runtime.getManifest().version, webrtc: settings.webrtc });
      });
      return true;
    }
    if (message.type === 'slc-fix-signal') {
      void (async () => {
        const signal = String(message.signal || '');
        const isWebrtc = signal === 'webrtcLeak';
        const originGranted = await chrome.permissions.contains({ origins: [CHECKER_ORIGIN_PATTERN] });
        const privacyGranted = await chrome.permissions.contains({ permissions: ['privacy'] });

        // 权限齐备：直接应用 + 重建注入；页面刷新交由检测页的 toast 提示
        // 用户主动完成（新配置在刷新后的 document_start 生效）
        if (originGranted && (!isWebrtc || privacyGranted)) {
          const settings = await loadSettings();
          const next = applySignalFix(settings, signal);
          if (!next) {
            sendResponse({ ok: false, error: 'unsupported-signal' });
            return;
          }
          await saveSettings(next);
          scheduleRebuild();
          if (isWebrtc) await setWebrtcPolicy();
          sendResponse({ ok: true, mode: 'auto' });
          return;
        }

        // 缺权限：chrome.privacy / 站点 origin 授权都需要用户手势，落到确认页
        const params = new URLSearchParams({
          intent: 'fix',
          signal,
          lang: message.lang === 'zh' ? 'zh' : 'en',
        });
        await chrome.tabs.create({ url: chrome.runtime.getURL(`/onboarding.html?${params.toString()}`) });
        sendResponse({ ok: true, mode: 'confirm' });
      })().catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }
  });
  chrome.runtime.onInstalled.addListener(() => {
    void ensureDefaults().then(() => scheduleRebuild());
  });
  chrome.runtime.onStartup.addListener(() => {
    scheduleRebuild();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['slc-settings']) scheduleRebuild();
  });
  chrome.permissions.onAdded.addListener(() => scheduleRebuild());
  chrome.permissions.onRemoved.addListener(() => scheduleRebuild());
  chrome.tabs.onActivated.addListener(() => {
    void loadSettings().then((settings) => updateBadges(settings));
  });
  chrome.tabs.onUpdated.addListener((_tabId, info) => {
    if (info.status === 'complete' || info.url) {
      void loadSettings().then((settings) => updateBadges(settings));
    }
  });
});
