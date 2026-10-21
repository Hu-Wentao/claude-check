import { scheduleRebuild, updateBadges } from '../src/lib/apply';
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
    if (message.type === 'slc-enable-webrtc') {
      void (async () => {
        const settings = await loadSettings();
        if (!settings.webrtc) {
          settings.webrtc = true;
          await saveSettings(settings);
          scheduleRebuild();
        }
        if (await chrome.permissions.contains({ permissions: ['privacy'] })) {
          const result = await setWebrtcPolicy();
          sendResponse({ ok: true, mode: 'auto', policy: result.value });
          return;
        }
        // chrome.privacy 授权需要用户手势，只能落在扩展页面里完成；
        // lang 由站点消息透传，确认页与请求页语言一致
        const lang = message.lang === 'zh' ? 'zh' : 'en';
        await chrome.tabs.create({ url: chrome.runtime.getURL(`/onboarding.html?intent=webrtc&lang=${lang}`) });
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
