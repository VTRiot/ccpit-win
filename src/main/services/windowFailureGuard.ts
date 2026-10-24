/**
 * ウィンドウが**無言のブランクになる**のを防ぐ番人（修正方針 Codex レビュー r1〜r7 で収束）。
 *
 * 2026-08-06 実測: renderer が render 中に throw し、`readyState: complete` かつ `#root` 空のまま
 * ウィンドウが固まった。main には `did-fail-load` も `render-process-gone` のハンドラも無く、
 * ユーザーには理由も復旧手段も出なかった。
 *
 * ここで守るのは **「空のまま放置されない」の一点**。renderer 側が自力でエラーを可視化できて
 * いるなら（ErrorBoundary の fallback 等）main が上書きする理由は無いので、
 * `app:renderer-ready` を受けた時点で watchdog は解除する。
 *
 * 純粋な判定部分（HTML 生成・致命判定）は export してテストで固定する。
 */

/** HTML 実体参照へのエスケープ。data: URL へ埋める前に必ず通す。 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * `did-fail-load` を致命扱いするか。
 *
 * - **サブフレームの失敗は対象外**。埋め込み・外部リンクの失敗で正常画面を潰さない
 * - **`ERR_ABORTED`(-3) は対象外**。ユーザー操作・正常な遷移中断・リダイレクトで日常的に出る
 */
export function isFatalLoadFailure(errorCode: number, isMainFrame: boolean): boolean {
  if (!isMainFrame) return false
  if (errorCode === -3) return false // ERR_ABORTED
  return true
}

/**
 * `render-process-gone` の reason が再読込に値するか。
 * `clean-exit` は意図された終了なので、リトライもエラー画面も出さない。
 */
export function isRetriableCrash(reason: string): boolean {
  return ['crashed', 'oom', 'launch-failed', 'integrity-failure', 'abnormal-exit'].includes(reason)
}

/**
 * 依存ゼロのエラーページを `data:` URL として組む。
 *
 * ファイル・dev server・preload・renderer bundle の**いずれにも依存しない**
 * （それらが壊れているから表示している、という状況なので依存してはならない）。
 * 埋め込む値は HTML エスケープし、完成した HTML 全体を `encodeURIComponent` する
 * （`%` や改行が data URL を壊すため）。CSP で外部リソースの読み込みも封じる。
 */
export function buildFatalErrorPageUrl(input: {
  title: string
  detail: string
  hint: string
}): string {
  const html = [
    '<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">',
    `<title>${escapeHtml(input.title)}</title></head>`,
    '<body style="margin:0;padding:24px;background:#1f1f1f;color:#e5e5e5;',
    'font:14px/1.7 system-ui,sans-serif">',
    `<h1 style="font-size:16px;margin:0 0 12px">${escapeHtml(input.title)}</h1>`,
    `<p style="margin:0 0 8px">${escapeHtml(input.detail)}</p>`,
    `<p style="margin:0;opacity:.75">${escapeHtml(input.hint)}</p>`,
    '</body></html>'
  ].join('')
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
}

/** 再読込の上限。超えたら自動リトライを止め、エラーページで操作をユーザーへ返す。 */
export const MAX_CRASH_RELOADS = 2

/** `did-finish-load` から「描画された」通知を待つ猶予。 */
export const RENDERER_READY_TIMEOUT_MS = 8000

/** `ready-to-show` を待つ猶予（超えたら splash を閉じて main を出す）。 */
export const READY_TO_SHOW_TIMEOUT_MS = 15000

/** ログ 1 行を組む（main 側のログ出力先はアプリの既存作法に合わせる）。 */
export function formatGuardLog(kind: string, detail: Record<string, unknown>): string {
  let body: string
  try {
    body = JSON.stringify(detail)
  } catch {
    body = '(detail をシリアライズできませんでした)'
  }
  return `[window-guard] ${kind} ${body}`
}
