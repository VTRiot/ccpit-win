import { appendFileSync } from 'fs'
import { performance } from 'perf_hooks'

/**
 * 区間の所要時間を JSONL で記録する計測の口（CCPIT_L0_004 W6）。
 *
 * 環境変数 CCPIT_PERF_TRACE に出力先のファイルパスがあるときだけ働く。未設定なら何もしない
 * （普段の起動は今までと同じ。記録の失敗も握りつぶし、本処理を止めない）。
 */
const PERF_TRACE_ENV = 'CCPIT_PERF_TRACE'

function traceFile(): string | undefined {
  const v = process.env[PERF_TRACE_ENV]
  return v && v.length > 0 ? v : undefined
}

export function perfEnabled(): boolean {
  return traceFile() !== undefined
}

export function perfRecord(name: string, ms: number, extra?: Record<string, unknown>): void {
  const file = traceFile()
  if (!file) return
  try {
    appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), name, ms, ...extra }) + '\n')
  } catch {
    /* 計測の記録に失敗しても本処理は続ける */
  }
}

/** 同期・非同期どちらの関数も包める。無効時は fn をそのまま呼ぶ */
export async function perfSpan<T>(
  name: string,
  fn: () => T | Promise<T>,
  extra?: Record<string, unknown>
): Promise<T> {
  if (!perfEnabled()) return await fn()
  const t0 = performance.now()
  try {
    return await fn()
  } finally {
    perfRecord(name, performance.now() - t0, extra)
  }
}

/** 同期区間用 */
export function perfSpanSync<T>(name: string, fn: () => T, extra?: Record<string, unknown>): T {
  if (!perfEnabled()) return fn()
  const t0 = performance.now()
  try {
    return fn()
  } finally {
    perfRecord(name, performance.now() - t0, extra)
  }
}
