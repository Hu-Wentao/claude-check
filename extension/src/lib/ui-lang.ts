// （环境：popup/onboarding 共用, 原因/备注：UI 语言不落 storage——每次打开按
// 「claudecheck 标签页页面语言 > 浏览器界面语言」解析，手动选择仅当次有效）
export type UiLang = 'en' | 'zh';

const SITE_ORIGIN = 'https://claudecheck.frely.cloud';
const LOCALE_DIR: Record<UiLang, string> = { en: 'en', zh: 'zh_CN' };

interface MessageEntry {
  message: string;
  placeholders?: Record<string, { content: string }>;
}

export type MessageTable = Record<string, MessageEntry>;

/**
 * Auto language for one popup session: if the active tab is the checker
 * site, read its declared page language (activeTab grants temporary access
 * the moment the toolbar icon is clicked); otherwise follow the browser UI
 * language, which is what chrome.i18n did before.
 */
export async function resolveAutoUiLang(): Promise<UiLang> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id != null && typeof tab.url === 'string' && tab.url.startsWith(`${SITE_ORIGIN}/`)) {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => document.documentElement.lang,
      });
      const lang = results?.[0]?.result;
      if (typeof lang === 'string' && lang.trim()) {
        return lang.toLowerCase().startsWith('zh') ? 'zh' : 'en';
      }
    }
  } catch {
    // activeTab 未覆盖（如非点击打开的边缘路径）→ 浏览器语言兜底
  }
  return chrome.i18n.getUILanguage().toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export async function loadUiMessages(lang: UiLang): Promise<MessageTable> {
  const url = chrome.runtime.getURL(`_locales/${LOCALE_DIR[lang]}/messages.json`);
  const res = await fetch(url);
  return (await res.json()) as MessageTable;
}

/** Replaces $NAME$ tokens the way chrome.i18n.getMessage does for $N content. */
export function formatUiMessage(table: MessageTable, key: string, subs?: string[]): string {
  const entry = table[key];
  if (!entry) return '';
  let text = entry.message;
  const placeholders = Object.entries(entry.placeholders || {});
  for (const [name, def] of placeholders) {
    const index = Number((def.content || '').replace('$', '')) - 1;
    const value = Number.isInteger(index) && subs && index >= 0 && index < subs.length ? subs[index] : '';
    text = text.split(`$${name.toUpperCase()}$`).join(value);
  }
  return text;
}
