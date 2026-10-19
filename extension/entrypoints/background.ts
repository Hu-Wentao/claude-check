import { scheduleRebuild, updateBadges } from '../src/lib/apply';
import { readRealEnv } from '../src/lib/real-env';
import { ensureDefaults, loadSettings } from '../src/lib/settings';

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== 'slc-real-env') return;
    void readRealEnv().then(sendResponse, (err) => sendResponse({ error: String(err) }));
    return true;
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
