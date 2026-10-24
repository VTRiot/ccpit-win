/**
 * composeFileLock — 状態ファイル・合成台帳を、プロセスをまたいで安全に更新するための排他ロック（葉モジュール）。
 *
 * 設計（Plan r10 §4-4 / Codex r5 [4]・r6 [1]・r7 [1]・r9 [3]）:
 * - 取得は排他的作成の原始操作 `openSync(path, 'wx')`。存在確認と作成が 1 つの操作なので、2 者が同時に通ることは無い
 * - **時間による失効奪取はしない**。保持者が生きている間は何時間経っても奪えない（待って、上限で諦めて報告する）
 * - 奪えるのは、保持者のプロセスが存在しないと確かめたときだけ（pid が無い、または pid があるのに開始時刻が違う＝pid の再利用）。
 *   奪取は、ロックファイルを一意名へ rename する（1 者だけが成功する）→ 作り直す、の順
 * - 開始時刻を OS から引けない（null）ときは、生きている扱い（奪わない）。安全側
 * - 更新は「ロックの下で読む→更新→書込み直前に読んだ時の sha256 と同じことを再確認→tmp+rename」
 */

import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { dirname } from 'node:path'
import { sha256Hex } from './composeHash'

export interface LockHolder {
  pid: number
  /** そのプロセスの開始時刻（epoch ms）。引けないときは 0 */
  startedAt: number
  token: string
}

export interface FileLockDeps {
  pid?: number
  /** 自プロセスの開始時刻（epoch ms） */
  selfStartedAt?: number
  /** 他プロセスの開始時刻。引けなければ null（＝奪わない側に倒す） */
  processStartTime?: (pid: number) => number | null
  isAlive?: (pid: number) => boolean
  sleep?: (ms: number) => Promise<void>
  /** 待つ上限。超えたら奪わずに FileLockTimeoutError */
  maxWaitMs?: number
  pollMs?: number
}

export class FileLockTimeoutError extends Error {
  constructor(
    public readonly lockPath: string,
    public readonly holder: LockHolder | null
  ) {
    super(
      `別の CCPIT が更新中です（ロック保持者 pid=${holder?.pid ?? '不明'}）。終わるのを待ちましたが解けませんでした: ${lockPath}`
    )
    this.name = 'FileLockTimeoutError'
  }
}

const SELF_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000)
/** 開始時刻の食い違いをこの範囲までは同一プロセスとみなす（時計の丸め・取得方法の差） */
const START_TIME_TOLERANCE_MS = 5000

export function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM = 存在するが権限が無い（生きている）
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** OS から他プロセスの開始時刻（epoch ms）を引く。引けなければ null */
export function defaultProcessStartTime(pid: number): number | null {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `[DateTimeOffset]::new((Get-Process -Id ${Math.trunc(pid)}).StartTime).ToUnixTimeMilliseconds()`
        ],
        { encoding: 'utf-8', timeout: 5000, windowsHide: true }
      )
      const n = Number((r.stdout || '').trim())
      return r.status === 0 && Number.isFinite(n) && n > 0 ? n : null
    }
    const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(Math.trunc(pid))], {
      encoding: 'utf-8',
      timeout: 5000
    })
    const t = Date.parse((r.stdout || '').trim())
    return r.status === 0 && Number.isFinite(t) ? t : null
  } catch {
    return null
  }
}

function readHolder(lockPath: string): LockHolder | null {
  try {
    const raw = readFileSync(lockPath, 'utf-8')
    const j = JSON.parse(raw) as Partial<LockHolder>
    if (typeof j.pid === 'number' && typeof j.token === 'string') {
      return {
        pid: j.pid,
        startedAt: typeof j.startedAt === 'number' ? j.startedAt : 0,
        token: j.token
      }
    }
    return null
  } catch {
    return null
  }
}

/** 保持者が存在しないと確かめられたときだけ true（奪ってよい）。迷ったら false */
export function isHolderDead(holder: LockHolder, deps: FileLockDeps = {}): boolean {
  const isAlive = deps.isAlive ?? defaultIsAlive
  if (!isAlive(holder.pid)) return true
  // pid は存在する。pid の再利用かを、開始時刻で見る（引けなければ生きている扱い）
  if (holder.startedAt <= 0) return false
  const get = deps.processStartTime ?? defaultProcessStartTime
  const actual =
    holder.pid === (deps.pid ?? process.pid)
      ? (deps.selfStartedAt ?? SELF_STARTED_AT)
      : get(holder.pid)
  if (actual === null) return false
  return Math.abs(actual - holder.startedAt) > START_TIME_TOLERANCE_MS
}

export interface FileLockHandle {
  lockPath: string
  token: string
  release: () => void
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function acquireFileLock(
  lockPath: string,
  deps: FileLockDeps = {}
): Promise<FileLockHandle> {
  const pid = deps.pid ?? process.pid
  const startedAt = deps.selfStartedAt ?? SELF_STARTED_AT
  const sleep = deps.sleep ?? defaultSleep
  const maxWaitMs = deps.maxWaitMs ?? 15000
  const pollMs = deps.pollMs ?? 25
  const token = randomBytes(12).toString('hex')
  mkdirSync(dirname(lockPath), { recursive: true })
  const deadline = Date.now() + maxWaitMs
  let lastHolder: LockHolder | null = null

  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx')
      try {
        writeSync(fd, JSON.stringify({ pid, startedAt, token } satisfies LockHolder))
      } finally {
        closeSync(fd)
      }
      return {
        lockPath,
        token,
        release: () => {
          const cur = readHolder(lockPath)
          // 自分のトークンのときだけ消す（奪取された後に他者のロックを消さない）
          if (cur && cur.token === token) {
            try {
              unlinkSync(lockPath)
            } catch {
              /* ignore */
            }
          }
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }

    const holder = readHolder(lockPath)
    lastHolder = holder
    if (holder && isHolderDead(holder, deps)) {
      // 奪取: 一意名への rename は 1 者だけが成功する。失敗（ENOENT）したら他者が先に奪った
      const stale = `${lockPath}.stale-${token}`
      try {
        renameSync(lockPath, stale)
        try {
          rmSync(stale, { force: true })
        } catch {
          /* ignore */
        }
      } catch {
        /* 他者が先に奪った。再試行 */
      }
      continue
    }
    // holder が null（空・壊れ）は、作成直後で書込み前かもしれない。生きている扱いで待つ（奪わない）
    if (Date.now() >= deadline) throw new FileLockTimeoutError(lockPath, lastHolder)
    await sleep(pollMs)
  }
}

export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T> | T,
  deps: FileLockDeps = {}
): Promise<T> {
  const h = await acquireFileLock(lockPath, deps)
  try {
    return await fn()
  } finally {
    h.release()
  }
}

export interface AtomicJsonUpdateDeps extends FileLockDeps {
  /** 読んだ後・書く直前に呼ぶ（テストで割り込み書込みを再現する） */
  beforeWrite?: () => void
  /** 再確認で食い違ったときの再試行上限 */
  maxRetries?: number
}

/**
 * JSON ファイルの更新。ロックの下で「読む→mutate→書込み直前に sha256 を再確認→tmp+rename」。
 * ファイルが無い・空・壊れているときは `fallback()` を初期値にする（フェイルセーフ）。
 */
export async function atomicJsonUpdate<T>(
  path: string,
  mutate: (current: T) => T,
  fallback: () => T,
  deps: AtomicJsonUpdateDeps = {}
): Promise<T> {
  const maxRetries = deps.maxRetries ?? 5
  return withFileLock(
    `${path}.lock`,
    () => {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        let raw = ''
        let current: T
        if (existsSync(path)) {
          try {
            raw = readFileSync(path, 'utf-8')
            current = raw.trim() === '' ? fallback() : (JSON.parse(raw) as T)
          } catch {
            current = fallback()
          }
        } else {
          current = fallback()
        }
        const readSha = sha256Hex(raw)
        const next = mutate(current)
        deps.beforeWrite?.()
        // 書込み直前の再確認（ロックを使わない書き手への追加の防御）
        const nowRaw = existsSync(path) ? readFileSync(path, 'utf-8') : ''
        if (sha256Hex(nowRaw) !== readSha) continue
        mkdirSync(dirname(path), { recursive: true })
        const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
        writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8')
        renameSync(tmp, path)
        return next
      }
      throw new Error(`更新の競合が解けませんでした（再試行の上限）: ${path}`)
    },
    deps
  )
}
