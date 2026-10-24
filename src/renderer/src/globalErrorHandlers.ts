/**
 * ErrorBoundary が**捕捉しない**経路を塞ぐ（修正方針レビュー r1#1 / r4#3）。
 *
 * React の ErrorBoundary が拾うのはレンダー中・ライフサイクル中の例外だけで、
 * イベントハンドラ内の throw / Promise rejection / setTimeout 等の非同期例外は拾わない。
 * 「何が起きても無言にしない」を成立させるには、ここを別に塞ぐ必要がある。
 *
 * **全面エラー画面へは倒さない**。非同期エラーは画面が生きていることが多く、
 * 操作中の状態を失わせるほうが害が大きい。「握り潰さない」と「全部を致命扱いにする」は別。
 *
 * 縮退は 3 段（最後の 1 段は依存ゼロで到達できること）:
 *   1. main へ通知（fire-and-forget）
 *   2. それも無理なら DOM 直書きの最小通知
 *   3. すべて失敗しても、この関数自身は決して throw しない
 */

const NOTICE_ID = 'ccpit-async-error-notice'

/** DOM 直書きの最小通知（フレームワーク非依存の最後の砦）。 */
function domNotice(text: string): void {
  try {
    let el = document.getElementById(NOTICE_ID)
    if (!el) {
      el = document.createElement('div')
      el.id = NOTICE_ID
      el.setAttribute(
        'style',
        [
          'position:fixed',
          'right:12px',
          'bottom:12px',
          'z-index:2147483647',
          'max-width:420px',
          'padding:8px 12px',
          'border-radius:6px',
          'background:#7f1d1d',
          'color:#fff',
          'font:12px/1.6 system-ui,sans-serif',
          'box-shadow:0 2px 8px rgba(0,0,0,.4)'
        ].join(';')
      )
      document.body.appendChild(el)
    }
    // textContent で入れる（HTML 解釈させない）
    el.textContent = text
  } catch {
    /* ここが最後。これ以上できることは無い */
  }
}

/** main へ通知する。`send` の fire-and-forget（`invoke` の reject が二次障害になるのを避ける）。 */
function report(kind: 'error' | 'unhandledrejection', message: string, stack?: string): boolean {
  try {
    const api = (window as unknown as { api?: { reportRendererError?: (p: unknown) => void } }).api
    if (!api?.reportRendererError) return false
    api.reportRendererError({ scope: kind, message, stack })
    return true
  } catch {
    return false
  }
}

function describe(e: unknown): string {
  try {
    if (typeof e === 'string') return e
    const m = (e as { message?: unknown })?.message
    return typeof m === 'string' ? m : String(e)
  } catch {
    return '(エラー内容を取得できませんでした)'
  }
}

/** 一度だけ登録する（多重登録すると通知が重複する）。 */
let installed = false

export function installGlobalErrorHandlers(): void {
  if (installed) return
  installed = true

  window.addEventListener('error', (ev) => {
    try {
      const msg = describe(ev.error ?? ev.message)
      const ok = report('error', msg, (ev.error as { stack?: string })?.stack)
      if (!ok) domNotice('エラーが発生しました: ' + msg)
    } catch {
      domNotice('エラーが発生しました（詳細を取得できません）')
    }
  })

  window.addEventListener('unhandledrejection', (ev) => {
    try {
      const msg = describe((ev as PromiseRejectionEvent).reason)
      const ok = report('unhandledrejection', msg)
      if (!ok) domNotice('処理が失敗しました: ' + msg)
    } catch {
      domNotice('処理が失敗しました（詳細を取得できません）')
    }
  })
}
