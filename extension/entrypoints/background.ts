import { scheduleRebuild, updateBadges } from '../src/lib/apply';
import { ensureDefaults, loadSettings } from '../src/lib/settings';

export default defineBackground(() => {
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
