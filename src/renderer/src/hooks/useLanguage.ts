import { useTranslation } from 'react-i18next'

type Language = 'en' | 'ja'

export function useLanguage(): { language: Language; toggleLanguage: () => void } {
  const { i18n } = useTranslation()
  const language = (i18n.language as Language) || 'en'

  const toggleLanguage = (): void => {
    const next: Language = language === 'en' ? 'ja' : 'en'
    void (async () => {
      await i18n.changeLanguage(next)
      try {
        await window.api.configSet({ language: next })
      } catch (err) {
        console.warn('[useLanguage] Failed to persist language to app-config.json', err)
      }
    })()
  }

  return { language, toggleLanguage }
}
