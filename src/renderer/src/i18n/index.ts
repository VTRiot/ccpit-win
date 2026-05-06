import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './en.json'
import ja from './ja.json'

type Language = 'ja' | 'en'

// 旧 localStorage キー — マイグレーション専用、書き込みには使用しない
const LEGACY_STORAGE_KEY = 'ccpit-lang'

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    ja: { translation: ja },
  },
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false,
  },
})

function detectFallbackLanguage(): Language {
  if (typeof navigator !== 'undefined' && typeof navigator.language === 'string') {
    return navigator.language.toLowerCase().startsWith('ja') ? 'ja' : 'en'
  }
  return 'en'
}

/**
 * app-config.json (SSoT) から language を読み込み i18n に反映する。
 * - main.tsx が React マウント前に await で呼び出すことで初回描画前に確定させる
 * - 旧 localStorage 'ccpit-lang' のマイグレーション処理を含む（best-effort）
 * - configGet 失敗時は navigator.language で ja/en を判定するフォールバック
 */
export async function initLanguageFromConfig(): Promise<void> {
  if (typeof window === 'undefined' || !window.api) {
    if (i18n.language !== detectFallbackLanguage()) {
      await i18n.changeLanguage(detectFallbackLanguage())
    }
    return
  }

  try {
    const cfg = await window.api.configGet()
    let target: Language = cfg.language

    // 旧 localStorage キーからのマイグレーション（同一オリジンで legacy 値が残っている場合）
    try {
      const legacy = localStorage.getItem(LEGACY_STORAGE_KEY)
      if ((legacy === 'ja' || legacy === 'en') && legacy !== target) {
        target = legacy
        await window.api.configSet({ language: legacy })
      }
      if (legacy !== null) {
        localStorage.removeItem(LEGACY_STORAGE_KEY)
      }
    } catch {
      // localStorage 不可用環境はスキップ
    }

    if (i18n.language !== target) {
      await i18n.changeLanguage(target)
    }
  } catch (err) {
    console.warn('[i18n] Failed to load language from app-config.json, using fallback', err)
    const fallback = detectFallbackLanguage()
    if (i18n.language !== fallback) {
      await i18n.changeLanguage(fallback)
    }
  }
}

export default i18n
