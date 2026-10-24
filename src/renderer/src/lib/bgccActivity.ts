/**
 * FB02: BG-CC アクティビティパネルの純ロジック核（状態遷移・自動オープン判定・バッジ計数）。
 * window/api に触れないため node 環境の vitest でそのまま検証できる（useBgccActivity は薄い殻）。
 * イベント型は preload の BgccActivityEventDto と同型（renderer は main を import しない既存慣習）。
 */

export type BgccActivityEvent = {
  runId: string
  source: string
  seq: number
  ts: string
  kind: 'start' | 'assistant' | 'tool' | 'raw_stdout' | 'stderr' | 'result' | 'error'
  text: string
  phase?: string
  trigger?: 'manual' | 'startup'
  meta?: {
    ok?: boolean
    durationMs?: number
    costUsd?: number
    permissionDenied?: boolean
    exitCode?: number | null
    resultEventCount?: number
  }
}

export type BgccRun = { runId: string; source: string; events: BgccActivityEvent[] }
export type BgccIndicatorStatus = 'idle' | 'running' | 'succeeded' | 'failed'

export interface BgccActivityState {
  /** 到着順。末尾が最新 run。 */
  runs: BgccRun[]
  panelOpen: boolean
  /** パネル閉時に到着したイベント数（open で 0 リセット）。 */
  unseen: number
}

export type BgccAction =
  | { type: 'event'; event: BgccActivityEvent; hidden: boolean }
  | { type: 'replay'; events: BgccActivityEvent[]; hidden: boolean }
  | { type: 'openPanel' }
  | { type: 'closePanel' }

/** 1 run の保持イベント上限。45s 上限の 1 run が行単位イベントで超えない実用上限（DOM 数拘束）。 */
export const MAX_EVENTS_PER_RUN = 500
/** 保持 run 数。インジケータ判定は最新 run のみ・履歴閲覧は直近数回で十分。 */
export const MAX_RUNS = 5
/** バッジ表示上限（超過は "99+"）。 */
export const BADGE_MAX = 99

export const INITIAL_BGCC_STATE: BgccActivityState = { runs: [], panelOpen: false, unseen: 0 }

/**
 * (runId, seq) をキーに重複排除しつつ seq 昇順で挿入する。
 * live 購読と replay（bgccActivityRecent）の重複到着を吸収する正しさの背骨。
 */
export function upsertEvent(runs: BgccRun[], ev: BgccActivityEvent): BgccRun[] {
  const idx = runs.findIndex((r) => r.runId === ev.runId)
  if (idx < 0) {
    const next = [...runs, { runId: ev.runId, source: ev.source, events: [ev] }]
    return next.length > MAX_RUNS ? next.slice(next.length - MAX_RUNS) : next
  }
  const run = runs[idx]
  if (run.events.some((e) => e.seq === ev.seq)) return runs
  const events = [...run.events]
  let insertAt = events.length
  while (insertAt > 0 && events[insertAt - 1].seq > ev.seq) insertAt--
  events.splice(insertAt, 0, ev)
  const capped = events.length > MAX_EVENTS_PER_RUN ? events.slice(1) : events
  const next = [...runs]
  next[idx] = { ...run, events: capped }
  return next
}

export function runStatus(run: BgccRun): Exclude<BgccIndicatorStatus, 'idle'> {
  for (const e of run.events) {
    if (e.kind === 'error') return 'failed'
    if (e.kind === 'result') return e.meta?.ok === true ? 'succeeded' : 'failed'
  }
  return 'running'
}

/** インジケータは最新 run の状態を映す（旧 run の失敗を引きずらない）。 */
export function indicatorStatus(runs: BgccRun[]): BgccIndicatorStatus {
  if (runs.length === 0) return 'idle'
  return runStatus(runs[runs.length - 1])
}

/**
 * パネル自動オープン判定（F5/F6・A1/A2）:
 * - hidden=true → 常に false（バッジ・インジケータは更新継続）
 * - manual トリガの start → true（A1: 手動更新で開く）
 * - 失敗終端（result ok=false / error）→ trigger 問わず true（A2: startup も失敗時は開く）
 * - trigger 欠落は 'startup' 扱い（契約ドリフト時は静かな側へ倒す fail-quiet）
 */
export function shouldAutoOpen(ev: BgccActivityEvent, hidden: boolean): boolean {
  if (hidden) return false
  if (ev.kind === 'start' && ev.trigger === 'manual') return true
  if (ev.kind === 'error') return true
  if (ev.kind === 'result' && ev.meta?.ok === false) return true
  return false
}

export function formatBadge(unseen: number): string {
  if (unseen <= 0) return ''
  return unseen > BADGE_MAX ? `${BADGE_MAX}+` : String(unseen)
}

/** 単一エントリポイント。すべての状態遷移はここを通す（テスト対象）。 */
export function reduce(state: BgccActivityState, action: BgccAction): BgccActivityState {
  switch (action.type) {
    case 'openPanel':
      return { ...state, panelOpen: true, unseen: 0 }
    case 'closePanel':
      return { ...state, panelOpen: false }
    case 'event': {
      const runs = upsertEvent(state.runs, action.event)
      if (runs === state.runs) return state // (runId, seq) 重複 → 完全無変化（unseen も増やさない）
      const open = state.panelOpen || shouldAutoOpen(action.event, action.hidden)
      return {
        runs,
        panelOpen: open,
        unseen: open ? 0 : Math.min(state.unseen + 1, BADGE_MAX + 1)
      }
    }
    case 'replay': {
      let next = state
      for (const ev of action.events) {
        next = reduce(next, { type: 'event', event: ev, hidden: action.hidden })
      }
      return next
    }
  }
}

/**
 * 054: モデルカタログ更新の summary を持つ run の runId 集合。
 *
 * 「カタログ取得は終わったのに、マウント済み UI が古い値のまま」という欠陥の検出点。
 * **到着時ではなく状態遷移で**判定するために純セレクタとして置く（reduce は副作用を持たない
 * 単一エントリポイントのまま保つ）。useBgccActivity の dispatch が reduce 前後の集合を比較し、
 * 差分（after − before）が非空のときだけ announce する。
 *
 * なぜ「件数」ではなく「集合」か: MAX_RUNS 超過で最古 run が evict される（upsertEvent :60）ため、
 * summary を持つ古い run が押し出されるのと同時に新しい summary が入ると件数が相殺されて
 * 動かない。他 source の run（skillProposals 等）が実在するので現実に起きる。集合なら runId が
 * 変わるので捕捉できる。
 *
 * main 側の発行点は modelCatalog.ts:241-265 の `phase: 'summary'` emit（1 summary = 1 run・runId は randomUUID、seq は 0）。
 * source 文字列はプロセス境界を跨ぐため定数を共有できない（本ファイル冒頭の「renderer は main を
 * import しない」慣習）。改名するときは main 側と対で追随させること。
 */
export const CATALOG_ACTIVITY_SOURCE = 'modelCatalog'

/** 成功 summary だけを拾う。失敗時は kind='error' / meta.ok=false で来るので偽になる。 */
function isCatalogRefreshSummary(ev: BgccActivityEvent): boolean {
  return (
    ev.source === CATALOG_ACTIVITY_SOURCE &&
    ev.phase === 'summary' &&
    ev.kind === 'result' &&
    ev.meta?.ok === true
  )
}

export function catalogRefreshSummaryRunIds(state: BgccActivityState): Set<string> {
  const ids = new Set<string>()
  for (const run of state.runs) {
    if (run.events.some(isCatalogRefreshSummary)) ids.add(run.runId)
  }
  return ids
}

/** パネルの Copy ボタン用プレーンテキスト（選択非依存の全量コピー）。 */
export function buildCopyText(run: BgccRun | undefined): string {
  if (!run || run.events.length === 0) return ''
  return run.events.map((e) => `[${formatEventTime(e.ts)}] ${e.kind}\t${e.text}`).join('\n')
}

/** ロケール準拠の時刻表示。不正 ISO は原文返し（catalogFormat.ts と同じ fail-open 流儀）。 */
export function formatEventTime(iso: string, locale?: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleTimeString(locale, { hour12: false })
}
