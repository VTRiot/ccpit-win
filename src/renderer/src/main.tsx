import './assets/main.css'
import { initLanguageFromConfig } from './i18n'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

// app-config.json (SSoT) から言語を確定させてから React をマウントする。
// マウント前に await することで初回描画時の en→ja チラつき (FOUC) を回避。
void initLanguageFromConfig().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
})
