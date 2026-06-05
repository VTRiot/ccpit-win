import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

/**
 * marshalLauncher — Marshal Tier（外部 Codex adversarial-review）の起動と integrity 制御。
 *
 * 背景（PIKES §5-15-9 / Marshal F2）: Marshal launcher が integrity 制御なしで可変コード
 * （codex-companion.mjs）を実行するのは Protocol 自体の穴。本モジュールは:
 *  - companion を semver 最大解決（不在は §5-15-8 フォールバック＝エラーではない）
 *  - SHA-256 hash を pin 記録/照合（mismatch は fail-closed エラー）
 *  - 出力を schema 検証（verdict/summary/findings 必須、不正は fail-closed）
 *  - 生 JSON（防御層1）+ meta（resolved path/hash/version/ts/scope）を連番保全
 *  - 「不在（absence）」と「integrity/schema/spawn 失敗（failure）」を明確に区別する
 *
 * electron 非依存（os.homedir 既定、ディレクトリは引数で上書き可）。純関数を分離し spawn を
 * 注入可能にしてテストする。
 */

export interface CompanionResolution {
  entry: string
  version: string
}

export interface ReviewFinding {
  severity?: string
  title?: string
  body?: string
  [k: string]: unknown
}

export interface ReviewResult {
  verdict: string
  summary: string
  findings: ReviewFinding[]
  [k: string]: unknown
}

export type MarshalStatus =
  | 'ok'
  | 'absent'
  | 'integrity_failure'
  | 'schema_failure'
  | 'spawn_failure'
  | 'parse_failure'

export interface MarshalOutcome {
  status: MarshalStatus
  result?: ReviewResult
  rawPath?: string
  metaPath?: string
  version?: string
  hash?: string
  reason?: string
}

export interface PinStore {
  [version: string]: string
}

/** spawn を注入可能にする（テストで実 node を起動しないため）。async で main event loop を塞がない。 */
export type SpawnFn = (
  entry: string,
  args: string[]
) => Promise<{ status: number | null; stdout: string; stderr: string }>

/** dotted semver の数値比較（prerelease は無視、a<b: 負 / a==b: 0 / a>b: 正） */
export function compareSemver(a: string, b: string): number {
  const pa = a
    .split('-')[0]
    .split('.')
    .map((x) => parseInt(x, 10) || 0)
  const pb = b
    .split('-')[0]
    .split('.')
    .map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** 既定の codex プラグインキャッシュディレクトリ */
export function defaultCodexCacheDir(): string {
  return join(homedir(), '.claude', 'plugins', 'cache', 'openai-codex', 'codex')
}

/**
 * codex-companion.mjs を semver 最大で解決する。存在しなければ null（＝不在、フォールバック対象）。
 * 最大版に entry が無ければ次点を試す（壊れた版をスキップ）。
 */
export function resolveCompanion(codexCacheDir: string): CompanionResolution | null {
  if (!existsSync(codexCacheDir)) return null
  let versions: string[]
  try {
    versions = readdirSync(codexCacheDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((n) => /^\d+\.\d+\.\d+/.test(n))
  } catch {
    return null
  }
  if (!versions.length) return null
  versions.sort((x, y) => compareSemver(y, x)) // 降順
  for (const v of versions) {
    const entry = join(codexCacheDir, v, 'scripts', 'codex-companion.mjs')
    if (existsSync(entry)) return { entry, version: v }
  }
  return null
}

/** ファイルの SHA-256（hex）。 */
export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function loadPinStore(pinPath: string): PinStore {
  const r = loadPinStoreStrict(pinPath)
  return 'store' in r ? r.store : {}
}

/**
 * pin store を厳密読込する（Marshal 成果物3-F1）。
 *  - ファイル不在 → {store:{}}（TOFU 初回として正常）
 *  - 存在するが parse 不能/オブジェクトでない → {error}（fail-closed。改竄/破損の疑い）
 * 「不在」と「破損」を区別しないと、改竄された pin ファイルが TOFU 再開で素通りする。
 */
/** SHA-256 hex（64 桁小文字）の形式判定 */
export function isSha256Hex(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
}

export function loadPinStoreStrict(pinPath: string): { store: PinStore } | { error: string } {
  if (!existsSync(pinPath)) return { store: {} }
  let text: string
  try {
    text = readFileSync(pinPath, 'utf-8')
  } catch (e) {
    return {
      error: `pin store 読込不能（fail-closed）: ${e instanceof Error ? e.message : String(e)}`
    }
  }
  let obj: unknown
  try {
    obj = JSON.parse(text)
  } catch (e) {
    return {
      error: `pin store parse 不能（fail-closed）: ${e instanceof Error ? e.message : String(e)}`
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { error: 'pin store が不正（オブジェクトでない、fail-closed）' }
  }
  // 各エントリの値を厳密検証（Marshal 成果物3-F1 round2: 空文字/null/false 等の無効値が
  // TOFU 再開に化けるのを防ぐ。キーは version 文字列、値は 64 桁小文字 hex SHA-256）。
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (!isSha256Hex(v)) {
      return { error: `pin store の値が不正（fail-closed）: ${k}=${JSON.stringify(v)}` }
    }
  }
  return { store: obj as PinStore }
}

/** pin store を atomic（tmp→rename）で保存。失敗は呼び出し側で fail-closed 扱いにする。 */
export function savePinStore(pinPath: string, store: PinStore): void {
  mkdirSync(join(pinPath, '..'), { recursive: true })
  const tmp = `${pinPath}.tmp`
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8')
  renameSync(tmp, pinPath)
}

/**
 * hash の integrity 判定（TOFU: trust-on-first-use）。
 *  - pin 未記録 → ok かつ firstUse=true（呼び出し側で pin を記録する）
 *  - pin 一致 → ok
 *  - pin 不一致 → fail-closed（改竄/差し替えの疑い）
 */
export function checkIntegrity(
  version: string,
  hash: string,
  store: PinStore
): { ok: boolean; firstUse: boolean; reason?: string } {
  // truthiness でなく hasOwn で判定（Marshal 成果物3-F1 round2: 空値が TOFU に化けるのを防ぐ）。
  if (!Object.prototype.hasOwnProperty.call(store, version)) {
    return { ok: true, firstUse: true }
  }
  const pinned = store[version]
  if (!isSha256Hex(pinned)) {
    return { ok: false, firstUse: false, reason: `pinned value invalid for version ${version}` }
  }
  if (pinned === hash) return { ok: true, firstUse: false }
  return {
    ok: false,
    firstUse: false,
    reason: `companion hash mismatch (version ${version}): pinned ${pinned.slice(0, 12)}… != actual ${hash.slice(0, 12)}…`
  }
}

/**
 * adversarial-review の出力 schema 検証（防御層: 不正出力で誤判定しないため fail-closed）。
 * 構造を厳密に検証する（Marshal 成果物3-F4）: verdict 非空文字列・summary 文字列・findings は
 * object の配列で各要素に severity/title（文字列）必須。verdict の enum は codex 側契約の
 * 揺れを誤って弾かないため非空文字列に留める（過剰 fail-closed=正当レビュー拒否を避ける）。
 */
export function validateReviewSchema(obj: unknown): { ok: boolean; reason?: string } {
  if (!obj || typeof obj !== 'object') return { ok: false, reason: 'result is not an object' }
  const o = obj as Record<string, unknown>
  if (typeof o.verdict !== 'string' || !o.verdict) return { ok: false, reason: 'verdict missing' }
  if (typeof o.summary !== 'string') return { ok: false, reason: 'summary missing' }
  if (!Array.isArray(o.findings)) return { ok: false, reason: 'findings is not an array' }
  for (let i = 0; i < o.findings.length; i++) {
    const f = o.findings[i]
    if (!f || typeof f !== 'object' || Array.isArray(f)) {
      return { ok: false, reason: `findings[${i}] is not an object` }
    }
    const fr = f as Record<string, unknown>
    if (typeof fr.severity !== 'string' || !fr.severity) {
      return { ok: false, reason: `findings[${i}].severity missing` }
    }
    if (typeof fr.title !== 'string' || !fr.title) {
      return { ok: false, reason: `findings[${i}].title missing` }
    }
  }
  return { ok: true }
}

/**
 * companion の stdout から result を抽出する。--json は通常 `{...,"result":{...},"rawOutput":...}`
 * を返す。先頭ログ等が混ざる場合に備え、JSON.parse 失敗時は verdict を含む最後の {…} を探す。
 */
export function extractResult(stdout: string): ReviewResult | null {
  const tryParse = (s: string): ReviewResult | null => {
    try {
      const p = JSON.parse(s)
      if (p && typeof p === 'object') {
        if (p.result && typeof p.result === 'object') return p.result as ReviewResult
        if (typeof p.verdict === 'string') return p as ReviewResult
      }
    } catch {
      /* fallthrough */
    }
    return null
  }
  const whole = tryParse(stdout)
  if (whole) return whole
  // ログ混在: 最初の '{' から末尾までを順に試す
  const first = stdout.indexOf('{')
  if (first >= 0) {
    const sub = tryParse(stdout.slice(first))
    if (sub) return sub
  }
  return null
}

/** dir 内の codex_review_raw_NN.json の次の連番（01 始まり） */
export function nextReviewIndex(dir: string): number {
  if (!existsSync(dir)) return 1
  let max = 0
  try {
    for (const f of readdirSync(dir)) {
      const m = /^codex_review_raw_(\d+)\.json$/.exec(f)
      if (m) max = Math.max(max, parseInt(m[1], 10))
    }
  } catch {
    /* ignore */
  }
  return max + 1
}

export interface PersistMeta {
  version: string
  hash: string
  entry: string
  scope: string
  focus: string
  timestamp: string
  index: number
}

/** 生 JSON（防御層1）+ meta を連番で保全し、書いたパスを返す。 */
export function persistReview(
  dir: string,
  rawStdout: string,
  meta: Omit<PersistMeta, 'index'>
): { rawPath: string; metaPath: string; index: number } {
  mkdirSync(dir, { recursive: true })
  const index = nextReviewIndex(dir)
  const nn = String(index).padStart(2, '0')
  const rawPath = join(dir, `codex_review_raw_${nn}.json`)
  const metaPath = join(dir, `codex_review_meta_${nn}.json`)
  writeFileSync(rawPath, rawStdout, 'utf-8')
  writeFileSync(metaPath, JSON.stringify({ ...meta, index }, null, 2), 'utf-8')
  return { rawPath, metaPath, index }
}

/** spawnSync の既定タイムアウト（Marshal 成果物3-F3: main process 無限ハング防止）。 */
export const DEFAULT_MARSHAL_TIMEOUT_MS = 600_000

export interface RunMarshalOptions {
  scope: string
  focus: string
  outDir: string
  timestamp: string
  codexCacheDir?: string
  pinPath?: string
  spawnFn?: SpawnFn
  timeoutMs?: number
  /**
   * 既存 pin がある状態で未登録の新バージョンを enrollment（pin 記録）して実行することを許可する
   * （Marshal 成果物3-F round5: 版置換攻撃対策）。既定 false＝初回 bootstrap 以外の新版は fail-closed。
   * 正規アップデートは明示的な信頼フロー（true）でのみ登録する。
   */
  enrollNewVersions?: boolean
}

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024

/**
 * 子プロセスツリー全体を kill し、kill 完了まで待つ（Marshal 成果物3-F2 round4）。
 * win32 は taskkill /T の close/error を待つ（fire-and-forget だと孫 kill 前に gate 解放するため）。
 * POSIX は detached のプロセスグループへ SIGKILL（同期的）。
 */
function killTree(child: ReturnType<typeof spawn>): Promise<void> {
  const pid = child.pid
  if (pid == null) return Promise.resolve()
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      try {
        const tk = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
        tk.on('close', () => resolve())
        tk.on('error', () => {
          try {
            child.kill('SIGKILL')
          } catch {
            /* gone */
          }
          resolve()
        })
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          /* gone */
        }
        resolve()
      }
    })
  }
  // POSIX: グループ全体に SIGKILL
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      /* gone */
    }
  }
  return Promise.resolve()
}

/**
 * 非同期 spawn（Marshal 成果物3-F2: spawnSync は main event loop を分単位で塞ぐため）。
 * timeout/出力上限超過ではプロセスツリーを kill し、実際の 'close'（＝終了）を待ってから resolve する。
 * これにより in-flight gate は cleanup 完了まで維持され、孫プロセスも巻き取られる（round3）。
 */
export function makeDefaultSpawn(timeoutMs: number): SpawnFn {
  return (entry, args) =>
    new Promise((resolve) => {
      const child = spawn('node', [entry, ...args], {
        windowsHide: true,
        // POSIX: 自前プロセスグループにして tree kill 可能に。win32 は taskkill /T を使う。
        detached: process.platform !== 'win32'
      })
      let stdout = ''
      let stderr = ''
      let killReason: string | null = null
      let killPromise: Promise<void> | null = null
      let resolved = false
      const finish = async (status: number | null): Promise<void> => {
        if (resolved) return
        resolved = true
        clearTimeout(to)
        // kill を起動済みなら、その完了（win32 taskkill の close 含む）まで待ってから resolve。
        // これで in-flight gate は孫プロセス cleanup 完了まで維持される（round4）。
        if (killPromise) {
          try {
            await killPromise
          } catch {
            /* best-effort */
          }
        }
        resolve({ status, stdout, stderr: killReason ? `${stderr}\n${killReason}` : stderr })
      }
      // kill を起動するが resolve はしない（'close' を待つ＝プロセス終了まで gate を維持）。
      const triggerKill = (reason: string): void => {
        if (killReason) return
        killReason = reason
        killPromise = killTree(child)
      }
      const to = setTimeout(() => triggerKill(`[timeout ${timeoutMs}ms]`), timeoutMs)
      child.stdout?.on('data', (d) => {
        stdout += d
        if (stdout.length > MAX_OUTPUT_BYTES) triggerKill('[stdout overflow]')
      })
      child.stderr?.on('data', (d) => {
        stderr += d
        if (stderr.length > MAX_OUTPUT_BYTES) triggerKill('[stderr overflow]')
      })
      // spawn 自体の失敗（ENOENT 等）は close が来ないので即 finish。
      child.on('error', (e) => {
        if (!killReason) killReason = e.message
        void finish(null)
      })
      // 正常/kill いずれも 'close'（プロセス完全終了）を待って resolve。kill 時は status=null。
      child.on('close', (code) => void finish(killReason ? null : code))
    })
}

/**
 * Marshal adversarial-review を起動し integrity/schema を検証して結果を保全する。
 * 戻り値の status で「不在（absence＝§5-15-8 フォールバック）」と各種「失敗（failure）」を区別する。
 * 失敗系（integrity/schema/spawn/parse）は fail-closed: result を返さず呼び出し側で停止/エスカレートさせる。
 */
export async function runMarshalReview(opts: RunMarshalOptions): Promise<MarshalOutcome> {
  const cacheDir = opts.codexCacheDir ?? defaultCodexCacheDir()
  const pinPath = opts.pinPath ?? join(homedir(), '.ccpit', 'marshal-companion-pin.json')
  const spawnFn = opts.spawnFn ?? makeDefaultSpawn(opts.timeoutMs ?? DEFAULT_MARSHAL_TIMEOUT_MS)

  const resolved = resolveCompanion(cacheDir)
  if (!resolved) {
    return {
      status: 'absent',
      reason: `codex-companion 不在（${cacheDir}）。§5-15-8 フォールバック対象。`
    }
  }

  const hash = sha256File(resolved.entry)
  // pin store 破損は fail-closed（Marshal 成果物3-F1: 不在=TOFU と破損=改竄疑いを区別）
  const loaded = loadPinStoreStrict(pinPath)
  if ('error' in loaded) {
    return { status: 'integrity_failure', version: resolved.version, hash, reason: loaded.error }
  }
  const store = loaded.store
  const integ = checkIntegrity(resolved.version, hash, store)
  if (!integ.ok) {
    return { status: 'integrity_failure', version: resolved.version, hash, reason: integ.reason }
  }
  if (integ.firstUse) {
    // 版置換対策（Marshal 成果物3-F round5）: 既存 pin がある状態で未登録の新バージョンを
    // 自動信頼しない。空 store（初回 bootstrap）か、明示的 enrollment 許可時のみ pin 記録して実行。
    const storeNonEmpty = Object.keys(store).length > 0
    if (storeNonEmpty && !opts.enrollNewVersions) {
      return {
        status: 'integrity_failure',
        version: resolved.version,
        hash,
        reason: `未登録の新バージョン ${resolved.version} を自動実行しません（既存 pin あり、版置換の疑い）。正規アップデートは明示的 enrollment が必要。`
      }
    }
    // 初回 pin 記録の失敗も fail-closed（記録できないなら以後の照合が成立しないため実行しない）
    store[resolved.version] = hash
    try {
      savePinStore(pinPath, store)
    } catch (e) {
      return {
        status: 'integrity_failure',
        version: resolved.version,
        hash,
        reason: `pin 記録失敗（fail-closed）: ${e instanceof Error ? e.message : String(e)}`
      }
    }
  }

  const args = ['adversarial-review', '--wait', '--json', '--scope', opts.scope, opts.focus]
  let spawned: { status: number | null; stdout: string; stderr: string }
  try {
    spawned = await spawnFn(resolved.entry, args)
  } catch (e) {
    return {
      status: 'spawn_failure',
      version: resolved.version,
      hash,
      reason: e instanceof Error ? e.message : String(e)
    }
  }
  if (spawned.status !== 0 || !spawned.stdout.trim()) {
    return {
      status: 'spawn_failure',
      version: resolved.version,
      hash,
      reason: `node 終了コード ${spawned.status}${spawned.stderr ? `: ${spawned.stderr.slice(0, 300)}` : ''}`
    }
  }

  const result = extractResult(spawned.stdout)
  if (!result) {
    return {
      status: 'parse_failure',
      version: resolved.version,
      hash,
      reason: 'stdout から result を抽出できない'
    }
  }
  const schema = validateReviewSchema(result)
  if (!schema.ok) {
    return { status: 'schema_failure', version: resolved.version, hash, reason: schema.reason }
  }

  const { rawPath, metaPath } = persistReview(opts.outDir, spawned.stdout, {
    version: resolved.version,
    hash,
    entry: resolved.entry,
    scope: opts.scope,
    focus: opts.focus,
    timestamp: opts.timestamp
  })

  return { status: 'ok', result, rawPath, metaPath, version: resolved.version, hash }
}
