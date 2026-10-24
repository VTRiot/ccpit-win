import './assets/main.css'
import { initLanguageFromConfig } from './i18n'
import { installGlobalErrorHandlers } from './globalErrorHandlers'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

// ErrorBoundary が拾わない経路（イベントハンドラ・Promise rejection・非同期）を先に塞ぐ。
// React のマウントより前に登録することで、マウント処理中の失敗も拾える。
installGlobalErrorHandlers()

// app-config.json (SSoT) から言語を確定させてから React をマウントする。
// マウント前に await することで初回描画時の en→ja チラつき (FOUC) を回避。
//
// ここで throw されるとマウント自体が起きず、`#root` が空のまま `readyState: complete` になる
// （2026-08-06 に実際に起きた固まり方）。捕まえて最低限の文言を DOM へ出す
// （main 側の watchdog も別経路でこれを検出する）。
void initLanguageFromConfig().finally(() => {
  try {
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <App />
      </StrictMode>
    )
  } catch (e) {
    const root = document.getElementById('root')
    if (root) {
      root.textContent =
        'アプリの初期化に失敗しました。再読み込みしてください。 ' +
        (e instanceof Error ? e.message : String(e))
    }
  }
})
