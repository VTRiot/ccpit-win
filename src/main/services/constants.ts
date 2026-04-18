/** CCPIT 共通定数 */

/** CCPIT バージョン */
export const CCPIT_VERSION = '0.1.0'

/** GitHub リポジトリ URL */
export const GITHUB_URL = 'https://github.com/(placeholder)'

/** Claude Code 公式ドキュメント URL */
export const CLAUDE_CODE_DOCS = {
  memory: 'https://code.claude.com/docs/en/memory',
  settings: 'https://code.claude.com/docs/en/settings',
  rules: 'https://code.claude.com/docs/en/memory#rules',
  skills: 'https://code.claude.com/docs/en/skills',
  hooks: 'https://code.claude.com/docs/en/hooks',
} as const

/** ai-guides URL（GitHub raw） */
export const AI_GUIDES = {
  ja: {
    conversion: 'https://raw.githubusercontent.com/VTRiot/ccpit-win/main/docs/ai-guides/ja/conversion-guide.md',
    diagnosis: 'https://raw.githubusercontent.com/VTRiot/ccpit-win/main/docs/ai-guides/ja/diagnosis-guide.md',
    summary: 'https://raw.githubusercontent.com/VTRiot/ccpit-win/main/docs/ai-guides/ja/manx-summary.md',
  },
  en: {
    conversion: 'https://raw.githubusercontent.com/VTRiot/ccpit-win/main/docs/ai-guides/en/conversion-guide.md',
    diagnosis: 'https://raw.githubusercontent.com/VTRiot/ccpit-win/main/docs/ai-guides/en/diagnosis-guide.md',
    summary: 'https://raw.githubusercontent.com/VTRiot/ccpit-win/main/docs/ai-guides/en/manx-summary.md',
  },
} as const
