import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  // golden/ は配布バンドル正本（dist/out と同種のアーティファクト）。アプリ用 TS/React 設定で
  // lint すると CommonJS スクリプトが誤 error になり、vendor/mermaid.min.js (3.3MB) は prettier が
  // heap OOM でクラッシュする（038 §4-6 検証中に判明した既存地雷）。検証は各 skill の selfcheck が担う。
  // resources/dashboard-ja も同種（同梱する実体をそのまま配る領域）。アプリ用 TS/React 設定で
  // lint する対象ではなく、整形も禁止（sha256 固定テストが正本との一致を守っている）。
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/out',
      'golden',
      'resources/dashboard-ja',
      // 古い golden の自己検査の写し（試験が「この版に戻ったら落ちる」ことを示すために保存。golden と同様に中身を変えない）
      'src/main/services/__tests__/fixtures/proposal-golden-self-check',
      '**/vendor',
      '**/*.min.js'
    ]
  },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules
    }
  },
  {
    // TypeScript projects already enforce prop typing; runtime prop-types are redundant.
    files: ['**/*.{ts,tsx}'],
    rules: {
      'react/prop-types': 'off'
    }
  },
  {
    // shadcn/ui standard implementation; defer to upstream (e.g. button.tsx exports
    // both Button and buttonVariants from the same file).
    files: ['src/renderer/src/components/ui/**/*.tsx'],
    rules: {
      'react-refresh/only-export-components': 'off'
    }
  },
  eslintConfigPrettier
)
