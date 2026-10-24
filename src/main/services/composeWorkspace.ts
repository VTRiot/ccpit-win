/**
 * composeWorkspace — 合成モードの作業場の作成・権限・起動計画（Plan r10 §4-2）。
 *
 * - 作業場 `~/.ccpit/compose/<skill>-<stamp>/` に、golden（git の指定コミットの blob）の ja・en の skill 一式の写しと
 *   `snapshot.json`（全ファイルの sha256 一覧。この sha256 が提案 frontmatter の `compose_snapshot`）を作る
 * - 合成 CC は作業場だけに書く。作業場の `.claude/settings.local.json` に、作業場の外（手元の ~/.claude・golden のリポジトリ・
 *   ~/.ccpit の状態ファイル等）への Edit・Write を拒否する規則を CCPIT が書く。**利用者の ~/.claude/settings.json は触らない**
 * - 起動計画: cwd＝作業場・許可モードは `acceptEdits` に固定・Bypass の入力は拒否する
 * - 同じ skill の合成は同時に 1 つだけ（`active-<skill>.json`。保持者の CCPIT が死んでいれば引き継ぐ）
 */

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  copyFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { contentHash, sha256Hex } from './composeHash'
import { isHolderDead } from './composeFileLock'
import {
  buildGuardRoots,
  makeBaseline,
  takeInventory,
  type Baseline,
  type Inventory,
  type InventoryItem,
  type InventoryRoot
} from './composeInventory'
import { serializeSnapshot, type ComposePaths, type SnapshotDoc } from './composeLedger'
import {
  DIALOGUE_FILE_ENV,
  DIALOGUE_PROMPT_ENV,
  DIALOGUE_PROMPT_FLAG,
  PERMISSION_MODE_VALUES,
  isPrintableAscii,
  isSafeFlagToken,
  type DialogueLaunchPlan
} from './proposalDialogueLaunch'

const GOLDEN_SKILLS = (lang: 'ja' | 'en', skill: string): string =>
  `ccpit/golden/common/${lang}/skills/${skill}`

/** 運搬・照合の対象にしないもの（`.bak*`・OS/VCS の残骸） */
const SKIP_SEG =
  /^(?:\.git|node_modules|\.DS_Store|Thumbs\.db)$|(?:\.bak|\.old|\.orig|\.tmp|\.swp)(?:[.\-_].*)?$|~$/i

// ---- golden の読み取り（git の指定コミットの blob。作業ツリーの未コミット変更を見ない） ----

/**
 * golden の reader。`list` の `[]`・`read` の `null` は「golden に確かに無い」（skill が基準のコミットに無い・
 * ファイルが無い）だけを意味する。git が読めなかったとき（起動失敗・時間切れ・シグナル・出力溢れ・無効な ref・
 * リポジトリでない）は `GoldenReadError` を投げ、呼び出し側が「無い」と取り違えられないようにする（CCPIT_L0_007）。
 */
export interface GoldenReader {
  list: (lang: 'ja' | 'en', skill: string) => string[]
  read: (lang: 'ja' | 'en', skill: string, relPath: string) => Buffer | null
}

export type GoldenReadFailureKind =
  | 'spawn-error'
  | 'timeout'
  | 'signal'
  | 'output-overflow'
  | 'exit'
  | 'inconsistent'

/** 利用者に出る文面の頭。画面と試験はこれで「git から読めなかった」と見分ける */
export const GOLDEN_READ_ERROR_HEAD = 'golden を git から読めませんでした'

/** 標準エラーの先頭を理由に載せる長さ（メッセージが画面で読める長さ。値の根拠ではない） */
const STDERR_HEAD_CHARS = 200

/**
 * 1 回の git 呼び出しの待ち時間の上限（ミリ秒）。旧は無期限で、止まった git がメインプロセスを塞いだ。
 * 【仮置き】測る前の値。CCPIT_L0_007 の W4（負荷の下の実測）の最大から導いて更新する。
 */
export const GIT_READ_TIMEOUT_MS = 30_000

/** `list`（ls-tree の出力）の上限。旧は Node の既定（1 MiB）で、溢れは黙って「失敗＝空」になっていた。値は旧と同じにして、溢れは失敗として報告する */
const LIST_MAX_BUFFER_BYTES = 1024 * 1024

/** `read`（blob の中身）の上限（旧と同じ） */
const READ_MAX_BUFFER_BYTES = 64 * 1024 * 1024

export class GoldenReadError extends Error {
  readonly op: 'list' | 'read'
  readonly lang: 'ja' | 'en'
  readonly skill: string
  readonly relPath: string | null
  readonly kind: GoldenReadFailureKind
  /** どの git の呼び出しで失敗したか（read は cat-file の後に、無いことの確認の ls-tree を呼ぶ） */
  readonly via: 'ls-tree' | 'cat-file'
  readonly exitCode: number | null
  readonly signal: string | null
  readonly errorCode: string | null
  readonly stderrHead: string

  constructor(d: {
    op: 'list' | 'read'
    lang: 'ja' | 'en'
    skill: string
    relPath?: string
    kind: GoldenReadFailureKind
    via: 'ls-tree' | 'cat-file'
    exitCode: number | null
    signal: string | null
    errorCode: string | null
    stderrHead: string
  }) {
    const target = `${d.lang}/${d.skill}${d.relPath ? `/${d.relPath}` : ''}`
    const parts = [`${d.op} ${target}`, `git ${d.via}`, d.kind]
    if (d.exitCode !== null) parts.push(`exit=${d.exitCode}`)
    if (d.signal) parts.push(`signal=${d.signal}`)
    if (d.errorCode) parts.push(`error=${d.errorCode}`)
    if (d.stderrHead) parts.push(`stderr=${d.stderrHead}`)
    super(
      `${GOLDEN_READ_ERROR_HEAD}（${parts.join(' / ')}）。もう一度実行してください。続くときは golden のリポジトリの状態を確かめてください`
    )
    // TS のターゲットによっては Error の継承で instanceof が壊れるため、明示する
    Object.setPrototypeOf(this, GoldenReadError.prototype)
    this.name = 'GoldenReadError'
    this.op = d.op
    this.lang = d.lang
    this.skill = d.skill
    this.relPath = d.relPath ?? null
    this.kind = d.kind
    this.via = d.via
    this.exitCode = d.exitCode
    this.signal = d.signal
    this.errorCode = d.errorCode
    this.stderrHead = d.stderrHead
  }
}

/** git の呼び出し 1 回の結果（`spawnSync` の戻りのうち、判定に使う部分） */
export interface GitRunResult {
  status: number | null
  signal: string | null
  error?: (Error & { code?: string }) | undefined
  stdout?: Buffer | string | null | undefined
  stderr?: Buffer | string | null | undefined
}

export interface GitRunOptions {
  cwd: string
  encoding: 'utf-8' | 'buffer'
  maxBuffer: number
  timeout: number
}

export interface GoldenReaderDeps {
  /** git の実行ファイル（既定 `git`）。試験が「起動できない git」を作るためのもの */
  gitCommand?: string
  /** 実行ファイルの直後に足す引数（試験が、止まる実プロセスを作るためのもの） */
  gitPrefixArgs?: string[]
  /** 1 回の git の待ち時間の上限（既定 `GIT_READ_TIMEOUT_MS`） */
  timeoutMs?: number
  /** 出力の上限（既定は定数。試験が溢れを実物で作るためのもの） */
  maxBuffer?: { list?: number; read?: number }
  /** `spawnSync` の差し替え（試験がシグナル・時間切れを決定的に作るためのもの） */
  spawn?: (command: string, args: string[], options: GitRunOptions) => GitRunResult
}

const headOf = (b: Buffer | string | null | undefined): string => {
  // 起動に失敗した spawnSync は stdout・stderr を null でなく undefined で返すことがある（実測）
  if (b === null || b === undefined) return ''
  const text = (typeof b === 'string' ? b : b.toString('utf-8')).replace(/\s+/g, ' ').trim()
  return text.slice(0, STDERR_HEAD_CHARS)
}

export function makeGitGoldenReader(
  repoDir: string,
  baseRef = 'HEAD',
  deps: GoldenReaderDeps = {}
): GoldenReader {
  const command = deps.gitCommand ?? 'git'
  const prefix = deps.gitPrefixArgs ?? []
  const timeout = deps.timeoutMs ?? GIT_READ_TIMEOUT_MS
  const listMax = deps.maxBuffer?.list ?? LIST_MAX_BUFFER_BYTES
  const readMax = deps.maxBuffer?.read ?? READ_MAX_BUFFER_BYTES
  const run = (args: string[], encoding: 'utf-8' | 'buffer', maxBuffer: number): GitRunResult => {
    const options: GitRunOptions = { cwd: repoDir, encoding, maxBuffer, timeout }
    const a = [...prefix, ...args]
    if (deps.spawn) return deps.spawn(command, a, options)
    return spawnSync(command, a, options as never) as unknown as GitRunResult
  }
  /** 失敗なら理由つきの GoldenReadError。成功（終了コード 0・エラーもシグナルも無い）なら null */
  const failureOf = (
    r: GitRunResult,
    ctx: {
      op: 'list' | 'read'
      lang: 'ja' | 'en'
      skill: string
      relPath?: string
      via: 'ls-tree' | 'cat-file'
    }
  ): GoldenReadError | null => {
    let kind: GoldenReadFailureKind
    if (r.error) {
      const code = r.error.code ?? ''
      kind =
        code === 'ETIMEDOUT' ? 'timeout' : code === 'ENOBUFS' ? 'output-overflow' : 'spawn-error'
    } else if (r.signal) {
      kind = 'signal'
    } else if (r.status === 0) {
      return null
    } else {
      kind = r.status === null ? 'spawn-error' : 'exit'
    }
    return new GoldenReadError({
      ...ctx,
      kind,
      exitCode: r.status,
      signal: r.signal ?? null,
      errorCode: r.error?.code ?? null,
      stderrHead: headOf(r.stderr)
    })
  }
  return {
    list: (lang, skill) => {
      const dir = GOLDEN_SKILLS(lang, skill)
      // -z: 出力を設定（core.quotePath）に左右されない生のパスにする。非 ASCII の名前が引用符つきで返り、
      // 次の read が「無い」になって黙って欠けるのを避ける
      // --literal-pathspecs: パスをそのままの綴りとして扱う（`*`・`[`・`:(glob)` などを別名に一致させない）
      const r = run(
        ['--literal-pathspecs', 'ls-tree', '-r', '-z', '--name-only', baseRef, '--', dir],
        'utf-8',
        listMax
      )
      const f = failureOf(r, { op: 'list', lang, skill, via: 'ls-tree' })
      if (f) throw f
      return String(r.stdout ?? '')
        .split('\0')
        .filter(Boolean)
        .map((p) => p.slice(dir.length + 1))
        .filter((rel) => !rel.split('/').some((seg) => SKIP_SEG.test(seg)))
        .sort()
    },
    read: (lang, skill, relPath) => {
      const rel = relPath.replace(/\\/g, '/')
      const path = `${GOLDEN_SKILLS(lang, skill)}/${rel}`
      const ctx = { op: 'read' as const, lang, skill, relPath: rel }
      const r = run(['cat-file', '-p', `${baseRef}:${path}`], 'buffer', readMax)
      const f = failureOf(r, { ...ctx, via: 'cat-file' })
      if (!f) {
        // 0 バイトのファイルは長さ 0 の Buffer（旧も同じ）。stdout が無いのに成功は、読めたとは言えない
        if (!Buffer.isBuffer(r.stdout))
          throw new GoldenReadError({
            ...ctx,
            via: 'cat-file',
            kind: 'inconsistent',
            exitCode: r.status,
            signal: null,
            errorCode: null,
            stderrHead: ''
          })
        return r.stdout
      }
      // 起動失敗・時間切れ・シグナル・出力溢れは、git が「無い」と答えたのではない
      if (f.kind !== 'exit') throw f
      // 終了コードが 0 でないだけでは「無いパス」と「リポジトリでない・無効な ref」を分けられない（どちらも 128）。
      // 標準エラーの文面にも頼らず、ls-tree（無いパスでも 0・出力が空）で「無い」ことを確かめる
      const c = run(['--literal-pathspecs', 'ls-tree', '-z', baseRef, '--', path], 'utf-8', listMax)
      const cf = failureOf(c, { ...ctx, via: 'ls-tree' })
      if (cf) throw cf
      // 出力は `<mode> <type> <sha>\t<path>` を NUL で区切ったもの
      const entries = String(c.stdout ?? '')
        .split('\0')
        .filter(Boolean)
        .map((s) => /^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]*)$/.exec(s))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => ({ type: m[2], path: m[4] }))
      // ls-tree は `./x` や `a//b` を正規化して答えるが、cat-file はしない。返った名前が要求と完全に同じときだけ、
      // 「在るのに cat-file が失敗した」矛盾として扱う（正規化された別名は、旧と同じく「無い」）
      const hit = entries.find((en) => en.path === path)
      // gitlink（submodule。type=commit）は blob ではなく、cat-file で読めないのが正常。旧も「無い」（null）
      if (hit && hit.type === 'commit') return null
      if (hit)
        throw new GoldenReadError({
          ...ctx,
          via: 'cat-file',
          kind: 'inconsistent',
          exitCode: r.status,
          signal: null,
          errorCode: null,
          stderrHead: headOf(r.stderr)
        })
      return null
    }
  }
}

interface CollectedGoldenFile {
  lang: 'ja' | 'en'
  relPath: string
  sha256: string
  buf: Buffer
}

/** golden の対象 skill の全ファイル（ja・en）を 1 回ずつ読む。list の後に消えたファイル（read が null）は入れない */
function collectGolden(reader: GoldenReader, skillName: string): CollectedGoldenFile[] {
  const out: CollectedGoldenFile[] = []
  for (const lang of ['ja', 'en'] as const) {
    for (const rel of reader.list(lang, skillName)) {
      const buf = reader.read(lang, skillName, rel)
      if (buf === null) continue
      out.push({ lang, relPath: rel, sha256: contentHash(rel, buf), buf })
    }
  }
  return out
}

/** 今の golden の対象 skill の全ファイル（ja・en）の sha256 一覧 */
export function measureSnapshot(reader: GoldenReader, skillName: string): SnapshotDoc {
  return {
    skillName,
    files: collectGolden(reader, skillName).map(({ lang, relPath, sha256 }) => ({
      lang,
      relPath,
      sha256
    }))
  }
}

// ---- 作業場 ----

export interface ComposeWorkspace {
  dir: string
  goldenDir: string
  sourcesDir: string
  outDir: string
  guardDir: string
  requestFile: string
  settingsPath: string
  snapshotPath: string
  snapshotText: string
  snapshotSha: string
}

export interface CreateWorkspaceInput {
  paths: ComposePaths
  skillName: string
  reader: GoldenReader
  /** 元提案（作業場の sources/ へ読み取り用の写しを置く） */
  sources: Array<{ requestId: string; filePath: string }>
  now?: () => number
  rand?: () => string
}

export function createComposeWorkspace(i: CreateWorkspaceInput): ComposeWorkspace {
  const now = i.now ?? Date.now
  const rand = i.rand ?? ((): string => Math.random().toString(36).slice(2, 8))
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const safeSkill = i.skillName.replace(/[^A-Za-z0-9._-]/g, '_')
  const dir = join(i.paths.workspacesDir, `${safeSkill}-${stamp}-${rand()}`)
  const goldenDir = join(dir, 'golden')
  const sourcesDir = join(dir, 'sources')
  const outDir = join(dir, 'out')
  const guardDir = join(dir, 'guard')

  // golden を読む（git が読めなければ GoldenReadError）のは、作業場を作る前に済ませる。読めなかったとき、
  // 作業場のディレクトリを 1 つも残さない。1 回の読みで、ハッシュと写しの中身を同じ版から作る
  const collected = collectGolden(i.reader, i.skillName)
  const doc: SnapshotDoc = {
    skillName: i.skillName,
    files: collected.map(({ lang, relPath, sha256 }) => ({ lang, relPath, sha256 }))
  }
  mkdirSync(outDir, { recursive: true })
  mkdirSync(sourcesDir, { recursive: true })
  mkdirSync(guardDir, { recursive: true })
  for (const f of collected) {
    const dest = join(goldenDir, f.lang, 'skills', i.skillName, f.relPath)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, f.buf)
  }
  const snapshotText = serializeSnapshot(doc)
  const snapshotPath = join(dir, 'snapshot.json')
  writeFileSync(snapshotPath, snapshotText, 'utf-8')
  for (const s of i.sources) {
    try {
      copyFileSync(
        s.filePath,
        join(sourcesDir, `${s.requestId.replace(/[^A-Za-z0-9._-]/g, '_')}.md`)
      )
    } catch {
      /* 読み取り用の写しなので、失敗しても合成の本体は続けられる */
    }
  }
  return {
    dir,
    goldenDir,
    sourcesDir,
    outDir,
    guardDir,
    requestFile: join(dir, 'compose-request.md'),
    settingsPath: join(dir, '.claude', 'settings.local.json'),
    snapshotPath,
    snapshotText,
    snapshotSha: sha256Hex(snapshotText)
  }
}

// ---- 作業場の権限規則 ----

/** 作業場の権限規則に載せる、書いてはならない場所（監視範囲と同じ。状態ファイルは名前の型で） */
export function guardPathsForSettings(g: {
  repoDir: string
  claudeDir: string
  ccpitDir: string
}): string[] {
  const out: string[] = [
    join(g.repoDir, 'ccpit', 'golden'),
    join(g.repoDir, '_Tools', 'golden-apply'),
    join(g.ccpitDir, 'golden-overlay'),
    join(g.ccpitDir, 'compose-registry'),
    join(g.ccpitDir, 'proposals')
  ]
  for (const d of ['skills', 'hooks', 'rules', 'scripts', 'commands', 'agents'])
    out.push(join(g.claudeDir, d))
  for (const f of ['settings.json', 'settings.local.json', 'CLAUDE.md'])
    out.push(join(g.claudeDir, f))
  for (const pat of ['proposal-*.json', 'golden-*.json', 'adopt-*.json', 'emergency-*.json'])
    out.push(join(g.ccpitDir, pat))
  return out
}

const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] as const

function posix(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

/** `C:/a/b` → `//c/a/b`（Claude Code のファイルシステム絶対パスの規則の書き方）。ドライブが無ければ null */
function toDoubleSlashForm(p: string): string | null {
  const m = /^([A-Za-z]):\/(.*)$/.exec(posix(p))
  return m ? `//${m[1].toLowerCase()}/${m[2]}` : null
}

export interface WorkspaceSettings {
  permissions: { defaultMode: 'acceptEdits'; deny: string[]; allow: string[] }
}

/**
 * 作業場の `.claude/settings.local.json` の内容。作業場の外の監視範囲（golden・手元の設定・状態ファイル）への
 * 書込みツールを拒否する。許可の規則は入れない（作業場の中は acceptEdits の既定で通る）。
 * 規則の書き方は 2 通り（`C:/…` と `//c/…`）出す。どちらかが効けばよく、効かない書き方は無害。
 */
export function buildWorkspaceSettings(guardPaths: string[]): WorkspaceSettings {
  const deny = new Set<string>()
  for (const raw of guardPaths) {
    const p = posix(raw)
    for (const form of [p, toDoubleSlashForm(p)]) {
      if (!form) continue
      for (const tool of WRITE_TOOLS) {
        deny.add(`${tool}(${form})`)
        deny.add(`${tool}(${form}/**)`)
      }
    }
  }
  return { permissions: { defaultMode: 'acceptEdits', deny: [...deny].sort(), allow: [] } }
}

export function writeWorkspaceSettings(
  ws: Pick<ComposeWorkspace, 'settingsPath'>,
  settings: WorkspaceSettings
): void {
  mkdirSync(dirname(ws.settingsPath), { recursive: true })
  writeFileSync(ws.settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8')
}

// ---- 起動計画 ----

export interface ComposeLaunchPlan extends DialogueLaunchPlan {
  /** 作業ディレクトリ（作業場） */
  cwd: string
  /** 許可モード（固定） */
  permissionMode: 'acceptEdits'
}

/**
 * 合成 CC の起動計画（純関数）。cwd＝作業場・許可モード `acceptEdits` に固定・Bypass の入力は拒否する。
 * プロンプトは ASCII のみ（起動 .ps1 の CP932 問題）。依頼の本体は作業場の compose-request.md（UTF-8）にある。
 */
export function buildComposeLaunchPlan(input: {
  promptFilePath: string
  workspaceDir: string
  model?: string
  effort?: string
  /** 渡されても許可モードは acceptEdits に固定する。bypassPermissions は拒否 */
  permissionMode?: string
  /** true は拒否 */
  skipPermissions?: boolean
}): ComposeLaunchPlan {
  if (input.skipPermissions === true)
    throw new Error(
      'compose launch must not skip permissions (--dangerously-skip-permissions is rejected)'
    )
  if ((input.permissionMode ?? '').trim() === 'bypassPermissions') {
    throw new Error('compose launch must not use bypassPermissions')
  }
  const prompt =
    'Compose Skill proposals into one golden-based proposal. ' +
    `Read this file and follow the instructions written in it: ${input.promptFilePath}`
  if (!isPrintableAscii(prompt))
    throw new Error(`compose prompt must be printable ASCII only: ${prompt}`)
  if (!(PERMISSION_MODE_VALUES as readonly string[]).includes('acceptEdits'))
    throw new Error('acceptEdits is not a known permission mode')

  const flags: string[] = ['--permission-mode', 'acceptEdits']
  const rejected: string[] = []
  const effort = (input.effort ?? '').trim()
  if (effort && effort !== 'medium') {
    if (isSafeFlagToken(effort)) flags.push('--effort', effort)
    else rejected.push(`effort=${effort}`)
  }
  const model = (input.model ?? '').trim()
  if (model) {
    if (isSafeFlagToken(model)) flags.push('--model', model)
    else rejected.push(`model=${model}`)
  }
  flags.push(DIALOGUE_PROMPT_FLAG)
  return {
    flags,
    injectEnv: { [DIALOGUE_PROMPT_ENV]: prompt, [DIALOGUE_FILE_ENV]: input.promptFilePath },
    promptFilePath: input.promptFilePath,
    prompt,
    rejected,
    cwd: input.workspaceDir,
    permissionMode: 'acceptEdits'
  }
}

// ---- 進行中の合成（skill ごとに 1 つ） ----

interface ActiveMarker {
  workspace: string
  pid: number
  startedAt: number
}

function activePath(paths: ComposePaths, skillName: string): string {
  return join(paths.locksDir, `active-${skillName.replace(/[^A-Za-z0-9._-]/g, '_')}.json`)
}

/** 同じ skill の合成が進行中なら拒否する。保持者の CCPIT が既に存在しなければ引き継ぐ */
export function claimActiveCompose(
  paths: ComposePaths,
  skillName: string,
  workspace: string,
  deps: {
    pid?: number
    startedAt?: number
    isAlive?: (pid: number) => boolean
    processStartTime?: (pid: number) => number | null
  } = {}
): { ok: true } | { ok: false; error: string } {
  const p = activePath(paths, skillName)
  mkdirSync(dirname(p), { recursive: true })
  const pid = deps.pid ?? process.pid
  const marker: ActiveMarker = {
    workspace,
    pid,
    startedAt: deps.startedAt ?? Date.now() - Math.round(process.uptime() * 1000)
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(p, JSON.stringify(marker), { encoding: 'utf-8', flag: 'wx' })
      return { ok: true }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    let holder: ActiveMarker | null = null
    try {
      holder = JSON.parse(readFileSync(p, 'utf-8')) as ActiveMarker
    } catch {
      holder = null
    }
    if (
      holder &&
      !isHolderDead({ pid: holder.pid, startedAt: holder.startedAt, token: '' }, deps)
    ) {
      return {
        ok: false,
        error: `「${skillName}」の合成が進行中です（作業場: ${holder.workspace}）。終わるのを待つか、その合成を取り消してください`
      }
    }
    if (!holder) return { ok: false, error: `「${skillName}」の合成の進行記録が読めません: ${p}` }
    // 保持者が存在しない: 引き継ぐ（一意名への rename は 1 者だけが成功する）
    try {
      renameSync(p, `${p}.stale-${Math.random().toString(36).slice(2, 8)}`)
    } catch {
      /* 他者が先に引き継いだ */
    }
  }
  return { ok: false, error: `「${skillName}」の合成の進行記録を引き継げませんでした` }
}

export function releaseActiveCompose(
  paths: ComposePaths,
  skillName: string,
  workspace: string
): void {
  const p = activePath(paths, skillName)
  try {
    const holder = JSON.parse(readFileSync(p, 'utf-8')) as ActiveMarker
    if (holder.workspace === workspace) rmSync(p, { force: true })
  } catch {
    /* 無ければ何もしない */
  }
}

// ---- 起動前の目録・写しの保存 ----

export interface GuardState {
  roots: InventoryRoot[]
  before: Inventory
  baseline: Baseline
}

const serializeInventory = (inv: Inventory): string => JSON.stringify([...inv.entries()])
const deserializeInventory = (text: string): Inventory =>
  new Map(JSON.parse(text) as Array<[string, InventoryItem]>)

export function takeGuardState(
  ws: Pick<ComposeWorkspace, 'dir' | 'guardDir'>,
  g: { repoDir: string; claudeDir: string; ccpitDir: string }
): GuardState {
  const roots = buildGuardRoots({ ...g, workspaceDir: ws.dir })
  const before = takeInventory(roots)
  const baseline = makeBaseline(before, join(ws.guardDir, 'baseline'))
  writeFileSync(join(ws.guardDir, 'before.json'), serializeInventory(before), 'utf-8')
  writeFileSync(
    join(ws.guardDir, 'baseline.json'),
    JSON.stringify([...baseline.files.entries()]),
    'utf-8'
  )
  return { roots, before, baseline }
}

/** CCPIT が再起動しても、作業場に残した目録と写しから終了後の検査を続けられる */
export function loadGuardState(
  ws: Pick<ComposeWorkspace, 'dir' | 'guardDir'>,
  g: { repoDir: string; claudeDir: string; ccpitDir: string }
): GuardState | null {
  const b = join(ws.guardDir, 'before.json')
  const f = join(ws.guardDir, 'baseline.json')
  if (!existsSync(b) || !existsSync(f)) return null
  return {
    roots: buildGuardRoots({ ...g, workspaceDir: ws.dir }),
    before: deserializeInventory(readFileSync(b, 'utf-8')),
    baseline: {
      dir: join(ws.guardDir, 'baseline'),
      files: new Map(JSON.parse(readFileSync(f, 'utf-8')) as Array<[string, string]>)
    }
  }
}
