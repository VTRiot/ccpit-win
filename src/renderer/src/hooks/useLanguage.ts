import { useTranslation } from 'react-i18next'
import { STORAGE_KEY } from '../i18n'

type Language = 'en' | 'ja'

export function useLanguage(): { language: Language; toggleLanguage: () => void } {
  const { i18n } = useTranslation()
  const language = (i18n.language as Language) || 'en'

  const toggleLanguage = (): void => {
    const next = language === 'en' ? 'ja' : 'en'
    i18n.changeLanguage(next)
    localStorage.setItem(STORAGE_KEY, next)
    // main プロセス側 app-config.json にも言語を保存（deploy/health で参照される）
    void window.api.configSet({ language: next })
  }

  return { language, toggleLanguage }
}
