import { defineConfig } from 'wxt';

const e2e = process.env.SLC_E2E === '1';

// （环境：sideload 分发, 原因/备注：固定扩展 ID，让 claudecheck.frely.cloud 能通过
// externally_connectable 定点 sendMessage；无私钥则 ID 随安装路径漂移）
const PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEApY4vBregvYd87lbm2pAPZ/aZyQ7avnQzutZCH/KsSr2KiH7zjsSHY3AxR/HW1AEyfjlkNGRkE+5lQ44QjvCbXgYhAB31GV8AvDKiuqntt2OXF6DmHlhFP1Q33gAMBNbF/ztOBfuCeqDpxvQomXYsBtkIeWI21aT9S/zTP9W6ihA3//hLLk6zhEwtz6cMpUqZkRRu9wDqI5Nbm/sbZ6j2O39brt5YDi9WwKvd0M4ThZJQn/bTrn+kTjTueZ55OqsmbkUMuGcLuDwBugVaNj8HAkMC8iLRqKx6B0UpNEKmZFtGr0JwiY29FzUksauGqxuXJn1t+nWM0yhUCzpQVrO29wIDAQAB';

export default defineConfig({
  outDir: e2e ? '.output-e2e' : '.output',
  vite: () => ({
    define: {
      __SLC_E2E__: JSON.stringify(e2e),
    },
    build: {
      sourcemap: false,
    },
    server: {
      fs: {
        allow: ['..'],
      },
    },
  }),
  manifest: {
    name: '__MSG_extName__',
    description: '__MSG_extDesc__',
    default_locale: 'en',
    permissions: [
      'storage',
      'scripting',
      'declarativeNetRequestWithHostAccess',
      ...(e2e ? ['privacy'] : []),
    ],
    optional_permissions: ['privacy'],
    optional_host_permissions: [
      'https://claude.ai/*',
      'https://*.claude.ai/*',
      'https://claude.com/*',
      'https://*.claude.com/*',
      'https://claudecheck.frely.cloud/*',
      'https://*/*',
    ],
    icons: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
    ...(e2e ? { host_permissions: ['http://localhost/*', 'http://127.0.0.1/*'] } : {}),
    key: PUBLIC_KEY,
    // （环境：prod 域名固定, 原因/备注：检测页一键修复的消息通道；仅此源可发 onMessageExternal）
    ...(e2e ? {} : { externally_connectable: { matches: ['https://claudecheck.frely.cloud/*'] } }),
    action: {
      default_title: '__MSG_extAction__',
      default_popup: 'popup.html',
      default_icon: {
        16: 'icons/icon-16.png',
        32: 'icons/icon-32.png',
        48: 'icons/icon-48.png',
      },
    },
  },
});
