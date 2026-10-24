import type { OwnershipLease } from './pxpipeOwnership'

/**
 * pxpipeDiagnostics — 中継経路の自己診断と自律復旧 Watchdog (CCPIT_066 / Codex F4, F5, F9)。
 */

export type IncidentCategory =
  | 'no-config'
  | 'owned-absent'
  | 'port-conflict'
  | 'external-api-down'
  | 'unknown'

export interface DiagnosticInput {
  hasPxpipeConfig: boolean
  lease?: OwnershipLease | null
  isProcessAlive?: boolean
  isPortListening?: boolean
  isProxyHealthy?: boolean
  isExternalApiReachable?: boolean
  port?: number
}

export interface DiagnosticIncident {
  category: IncidentCategory
  canAutoRecover: boolean
  reason: string
  port?: number
}

export interface HealingOptions {
  incident: DiagnosticIncident
  maxAttempts?: number
  backoffMs?: number[]
  recoverFn: () => Promise<{ ok: boolean; url?: string; error?: Error }>
  onLog?: (level: string, message: string) => void
}

export interface HealingResult {
  recovered: boolean
  attempts: number
  url?: string
  reason?: string
}

/**
 * 5 分類自己診断マトリクス (Codex F5)。
 * 優先順位に従って障害の原因を特定し、自動操作の可否を判定する。
 */
export function classifyIncident(input: DiagnosticInput): DiagnosticIncident {
  // 優先度 1: 設定不備（有効な構成がない）
  if (!input.hasPxpipeConfig) {
    return {
      category: 'no-config',
      canAutoRecover: false,
      reason: 'pxpipe 有効なセッションまたは設定が存在しません（常駐不要）',
      port: input.port
    }
  }

  // 優先度 2: 所有 upstream 不在（有効 Lease あり ∧ PID 不在、またはセッション要求があるのに proxy 不在）
  if (
    (input.lease && input.isProcessAlive === false) ||
    (input.hasPxpipeConfig && !input.isPortListening && !input.isProxyHealthy && input.isProcessAlive === false)
  ) {
    return {
      category: 'owned-absent',
      canAutoRecover: true,
      reason: input.lease
        ? `所有していた proxy (PID: ${input.lease.pid}) が OS 上に存在しません`
        : 'セッションが要求する upstream proxy が稼働していません',
      port: input.lease?.port ?? input.port
    }
  }

  // 優先度 3: ポート競合（他プロセスがポート占有・非 pxpipe / squatter）
  if (input.isPortListening && !input.isProxyHealthy) {
    return {
      category: 'port-conflict',
      canAutoRecover: false,
      reason: `候補ポート (${input.port}) が他プロセスに占有されており pxpipe ではありません`,
      port: input.port
    }
  }

  // 優先度 4: 外部 API 障害（local proxy は健康だが外部 API 疎通不可）
  if (input.isProxyHealthy && input.isExternalApiReachable === false) {
    return {
      category: 'external-api-down',
      canAutoRecover: false,
      reason: 'pxpipe proxy は稼働中ですが、外部 API (Anthropic) への疎通が失われています',
      port: input.port
    }
  }

  // 優先度 5: 分類不能
  return {
    category: 'unknown',
    canAutoRecover: false,
    reason: '障害原因を特定できません（fail-safe: 自動操作せず現状維持）',
    port: input.port
  }
}

/**
 * 指数バックオフ付き自律復旧（最大試行回数計 3 回で停止・F9）。
 */
export async function attemptSelfHealing(opts: HealingOptions): Promise<HealingResult> {
  const maxAttempts = opts.maxAttempts ?? 3
  const backoff = opts.backoffMs ?? [1000, 2000]
  const log = opts.onLog ?? console.log

  if (!opts.incident.canAutoRecover) {
    log(`[pxpipeWatchdog] 自動復旧スキップ (${opts.incident.category}): ${opts.incident.reason}`)
    return {
      recovered: false,
      attempts: 0,
      reason: `復旧非対象 (${opts.incident.category})`
    }
  }

  log(`[pxpipeWatchdog] 自律復旧開始 (${opts.incident.category}): ${opts.incident.reason}`)

  let attempt = 0
  let lastError: Error | undefined

  while (attempt < maxAttempts) {
    attempt++
    log(`[pxpipeWatchdog] 復旧試行 ${attempt}/${maxAttempts}...`)
    try {
      const outcome = await opts.recoverFn()
      if (outcome.ok) {
        log(`[pxpipeWatchdog] 自律復旧成功 (試行: ${attempt}回目, URL: ${outcome.url})`)
        return {
          recovered: true,
          attempts: attempt,
          url: outcome.url
        }
      }
      lastError = outcome.error
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e))
    }

    if (attempt < maxAttempts) {
      const delay = backoff[attempt - 1] ?? 2000
      log(`[pxpipeWatchdog] 試行 ${attempt} 失敗 (${lastError?.message})。${delay}ms 待機後再試行...`)
      await new Promise((r) => setTimeout(r, delay))
    }
  }

  const failMsg = `最大試行回数 (${maxAttempts}回) に達しました。自律復旧を停止し degraded 状態へ移行します: ${lastError?.message ?? 'unknown'}`
  log(`[pxpipeWatchdog] ${failMsg}`)
  return {
    recovered: false,
    attempts: attempt,
    reason: failMsg
  }
}
