// （环境：vitest/bun, 原因/备注：域名事实源唯一性的自执行约束——字面量只允许
// 出现在扩展 lib/origins.ts 与站点 config/site.ts（另豁免文档、一次性资产脚本
// 与本测试自身），任何新散装立即红）
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const EXT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPO_ROOT = join(EXT_ROOT, '..');

const EXT_ALLOW = new Set([
  'src/lib/origins.ts', // 扩展侧事实源
  'README.md', // 文档允许叙述域名
]);
const SITE_ALLOW = new Set([
  'src/config/site.ts', // 站点侧事实源
  'scripts/gen-assets.mjs', // 一次性资产生成脚本的水印文字（产物为静态 SVG）
]);

// 扩展无文案场景：三个域族全部禁止散装；站点侧 news/community 等编辑性内容
// 合法提及 claude.ai，故只约束自有域名 frely.cloud
const EXT_PATTERN = /frely\.cloud|claude\.ai|claude\.com/;
const SITE_PATTERN = /frely\.cloud/;

const SKIP_DIRS = new Set(['node_modules', '.output', '.output-e2e', '.vercel', 'dist', '.astro', 'public']);

function walk(dir: string, exts: Set<string>): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) {
      if (!SKIP_DIRS.has(name)) out.push(...walk(abs, exts));
    } else if (exts.has(name.slice(name.lastIndexOf('.')))) {
      out.push(abs);
    }
  }
  return out;
}

function offenders(root: string, dirs: string[], allow: Set<string>, pattern: RegExp, exts: Set<string>): string[] {
  const hits: string[] = [];
  for (const dir of dirs.map((d) => join(root, d))) {
    for (const file of walk(dir, exts)) {
      const rel = relative(root, file);
      if (allow.has(rel)) continue;
      if (pattern.test(readFileSync(file, 'utf8'))) hits.push(rel);
    }
  }
  return hits;
}

describe('域名事实源唯一（scatter-guard）', () => {
  it('扩展源码：字面量只允许出现在 src/lib/origins.ts', () => {
    const exts = new Set(['.ts', '.mjs']);
    const hits = offenders(EXT_ROOT, ['src', 'entrypoints', 'scripts'], EXT_ALLOW, EXT_PATTERN, exts);
    // wxt.config.ts 单独检查（tests/ 目录断言事实源内容，属合法引用，不扫描）
    for (const file of ['wxt.config.ts']) {
      const rel = file;
      if (!EXT_ALLOW.has(rel) && EXT_PATTERN.test(readFileSync(join(EXT_ROOT, file), 'utf8'))) hits.push(rel);
    }
    expect(hits).toEqual([]);
  });

  it('站点源码：frely.cloud 字面量只允许出现在 src/config/site.ts', () => {
    const hits = offenders(REPO_ROOT, ['src', 'scripts'], SITE_ALLOW, SITE_PATTERN, new Set(['.ts', '.astro', '.mjs']));
    // astro.config.mjs 是文件不是目录——单独读一次
    const astroConfig = join(REPO_ROOT, 'astro.config.mjs');
    const rel = relative(REPO_ROOT, astroConfig);
    if (!SITE_ALLOW.has(rel) && SITE_PATTERN.test(readFileSync(astroConfig, 'utf8'))) hits.push(rel);
    expect(hits).toEqual([]);
  });
});
