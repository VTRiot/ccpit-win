/**
 * composeContract — golden 同名提案の合成の「由来で分けるレビュー」「巡」「画面の手番」の契約（CCPIT_L0_011）。
 *
 * main（合成の実行・レビュー・台帳）と renderer（カード）の両方が読む。型・定数・純関数だけを置き、fs や electron に触れない。
 * 契約の変更は頭（実装レーンの統合役）だけが行う。消費側はここを import して使い、同じ定義を自前で持たない。
 *
 * 行番号はすべて 1 始まり・両端を含む（`L12-30` は 12 行目から 30 行目まで）。
 */

// ---- 数字（数字の札は Plan r3 §8） ----

/** 自動で回す巡の上限（第 1 巡＝最初の合成。改訂は最大 2 回）。【仮置き】見直し: 収束までの巡数の記録 10 件 */
export const COMPOSE_ROUND_MAX = 3
/** 遷移から描画までの上限・「更新待ち」を出す閾値（暫定 SLO）。【仮置き】見直し: 遅延 10 件の p95 */
export const COMPOSE_UPDATE_SLO_MS = 5000
/** 合図のポーラーと renderer の取り直しの間隔。既存のポーラーの値（composeIpc.ts の既定）をここへ移して共有する */
export const COMPOSE_POLL_INTERVAL_MS = 3000
/** 改訂 AI（窓を出さない claude -p）の 1 巡の時間の上限。【仮置き】最初の合成の実測 ≒ 3 分の 10 倍。見直し: 実測 3 件 */
export const COMPOSE_REVISE_TIMEOUT_MS = 30 * 60 * 1000
/** 改訂 AI の 1 巡の費用の上限（--max-budget-usd）。【仮置き】見直し: 実測 3 件の最大の 2 倍へ */
export const COMPOSE_REVISE_MAX_BUDGET_USD = 5
/** CCPIT の再起動で生成が止まったときに、同じ巡を起動し直してよい回数の合計（最初の 1 回を含む） */
export const COMPOSE_GENERATION_ATTEMPTS_MAX = 2
/**
 * 窓つきの合成 CC の起動から、着手の合図が来ないまま「窓が見当たらないとき」の案内を出すまで（CCPIT_L0_012 W1・AC11）。
 * 【根拠・設計承認済み】実データ 8 件で起動→最初の道具呼び出しが最大 25.8 秒（合図を書く時刻の近似）の約 1.75 倍。
 * 見直し: 本物の起動で合図が N 秒超になった記録 3 件
 */
export const COMPOSE_WINDOW_WAIT_HINT_MS = 45 * 1000

// ---- 環境変数 ----

/** 遅延のログを書く先（隔離起動・試験のときだけ有効。本番の実データには書かない） */
export const COMPOSE_LATENCY_LOG_ENV = 'CCPIT_COMPOSE_LATENCY_LOG'
/** 隔離起動の画面確認で、合成 CC・改訂 AI・レビュアーを台本の偽に差し替える（isIsolatedLaunch() のときだけ有効） */
export const COMPOSE_FAKE_SCENARIO_ENV = 'CCPIT_COMPOSE_FAKE_SCENARIO'

// ---- IPC のチャネル ----

export const COMPOSE_IPC = {
  status: 'skillProposals:composeStatus',
  statusPush: 'compose:status',
  answer: 'skillProposals:composeAnswer',
  adjudicate: 'skillProposals:composeAdjudicate',
  rendered: 'skillProposals:composeRendered',
  receptacles: 'skillProposals:receptacles',
  receptacleClose: 'skillProposals:receptacleClose'
} as const

// ---- 合成の段 ----

/** 作業場の段。`reviewing` は L0_011 で追加（登録の後、独立レビューの判定を待つ間） */
export type ComposePhase = 'running' | 'finalizing' | 'reviewing' | 'registered' | 'failed' | 'cancelled'

/** 作業場の `stage.json`（finalize の段の切替ごとに書く） */
export interface ComposeStageMarker {
  stage: 'checking' | 'reviewing'
  /** ISO 時刻（画面の経過時間の起点） */
  at: string
}

// ---- 着手の合図（CCPIT_L0_012 W1 状態 3） ----
//
// 誰が: 窓つきで起動した合成 CC（最初の巡）。依頼文の冒頭の節「最初にすること」で、ほかの何よりも先に書く。
// どこに: 作業場の COMPOSE_STARTED_FILE。中身は ComposeStartedSignal（JSON）。
// 固有の値: CCPIT が起動の直前に 16 進 COMPOSE_LAUNCH_NONCE_HEX_LEN 桁を発行し、依頼文にだけ平文で埋める。
//   meta.json には sha256 だけを置く（launchNonceSha256）。CCPIT は sha256 が一致する合図だけを「着手した」と数える。
// 信頼水準: 「この起動の依頼文を読んだ者」まで（READY のハッシュ束縛と同じ）。CC がその後に止まったことは検出しない。

/** 着手の合図のファイル（作業場からの相対パス） */
export const COMPOSE_STARTED_FILE = 'out/STARTED.json'
/** 起動ごとの固有の値の長さ（16 進の桁数＝128 bit） */
export const COMPOSE_LAUNCH_NONCE_HEX_LEN = 32
/** 合図のファイルを読む上限（中身は 50 字程度。大きなファイルは読まずに「合図なし」とする） */
export const COMPOSE_STARTED_FILE_MAX_BYTES = 1024

export interface ComposeStartedSignal {
  launchNonce: string
}

/** 窓つきの合成 CC の着手の状況。waiting＝起動した・合図はまだ／working＝この起動の合図を確かめた */
export type ComposeCcStart = 'waiting' | 'working'

/**
 * ComposeStatus に任意で足す項目。値を入れるのは「窓つきの起動（meta に launchNonceSha256 がある）かつ段が running」の
 * ときだけ。それ以外（検査の段より後・窓なしの巡・旧い作業場）では常に欠落する
 */
export interface ComposeWindowFields {
  ccStart?: ComposeCcStart
}

// ---- 由来 ----

/** 確定した由来 */
export type FindingOrigin = 'diff' | 'base' | 'unclear'
/** 機械判定（`where:` の範囲と変更行の突き合わせ）。missing ＝ 範囲を取り出せない・境界情報が無い */
export type MachineOrigin = 'diff' | 'base' | 'missing'
/** レビュアーの申告。none ＝ origin 行が無い */
export type ReviewerOrigin = 'diff' | 'base' | 'unclear' | 'none'

export interface LineRange {
  start: number
  end: number
}

/** ファイルのラベルは `[ja]SKILL.md`・`[en]SKILL.md`・`[ja]references/x.md` の形 */
export interface FileChangedRanges {
  file: string
  ranges: LineRange[]
  /** false ＝ 変更行を算出できなかった（このファイルを指す指摘の機械判定は missing） */
  boundaryOk: boolean
  /** そのファイルの行数（合成提案側） */
  lineCount: number
}

export interface CitedRange {
  file: string
  range: LineRange
  /** この範囲が変更行に掛かるか */
  changed: boolean
}

/**
 * 由来の確定（失敗安全）。機械判定と申告が一致し、かつ両方が diff または base のときだけ、その由来に確定する。
 * それ以外（食い違い・申告なし・申告 unclear・missing）は全部 unclear。
 */
export function settleOrigin(machine: MachineOrigin, reviewer: ReviewerOrigin): FindingOrigin {
  if (machine === 'base' && reviewer === 'base') return 'base'
  if (machine === 'diff' && reviewer === 'diff') return 'diff'
  return 'unclear'
}

// ---- レビューの指摘 ----

export type FindingSeverity = 'critical' | 'major' | 'minor' | 'unknown'

/** レビュアーの出力から切り出した指摘 1 件 */
export interface ParsedFinding {
  /** レビュアーの番号（'1'…）か、持ち越しの指摘の番号（'H1'…） */
  reviewerNo: string
  carried: boolean
  severity: FindingSeverity
  title: string
  where: string
  claim: string
  impact: string
  suggestion: string
  reviewerOrigin: ReviewerOrigin
  /** 元の本文のブロック（台帳の findings に入れるときの材料） */
  block: string
}

export interface ClassifiedFinding extends ParsedFinding {
  machineOrigin: MachineOrigin
  origin: FindingOrigin
  citedRanges: CitedRange[]
  agree: boolean
  /** 台帳の findings（ゲートに渡る集合）での番号。原文由来は null */
  gateId: string | null
}

export interface OriginCounts {
  diff: number
  base: number
  unclear: number
}

/** 台帳の行に残す、指摘ごとの由来の記録 */
export interface FindingOriginRecord {
  reviewerNo: string
  carried: boolean
  gateId: string | null
  severity: FindingSeverity
  title: string
  where: string
  reviewerOrigin: ReviewerOrigin
  machineOrigin: MachineOrigin
  origin: FindingOrigin
  citedRanges: CitedRange[]
  agree: boolean
}

/** 台帳の行の「問うた範囲」 */
export interface ComposeReviewScope {
  kind: 'compose-diff'
  caseId: string
  round: number
  /** 合成提案 MD の computeProposalHash（台帳の proposal_hash と同じ値） */
  proposalHash: string
  /** 依頼文の sha256 */
  requestSha256: string
  changedRanges: FileChangedRanges[]
}

/** setProposalReview の extra として台帳の行へ足す項目（合成提案のレビューだけ） */
export interface ComposeReviewLedgerExtra {
  reviewScope: ComposeReviewScope
  /** Codex の VERDICT（実効の verdict とは別） */
  reviewerVerdict: string
  /** Codex の生の本文 */
  reviewerFindings: string
  findingOrigins: FindingOriginRecord[]
  /** 原文由来の指摘を入れた受け皿のパス */
  baseFindingRefs: string[]
}

/** 合成のレビューの結果（finalize が受け取る） */
export interface ComposeReviewOutcome {
  status: 'ok' | 'reviewer-unavailable' | 'proposal-id-missing' | 'launch-failed' | 'output-unusable' | 'scope-failed'
  message?: string
  /** 実効の verdict（差分 0・不明 0 なら approve） */
  verdict?: 'approve' | 'needs-attention'
  reviewerVerdict?: string
  findings: ClassifiedFinding[]
  counts: OriginCounts
  scope?: ComposeReviewScope
}

/** 依頼文の「経緯」に載せる 1 行 */
export interface ReviewHistoryItem {
  /** 前の巡の番号（'2-1' のように巡-番号）か 'H1' */
  no: string
  title: string
  origin: FindingOrigin | 'unknown'
  decision: 'adopted' | 'rejected' | 'deferred' | 'not-applied' | 'carried'
  reason: string
}

/** 持ち越しの指摘（同じ元提案の集合に対する過去の合成提案のレビューの指摘）。依頼文で H1…Hn として渡す */
export interface CarriedFinding {
  no: string
  /** どの合成提案のレビューから持ち越したか */
  fromCompositeId: string
  title: string
  where: string
  /** 元の本文のブロック（非命令データとして依頼文へ入れる） */
  block: string
}

/**
 * finalize が runReview の第 2 引数で渡す文脈（caseId を持つ作業場だけ）。
 * 旧形式の作業場では渡さない（runReview は従来の { status, verdict, message } を返してよい）。
 */
export interface ComposeReviewContext {
  caseId: string
  round: number
  workspaceDir: string
  /** 作業場の golden の写し（`<goldenDir>/<lang>/skills/<skill>/<relPath>`） */
  goldenDir: string
  skillName: string
  history: ReviewHistoryItem[]
  carried: CarriedFinding[]
  /** 受け皿の持ち主の既定（元提案の author／issuer。分からなければ RECEPTACLE_DEFAULT_OWNER） */
  owner: string
  /** 元提案の request_id（受け皿の記録用） */
  sourceIds: string[]
}

// ---- 改訂の合成提案 §1 の採否の表 ----

/** 改訂 AI が §1 に書く表の見出し */
export const SECTION1_DECISION_TABLE_HEADING = '前回の指摘の採否'
/** 表の列（この順） */
export const SECTION1_DECISION_TABLE_COLUMNS = ['前回番号', '由来', '採否', '理由'] as const
/** 由来の列に書く語 */
export const SECTION1_ORIGIN_WORDS = { diff: '差分', base: '原文', unresolved: '確定できない' } as const
/** 採否の列に書く語 */
export const SECTION1_DECISION_WORDS = { adopted: '反映', rejected: '棄却', notApplied: '反映しない' } as const

export interface Section1Row {
  prevNo: string
  origin: 'diff' | 'base' | 'unresolved'
  decision: 'adopted' | 'rejected' | 'not-applied'
  reason: string
}

// ---- 巡と案件 ----

export type RoundState = 'reserved' | 'launched' | 'ready' | 'registered' | 'reviewed' | 'decided'

export type RoundDecision = 'approve' | 'stop-d' | 'next-round' | 'stop-a' | 'stop-b' | 'stop-c' | 'stop-e'

export type StopReason = 'a' | 'b' | 'c' | 'd' | 'e'

export type ComposeAnswerOption =
  | 'split-and-proceed'
  | 'address-base'
  | 'hold'
  | 'resume-hold'
  | 'consult'
  | 'withdraw'
  | 'reject-and-next'
  | 'request-revision'
  | 'choose-origins-and-revise'

export interface StopQuestion {
  reason: StopReason
  round: number
  recommended: ComposeAnswerOption
  options: ComposeAnswerOption[]
  /** 停止の時点の件数（文面の補間に使う） */
  counts: OriginCounts
  /** (b) の前巡の差分由来の件数 */
  prevDiff?: number
  /** (c) の戻った指摘の件数 */
  repeated?: number
}

export interface RoundRecord {
  round: number
  state: RoundState
  /** 予約の札（同じ巡の二重起動を防ぐ） */
  token: string
  reservedAt: string
  ownerPid: number
  workspaceDir?: string
  compositeId?: string
  generationAttempts: number
  counts?: OriginCounts
  decision?: RoundDecision
  decidedAt?: string
  /** 改訂の巡で §1 から読んだ採否の表 */
  section1?: Section1Row[]
}

export type ComposeCaseStatus =
  | 'active'
  | 'awaiting-approval'
  | 'stopped'
  | 'answer-pending'
  | 'held'
  | 'withdrawn'
  | 'cancelled'
  | 'failed'

/** maintainerが UI で記録した棄却（次の巡の入力） */
export interface HumanRejection {
  round: number
  gateId: string
  reason: string
  at: string
}

/** (e) で人が選んだ由来 */
export interface OriginChoice {
  round: number
  gateId: string
  origin: 'diff' | 'base'
  at: string
}

/** 案件の記録（第 1 巡の作業場の case.json） */
export interface ComposeCaseRecord {
  version: 1
  caseId: string
  skillName: string
  /** 旧形式の合成提案から続けたときの、その ID */
  continuesFrom?: string
  status: ComposeCaseStatus
  rounds: RoundRecord[]
  stop?: StopQuestion & { at: string }
  answer?: { option: ComposeAnswerOption; at: string }
  humanRejections: HumanRejection[]
  originChoices: OriginChoice[]
  /** (d) で「原文への指摘を反映する」が選ばれた巡（その次の巡だけ原文由来を反映してよい） */
  addressBaseFromRound?: number
  updatedAt: string
}

// ---- 画面の DTO（ComposeStatus に足す項目） ----

export type ComposeTurn = 'ai' | 'ccpit' | 'you' | 'none'

/** カードの状態（表示の行列の行） */
export type ComposeCaseView =
  | 'composing'
  | 'revising'
  | 'checking'
  | 'reviewing'
  | 'awaiting-approval'
  | 'awaiting-approval-base'
  | 'stopped'
  | 'answer-pending'
  | 'held'
  | 'cancelled'
  | 'failed'
  /** 昇格済み（合成台帳のエントリに application がある）。終端。case.json の状態より優先する */
  | 'adopted'

/**
 * 昇格済みの印（合成台帳 `proposal-merges.json` のエントリに `application` があるとき main が付ける）。
 * 案件の作業場・旧形式の作業場の両方に付く。台帳の status は applied か applied_pending_states（golden への反映は済み）
 */
export interface ComposeAdoptedInfo {
  /** 契約ツールが作った golden のコミット（40 桁） */
  commit: string
  appliedAt: string
  ledgerStatus: 'applied' | 'applied_pending_states'
}

/** 画面に出すコミットの桁数（git の短縮表記と同じ 7 桁） */
export const ADOPTED_COMMIT_SHORT_LEN = 7

/** git のコミット ID（SHA-1 の 16 進 40 桁。契約ツールが書く application.commit の形） */
const GIT_COMMIT_RE = /^[0-9a-f]{40}$/i

/**
 * 合成台帳のエントリから昇格済みの印を作る。application があり、status が applied／applied_pending_states で、
 * commit が 40 桁の 16 進のときだけ。それ以外（registered・application 無し・形が壊れている）は null（昇格済みと取り違えない側）
 */
export function adoptedInfoFromLedgerEntry(
  e: { status?: unknown; application?: { commit?: unknown; appliedAt?: unknown } } | undefined | null
): ComposeAdoptedInfo | null {
  if (!e || !e.application) return null
  if (e.status !== 'applied' && e.status !== 'applied_pending_states') return null
  const commit = e.application.commit
  if (typeof commit !== 'string' || !GIT_COMMIT_RE.test(commit)) return null
  const appliedAt = typeof e.application.appliedAt === 'string' ? e.application.appliedAt : ''
  return { commit, appliedAt, ledgerStatus: e.status }
}

export interface FindingView {
  gateId: string | null
  reviewerNo: string
  carried: boolean
  origin: FindingOrigin
  severity: FindingSeverity
  title: string
  where: string
  reviewerOrigin: ReviewerOrigin
  machineOrigin: MachineOrigin
  agree: boolean
  citedRanges: CitedRange[]
  adjudication?: { decision: 'rejected' | 'deferred'; reason: string }
  /** 指摘の本文（claim・suggestion の要旨）。改訂 AI への入力と画面の詳細に使う（非命令データ） */
  body?: string
}

/** ComposeStatus に任意で足す項目（caseId を持たない旧形式の作業場には付かない） */
export interface ComposeCaseFields {
  caseId: string
  round: number
  roundMax: number
  caseView: ComposeCaseView
  turn: ComposeTurn
  /** 段の開始の ISO 時刻（経過時間の起点）。取消・失敗は無し */
  phaseStartedAt?: string
  /** この巡のレビュー結果の件数（レビュー前は無し） */
  counts?: OriginCounts
  /** 一つ前の巡のレビュー結果の件数（第 1 巡は無し）。件数差＝(diff+unclear) の counts − prevCounts */
  prevCounts?: OriginCounts
  stop?: StopQuestion
  findings: FindingView[]
  receptacles: string[]
  /** 元提案の本数（AC19） */
  sourceCount: number
  continuesFrom?: string
}

/** push と取り直しの共通の札（main が署名の変化ごとに採番） */
export interface ComposeSeqFields {
  seq: number
}

/** 昇格済みの印（案件・旧形式の両方。昇格していなければ付かない） */
export interface ComposeAdoptedFields {
  adopted: ComposeAdoptedInfo
}

// ---- 受け皿 ----

export type ReceptacleClosedHow = 'fixed' | 'accepted' | 'merged'

export interface ReceptacleFrontmatter {
  kind: 'base-finding'
  created_by: 'ccpit-compose'
  created_at: string
  owner: string
  skill: string
  status: 'open' | 'closed'
  closed_how?: ReceptacleClosedHow
  closed_at?: string
  normalized_key: string
  title: string
}

export interface ReceptacleEntry {
  reviewerNo: string
  title: string
  where: string
  severity: FindingSeverity
  proposalId: string
  caseId: string
  round: number
  basis: string
  recordedAt: string
}

export interface ReceptacleSummary {
  path: string
  skill: string
  status: 'open' | 'closed'
  owner: string
  title: string
  normalizedKey: string
  createdAt: string
  closedHow?: ReceptacleClosedHow
  entryCount: number
}

/** 受け皿の持ち主の既定（元提案の起票者が分からないとき） */
export const RECEPTACLE_DEFAULT_OWNER = 'maintainer（golden skill の管理者）'

// ---- 正規化（W2(c) の「同じ指摘」と、受け皿の重複の判定で共有） ----

/** `where:` から節の部分（ファイルのラベル・§番号・見出し）を取り出して正規化する。行番号は捨てる */
export function normalizeWhereSection(where: string): string {
  const s = where.normalize('NFKC')
  const labels = s.match(/\[(?:ja|en)\][^\s,、:：]+/g) ?? []
  const sections = s.match(/§\s*[0-9]+(?:-[0-9]+)?(?:\s*[A-Z])?/g) ?? []
  const parts = [...labels, ...sections.map((x) => x.replace(/\s+/g, ''))]
  if (parts.length === 0) return normalizeText(s.replace(/L\d+(?:-\d+)?/g, ''))
  return [...new Set(parts)].sort().join('|').toLowerCase()
}

/** 要旨の正規化（NFKC・空白・句読点・記号を除き、小文字にする） */
export function normalizeText(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[、。，．,.・:：;；!！?？「」『』（）()[\]【】<>＜＞"'`~〜\-—_/\\|]+/g, '')
}

/** 「同じ指摘」の鍵（`where:` の節が同じかつ要旨の正規化文字列が同じ） */
export function findingKey(where: string, title: string): string {
  return `${normalizeWhereSection(where)}#${normalizeText(title)}`
}
