import { useSyncExternalStore } from 'react'
import {
  reduce,
  catalogRefreshSummaryRunIds,
  INITIAL_BGCC_STATE,
  type BgccActivityState,
  type BgccAction,
  type BgccActivityEvent
} from '../lib/bgccActivity'
import { announceModelCatalogChanged } from '../lib/modelCatalogEvent'

/**
 * FB02: BG-CC アクティビティのモジュールスコープ単一ストア。
 * StatusBar（インジケータ+バッジ）とパネルが同一状態を共有するための最小機構
 * （codebase に中央状態管理が無いため、React 組込の useSyncExternalStore + module 変数で足りる）。
 * 純ロジックは lib/bgccActivity.ts の reduce に全委譲し、本ファイルは window.api 配線のみの薄い殻。
 */

let state: BgccActivityState = INITIAL_BGCC_STATE
// config 読込前は「静か」側に倒す（fail-quiet）。読込後・トグル操作時に更新される。
let hidden = true
let refCount = 0
let unsubscribeIpc: (() => void) | null = null
const listeners = new Set<() => void>()

function emitChange(): void {
  for (const l of listeners) l()
}

function dispatch(action: BgccAction): void {
  const next = reduce(state, action)
  if (next === state) return
  // 054: カタログ更新の summary が**新規に**入ったときだけ、マウント済み UI へ再読を促す。
  // 到着時ではなく状態遷移で判定するのが要点で、これにより
  //   - live と replay で同じ summary が二重到着 → reduce が (runId, seq) 重複で同一参照を
  //     返す（bgccActivity.ts :117）ので次行の early return に落ち、二重 announce しない
  //   - replay に summary が複数 → 1 dispatch に合流するので announce も 1 回
  // が状態 dedupe の副産物として自動的に満たされる（announce 側に台帳を持たせない）。
  // runs 参照が変わらない action（パネル開閉）では集合計算そのものを省く。
  const before = next.runs !== state.runs ? catalogRefreshSummaryRunIds(state) : null
  state = next
  emitChange()
  if (!before) return
  const after = catalogRefreshSummaryRunIds(next)
  for (const runId of after) {
    if (!before.has(runId)) {
      // 購読直後の replay に成功 summary が有れば 1 回発火する（子の mount fetch → App の IPC 購読の
      // 隙間を埋める意図的挙動・費用は購読者×再読 IPC）。evict 済み summary の再来も同様に冪等・無害。
      announceModelCatalogChanged()
      return
    }
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useBgccActivity(): BgccActivityState {
  return useSyncExternalStore(subscribe, () => state)
}

export function openBgccPanel(): void {
  dispatch({ type: 'openPanel' })
}

export function closeBgccPanel(): void {
  dispatch({ type: 'closePanel' })
}

/** SettingsDialog のトグルから同期する（config 再読なしで自動オープン抑止を即反映）。 */
export function setBgccHiddenPref(next: boolean): void {
  hidden = next
}

/**
 * App.tsx の useEffect から1回呼ぶ。戻り値は cleanup。
 * refCount で StrictMode の二重 effect / HMR 再マウントを冪等化する（listener leak 防止）。
 * 手順: live listener 先付け → hidden 設定読込 → backlog replay（(runId,seq) dedupe が
 * live/replay の重複と順序を吸収する — 起動時 TTL 更新のマウント前完了への対策）。
 */
export function startBgccSubscription(): () => void {
  refCount++
  if (refCount === 1) {
    unsubscribeIpc = window.api.onBgccActivity((ev: BgccActivityEvent) => {
      dispatch({ type: 'event', event: ev, hidden })
    })
    void (async (): Promise<void> => {
      try {
        const cfg = await window.api.configGet()
        hidden = cfg.backstageCc?.hidden ?? false
      } catch {
        /* fail-quiet: hidden=true のまま（自動オープンだけが抑止される） */
      }
      try {
        const recent = await window.api.bgccActivityRecent()
        dispatch({ type: 'replay', events: recent, hidden })
      } catch {
        /* main 側未対応/失敗時は live のみで動く */
      }
    })()
  }
  return () => {
    refCount--
    if (refCount === 0 && unsubscribeIpc) {
      unsubscribeIpc()
      unsubscribeIpc = null
    }
  }
}
