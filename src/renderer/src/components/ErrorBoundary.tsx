import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * レンダリング例外でアプリ全体が**無言のブランク**になるのを防ぐ境界。
 *
 * 背景（2026-08-06 実測）: 1 ページのコンポーネントが throw しただけで React がツリー全体を
 * unmount し、`#root` が空・`readyState: complete` のまま固まる事象が発生した。
 * 当時 renderer には境界が 1 つも無く、ユーザーには理由も復旧手段も出なかった。
 *
 * 設計（修正方針 Codex レビュー r1〜r7 で収束）:
 * - **2 段構成**。`variant="page"` は 1 ページの障害を封じ込め（shell とナビは生存）、
 *   `variant="root"` は最後の砦。
 * - **ルート fallback は依存を極小化する**。UI ライブラリ・router・i18n・`window.api` に触らない。
 *   ここが投げたら拾う先が無いため「依存が少ないほど正しい」。
 * - **エラー内容の読み出し自体が例外を投げうる**（`message` が throwing getter のケース）ので
 *   `safeToString` を通す。
 * - main への通知は **fire-and-forget**。`invoke` の reject は同期 try/catch で捕まえられず、
 *   通知の失敗が unhandled rejection になって二次障害を生むため。
 */

/**
 * throw された値を安全に文字列化する。
 * `Error` とは限らず、`message` の**プロパティアクセス自体が throw する**ことがある。
 */
export function safeToString(e: unknown): string {
  try {
    if (typeof e === 'string') return e
    const m = (e as { message?: unknown })?.message
    return typeof m === 'string' ? m : String(e)
  } catch {
    return '(エラー内容を取得できませんでした)'
  }
}

/** ログ参照用の短い識別子。本番では詳細の代わりにこれを出す。 */
export function makeErrorId(now: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `E${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${p(now.getMilliseconds(), 3)}`
}

/** main へエラーを通知する（fire-and-forget・失敗しても呼び出し元を壊さない）。 */
function reportToMain(payload: {
  scope: 'page' | 'root'
  errorId: string
  message: string
  stack?: string
  componentStack?: string
}): void {
  try {
    const api = (window as unknown as { api?: { reportRendererError?: (p: unknown) => void } }).api
    api?.reportRendererError?.(payload)
  } catch {
    /* 通知できなくても画面表示は続ける（最後の砦を通知失敗で壊さない） */
  }
}

interface Props {
  children: ReactNode
  variant: 'page' | 'root'
  /** page 境界の復旧導線（ホームへ戻る等）。root 境界では使わない */
  onReset?: () => void
  /** 開発時のみ詳細（message / stack）を出す */
  showDetail?: boolean
}

interface State {
  error: unknown
  errorId: string
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, errorId: '' }

  static getDerivedStateFromError(error: unknown): State {
    return { error, errorId: makeErrorId(new Date()) }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // 詳細の抽出は fallback の render 経路から切り離す（ここが投げても描画は生きる）
    try {
      reportToMain({
        scope: this.props.variant,
        errorId: this.state.errorId,
        message: safeToString(error),
        stack: (error as { stack?: string })?.stack,
        componentStack: info?.componentStack ?? undefined
      })
    } catch {
      /* 通知失敗は握る（ログ経路が死んでも画面は出す） */
    }
  }

  private reload = (): void => {
    try {
      window.location.reload()
    } catch {
      /* 何もできないが、文言は画面に残る */
    }
  }

  render(): ReactNode {
    const { error, errorId } = this.state
    if (!error) return this.props.children

    const detail = this.props.showDetail ? safeToString(error) : null

    // --- ルート境界: 依存ゼロの静的 UI（素の DOM + inline style のみ） ---
    if (this.props.variant === 'root') {
      return (
        <div
          style={{
            padding: '24px',
            fontFamily: 'system-ui, sans-serif',
            fontSize: '14px',
            lineHeight: 1.7,
            color: '#e5e5e5',
            background: '#1f1f1f',
            minHeight: '100vh'
          }}
        >
          <h1 style={{ fontSize: '16px', margin: '0 0 12px' }}>
            アプリの表示中にエラーが発生しました
          </h1>
          <p style={{ margin: '0 0 8px' }}>
            画面を再読み込みすると復帰できることがあります。エラー ID: <code>{errorId}</code>
          </p>
          {detail ? (
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                background: '#2a2a2a',
                padding: '8px',
                borderRadius: '4px',
                margin: '0 0 12px'
              }}
            >
              {detail}
            </pre>
          ) : (
            <p style={{ margin: '0 0 12px', opacity: 0.75 }}>
              詳細はアプリのログに記録されています（エラー ID で参照できます）。
            </p>
          )}
          <button
            type="button"
            onClick={this.reload}
            style={{
              padding: '6px 14px',
              fontSize: '14px',
              cursor: 'pointer',
              background: '#3b82f6',
              color: '#fff',
              border: 'none',
              borderRadius: '4px'
            }}
          >
            再読み込み
          </button>
        </div>
      )
    }

    // --- ページ境界: shell とナビは生存しているので、復旧導線を出せる ---
    return (
      <div className="p-6 space-y-3 text-sm">
        <div className="font-medium text-rose-600">この画面でエラーが発生しました</div>
        <div className="text-muted-foreground">
          他の画面へは移動できます。エラー ID: <code>{errorId}</code>
        </div>
        {detail ? (
          <pre className="text-xs bg-muted/40 rounded p-2 overflow-auto max-h-60 whitespace-pre-wrap">
            {detail}
          </pre>
        ) : (
          <div className="text-muted-foreground">
            詳細はアプリのログに記録されています（エラー ID で参照できます）。
          </div>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            className="px-3 py-1 rounded bg-primary text-primary-foreground"
            onClick={this.reload}
          >
            再読み込み
          </button>
          {this.props.onReset && (
            <button
              type="button"
              className="px-3 py-1 rounded border"
              onClick={() => {
                try {
                  this.setState({ error: null, errorId: '' })
                  this.props.onReset?.()
                } catch {
                  /* 復帰に失敗しても画面は残す */
                }
              }}
            >
              前の画面へ戻る
            </button>
          )}
        </div>
      </div>
    )
  }
}
