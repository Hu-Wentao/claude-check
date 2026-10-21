export interface SiteAuthor {
  id: 'hu-wentao';
  name: string;
  email: string;
  github: string;
  githubUrl: string;
  xUrl: string;
  bio: { en: string; zh: string };
}

export const SITE_AUTHOR: SiteAuthor = {
  id: 'hu-wentao',
  name: 'Hu-Wentao',
  email: 'support@frely.cloud',
  github: 'Hu-Wentao',
  githubUrl: 'https://github.com/Hu-Wentao',
  xUrl: 'https://x.com/wyatt_coder',
  bio: {
    en: 'Independent developer who built Claude Check from public reverse-engineering of Claude Code fingerprinting. This site is a reference tool and educational knowledge base — not affiliated with Anthropic.',
    zh: '独立开发者,基于 Claude Code 指纹检测的公开逆向分析构建了 Claude Check。本站是参考工具与教育型知识库,与 Anthropic 无任何关联。',
  },
};

export const CLARITY_PROJECT_ID = 'z0jc6o8jrt';

// SEO hreflang 扩展:站点仅实际构建 en(/) 与 zh(/zh/) 两种内容,下列区域市场码
// 按语言就近映射到已构建页面,仅在页面 <head> 输出(@astrojs/sitemap 的 i18n
// 映射每语言仅接受单码,sitemap 保持 en/zh-CN 两条主映射)。
export const SEO_ALTERNATE_LOCALES: readonly { code: string; locale: 'en' | 'zh' }[] = [
  { code: 'zh-CN', locale: 'zh' },
  { code: 'ru-RU', locale: 'en' },
  { code: 'zh-HK', locale: 'zh' },
  { code: 'en-HK', locale: 'en' },
  { code: 'fa-IR', locale: 'en' },
  { code: 'es-PR', locale: 'en' },
  { code: 'en-PR', locale: 'en' },
  { code: 'es-VE', locale: 'en' },
  { code: 'be-BY', locale: 'en' },
  { code: 'ru-BY', locale: 'en' },
  { code: 'zh-MO', locale: 'zh' },
  { code: 'pt-MO', locale: 'en' },
];
