// （环境:全扩展唯一事实源, 原因/备注:默认站点表与检测域名只在此维护,新增或删除
// 域名只改本文件——manifest 两个 host 列表、建议站点、桥来源、popup 语言识别与
// 自测标签全部派生;tests/scatter-guard.test.ts 阻止字面量散装到其他文件）
import type { SiteEntry } from './sites';

export const DEFAULT_SITES: SiteEntry[] = [
  { host: 'claude.ai', includeSubdomains: true, suggested: true },
  { host: 'claude.com', includeSubdomains: true, suggested: true },
  { host: 'claudecheck.frely.cloud', includeSubdomains: false, suggested: true },
  { host: 'cc.frely.cloud', includeSubdomains: false, suggested: true },
];

/** 检测页来源（externally_connectable、桥校验、语言自动识别、自测标签） */
export const CHECKER_ORIGINS = ['https://claudecheck.frely.cloud', 'https://cc.frely.cloud'] as const;

export const CHECKER_ORIGIN_PATTERNS: string[] = CHECKER_ORIGINS.map((origin) => `${origin}/*`);

export const CHECKER_HOSTS: string[] = CHECKER_ORIGINS.map((origin) => new URL(origin).host);
