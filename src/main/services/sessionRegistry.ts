/**
 * sessionRegistry — 起動中 CC セッションの列挙。
 *
 * データソース（実機検証で確定した唯一のライブ State ソース）:
 *   ~/.claude/sessions/<PID>.json — CC が起動中セッションごとにライブ更新する 1 行 JSON。
 *   主要フィールド: pid / sessionId / cwd / status(busy|waiting|idle) / updatedAt /
 *   statusUpdatedAt(新版のみ) / waitingFor(permission prompt 等) / procStart(一部版) /
 *   version / kind / entrypoint / name。
 *
 * 重要な仕様差（実装上の注意）:
 *   - statusUpdatedAt は 2.1.175+ のみ。旧版は updatedAt のみ → effectiveStatusTime で吸収。
 *   - 古い <PID>.json が残骸として残る → PID 生存確認必須（checkAlivePids）。
 *   - PID が別プロセスに再利用され得る → claude.exe の生存集合で照合し、
 *     非 claude プロセスは dead 扱い。厳密な再利用検出(procStart 照合)は次段(SM とセット)。
 *
 * 読み取り専用: sessions/*.json と tasklist を読むだけ。書込・kill はしない（それは sessionRestart）。
 * session.json は 1 行・件数少（PID 数）のため per-file キャッシュは持たない（skillFiringStats と異なる判断）。
 */

import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { readFile, readdir } from 'fs/promises'
import { join, normalize } from 'path'
import { homedir } from 'os'
import { enumClaudeProcs, parseResumeSessionId, type ProcEnumResult } from './procEnum'

export type SessionStatus = 'busy' | 'waiting' | 'idle' | 'unknown'

/** parseSessionJson の戻り（liveness 判定前）。 */
export interface ParsedSession {
  pid: number
  sessionId: string
  cwd: string
  status: SessionStatus
  name?: string
  version?: string
  kind?: string
  entrypoint?: string
  waitingFor?: string
  /** epoch ms。無ければ null */
  updatedAt: number | null
  /** epoch ms。新版のみ。無ければ null（updatedAt で代替） */
  statusUpdatedAt: number | null
  /** 一部版のみ。PID 再利用検出用（次段）。生値を保持 */
  procStart?: string
  sourceFile: string
}

/** liveness 確認済みのセッション情報。 */
export interface SessionInfo extends ParsedSession {
  /** tasklist による PID 生存（claude.exe として生存しているか） */
  alive: boolean
}

export interface ListSessionsOptions {
  /** 既定 ~/.claude/sessions */
  sessionsRoot?: string
  /** 指定時、cwd 一致（正規化/大小無視）のセッションのみ返す */
  filterCwd?: string
  /** true で PID 死亡セッションも含める（既定 false） */
  includeDead?: boolean
  /** テスト注入用。指定 PID 集合のうち生存している PID 集合を返す */
  aliveCheck?: (pids: number[]) => Promise<Set<number>>
}

/** ~/.claude/sessions */
export function getDefaultSessionsRoot(): string {
  return join(homedir(), '.claude', 'sessions')
}

/** statusUpdatedAt を優先し、無ければ updatedAt を使う（版差吸収）。両方無ければ null。 */
export function effectiveStatusTime(s: ParsedSession): number | null {
  return s.statusUpdatedAt ?? s.updatedAt
}

function normStatus(v: unknown): SessionStatus {
  if (v === 'busy' || v === 'waiting' || v === 'idle') return v
  return 'unknown'
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function strOrUndef(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/**
 * sessions/<PID>.json 1 ファイルの内容をパースする（純関数・破損/必須欠落は null）。
 * 必須: pid(number) / sessionId(non-empty string) / cwd(non-empty string)。
 */
export function parseSessionJson(content: string, sourceFile: string): ParsedSession | null {
  let rec: unknown
  try {
    rec = JSON.parse(content)
  } catch {
    return null
  }
  if (rec === null || typeof rec !== 'object') return null
  const r = rec as Record<string, unknown>

  const pid = numOrNull(r.pid)
  const sessionId = strOrUndef(r.sessionId)
  const cwd = strOrUndef(r.cwd)
  if (pid === null || !Number.isInteger(pid) || sessionId === undefined || cwd === undefined) {
    return null // fail-closed: 必須欠落
  }

  return {
    pid,
    sessionId,
    cwd,
    status: normStatus(r.status),
    name: strOrUndef(r.name),
    version: strOrUndef(r.version),
    kind: strOrUndef(r.kind),
    entrypoint: strOrUndef(r.entrypoint),
    waitingFor: strOrUndef(r.waitingFor),
    updatedAt: numOrNull(r.updatedAt),
    statusUpdatedAt: numOrNull(r.statusUpdatedAt),
    procStart: strOrUndef(r.procStart),
    sourceFile,
  }
}

/**
 * cwd 突合（Windows 正規化 + 大小無視 + 末尾セパレータ差吸収）。
 * filterCwd と sessionCwd が同一ディレクトリを指すか。
 */
export function cwdMatches(sessionCwd: string, filterCwd: string): boolean {
  const canon = (p: string): string =>
    normalize(p).replace(/[\\/]+$/, '').toLowerCase()
  return canon(sessionCwd) === canon(filterCwd)
}

/**
 * win32: tasklist で claude.exe の生存 PID 集合を取得し、与 PID と交差させる。
 * PID が claude.exe として生存していなければ dead（残骸 or 非 claude による再利用）。
 * POSIX: process.kill(pid, 0) でフォールバック（当面 MANX=win32 が主対象）。
 */
export function checkAlivePids(pids: number[]): Promise<Set<number>> {
  const want = new Set(pids)
  if (want.size === 0) return Promise.resolve(new Set())

  if (process.platform !== 'win32') {
    const alive = new Set<number>()
    for (const pid of want) {
      try {
        process.kill(pid, 0)
        alive.add(pid)
      } catch {
        /* dead */
      }
    }
    return Promise.resolve(alive)
  }

  return new Promise((resolve) => {
    let out = ''
    try {
      const tk = spawn(
        'tasklist',
        ['/FI', 'IMAGENAME eq claude.exe', '/FO', 'CSV', '/NH'],
        { windowsHide: true }
      )
      tk.stdout?.on('data', (d) => {
        out += d
      })
      tk.on('error', () => resolve(new Set()))
      tk.on('close', () => {
        const aliveAll = new Set<number>()
        // CSV 各行: "claude.exe","36700","Console","1","281,760 K"
        for (const line of out.split(/\r?\n/)) {
          const m = line.match(/^"[^"]*","(\d+)"/)
          if (m) aliveAll.add(Number(m[1]))
        }
        const alive = new Set<number>()
        for (const pid of want) if (aliveAll.has(pid)) alive.add(pid)
        resolve(alive)
      })
    } catch {
      resolve(new Set())
    }
  })
}

/**
 * sessions/*.json を列挙 → パース → 生存確認 → フィルタして SessionInfo[] を返す。
 * 既定では PID 死亡（残骸）を除外。filterCwd 指定で対象ノード/PJ を絞る。
 */
export async function listSessions(opts: ListSessionsOptions = {}): Promise<SessionInfo[]> {
  const root = opts.sessionsRoot ?? getDefaultSessionsRoot()
  if (!existsSync(root)) return []

  let files: string[] = []
  try {
    files = (await readdir(root)).filter((f) => f.toLowerCase().endsWith('.json'))
  } catch {
    return []
  }

  const parsed: ParsedSession[] = []
  for (const f of files) {
    const full = join(root, f)
    let content: string
    try {
      content = await readFile(full, 'utf-8')
    } catch {
      continue
    }
    const ps = parseSessionJson(content, full)
    if (ps !== null) parsed.push(ps)
  }

  const filtered = opts.filterCwd
    ? parsed.filter((p) => cwdMatches(p.cwd, opts.filterCwd as string))
    : parsed

  const aliveCheck = opts.aliveCheck ?? checkAlivePids
  const aliveSet = await aliveCheck(filtered.map((p) => p.pid))

  const infos: SessionInfo[] = filtered.map((p) => ({ ...p, alive: aliveSet.has(p.pid) }))
  return opts.includeDead ? infos : infos.filter((i) => i.alive)
}

// ─── CIM 全列挙による検出（fail-silent 根絶） ──────────────

/** live CC の解決度。resolved=sessions ファイルあり / resume-only=--resume sid のみ / unresolved=紐付け不能 */
export type CcResolution = 'resolved' | 'resume-only' | 'unresolved'

export interface DetectedCc {
  pid: number
  resolution: CcResolution
  sessionId?: string
  cwd?: string
  status?: SessionStatus
  name?: string
  waitingFor?: string
  createdAt?: string | null
}

export interface DetectSummary {
  total: number
  resolved: number
  resumeOnly: number
  unresolved: number
  sessions: DetectedCc[]
}

/** 判別共用体: 列挙失敗は ok:false（[] に潰して "0=green" にしない / Codex #5 fail-closed）。 */
export type DetectResult = { ok: true; summary: DetectSummary } | { ok: false; error: string }

export interface DetectOptions {
  sessionsRoot?: string
  enumFn?: () => Promise<ProcEnumResult>
}

/**
 * live な claude.exe を CIM で全列挙し、各 pid を sessions/<pid>.json → --resume CommandLine →
 * 未解決 の優先で分類する。全数検出（見落としゼロ）が目的。列挙失敗は fail-closed。
 */
export async function detectLiveSessions(opts: DetectOptions = {}): Promise<DetectResult> {
  const enumFn = opts.enumFn ?? enumClaudeProcs
  const e = await enumFn()
  if (!e.ok) return { ok: false, error: e.error }

  const root = opts.sessionsRoot ?? getDefaultSessionsRoot()
  const sessions: DetectedCc[] = []
  for (const p of e.procs) {
    const sf = join(root, `${p.pid}.json`)
    let resolved: ParsedSession | null = null
    if (existsSync(sf)) {
      try {
        resolved = parseSessionJson(await readFile(sf, 'utf-8'), sf)
      } catch {
        resolved = null
      }
    }
    if (resolved) {
      sessions.push({
        pid: p.pid,
        resolution: 'resolved',
        sessionId: resolved.sessionId,
        cwd: resolved.cwd,
        status: resolved.status,
        name: resolved.name,
        waitingFor: resolved.waitingFor,
        createdAt: p.createdAt
      })
      continue
    }
    const sid = parseResumeSessionId(p.commandLine)
    if (sid) {
      sessions.push({ pid: p.pid, resolution: 'resume-only', sessionId: sid, createdAt: p.createdAt })
      continue
    }
    sessions.push({ pid: p.pid, resolution: 'unresolved', createdAt: p.createdAt })
  }

  return {
    ok: true,
    summary: {
      total: sessions.length,
      resolved: sessions.filter((s) => s.resolution === 'resolved').length,
      resumeOnly: sessions.filter((s) => s.resolution === 'resume-only').length,
      unresolved: sessions.filter((s) => s.resolution === 'unresolved').length,
      sessions
    }
  }
}
