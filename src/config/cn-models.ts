/**
 * Domestic (Chinese) LLM picks rendered by `src/components/CnModels.astro`
 * as a strip of name-only outbound links below the "How the check works"
 * section. Every link is tagged with the `utm_source=claude-check` referral source.
 */

export interface CnModel {
  id: string;
  name: string;
  /** Outbound link, tagged with the claude-check referral source. */
  url: string;
}

export const CN_MODELS: CnModel[] = [
  {
    id: 'kimi',
    name: 'Kimi',
    url: 'https://www.kimi.com/code?utm_source=claude-check',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    url: 'https://www.deepseek.com/?utm_source=claude-check',
  },
  {
    id: 'glm',
    name: 'GLM',
    url: 'https://bigmodel.cn/?utm_source=claude-check',
  },
];
