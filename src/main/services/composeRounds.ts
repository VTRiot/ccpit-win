/**
 * composeRounds — 合成の「巡」と「案件」の判定・記録・画面への写し（CCPIT_L0_011 W2・W3。electron 非依存）。
 *
 * 置くもの:
 *  - 純関数: §1 の採否の表の読取り（parseSection1Table）・停止 (e) の判定（evaluateSection1）・巡の判定（decideAfterReview）・
 *    停止の 1 問（buildStopQuestion）・台帳の行からの復元（outcomeFromRow・prevInfoFromRow）・画面の項目（projectCaseFields）
 *  - 案件の記録 `case.json`（第 1 巡の作業場の中）の読み書き。書込みは tmp→rename。他プロセスとの排他は skill 単位のロック
 *    （updateCase）。ロックの下や、同期で済ませたい取消では mutateCaseSync を使う
 *  - 実行側（composeLaunch）が共有する状態 ComposeRuntime（生成 AI の Promise・署名・seq・描画の遅延の記録）
 *
 * 巡の実行（作業場の作成・起動・復旧）は composeLaunch が行う。ここは composeLaunch を実行時に import しない（型のみ）。
 */

import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'

import {
  COMPOSE_LATENCY_LOG_ENV,
  COMPOSE_ROUND_MAX,
  COMPOSE_UPDATE_SLO_MS,
  SECTION1_DECISION_TABLE_COLUMNS,
  SECTION1_DECISION_TABLE_HEADING,
  SECTION1_DECISION_WORDS,
  SECTION1_ORIGIN_WORDS,
  adoptedInfoFromLedgerEntry,
  findingKey,
  type ClassifiedFinding,
  type ComposeAdoptedInfo,
  type ComposeAnswerOption,
  type ComposeCaseFields,
  type ComposeCaseRecord,
  type ComposeCaseView,
  type ComposePhase,
  type ComposeReviewOutcome,
  type ComposeReviewScope,
  type ComposeStageMarker,
  type ComposeTurn,
  type FindingOrigin,
  type FindingOriginRecord,
  type FindingView,
  type HumanRejection,
  type OriginCounts,
  type ReviewHistoryItem,
  type RoundDecision,
  type RoundRecord,
  type Section1Row,
  type StopQuestion,
  type StopReason
} from '../../shared/composeContract'
import type { FileLockDeps } from './composeFileLock'
import { sha256Hex } from './composeHash'
import { withSkillLock, type ComposePaths } from './composeLedger'

// ---- 定数 ----

export const CASE_FILE = 'case.json'
export const STAGE_FILE = 'stage.json'

/** 遅延のログに残す行数の上限（直近のぶんだけ。ログが際限なく増えないように） */
export const COMPOSE_LATENCY_LOG_MAX_LINES = 500
/** 描画の報告を待つ seq の記録の上限（古いものから捨てる） */
export const COMPOSE_SEQ_LOG_MAX = 500

// ---- 台帳の行（合成提案のレビュー）の読取り用の形 ----

/** proposal-reviews.json の合成提案の行。読むのに必要な項目だけを緩く型付けする（書くのは composeReview・skillProposals） */
export interface ReviewRow {
  verdict?: string
  findings?: string
  proposal_hash?: string
  reviewScope?: Partial<ComposeReviewScope>
  reviewerVerdict?: string
  reviewerFindings?: string
  findingOrigins?: FindingOriginRecord[]
  baseFindingRefs?: string[]
  adjudications?: Array<{ id?: unknown; decision?: unknown; reason?: unknown; at?: unknown }>
  adjudicationsFor?: string
}

export type ReviewRowReader = (compositeId: string) => ReviewRow | undefined

/** レビュー台帳のファイルから、1 行を同期で読む（読めなければ undefined）。試験は偽の関数を差し込める */
export function makeRawReviewRowReader(reviewsPath: string): ReviewRowReader {
  return (id) => {
    try {
      const j = JSON.parse(readFileSync(reviewsPath, 'utf-8')) as unknown
      if (j === null || typeof j !== 'object' || Array.isArray(j)) return undefined
      const r = (j as Record<string, unknown>)[id]
      return r !== null && typeof r === 'object' && !Array.isArray(r) ? (r as ReviewRow) : undefined
    } catch {
      return undefined
    }
  }
}

// ---- §1 の採否の表 ----

const SEPARATOR_ROW_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/
const MARKDOWN_HEADING_RE = /^\s{0,3}#{1,6}\s/
/** 見出しから表までに許す、表でも見出しでもない行数（見出しと表の間の説明文のぶん） */
const SECTION1_MAX_GAP_LINES = 12

const stripEmphasis = (s: string): string => s.replace(/[*`_]/g, '').trim()

function splitTableRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((c) => c.trim())
}

const ORIGIN_WORD_TO_VALUE: Record<string, Section1Row['origin']> = {
  [SECTION1_ORIGIN_WORDS.diff]: 'diff',
  [SECTION1_ORIGIN_WORDS.base]: 'base',
  [SECTION1_ORIGIN_WORDS.unresolved]: 'unresolved'
}
const DECISION_WORD_TO_VALUE: Record<string, Section1Row['decision']> = {
  [SECTION1_DECISION_WORDS.adopted]: 'adopted',
  [SECTION1_DECISION_WORDS.rejected]: 'rejected',
  [SECTION1_DECISION_WORDS.notApplied]: 'not-applied'
}

function parseTableFrom(lines: string[], headingIdx: number): Section1Row[] | null {
  let i = headingIdx + 1
  let gap = 0
  // 見出しの行そのものが表の見出し行になっている書き方も許す
  if (lines[headingIdx].trim().startsWith('|')) i = headingIdx
  while (i < lines.length && !lines[i].trim().startsWith('|')) {
    if (MARKDOWN_HEADING_RE.test(lines[i])) return null
    if (++gap > SECTION1_MAX_GAP_LINES) return null
    i++
  }
  if (i >= lines.length) return null
  const header = splitTableRow(lines[i]).map(stripEmphasis)
  const cols = SECTION1_DECISION_TABLE_COLUMNS
  if (header.length !== cols.length || header.some((h, k) => h !== cols[k])) return null
  if (i + 1 >= lines.length || !SEPARATOR_ROW_RE.test(lines[i + 1])) return null
  const rows: Section1Row[] = []
  for (let k = i + 2; k < lines.length && lines[k].trim().startsWith('|'); k++) {
    const cells = splitTableRow(lines[k])
    if (cells.length < cols.length) return null
    const origin = ORIGIN_WORD_TO_VALUE[stripEmphasis(cells[1])]
    const decision = DECISION_WORD_TO_VALUE[stripEmphasis(cells[2])]
    // 読めない語は黙って丸めない。表ごと読めないものとして null（停止側に倒れる）
    if (!origin || !decision) return null
    rows.push({
      prevNo: stripEmphasis(cells[0]),
      origin,
      decision,
      reason: cells.slice(3).join('|').trim()
    })
  }
  return rows
}

/**
 * 改訂の合成提案 §1 の「前回の指摘の採否」の表を読む。見出し・列・語は契約の定数。
 * 表が無い・列が違う・読めない語がある → null（呼び出し側は「採否が揃っていない」として止める側に倒す）。
 */
export function parseSection1Table(raw: string): Section1Row[] | null {
  const lines = raw.replace(/\r\n/g, '\n').split('\n')
  for (let h = 0; h < lines.length; h++) {
    if (!lines[h].includes(SECTION1_DECISION_TABLE_HEADING)) continue
    const rows = parseTableFrom(lines, h)
    if (rows) return rows
  }
  return null
}

// ---- 前の巡の情報 ----

export interface PrevFindingRef {
  /** 巡-番号（'1-2'）。依頼文の経緯・採否の表で使う前回番号 */
  no: string
  gateId: string | null
  reviewerNo: string
  where: string
  title: string
  origin: FindingOrigin
}

/** 判定の入力になる、前の巡の情報（差分・不明の指摘だけ） */
export interface PrevRoundInfo {
  round: number
  counts: OriginCounts
  findings: PrevFindingRef[]
}

export const tally = (fs: Array<{ origin: FindingOrigin }>): OriginCounts => ({
  diff: fs.filter((f) => f.origin === 'diff').length,
  base: fs.filter((f) => f.origin === 'base').length,
  unclear: fs.filter((f) => f.origin === 'unclear').length
})

/** 台帳の行（と巡の記録の件数）から、前の巡の情報を作る */
export function prevInfoFromRow(
  row: ReviewRow | undefined,
  round: number,
  counts?: OriginCounts
): PrevRoundInfo | undefined {
  if (!row) return undefined
  const origins = Array.isArray(row.findingOrigins) ? row.findingOrigins : []
  const findings: PrevFindingRef[] = origins
    .filter((f) => f.origin !== 'base')
    .map((f) => ({
      no: `${round}-${f.gateId ?? f.reviewerNo}`,
      gateId: f.gateId,
      reviewerNo: f.reviewerNo,
      where: f.where,
      title: f.title,
      origin: f.origin
    }))
  return { round, counts: counts ?? tally(origins), findings }
}

const normNo = (s: string): string =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s[\]#【】]/g, '')

/** §1 の行の「前回番号」が、前の巡の指摘を指しているか（番号の書き方の揺れを許す） */
export function rowMatchesPrev(prevNo: string, p: PrevFindingRef, prevRound: number): boolean {
  const n = normNo(prevNo)
  if (n === '') return false
  const cands = [p.no, p.gateId ?? '', p.reviewerNo, p.gateId ? `${prevRound}-${p.gateId}` : '']
  return cands.some((c) => c !== '' && normNo(c) === n)
}

export type Section1Verdict =
  | { ok: true }
  | { ok: false; kind: 'missing' | 'unresolved'; detail: string; count: number }

/**
 * 停止 (e) の判定。前回の差分・不明の指摘の行が欠けている、または由来が「確定できない」の行がある。
 * 前の巡の情報が無い（第 1 巡の持ち越しなど）ときは欠けは見ず、「確定できない」の行だけを見る。
 */
export function evaluateSection1(
  rows: Section1Row[] | null,
  prev: PrevRoundInfo | undefined
): Section1Verdict {
  const expected = prev ? prev.findings : []
  if (prev && expected.length > 0) {
    if (rows === null) {
      return {
        ok: false,
        kind: 'missing',
        detail: `§1 に「${SECTION1_DECISION_TABLE_HEADING}」の表が無い、または読めない`,
        count: expected.length
      }
    }
    const missing = expected.filter(
      (p) => !rows.some((r) => rowMatchesPrev(r.prevNo, p, prev.round))
    )
    if (missing.length > 0) {
      return {
        ok: false,
        kind: 'missing',
        detail: `前回の指摘 ${missing.map((m) => m.no).join('、')} の行が無い`,
        count: missing.length
      }
    }
  }
  const unresolved = (rows ?? []).filter((r) => r.origin === 'unresolved')
  if (unresolved.length > 0) {
    return {
      ok: false,
      kind: 'unresolved',
      detail: `由来を確定できない指摘が ${unresolved.length} 件（${unresolved.map((r) => r.prevNo).join('、')}）`,
      count: unresolved.length
    }
  }
  return { ok: true }
}

// ---- 判定 ----

export const lastRoundOf = (c: ComposeCaseRecord): RoundRecord | undefined =>
  c.rounds.reduce<RoundRecord | undefined>((a, r) => (!a || r.round > a.round ? r : a), undefined)

const mentionsUnaddressed = (f: ClassifiedFinding, prev: PrevRoundInfo): boolean => {
  const text = `${f.block}\n${f.title}\n${f.claim}\n${f.impact}`
  return /未対応/.test(text) && prev.findings.some((p) => text.includes(p.no))
}

/** 前の巡と同じ指摘が戻ったもの。同じ節かつ要旨の正規化が同じ（契約の findingKey）、または本文に前巡の番号と「未対応」 */
export function detectRepeated(
  outcome: ComposeReviewOutcome,
  prev: PrevRoundInfo | undefined
): ClassifiedFinding[] {
  if (!prev) return []
  const keys = new Set(prev.findings.map((p) => findingKey(p.where, p.title)))
  return outcome.findings.filter(
    (f) =>
      f.origin !== 'base' &&
      (keys.has(findingKey(f.where, f.title)) || mentionsUnaddressed(f, prev))
  )
}

/**
 * 独立レビューの結果から、次にすることを決める。巡は案件の記録の最後の巡。
 *  - 差分 0・不明 0: 原文由来なし → approve、あり → stop-d
 *  - 差分か不明が残る: 差分が前巡より増えた → stop-b、同じ指摘が戻った → stop-c、第 3 巡 → stop-a、それ以外 → next-round
 * 停止 (e)（§1 の採否が揃わない）はレビューの前に決まるので、ここでは返さない。
 */
export function decideAfterReview(
  c: ComposeCaseRecord,
  outcome: ComposeReviewOutcome,
  prev?: PrevRoundInfo
): RoundDecision {
  if (outcome.status !== 'ok')
    throw new Error(`decideAfterReview: レビューが ok でない (${outcome.status})`)
  const round = lastRoundOf(c)?.round ?? 1
  const { diff, unclear, base } = outcome.counts
  if (diff + unclear === 0) return base > 0 ? 'stop-d' : 'approve'
  if (prev && diff > prev.counts.diff) return 'stop-b'
  if (detectRepeated(outcome, prev).length > 0) return 'stop-c'
  if (round >= COMPOSE_ROUND_MAX) return 'stop-a'
  return 'next-round'
}

const STOP_REASON: Partial<Record<RoundDecision, StopReason>> = {
  'stop-a': 'a',
  'stop-b': 'b',
  'stop-c': 'c',
  'stop-d': 'd',
  'stop-e': 'e'
}

/** 改訂 AI が理由つきで棄却していて、対象の指摘すべてに理由があるか（(b)(c) の推奨を分ける） */
function aiReasonsCoverAll(
  targets: ClassifiedFinding[],
  prev: PrevRoundInfo | undefined,
  rows: Section1Row[] | undefined
): boolean {
  if (!prev || !rows || targets.length === 0) return false
  const keyToPrev = new Map(prev.findings.map((p) => [findingKey(p.where, p.title), p]))
  return targets.every((t) => {
    const p =
      keyToPrev.get(findingKey(t.where, t.title)) ??
      prev.findings.find((x) => mentionsUnaddressed(t, prev) && `${t.block}`.includes(x.no))
    if (!p) return false
    return rows.some(
      (r) =>
        rowMatchesPrev(r.prevNo, p, prev.round) &&
        r.decision === 'rejected' &&
        r.reason.trim() !== ''
    )
  })
}

/**
 * 停止の 1 問（推奨 1 つ・選択肢）。第 3 巡では「次の巡へ」系を出さない。approve・next-round には 1 問が無い（null）。
 * prev があると (b)(c) の推奨を「改訂 AI の理由が全件にあるか」で分けられる（無ければ改訂を頼む側）。
 */
export function buildStopQuestion(
  decision: RoundDecision,
  c: ComposeCaseRecord,
  outcome: ComposeReviewOutcome,
  prev?: PrevRoundInfo
): StopQuestion | null {
  const reason = STOP_REASON[decision]
  if (!reason) return null
  const last = lastRoundOf(c)
  const round = last?.round ?? 1
  const more = round < COMPOSE_ROUND_MAX
  const q: StopQuestion = {
    reason,
    round,
    recommended: 'consult',
    options: [],
    counts: { ...outcome.counts }
  }
  switch (reason) {
    case 'a':
      q.recommended = 'consult'
      q.options = ['consult', 'withdraw']
      break
    case 'd':
      q.recommended = 'split-and-proceed'
      q.options = more
        ? ['split-and-proceed', 'address-base', 'hold']
        : ['split-and-proceed', 'hold']
      break
    case 'e':
      if (more) {
        q.recommended = 'choose-origins-and-revise'
        q.options = ['choose-origins-and-revise', 'withdraw']
      } else {
        q.recommended = 'consult'
        q.options = ['consult', 'withdraw']
      }
      break
    case 'b':
    case 'c': {
      if (reason === 'b') q.prevDiff = prev?.counts.diff ?? 0
      const repeated = detectRepeated(outcome, prev)
      if (reason === 'c') q.repeated = repeated.length
      if (!more) {
        q.recommended = 'consult'
        q.options = ['consult', 'withdraw']
        break
      }
      const targets =
        reason === 'c' ? repeated : outcome.findings.filter((f) => f.origin !== 'base')
      q.recommended = aiReasonsCoverAll(targets, prev, last?.section1)
        ? 'reject-and-next'
        : 'request-revision'
      q.options = ['reject-and-next', 'request-revision', 'withdraw']
      break
    }
  }
  return q
}

/** 台帳の行から、判定に使う結果を復元する（レビューを走らせ直さず、済みの行を使うとき）。本文は台帳に無いので空 */
export function outcomeFromRow(row: ReviewRow): ComposeReviewOutcome {
  const origins = Array.isArray(row.findingOrigins) ? row.findingOrigins : []
  const findings: ClassifiedFinding[] = origins.map((o) => ({
    reviewerNo: o.reviewerNo,
    carried: o.carried,
    severity: o.severity,
    title: o.title,
    where: o.where,
    claim: '',
    impact: '',
    suggestion: '',
    reviewerOrigin: o.reviewerOrigin,
    block: '',
    machineOrigin: o.machineOrigin,
    origin: o.origin,
    citedRanges: o.citedRanges ?? [],
    agree: o.agree,
    gateId: o.gateId
  }))
  const counts = tally(findings)
  return {
    status: 'ok',
    verdict: row.verdict === 'approve' ? 'approve' : 'needs-attention',
    ...(row.reviewerVerdict ? { reviewerVerdict: row.reviewerVerdict } : {}),
    findings,
    counts,
    ...(row.reviewScope ? { scope: row.reviewScope as ComposeReviewScope } : {})
  }
}

/** ComposeReviewOutcome かどうか（旧形式の { status, verdict } と見分ける） */
export function isReviewOutcome(x: unknown): x is ComposeReviewOutcome {
  if (x === null || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  const c = o.counts as Record<string, unknown> | undefined
  return (
    Array.isArray(o.findings) && !!c && typeof c.diff === 'number' && typeof c.base === 'number'
  )
}

/** 束縛の照合。合っていれば null、食い違えば理由 */
export function checkReviewBinding(
  row: ReviewRow | undefined,
  expected: { caseId: string; round: number; currentHash: string; verdict?: string }
): string | null {
  if (!row) return 'レビューの台帳の行が見つからない'
  const s = row.reviewScope
  if (!s || s.kind !== 'compose-diff') return '台帳の行に reviewScope（compose-diff）が無い'
  if (s.caseId !== expected.caseId) return `台帳の行の案件が違う（${String(s.caseId)}）`
  if (s.round !== expected.round) return `台帳の行の巡が違う（${String(s.round)}）`
  if (s.proposalHash !== expected.currentHash)
    return '台帳の行の reviewScope.proposalHash が、合成提案 MD の現在のハッシュと違う'
  if (row.proposal_hash !== expected.currentHash)
    return '台帳の行の proposal_hash が、合成提案 MD の現在のハッシュと違う'
  // 裁定があるなら、その束縛（adjudicationsFor）が要る。裁定が空でも adjudicationsFor に値があれば、findings のハッシュと一致していること
  const hasAdj = Array.isArray(row.adjudications) && row.adjudications.length > 0
  if (
    (hasAdj || row.adjudicationsFor !== undefined) &&
    row.adjudicationsFor !== sha256Hex(row.findings ?? '')
  ) {
    return '台帳の行の adjudicationsFor が findings のハッシュと違う'
  }
  if (expected.verdict && row.verdict !== expected.verdict) {
    return `台帳の行の verdict（${String(row.verdict)}）が、レビューの結果（${expected.verdict}）と違う`
  }
  return null
}

// ---- 経緯（依頼文へ渡す・前の巡の指摘ごとの扱い） ----

/** 前の巡の指摘ごとの 番号・要旨・由来・採否・理由。採否は今の巡の §1 の表と、maintainerの棄却から */
export function buildHistoryItems(
  prevRow: ReviewRow | undefined,
  prevRound: number,
  section1: Section1Row[] | null | undefined,
  humanRejections: HumanRejection[]
): ReviewHistoryItem[] {
  if (!prevRow || !Array.isArray(prevRow.findingOrigins)) return []
  const out: ReviewHistoryItem[] = []
  for (const f of prevRow.findingOrigins) {
    const no = f.gateId ? `${prevRound}-${f.gateId}` : `${prevRound}-R${f.reviewerNo}`
    if (f.origin === 'base') {
      out.push({
        no,
        title: f.title,
        origin: 'base',
        decision: 'deferred',
        reason: '原文への指摘のため受け皿へ入れた'
      })
      continue
    }
    const human = humanRejections.find((h) => h.round === prevRound && h.gateId === f.gateId)
    if (human) {
      out.push({ no, title: f.title, origin: f.origin, decision: 'rejected', reason: human.reason })
      continue
    }
    const p: PrevFindingRef = {
      no,
      gateId: f.gateId,
      reviewerNo: f.reviewerNo,
      where: f.where,
      title: f.title,
      origin: f.origin
    }
    const row = (section1 ?? []).find((r) => rowMatchesPrev(r.prevNo, p, prevRound))
    out.push({
      no,
      title: f.title,
      origin: f.origin,
      decision: row ? row.decision : 'not-applied',
      reason: row ? row.reason : '改訂 AI の採否の記載なし'
    })
  }
  return out
}

// ---- 案件の記録 case.json ----

export const caseFilePath = (workspaceDir: string): string => join(workspaceDir, CASE_FILE)

export function readCase(workspaceDir: string): ComposeCaseRecord | null {
  try {
    const j = JSON.parse(readFileSync(caseFilePath(workspaceDir), 'utf-8')) as ComposeCaseRecord
    return j && j.version === 1 && Array.isArray(j.rounds) ? j : null
  } catch {
    return null
  }
}

/** tmp→rename で書く（書きかけを読ませない）。updatedAt を更新する */
export function writeCaseSync(
  workspaceDir: string,
  rec: ComposeCaseRecord,
  now: Date = new Date()
): void {
  rec.updatedAt = now.toISOString()
  const p = caseFilePath(workspaceDir)
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  writeFileSync(tmp, JSON.stringify(rec, null, 2), 'utf-8')
  renameSync(tmp, p)
}

/** 読む→変える→書く、を同期で行う。ロックを取らない（ロックの下、または同一プロセスでの取消に使う）。記録が無ければ null */
export function mutateCaseSync(
  workspaceDir: string,
  fn: (c: ComposeCaseRecord) => void,
  now: Date = new Date()
): ComposeCaseRecord | null {
  const c = readCase(workspaceDir)
  if (!c) return null
  fn(c)
  writeCaseSync(workspaceDir, c, now)
  return c
}

/** skill 単位のロックの下で案件の記録を更新する */
export async function updateCase(
  paths: ComposePaths,
  skillName: string,
  workspaceDir: string,
  fn: (c: ComposeCaseRecord) => void,
  lockDeps?: FileLockDeps,
  now?: Date
): Promise<ComposeCaseRecord | null> {
  return withSkillLock(paths, skillName, () => mutateCaseSync(workspaceDir, fn, now), lockDeps)
}

export function newCaseRecord(i: {
  caseId: string
  skillName: string
  first: RoundRecord
  continuesFrom?: string
  now?: Date
}): ComposeCaseRecord {
  return {
    version: 1,
    caseId: i.caseId,
    skillName: i.skillName,
    ...(i.continuesFrom ? { continuesFrom: i.continuesFrom } : {}),
    status: 'active',
    rounds: [i.first],
    humanRejections: [],
    originChoices: [],
    updatedAt: (i.now ?? new Date()).toISOString()
  }
}

export const newToken = (): string => randomBytes(8).toString('hex')

export interface WorkspaceMetaLite {
  caseId?: string
  round?: number
  caseDir?: string
  skillName?: string
  compositeRequestId?: string
  sources?: unknown[]
  startedAt?: string
  continuesFrom?: string
  headless?: boolean
}

export function readMetaLite(workspaceDir: string): WorkspaceMetaLite | null {
  try {
    return JSON.parse(readFileSync(join(workspaceDir, 'meta.json'), 'utf-8')) as WorkspaceMetaLite
  } catch {
    return null
  }
}

/** 作業場（`compose/` の直下）を全部読む。meta.json が読めないものは含めない */
export function listWorkspaceMetas(
  paths: ComposePaths
): Array<{ dir: string; meta: WorkspaceMetaLite }> {
  if (!existsSync(paths.workspacesDir)) return []
  const out: Array<{ dir: string; meta: WorkspaceMetaLite }> = []
  for (const name of readdirSync(paths.workspacesDir)) {
    if (name.startsWith('.')) continue
    const dir = join(paths.workspacesDir, name)
    const meta = readMetaLite(dir)
    if (meta) out.push({ dir, meta })
  }
  return out
}

/** 案件の記録がある作業場（第 1 巡）を探す */
export function findCaseDir(paths: ComposePaths, caseId: string): string | null {
  for (const { dir, meta } of listWorkspaceMetas(paths)) {
    if (meta.caseId === caseId && (meta.round ?? 1) === 1 && existsSync(caseFilePath(dir)))
      return dir
  }
  return null
}

/** ある作業場が属する案件の記録の置き場（第 1 巡ならその作業場、第 2 巡以降は meta の caseDir、無ければ探す） */
export function caseDirOfWorkspace(
  paths: ComposePaths,
  workspaceDir: string,
  meta: WorkspaceMetaLite
): string | null {
  if (!meta.caseId) return null
  if ((meta.round ?? 1) === 1) return workspaceDir
  if (typeof meta.caseDir === 'string' && existsSync(caseFilePath(meta.caseDir)))
    return meta.caseDir
  return findCaseDir(paths, meta.caseId)
}

/** 同じ案件・同じ巡の作業場があるか（二重起動の禁止） */
export function roundWorkspaceExists(paths: ComposePaths, caseId: string, round: number): boolean {
  return listWorkspaceMetas(paths).some(
    ({ meta }) => meta.caseId === caseId && (meta.round ?? 1) === round
  )
}

export function readStage(workspaceDir: string): ComposeStageMarker | null {
  try {
    const j = JSON.parse(
      readFileSync(join(workspaceDir, STAGE_FILE), 'utf-8')
    ) as ComposeStageMarker
    return j && (j.stage === 'checking' || j.stage === 'reviewing') && typeof j.at === 'string'
      ? j
      : null
  } catch {
    return null
  }
}

export function writeStage(
  workspaceDir: string,
  stage: ComposeStageMarker['stage'],
  now: Date = new Date()
): void {
  const marker: ComposeStageMarker = { stage, at: now.toISOString() }
  writeFileSync(join(workspaceDir, STAGE_FILE), JSON.stringify(marker), 'utf-8')
}

// ---- 判定の結果を案件の記録へ書く ----

export interface AppliedDecision {
  /** 次の巡を予約したとき、その巡の番号 */
  reservedRound?: number
}

/**
 * 判定の結果を案件の記録へ反映する（呼び出し側がロックの下で呼ぶ）。巡を decided にし、状態を決め、next-round なら次の巡を予約する。
 * 予約は同じ更新で書くので、「判定は済んだが予約が無い」状態は残らない。
 */
export function applyDecision(
  c: ComposeCaseRecord,
  i: {
    round: number
    decision: RoundDecision
    counts: OriginCounts
    stop: StopQuestion | null
    compositeId?: string
    section1?: Section1Row[]
    now: Date
    ownerPid: number
  }
): AppliedDecision {
  const iso = i.now.toISOString()
  const r = c.rounds.find((x) => x.round === i.round)
  if (r) {
    r.state = 'decided'
    r.decision = i.decision
    r.decidedAt = iso
    r.counts = { ...i.counts }
    if (i.compositeId) r.compositeId = i.compositeId
    if (i.section1) r.section1 = i.section1
  }
  delete c.stop
  delete c.answer
  if (i.decision === 'approve') {
    c.status = 'awaiting-approval'
    return {}
  }
  if (i.decision === 'stop-d') {
    c.status = 'awaiting-approval'
    if (i.stop) c.stop = { ...i.stop, at: iso }
    return {}
  }
  if (i.decision === 'next-round') {
    return reserveRound(c, i.round + 1, i.now, i.ownerPid)
  }
  c.status = 'stopped'
  if (i.stop) c.stop = { ...i.stop, at: iso }
  return {}
}

/**
 * 次の巡を予約する（呼び出し側がロックの下で呼ぶ）。第 3 巡の後は何があっても予約しない。
 * 同じ番号の巡が既にあれば何もしない（二重起動の禁止）。
 */
export function reserveRound(
  c: ComposeCaseRecord,
  round: number,
  now: Date,
  ownerPid: number
): AppliedDecision & { refused?: string } {
  if (round > COMPOSE_ROUND_MAX)
    return { refused: `第 ${COMPOSE_ROUND_MAX} 巡の後は次の巡を始めません` }
  if (c.rounds.some((r) => r.round === round)) return { refused: `第 ${round} 巡は既にあります` }
  c.rounds.push({
    round,
    state: 'reserved',
    token: newToken(),
    reservedAt: now.toISOString(),
    ownerPid,
    generationAttempts: 0
  })
  c.status = 'active'
  delete c.stop
  return { reservedRound: round }
}

// ---- 実行時の状態（CCPIT のプロセスごと） ----

export interface SeqEntry {
  workspace: string
  phase: string
  tMain: number
}

export interface ComposeRuntime {
  /** このランタイム（= プロセス）の識別子。独立レビューの起動権の持ち主を、同じプロセスの別の走査と見分けるのに使う */
  id: string
  /** いま finalize している作業場（同じプロセスの二重の finalize を防ぐ） */
  finalizing: Set<string>
  /** このプロセスが起動した改訂 AI の Promise（作業場ごと）。無ければ「CCPIT の再起動で止まった」と見なす */
  generations: Map<string, Promise<void>>
  /** 次の巡を起動している最中のキー（caseId#round）。同じプロセスの二重起動を防ぐ */
  launching: Set<string>
  /** 作業場ごとの直近の署名と seq */
  sigs: Map<string, { sig: string; seq: number }>
  seqLog: Map<number, SeqEntry>
  /** 作業場ごとに、最後に画面へ通知した seq（poller が使う。状態の取得だけでは進めない） */
  notified: Map<string, number>
  nextSeq: number
  /** 最初の走査を済ませたか（最初の走査で見た作業場は、変化として通知しない） */
  baselined: boolean
  /** 単調な時計（ミリ秒）。main の 1 本。試験は偽を差し込む */
  now: () => number
}

export function createComposeRuntime(now: () => number = () => performance.now()): ComposeRuntime {
  return {
    id: randomBytes(6).toString('hex'),
    finalizing: new Set(),
    generations: new Map(),
    launching: new Set(),
    sigs: new Map(),
    seqLog: new Map(),
    notified: new Map(),
    nextSeq: 0,
    baselined: false,
    now
  }
}

const RUNTIMES = new Map<string, ComposeRuntime>()

/** その `~/.ccpit` に対する実行時の状態（既定）。試験は runtime を deps に渡すか、forgetRuntime で CCPIT の再起動を模す */
export function runtimeFor(paths: ComposePaths): ComposeRuntime {
  let r = RUNTIMES.get(paths.workspacesDir)
  if (!r) {
    r = createComposeRuntime()
    RUNTIMES.set(paths.workspacesDir, r)
  }
  return r
}

export function forgetRuntime(paths: ComposePaths): void {
  RUNTIMES.delete(paths.workspacesDir)
}

/**
 * 画面に見える状態の署名。変わったら新しい seq を採番する。
 * 段・巡・件数・結果に加え、停止の 1 問の中身（推奨・選択肢・件数）、指摘ごとの裁定（決定と理由）、
 * 案件の記録の回答・状態・棄却と由来の選択の数（`rec`）を含める（回答だけ・理由の差し替えだけでも画面へ知らせる）
 */
export function statusSignature(
  s: {
    phase: string
    caseView?: ComposeCaseView
    round?: number
    stop?: StopQuestion
    counts?: OriginCounts
    findings?: FindingView[]
    result?: { ok: boolean; finishedAt: string; review?: { status: string } }
    /** 昇格済みの印（旧形式の作業場は caseView を持たないので、昇格をここで署名に入れる） */
    adopted?: { commit: string; ledgerStatus: string }
    /** L0_012: 窓つきの合成 CC の着手の状況（合図の出現を push するため） */
    ccStart?: string
  },
  rec?: ComposeCaseRecord | null
): string {
  return JSON.stringify([
    s.phase,
    s.caseView ?? null,
    s.round ?? null,
    s.stop ? [s.stop.reason, s.stop.recommended, s.stop.options, s.stop.counts] : null,
    s.counts ?? null,
    s.findings
      ? s.findings.map((f) => [
          f.gateId,
          f.origin,
          f.adjudication ? [f.adjudication.decision, f.adjudication.reason] : null
        ])
      : null,
    s.result ? [s.result.ok, s.result.finishedAt, s.result.review?.status ?? null] : null,
    rec
      ? [
          rec.status,
          rec.answer ? [rec.answer.option, rec.answer.at] : null,
          rec.humanRejections.length,
          rec.originChoices.length,
          rec.addressBaseFromRound ?? null,
          rec.rounds.map((r) => [r.round, r.decision ?? null])
        ]
      : null,
    // 昇格していない作業場の署名は従来と同じ文字列のまま（要素を足さない）
    ...(s.adopted ? [['adopted', s.adopted.commit, s.adopted.ledgerStatus]] : []),
    // 合図の項目が無い作業場の署名も従来と同じ文字列のまま
    ...(s.ccStart ? [['ccStart', s.ccStart]] : [])
  ])
}

export interface Observation {
  seq: number
  /** 前回の署名と違う（新しい作業場を含む） */
  changed: boolean
  /** この作業場を初めて見た */
  isNew: boolean
}

/** 作業場の署名を見て、変わっていれば新しい seq と時刻を記録する */
export function observe(
  rt: ComposeRuntime,
  workspaceDir: string,
  phase: string,
  sig: string
): Observation {
  const cur = rt.sigs.get(workspaceDir)
  if (cur && cur.sig === sig) return { seq: cur.seq, changed: false, isNew: false }
  const seq = ++rt.nextSeq
  rt.sigs.set(workspaceDir, { sig, seq })
  rt.seqLog.set(seq, { workspace: workspaceDir, phase, tMain: rt.now() })
  if (rt.seqLog.size > COMPOSE_SEQ_LOG_MAX) {
    const oldest = rt.seqLog.keys().next().value
    if (oldest !== undefined) rt.seqLog.delete(oldest)
  }
  return { seq, changed: true, isNew: !cur }
}

export interface RenderLatency {
  seq: number
  workspace: string
  phase: string
  tMain: number
  tAck: number
  latencyMs: number
  late: boolean
}

/** renderer が描画の直後に報告した seq の遅延を出す。環境変数があるときだけ JSONL に追記する（直近の行数だけ残す） */
export function recordRenderLatency(
  rt: ComposeRuntime,
  seq: unknown,
  env: NodeJS.ProcessEnv = process.env
): RenderLatency | null {
  if (typeof seq !== 'number' || !Number.isFinite(seq)) return null
  const e = rt.seqLog.get(seq)
  if (!e) return null
  const tAck = rt.now()
  const latencyMs = tAck - e.tMain
  const rec: RenderLatency = {
    seq,
    workspace: e.workspace,
    phase: e.phase,
    tMain: e.tMain,
    tAck,
    latencyMs,
    late: latencyMs > COMPOSE_UPDATE_SLO_MS
  }
  const file = env[COMPOSE_LATENCY_LOG_ENV]
  if (file) {
    try {
      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(file, JSON.stringify(rec) + '\n', 'utf-8')
      const lines = readFileSync(file, 'utf-8')
        .split('\n')
        .filter((l) => l !== '')
      if (lines.length > COMPOSE_LATENCY_LOG_MAX_LINES) {
        writeFileSync(file, lines.slice(-COMPOSE_LATENCY_LOG_MAX_LINES).join('\n') + '\n', 'utf-8')
      }
    } catch {
      /* 記録は測定用。書けなくても本体を止めない */
    }
  }
  return rec
}

// ---- 画面の項目 ----

export interface ProjectionInput {
  workspaceDir: string
  phase: ComposePhase
  meta: WorkspaceMetaLite
  stage: ComposeStageMarker | null
  rec: ComposeCaseRecord | null
  readRow: ReviewRowReader
  /** この作業場の合成提案の ID（登録後） */
  compositeId?: string
  /** 案件のどれかの巡の合成提案が昇格済み（合成台帳に application がある）。あれば caseView は adopted（終端） */
  adopted?: ComposeAdoptedInfo | null
}

const DECIDED_VIEWS: ReadonlySet<ComposeCaseView> = new Set<ComposeCaseView>([
  'awaiting-approval',
  'awaiting-approval-base',
  'stopped',
  'answer-pending',
  'held'
])

const TURN_OF: Record<ComposeCaseView, ComposeTurn> = {
  composing: 'ai',
  revising: 'ai',
  checking: 'ccpit',
  reviewing: 'ccpit',
  'awaiting-approval': 'you',
  'awaiting-approval-base': 'you',
  stopped: 'you',
  'answer-pending': 'you',
  held: 'you',
  cancelled: 'none',
  failed: 'you',
  adopted: 'none'
}

const countsBefore = (rec: ComposeCaseRecord, round: number): OriginCounts | undefined =>
  rec.rounds.filter((r) => r.round < round && r.counts).sort((a, b) => b.round - a.round)[0]?.counts

function viewFromCase(rec: ComposeCaseRecord | null, round: number): ComposeCaseView {
  if (!rec) return 'awaiting-approval'
  switch (rec.status) {
    case 'cancelled':
    case 'withdrawn':
      return 'cancelled'
    case 'failed':
      return 'failed'
    case 'held':
      return 'held'
    case 'stopped':
      return 'stopped'
    case 'answer-pending':
      return 'answer-pending'
    case 'active':
      return 'revising'
    case 'awaiting-approval': {
      const counts = rec.rounds.find((r) => r.round === round)?.counts
      return rec.stop?.reason === 'd' || (counts?.base ?? 0) > 0
        ? 'awaiting-approval-base'
        : 'awaiting-approval'
    }
  }
}

export function findingViewsFromRow(row: ReviewRow | undefined): FindingView[] {
  if (!row || !Array.isArray(row.findingOrigins)) return []
  const adjOk =
    Array.isArray(row.adjudications) && row.adjudicationsFor === sha256Hex(row.findings ?? '')
  return row.findingOrigins.map((o): FindingView => {
    const a = adjOk && o.gateId ? row.adjudications!.find((x) => x.id === o.gateId) : undefined
    const decision =
      a && (a.decision === 'rejected' || a.decision === 'deferred') ? a.decision : undefined
    return {
      gateId: o.gateId,
      reviewerNo: o.reviewerNo,
      carried: o.carried,
      origin: o.origin,
      severity: o.severity,
      title: o.title,
      where: o.where,
      reviewerOrigin: o.reviewerOrigin,
      machineOrigin: o.machineOrigin,
      agree: o.agree,
      citedRanges: o.citedRanges ?? [],
      ...(decision && a ? { adjudication: { decision, reason: String(a.reason ?? '') } } : {})
    }
  })
}

/**
 * 案件の項目（caseView・turn・巡・件数・停止・指摘・受け皿）を作業場の状態から作る。caseId の無い（旧形式の）作業場は null。
 * 画面の表示の行列（Plan r3 §2 W3）の行に合わせる。
 */
export function projectCaseFields(i: ProjectionInput): ComposeCaseFields | null {
  const meta = i.meta
  if (!meta.caseId) return null
  const rec = i.rec
  const myRound = meta.round ?? 1
  const latest = rec ? lastRoundOf(rec) : undefined

  let view: ComposeCaseView
  // 昇格済みは golden が書き換わった事実なので、作業場の段・案件の記録（case.json は昇格で書き換えない）より優先する
  if (i.adopted) {
    return {
      caseId: meta.caseId,
      round: myRound,
      roundMax: COMPOSE_ROUND_MAX,
      caseView: 'adopted',
      turn: TURN_OF.adopted,
      findings: [],
      receptacles: receptaclesOf(rec, i.readRow),
      sourceCount: Array.isArray(meta.sources) ? meta.sources.length : 0,
      ...continuesFromOf(meta, rec)
    }
  }
  switch (i.phase) {
    case 'cancelled':
      view = 'cancelled'
      break
    case 'failed':
      view = 'failed'
      break
    case 'running':
      view = myRound > 1 ? 'revising' : 'composing'
      break
    case 'finalizing':
      view = 'checking'
      break
    case 'reviewing':
      view = 'reviewing'
      break
    default:
      view = viewFromCase(rec, myRound)
  }
  // 登録済みの作業場の案件が「改訂中」（次の巡を予約・起動中）のとき、見せる巡は予約した巡
  const round =
    view === 'revising' && i.phase === 'registered' ? (latest?.round ?? myRound) : myRound
  const rr = rec?.rounds.find((r) => r.round === myRound)

  const counts = DECIDED_VIEWS.has(view) ? rr?.counts : undefined
  const prevCounts =
    DECIDED_VIEWS.has(view) || view === 'revising'
      ? rec
        ? countsBefore(rec, round)
        : undefined
      : undefined

  let phaseStartedAt: string | undefined
  if (view === 'composing' || view === 'revising') {
    phaseStartedAt =
      i.phase === 'registered' ? (latest?.reservedAt ?? meta.startedAt) : meta.startedAt
  } else if (view === 'checking' || view === 'reviewing') {
    phaseStartedAt = i.stage?.at ?? meta.startedAt
  } else if (DECIDED_VIEWS.has(view)) {
    phaseStartedAt = rr?.decidedAt ?? rec?.updatedAt
  }

  const compositeId = i.compositeId ?? rr?.compositeId
  let row: ReviewRow | undefined
  if (DECIDED_VIEWS.has(view)) {
    if (rr?.decision === 'stop-e' && rec) {
      // 停止 (e) の巡は独立レビューを走らせていない。指摘は、台帳の行が残っている前の巡のもの
      for (let k = myRound - 1; k >= 1 && !row; k--) {
        const pid = rec.rounds.find((x) => x.round === k)?.compositeId
        const pr = pid ? i.readRow(pid) : undefined
        if (pr?.reviewScope?.kind === 'compose-diff') row = pr
      }
    } else if (compositeId) {
      row = i.readRow(compositeId)
    }
  }
  const showStop =
    !!rec?.stop &&
    (view === 'stopped' || (view === 'awaiting-approval-base' && rec.stop.reason === 'd'))
  let stop: StopQuestion | undefined
  if (showStop && rec?.stop) {
    const { at: _at, ...q } = rec.stop
    void _at
    stop = q
  }
  return {
    caseId: meta.caseId,
    round,
    roundMax: COMPOSE_ROUND_MAX,
    caseView: view,
    turn: TURN_OF[view],
    ...(phaseStartedAt ? { phaseStartedAt } : {}),
    ...(counts ? { counts } : {}),
    ...(prevCounts ? { prevCounts } : {}),
    ...(stop ? { stop } : {}),
    findings: findingViewsFromRow(row),
    receptacles: receptaclesOf(rec, i.readRow),
    sourceCount: Array.isArray(meta.sources) ? meta.sources.length : 0,
    ...continuesFromOf(meta, rec)
  }
}

/** 案件の全巡の台帳の行から、原文由来の指摘を入れた受け皿のパスを集める */
function receptaclesOf(rec: ComposeCaseRecord | null, readRow: ReviewRowReader): string[] {
  const receptacles = new Set<string>()
  if (rec) {
    for (const r of rec.rounds) {
      const rw = r.compositeId ? readRow(r.compositeId) : undefined
      for (const p of rw?.baseFindingRefs ?? []) receptacles.add(p)
    }
  }
  return [...receptacles]
}

function continuesFromOf(
  meta: WorkspaceMetaLite,
  rec: ComposeCaseRecord | null
): { continuesFrom?: string } {
  if (typeof meta.continuesFrom === 'string') return { continuesFrom: meta.continuesFrom }
  return rec?.continuesFrom ? { continuesFrom: rec.continuesFrom } : {}
}

/**
 * 案件の昇格済みの印。案件のどれかの巡の合成提案（とこの作業場の合成提案）について、合成台帳のエントリを引き、
 * application のあるものがあれば返す（新しい巡を優先）。無ければ null
 */
export function caseAdoptedInfo(
  rec: ComposeCaseRecord | null,
  ownCompositeId: string | undefined,
  entryOf: (compositeId: string) => Parameters<typeof adoptedInfoFromLedgerEntry>[0]
): ComposeAdoptedInfo | null {
  const ids: string[] = []
  if (rec) for (const r of [...rec.rounds].sort((a, b) => b.round - a.round)) if (r.compositeId) ids.push(r.compositeId)
  if (ownCompositeId && !ids.includes(ownCompositeId)) ids.push(ownCompositeId)
  for (const id of ids) {
    const info = adoptedInfoFromLedgerEntry(entryOf(id))
    if (info) return info
  }
  return null
}

// ---- 回答の選択肢の検査 ----

/** 案件がいま受け付ける回答の選択肢（停止の 1 問に出した選択肢。保留中は解除だけ） */
export function allowedAnswerOptions(c: ComposeCaseRecord): ComposeAnswerOption[] {
  if (c.status === 'held') return ['resume-hold']
  if ((c.status === 'stopped' || c.status === 'awaiting-approval') && c.stop) return c.stop.options
  return []
}

/** 案件の最後の巡が、次の巡を始められる位置か（第 3 巡の後は始められない） */
export const canReserveNextRound = (c: ComposeCaseRecord): boolean => {
  const last = lastRoundOf(c)
  return !!last && last.round < COMPOSE_ROUND_MAX
}
