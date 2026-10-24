import {
  ensureProxy,
  adoptExistingProxy,
  pxpipeUrl,
  healthCheck,
  isProxyOwned,
  getActiveProxyLease,
  isPortListening,
  PXPIPE_PORT_CANDIDATES,
  type EnsureProxyResult
} from './pxpipeProxy'
import {
  setUpstreamUrl,
  getUpstreamUrl,
  isRelayRunning,
  restoreEnvSanitizeRelay
} from './pxpipeEnvSanitizeRelay'
import { detectLiveSessions, type DetectResult, type DetectedCc } from './sessionRegistry'
import type { OwnershipLease, OwnershipContext } from './pxpipeOwnership'
import {
  classifyIncident,
  attemptSelfHealing,
  type HealingResult
} from './pxpipeDiagnostics'

/**
 * pxpipeResilience — 中継経路レジリエンス（再起動後自律復旧・Watchdog オーケストレータ）
 * (CCPIT_066 / 2026-09-13 実事故対策)。
 */

export interface AutoEnsureUpstreamOptions {
  proxyEnv?: Record<string, string>
  ownershipContext?: OwnershipContext
  findLivePort?: () => Promise<number | null>
  adoptProxy?: () => Promise<OwnershipLease | null>
  detectSessions?: () => Promise<DetectResult>
  isPxpipeEnabledForCwd?: (cwd: string) => Promise<boolean>
  ensureProxyFn?: () => Promise<EnsureProxyResult>
  onLog?: (level: string, message: string) => void
}

async function defaultFindLivePort(): Promise<number | null> {
  for (const port of PXPIPE_PORT_CANDIDATES) {
    if (await healthCheck(port).catch(() => false)) return port
  }
  return null
}

/**
 * アプリ起動時 / 再起動時に、稼働中 CC セッションの要求に応じて upstream proxy を自動確保する (AC-1, AC-2)。
 */
export async function autoEnsureUpstream(
  opts: AutoEnsureUpstreamOptions = {}
): Promise<string | null> {
  const log = opts.onLog ?? console.log
  const findPort = opts.findLivePort ?? defaultFindLivePort
  const adopt = opts.adoptProxy ?? (() => adoptExistingProxy({ proxyEnv: opts.proxyEnv, ctx: opts.ownershipContext }))
  const detect = opts.detectSessions ?? detectLiveSessions
  const isEnabled = opts.isPxpipeEnabledForCwd ?? (async () => false)
  const doEnsure = opts.ensureProxyFn ?? ensureProxy

  try {
    // 1. 前回の Ownership Lease が生きていれば adopt (F1)
    const adopted = await adopt().catch(() => null)
    if (adopted) {
      log(`[pxpipeResilience] 既存の所有 proxy (PID: ${adopted.pid}, Port: ${adopted.port}) を adopt しました`)
    }

    // 2. 既に健全に動いている proxy があればそのポートを利用
    const livePort = await findPort().catch(() => null)
    if (livePort != null) {
      const url = pxpipeUrl(livePort)
      setUpstreamUrl(url)
      log(`[pxpipeResilience] 稼働中の upstream proxy を検出しました: ${url}`)
      return url
    }

    // 3. live CC セッションを検出 (再起動をまたぐ構成判定)
    const detected = await detect().catch(() => ({ ok: false as const, summary: { sessions: [] } }))
    const liveSessions = detected.ok ? detected.summary.sessions : []

    // 4. 各セッションの pxpipe 要否を判定
    const targetSessions: DetectedCc[] = []
    for (const s of liveSessions) {
      if (s.cwd && (await isEnabled(s.cwd).catch(() => false))) {
        targetSessions.push(s)
      }
    }

    // 5. pxpipe 利用中セッションが存在しない場合 → 起動しない (AC-2)
    if (targetSessions.length === 0) {
      log('[pxpipeResilience] pxpipe 有効な live セッションは存在しません（常駐 proxy は起動しません）')
      return null
    }

    // 6. pxpipe 利用中セッションが存在する場合 → upstream proxy を自動確保 (AC-1)
    const sessionPids = targetSessions.map((s) => s.pid).join(', ')
    log(`[pxpipeResilience] live セッション [PID: ${sessionPids}] のための upstream proxy を自動確保します...`)

    const ensured = await doEnsure().catch((e) => ({
      ok: false as const,
      reused: false,
      url: '',
      reason: e instanceof Error ? e.message : String(e)
    }))

    if (ensured.ok && 'url' in ensured && ensured.url) {
      setUpstreamUrl(ensured.url)
      log(`[pxpipeResilience] upstream proxy の自律確保に成功しました: ${ensured.url}`)
      return ensured.url
    }

    log(`[pxpipeResilience] upstream proxy 確保失敗（graceful degrade）: ${ensured.reason ?? 'unknown'}`)
    return null
  } catch (e) {
    log(`[pxpipeResilience] autoEnsureUpstream 例外（起動継続）: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

let watchdogTimer: NodeJS.Timeout | null = null
let isWatchdogRunning = false

export interface WatchdogOptions extends AutoEnsureUpstreamOptions {
  intervalMs?: number
  checkExternalApi?: () => Promise<boolean>
  isRelayRunningFn?: () => boolean
  restoreRelayFn?: () => Promise<{ restored: boolean; url?: string; reason?: string }>
  isPortListeningFn?: (port: number) => Promise<boolean>
}

/**
 * 周期的に中継経路（relay および upstream proxy）の死活を監視し、異常時に 5分類自己診断と上限付き自律復旧を実行する (AC-4, AC-5, F4, F5, F9)。
 */
export async function runWatchdogCycle(opts: WatchdogOptions = {}): Promise<HealingResult | null> {
  if (isWatchdogRunning) return null
  isWatchdogRunning = true
  const log = opts.onLog ?? console.log

  try {
    const detect = opts.detectSessions ?? detectLiveSessions
    const isEnabled = opts.isPxpipeEnabledForCwd ?? (async () => false)
    const findPort = opts.findLivePort ?? defaultFindLivePort
    const doEnsure = opts.ensureProxyFn ?? ensureProxy
    const checkRelay = opts.isRelayRunningFn ?? isRelayRunning
    const doRestoreRelay =
      opts.restoreRelayFn ?? (() => restoreEnvSanitizeRelay(async () => getUpstreamUrl()))
    const checkListening = opts.isPortListeningFn ?? isPortListening

    // 1. live セッションの有無と pxpipe 要否
    const detected = await detect().catch(() => ({ ok: false as const, summary: { sessions: [] } }))
    const liveSessions = detected.ok ? detected.summary.sessions : []
    let hasTargetSession = false
    for (const s of liveSessions) {
      if (s.cwd && (await isEnabled(s.cwd).catch(() => false))) {
        hasTargetSession = true
        break
      }
    }

    // 1b. relay 自身の死活点検と自律再確保 (AC-4)
    if (hasTargetSession && !checkRelay()) {
      log('[pxpipeWatchdog] 稼働中セッションが存在しますが relay が停止しています。前回ポートで再確保を試行します (AC-4)...')
      const restoreRes = await doRestoreRelay().catch((e) => ({
        restored: false,
        url: undefined as string | undefined,
        reason: e instanceof Error ? e.message : String(e)
      }))
      if (restoreRes.restored) {
        log(`[pxpipeWatchdog] relay の自律再確保に成功しました: ${restoreRes.url ?? ''}`)
      } else {
        log(`[pxpipeWatchdog] relay の自律再確保失敗: ${restoreRes.reason ?? 'unknown'}`)
      }
    }

    // 2. 現在の upstream の健康状態
    const livePort = await findPort().catch(() => null)
    const isProxyHealthy = livePort !== null
    const isOwned = isProxyOwned()
    const activeLease = getActiveProxyLease()
    const targetPort = activeLease?.port ?? livePort ?? PXPIPE_PORT_CANDIDATES[0]
    const portListening = await checkListening(targetPort).catch(() => false)

    // 外部 API 疎通状態（healthy proxy 時も必ず検査・F5）
    const externalApiOk = opts.checkExternalApi ? await opts.checkExternalApi().catch(() => true) : true

    // 異常なし（健全に稼働中 かつ 外部 API 疎通正常）
    if (isProxyHealthy && livePort != null && externalApiOk) {
      const currentUrl = pxpipeUrl(livePort)
      if (getUpstreamUrl() !== currentUrl) {
        setUpstreamUrl(currentUrl)
      }
      return null
    }

    // pxpipe 利用セッションがなく、自身も所有していない正常停止状態
    if (!hasTargetSession && !isOwned) {
      return null
    }

    // 3. 異常発生: 5分類診断を実施 (AC-5, AC-6, AC-7, F4, F5)
    const incident = classifyIncident({
      hasPxpipeConfig: hasTargetSession || isOwned,
      lease: activeLease,
      isProcessAlive: isProxyHealthy,
      isPortListening: portListening,
      isProxyHealthy: isProxyHealthy,
      isExternalApiReachable: externalApiOk,
      port: targetPort
    })

    log(`[pxpipeWatchdog] 経路異常を検知しました: 分類=${incident.category}, 概要=${incident.reason}`)

    // 4. 自律復旧を試行（外部 API 障害時は 0 回、最大 3 回で停止・F4, F5, F9）
    const result = await attemptSelfHealing({
      incident,
      recoverFn: async () => {
        const res = await doEnsure()
        if (res.ok && res.url) {
          setUpstreamUrl(res.url)
          return { ok: true, url: res.url }
        }
        return { ok: false, error: new Error(res.reason ?? 'proxy ensure failed') }
      },
      onLog: (_level, msg) => log(msg)
    })

    return result
  } catch (e) {
    log(`[pxpipeWatchdog] 監視サイクル例外: ${e instanceof Error ? e.message : String(e)}`)
    return null
  } finally {
    isWatchdogRunning = false
  }
}

/**
 * 中継経路監視 Watchdog を開始する (CCPIT_066 / F4, F5, F9)。
 */
export function startPxpipeWatchdog(opts: WatchdogOptions = {}): void {
  if (watchdogTimer) return
  const interval = opts.intervalMs ?? 30_000
  watchdogTimer = setInterval(() => {
    void runWatchdogCycle(opts)
  }, interval)
}

/**
 * 中継経路監視 Watchdog を停止する。
 */
export function stopPxpipeWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer)
    watchdogTimer = null
  }
}
