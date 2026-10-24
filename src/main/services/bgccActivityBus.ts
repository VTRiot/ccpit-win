import { EventEmitter } from 'events'

/**
 * FB02: BG-CC アクティビティイベントバス（利用者非依存・electron 非依存）。
 *
 * runBackstageCc へ onActivity コールバック引数を足す案ではなくシングルトンバスにした理由:
 * - シングルフライト（modelCatalog の inflightFetch 共有）で第二呼び出し側のコールバックが
 *   黙って落ちる問題が構造的に消える（「誰が聴くか」と「誰が実行を始めたか」を直交化）。
 * - backstageCc.ts の electron 非依存を維持し、node 環境の vitest でそのまま検証できる。
 * - 起動時 TTL 更新はレンダラのマウント前に走る（index.ts の maybeRefreshOnStartup）。
 *   ring buffer の backlog を IPC で後読みさせることで取りこぼしを構造的に解決する
 *   （コールバック方式では「たまたま間に合う」に依存してしまう）。
 * - 将来の BG-CC 第二利用者（設計計画 r2 P2）が呼び出し側変更ゼロでパネル可視化に乗れる。
 */

export type BgccActivityKind =
  | 'start'
  | 'assistant'
  | 'tool'
  | 'raw_stdout'
  | 'stderr'
  | 'result'
  | 'error'

export interface BgccActivityEvent {
  /** run 毎に一意（crypto.randomUUID）。 */
  runId: string
  /** 利用者識別（例 'modelCatalog'）。表示・生ログ帰属用。 */
  source: string
  /** run 内 0 起点の単調増加。renderer 側の順序復元・重複排除キー（runId+seq）。 */
  seq: number
  /** ISO8601。 */
  ts: string
  kind: BgccActivityKind
  /** sanitize 済み・上限適用済みの不活性テキスト（renderer は素のテキストとしてのみ描画）。 */
  text: string
  /** 例 'P1 official docs' / 'P2 env self-report' / 'summary'。 */
  phase?: string
  /** パネル自動オープン判定用（A1: manual の start で開く / A2: startup は失敗時のみ）。 */
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

/**
 * backlog 保持件数。1 run は表示イベント数十件（実測: カタログ取得 P1 で約30行）のため、
 * 直近数 run 分＝起動時 TTL 更新（P1+P2+summary）の全量を確実に覆う値として 200 とする。
 */
export const ACTIVITY_BACKLOG_SIZE = 200

const emitter = new EventEmitter()
// 購読者は ipc 配線（webContents 転送）の 1 本が基本。EventEmitter 既定 10 のままでよいが、
// テストでの多重購読を許容するため上限を明示的に緩める。
emitter.setMaxListeners(50)

const EVENT_NAME = 'activity'

let backlog: BgccActivityEvent[] = []

/** イベントを backlog へ積み、購読者へ配信する。 */
export function emitBgccActivity(ev: BgccActivityEvent): void {
  backlog.push(ev)
  if (backlog.length > ACTIVITY_BACKLOG_SIZE) {
    backlog = backlog.slice(backlog.length - ACTIVITY_BACKLOG_SIZE)
  }
  emitter.emit(EVENT_NAME, ev)
}

/** 購読登録。戻り値は購読解除関数。 */
export function onBgccActivity(listener: (ev: BgccActivityEvent) => void): () => void {
  emitter.on(EVENT_NAME, listener)
  return () => {
    emitter.removeListener(EVENT_NAME, listener)
  }
}

/** backlog のコピーを返す（renderer の遅延マウント補完用）。 */
export function getRecentActivity(): BgccActivityEvent[] {
  return backlog.slice()
}

/** テスト専用: 購読者と backlog を全消去する。 */
export function _resetForTest(): void {
  emitter.removeAllListeners(EVENT_NAME)
  backlog = []
}
