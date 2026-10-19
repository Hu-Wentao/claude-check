# Site Locale Control / 站点区域控制

Manifest V3 扩展。只改已授权站点看到的时区、时区偏移、语言和 `Intl` 默认区域。不改系统时区，也不改 IP 地址。

## 开发

在 `extension/` 目录里：

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

`pnpm build` 会生成时区/语言配置片段、打包 `public/injected/patch.js`，再用 WXT 产出 `.output/chrome-mv3`。

弹窗文案来自 `_locales/en` 和 `_locales/zh_CN`。默认语言是英语。

## 权限

固定权限只有 `storage`、`scripting`、`declarativeNetRequestWithHostAccess`。

可选主机权限：

- `https://claude.ai/*` 与 `https://*.claude.ai/*`
- `https://claude.com/*` 与 `https://*.claude.com/*`
- `https://fuck-claude.vercel.app/*`
- `https://*/*`，只给用户手动添加的具体 HTTPS 站点用。运行时按该站点的 origin 申请，不会直接请求通配。

正式构建没有 `host_permissions`，也没有 `<all_urls>`。

## `SLC_E2E=1`

自动化测试专用。这个环境变量会：

- 把 `host_permissions` 设为 `http://localhost/*` 和 `http://127.0.0.1/*`
- 把 `localhost` 和 `127.0.0.1` 放进默认站点

产物写到 `.output-e2e`，避免覆盖正式包。正式构建不要设置 `SLC_E2E`。正式清单里不能出现 localhost。

```bash
SLC_E2E=1 pnpm build
node e2e/run.mjs
```

端到端脚本用 new headless，优先通过 Puppeteer 的 `enableExtensions` 和 `browser.installExtension()` 加载系统 Chrome。结果写到 `/workspace/fc-ext-e2e/`。网站构建需要 Node >= 22.12（Astro 7）；`e2e/run.mjs` 不会构建网站，只读取已经存在的 `/workspace/fc-ext-phase1/.vercel/output/static` 或 `/workspace/fc-ext-phase1/dist`，跑端到端之前要先手动构建网站。

## 配置怎么进页面

Service worker 用 `chrome.scripting.registerContentScripts` 注册 MAIN world 脚本（`document_start`、`allFrames`、`matchOriginAsFallback`，并尽量带上 `matchAboutBlank`）。同一次注册里按顺序执行：选中的时区片段、语言片段、四个开关片段、`patch.js`。片段把值写进临时全局槽位，`patch.js` 第一行读出并立刻删掉。不用 `sessionStorage`，不自动刷新，不用 `postMessage` 传配置。Chrome 155 的动态注册 schema 会拒绝 `matchAboutBlank`；这时去掉该字段再注册一次。`matchOriginAsFallback` 仍会注入 `about:blank` 和 `srcdoc` 帧。

## 已知缺口

- Worker 里的 `Intl` 仍是浏览器真实时区。
- 包装函数的 `toString()` 不是 `[native code]`。
- 已经打开的页面需要手动刷新。
- 未授权的跨源 iframe 不会被改。
