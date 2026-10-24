/**
 * 054 AC7: 起動オプション（PJ 単位）の変更をマウント済み UI へ伝搬するアプリ内イベント
 * （modelCatalogEvent.ts と同型。CCES_CONFIG_CHANGED_EVENT と同じ window イベント方式）。
 *
 * 背景: FableLaunchButton は tooltip の実モデル ID を mount 時と catalog / config 変更時に
 * しか解決しないため、起動メニューで `fableVersion` を変えても remount するまで表示が
 * 古いままだった（053 W-4 の残骸）。localStorage への書込は同一 renderer 内では
 * 'storage' イベントを発火しないので、書き手側から明示的に通知する必要がある。
 *
 * 不変条件:
 *   - dispatch は**実際に値が変わったときのみ**（同値 patch では発火しない。さもないと
 *     再レンダのたびに全購読者が IPC を投げる）
 *   - detail.projectPath を必ず載せる。購読側は samePath で**自 PJ のイベントだけ**を拾う
 *     （他 PJ の変更で全行が再解決すると、1 変更 × 行数 × 2 IPC のファンアウトになる）
 *   - イベント名の文字列リテラルを他所へ複製しない（この定数だけを import する。ズレると
 *     「発火しているのに誰も聞いていない」無音故障になる）
 */
export const LAUNCH_OPTIONS_CHANGED_EVENT = 'launch-options-changed'

export type LaunchOptionsChangedDetail = { projectPath: string }

/**
 * 起動オプションが**実際に変化した**後に呼ぶ。購読者（FableLaunchButton）が
 * 永続値を読み直して表示を再解決する。
 * window 不在（node 環境の vitest）では no-op ＝ lib を純関数として検証できる。
 */
export function announceLaunchOptionsChanged(projectPath: string): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent<LaunchOptionsChangedDetail>(LAUNCH_OPTIONS_CHANGED_EVENT, {
      detail: { projectPath }
    })
  )
}
