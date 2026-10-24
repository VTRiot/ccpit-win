/**
 * golden の git 読み取りの共通部（CCPIT_L0_010）。
 *
 * 昇格経路（goldenPromotion.ts）は git の失敗を「無い」に畳んでいた（`status !== 0` → null／''／[]／'initial'）。
 * 実測で、その畳み込みのうち 12 箇所が「検査を通す／検出が消える」向きに緩むと分かった。ここでは、読み取りの結果を
 * 「在る（present）」「確かに無い（absent）」「読めなかった（unreadable）」の三つに分け、読めなかったものが
 * 「無い」に化けないようにする。
 *
 * - 葉のモジュール。electron にも goldenPromotion.ts にも依存しない（試験から単独で import できる）。
 * - 投げない関数（`readGoldenBlob`・`resolveHead`・`checkLease`・`probeCommit`）と、投げる薄い皮（`…OrThrow`）を分ける。
 *   走査は投げない側を使い、反映は投げる側で止める（一覧の 1 件の失敗で全部が消えないように）。
 * - 失敗の分類の順と、利用者に出る文面の頭（`GOLDEN_READ_ERROR_HEAD`）は composeWorkspace.ts と共有する（値の複製をしない）。
 *   composeWorkspace.ts の import 閉包に goldenPromotion.ts・electron は無い（循環しない）。
 * - `child_process` は goldenPromotion.ts と同じ指定子で import する（試験の `vi.mock('child_process')` が両方に効く）。
 */

import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { GOLDEN_READ_ERROR_HEAD, type GoldenReadFailureKind } from './composeWorkspace'

/** 標準エラーの先頭を理由に載せる長さ（メッセージが画面で読める長さ。値の根拠ではなく表示の都合。composeWorkspace.ts と同じ） */
const STDERR_HEAD_CHARS = 200

/** 昇格の基準が「まだ commit が無い」ことを表す番兵（旧コードが `rev-parse HEAD` の失敗時に代入していた文字列） */
export const INITIAL_BASE_SENTINEL = 'initial'

/** HEAD を指す ref 名 */
export const HEAD_REF = 'HEAD'

/** git の commit 識別子の形。sha-1 は 40 桁、sha-256 のリポジトリは 64 桁（旧コードは形式を見ないので 40 固定にしない） */
const COMMIT_SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i

/** 台帳・拒否文面で使う 40 桁（sha-1）の形。`isValidGitCommit` の入力検査用 */
const SHA1_RE = /^[0-9a-f]{40}$/i

export type GoldenGitOp =
  | 'read'
  | 'head'
  | 'lease'
  | 'commit'
  | 'tree'
  | 'log'
  | 'show'
  | 'diff'
  // CCPIT_L0_014: 残置 worktree の一覧・孤立ブランチの一覧・ref（master など）の有無
  | 'worktree'
  | 'branch'
  | 'ref'

/** git 呼び出し 1 回の失敗の中身（`spawnSync` の戻りから判定に使う部分だけを取る） */
export interface GoldenGitFailure {
  kind: GoldenReadFailureKind
  /** 呼んだ git のサブコマンド（`cat-file`・`ls-tree` など） */
  via: string
  exitCode: number | null
  signal: string | null
  errorCode: string | null
  stderrHead: string
  /** 標準エラーが空か。リースの「確かに無い（終了 1・stderr 空）」と「壊れた ref（終了 1・警告あり）」を分けるのに使う */
  stderrEmpty: boolean
  /** 出力の上限（output-overflow のときの文面用） */
  maxBuffer: number | null
}

export type GoldenGitRun =
  | { ok: true; stdout: Buffer | string; stderrEmpty: boolean }
  | { ok: false; failure: GoldenGitFailure }

export interface RunGoldenGitOptions {
  encoding: 'buffer' | 'utf-8'
  /** 出力の上限。省略は Node の既定（旧コードが指定していなかった呼び出しの同値のため） */
  maxBuffer?: number
  /**
   * 成功として受ける終了コード（0 に加えて）。既定は 0 だけ。`git diff --no-index` は「差がある」を終了 1 で返すので、
   * それを成功として受けるために使う（CCPIT_L0_014）。これ以外の非 0 は従来どおり `exit` の失敗
   */
  okExitCodes?: readonly number[]
}

const BRAND = Symbol.for('ccpit.GoldenGitReadError')

/**
 * golden を git から読めなかったときの例外。composeWorkspace.ts の `GoldenReadError`（lang・skill・op が必須）は
 * ref＋任意の path に合わないので、継承せず兄弟として作る。文面の頭は共有する。
 */
export class GoldenGitReadError extends Error {
  readonly op: GoldenGitOp
  readonly ref: string | null
  readonly relPath: string | null
  readonly kind: GoldenReadFailureKind
  readonly via: string
  readonly exitCode: number | null
  readonly signal: string | null
  readonly errorCode: string | null
  readonly stderrHead: string
  readonly [BRAND] = true

  constructor(d: {
    op: GoldenGitOp
    ref?: string | null
    relPath?: string | null
    failure: GoldenGitFailure
    /** 失敗の補足（例: 「ls-tree は在ると言うのに cat-file が失敗した」） */
    note?: string
  }) {
    const f = d.failure
    const target = [d.ref, d.relPath].filter((x): x is string => !!x).join(':')
    const parts = [`${d.op}${target ? ` ${target}` : ''}`, `git ${f.via}`, f.kind]
    if (f.exitCode !== null) parts.push(`exit=${f.exitCode}`)
    if (f.signal) parts.push(`signal=${f.signal}`)
    if (f.errorCode) parts.push(`error=${f.errorCode}`)
    if (f.stderrHead) parts.push(`stderr=${f.stderrHead}`)
    if (d.note) parts.push(d.note)
    // 出力の上限超えは再試行で直らない。それ以外は一時的な失敗でありうる
    const advice =
      f.kind === 'output-overflow'
        ? `再試行では直りません。出力が上限${f.maxBuffer !== null ? ` ${f.maxBuffer} バイト` : ''}を超えました`
        : 'もう一度実行してください。続くときは golden のリポジトリの状態を確かめてください'
    super(`${GOLDEN_READ_ERROR_HEAD}（${parts.join(' / ')}）。${advice}`)
    // TS のターゲットによっては Error の継承で instanceof が壊れるため、明示する
    Object.setPrototypeOf(this, GoldenGitReadError.prototype)
    this.name = 'GoldenGitReadError'
    this.op = d.op
    this.ref = d.ref ?? null
    this.relPath = d.relPath ?? null
    this.kind = f.kind
    this.via = f.via
    this.exitCode = f.exitCode
    this.signal = f.signal
    this.errorCode = f.errorCode
    this.stderrHead = f.stderrHead
  }
}

/**
 * 境界の判定はこちらを使う。試験の `vi.resetModules` などでクラスが二重に読まれても、name とブランドで外れない。
 */
export function isGoldenGitReadError(e: unknown): e is GoldenGitReadError {
  if (e instanceof GoldenGitReadError) return true
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { name?: unknown }).name === 'GoldenGitReadError' &&
    (e as Record<symbol, unknown>)[BRAND] === true
  )
}

/**
 * `dir` かその親のどれかに `.git`（フォルダでもファイルでも）があるか。
 * 無ければ git のリポジトリの外＝golden が確かに無い場所（インストール版の実行など）。`.git` が在るのに git が失敗するのは
 * 壊れたリポジトリで、これは「読めなかった」。旧は両方とも「無い」に畳まれていたので、前者だけを旧の挙動のまま残すために使う。
 */
export function isInsideGitRepo(dir: string): boolean {
  let cur = resolve(dir)
  for (;;) {
    if (existsSync(join(cur, '.git'))) return true
    const up = dirname(cur)
    if (up === cur) return false
    cur = up
  }
}

const headOf = (b: unknown): string => {
  // 起動に失敗した spawnSync は stdout・stderr を null でなく undefined で返すことがある（実測）
  if (b === null || b === undefined) return ''
  const text = (typeof b === 'string' ? b : Buffer.isBuffer(b) ? b.toString('utf-8') : '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.slice(0, STDERR_HEAD_CHARS)
}

const isEmptyOutput = (b: unknown): boolean => {
  if (b === null || b === undefined) return true
  if (typeof b === 'string') return b.length === 0
  if (Buffer.isBuffer(b)) return b.length === 0
  return false
}

/** `-` で始まる全体オプション（`--literal-pathspecs` など）を飛ばした最初の語＝サブコマンド */
const subcommandOf = (args: string[]): string =>
  args.find((a) => !a.startsWith('-')) ?? args[0] ?? ''

/**
 * git を 1 回呼び、結果を成功／失敗に分ける。投げない。
 *
 * 分類の順（composeWorkspace.ts の `failureOf` と同じ）: error → signal → status null → 0 → それ以外。
 * ENOBUFS は signal（SIGTERM）も同時に立つので、signal を先に見ると output-overflow が signal に化ける。
 * 成功が確定するまで `stdout` に触らない（ENOBUFS では上限超の部分 Buffer が残り、ENOENT では undefined）。
 */
export function runGoldenGit(
  repoDir: string,
  args: string[],
  opts: RunGoldenGitOptions
): GoldenGitRun {
  const via = subcommandOf(args)
  const maxBuffer = opts.maxBuffer ?? null
  const fail = (
    kind: GoldenReadFailureKind,
    d: Partial<GoldenGitFailure> & { stderr?: unknown }
  ): GoldenGitRun => ({
    ok: false,
    failure: {
      kind,
      via,
      exitCode: d.exitCode ?? null,
      signal: d.signal ?? null,
      errorCode: d.errorCode ?? null,
      stderrHead: headOf(d.stderr),
      stderrEmpty: isEmptyOutput(d.stderr),
      maxBuffer
    }
  })

  let res: ReturnType<typeof spawnSync>
  try {
    res = spawnSync('git', args, {
      cwd: repoDir,
      encoding: opts.encoding,
      ...(opts.maxBuffer !== undefined ? { maxBuffer: opts.maxBuffer } : {})
    })
  } catch (e) {
    // 同期例外（引数の不正など）も「読めなかった」。呼び出し側へ投げない
    const code = (e as { code?: unknown })?.code
    return fail('spawn-error', { errorCode: typeof code === 'string' ? code : 'THROWN' })
  }

  if (res.error) {
    const code = (res.error as { code?: string }).code ?? ''
    const kind: GoldenReadFailureKind =
      code === 'ETIMEDOUT' ? 'timeout' : code === 'ENOBUFS' ? 'output-overflow' : 'spawn-error'
    return fail(kind, {
      exitCode: res.status,
      signal: res.signal ?? null,
      errorCode: code || null,
      stderr: res.stderr
    })
  }
  if (res.signal) {
    return fail('signal', { exitCode: res.status, signal: res.signal, stderr: res.stderr })
  }
  if (res.status === null) {
    return fail('spawn-error', { stderr: res.stderr })
  }
  if (res.status !== 0 && !(opts.okExitCodes ?? []).includes(res.status)) {
    return fail('exit', { exitCode: res.status, stderr: res.stderr })
  }
  // 成功。出力の型が期待と違うものは、成功とみなさない（stdout が undefined の 0 を「在る」にしない）
  const out = res.stdout as unknown
  const okType = opts.encoding === 'buffer' ? Buffer.isBuffer(out) : typeof out === 'string'
  if (!okType) return fail('inconsistent', { exitCode: 0, stderr: res.stderr })
  return { ok: true, stdout: out as Buffer | string, stderrEmpty: isEmptyOutput(res.stderr) }
}

// ---- blob の読み取り ----

export type GoldenBlobRead =
  | { state: 'present'; bytes: Buffer }
  | { state: 'absent' }
  | { state: 'unreadable'; error: GoldenGitReadError }

export interface ReadGoldenBlobOptions {
  /** 出力の上限。呼び出し側（goldenPromotion.ts）が `MAX_COMPANION_FILE_SIZE_BYTES` を渡す（定数を二重に持たない） */
  maxBuffer: number
  /**
   * 真なら、`repoDir` が git のリポジトリの外（`.git` がどこにも無い）で git が終了コードで失敗したとき、absent とする。
   * 走査が、リポジトリの無い場所で従来どおり「golden に無い」と扱うため。壊れたリポジトリ（`.git` はある）は unreadable のまま
   */
  noRepoIsAbsent?: boolean
}

/**
 * `ls-tree` の 1 項目（`-z` 形式: `<mode> SP <type> SP <sha> TAB <path>` を NUL で区切ったもの）から path が一致する型を取る。
 */
function lsTreeTypeOf(stdout: Buffer, relPath: string): string | null {
  for (const entry of stdout.toString('utf-8').split('\0')) {
    if (!entry) continue
    const tab = entry.indexOf('\t')
    if (tab < 0) continue
    const path = entry.slice(tab + 1)
    if (path !== relPath) continue
    const fields = entry.slice(0, tab).split(' ')
    return fields[1] ?? null
  }
  return null
}

/**
 * 基準 `ref` の `relPath` の中身を読む。投げない。
 *
 * 1. `git cat-file -p <ref>:<path>`（旧と同じ argv・Buffer・上限。時間切れは付けない＝健全時の結果を変えないため）。
 *    成功なら present（0 バイトも present）。
 * 2. 失敗が「終了コード」のときだけ、`git --literal-pathspecs ls-tree --full-tree -z <ref> -- <path>` で「確かに無い」かを確かめる。
 *    `--literal-pathspecs` は git 全体のオプション（`ls-tree` の後ろに置くと終了 129）。`--full-tree` は、`repoDir` が
 *    リポジトリの最上位でなくても `cat-file` と同じ基準にするため（付けないと、在る path でも空になる）。
 *    - `ls-tree` が 0 で該当項目が無い → absent。項目が `commit`（gitlink）→ absent（旧も null）。
 *    - 項目が blob／tree なのに `cat-file` が失敗していた → unreadable（inconsistent）。`ls-tree` 自体の失敗 → unreadable。
 * 3. 失敗が終了コード以外（起動失敗・時間切れ・signal・出力溢れ）なら `ls-tree` に進まず unreadable。
 * 4. 番兵: `ref` が `'initial'` なら git を呼ばず absent。`'HEAD'` は、commit が 0 件（unborn）と確認できたときだけ absent。
 */
export function readGoldenBlob(
  repoDir: string,
  ref: string,
  relPath: string,
  opts: ReadGoldenBlobOptions
): GoldenBlobRead {
  const normRel = relPath.replace(/\\/g, '/')
  if (ref === INITIAL_BASE_SENTINEL) return { state: 'absent' }

  const err = (failure: GoldenGitFailure, note?: string): GoldenBlobRead => ({
    state: 'unreadable',
    error: new GoldenGitReadError({ op: 'read', ref, relPath: normRel, failure, note })
  })

  const cat = runGoldenGit(repoDir, ['cat-file', '-p', `${ref}:${normRel}`], {
    encoding: 'buffer',
    maxBuffer: opts.maxBuffer
  })
  if (cat.ok) return { state: 'present', bytes: cat.stdout as Buffer }
  if (cat.failure.kind !== 'exit') return err(cat.failure)
  if (opts.noRepoIsAbsent && !isInsideGitRepo(repoDir)) return { state: 'absent' }

  if (ref === HEAD_REF) {
    const head = resolveHead(repoDir)
    if (head.state === 'unborn') return { state: 'absent' }
  }

  const tree = runGoldenGit(
    repoDir,
    ['--literal-pathspecs', 'ls-tree', '--full-tree', '-z', ref, '--', normRel],
    { encoding: 'buffer' }
  )
  if (!tree.ok) return err(tree.failure)
  const type = lsTreeTypeOf(tree.stdout as Buffer, normRel)
  if (type === null || type === 'commit') return { state: 'absent' }
  return err(
    { ...cat.failure, kind: 'inconsistent' },
    `ls-tree は ${type} が在ると言うのに cat-file が失敗しました`
  )
}

/** 投げる版。反映の経路が使う。読めなかったら `GoldenGitReadError`、無ければ null */
export function readGoldenBlobOrThrow(
  repoDir: string,
  ref: string,
  relPath: string,
  opts: ReadGoldenBlobOptions
): Buffer | null {
  const r = readGoldenBlob(repoDir, ref, relPath, opts)
  if (r.state === 'unreadable') throw r.error
  return r.state === 'present' ? r.bytes : null
}

// ---- 出力を読む git（ls-tree・log・show・diff-tree） ----

export type GoldenTextRead =
  | { state: 'ok'; stdout: string }
  | { state: 'unreadable'; error: GoldenGitReadError }

export interface ReadGoldenTextContext {
  op: GoldenGitOp
  ref?: string | null
  relPath?: string | null
  maxBuffer?: number
  /**
   * 真なら、基準 `ref` が番兵（`'initial'`）のとき git を呼ばず空を返し、`'HEAD'` で commit が 0 件（unborn）と確認できたときも空を返す。
   * 旧は、基準が引けない（commit が無い）と ls-tree が 128 になり、結果が空＝「新規」になっていた。その挙動を unborn に限って残す。
   */
  emptyIfNoBase?: boolean
}

/**
 * 出力を文字列で読む git を 1 回呼ぶ。投げない。終了 0 の空出力は ok（空）。それ以外の失敗は unreadable。
 * 「失敗」と「正当な空」を区別するのが目的で、空かどうかの解釈は呼び出し側が行う。
 */
export function readGoldenText(
  repoDir: string,
  args: string[],
  ctx: ReadGoldenTextContext
): GoldenTextRead {
  if (ctx.emptyIfNoBase && ctx.ref === INITIAL_BASE_SENTINEL) return { state: 'ok', stdout: '' }
  const r = runGoldenGit(repoDir, args, {
    encoding: 'utf-8',
    ...(ctx.maxBuffer !== undefined ? { maxBuffer: ctx.maxBuffer } : {})
  })
  if (r.ok) return { state: 'ok', stdout: r.stdout as string }
  if (ctx.emptyIfNoBase && r.failure.kind === 'exit') {
    // git のリポジトリの外は、golden が確かに無い場所（従来どおり空）。壊れたリポジトリ（.git はある）は下で unreadable
    if (!isInsideGitRepo(repoDir)) return { state: 'ok', stdout: '' }
    if (ctx.ref === HEAD_REF && resolveHead(repoDir).state === 'unborn') return { state: 'ok', stdout: '' }
  }
  return {
    state: 'unreadable',
    error: new GoldenGitReadError({
      op: ctx.op,
      ref: ctx.ref ?? null,
      relPath: ctx.relPath ?? null,
      failure: r.failure
    })
  }
}

/** 投げる版。読めなかったら `GoldenGitReadError` */
export function readGoldenTextOrThrow(
  repoDir: string,
  args: string[],
  ctx: ReadGoldenTextContext
): string {
  const r = readGoldenText(repoDir, args, ctx)
  if (r.state === 'unreadable') throw r.error
  return r.stdout
}

// ---- HEAD ----

export type HeadRead =
  | { state: 'present'; sha: string }
  | { state: 'unborn' }
  | { state: 'unreadable'; error: GoldenGitReadError }

/**
 * HEAD の commit を読む。投げない。
 *
 * 実 git の実測（終了コード）:
 * - 健全: `rev-parse --verify --quiet HEAD^{commit}` が 0＋sha。
 * - commit が 0 件（unborn）: 1。ただし **ref の中身が壊れていても 1**（unborn と区別できない）。
 * - そこで 1 のときだけ `symbolic-ref -q HEAD`（名前を得る。壊れた ref は 128）と
 *   `show-ref --verify --quiet <名前>`（無ければ 1。commit object が無いと 128）を足し、
 *   「名前は在るが ref が確かに無い」ときだけ unborn とする。
 * - それ以外（128・null・signal・時間切れ・出力溢れ・想定外の出力）はすべて unreadable。
 */
export function resolveHead(repoDir: string): HeadRead {
  const bad = (failure: GoldenGitFailure, note?: string): HeadRead => ({
    state: 'unreadable',
    error: new GoldenGitReadError({ op: 'head', ref: HEAD_REF, failure, note })
  })

  const rp = runGoldenGit(repoDir, ['rev-parse', '--verify', '--quiet', `${HEAD_REF}^{commit}`], {
    encoding: 'utf-8'
  })
  if (rp.ok) {
    const sha = (rp.stdout as string).trim()
    if (COMMIT_SHA_RE.test(sha)) return { state: 'present', sha }
    return bad(
      {
        kind: 'inconsistent',
        via: 'rev-parse',
        exitCode: 0,
        signal: null,
        errorCode: null,
        stderrHead: '',
        stderrEmpty: true,
        maxBuffer: null
      },
      '想定外の出力'
    )
  }
  if (!(rp.failure.kind === 'exit' && rp.failure.exitCode === 1)) return bad(rp.failure)

  const sym = runGoldenGit(repoDir, ['symbolic-ref', '-q', HEAD_REF], { encoding: 'utf-8' })
  if (!sym.ok) return bad(sym.failure)
  const refName = (sym.stdout as string).trim()
  if (!refName)
    return bad({ ...rp.failure, via: 'symbolic-ref', kind: 'inconsistent' }, '想定外の出力')

  const sr = runGoldenGit(repoDir, ['show-ref', '--verify', '--quiet', refName], {
    encoding: 'utf-8'
  })
  if (sr.ok) {
    // ref は在るのに HEAD^{commit} が解決できない（commit でない object など）
    return bad(
      { ...rp.failure, kind: 'inconsistent' },
      `${refName} は在りますが commit に解決できません`
    )
  }
  if (sr.failure.kind === 'exit' && sr.failure.exitCode === 1) return { state: 'unborn' }
  return bad(sr.failure)
}

/** 投げる版。unborn は null、読めなかったら `GoldenGitReadError` */
export function resolveHeadOrThrow(repoDir: string): string | null {
  const h = resolveHead(repoDir)
  if (h.state === 'unreadable') throw h.error
  return h.state === 'present' ? h.sha : null
}

// ---- リース ----

export type LeaseRead =
  | { state: 'present'; sha: string }
  | { state: 'absent' }
  | { state: 'unreadable'; error: GoldenGitReadError }

/**
 * ref が在るか。投げない。`checkLease` の本体（リース以外の ref、たとえば `refs/heads/master` にも使う。CCPIT_L0_014）。
 *
 * `rev-parse --verify --quiet <ref>`: 在れば 0＋sha、確かに無ければ **1 かつ標準エラーが空**。
 * 壊れた ref は 1 でも標準エラーに警告（`warning: ignoring broken ref`）が出るので、「確かに無い」にしない。
 * 標準エラーは「空かどうか」だけ見る（言語設定に依存しない）。
 */
export function checkRef(repoDir: string, ref: string, op: GoldenGitOp): LeaseRead {
  const bad = (failure: GoldenGitFailure, note?: string): LeaseRead => ({
    state: 'unreadable',
    error: new GoldenGitReadError({ op, ref, failure, note })
  })
  const r = runGoldenGit(repoDir, ['rev-parse', '--verify', '--quiet', ref], {
    encoding: 'utf-8'
  })
  if (r.ok) {
    const sha = (r.stdout as string).trim()
    if (sha) return { state: 'present', sha }
    return bad(
      {
        kind: 'inconsistent',
        via: 'rev-parse',
        exitCode: 0,
        signal: null,
        errorCode: null,
        stderrHead: '',
        stderrEmpty: true,
        maxBuffer: null
      },
      '終了 0 なのに出力が空'
    )
  }
  const f = r.failure
  if (f.kind === 'exit' && f.exitCode === 1 && f.stderrEmpty) return { state: 'absent' }
  return bad(f)
}

/** リース ref が在るか。投げない。判定は `checkRef` と同じ（op だけ `lease`） */
export function checkLease(repoDir: string, leaseRef: string): LeaseRead {
  return checkRef(repoDir, leaseRef, 'lease')
}

// ---- commit の実在 ----

export type CommitProbe =
  | { state: 'present' }
  | { state: 'absent' }
  | { state: 'unreadable'; error: GoldenGitReadError }

/**
 * 40 桁の sha が commit object として在るか。投げない。
 *
 * 旧は `cat-file -e <sha>^{commit}` の終了コード 0 だけを見ていたが、`^{commit}` 付きは **存在しない sha でも 128**
 * （付けなければ 1）で、「無い」と「リポジトリが読めない」が見分けられない。そこで
 * `cat-file -e <sha>`（0＝在る・1＝無い・それ以外＝失敗）に変え、在るときだけ `cat-file -t <sha>` で commit かを確かめる
 * （blob・tree の sha は今と同じく「commit として無い」）。40 桁でない入力は git を呼ばず absent。
 */
export function probeCommit(repoDir: string, sha: string): CommitProbe {
  if (!SHA1_RE.test(sha)) return { state: 'absent' }
  const bad = (failure: GoldenGitFailure, note?: string): CommitProbe => ({
    state: 'unreadable',
    error: new GoldenGitReadError({ op: 'commit', ref: sha, failure, note })
  })
  const e = runGoldenGit(repoDir, ['cat-file', '-e', sha], { encoding: 'utf-8' })
  if (!e.ok) {
    if (e.failure.kind === 'exit' && e.failure.exitCode === 1) return { state: 'absent' }
    return bad(e.failure)
  }
  const t = runGoldenGit(repoDir, ['cat-file', '-t', sha], { encoding: 'utf-8' })
  if (!t.ok) return bad(t.failure)
  return (t.stdout as string).trim() === 'commit' ? { state: 'present' } : { state: 'absent' }
}

/** 投げる版。commit として在れば true、確かに無ければ false、読めなかったら `GoldenGitReadError` */
export function isCommitObjectOrThrow(repoDir: string, sha: string): boolean {
  const p = probeCommit(repoDir, sha)
  if (p.state === 'unreadable') throw p.error
  return p.state === 'present'
}
