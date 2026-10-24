/**
 * composeLaunch — 合成の起動と、終了後の検査・登録・レビューの段取り（electron 非依存。Plan r10 §4-2・T4・T7）。
 *
 * 画面の「合成して golden へ入れる」ボタンから `startCompose` が呼ばれ、作業場を作り、権限規則を書き、起動前の目録を取り、
 * 合成 CC を起動する。CC は作業場の `out/READY.json` に合図を書いて終わる。CCPIT 側の `pollComposeWorkspaces` が合図を見つけ、
 * `finalizeWorkspace`（範囲外書込みの検査→登録→独立レビュー）を行って結果を `result.json` に残す。画面は `listComposeStatuses` で読む。
 * CCPIT が再起動しても、作業場の meta.json・guard/・result.json から続きを行える。
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  closeSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import {
  COMPOSE_GENERATION_ATTEMPTS_MAX,
  COMPOSE_LAUNCH_NONCE_HEX_LEN,
  COMPOSE_ROUND_MAX,
  COMPOSE_STARTED_FILE,
  COMPOSE_STARTED_FILE_MAX_BYTES,
  RECEPTACLE_DEFAULT_OWNER,
  adoptedInfoFromLedgerEntry,
  type CarriedFinding,
  type ComposeAdoptedFields,
  type ComposeCaseFields,
  type ComposeCaseRecord,
  type ComposeCcStart,
  type ComposePhase,
  type ComposeReviewContext,
  type ComposeReviewOutcome,
  type ComposeSeqFields,
  type ComposeWindowFields,
  type FindingOrigin,
  type FindingSeverity,
  type OriginCounts,
  type RoundRecord,
  type Section1Row
} from '../../shared/composeContract'
import { launchCc, type LaunchArgs } from './ccLaunch'
import { buildComposePacket, buildRevisionFindingsDoc } from './goldenMergeConsult'
import {
  detectUnsupportedSource,
  finalizeCompose,
  listSourceAdaptationKeys,
  readFm,
  type AdaptedListItem,
  type ComposeSource
} from './composeRegister'
import { readMergeLedger, withSkillLock, type ComposePaths, type MergeEntry } from './composeLedger'
import {
  buildComposeLaunchPlan,
  buildWorkspaceSettings,
  claimActiveCompose,
  createComposeWorkspace,
  GoldenReadError,
  guardPathsForSettings,
  loadGuardState,
  makeGitGoldenReader,
  releaseActiveCompose,
  takeGuardState,
  writeWorkspaceSettings,
  type ComposeWorkspace,
  type GoldenReader
} from './composeWorkspace'
import {
  asciiSafeTempDir,
  isPrintableAscii,
  DIALOGUE_PROMPT_FLAG,
  type DialogueLaunchOptions
} from './proposalDialogueLaunch'
import { sha256Hex } from './composeHash'
import { defaultIsAlive, type FileLockDeps } from './composeFileLock'
import type {
  StartComposeRevisionHeadlessArgs,
  StartComposeRevisionHeadlessResult
} from './composeHeadlessLaunch'
import { parseReviewerOutput } from './composeReviewClassify'
import {
  applyDecision,
  buildHistoryItems,
  buildStopQuestion,
  canReserveNextRound,
  caseAdoptedInfo,
  caseDirOfWorkspace,
  checkReviewBinding,
  decideAfterReview,
  evaluateSection1,
  findingViewsFromRow,
  isReviewOutcome,
  lastRoundOf,
  listWorkspaceMetas,
  makeRawReviewRowReader,
  mutateCaseSync,
  newCaseRecord,
  newToken,
  observe,
  outcomeFromRow,
  parseSection1Table,
  prevInfoFromRow,
  projectCaseFields,
  readCase,
  readMetaLite,
  readStage,
  reserveRound,
  roundWorkspaceExists,
  runtimeFor,
  statusSignature,
  updateCase,
  writeCaseSync,
  writeStage,
  type ComposeRuntime,
  type PrevRoundInfo,
  type ReviewRow,
  type ReviewRowReader
} from './composeRounds'

export type { ComposePhase }

export interface ComposeGuardDirs {
  repoDir: string
  claudeDir: string
  ccpitDir: string
}

export interface ComposeSourceInfo extends ComposeSource {
  title: string
  adoptionLabel: string
}

export interface ComposeMeta {
  skillName: string
  compositeRequestId: string
  sources: ComposeSourceInfo[]
  guard: ComposeGuardDirs
  proposalsDir: string
  startedAt: string
  language: 'ja' | 'en'
  promptFilePath: string
  /** 改訂ルート: 置き換える旧合成提案の ID */
  revises?: string
  /** 選ばなかった提案（起動時に元提案に選べたが選ばなかったもの）の request_id。登録で台帳の `excluded` に写る */
  excluded?: string[]
  // ---- L0_011: 案件と巡（旧形式の作業場には無い） ----
  /** 案件の ID（第 1 巡の合成提案の ID）。無ければ旧形式の作業場 */
  caseId?: string
  /** 巡の番号（1 始まり）。巡の一意キーは `caseId#round` */
  round?: number
  /** 旧形式の合成提案から続けたとき、その ID */
  continuesFrom?: string
  /** 巡の予約の札（同じ巡の二重起動を防ぐ） */
  token?: string
  /** 案件の記録 case.json がある作業場（第 2 巡以降が指す。第 1 巡では省略） */
  caseDir?: string
  /** 窓を出さない改訂 AI で作った作業場（CCPIT の再起動で止まったとき、起動し直す対象） */
  headless?: boolean
  // ---- L0_012: 窓つきの合成 CC の着手の合図 ----
  /** 起動ごとの固有の値の sha256（16 進）。値そのものは依頼文にだけ在る。窓つきの起動だけが持つ */
  launchNonceSha256?: string
}

export interface ComposeReviewFindingSummary {
  reviewerNo: string
  gateId: string | null
  origin: FindingOrigin
  severity: FindingSeverity
  title: string
  where: string
}

export interface ComposeReview {
  status: string
  verdict?: string
  message?: string
  /** 案件の作業場のみ: 由来別の件数と、指摘の要約（画面の FindingView の材料） */
  counts?: OriginCounts
  findings?: ComposeReviewFindingSummary[]
}

export interface ComposeResult {
  ok: boolean
  stage?: string
  error?: string
  /** containment で拒否したときの、満たさなかったハンク（鍵・理由・要約） */
  unsatisfied?: Array<{ key: string; reason: string; preview: string }>
  compositeId?: string
  filePath?: string
  adapted?: AdaptedListItem[]
  review?: ComposeReview
  finishedAt: string
}

export interface ComposeStatus
  extends Partial<ComposeCaseFields>,
    Partial<ComposeSeqFields>,
    Partial<ComposeAdoptedFields>,
    ComposeWindowFields {
  workspaceDir: string
  skillName: string
  startedAt: string
  phase: ComposePhase
  compositeRequestId: string
  sourceIds: string[]
  /** 改訂の合成のとき、置き換える旧合成提案の ID */
  revises?: string
  /** 選ばなかった提案の request_id（合成の元に選ばず、この合成が終わるまで昇格候補から外れる提案） */
  excludedIds: string[]
  result?: ComposeResult
}

/** 窓を出さない改訂 AI の起動口（composeHeadlessLaunch.startComposeRevisionHeadless と同じ形。試験は偽を差し込む） */
export type HeadlessLauncher = (
  a: StartComposeRevisionHeadlessArgs
) => StartComposeRevisionHeadlessResult

/** 案件の記録のうち、失敗の原因（契約の型には無い追加項目） */
type CaseRecordX = ComposeCaseRecord & { error?: string }
/** 巡の記録のうち、独立レビューの起動権（契約の型には無い追加項目。プロセスをまたいで 1 巡 1 回にする） */
type RoundRecordX = RoundRecord & { reviewClaim?: { pid: number; owner: string; at: string } }

const META = 'meta.json'
const RESULT = 'result.json'
const CANCEL = 'cancelled.json'

const readJson = <T>(p: string): T | null => {
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as T
  } catch {
    return null
  }
}

function stamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`
}

// ---- 元提案の選び方 ----

export interface CandidateLike {
  skillName: string
  proposalRequestId?: string
  proposalFilePath?: string
  title: string
  composedInto?: string
  /** 別の合成提案が昇格を完了するまで待たされている（その合成提案の request_id） */
  composeWaitingFor?: string
  /** 登録済みだがまだ有効でない（未 approve など）別の合成提案の元になっている（その合成提案の request_id） */
  composeHeldBy?: string
}

/**
 * 候補（承認済みの提案）から、合成の対象にできる元提案（適格な集合）を選ぶ。合成提案そのもの（`supersedes` を持つ・台帳にある）と、
 * 既に別の合成提案（登録済み）の元になっているもの・別の合成提案の昇格待ちのものは含めない（同じ元提案を 2 つの合成提案が握らない）
 */
export function selectComposeSources(
  candidates: CandidateLike[],
  skillName: string,
  ledgerIds: ReadonlySet<string>
): ComposeSourceInfo[] {
  const out: ComposeSourceInfo[] = []
  for (const c of candidates) {
    if (c.skillName !== skillName || !c.proposalRequestId || !c.proposalFilePath) continue
    if (
      ledgerIds.has(c.proposalRequestId) ||
      c.composedInto ||
      c.composeWaitingFor ||
      c.composeHeldBy
    )
      continue
    let fm: Record<string, string> = {}
    try {
      fm = readFm(readFileSync(c.proposalFilePath, 'utf-8'))
    } catch {
      continue
    }
    if ((fm['supersedes'] || '').trim()) continue
    out.push({
      requestId: c.proposalRequestId,
      filePath: c.proposalFilePath,
      skillName,
      title: c.title.replace(/^\[CC提案\]\s*/, ''),
      adoptionLabel: fm['adoption_label'] || 'recommend'
    })
  }
  return out
}

/**
 * 適格な元提案から、人が選んだものだけを元提案にする。選ばなかった適格な提案は `excluded` として返す
 * （合成が昇格を完了するまで、昇格候補の競合の母数から外す）。`sourceIds` が未指定なら全件（従来と同じ）。
 * 指定があるときは適格な集合の部分集合で、空・未知の ID・重複でない不適格な ID があれば起動しない。
 */
export function chooseComposeSources(
  eligible: ComposeSourceInfo[],
  sourceIds?: unknown
): { ok: true; sources: ComposeSourceInfo[]; excluded: string[] } | { ok: false; error: string } {
  // 適格な集合に同じ request_id が 2 件あると、supersedes の集合比較と台帳の sources がずれる。曖昧なまま始めない
  const eligibleIds = new Set<string>()
  for (const s of eligible) {
    if (eligibleIds.has(s.requestId)) {
      return {
        ok: false,
        error: `同じ request_id「${s.requestId}」の提案が複数あるため、合成の元を決められません（重複の片方を整理してください）`
      }
    }
    eligibleIds.add(s.requestId)
  }
  if (sourceIds === undefined) return { ok: true, sources: eligible, excluded: [] }
  if (!Array.isArray(sourceIds) || sourceIds.some((x) => typeof x !== 'string' || x === '')) {
    return {
      ok: false,
      error: '合成の元にする提案の指定が不正です（空でない提案 ID の配列で指定します）'
    }
  }
  const wanted = sourceIds as string[]
  if (new Set(wanted).size !== wanted.length)
    return { ok: false, error: '合成の元にする提案の指定に重複があります' }
  if (wanted.length === 0)
    return { ok: false, error: '合成の元にする提案を 1 件以上選んでください' }
  const bad = wanted.filter((id) => !eligibleIds.has(id))
  if (bad.length > 0) {
    return {
      ok: false,
      error: `次の提案は合成の元に選べません（承認済みでない・別の合成に取り込み済みまたは昇格待ち・他の skill 宛てなど）: ${bad.join('、')}`
    }
  }
  const chosen = new Set(wanted)
  return {
    ok: true,
    sources: eligible.filter((s) => chosen.has(s.requestId)),
    excluded: eligible.filter((s) => !chosen.has(s.requestId)).map((s) => s.requestId)
  }
}

// ---- 着手の合図（L0_012） ----

const LAUNCH_NONCE_RE = new RegExp(`^[0-9a-f]{${COMPOSE_LAUNCH_NONCE_HEX_LEN}}$`)
const SHA256_HEX_RE = /^[0-9a-f]{64}$/

/** 起動ごとの固有の値（16 進 COMPOSE_LAUNCH_NONCE_HEX_LEN 桁） */
export function newLaunchNonce(): string {
  return randomBytes(COMPOSE_LAUNCH_NONCE_HEX_LEN / 2).toString('hex')
}

/**
 * 窓つきの合成 CC の着手の状況を作業場から読む。meta に launchNonceSha256 が無い（窓なしの巡・旧い作業場）なら undefined。
 * 合図のファイルが在り、COMPOSE_STARTED_FILE_MAX_BYTES 以下で、launchNonce が 16 進の決まった桁で、その sha256 が
 * meta の値と一致するときだけ 'working'。それ以外（無い・壊れている・違う値・大きすぎる・読めない）は 'waiting'（観測していない側）。
 * 段（running かどうか）は呼び出し側が見る
 */
export function readCcStart(
  dir: string,
  meta: { launchNonceSha256?: unknown } | null
): ComposeCcStart | undefined {
  const want = meta?.launchNonceSha256
  if (typeof want !== 'string' || !SHA256_HEX_RE.test(want)) return undefined
  const p = join(dir, COMPOSE_STARTED_FILE)
  let fd: number | null = null
  try {
    // 上限＋1 バイトまでしか読まない（確かめてから読む間に差し替えられても、大きな中身を読み込まない）
    fd = openSync(p, 'r')
    const buf = Buffer.alloc(COMPOSE_STARTED_FILE_MAX_BYTES + 1)
    const n = readSync(fd, buf, 0, buf.length, 0)
    if (n > COMPOSE_STARTED_FILE_MAX_BYTES) return 'waiting'
    const sig = JSON.parse(buf.subarray(0, n).toString('utf-8')) as { launchNonce?: unknown }
    const got = sig?.launchNonce
    if (typeof got !== 'string' || !LAUNCH_NONCE_RE.test(got)) return 'waiting'
    return sha256Hex(got) === want ? 'working' : 'waiting'
  } catch {
    return 'waiting'
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

// ---- 起動 ----

/** 窓を出さない改訂 AI の起動時の依頼文とモデル（CCPIT の再起動で起動し直すとき、同じ内容で再実行する） */
const HEADLESS_FILE = 'headless.json'
/** 旧形式の合成提案から続けた案件の第 1 巡で、レビュアーへ渡す持ち越しの指摘 */
const CARRIED_FILE = 'carried.json'

/** 案件の巡として始める指定（L0_011） */
export interface CaseStartInput {
  /** 省略 = この合成提案の ID（新しい案件の第 1 巡） */
  caseId?: string
  round: number
  /** 旧形式の合成提案から続けたときの、その ID（第 1 巡） */
  continuesFrom?: string
  /** 巡の予約の札。省略時は新しく採番する */
  token?: string
  /** 第 2 巡以降: 案件の記録がある作業場（第 1 巡） */
  caseDir?: string
  /** 第 1 巡（旧形式から続けたとき）: 持ち越しの指摘。作業場に残し、レビューの依頼文へ H1…Hn として渡す */
  carried?: CarriedFinding[]
}

export interface StartComposeDeps {
  paths: ComposePaths
  guard: ComposeGuardDirs
  proposalsDir: string
  language: 'ja' | 'en'
  /** 合成の対象の元提案（承認済みの候補から選んだもの） */
  sources: ComposeSourceInfo[]
  /** 選ばなかった提案の request_id（`chooseComposeSources` の戻り。改訂では旧エントリのものを引き継ぐ） */
  excluded?: string[]
  options?: DialogueLaunchOptions
  extraEnv?: Record<string, string>
  reader?: GoldenReader
  launch?: typeof launchCc
  now?: () => Date
  /** 改訂ルート: 旧合成提案の ID・MD の絶対パス・レビューの指摘の本文（`startRevise` が検査して渡す） */
  revision?: {
    compositeId: string
    previousFile: string
    findings: string
    previousAcksFile?: string
  }
  /** L0_011: 案件の巡として始める。改訂（revision あり）は launchHeadless で窓を出さずに起動する */
  caseStart?: CaseStartInput
  launchHeadless?: HeadlessLauncher
  runtime?: ComposeRuntime
  /** 作業場の状態が変わったとき（画面へ即時に知らせる） */
  onWorkspaceChange?: (workspaceDir: string) => void
}

export type StartComposeResult =
  | {
      ok: true
      workspaceDir: string
      compositeRequestId: string
      promptFilePath: string
      appliedFlags: string[]
      sourceIds: string[]
      caseId?: string
      round?: number
    }
  | { ok: false; error: string }

/** 作業場を失敗にする（結果を残し、占有を解き、案件の記録も失敗にする）。取消済みなら何もしない */
function failWorkspace(
  paths: ComposePaths,
  dir: string,
  skillName: string,
  stage: string,
  error: string,
  now: Date = new Date()
): void {
  if (existsSync(join(dir, CANCEL))) return
  try {
    writeFileSync(
      join(dir, RESULT),
      JSON.stringify(
        { ok: false, stage, error, finishedAt: now.toISOString() } satisfies ComposeResult,
        null,
        2
      ),
      'utf-8'
    )
  } catch {
    /* 書けなければ phase は running のまま残る。次の走査で再度扱われる */
  }
  releaseActiveCompose(paths, skillName, dir)
  const meta = readJson<ComposeMeta>(join(dir, META))
  const cd = meta ? caseDirOfWorkspace(paths, dir, meta) : null
  if (cd) {
    mutateCaseSync(
      cd,
      (c) => {
        c.status = 'failed'
        ;(c as CaseRecordX).error = `[${stage}] ${error}`
      },
      now
    )
  }
}

/**
 * 窓を出さない改訂 AI の終了を見張る。このプロセスが起動した印（generations）にもなる。
 * 終わったのに合図（out/READY.json）が無ければ失敗にする（取消済み・結果ありは何もしない）。
 */
function trackGeneration(
  rt: ComposeRuntime,
  paths: ComposePaths,
  dir: string,
  skillName: string,
  done: Promise<{ ok: boolean; error?: string }>,
  onChange?: (dir: string) => void
): void {
  const p: Promise<void> = Promise.resolve(done)
    .catch((err: unknown) => ({
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }))
    .then((res) => {
      try {
        const settled = existsSync(join(dir, CANCEL)) || existsSync(join(dir, RESULT))
        const ready = existsSync(join(dir, 'out', 'READY.json'))
        if (!settled && !ready) {
          failWorkspace(
            paths,
            dir,
            skillName,
            'generation',
            res.ok
              ? '改訂 AI が合図（out/READY.json）を書かずに終わりました'
              : `改訂 AI が失敗しました: ${res.error ?? '原因不明'}`
          )
          onChange?.(dir)
        }
      } finally {
        if (rt.generations.get(dir) === p) rt.generations.delete(dir)
      }
    })
  rt.generations.set(dir, p)
}

export function startCompose(skillName: string, d: StartComposeDeps): StartComposeResult {
  if (d.sources.length === 0) {
    return {
      ok: false,
      error: `「${skillName}」宛ての承認済みの提案がありません（レビューで approve になった提案が合成の対象です）`
    }
  }
  const cs = d.caseStart
  // 第 3 巡の後は、どの経路でも作業場を作らない（次の巡の起動の最後の関門）
  if (cs && cs.round > COMPOSE_ROUND_MAX)
    return {
      ok: false,
      error: `第 ${COMPOSE_ROUND_MAX} 巡の後は次の巡を始めません（第 ${cs.round} 巡の指定）`
    }
  const headless = !!(cs && d.revision)
  if (headless && !d.launchHeadless)
    return { ok: false, error: '窓を出さない改訂 AI の起動口（launchHeadless）が渡されていません' }
  for (const s of d.sources) {
    let raw = ''
    try {
      raw = readFileSync(s.filePath, 'utf-8')
    } catch {
      return { ok: false, error: `元提案 ${s.requestId} の MD を読めません: ${s.filePath}` }
    }
    const unsupported = detectUnsupportedSource(raw)
    if (unsupported) {
      return {
        ok: false,
        error: `元提案 ${s.requestId} は合成できません（ファイルの削除・改名は本件の対象外です）: ${unsupported}`
      }
    }
  }
  const now = (d.now ?? ((): Date => new Date()))()
  const reader = d.reader ?? makeGitGoldenReader(d.guard.repoDir)
  let ws: ComposeWorkspace
  try {
    ws = createComposeWorkspace({
      paths: d.paths,
      skillName,
      reader,
      sources: d.sources,
      now: () => now.getTime()
    })
  } catch (err) {
    // golden を git から読めなかった。golden の読み取りは作業場を作る前なので、止まったとき何も残っていない
    if (err instanceof GoldenReadError) return { ok: false, error: err.message }
    throw err
  }
  const claim = claimActiveCompose(d.paths, skillName, ws.dir)
  if (!claim.ok) {
    rmSync(ws.dir, { recursive: true, force: true })
    return { ok: false, error: claim.error }
  }
  const fail = (error: string): StartComposeResult => {
    releaseActiveCompose(d.paths, skillName, ws.dir)
    rmSync(ws.dir, { recursive: true, force: true })
    return { ok: false, error }
  }
  try {
    const wsSettings = buildWorkspaceSettings(guardPathsForSettings(d.guard))
    writeWorkspaceSettings(ws, wsSettings)
    // 窓を出さない改訂 AI は `--settings=<作業場>/.claude/settings.json` を読む。権限規則は同じものを置く
    if (headless) {
      writeFileSync(
        join(ws.dir, '.claude', 'settings.json'),
        JSON.stringify(wsSettings, null, 2) + '\n',
        'utf-8'
      )
    }
    takeGuardState(ws, d.guard)

    // 適応の鍵の一覧（合成 CC が鍵を推測せず、ここから写す）。元提案が読めない／golden が無いときは一覧なしで進める
    const keyList = listSourceAdaptationKeys(d.sources, reader, skillName)
    const adaptationKeys = 'keys' in keyList ? keyList.keys : []
    const adaptationKeysFile = join(ws.dir, 'adaptation-keys.json')
    writeFileSync(
      adaptationKeysFile,
      JSON.stringify(
        {
          note: 'adapted_hunks と acks.json に書く鍵は、ここの key をそのまま写す（推測しない）',
          keys: adaptationKeys
        },
        null,
        2
      ),
      'utf-8'
    )

    // 改訂: 旧合成の写しと、レビューの指摘の本文（非命令データ）を作業場の previous/ へ置く
    let revisionInput:
      | {
          compositeId: string
          previousPath: string
          findingsPath: string
          previousAcksPath?: string
        }
      | undefined
    if (d.revision) {
      const prevDir = join(ws.dir, 'previous')
      mkdirSync(prevDir, { recursive: true })
      const previousPath = join(
        prevDir,
        `${d.revision.compositeId.replace(/[^A-Za-z0-9._-]/g, '_')}.md`
      )
      writeFileSync(previousPath, readFileSync(d.revision.previousFile, 'utf-8'), 'utf-8')
      const findingsPath = join(prevDir, 'review-findings.md')
      writeFileSync(findingsPath, d.revision.findings, 'utf-8')
      let previousAcksPath: string | undefined
      if (d.revision.previousAcksFile && existsSync(d.revision.previousAcksFile)) {
        previousAcksPath = join(prevDir, 'acks.json')
        copyFileSync(d.revision.previousAcksFile, previousAcksPath)
      }
      revisionInput = {
        compositeId: d.revision.compositeId,
        previousPath,
        findingsPath,
        ...(previousAcksPath ? { previousAcksPath } : {})
      }
    }

    const safeSkill = skillName.replace(/[^A-Za-z0-9._-]/g, '-')
    // 同じ分に始めた合成（改訂など）で台帳の ID と重ならないようにする
    const usedIds = new Set(Object.keys(readMergeLedger(d.paths.mergesPath).entries))
    const baseId = `${safeSkill}-compose-${stamp(now)}`
    let compositeRequestId = baseId
    for (let n = 2; usedIds.has(compositeRequestId); n++) compositeRequestId = `${baseId}-${n}`
    // L0_012: 窓つきの起動だけ、着手の合図に使う固有の値を発行する（依頼文にだけ平文で埋め、meta には sha256 だけ）
    const launchNonce = headless ? undefined : newLaunchNonce()
    const packet = buildComposePacket({
      generatedAt: now.toISOString(),
      language: d.language,
      skillName,
      workspaceDir: ws.dir,
      goldenDir: ws.goldenDir,
      sourcesDir: ws.sourcesDir,
      outDir: ws.outDir,
      snapshotSha: ws.snapshotSha,
      compositeRequestId,
      adaptationKeysFile,
      ...(revisionInput ? { revision: revisionInput } : {}),
      ...(launchNonce
        ? { startSignal: { file: join(ws.dir, COMPOSE_STARTED_FILE), nonce: launchNonce } }
        : {}),
      sources: d.sources.map((s) => ({
        requestId: s.requestId,
        title: s.title,
        adoptionLabel: s.adoptionLabel,
        copyPath: join(ws.sourcesDir, `${s.requestId.replace(/[^A-Za-z0-9._-]/g, '_')}.md`)
      }))
    })
    writeFileSync(ws.requestFile, packet, 'utf-8')
    // 起動プロンプトは ASCII のみ（起動 .ps1 の CP932 問題）。作業場のパスが非 ASCII なら、依頼の写しを ASCII の temp へ置く
    let promptFilePath = ws.requestFile
    if (!isPrintableAscii(promptFilePath)) {
      const dir = asciiSafeTempDir()
      mkdirSync(dir, { recursive: true })
      promptFilePath = join(dir, `ccpit-compose-${sha256Hex(ws.dir).slice(0, 12)}.md`)
      writeFileSync(promptFilePath, packet, 'utf-8')
    }
    // 利用者の設定の skipPermissions・permissionMode は渡さない（合成は許可モードを acceptEdits に固定し、Bypass を使わない）
    const plan = buildComposeLaunchPlan({
      promptFilePath,
      workspaceDir: ws.dir,
      model: d.options?.model,
      effort: d.options?.effort
    })
    const caseId = cs ? (cs.caseId ?? compositeRequestId) : undefined
    const token = cs ? (cs.token ?? newToken()) : undefined
    const meta: ComposeMeta = {
      skillName,
      compositeRequestId,
      sources: d.sources,
      guard: d.guard,
      proposalsDir: d.proposalsDir,
      startedAt: now.toISOString(),
      language: d.language,
      promptFilePath,
      ...(d.revision ? { revises: d.revision.compositeId } : {}),
      ...(d.excluded && d.excluded.length > 0 ? { excluded: [...new Set(d.excluded)].sort() } : {}),
      ...(launchNonce ? { launchNonceSha256: sha256Hex(launchNonce) } : {}),
      ...(cs && caseId && token
        ? {
            caseId,
            round: cs.round,
            token,
            ...(cs.continuesFrom ? { continuesFrom: cs.continuesFrom } : {}),
            ...(cs.round > 1 && cs.caseDir ? { caseDir: cs.caseDir } : {}),
            ...(headless ? { headless: true } : {})
          }
        : {})
    }
    writeFileSync(join(ws.dir, META), JSON.stringify(meta, null, 2), 'utf-8')
    if (cs && caseId && token && cs.round === 1) {
      // 案件の記録は第 1 巡の作業場の中（新しい実データのパスを作らない）
      writeCaseSync(
        ws.dir,
        newCaseRecord({
          caseId,
          skillName,
          ...(cs.continuesFrom ? { continuesFrom: cs.continuesFrom } : {}),
          now,
          first: {
            round: 1,
            state: 'launched',
            token,
            reservedAt: now.toISOString(),
            ownerPid: process.pid,
            workspaceDir: ws.dir,
            compositeId: compositeRequestId,
            generationAttempts: 1
          }
        }),
        now
      )
    }
    if (cs?.carried && cs.carried.length > 0) {
      writeFileSync(join(ws.dir, CARRIED_FILE), JSON.stringify(cs.carried, null, 2), 'utf-8')
    }

    if (headless && d.launchHeadless) {
      const promptText = plan.prompt
      writeFileSync(
        join(ws.dir, HEADLESS_FILE),
        JSON.stringify({ promptText, model: d.options?.model ?? null }, null, 2),
        'utf-8'
      )
      const hr = d.launchHeadless({
        workspaceDir: ws.dir,
        promptText,
        ...(d.options?.model ? { model: d.options.model } : {}),
        ...(d.extraEnv ? { extraEnv: d.extraEnv } : {})
      })
      if (!hr.started) return fail(hr.error)
      trackGeneration(
        d.runtime ?? runtimeFor(d.paths),
        d.paths,
        ws.dir,
        skillName,
        hr.done,
        d.onWorkspaceChange
      )
    } else {
      const launchArgs: LaunchArgs = { projectPath: ws.dir, flags: plan.flags }
      const res = (d.launch ?? launchCc)(launchArgs, { ...plan.injectEnv, ...(d.extraEnv ?? {}) })
      if (!res.spawned) return fail(res.error ?? 'Claude Code を起動できませんでした')
    }
    return {
      ok: true,
      workspaceDir: ws.dir,
      compositeRequestId,
      promptFilePath,
      appliedFlags: plan.flags.filter((f) => f !== DIALOGUE_PROMPT_FLAG),
      sourceIds: d.sources.map((s) => s.requestId),
      ...(caseId ? { caseId } : {}),
      ...(cs ? { round: cs.round } : {})
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
}

// ---- 改訂（登録済みの合成提案を、レビューの指摘を反映して再合成する） ----

export interface PreparedRevision {
  entry: MergeEntry
  previousFile: string
  sources: ComposeSourceInfo[]
}

/**
 * 改訂の前提の検査と、入力（旧合成提案の MD・元提案）の確定。台帳に在って registered・未改訂で、MD と元提案が登録時のまま。
 * `reviewCheck` は「未改訂」の検査の直後に呼ぶ（startRevise は、レビューが approve でないことをここで確かめる）。
 */
export function prepareRevision(
  compositeId: string,
  d: { paths: ComposePaths; proposalsDir: string },
  reviewCheck?: () => string | null
): ({ ok: true } & PreparedRevision) | { ok: false; error: string } {
  const entry = readMergeLedger(d.paths.mergesPath).entries[compositeId]
  if (!entry)
    return { ok: false, error: `合成提案「${compositeId}」が合成台帳に無いため改訂できません` }
  if (entry.status !== 'registered')
    return {
      ok: false,
      error: `合成提案「${compositeId}」は適用済み（${entry.status}）のため改訂できません`
    }
  if (entry.revisedBy)
    return {
      ok: false,
      error: `合成提案「${compositeId}」は既に ${entry.revisedBy} に改訂されています。新しい方を改訂してください`
    }
  const reviewError = reviewCheck?.() ?? null
  if (reviewError) return { ok: false, error: reviewError }
  let names: string[] = []
  try {
    names = readdirSync(d.proposalsDir)
  } catch {
    names = []
  }
  const file = names.find((n) => n.endsWith(`_${compositeId}.md`))
  if (!file)
    return { ok: false, error: `合成提案の MD が提案プールに見つかりません（${compositeId}）` }
  const previousFile = join(d.proposalsDir, file)
  let prevRaw = ''
  try {
    prevRaw = readFileSync(previousFile, 'utf-8')
  } catch {
    return { ok: false, error: `合成提案の MD を読めません: ${previousFile}` }
  }
  if (sha256Hex(prevRaw.replace(/\r\n/g, '\n')) !== entry.proposalSha256)
    return {
      ok: false,
      error: '合成提案の MD が登録後に変わっています。通常の合成からやり直してください'
    }
  const sources: ComposeSourceInfo[] = []
  for (const s of entry.sources) {
    let raw = ''
    try {
      raw = readFileSync(s.filePath, 'utf-8')
    } catch {
      return { ok: false, error: `元提案 ${s.requestId} の MD を読めません: ${s.filePath}` }
    }
    if (sha256Hex(raw.replace(/\r\n/g, '\n')) !== s.sha256)
      return {
        ok: false,
        error: `元提案 ${s.requestId} が登録後に変わっています。通常の合成からやり直してください`
      }
    const fm = readFm(raw)
    sources.push({
      requestId: s.requestId,
      filePath: s.filePath,
      skillName: s.skillName,
      title: fm['title'] || s.requestId,
      adoptionLabel: fm['adoption_label'] || 'recommend'
    })
  }
  return { ok: true, entry, previousFile, sources }
}

export interface StartReviseDeps extends Omit<
  StartComposeDeps,
  'sources' | 'revision' | 'caseStart'
> {
  /** 提案のレビュー記録（proposal-reviews.json）の 1 件。無ければ undefined */
  getReview: (requestId: string) => { verdict?: string; findings?: string } | undefined
  /**
   * L0_011: 旧形式の合成提案の改訂を、新しい案件の第 1 巡として窓を出さずに始める。
   * `carried` は旧の合成提案の台帳の findings から切り出した持ち越しの指摘（H1…）。`buildDoc` は改訂 AI へ渡す指摘の本文を作る
   */
  asCase?: {
    carried: CarriedFinding[]
    buildDoc?: typeof buildRevisionFindingsDoc
  }
}

/**
 * 改訂の起動。旧合成が登録済み・未改訂・未適用で、レビューが approve でない（指摘がある）ときだけ。
 * 元提案は台帳の旧エントリから取る（旧合成が有効な間、元提案は候補から外れているため）。元提案と旧合成の MD は
 * 登録時の sha256 と一致していること（変わっていれば、改訂でなく通常の合成からやり直す）。
 * `asCase` と launchHeadless があれば、新しい案件の第 1 巡として窓を出さずに起動する。
 */
export function startRevise(compositeId: string, d: StartReviseDeps): StartComposeResult {
  let review: { verdict?: string; findings?: string } | undefined
  const prep = prepareRevision(compositeId, d, () => {
    review = d.getReview(compositeId)
    if (!review || !review.verdict)
      return '合成提案のレビュー記録がありません（レビューが終わってから改訂します）'
    if (review.verdict === 'approve')
      return '合成提案は approve のため改訂せず、昇格画面で承認してください'
    return null
  })
  if (!prep.ok) return prep
  const { entry, previousFile, sources } = prep
  const { getReview: _unused, asCase, ...rest } = d
  void _unused
  const asCaseOn = !!asCase && !!d.launchHeadless
  const findings = asCaseOn
    ? (asCase!.buildDoc ?? buildRevisionFindingsDoc)({
        previousCompositeId: compositeId,
        findings: [],
        humanRejections: [],
        originChoices: [],
        addressBase: false,
        acksNote:
          d.language === 'ja'
            ? '旧合成提案の適応の選択を引き継ぐ'
            : 'carry over the adaptation choices of the previous composite',
        carried: asCase!.carried
      })
    : ((review as { findings?: string } | undefined)?.findings ?? '')
  return startCompose(entry.skillName, {
    ...rest,
    sources,
    // 選ばなかった提案は旧エントリのものを引き継ぐ（引き継がないと、改訂の登録後に競合の母数へ戻る）
    ...(entry.excluded && entry.excluded.length > 0 ? { excluded: entry.excluded } : {}),
    revision: { compositeId, previousFile, findings },
    ...(asCaseOn
      ? {
          caseStart: { round: 1, continuesFrom: compositeId, carried: asCase!.carried }
        }
      : {})
  })
}

// ---- 終了後の検査・登録・レビュー ----

/** 次の巡の起動・復旧に要るもの（無ければ、予約までで止める。poller の復旧が後で拾う） */
export interface RoundsDeps {
  launchHeadless?: HeadlessLauncher
  /** 合成の設定（モデル・effort）。巡ごとに読み直す */
  getOptions?: () => DialogueLaunchOptions | undefined
  resolveExtraEnv?: () => Promise<Record<string, string> | undefined>
  /** 改訂 AI へ渡す指摘の本文の組み立て（既定は goldenMergeConsult.buildRevisionFindingsDoc） */
  buildRevisionFindingsDoc?: typeof buildRevisionFindingsDoc
  /** レビュアーの生の本文から指摘のブロックを取る（既定は composeReviewClassify.parseReviewerOutput） */
  parseReviewerOutput?: typeof parseReviewerOutput
  reader?: GoldenReader
  /** 予約の持ち主のプロセスが生きているか（既定は process.kill(pid, 0)） */
  isAlive?: (pid: number) => boolean
}

export interface FinalizeDeps {
  paths: ComposePaths
  /**
   * 独立レビューの実行（登録した提案 MD を渡す）。テストで差し替える。
   * 案件（caseId を持つ作業場）のときだけ第 2 引数に文脈を渡し、由来つきの ComposeReviewOutcome を受け取る。
   * 旧形式の作業場には渡さず、従来の { status, verdict, message } を受け取る。
   */
  runReview?: (
    filePath: string,
    ctx?: ComposeReviewContext
  ) => Promise<ComposeReview | ComposeReviewOutcome>
  reader?: GoldenReader
  lockDeps?: FileLockDeps
  now?: () => Date
  /** 段の切替（checking／reviewing）や新しい巡の起動のたびに呼ぶ（画面へ即時に知らせる） */
  onStage?: (workspaceDir: string) => void
  /** 台帳の行を読む（束縛の照合・画面の指摘）。省略時は reviewsPath から読む */
  readReviewRow?: ReviewRowReader
  /** proposal-reviews.json のパス */
  reviewsPath?: string
  rounds?: RoundsDeps
  /** 実行時の状態（既定は ~/.ccpit ごとの共有）。試験は CCPIT の再起動を、新しい runtime で模す */
  runtime?: ComposeRuntime
}

function readWorkspace(dir: string): {
  ws: Pick<ComposeWorkspace, 'dir' | 'guardDir' | 'outDir' | 'snapshotText' | 'snapshotSha'>
  meta: ComposeMeta
} | null {
  const meta = readJson<ComposeMeta>(join(dir, META))
  if (!meta) return null
  const snapshotText = readFileSync(join(dir, 'snapshot.json'), 'utf-8')
  return {
    meta,
    ws: {
      dir,
      guardDir: join(dir, 'guard'),
      outDir: join(dir, 'out'),
      snapshotText,
      snapshotSha: sha256Hex(snapshotText)
    }
  }
}

/** 提案プールの中の、合成提案 MD（`<時刻>_<ID>.md` または `<ID>.md`） */
function findCompositeFile(proposalsDir: string, id: string): string | null {
  let names: string[] = []
  try {
    names = readdirSync(proposalsDir)
  } catch {
    names = []
  }
  const n = names.find((x) => x.endsWith(`_${id}.md`) || x === `${id}.md`)
  return n ? join(proposalsDir, n) : null
}

const ZERO_COUNTS: OriginCounts = { diff: 0, base: 0, unclear: 0 }

function summarizeOutcome(o: ComposeReviewOutcome): ComposeReview {
  return {
    status: 'ok',
    ...(o.verdict ? { verdict: o.verdict } : {}),
    counts: { ...o.counts },
    findings: o.findings.map((f) => ({
      reviewerNo: f.reviewerNo,
      gateId: f.gateId,
      origin: f.origin,
      severity: f.severity,
      title: f.title,
      where: f.where
    }))
  }
}

/** 受け皿の持ち主の既定: 元提案（先頭）の起票者。分からなければ既定の持ち主（空にしない） */
function receptacleOwner(meta: ComposeMeta): string {
  for (const s of meta.sources) {
    try {
      const fm = readFm(readFileSync(s.filePath, 'utf-8'))
      const o = (fm['author'] || fm['issuer'] || '').trim()
      if (o) return o
    } catch {
      /* 読めなければ次の元提案 */
    }
  }
  return RECEPTACLE_DEFAULT_OWNER
}

/** 前の巡のうち、台帳の行（独立レビューの結果）が残っている最後のもの。停止 (e) の巡を飛ばして遡る */
export function findPrevReviewed(
  rec: ComposeCaseRecord,
  round: number,
  readRow: ReviewRowReader | undefined
): { round: number; counts?: OriginCounts; row: ReviewRow } | undefined {
  if (!readRow) return undefined
  for (let r = round - 1; r >= 1; r--) {
    const rr = rec.rounds.find((x) => x.round === r)
    if (!rr?.compositeId) continue
    const row = readRow(rr.compositeId)
    if (row && row.reviewScope?.kind === 'compose-diff') return { round: r, counts: rr.counts, row }
  }
  return undefined
}

function buildReviewContext(i: {
  dir: string
  meta: ComposeMeta
  rec: ComposeCaseRecord
  round: number
  readRow: ReviewRowReader | undefined
  section1: Section1Row[] | null
}): ComposeReviewContext {
  const prev = findPrevReviewed(i.rec, i.round, i.readRow)
  const history = prev
    ? buildHistoryItems(prev.row, prev.round, i.section1, i.rec.humanRejections)
    : []
  const carried = i.round === 1 ? (readJson<CarriedFinding[]>(join(i.dir, CARRIED_FILE)) ?? []) : []
  return {
    caseId: i.meta.caseId ?? '',
    round: i.round,
    workspaceDir: i.dir,
    goldenDir: join(i.dir, 'golden'),
    skillName: i.meta.skillName,
    history,
    carried,
    owner: receptacleOwner(i.meta),
    sourceIds: i.meta.sources.map((s) => s.requestId)
  }
}

/** 作業場の snapshot.json は可変なので、起動時に meta へ写した sha256 ではなく、再計測との照合に使う（registerComposite が行う） */
export async function finalizeWorkspace(dir: string, d: FinalizeDeps): Promise<ComposeResult> {
  const nowFn = d.now ?? ((): Date => new Date())
  const now = nowFn()
  let loaded: ReturnType<typeof readWorkspace> = null
  try {
    loaded = readWorkspace(dir)
  } catch {
    loaded = null
  }
  const done = (r: ComposeResult): ComposeResult => {
    writeFileSync(join(dir, RESULT), JSON.stringify(r, null, 2), 'utf-8')
    return r
  }
  if (!loaded)
    return done({
      ok: false,
      stage: 'meta',
      error: '作業場の meta.json が読めません',
      finishedAt: now.toISOString()
    })
  const { ws, meta } = loaded
  const rt = d.runtime ?? runtimeFor(d.paths)
  const caseDir = meta.caseId ? caseDirOfWorkspace(d.paths, dir, meta) : null
  const round = meta.round ?? 1
  const readRow: ReviewRowReader | undefined =
    d.readReviewRow ?? (d.reviewsPath ? makeRawReviewRowReader(d.reviewsPath) : undefined)
  let followUp: (() => Promise<void>) | undefined
  let busy = false
  const busyResult = (error: string): ComposeResult => {
    busy = true
    return { ok: false, stage: 'busy', error, finishedAt: now.toISOString() }
  }

  const tick = (stage: 'checking' | 'reviewing'): void => {
    // 段の印は案件の作業場だけに書く（旧形式の作業場の失敗経路は、result.json と占有の記録以外を触らないと既存の試験が固定している）
    if (caseDir) {
      try {
        writeStage(dir, stage, nowFn())
      } catch {
        /* 段の印は画面の表示用。書けなくても検査・登録は続ける */
      }
    }
    d.onStage?.(dir)
  }
  /** 失敗の結果を残す。案件の作業場なら案件の記録も失敗にする（取消済みは変えない） */
  const failDone = (r: ComposeResult): ComposeResult => {
    if (caseDir) {
      mutateCaseSync(caseDir, (c) => {
        if (c.status === 'cancelled') return
        c.status = 'failed'
        ;(c as CaseRecordX).error = `[${r.stage ?? 'finalize'}] ${r.error ?? ''}`
      })
    }
    return done(r)
  }

  const run = async (): Promise<ComposeResult> => {
    const ready = readJson<{ compositeFile?: string }>(join(dir, 'out', 'READY.json'))
    if (!ready?.compositeFile) {
      return failDone({
        ok: false,
        stage: 'parse',
        error: 'out/READY.json に compositeFile が無い',
        finishedAt: now.toISOString()
      })
    }
    const compositeFile = join(dir, ready.compositeFile.replace(/\\/g, '/'))
    const acks = readJson<{ ackedAdaptations?: unknown }>(join(dir, 'out', 'acks.json'))
    const ackedAdaptations = Array.isArray(acks?.ackedAdaptations)
      ? acks!.ackedAdaptations.filter((x): x is string => typeof x === 'string')
      : []

    if (caseDir) {
      await updateCase(
        d.paths,
        meta.skillName,
        caseDir,
        (c) => {
          const r = c.rounds.find((x) => x.round === round)
          if (r && r.state === 'launched') r.state = 'ready'
        },
        d.lockDeps
      )
    }

    // 登録の後で止まっていた（台帳に合成提案が在る）なら、登録をやり直さずレビューから再開する
    const existing = caseDir
      ? readMergeLedger(d.paths.mergesPath).entries[meta.compositeRequestId]
      : undefined
    let reg: { compositeId: string; filePath: string; adapted: AdaptedListItem[] }
    if (existing) {
      const fp = findCompositeFile(meta.proposalsDir, existing.compositeId)
      if (!fp) {
        return failDone({
          ok: false,
          stage: 'registered',
          error: `登録済みの合成提案の MD が提案プールに見つからない（${existing.compositeId}）`,
          finishedAt: now.toISOString()
        })
      }
      reg = { compositeId: existing.compositeId, filePath: fp, adapted: [] }
    } else {
      const guard = loadGuardState(ws, meta.guard)
      if (!guard) {
        return failDone({
          ok: false,
          stage: 'guard',
          error: '起動前の目録が作業場に残っていないため、範囲外書込みを検査できない。登録しない',
          finishedAt: now.toISOString()
        })
      }
      tick('checking')
      const r = await finalizeCompose({
        paths: d.paths,
        workspace: ws,
        reader: d.reader ?? makeGitGoldenReader(meta.guard.repoDir),
        proposalsDir: meta.proposalsDir,
        compositeFile,
        sources: meta.sources,
        ackedAdaptations,
        ...(meta.revises ? { revises: meta.revises } : {}),
        ...(meta.excluded && meta.excluded.length > 0 ? { excluded: meta.excluded } : {}),
        guard,
        now: () => now,
        lockDeps: d.lockDeps
      })
      if (!r.ok) {
        // 別の CCPIT が同時に同じ作業場を登録し終えていた（台帳に合成提案が在る）なら、失敗でなくレビューの段へ進む
        const raced = caseDir
          ? readMergeLedger(d.paths.mergesPath).entries[meta.compositeRequestId]
          : undefined
        const racedFile = raced ? findCompositeFile(meta.proposalsDir, raced.compositeId) : null
        if (raced && racedFile) {
          reg = { compositeId: raced.compositeId, filePath: racedFile, adapted: [] }
        } else {
          const unsat =
            'unsatisfied' in r && Array.isArray(r.unsatisfied) ? r.unsatisfied : undefined
          return failDone({
            ok: false,
            stage: r.stage,
            error: r.error,
            ...(unsat
              ? {
                  unsatisfied: unsat.map((u) => ({
                    key: u.key,
                    reason: u.reason,
                    preview: u.preview
                  }))
                }
              : {}),
            finishedAt: now.toISOString()
          })
        }
      } else {
        reg = { compositeId: r.compositeId, filePath: r.filePath, adapted: r.adapted }
        const registered = reg
        if (caseDir) {
          await updateCase(
            d.paths,
            meta.skillName,
            caseDir,
            (c) => {
              const rr = c.rounds.find((x) => x.round === round)
              if (rr) {
                rr.state = 'registered'
                rr.compositeId = registered.compositeId
              }
            },
            d.lockDeps
          )
        }
      }
    }

    // ---- 旧形式の作業場: 従来どおり ----
    if (!caseDir) {
      let review: ComposeReview | undefined
      if (d.runReview) {
        tick('reviewing')
        try {
          const res = await d.runReview(reg.filePath)
          review = isReviewOutcome(res) ? summarizeOutcome(res) : res
        } catch (err) {
          review = {
            status: 'launch-failed',
            message: err instanceof Error ? err.message : String(err)
          }
        }
      }
      return done({
        ok: true,
        compositeId: reg.compositeId,
        filePath: reg.filePath,
        adapted: reg.adapted,
        ...(review ? { review } : {}),
        finishedAt: now.toISOString()
      })
    }

    // ---- 案件の巡 ----
    const rec0 = readCase(caseDir)
    if (!rec0) {
      return failDone({
        ok: false,
        stage: 'case',
        error: '案件の記録（case.json）が読めない',
        finishedAt: now.toISOString()
      })
    }
    const prev = findPrevReviewed(rec0, round, readRow)
    const prevInfo: PrevRoundInfo | undefined = prev
      ? prevInfoFromRow(prev.row, prev.round, prev.counts)
      : undefined
    const compRaw = readFileSync(reg.filePath, 'utf-8')
    const currentHash = sha256Hex(compRaw)
    const okResult = (review: ComposeReview): ComposeResult =>
      done({
        ok: true,
        compositeId: reg.compositeId,
        filePath: reg.filePath,
        adapted: reg.adapted,
        review,
        finishedAt: now.toISOString()
      })

    // 改訂の巡: §1 の採否の表。前回の指摘の行が欠ける・由来を確定できないなら、レビューを走らせず 1 問
    let section1Rows: Section1Row[] | null = null
    if (meta.revises) {
      section1Rows = parseSection1Table(compRaw)
      const v = evaluateSection1(section1Rows, prevInfo)
      if (!v.ok) {
        const counts: OriginCounts = { diff: 0, base: 0, unclear: v.count }
        const synth: ComposeReviewOutcome = { status: 'ok', findings: [], counts }
        const stopQ = buildStopQuestion(
          'stop-e',
          withSection1(rec0, round, section1Rows),
          synth,
          prevInfo
        )
        await updateCase(
          d.paths,
          meta.skillName,
          caseDir,
          (c) => {
            if (c.status === 'cancelled') return
            applyDecision(c, {
              round,
              decision: 'stop-e',
              counts,
              stop: stopQ,
              compositeId: reg.compositeId,
              ...(section1Rows ? { section1: section1Rows } : {}),
              now: nowFn(),
              ownerPid: process.pid
            })
          },
          d.lockDeps
        )
        return okResult({ status: 'not-run', message: `停止 (e): ${v.detail}` })
      }
    }

    if (!d.runReview) {
      return failDone({
        ok: false,
        stage: 'review',
        error: '独立レビューの実行口が設定されていないため、判定できない',
        finishedAt: now.toISOString()
      })
    }

    // 独立レビュー（1 巡あたり 1 回）。台帳に、この巡・この合成提案のレビューの行が既にあれば、走らせずにそれを使う
    tick('reviewing')
    let outcome: ComposeReviewOutcome | undefined
    let review: ComposeReview | undefined
    let bound = true
    const reviewedRow = (): ReviewRow | undefined => {
      const row = readRow?.(reg.compositeId)
      const sc = row?.reviewScope
      return row &&
        sc?.kind === 'compose-diff' &&
        sc.caseId === meta.caseId &&
        sc.round === round &&
        sc.proposalHash === currentHash
        ? row
        : undefined
    }
    // 起動権: ロックの下で、台帳の行が無く、別の CCPIT が起動権を持っていないことを確かめて取る。
    // 持っているのが別の生きたプロセスなら、レビューを走らせず待つ（1 巡あたり 1 回を、プロセスをまたいで保つ）
    let busyElsewhere = false
    let doneElsewhere: ReviewRow | undefined
    if (!reviewedRow()) {
      const isAlive = d.rounds?.isAlive ?? defaultIsAlive
      await updateCase(
        d.paths,
        meta.skillName,
        caseDir,
        (c) => {
          const r = c.rounds.find((x) => x.round === round) as RoundRecordX | undefined
          if (!r) return
          doneElsewhere = reviewedRow()
          if (doneElsewhere) return
          const holder = r.reviewClaim
          // 持ち主が別のランタイム（= 別のプロセス）で、そのプロセスが生きている間は待つ
          if (holder && holder.owner !== rt.id && isAlive(holder.pid)) {
            busyElsewhere = true
            return
          }
          r.reviewClaim = { pid: process.pid, owner: rt.id, at: nowFn().toISOString() }
        },
        d.lockDeps
      )
    }
    if (busyElsewhere)
      return busyResult('別の CCPIT がこの巡のレビューを実行中です。終わるのを待ちます')
    const doneRow = doneElsewhere ?? reviewedRow()
    if (doneRow) {
      outcome = outcomeFromRow(doneRow)
    } else {
      const ctx = buildReviewContext({
        dir,
        meta,
        rec: rec0,
        round,
        readRow,
        section1: section1Rows
      })
      try {
        const res = await d.runReview(reg.filePath, ctx)
        if (isReviewOutcome(res)) {
          outcome = res
        } else {
          // 旧形式の戻り（由来を持たない）。approve だけは判定に使えるが、台帳の行の束縛は照合できない
          review = res
          bound = false
          if (res.status === 'ok' && res.verdict === 'approve') {
            outcome = { status: 'ok', verdict: 'approve', findings: [], counts: { ...ZERO_COUNTS } }
          }
        }
      } catch (err) {
        review = {
          status: 'launch-failed',
          message: err instanceof Error ? err.message : String(err)
        }
      }
    }
    if (outcome && outcome.status !== 'ok') {
      review = { status: outcome.status, ...(outcome.message ? { message: outcome.message } : {}) }
      outcome = undefined
    }
    if (!outcome) {
      const why = review?.message ?? review?.status ?? '結果なし'
      mutateCaseSync(caseDir, (c) => {
        if (c.status === 'cancelled') return
        c.status = 'failed'
        ;(c as CaseRecordX).error = `[review] ${why}`
      })
      return okResult(review ?? { status: 'launch-failed' })
    }
    // 束縛の照合: 台帳の行の reviewScope・proposal_hash・adjudicationsFor と、合成提案 MD の現在のハッシュ
    if (bound) {
      const err = checkReviewBinding(readRow?.(reg.compositeId), {
        caseId: meta.caseId ?? '',
        round,
        currentHash,
        ...(outcome.verdict ? { verdict: outcome.verdict } : {})
      })
      if (err) {
        return failDone({
          ok: false,
          stage: 'review-binding',
          error: `判定しません。レビューの束縛が合っていません: ${err}`,
          finishedAt: now.toISOString()
        })
      }
    }

    const rec = withSection1(readCase(caseDir) ?? rec0, round, section1Rows)
    const decision = decideAfterReview(rec, outcome, prevInfo)
    const stopQ = buildStopQuestion(decision, rec, outcome, prevInfo)
    let reserved: number | undefined
    await updateCase(
      d.paths,
      meta.skillName,
      caseDir,
      (c) => {
        if (c.status === 'cancelled') return
        const a = applyDecision(c, {
          round,
          decision,
          counts: outcome!.counts,
          stop: stopQ,
          compositeId: reg.compositeId,
          ...(section1Rows ? { section1: section1Rows } : {}),
          now: nowFn(),
          ownerPid: process.pid
        })
        if (a.reservedRound) {
          reserved = a.reservedRound
          // 判定の直後に、同じプロセスの poller が予約を拾って二重に起動しないよう、起動中の印を同じ更新の中で付ける
          rt.launching.add(`${c.caseId}#${a.reservedRound}`)
        }
      },
      d.lockDeps
    )
    if (reserved !== undefined) {
      const next = reserved
      const caseId = meta.caseId ?? ''
      if (d.rounds) {
        followUp = async () => {
          await launchReservedRound({
            paths: d.paths,
            caseDir,
            caseId,
            skillName: meta.skillName,
            round: next,
            rounds: d.rounds!,
            runtime: rt,
            ...(readRow ? { readRow } : {}),
            ...(d.lockDeps ? { lockDeps: d.lockDeps } : {}),
            ...(d.onStage ? { onChange: d.onStage } : {})
          })
        }
      } else {
        // 起動口が無い。予約は残す（poller の復旧が、起動口のある実行で拾う）
        rt.launching.delete(`${caseId}#${next}`)
      }
    }
    // 旧形式の戻り（由来を持たない）で判定したときは、その戻りをそのまま残す
    return okResult(!bound && review ? review : summarizeOutcome(outcome))
  }

  // 同じプロセスで同じ作業場を二重に finalize しない（2 つ目は何もせず待つ側に回る）
  if (rt.finalizing.has(dir)) return busyResult('この作業場は、このプロセスで処理中です')
  rt.finalizing.add(dir)
  let result: ComposeResult
  try {
    result = await run()
  } finally {
    rt.finalizing.delete(dir)
    // 別の CCPIT がレビュー中のときは、占有の記録に触れない（その CCPIT が終わりに解く）
    if (!busy) releaseActiveCompose(d.paths, meta.skillName, dir)
  }
  // 次の巡の起動は、占有を解いた後（同じ skill の占有を、前の巡が握ったままにしない）
  if (followUp) await followUp()
  return result
}

/** 案件の記録の写しに、この巡の §1 の採否の表を載せる（buildStopQuestion が、改訂 AI の棄却理由の有無を見る） */
function withSection1(
  rec: ComposeCaseRecord,
  round: number,
  rows: Section1Row[] | null
): ComposeCaseRecord {
  const copy: ComposeCaseRecord = JSON.parse(JSON.stringify(rec)) as ComposeCaseRecord
  const r = copy.rounds.find((x) => x.round === round)
  if (r && rows) r.section1 = rows
  return copy
}

// ---- 次の巡の予約と起動 ----

export type LaunchRoundResult = { ok: true; workspaceDir: string } | { ok: false; error: string }

/** 前の巡の指摘の本文（レビュアーの生の出力から、番号ごとのブロックを取る） */
function bodiesFromRow(
  row: ReviewRow | undefined,
  parse: typeof parseReviewerOutput
): Map<string, string> {
  const m = new Map<string, string>()
  if (!row?.reviewerFindings) return m
  try {
    for (const f of parse(row.reviewerFindings).findings ?? []) m.set(f.reviewerNo, f.block)
  } catch {
    /* 本文は材料。取れなくても要旨・where で渡る */
  }
  return m
}

/**
 * 予約済みの巡を起動する（改訂 AI を窓を出さずに起動する）。skill 単位のロックの下で、予約の札・同じキーの作業場の有無を確かめてから始める。
 * 失敗したら案件を失敗にする（予約は残し、同じ巡を再び起動しない）。第 3 巡の後は何があっても起動しない。
 */
export async function launchReservedRound(i: {
  paths: ComposePaths
  caseDir: string
  caseId: string
  skillName: string
  round: number
  rounds: RoundsDeps
  runtime?: ComposeRuntime
  readRow?: ReviewRowReader
  lockDeps?: FileLockDeps
  onChange?: (workspaceDir: string) => void
}): Promise<LaunchRoundResult> {
  const rt = i.runtime ?? runtimeFor(i.paths)
  const key = `${i.caseId}#${i.round}`
  rt.launching.add(key)
  const fail = (error: string): LaunchRoundResult => {
    mutateCaseSync(i.caseDir, (c) => {
      if (c.status === 'cancelled') return
      c.status = 'failed'
      ;(c as CaseRecordX).error = `[round-start] ${error}`
    })
    return { ok: false, error }
  }
  try {
    return await withSkillLock(
      i.paths,
      i.skillName,
      async (): Promise<LaunchRoundResult> => {
        if (i.round > COMPOSE_ROUND_MAX)
          return { ok: false, error: `第 ${COMPOSE_ROUND_MAX} 巡の後は次の巡を始めません` }
        const rec = readCase(i.caseDir)
        if (!rec) return { ok: false, error: '案件の記録が読めません' }
        if (rec.status === 'cancelled') return { ok: false, error: '取り消された案件です' }
        const rr = rec.rounds.find((x) => x.round === i.round)
        if (!rr || rr.state !== 'reserved')
          return { ok: false, error: `第 ${i.round} 巡の予約がありません` }
        if (roundWorkspaceExists(i.paths, i.caseId, i.round))
          return { ok: false, error: `第 ${i.round} 巡の作業場は既にあります` }
        if (!i.rounds.launchHeadless)
          return { ok: false, error: '窓を出さない改訂 AI の起動口がありません' }
        const first = readJson<ComposeMeta>(join(i.caseDir, META))
        if (!first) return fail('第 1 巡の作業場の meta.json が読めません')
        const prevRec = rec.rounds.find((x) => x.round === i.round - 1)
        if (!prevRec?.compositeId) return fail('前の巡の合成提案が分かりません')
        const prep = prepareRevision(prevRec.compositeId, {
          paths: i.paths,
          proposalsDir: first.proposalsDir
        })
        if (!prep.ok) return fail(prep.error)

        // 改訂 AI へ渡す指摘は、台帳の行が残っている最後の巡のもの（停止 (e) の巡は飛ばす）
        const prevReviewed = findPrevReviewed(rec, i.round, i.readRow)
        const parse = i.rounds.parseReviewerOutput ?? parseReviewerOutput
        const bodies = bodiesFromRow(prevReviewed?.row, parse)
        const views = findingViewsFromRow(prevReviewed?.row).map((v) => ({
          ...v,
          ...(bodies.has(v.reviewerNo) ? { body: bodies.get(v.reviewerNo) } : {})
        }))
        const docRound = prevReviewed?.round
        const doc = (i.rounds.buildRevisionFindingsDoc ?? buildRevisionFindingsDoc)({
          previousCompositeId: prevRec.compositeId,
          findings: views,
          humanRejections: rec.humanRejections.filter((h) => h.round === docRound),
          originChoices: rec.originChoices.filter((o) => o.round === docRound),
          addressBase:
            rec.addressBaseFromRound !== undefined && rec.addressBaseFromRound === i.round - 1,
          acksNote:
            first.language === 'ja'
              ? '前回の acks.json（作業場の previous/acks.json）で選ばれた適応の選択を引き継ぐ'
              : 'carry over the adaptation choices of the previous acks.json (previous/acks.json in the workspace)',
          carried: []
        })
        const prevWs = prevRec.workspaceDir
        const roundOptions = i.rounds.getOptions?.()
        const extraEnv = i.rounds.resolveExtraEnv
          ? await i.rounds.resolveExtraEnv().catch(() => undefined)
          : undefined
        const sc = startCompose(i.skillName, {
          paths: i.paths,
          guard: first.guard,
          proposalsDir: first.proposalsDir,
          language: first.language,
          sources: prep.sources,
          ...(prep.entry.excluded && prep.entry.excluded.length > 0
            ? { excluded: prep.entry.excluded }
            : {}),
          ...(roundOptions ? { options: roundOptions } : {}),
          ...(extraEnv ? { extraEnv } : {}),
          ...(i.rounds.reader ? { reader: i.rounds.reader } : {}),
          launchHeadless: i.rounds.launchHeadless,
          runtime: rt,
          revision: {
            compositeId: prevRec.compositeId,
            previousFile: prep.previousFile,
            findings: doc,
            ...(prevWs ? { previousAcksFile: join(prevWs, 'out', 'acks.json') } : {})
          },
          caseStart: { caseId: i.caseId, round: i.round, token: rr.token, caseDir: i.caseDir },
          ...(i.onChange ? { onWorkspaceChange: i.onChange } : {})
        })
        if (!sc.ok) return fail(sc.error)
        mutateCaseSync(i.caseDir, (c) => {
          const r = c.rounds.find((x) => x.round === i.round)
          if (!r) return
          r.state = 'launched'
          r.workspaceDir = sc.workspaceDir
          r.compositeId = sc.compositeRequestId
          r.generationAttempts = 1
          r.ownerPid = process.pid
        })
        i.onChange?.(sc.workspaceDir)
        return { ok: true, workspaceDir: sc.workspaceDir }
      },
      i.lockDeps
    )
  } finally {
    rt.launching.delete(key)
  }
}

/**
 * 次の巡を予約して起動する（回答・棄却の記録の後など）。ロックの下で、第 3 巡の後でないことを確かめ、`mutate` で案件の記録を
 * 変えたうえで予約する。起動口（rounds）が無ければ予約までで止める（poller の復旧が、起動口のある実行で拾う）。
 */
export async function scheduleNextRound(i: {
  paths: ComposePaths
  caseDir: string
  skillName: string
  rounds?: RoundsDeps
  runtime?: ComposeRuntime
  readRow?: ReviewRowReader
  lockDeps?: FileLockDeps
  now?: Date
  /** 予約の前に案件の記録へ足す変更（回答の記録など） */
  mutate?: (c: ComposeCaseRecord) => void
  onChange?: (workspaceDir: string) => void
}): Promise<
  | { ok: true; round: number; launched: boolean; workspaceDir?: string }
  | { ok: false; error: string }
> {
  const rt = i.runtime ?? runtimeFor(i.paths)
  let reserved: number | undefined
  let refused: string | undefined
  let caseId = ''
  const rec = await updateCase(
    i.paths,
    i.skillName,
    i.caseDir,
    (c) => {
      if (c.status === 'cancelled') {
        refused = '取り消された案件です'
        return
      }
      if (!canReserveNextRound(c)) {
        refused = `第 ${COMPOSE_ROUND_MAX} 巡の後は次の巡を始めません`
        return
      }
      i.mutate?.(c)
      const last = lastRoundOf(c)
      const a = reserveRound(c, (last?.round ?? 0) + 1, i.now ?? new Date(), process.pid)
      if (a.refused) {
        refused = a.refused
        return
      }
      reserved = a.reservedRound
      caseId = c.caseId
      if (reserved !== undefined) rt.launching.add(`${c.caseId}#${reserved}`)
    },
    i.lockDeps,
    i.now
  )
  if (!rec) return { ok: false, error: '案件の記録が読めません' }
  if (refused || reserved === undefined)
    return { ok: false, error: refused ?? '次の巡を予約できませんでした' }
  if (!i.rounds) {
    rt.launching.delete(`${caseId}#${reserved}`)
    return { ok: true, round: reserved, launched: false }
  }
  const r = await launchReservedRound({
    paths: i.paths,
    caseDir: i.caseDir,
    caseId,
    skillName: i.skillName,
    round: reserved,
    rounds: i.rounds,
    runtime: rt,
    ...(i.readRow ? { readRow: i.readRow } : {}),
    ...(i.lockDeps ? { lockDeps: i.lockDeps } : {}),
    ...(i.onChange ? { onChange: i.onChange } : {})
  })
  return r.ok
    ? { ok: true, round: reserved, launched: true, workspaceDir: r.workspaceDir }
    : { ok: false, error: r.error }
}

/** 作業場を取り消す（進行中の合図を解放し、結果を cancelled として残す。作業場のファイルは消さない）。案件なら予約も消す */
export function cancelCompose(
  dir: string,
  paths: ComposePaths,
  now: Date = new Date()
): { ok: boolean; error?: string } {
  const meta = readJson<ComposeMeta>(join(dir, META))
  if (!meta) return { ok: false, error: '作業場の meta.json が読めません' }
  writeFileSync(join(dir, CANCEL), JSON.stringify({ at: now.toISOString() }), 'utf-8')
  releaseActiveCompose(paths, meta.skillName, dir)
  const cd = caseDirOfWorkspace(paths, dir, meta)
  if (cd) {
    mutateCaseSync(
      cd,
      (c) => {
        c.status = 'cancelled'
        c.rounds = c.rounds.filter((r) => r.state !== 'reserved')
        delete c.stop
      },
      now
    )
  }
  return { ok: true }
}

// ---- 一覧と監視 ----

export function listComposeStatuses(paths: ComposePaths): ComposeStatus[] {
  if (!existsSync(paths.workspacesDir)) return []
  const out: ComposeStatus[] = []
  for (const name of readdirSync(paths.workspacesDir)) {
    const dir = join(paths.workspacesDir, name)
    const meta = readJson<ComposeMeta>(join(dir, META))
    if (!meta) continue
    const result = readJson<ComposeResult>(join(dir, RESULT)) ?? undefined
    const cancelled = existsSync(join(dir, CANCEL))
    const ready = existsSync(join(dir, 'out', 'READY.json'))
    const phase: ComposePhase = cancelled
      ? 'cancelled'
      : result
        ? result.ok
          ? 'registered'
          : 'failed'
        : ready
          ? readStage(dir)?.stage === 'reviewing'
            ? 'reviewing'
            : 'finalizing'
          : 'running'
    out.push({
      workspaceDir: dir,
      skillName: meta.skillName,
      startedAt: meta.startedAt,
      phase,
      compositeRequestId: meta.compositeRequestId,
      sourceIds: meta.sources.map((s) => s.requestId),
      ...(meta.revises ? { revises: meta.revises } : {}),
      excludedIds: meta.excluded ?? [],
      ...(result ? { result } : {})
    })
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

export interface StatusViewDeps {
  paths: ComposePaths
  readReviewRow?: ReviewRowReader
  reviewsPath?: string
  runtime?: ComposeRuntime
}

/**
 * 画面へ返す状態: 作業場の一覧に、案件の項目（caseView・turn・巡・件数・停止・指摘・受け皿）と seq を足す。
 * 旧形式の作業場（caseId 無し）には案件の項目を足さない。状態の署名が変わるたびに seq を新しく採番する。
 */
export function describeComposeStatuses(d: StatusViewDeps): ComposeStatus[] {
  const rt = d.runtime ?? runtimeFor(d.paths)
  const readRow: ReviewRowReader =
    d.readReviewRow ?? (d.reviewsPath ? makeRawReviewRowReader(d.reviewsPath) : () => undefined)
  const recs = new Map<string, ComposeCaseRecord | null>()
  const out: ComposeStatus[] = []
  // 昇格済みの判定は合成台帳の application（昇格の後処理 composePostPromotion が書く。case.json は書き換えない）
  const ledger = readMergeLedger(d.paths.mergesPath)
  const entryOf = (id: string): MergeEntry | undefined => ledger.entries[id]
  for (const base of listComposeStatuses(d.paths)) {
    const st: ComposeStatus = { ...base }
    const meta = readMetaLite(base.workspaceDir)
    const ownCompositeId = base.result?.compositeId ?? base.compositeRequestId
    let rec: ComposeCaseRecord | null = null
    if (meta?.caseId) {
      const cd = caseDirOfWorkspace(d.paths, base.workspaceDir, meta)
      if (cd) {
        if (!recs.has(cd)) recs.set(cd, readCase(cd))
        rec = recs.get(cd) ?? null
      }
      const adopted = caseAdoptedInfo(rec, ownCompositeId, entryOf)
      const fields = projectCaseFields({
        workspaceDir: base.workspaceDir,
        phase: base.phase,
        meta,
        stage: readStage(base.workspaceDir),
        rec,
        readRow,
        compositeId: ownCompositeId,
        adopted
      })
      if (fields) Object.assign(st, fields)
      if (adopted) st.adopted = adopted
      // 次の巡の起動などで案件が失敗したとき、登録済みの作業場の結果にも原因を出す（昇格済みなら出さない）
      const err = rec?.status === 'failed' && !adopted ? (rec as CaseRecordX).error : undefined
      if (err && st.result?.ok) st.result = { ...st.result, ok: false, stage: 'case', error: err }
    } else {
      // 旧形式の作業場: 自分の合成提案が昇格済みなら印を付ける（文面とボタンは renderer の composeStatusView が決める）
      const adopted = adoptedInfoFromLedgerEntry(entryOf(ownCompositeId))
      if (adopted) st.adopted = adopted
    }
    // L0_012: 案件の作業場の窓つきの起動で、段が running の間だけ、着手の合図の状況を付ける
    // （検査の段より後には残さない。旧形式の作業場の表示は合図を使わないので付けない）
    if (st.phase === 'running' && !st.adopted && meta?.caseId) {
      const cc = readCcStart(base.workspaceDir, meta as { launchNonceSha256?: unknown } | null)
      if (cc) st.ccStart = cc
    }
    st.seq = observe(rt, base.workspaceDir, st.phase, statusSignature(st, rec)).seq
    out.push(st)
  }
  return out
}

/**
 * 改訂 AI が止まっているか。巡の持ち主（ownerPid）が、このプロセスなら「このプロセスが起動した Promise が無い」、
 * 別のプロセスなら「そのプロセスが生きていない」とき。持ち主の記録が無いときも止まっていると見なす。
 * 別の CCPIT が走らせている改訂 AI を、止まったと取り違えて起動し直さない。
 */
export function isGenerationStale(
  rr: RoundRecord | undefined,
  rt: ComposeRuntime,
  dir: string,
  isAlive: (pid: number) => boolean
): boolean {
  const owner = rr?.ownerPid
  if (owner === process.pid) return !rt.generations.has(dir)
  if (typeof owner === 'number' && owner > 0) return !isAlive(owner)
  return true
}

/**
 * CCPIT の再起動で止まった改訂 AI を、同じ作業場・同じ巡で 1 回だけ起動し直す。上限に達していたら失敗にする。
 * 判定・試行回数の更新・占有の引継ぎ・書きかけの出力の削除・起動は、skill 単位のロックの下の 1 つの手順にする
 * （複数の CCPIT が同時に気づいても、1 者だけが起動し直し、後の者は持ち主が生きていると見て何もしない）。
 */
async function restartGeneration(
  d: FinalizeDeps,
  rt: ComposeRuntime,
  dir: string,
  meta: ComposeMeta,
  rounds: RoundsDeps,
  changed: (dir: string) => void
): Promise<void> {
  const cd = caseDirOfWorkspace(d.paths, dir, meta)
  if (!cd) return
  const round = meta.round ?? 1
  const isAlive = rounds.isAlive ?? defaultIsAlive
  const key = `${meta.caseId}#${round}`
  rt.launching.add(key)
  try {
    await withSkillLock(
      d.paths,
      meta.skillName,
      async () => {
        // ロックの下で改めて確かめる（待っている間に、別の CCPIT が起動し直していたら何もしない）
        if (
          existsSync(join(dir, RESULT)) ||
          existsSync(join(dir, CANCEL)) ||
          existsSync(join(dir, 'out', 'READY.json'))
        )
          return
        const rec = readCase(cd)
        if (!rec || rec.status === 'cancelled' || rec.status === 'failed') return
        const rr = rec.rounds.find((x) => x.round === round)
        if (!isGenerationStale(rr, rt, dir, isAlive)) return
        const attempts = rr?.generationAttempts ?? 1
        if (attempts >= COMPOSE_GENERATION_ATTEMPTS_MAX) {
          failWorkspace(
            d.paths,
            dir,
            meta.skillName,
            'generation',
            `CCPIT の再起動で改訂 AI が ${COMPOSE_GENERATION_ATTEMPTS_MAX} 回止まりました（起動し直しは 1 回までです）`
          )
          changed(dir)
          return
        }
        if (!rounds.launchHeadless) return
        const h = readJson<{ promptText?: string; model?: string | null }>(join(dir, HEADLESS_FILE))
        if (!h?.promptText) {
          failWorkspace(
            d.paths,
            dir,
            meta.skillName,
            'generation',
            '改訂 AI の依頼文の記録（headless.json）が読めません'
          )
          changed(dir)
          return
        }
        // 試行回数と持ち主を先に記録する（起動の途中で落ちても、数え直さない）
        mutateCaseSync(cd, (c) => {
          const r = c.rounds.find((x) => x.round === round)
          if (!r) return
          r.generationAttempts = attempts + 1
          r.ownerPid = process.pid
        })
        // 前のプロセスが握っていた、この作業場の占有の記録は、起動し直す前に引き取る（別の作業場の占有は解かない）
        releaseActiveCompose(d.paths, meta.skillName, dir)
        const claim = claimActiveCompose(d.paths, meta.skillName, dir)
        if (!claim.ok) {
          failWorkspace(d.paths, dir, meta.skillName, 'generation', claim.error)
          changed(dir)
          return
        }
        // 書きかけの出力を消してから、同じ依頼文で起動し直す（新しい作業場・新しい巡は作らない）
        const outDir = join(dir, 'out')
        for (const n of existsSync(outDir) ? readdirSync(outDir) : []) {
          rmSync(join(outDir, n), { recursive: true, force: true })
        }
        const extraEnv = rounds.resolveExtraEnv
          ? await rounds.resolveExtraEnv().catch(() => undefined)
          : undefined
        const hr = rounds.launchHeadless({
          workspaceDir: dir,
          promptText: h.promptText,
          ...(h.model ? { model: h.model } : {}),
          ...(extraEnv ? { extraEnv } : {})
        })
        if (!hr.started) {
          failWorkspace(d.paths, dir, meta.skillName, 'generation', hr.error)
          changed(dir)
          return
        }
        trackGeneration(rt, d.paths, dir, meta.skillName, hr.done, changed)
      },
      d.lockDeps
    )
  } finally {
    rt.launching.delete(key)
  }
}

/**
 * 再起動後・取りこぼしの復旧。(1) 改訂 AI が走っているはずなのに、このプロセスに印が無い作業場 → 同じ作業場で 1 回だけ起動し直す。
 * (2) 予約があるのに作業場が無い巡 → 持ち主のプロセスが生きていなければ、その予約のまま起動する（判定は数え直さない）。
 * 予約はあるのに作業場が先にできていた巡は、launched に進める。
 */
async function recoverCases(
  d: FinalizeDeps,
  rt: ComposeRuntime,
  changed: (dir: string) => void
): Promise<void> {
  const rounds = d.rounds
  if (!rounds) return
  const metas = listWorkspaceMetas(d.paths) as unknown as Array<{ dir: string; meta: ComposeMeta }>
  for (const { dir, meta } of metas) {
    if (!meta.headless || !meta.caseId) continue
    if (existsSync(join(dir, RESULT)) || existsSync(join(dir, CANCEL))) continue
    if (existsSync(join(dir, 'out', 'READY.json'))) continue
    if (rt.launching.has(`${meta.caseId}#${meta.round ?? 1}`)) continue
    const cd = caseDirOfWorkspace(d.paths, dir, meta)
    const rr = (cd ? readCase(cd) : null)?.rounds.find((x) => x.round === (meta.round ?? 1))
    if (!isGenerationStale(rr, rt, dir, rounds.isAlive ?? defaultIsAlive)) continue
    await restartGeneration(d, rt, dir, meta, rounds, changed)
  }
  const isAlive = rounds.isAlive ?? defaultIsAlive
  const readRow =
    d.readReviewRow ?? (d.reviewsPath ? makeRawReviewRowReader(d.reviewsPath) : undefined)
  for (const { dir, meta } of metas) {
    if (!meta.caseId || (meta.round ?? 1) !== 1) continue
    const rec = readCase(dir)
    if (!rec || rec.status !== 'active') continue
    for (const r of rec.rounds) {
      if (r.state !== 'reserved') continue
      const key = `${rec.caseId}#${r.round}`
      if (rt.launching.has(key)) continue
      if (roundWorkspaceExists(d.paths, rec.caseId, r.round)) {
        // 作業場はできたのに、記録が launched に進まなかった
        const ws = metas.find(
          (m) => m.meta.caseId === rec.caseId && (m.meta.round ?? 1) === r.round
        )
        mutateCaseSync(dir, (c) => {
          const x = c.rounds.find((y) => y.round === r.round)
          if (!x || x.state !== 'reserved') return
          x.state = 'launched'
          if (ws) {
            x.workspaceDir = ws.dir
            x.compositeId = ws.meta.compositeRequestId
          }
          x.generationAttempts = Math.max(1, x.generationAttempts)
        })
        continue
      }
      if (r.ownerPid !== process.pid && isAlive(r.ownerPid)) continue // 別の CCPIT が起動中。待つ
      await launchReservedRound({
        paths: d.paths,
        caseDir: dir,
        caseId: rec.caseId,
        skillName: rec.skillName,
        round: r.round,
        rounds,
        runtime: rt,
        ...(readRow ? { readRow } : {}),
        ...(d.lockDeps ? { lockDeps: d.lockDeps } : {}),
        onChange: changed
      })
    }
  }
}

/**
 * 合図（out/READY.json）が出た作業場を 1 回だけ終わらせる。多重実行を避けるため、実行中の作業場は覚えておく。
 * `setInterval` から呼ぶ想定（呼び出し側が間隔を持つ）。
 *
 * 毎回の走査で、作業場ごとの署名（段・巡・案件の状態・停止・回答）を前回と比べ、変わったものを onDone に渡す
 * （running→READY・取消・失敗・新しい巡を含む）。最初の走査で見た作業場は基準にするだけで、通知しない。
 * 段の切替（checking／reviewing）は opts.onStage に渡す（省略時は通知せず、seq の採番だけ行う）。
 */
export function createComposePoller(
  d: FinalizeDeps,
  onDone?: (s: ComposeStatus) => void,
  opts: { onStage?: (s: ComposeStatus) => void } = {}
): () => Promise<number> {
  const rt = d.runtime ?? runtimeFor(d.paths)
  const inFlight = new Set<string>()
  const view = (): ComposeStatus[] => describeComposeStatuses({ ...d, runtime: rt })
  /** 未通知の変化を渡す。onlyDir があればその作業場だけ。cb が無ければ通知済みにするだけ */
  const flush = (cb: ((s: ComposeStatus) => void) | undefined, onlyDir?: string): void => {
    for (const st of view()) {
      if (onlyDir !== undefined && st.workspaceDir !== onlyDir) continue
      if (rt.notified.get(st.workspaceDir) === st.seq) continue
      rt.notified.set(st.workspaceDir, st.seq as number)
      if (rt.baselined) cb?.(st)
    }
  }
  const finalizeDeps: FinalizeDeps = {
    ...d,
    runtime: rt,
    onStage: (dir) => {
      d.onStage?.(dir)
      flush(opts.onStage, dir)
    }
  }
  return async () => {
    let n = 0
    await recoverCases(finalizeDeps, rt, (dir) => flush(onDone, dir)).catch(() => undefined)
    flush(onDone)
    rt.baselined = true
    for (const st of listComposeStatuses(d.paths)) {
      if ((st.phase !== 'finalizing' && st.phase !== 'reviewing') || inFlight.has(st.workspaceDir))
        continue
      inFlight.add(st.workspaceDir)
      try {
        const res = await finalizeWorkspace(st.workspaceDir, finalizeDeps)
        if (res.stage !== 'busy') n++
        flush(onDone)
      } finally {
        inFlight.delete(st.workspaceDir)
      }
    }
    return n
  }
}

/** 合成台帳に登録済みの request_id の集合（合成提案を元提案に選ばないため） */
export function ledgerCompositeIds(paths: ComposePaths): Set<string> {
  return new Set(Object.keys(readMergeLedger(paths.mergesPath).entries))
}

/** ComposeSeqFields を満たす seq を状態に付ける型の補助（preload の DTO と合わせる） */
export type { ComposeSeqFields }
