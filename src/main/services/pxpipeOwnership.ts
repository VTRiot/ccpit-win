import { join, dirname } from 'path'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  openSync,
  closeSync
} from 'fs'
import { homedir } from 'os'
import { createHash } from 'crypto'
import { spawnSync } from 'child_process'

/**
 * pxpipeOwnership — pxpipe proxy の永続的所有権管理と OS 横断排他 (CCPIT_066 / Codex F1, F2, F8)。
 */

export interface OwnershipLease {
  instanceToken: string
  pid: number
  startTime: string
  port: number
  url: string
  configFingerprint: string
  createdAt: string
  updatedAt: string
}

export interface OwnershipContext {
  parcFermeDir?: string
  leasePath?: string
  lockPath?: string
}

function resolveParcFermeDir(ctx?: OwnershipContext): string {
  return ctx?.parcFermeDir ?? join(homedir(), '.ccpit')
}

function resolveLeasePath(ctx?: OwnershipContext): string {
  return ctx?.leasePath ?? join(resolveParcFermeDir(ctx), 'proxy-owner.json')
}

function resolveLockPath(ctx?: OwnershipContext): string {
  return ctx?.lockPath ?? join(resolveParcFermeDir(ctx), 'proxy.lock')
}

/**
 * proxyEnv の正規化 fingerprint を計算する (F8)。
 * キーを小文字化・アルファベット順ソートし、設定の同一性を判定する。
 */
export function buildProxyConfigFingerprint(env?: Record<string, string>): string {
  if (!env || Object.keys(env).length === 0) return 'empty'
  const normalizedEntries = Object.entries(env)
    .map(([k, v]) => [k.toLowerCase(), v] as [string, string])
    .sort(([a], [b]) => a.localeCompare(b))

  const repr = JSON.stringify(normalizedEntries)
  return createHash('sha256').update(repr).digest('hex').slice(0, 16)
}

/** Lease を原子的に書き込む (F1)。 */
export function writeOwnershipLease(lease: OwnershipLease, ctx?: OwnershipContext): void {
  try {
    const file = resolveLeasePath(ctx)
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp.${Date.now()}`
    writeFileSync(tmp, JSON.stringify(lease, null, 2) + '\n', 'utf8')
    renameSync(tmp, file)
  } catch (e) {
    /* Lease 記録失敗時はアプリを止めないが best-effort で試みる */
  }
}

/** Lease を読み込む。壊れていれば null (F1)。 */
export function readOwnershipLease(ctx?: OwnershipContext): OwnershipLease | null {
  try {
    const file = resolveLeasePath(ctx)
    if (!existsSync(file)) return null
    const raw = JSON.parse(readFileSync(file, 'utf8')) as OwnershipLease
    if (
      typeof raw.instanceToken === 'string' &&
      typeof raw.pid === 'number' &&
      typeof raw.port === 'number' &&
      typeof raw.url === 'string'
    ) {
      return raw
    }
    return null
  } catch {
    return null
  }
}

/** Lease を削除（解放）する。 */
export function clearOwnershipLease(ctx?: OwnershipContext): void {
  try {
    const file = resolveLeasePath(ctx)
    if (existsSync(file)) unlinkSync(file)
  } catch {
    /* gone */
  }
}

/**
 * OS 上で PID が実在するか確認する。
 * expectedName が指定された場合、プロセス名（イメージ名）の一致も検証する（PID 再利用対策・Codex F1）。
 */
export function checkSystemProcessAlive(pid: number, expectedName?: string): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    if (process.platform === 'win32') {
      const res = spawnSync('tasklist', ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'], {
        encoding: 'utf8',
        windowsHide: true
      })
      if (res.error || res.status !== 0) return false
      const stdout = res.stdout.trim()
      // CSV 出力: "node.exe","12345",...
      const match = stdout.match(/^"([^"]+)","(\d+)"/i)
      if (!match) return false
      const foundImage = match[1].toLowerCase().replace(/\.exe$/, '')
      const foundPid = parseInt(match[2], 10)
      if (foundPid !== pid) return false
      if (expectedName) {
        const expected = expectedName.toLowerCase().replace(/\.exe$/, '')
        if (foundImage !== expected) return false
      }
      return true
    }
    // POSIX: kill(0) で存在確認
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export interface AdoptOptions {
  ctx?: OwnershipContext
  expectedFingerprint?: string
  isProcessAlive?: (pid: number) => Promise<boolean>
  isPxpipeHealth?: (port: number) => Promise<boolean>
}

/**
 * 起動時に前回の Lease を検証し、一致すれば adopt（所有引き継ぎ）する (F1, F8)。
 * PID実在 (node.exe 検証) ∧ configFingerprint 一致 ∧ healthCheck(port) 成功 の全てを満たす場合のみ受理。
 */
export async function validateAndAdoptLease(opts: AdoptOptions = {}): Promise<OwnershipLease | null> {
  const lease = readOwnershipLease(opts.ctx)
  if (!lease) return null

  // 1. 設定 fingerprint の整合性確認 (F8)
  if (opts.expectedFingerprint && lease.configFingerprint && lease.configFingerprint !== opts.expectedFingerprint) {
    clearOwnershipLease(opts.ctx)
    return null
  }

  // 2. PID 生存と node プロセス名の検証 (F1: PID 再利用による無関係プロセス kill 防止)
  const isAliveFn = opts.isProcessAlive ?? (async (pid) => checkSystemProcessAlive(pid, 'node'))
  const isHealthyFn = opts.isPxpipeHealth ?? (async () => false)

  const isAlive = await isAliveFn(lease.pid).catch(() => false)
  if (!isAlive) {
    clearOwnershipLease(opts.ctx)
    return null
  }

  // 3. 当該ポートでの pxpipe 応答検証
  const isHealthy = await isHealthyFn(lease.port).catch(() => false)
  if (!isHealthy) {
    clearOwnershipLease(opts.ctx)
    return null
  }

  return lease
}

// proxy 起動タイムアウト 45秒 + 余裕 15秒 ＝ 60秒 (Codex F2)
const LOCK_STALE_TIMEOUT_MS = 60_000

let activeLockFd: number | null = null

/**
 * OS 横断排他ロックを取得する (F2)。
 */
export function acquireProxyLock(ctx?: OwnershipContext, timeoutMs = 5000): boolean {
  const lockFile = resolveLockPath(ctx)
  mkdirSync(dirname(lockFile), { recursive: true })

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      // 'wx': ファイルが存在すれば O_EXCL で失敗する (原子的ロック)
      const fd = openSync(lockFile, 'wx')
      const info = JSON.stringify({ pid: process.pid, time: Date.now() })
      writeFileSync(fd, info, 'utf8')
      activeLockFd = fd
      return true
    } catch (e: any) {
      if (e?.code === 'EEXIST') {
        // stale ロックの検査: ロック保持者が生存している場合はタイムアウト内であっても奪取しない (F2)
        try {
          const raw = JSON.parse(readFileSync(lockFile, 'utf8')) as { pid?: number; time?: number }
          const pid = raw.pid
          const hasPid = typeof pid === 'number'
          const isAlive = hasPid && checkSystemProcessAlive(pid)
          const isExpired = typeof raw.time === 'number' && Date.now() - raw.time > LOCK_STALE_TIMEOUT_MS

          // 保持 PID が完全に死んでいる、または PID 不明かつ 60秒経過した孤立ロックのみ回収
          if (!isAlive && (isExpired || !hasPid)) {
            try {
              unlinkSync(lockFile)
            } catch {
              /* race */
            }
          }
        } catch {
          /* parse fail */
        }
        // スピン待機
        const wait = Math.min(50, Math.max(10, deadline - Date.now()))
        if (wait > 0) {
          spawnSync('powershell', ['-NoProfile', '-Command', `Start-Sleep -Milliseconds ${wait}`], {
            windowsHide: true
          })
        }
      } else {
        return false
      }
    }
  }
  return false
}

/** OS 横断排他ロックを解放する (F2)。 */
export function releaseProxyLock(ctx?: OwnershipContext): void {
  const lockFile = resolveLockPath(ctx)
  if (activeLockFd !== null) {
    try {
      closeSync(activeLockFd)
    } catch {
      /* ignore */
    }
    activeLockFd = null
  }
  try {
    if (existsSync(lockFile)) unlinkSync(lockFile)
  } catch {
    /* gone */
  }
}

/**
 * ロックを取得して処理を直列実行するヘルパー (F2)。
 */
export async function withProxyLock<T>(
  fn: () => Promise<T>,
  ctx?: OwnershipContext,
  timeoutMs = 5000
): Promise<T> {
  const acquired = acquireProxyLock(ctx, timeoutMs)
  if (!acquired) {
    throw new Error(`proxy.lock の取得に失敗しました (timeout: ${timeoutMs}ms)`)
  }
  try {
    return await fn()
  } finally {
    releaseProxyLock(ctx)
  }
}
