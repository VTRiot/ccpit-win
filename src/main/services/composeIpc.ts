/**
 * composeIpc — 合成ルートの IPC の本体（electron 非依存。ipc.ts が ipcMain へ結線する薄い層で呼ぶ。Plan r10 T4・T7）。
 *
 * - start: 「合成して golden へ入れる」ボタン。承認済みの候補から元提案を選び、合成 CC を起動する（開発版のリポジトリでのみ）
 * - status: 作業場ごとの進み具合（running／finalizing／registered／failed／cancelled）と、登録後のレビュー結果
 * - cancel: 進行中の合成を取り消す
 * - poller: out/READY.json の合図を見つけて、検査・登録・独立レビューを行う
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import type { launchCc } from './ccLaunch'
import {
  cancelCompose,
  chooseComposeSources,
  createComposePoller,
  describeComposeStatuses,
  findPrevReviewed,
  ledgerCompositeIds,
  scheduleNextRound,
  selectComposeSources,
  startCompose,
  startRevise,
  type ComposeReview,
  type ComposeStatus,
  type HeadlessLauncher,
  type RoundsDeps,
  type StartComposeResult
} from './composeLaunch'
import {
  deriveComposeHolds,
  getComposePaths,
  lookupHold,
  readMergeLedger,
  withSkillLock,
  type ComposePaths
} from './composeLedger'
import { readFm } from './composeRegister'
import { parseReviewerOutput } from './composeReviewClassify'
import {
  allowedAnswerOptions,
  canReserveNextRound,
  caseAdoptedInfo,
  findCaseDir,
  lastRoundOf,
  makeRawReviewRowReader,
  readCase,
  recordRenderLatency,
  runtimeFor,
  updateCase,
  type ComposeRuntime,
  type RenderLatency,
  type ReviewRowReader
} from './composeRounds'
import { skillNameFromProposalTarget } from './proposalTarget'
import { sha256Hex } from './composeHash'
import type { DialogueLaunchOptions } from './proposalDialogueLaunch'
import type { buildRevisionFindingsDoc } from './goldenMergeConsult'
import type { PromotionItem } from './goldenPromotion'
import {
  readProposalReviews,
  readProposalStates,
  recordComposeAdjudication as recordComposeAdjudicationReal,
  setProposalState,
  type ProposalStorePaths
} from './skillProposals'
import {
  ADOPTED_COMMIT_SHORT_LEN,
  COMPOSE_IPC,
  COMPOSE_POLL_INTERVAL_MS,
  COMPOSE_ROUND_MAX,
  type CarriedFinding,
  type ComposeAnswerOption,
  type ComposeCaseRecord,
  type ComposeReviewContext,
  type ComposeReviewOutcome
} from '../../shared/composeContract'

export interface ComposeIpcDeps {
  /** golden を持つリポジトリのルート。`.git` と `ccpit/golden` が無ければ合成は使えない（配布版は書込みが残らない） */
  getRepoDir: () => string
  getClaudeDir: () => string
  getCcpitDir: () => string
  getProposalsDir: () => string
  getStorePaths: () => ProposalStorePaths
  getLanguage: () => 'ja' | 'en'
  getOptions: () => DialogueLaunchOptions | undefined
  resolveExtraEnv?: () => Promise<Record<string, string> | undefined>
  /**
   * L0_012: 合成の開始の前に待つ（隔離起動の偽ドライバの台本が startIpcDelayMs を持つときだけ ipc.ts が渡す。
   * 画面で「準備中」を見るため。本番では渡さない）
   */
  beforeComposeStart?: () => Promise<void>
  /** 承認済みの昇格候補（scanProposalCandidates）。テストで差し替える */
  listCandidates: (
    repoDir: string,
    proposalsDir: string,
    stores: ProposalStorePaths
  ) => Promise<PromotionItem[]>
  /**
   * 独立レビュー。案件（caseId を持つ作業場）のときだけ第 2 引数に文脈を渡し、由来つきの ComposeReviewOutcome を受け取る。
   * 旧形式の作業場には渡さず、従来の { status, verdict, message } を受け取る
   */
  runReview?: (
    filePath: string,
    ctx?: ComposeReviewContext
  ) => Promise<ComposeReview | ComposeReviewOutcome>
  launch?: typeof launchCc
  /** 状態が変わったときの通知（画面へ push する） */
  notify?: (status: ComposeStatus) => void
  /** 段の切替（検査中→レビュー中）や新しい巡の起動の通知。notify と同じ送り口でよい（省略時は段の通知をしない） */
  notifyStage?: (status: ComposeStatus) => void
  // ---- L0_011（すべて任意。無ければ、窓を出さない改訂・棄却の記録は使えない／旧来の動作） ----
  /** 窓を出さない改訂 AI の起動口（composeHeadlessLaunch.startComposeRevisionHeadless）。無ければ改訂は従来どおり窓つき */
  launchHeadless?: HeadlessLauncher
  /** 棄却の記録（skillProposals.recordComposeAdjudication）。省略時は本物 */
  recordComposeAdjudication?: typeof recordComposeAdjudicationReal
  /** 改訂 AI へ渡す指摘の本文の組み立て（省略時は goldenMergeConsult の本物） */
  buildRevisionFindingsDoc?: typeof buildRevisionFindingsDoc
  /** レビュアーの生の本文から指摘のブロックを取る（省略時は composeReviewClassify の本物） */
  parseReviewerOutput?: typeof parseReviewerOutput
  /** レビュー台帳の行を同期で読む（画面の指摘・束縛の照合）。省略時は getStorePaths().reviewsPath から読む */
  readReviewRow?: ReviewRowReader
  /** 実行時の状態（既定は ~/.ccpit ごとの共有）。試験は偽の時計つきを渡す */
  runtime?: ComposeRuntime
  /** 予約の持ち主のプロセスが生きているか（試験用） */
  isAlive?: (pid: number) => boolean
}

const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function isRepositoryDir(repoDir: string): boolean {
  return existsSync(join(repoDir, '.git')) && existsSync(join(repoDir, 'ccpit', 'golden'))
}

const pathsOf = (d: ComposeIpcDeps): ComposePaths => getComposePaths(d.getCcpitDir())

const runtimeOf = (d: ComposeIpcDeps): ComposeRuntime => d.runtime ?? runtimeFor(pathsOf(d))

/** レビュー台帳のパス（読めない設定のときは undefined。画面の指摘・束縛の照合は台帳なしで縮退する） */
function reviewsPathOf(d: ComposeIpcDeps): string | undefined {
  try {
    return d.getStorePaths().reviewsPath
  } catch {
    return undefined
  }
}

/** 次の巡の起動・復旧に要るもの。窓を出さない起動口が無ければ undefined（予約までで止まり、poller が後で拾う） */
function roundsDepsOf(d: ComposeIpcDeps): RoundsDeps | undefined {
  if (!d.launchHeadless) return undefined
  return {
    launchHeadless: d.launchHeadless,
    getOptions: d.getOptions,
    ...(d.resolveExtraEnv ? { resolveExtraEnv: d.resolveExtraEnv } : {}),
    ...(d.buildRevisionFindingsDoc ? { buildRevisionFindingsDoc: d.buildRevisionFindingsDoc } : {}),
    ...(d.parseReviewerOutput ? { parseReviewerOutput: d.parseReviewerOutput } : {}),
    ...(d.isAlive ? { isAlive: d.isAlive } : {})
  }
}

const readRowOf = (d: ComposeIpcDeps): ReviewRowReader | undefined => {
  if (d.readReviewRow) return d.readReviewRow
  const rp = reviewsPathOf(d)
  return rp ? makeRawReviewRowReader(rp) : undefined
}

export async function composeStartHandler(
  d: ComposeIpcDeps,
  input: { skillName?: unknown; sourceIds?: unknown }
): Promise<StartComposeResult> {
  const skillName = typeof input?.skillName === 'string' ? input.skillName : ''
  if (!SKILL_NAME_RE.test(skillName))
    return { ok: false, error: `skill 名が不正です: ${skillName || '(空)'}` }
  const repoDir = d.getRepoDir()
  if (!isRepositoryDir(repoDir)) {
    return {
      ok: false,
      error:
        '提案の合成は、開発版（golden のリポジトリがある実行）でのみ使えます。配布版では golden への書込みが残らないため、合成を始めません。'
    }
  }
  const paths = pathsOf(d)
  const stores = d.getStorePaths()
  const items = await d.listCandidates(repoDir, d.getProposalsDir(), stores)
  // 適格な集合は起動の瞬間に再計算する（選択ダイアログを開いた後に状態が変わっていても、ここで厳密に照合される）
  const eligible = selectComposeSources(items, skillName, ledgerCompositeIds(paths))
  const chosen = chooseComposeSources(eligible, input?.sourceIds)
  if (!chosen.ok) return { ok: false, error: chosen.error }
  if (d.beforeComposeStart) await d.beforeComposeStart()
  const extraEnv = d.resolveExtraEnv ? await d.resolveExtraEnv().catch(() => undefined) : undefined
  return startCompose(skillName, {
    paths,
    guard: { repoDir, claudeDir: d.getClaudeDir(), ccpitDir: d.getCcpitDir() },
    proposalsDir: d.getProposalsDir(),
    language: d.getLanguage(),
    sources: chosen.sources,
    excluded: chosen.excluded,
    options: d.getOptions(),
    // 新しい合成は案件の第 1 巡（案件の ID は合成提案の ID）。最初の合成は従来どおり窓つきの Claude Code
    caseStart: { round: 1 },
    runtime: runtimeOf(d),
    ...(extraEnv ? { extraEnv } : {}),
    ...(d.launch ? { launch: d.launch } : {})
  })
}

// ---- 合成の元提案の選択（ダイアログに出す一覧） ----

export type ComposePickerReason =
  | 'unreviewed'
  | 'findings'
  | 'rejected'
  | 'adopted'
  | 'composite'
  | 'composed'
  | 'waiting'
  | 'notCandidate'

export interface ComposePickerItem {
  requestId: string
  title: string
  adoptionLabel: string
  selectable: boolean
  /** 選べない理由（selectable が false のとき） */
  reason?: ComposePickerReason
  /** 理由の相手（composed／waiting のとき、その合成提案の ID。findings のとき verdict） */
  detail?: string
}

/**
 * 合成の元にできる提案（既定で全件選択）と、選べない同じ skill の提案とその理由。判定は主処理が行い、画面は持たない。
 * 他の skill の提案は一覧に出さない（画面が「他の skill の提案は対象外」と添える）
 */
export async function composeSelectableHandler(
  d: ComposeIpcDeps,
  input: { skillName?: unknown }
): Promise<{ ok: true; items: ComposePickerItem[] } | { ok: false; error: string }> {
  const skillName = typeof input?.skillName === 'string' ? input.skillName : ''
  if (!SKILL_NAME_RE.test(skillName))
    return { ok: false, error: `skill 名が不正です: ${skillName || '(空)'}` }
  const repoDir = d.getRepoDir()
  if (!isRepositoryDir(repoDir)) {
    return {
      ok: false,
      error: '提案の合成は、開発版（golden のリポジトリがある実行）でのみ使えます。'
    }
  }
  const paths = pathsOf(d)
  const stores = d.getStorePaths()
  const candidates = await d.listCandidates(repoDir, d.getProposalsDir(), stores)
  const ledgerIds = ledgerCompositeIds(paths)
  const eligible = selectComposeSources(candidates, skillName, ledgerIds)
  const items: ComposePickerItem[] = eligible.map((s) => ({
    requestId: s.requestId,
    title: s.title,
    adoptionLabel: s.adoptionLabel,
    selectable: true
  }))
  const reviews: Record<string, { verdict?: string } | undefined> = await readProposalReviews(
    stores
  ).catch(() => ({}))
  const states: Record<string, string | undefined> = await readProposalStates(stores).catch(
    () => ({})
  )
  const holds = deriveComposeHolds(readMergeLedger(paths.mergesPath).entries, states)
  const proposalsDir = d.getProposalsDir()
  let names: string[] = []
  try {
    names = readdirSync(proposalsDir).filter((n) => n.toLowerCase().endsWith('.md'))
  } catch {
    names = []
  }
  const seen = new Set<string>(eligible.map((s) => s.requestId))
  for (const n of names.sort()) {
    let raw = ''
    try {
      raw = readFileSync(join(proposalsDir, n), 'utf-8')
    } catch {
      continue
    }
    const fm = readFm(raw)
    const requestId = (fm['request_id'] || fm['requestId'] || n.replace(/\.md$/i, '')).trim()
    if (seen.has(requestId)) continue
    if (skillNameFromProposalTarget(fm['target'] || '') !== skillName) continue
    seen.add(requestId)
    const hold = lookupHold(holds, skillName, requestId)
    const review = reviews[requestId]
    const st = states[requestId]
    let reason: ComposePickerReason
    let detail: string | undefined
    if (st === 'adopted') reason = 'adopted'
    else if (st === 'rejected') reason = 'rejected'
    else if (ledgerIds.has(requestId) || (fm['supersedes'] || '').trim()) reason = 'composite'
    else if (hold) {
      reason = hold.role === 'source' ? 'composed' : 'waiting'
      detail = hold.compositeId
    } else if (!review || !review.verdict) reason = 'unreviewed'
    else if (review.verdict !== 'approve') {
      reason = 'findings'
      detail = review.verdict
    } else reason = 'notCandidate'
    items.push({
      requestId,
      title: (fm['title'] || requestId).replace(/^\[CC提案\]\s*/, ''),
      adoptionLabel: fm['adoption_label'] || 'recommend',
      selectable: false,
      reason,
      ...(detail ? { detail } : {})
    })
  }
  return { ok: true, items }
}

/**
 * 合成を破棄する（握りの解除口）。合成提案の提案状態を rejected にするだけで、他は書かない。
 * 通常の「却下」が届かない異常のときだけ許可する: 台帳に在って registered・未改訂で、かつ
 * (a) 合成提案の MD が提案プールに無い・読めない・sha256 が台帳と違う、または (b) 合成提案が adopted のまま registered。
 * 通常に読める合成提案は拒む（候補ブラウザの「却下」を使う）。skill 単位のロックの下で検査して書く
 */
export async function composeDiscardHandler(
  d: ComposeIpcDeps,
  input: { compositeId?: unknown }
): Promise<{ ok: boolean; error?: string }> {
  const compositeId = typeof input?.compositeId === 'string' ? input.compositeId : ''
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$/.test(compositeId))
    return { ok: false, error: `合成提案の ID が不正です: ${compositeId || '(空)'}` }
  const paths = pathsOf(d)
  const stores = d.getStorePaths()
  const first = readMergeLedger(paths.mergesPath).entries[compositeId]
  if (!first || first.compositeId !== compositeId)
    return { ok: false, error: `合成提案「${compositeId}」が合成台帳に無いため破棄できません` }
  return withSkillLock(paths, first.skillName, async () => {
    const entry = readMergeLedger(paths.mergesPath).entries[compositeId]
    if (!entry || entry.compositeId !== compositeId)
      return { ok: false, error: `合成提案「${compositeId}」が合成台帳に無いため破棄できません` }
    if (entry.status !== 'registered')
      return {
        ok: false,
        error: `合成提案「${compositeId}」は ${entry.status} のため破棄できません（昇格の途中・完了後は破棄しません）`
      }
    if (entry.revisedBy)
      return {
        ok: false,
        error: `合成提案「${compositeId}」は ${entry.revisedBy} に改訂済みです。新しい方を扱ってください`
      }
    const states: Record<string, string | undefined> = await readProposalStates(stores).catch(
      () => ({})
    )
    if (states[compositeId] === 'rejected')
      return {
        ok: false,
        error: `合成提案「${compositeId}」は既に却下されています（握りは解けています）`
      }
    let abnormal = states[compositeId] === 'adopted'
    if (!abnormal) {
      let names: string[] = []
      try {
        names = readdirSync(d.getProposalsDir()).filter((n) => n.toLowerCase().endsWith('.md'))
      } catch {
        names = []
      }
      // 提案プールの全 MD を、ファイル名でなく frontmatter の request_id（候補の走査と同じ規則）で照合する。
      // 登録時の sha256 と一致する MD が 1 つでもあれば正常（別名・複製・古い版が並んでいても、正常な合成提案を破棄させない）。
      // 1 つも無い（無い・読めない・全部違う）ときだけ異常
      const intact = names.some((n) => {
        try {
          const raw = readFileSync(join(d.getProposalsDir(), n), 'utf-8')
          const fm = readFm(raw)
          const rid = (fm['requestId'] || fm['request_id'] || n.replace(/\.md$/i, '')).trim()
          return (
            rid === compositeId && sha256Hex(raw.replace(/\r\n/g, '\n')) === entry.proposalSha256
          )
        } catch {
          return false
        }
      })
      if (!intact) abnormal = true
    }
    if (!abnormal) {
      return {
        ok: false,
        error:
          '合成提案の MD は正常に読めます。破棄ではなく、Skill 候補ブラウザで合成提案を「却下」してください'
      }
    }
    await setProposalState(compositeId, 'rejected', stores)
    return { ok: true }
  })
}

/** 旧の合成提案の台帳の findings を、持ち越しの指摘（H1…）に切り出す。読めない形のときは [n] で始まる行ごとに分ける */
export function carriedFromFindings(
  findings: string | undefined,
  fromCompositeId: string,
  parse: typeof parseReviewerOutput = parseReviewerOutput
): CarriedFinding[] {
  if (!findings || findings.trim() === '') return []
  try {
    const parsed = parse(findings).findings
    if (parsed && parsed.length > 0) {
      return parsed.map((f, i) => ({
        no: `H${i + 1}`,
        fromCompositeId,
        title: f.title,
        where: f.where,
        block: f.block
      }))
    }
  } catch {
    /* 下の素朴な切り出しへ */
  }
  const blocks: string[] = []
  for (const line of findings.split(/\r?\n/)) {
    if (/^\s*\[\d+\]/.test(line)) blocks.push(line)
    else if (blocks.length > 0) blocks[blocks.length - 1] += '\n' + line
  }
  return blocks.map((block, i) => ({
    no: `H${i + 1}`,
    fromCompositeId,
    title: block
      .replace(/^\s*\[\d+\]\s*/, '')
      .split('\n')[0]
      .trim()
      .slice(0, 200),
    where: '',
    block: block.trim()
  }))
}

/**
 * 改訂: 登録済みの合成提案を、レビューの指摘を反映して再合成する（開発版のみ）。
 * launchHeadless があれば、新しい案件の第 1 巡として窓を出さずに起動する（持ち越しの指摘は H1…）。無ければ従来どおり窓つき
 */
export async function composeReviseHandler(
  d: ComposeIpcDeps,
  input: { compositeId?: unknown }
): Promise<StartComposeResult> {
  const compositeId = typeof input?.compositeId === 'string' ? input.compositeId : ''
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$/.test(compositeId))
    return { ok: false, error: `合成提案の ID が不正です: ${compositeId || '(空)'}` }
  const repoDir = d.getRepoDir()
  if (!isRepositoryDir(repoDir)) {
    return {
      ok: false,
      error: '提案の改訂は、開発版（golden のリポジトリがある実行）でのみ使えます。'
    }
  }
  const reviews = await readProposalReviews(d.getStorePaths())
  const extraEnv = d.resolveExtraEnv ? await d.resolveExtraEnv().catch(() => undefined) : undefined
  const headless = !!d.launchHeadless
  const review = reviews[compositeId] as { verdict?: string; findings?: string } | undefined
  return startRevise(compositeId, {
    paths: pathsOf(d),
    guard: { repoDir, claudeDir: d.getClaudeDir(), ccpitDir: d.getCcpitDir() },
    proposalsDir: d.getProposalsDir(),
    language: d.getLanguage(),
    options: d.getOptions(),
    getReview: (id) => {
      const r = reviews[id] as { verdict?: string; findings?: string } | undefined
      return r ? { verdict: r.verdict, findings: r.findings } : undefined
    },
    ...(extraEnv ? { extraEnv } : {}),
    ...(d.launch ? { launch: d.launch } : {}),
    runtime: runtimeOf(d),
    ...(d.launchHeadless ? { launchHeadless: d.launchHeadless } : {}),
    onWorkspaceChange: (dir) => notifyDir(d, dir),
    ...(headless
      ? {
          asCase: {
            carried: carriedFromFindings(review?.findings, compositeId, d.parseReviewerOutput),
            ...(d.buildRevisionFindingsDoc ? { buildDoc: d.buildRevisionFindingsDoc } : {})
          }
        }
      : {})
  })
}

/** 状態の一覧。案件の作業場には案件の項目（caseView・turn・巡・件数・停止・指摘・受け皿）と seq を足す。旧形式の作業場はそのまま */
export function composeStatusHandler(d: ComposeIpcDeps): ComposeStatus[] {
  const reviewsPath = reviewsPathOf(d)
  return describeComposeStatuses({
    paths: pathsOf(d),
    runtime: runtimeOf(d),
    ...(d.readReviewRow ? { readReviewRow: d.readReviewRow } : {}),
    ...(reviewsPath ? { reviewsPath } : {})
  })
}

/** 作業場 1 つの現在の状態を、段の通知口（notifyStage）へ送る。口が無ければ何もしない */
function notifyDir(d: ComposeIpcDeps, dir: string): void {
  if (!d.notifyStage) return
  const st = composeStatusHandler(d).find((x) => x.workspaceDir === dir)
  if (st) d.notifyStage(st)
}

const ANSWER_OPTIONS: readonly ComposeAnswerOption[] = [
  'split-and-proceed',
  'address-base',
  'hold',
  'resume-hold',
  'consult',
  'withdraw',
  'reject-and-next',
  'request-revision',
  'choose-origins-and-revise'
]

export type ComposeAnswerResult =
  | {
      ok: true
      option: ComposeAnswerOption
      round?: number
      launched?: boolean
      workspaceDir?: string
    }
  | { ok: false; error: string }

/** 台帳の行の指摘のうち、ゲートの番号（[n]）を持つもの（差分・不明）の番号 */
function gateIdsOf(
  row: { findingOrigins?: Array<{ gateId: string | null }> } | undefined
): string[] {
  return (row?.findingOrigins ?? [])
    .map((o) => o.gateId)
    .filter((g): g is string => typeof g === 'string')
}

/** 行の指摘のうち、由来が不明のものの番号（停止 (e) で人が由来を選ぶ対象） */
function unclearGateIdsOf(
  row: { findingOrigins?: Array<{ gateId: string | null; origin?: string }> } | undefined
): string[] {
  return (row?.findingOrigins ?? [])
    .filter((o) => o.origin === 'unclear')
    .map((o) => o.gateId)
    .filter((g): g is string => typeof g === 'string')
}

/** 行の裁定が付いている番号（行の findings に束縛された裁定だけ） */
function adjudicatedIdsOf(
  row:
    | {
        findings?: string
        adjudications?: Array<{ id?: unknown }>
        adjudicationsFor?: string
      }
    | undefined
): Set<string> {
  if (!row || !Array.isArray(row.adjudications)) return new Set()
  if (row.adjudicationsFor !== sha256Hex(row.findings ?? '')) return new Set()
  return new Set(row.adjudications.map((a) => String(a.id)))
}

/**
 * 案件のどれかの巡の合成提案が昇格済み（合成台帳に application がある）なら、回答・棄却の記録を拒否する理由を返す。
 * 保留・取り下げ・原文への指摘の反映・次の巡の予約は、golden に入った合成提案の状態や案件を書き換えてしまうため
 */
function refuseIfCaseAdopted(
  paths: ComposePaths,
  rec: ComposeCaseRecord
): { ok: false; error: string } | null {
  const entries = readMergeLedger(paths.mergesPath).entries
  const adopted = caseAdoptedInfo(rec, undefined, (id) => entries[id])
  if (!adopted) return null
  return {
    ok: false,
    error: `この案件の合成提案は昇格済みです（golden commit ${adopted.commit.slice(0, ADOPTED_COMMIT_SHORT_LEN)}）。昇格済みの案件には回答できません。新しい提案は「合成して golden へ入れる」から始めてください`
  }
}

/**
 * 停止の 1 問への回答。案件がいま出している選択肢だけを受け付ける（出していない選択肢・停止していない案件は拒否）。
 *  split-and-proceed・consult: 記録だけ ／ hold・resume-hold: 合成提案の状態を held／candidate に ／
 *  withdraw: 合成提案を rejected に、案件を withdrawn に ／
 *  address-base・request-revision・choose-origins-and-revise: 次の巡を予約して起動（第 3 巡の後は起動しない） ／
 *  reject-and-next: 案件を answer-pending にし、理由の記録が全件済んだら次の巡
 */
export async function composeAnswerHandler(
  d: ComposeIpcDeps,
  input: { caseId?: unknown; option?: unknown; origins?: unknown }
): Promise<ComposeAnswerResult> {
  const caseId = typeof input?.caseId === 'string' ? input.caseId : ''
  const option = input?.option as ComposeAnswerOption
  if (!caseId) return { ok: false, error: '案件が指定されていません' }
  if (!ANSWER_OPTIONS.includes(option))
    return { ok: false, error: `回答の種類が不正です: ${String(input?.option)}` }
  const paths = pathsOf(d)
  const caseDir = findCaseDir(paths, caseId)
  const rec = caseDir ? readCase(caseDir) : null
  if (!caseDir || !rec) return { ok: false, error: `案件「${caseId}」が見つかりません` }
  // 昇格済みの案件は終端。case.json は昇格で書き換わらないので、停止の 1 問が残って見えても回答は受け付けない
  const adoptedRefusal = refuseIfCaseAdopted(paths, rec)
  if (adoptedRefusal) return adoptedRefusal
  if (!allowedAnswerOptions(rec).includes(option)) {
    return {
      ok: false,
      error: `この案件は今、「${option}」を受け付けていません（状態: ${rec.status}）`
    }
  }
  const last = lastRoundOf(rec)
  const compositeId = last?.compositeId
  const stores = d.getStorePaths()
  const at = new Date().toISOString()
  const readRow = readRowOf(d)
  const common = {
    paths,
    caseDir,
    skillName: rec.skillName,
    rounds: roundsDepsOf(d),
    runtime: runtimeOf(d),
    ...(readRow ? { readRow } : {}),
    onChange: (dir: string) => notifyDir(d, dir)
  }
  const record = async (fn: (c: ComposeCaseRecord) => void): Promise<void> => {
    await updateCase(paths, rec.skillName, caseDir, fn)
  }
  const answered = { option, at }
  const launched = (r: {
    round: number
    launched: boolean
    workspaceDir?: string
  }): ComposeAnswerResult => ({
    ok: true,
    option,
    round: r.round,
    launched: r.launched,
    ...(r.workspaceDir ? { workspaceDir: r.workspaceDir } : {})
  })
  switch (option) {
    case 'split-and-proceed':
    case 'consult':
      await record((c) => {
        c.answer = answered
      })
      return { ok: true, option }
    case 'hold':
    case 'resume-hold':
    case 'withdraw': {
      if (!compositeId) return { ok: false, error: '合成提案が分かりません' }
      const state = option === 'hold' ? 'held' : option === 'resume-hold' ? 'candidate' : 'rejected'
      await setProposalState(compositeId, state, stores)
      await record((c) => {
        c.answer = answered
        if (option === 'hold') c.status = 'held'
        else if (option === 'resume-hold') c.status = 'awaiting-approval'
        else {
          c.status = 'withdrawn'
          delete c.stop
        }
      })
      return { ok: true, option }
    }
    case 'reject-and-next': {
      if (!canReserveNextRound(rec))
        return { ok: false, error: `第 ${COMPOSE_ROUND_MAX} 巡の後は次の巡を始めません` }
      const row = compositeId ? readRow?.(compositeId) : undefined
      const done = adjudicatedIdsOf(row)
      const remaining = gateIdsOf(row).filter((g) => !done.has(g))
      if (remaining.length > 0) {
        await record((c) => {
          c.status = 'answer-pending'
          c.answer = answered
        })
        return { ok: true, option, round: last?.round }
      }
      // 理由の記録が全件済んでいる → そのまま次の巡へ
      const r = await scheduleNextRound({
        ...common,
        mutate: (c) => {
          c.answer = answered
        }
      })
      return r.ok ? launched(r) : r
    }
    case 'choose-origins-and-revise': {
      if (!canReserveNextRound(rec))
        return { ok: false, error: `第 ${COMPOSE_ROUND_MAX} 巡の後は次の巡を始めません` }
      const origins = Array.isArray(input.origins)
        ? (input.origins as Array<{ gateId?: unknown; origin?: unknown }>)
        : []
      // 由来を選ぶのは、台帳の行が残っている最後の巡の指摘（停止 (e) の巡は飛ばす）
      const prev = findPrevReviewed(rec, (last?.round ?? 1) + 1, readRow)
      const known = new Set(gateIdsOf(prev?.row))
      const bad = origins.filter(
        (o) =>
          typeof o?.gateId !== 'string' ||
          !known.has(o.gateId) ||
          (o.origin !== 'diff' && o.origin !== 'base')
      )
      if (origins.length === 0 || bad.length > 0) {
        return {
          ok: false,
          error: '由来の指定が不正です（指摘の番号と、差分か原文かを 1 件以上指定します）'
        }
      }
      // 不明の指摘があるときは、その全件をちょうど 1 回ずつ選ぶ（不足・重複・不明でない指摘の指定を拒否）
      const unclear = unclearGateIdsOf(prev?.row)
      if (unclear.length > 0) {
        const ids = origins.map((o) => o.gateId as string)
        const dup = ids.length !== new Set(ids).size
        const extra = ids.filter((g) => !unclear.includes(g))
        const lack = unclear.filter((g) => !ids.includes(g))
        if (dup || extra.length > 0 || lack.length > 0) {
          return {
            ok: false,
            error: `由来は、由来が不明の指摘（${unclear.join('、')}）の全件をちょうど 1 回ずつ選んでください`
          }
        }
      }
      const picked = origins as Array<{ gateId: string; origin: 'diff' | 'base' }>
      const r = await scheduleNextRound({
        ...common,
        mutate: (c) => {
          c.answer = answered
          for (const o of picked) {
            c.originChoices = c.originChoices.filter(
              (x) => !(x.round === prev?.round && x.gateId === o.gateId)
            )
            c.originChoices.push({
              round: prev?.round ?? 1,
              gateId: o.gateId,
              origin: o.origin,
              at
            })
          }
        }
      })
      return r.ok ? launched(r) : r
    }
    case 'address-base':
    case 'request-revision': {
      const r = await scheduleNextRound({
        ...common,
        mutate: (c) => {
          c.answer = answered
          if (option === 'address-base') c.addressBaseFromRound = lastRoundOf(c)?.round
        }
      })
      return r.ok ? launched(r) : r
    }
  }
}

export type ComposeAdjudicateResult =
  | { ok: true; remaining: number; round?: number; launched?: boolean }
  | { ok: false; error: string }

/**
 * 回答待ち（reject-and-next の後）の案件で、指摘 1 件の棄却の理由を記録する。台帳の行へ書く（合成提案 MD は書き換えない）。
 * 案件の humanRejections に足し、未記録が 0 件になったら次の巡を予約して起動する
 */
export async function composeAdjudicateHandler(
  d: ComposeIpcDeps,
  input: { caseId?: unknown; compositeId?: unknown; gateId?: unknown; reason?: unknown }
): Promise<ComposeAdjudicateResult> {
  const caseId = typeof input?.caseId === 'string' ? input.caseId : ''
  const compositeId = typeof input?.compositeId === 'string' ? input.compositeId : ''
  const gateId = typeof input?.gateId === 'string' ? input.gateId : ''
  const reason = typeof input?.reason === 'string' ? input.reason : ''
  if (!caseId || !compositeId || !gateId)
    return { ok: false, error: '案件・合成提案・指摘の番号が必要です' }
  const paths = pathsOf(d)
  const caseDir = findCaseDir(paths, caseId)
  const rec = caseDir ? readCase(caseDir) : null
  if (!caseDir || !rec) return { ok: false, error: `案件「${caseId}」が見つかりません` }
  const adoptedRefusal = refuseIfCaseAdopted(paths, rec)
  if (adoptedRefusal) return adoptedRefusal
  if (rec.status !== 'answer-pending')
    return { ok: false, error: `棄却の理由を受け付ける状態ではありません（状態: ${rec.status}）` }
  const last = lastRoundOf(rec)
  if (!last || last.compositeId !== compositeId)
    return {
      ok: false,
      error: '最後の巡の合成提案ではありません（古い巡の指摘には記録できません）'
    }
  let file: string | undefined
  try {
    const n = readdirSync(d.getProposalsDir()).find(
      (x) => x.endsWith(`_${compositeId}.md`) || x === `${compositeId}.md`
    )
    if (n) file = join(d.getProposalsDir(), n)
  } catch {
    file = undefined
  }
  if (!file)
    return { ok: false, error: `合成提案の MD が提案プールに見つかりません（${compositeId}）` }
  const record = d.recordComposeAdjudication ?? recordComposeAdjudicationReal
  const res = await record({ compositeId, compositeFile: file, gateId, reason }, d.getStorePaths())
  if (!res.ok) return { ok: false, error: res.error }
  const at = new Date().toISOString()
  await updateCase(paths, rec.skillName, caseDir, (c) => {
    c.humanRejections = c.humanRejections.filter(
      (h) => !(h.round === last.round && h.gateId === gateId)
    )
    c.humanRejections.push({ round: last.round, gateId, reason, at })
  })
  if (res.remaining > 0) return { ok: true, remaining: res.remaining }
  const readRow = readRowOf(d)
  const r = await scheduleNextRound({
    paths,
    caseDir,
    skillName: rec.skillName,
    rounds: roundsDepsOf(d),
    runtime: runtimeOf(d),
    ...(readRow ? { readRow } : {}),
    onChange: (dir) => notifyDir(d, dir)
  })
  return r.ok ? { ok: true, remaining: 0, round: r.round, launched: r.launched } : r
}

/**
 * renderer が新しい seq を描画した直後の報告（ipcMain.on で受ける。登録は ipc.ts）。main の単調な時計で、
 * seq を採番した時刻と受信時刻の差を出し、5 秒を超えたら late。環境変数 CCPIT_COMPOSE_LATENCY_LOG があるときだけ JSONL に追記する
 */
export function composeRenderedHandler(d: ComposeIpcDeps, seq: unknown): RenderLatency | null {
  return recordRenderLatency(runtimeOf(d), seq)
}

export function composeCancelHandler(
  d: ComposeIpcDeps,
  workspaceDir: unknown
): { ok: boolean; error?: string } {
  if (typeof workspaceDir !== 'string' || workspaceDir === '')
    return { ok: false, error: '作業場が指定されていません' }
  const paths = pathsOf(d)
  // 作業場の外のパスを渡されても何もしない（compose/ の直下の 1 階層だけ）
  const rel = relative(resolve(paths.workspacesDir), resolve(workspaceDir))
  if (rel === '' || rel.startsWith('..') || /[\\/]/.test(rel) || /^[A-Za-z]:/.test(rel)) {
    return { ok: false, error: '作業場のパスが不正です' }
  }
  return cancelCompose(resolve(workspaceDir), paths)
}

/** ipcMain の handle だけを使う最小の型（electron に依存せず、試験で記録用の代役を渡せる） */
export interface IpcHandleRegistry {
  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void
}

/** 合成ルートの IPC の登録（ipc.ts はこれを 1 回呼ぶ）。チャネル名と引数の受け渡しをここに集める */
export function registerComposeHandlers(ipc: IpcHandleRegistry, d: ComposeIpcDeps): void {
  ipc.handle(
    'skillProposals:composeStart',
    (_e, input: { skillName?: unknown; sourceIds?: unknown }) => composeStartHandler(d, input)
  )
  ipc.handle('skillProposals:composeSelectable', (_e, input: { skillName?: unknown }) =>
    composeSelectableHandler(d, input)
  )
  ipc.handle('skillProposals:composeDiscard', (_e, input: { compositeId?: unknown }) =>
    composeDiscardHandler(d, input)
  )
  ipc.handle('skillProposals:composeRevise', (_e, input: { compositeId?: unknown }) =>
    composeReviseHandler(d, input)
  )
  ipc.handle('skillProposals:composeStatus', () => composeStatusHandler(d))
  ipc.handle('skillProposals:composeCancel', (_e, workspaceDir: unknown) =>
    composeCancelHandler(d, workspaceDir)
  )
}

/**
 * 案件の回答・棄却の IPC の登録（ipc.ts は registerComposeHandlers の後にこれも 1 回呼ぶ）。
 * registerComposeHandlers が登録する 6 チャネルは、既存の試験が一覧で固定しているため、ここは別の関数にしている。
 * 描画の報告（COMPOSE_IPC.rendered）は ipcMain.on なので、ここでは登録しない（composeRenderedHandler を ipc.ts が結ぶ）
 */
export function registerComposeCaseHandlers(ipc: IpcHandleRegistry, d: ComposeIpcDeps): void {
  ipc.handle(
    COMPOSE_IPC.answer,
    (_e, input: { caseId?: unknown; option?: unknown; origins?: unknown }) =>
      composeAnswerHandler(d, input)
  )
  ipc.handle(
    COMPOSE_IPC.adjudicate,
    (_e, input: { caseId?: unknown; compositeId?: unknown; gateId?: unknown; reason?: unknown }) =>
      composeAdjudicateHandler(d, input)
  )
}

/** 合図の監視。戻り値は止める関数。1 回分は `poll()` でも呼べる（テスト・起動直後の追い付き用） */
export function startComposePoller(
  d: ComposeIpcDeps,
  intervalMs = COMPOSE_POLL_INTERVAL_MS
): { stop: () => void; poll: () => Promise<number> } {
  const rounds = roundsDepsOf(d)
  const reviewsPath = reviewsPathOf(d)
  const poll = createComposePoller(
    {
      paths: pathsOf(d),
      runtime: runtimeOf(d),
      ...(d.runReview ? { runReview: d.runReview } : {}),
      ...(d.readReviewRow ? { readReviewRow: d.readReviewRow } : {}),
      ...(reviewsPath ? { reviewsPath } : {}),
      ...(rounds ? { rounds } : {})
    },
    (status) => d.notify?.(status),
    d.notifyStage ? { onStage: (status) => d.notifyStage?.(status) } : {}
  )
  const timer = setInterval(() => {
    poll().catch(() => undefined)
  }, intervalMs)
  // Electron の終了を妨げない
  ;(timer as unknown as { unref?: () => void }).unref?.()
  return { stop: () => clearInterval(timer), poll }
}
