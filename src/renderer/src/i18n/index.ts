import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './en.json'
import ja from './ja.json'

const STORAGE_KEY = 'parc-ferme-lang'

const initialLang = (localStorage.getItem(STORAGE_KEY) || 'en') as 'ja' | 'en'

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    ja: { translation: ja },
  },
  lng: initialLang,
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false,
  },
})

// 起動時に main プロセス app-config.json の language を localStorage と同期
if (typeof window !== 'undefined' && window.api) {
  void window.api.configSet({ language: initialLang })
}

export { STORAGE_KEY }
export default i18n
