// （环境：vitest/bun, 原因/备注：锁定 manifest 两个 host 列表与 lib/origins.ts
// 事实源的派生关系——wxt.config 不允许手写字面量偏离 DEFAULT_SITES/CHECKER_ORIGINS；
// 构建产物侧由 scripts/check-manifest.mjs 做形状校验兜底）
import { describe, expect, it } from 'vitest';
import { CHECKER_ORIGIN_PATTERNS, DEFAULT_SITES } from '../src/lib/origins';
import { originPatterns } from '../src/lib/sites';
import wxtConfig from '../wxt.config';

type ManifestLike = { optional_host_permissions?: string[]; externally_connectable?: { matches?: string[] } };
const manifest = (wxtConfig as { manifest?: ManifestLike }).manifest ?? {};

describe('manifest 域名列表由 origins.ts 派生', () => {
  it('optional_host_permissions = originPatterns(DEFAULT_SITES) + 通配', () => {
    expect(manifest.optional_host_permissions).toEqual([...DEFAULT_SITES.flatMap(originPatterns), 'https://*/*']);
  });

  it('externally_connectable.matches = CHECKER_ORIGIN_PATTERNS', () => {
    expect(manifest.externally_connectable?.matches).toEqual([...CHECKER_ORIGIN_PATTERNS]);
  });

  it('默认站点表 = 2 个 claude 站 + 2 个检测站（子域仅 claude 开）', () => {
    expect(DEFAULT_SITES.map((site) => [site.host, site.includeSubdomains])).toEqual([
      ['claude.ai', true],
      ['claude.com', true],
      ['claudecheck.frely.cloud', false],
      ['cc.frely.cloud', false],
    ]);
  });
});
