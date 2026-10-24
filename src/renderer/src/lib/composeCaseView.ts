/**
 * composeCaseView — 合成の「案件」（caseId を持つ作業場）の状態を、カードに出す文面・表示の行列・ボタン・指摘の行へ
 * 変換する純関数（CCPIT_L0_011 Plan r3 §2 W3・W4・W5）。ja/en の両方を返す。
 *
 * 旧形式（caseId を持たない作業場）は composeStatusView.ts が従来どおり扱う。ここは案件の分だけ。
 * 文面は Plan §2 W5 の「文言期待表」と 1 対 1（composeWordingTable.test.ts が全セルを突き合わせる）。
 * 数値（巡の上限・更新待ちの閾値・取り直しの間隔）は src/shared/composeContract.ts の定数を使い、ここで直書きしない。
 */
import {
  COMPOSE_ROUND_MAX,
  COMPOSE_UPDATE_SLO_MS,
  COMPOSE_WINDOW_WAIT_HINT_MS,
  type ComposeAnswerOption,
  type ComposeCaseFields,
  type ComposeCaseView,
  type ComposeCcStart,
  type ComposePhase,
  type FindingOrigin,
  type FindingView,
  type OriginCounts,
  type ReceptacleClosedHow,
  type ReceptacleSummary,
  type ReviewerOrigin,
  type StopQuestion
} from '../../../shared/composeContract'
import {
  adaptedDetailLines,
  adoptedHeadline,
  adoptedNextLine,
  excludedIdsLine,
  shortCommit
} from './composeStatusView'

// ---- 入力 ----

/** カードが読む status（preload の ComposeStatusDto と構造が合う部分だけ） */
export interface CaseStatusInput extends Partial<ComposeCaseFields> {
  phase: ComposePhase
  skillName: string
  compositeRequestId: string
  workspaceDir?: string
  startedAt?: string
  seq?: number
  sourceIds?: string[]
  excludedIds?: string[]
  revises?: string
  /** 昇格済みの印（main が合成台帳の application から付ける） */
  adopted?: { commit: string }
  /** L0_012: 窓つきの合成 CC の着手の状況（main が窓つきの起動・段 running の間だけ付ける） */
  ccStart?: ComposeCcStart
  result?: {
    ok: boolean
    stage?: string
    error?: string
    compositeId?: string
    adapted?: Array<{ key: string; sourceId: string; relPath: string; lang: 'ja' | 'en'; reason: string; preview: string }>
    review?: { status: string; verdict?: string; message?: string }
  }
}

// ---- 出力 ----

export type CaseButtonAction =
  | 'cancel'
  | 'openPromotion'
  | 'answer'
  | 'consult'
  | 'adjudicate'

export interface CaseButton {
  /** answer のとき押すと skillProposalsComposeAnswer の option になる */
  option?: ComposeAnswerOption
  action: CaseButtonAction
  label: string
  primary?: boolean
}

/** 表示の行列（Plan §2 W3）。全欄に値か「—」が入る */
export interface CaseMatrix {
  round: string
  turn: string
  waitingOn: string
  elapsed: string
  delta: string
  next: string
}

export interface CaseFindingRow {
  gateId: string | null
  /** 画面の番号（ゲートの番号があれば `[2]`、原文由来は `(レビュアーの番号)`） */
  number: string
  origin: FindingOrigin
  /** 由来の札（差分／原文／不明） */
  originLabel: string
  severity: FindingView['severity']
  /** 根拠（比べた範囲が変更行に掛かる／掛からない・申告・一致／不一致） */
  basis: string
  /** 要旨 */
  summary: string
  /** 裁定（棄却・持ち越しの理由）。無ければ空 */
  adjudication: string
  /** 棄却の理由を入れて記録できる指摘か（差分／不明で、まだ裁定が無い） */
  canReject: boolean
}

export interface CaseViewModel {
  caseView: ComposeCaseView
  headline: string
  detail: string[]
  matrix: CaseMatrix
  buttons: CaseButton[]
  findings: CaseFindingRow[]
  /** 受け皿のパス（コピーできる形で出す） */
  receptacles: string[]
  /** 「元提案 1 本」の添え書き（1 本のときだけ。AC19） */
  sourceNote: string | null
  /** 棄却の理由の入力欄と「棄却を記録」を出すか（停止・回答待ち） */
  showAdjudicationInputs: boolean
  /** 残りの棄却理由の件数（回答待ちの「残り {k} 件」） */
  rejectsRemaining: number
  /** (e) の「由来を選んで改訂を頼む」で由来を選ばせる指摘の gateId（不明の指摘） */
  unclearGateIds: string[]
  /** 合成提案の ID（棄却の記録に渡す） */
  compositeId: string
  /**
   * L0_012: 見出しの傍に添える動く表示。spin＝回転（起動待ち）／pulse＝鼓動（Claude Code の合図を受け取り作業中）／
   * null＝出さない（合図の項目を持たない状態・本件の対象外の状態）
   */
  activity: 'spin' | 'pulse' | null
}

// ---- 表示の行列の見出し ----

export function matrixLabels(ja: boolean): Record<keyof CaseMatrix, string> {
  return ja
    ? { round: '巡', turn: '手番', waitingOn: '待っている対象', elapsed: '経過', delta: '件数差', next: '次に起きること' }
    : { round: 'Round', turn: 'Turn', waitingOn: 'Waiting on', elapsed: 'Elapsed', delta: 'Findings delta', next: 'What happens next' }
}

/** 欄に入れる「該当なし」の印 */
export const NONE = '—'

// ---- 選択肢の名前（Plan §2 W2 の 1 問・W5 の表。A/B/C の記号は使わない） ----

/** 推奨の文（「推奨: {…}。理由: …」の {…}）に使う、選択肢の中身の名前 */
const OPTION_SENTENCE: Record<ComposeAnswerOption, { ja: string; en: string }> = {
  'split-and-proceed': {
    ja: '原文への指摘を別の提案に切り出して、この提案は差分だけで先へ進む',
    en: 'split the findings on the existing text into a separate proposal and move on with the changes only'
  },
  'address-base': { ja: '原文への指摘を反映する', en: 'address the findings on the existing text' },
  hold: { ja: '保留', en: 'hold it' },
  'resume-hold': { ja: '保留を解く', en: 'resume it' },
  consult: { ja: '自分で直す（候補ブラウザの相談から）', en: 'fix it yourself (consult from the candidate browser)' },
  withdraw: { ja: '取り下げる', en: 'withdraw it' },
  'reject-and-next': { ja: '残りの指摘を棄却して次の巡へ', en: 'reject the rest and go to the next round' },
  'request-revision': { ja: '改訂を頼む', en: 'ask for a revision' },
  'choose-origins-and-revise': { ja: '由来を選んで改訂を頼む', en: 'choose the origins and ask for a revision' }
}

/** ボタンの名前 */
const OPTION_BUTTON: Record<ComposeAnswerOption, { ja: string; en: string }> = {
  'split-and-proceed': { ja: '切り出して先へ進む', en: 'Split and proceed' },
  'address-base': { ja: '原文への指摘を反映する', en: 'Address the findings on the existing text' },
  hold: { ja: '保留', en: 'Hold' },
  'resume-hold': { ja: '保留を解く', en: 'Resume' },
  consult: { ja: '相談を開く', en: 'Open consult' },
  withdraw: { ja: '取り下げる', en: 'Withdraw' },
  'reject-and-next': { ja: '残りの指摘を棄却して次の巡へ', en: 'Reject the rest and go to the next round' },
  'request-revision': { ja: '改訂を頼む', en: 'Ask for a revision' },
  'choose-origins-and-revise': { ja: '由来を選んで改訂を頼む', en: 'Choose origins and revise' }
}

export function optionSentence(o: ComposeAnswerOption, ja: boolean): string {
  return OPTION_SENTENCE[o][ja ? 'ja' : 'en']
}
export function optionButtonLabel(o: ComposeAnswerOption, ja: boolean): string {
  return OPTION_BUTTON[o][ja ? 'ja' : 'en']
}

// ---- 小さな純関数 ----

const SEC_PER_MIN = 60
const SEC_PER_HOUR = 60 * SEC_PER_MIN

/**
 * 段の開始からの経過を mm:ss で。60 分以上は h:mm:ss に折り畳む（承認待ちが日をまたぐと 1000 分を超える表示になるため）。
 * 起点が無い・読めないときは「—」
 */
export function formatElapsed(startIso: string | undefined, nowMs: number): string {
  if (!startIso) return NONE
  const t = Date.parse(startIso)
  if (!Number.isFinite(t)) return NONE
  const sec = Math.max(0, Math.floor((nowMs - t) / 1000))
  const ss = String(sec % SEC_PER_MIN).padStart(2, '0')
  if (sec < SEC_PER_HOUR) {
    const mm = String(Math.floor(sec / SEC_PER_MIN)).padStart(2, '0')
    return `${mm}:${ss}`
  }
  const h = Math.floor(sec / SEC_PER_HOUR)
  const mm = String(Math.floor((sec % SEC_PER_HOUR) / SEC_PER_MIN)).padStart(2, '0')
  return `${h}:${mm}:${ss}`
}

/** 前巡比の符号つき件数（+2／-1／±0） */
export function signedDelta(k: number): string {
  if (k > 0) return `+${k}`
  if (k < 0) return `-${-k}`
  return '±0'
}

const ZERO: OriginCounts = { diff: 0, base: 0, unclear: 0 }

/** 件数差（差分 {a}・不明 {u}（前巡比 {±k}）／初回は —（初回）／0 件は 0 件） */
export function formatDelta(counts: OriginCounts | undefined, prev: OriginCounts | undefined, ja: boolean): string {
  if (!prev) return ja ? `${NONE}（初回）` : `${NONE} (first round)`
  const c = counts ?? ZERO
  const k = c.diff + c.unclear - (prev.diff + prev.unclear)
  if (c.diff + c.unclear === 0) {
    return ja ? `0 件（前巡比 ${signedDelta(k)}）` : `0 findings (vs. previous round ${signedDelta(k)})`
  }
  return ja
    ? `差分 ${c.diff}・不明 ${c.unclear}（前巡比 ${signedDelta(k)}）`
    : `Diff ${c.diff}, unclear ${c.unclear} (vs. previous round ${signedDelta(k)})`
}

/** `hh:mm:ss`（renderer の時計のローカル時刻） */
export function formatClock(ms: number): string {
  const d = new Date(ms)
  const p2 = (n: number): string => String(n).padStart(2, '0')
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
}

/**
 * 更新待ちの判定。最後に取れた時刻（renderer の時計）から COMPOSE_UPDATE_SLO_MS を超えたら出す（ちょうど閾値は出さない）。
 * 一度も取れていない（null）ときは比べる相手が無いので出さない。
 */
export function updateStaleness(
  lastFetchedMs: number | null,
  nowMs: number,
  ja: boolean
): { stale: boolean; label: string | null } {
  if (lastFetchedMs === null) return { stale: false, label: null }
  if (nowMs - lastFetchedMs <= COMPOSE_UPDATE_SLO_MS) return { stale: false, label: null }
  const t = formatClock(lastFetchedMs)
  return {
    stale: true,
    label: ja ? `更新待ち（最終更新 ${t}）` : `Waiting for update (last updated ${t})`
  }
}

/** 進行中か（取り直しを続ける対象）。取消・失敗・承認待ち・保留・停止・昇格済み以外 */
export function isComposeInProgress(s: Pick<CaseStatusInput, 'phase' | 'caseView' | 'adopted'>): boolean {
  if (s.adopted) return false
  if (s.caseView) {
    return !(
      s.caseView === 'adopted' ||
      s.caseView === 'cancelled' ||
      s.caseView === 'failed' ||
      s.caseView === 'awaiting-approval' ||
      s.caseView === 'awaiting-approval-base' ||
      s.caseView === 'held' ||
      s.caseView === 'stopped'
    )
  }
  return s.phase === 'running' || s.phase === 'finalizing' || s.phase === 'reviewing'
}

/** まだ描画を報告していない seq（昇順）。同じ seq を 2 回送らないための判定 */
export function newSeqsToReport(
  statuses: ReadonlyArray<{ seq?: number }>,
  reported: ReadonlySet<number>
): number[] {
  const out = new Set<number>()
  for (const s of statuses) {
    if (typeof s.seq === 'number' && Number.isFinite(s.seq) && !reported.has(s.seq)) out.add(s.seq)
  }
  return [...out].sort((a, b) => a - b)
}

/**
 * 画面に出ている status の seq を、描画の報告として送るかを決める（遷移→描画の遅延の測定）。
 * - 出ていない status の seq は送らない（描画していないものを「描画した」と報告しない）。
 * - 表示の対象が変わった直後（選択を替えた・初めて開いた）の 1 回目は、その時点の seq を「報告済み」に置くだけで送らない
 *   （過去の遷移を、いま見せたものとして遅延に数えない）。
 * 戻り値の workspace は次回の prevWorkspace に渡す。
 */
export function seqsToReportForDisplay(
  displayed: { workspaceDir?: string; seq?: number; caseId?: string } | null,
  prevWorkspace: string | null,
  reported: ReadonlySet<number>,
  prevCaseId: string | null = null
): { send: number[]; baseline: number | null; workspace: string | null; caseId: string | null } {
  const workspace = displayed?.workspaceDir ?? null
  const caseId = displayed?.caseId ?? null
  // 同じ案件の中で作業場が替わった（新しい巡が始まった）のは本物の遷移なので報告する。
  // 別の提案を選び直した・初めて出したときだけ、その時点の seq を報告済みに置く（過去の遷移を遅延に数えない）
  if (workspace !== prevWorkspace && caseId !== null && caseId === prevCaseId) {
    return { send: displayed ? newSeqsToReport([displayed], reported) : [], baseline: null, workspace, caseId }
  }
  if (workspace !== prevWorkspace) {
    const baseline = typeof displayed?.seq === 'number' && Number.isFinite(displayed.seq) ? displayed.seq : null
    return { send: [], baseline, workspace, caseId }
  }
  return { send: displayed ? newSeqsToReport([displayed], reported) : [], baseline: null, workspace, caseId }
}

/** 元提案の本数（案件の記録が優先。無ければ sourceIds の長さ） */
export function sourceCountOf(s: Pick<CaseStatusInput, 'sourceCount' | 'sourceIds'>): number {
  return s.sourceCount ?? s.sourceIds?.length ?? 0
}

/** 「① 合成」の下に添える「元提案 1 本」（1 本のときだけ。AC19） */
export function sourceNoteFor(s: Pick<CaseStatusInput, 'sourceCount' | 'sourceIds'>, ja: boolean): string | null {
  return sourceCountOf(s) === 1 ? (ja ? '元提案 1 本' : '1 source proposal') : null
}

/** caseView が無い（古い main）ときの導出。通常は main が付ける */
export function deriveCaseView(s: Pick<CaseStatusInput, 'phase' | 'caseView' | 'round'>): ComposeCaseView {
  if (s.caseView) return s.caseView
  switch (s.phase) {
    case 'running':
      return (s.round ?? 1) > 1 ? 'revising' : 'composing'
    case 'finalizing':
      return 'checking'
    case 'reviewing':
      return 'reviewing'
    case 'registered':
      return 'awaiting-approval'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
  }
}

// ---- 指摘の行 ----

function originLabel(o: FindingOrigin, ja: boolean): string {
  return o === 'diff' ? (ja ? '差分' : 'Diff') : o === 'base' ? (ja ? '原文' : 'Existing text') : ja ? '不明' : 'Unclear'
}

function reviewerOriginLabel(o: ReviewerOrigin, ja: boolean): string {
  if (o === 'none') return ja ? 'なし' : 'none'
  return originLabel(o, ja)
}

function rangeText(r: { file: string; range: { start: number; end: number } }): string {
  const { start, end } = r.range
  return `${r.file} L${start}${end !== start ? `-${end}` : ''}`
}

/** 根拠: 比べた範囲 `[en]SKILL.md L40-52` が変更行に掛かる／掛からない・申告・一致／不一致 */
export function findingBasis(f: Pick<FindingView, 'citedRanges' | 'reviewerOrigin' | 'agree'>, ja: boolean): string {
  const cited = f.citedRanges ?? []
  const range =
    cited.length === 0
      ? ja
        ? '比べた範囲を取り出せず'
        : 'no range could be extracted'
      : ja
        ? `比べた範囲 ${cited.map(rangeText).join('、')} が変更行に${cited.some((c) => c.changed) ? '掛かる' : '掛からない'}`
        : `compared range ${cited.map(rangeText).join(', ')} ${cited.some((c) => c.changed) ? 'overlaps' : 'does not overlap'} the changed lines`
  const claim = ja ? `申告 ${reviewerOriginLabel(f.reviewerOrigin, ja)}` : `reported ${reviewerOriginLabel(f.reviewerOrigin, ja)}`
  const agree = f.agree ? (ja ? '一致' : 'match') : ja ? '不一致' : 'mismatch'
  return `${range}・${claim}・${agree}`
}

export function findingRows(findings: readonly FindingView[], ja: boolean): CaseFindingRow[] {
  return findings.map((f) => ({
    gateId: f.gateId,
    number: f.gateId ? `[${f.gateId}]` : `(${f.reviewerNo})`,
    origin: f.origin,
    originLabel: originLabel(f.origin, ja),
    severity: f.severity,
    basis: findingBasis(f, ja),
    summary: f.title,
    adjudication: f.adjudication
      ? `${f.adjudication.decision === 'rejected' ? (ja ? '棄却' : 'Rejected') : ja ? '持ち越し' : 'Deferred'}: ${f.adjudication.reason}`
      : '',
    canReject: !!f.gateId && f.origin !== 'base' && !f.adjudication
  }))
}

// ---- 本体 ----

type StopReasonView = StopQuestion['reason']

/** 停止の 1 問の文面（補足の「推奨: …。理由: …」 1 行） */
export function stopQuestionLine(
  reason: StopReasonView,
  recommended: ComposeAnswerOption,
  ja: boolean,
  roundMax: number = COMPOSE_ROUND_MAX
): string {
  const opt = optionSentence(recommended, ja)
  const why: Record<StopReasonView, { ja: string; en: string }> = {
    a: {
      ja: `${roundMax} 巡で収束せず、自動の改訂はここで終わる。`,
      en: `it did not converge in ${roundMax} rounds, so automatic revision stops here.`
    },
    b: { ja: '改訂で指摘が増えた。', en: 'the revision increased the findings.' },
    c: {
      ja: '改訂 AI が理由つきで残した指摘が再び出た。理由をレビュアーに渡して裁定させる。',
      en: 'findings the AI kept with a reason came back; pass the reasons to the reviewer.'
    },
    d: {
      ja: '差分に指摘が無く、原文への指摘は受け皿に残してある。',
      en: 'the changes have no findings, and the others are kept in the holding file.'
    },
    e: { ja: 'AI が由来を決められなかった。', en: 'the AI could not decide them.' }
  }
  return ja ? `推奨: ${opt}。理由: ${why[reason].ja}` : `Recommended: ${opt}. Reason: ${why[reason].en}`
}

/** 停止 (a)(b)(c)(e) で出す選択肢（推奨を先頭に）。第 3 巡（上限）では (a) と同じ 2 つ */
function stopOptions(reason: StopReasonView, round: number, roundMax: number, stop: StopQuestion | undefined): {
  recommended: ComposeAnswerOption
  options: ComposeAnswerOption[]
} {
  if (reason === 'a' || round >= roundMax) {
    return { recommended: 'consult', options: ['consult', 'withdraw'] }
  }
  const all: ComposeAnswerOption[] =
    reason === 'e'
      ? ['choose-origins-and-revise', 'withdraw']
      : ['reject-and-next', 'request-revision', 'withdraw']
  // main が出さない選択肢は出さない（main が持っていれば、その集合との積）
  const offered = stop?.options?.length ? all.filter((o) => stop.options.includes(o)) : all
  const options = offered.length > 0 ? offered : all
  const recommended = stop && options.includes(stop.recommended) ? stop.recommended : options[0]
  return { recommended, options: [recommended, ...options.filter((o) => o !== recommended)] }
}

/** 起動から N 秒（COMPOSE_WINDOW_WAIT_HINT_MS）を過ぎても着手の合図が無いか（起点が無い・読めないときは出さない） */
export function windowWaitTooLong(startIso: string | undefined, nowMs: number): boolean {
  const t = startIso ? Date.parse(startIso) : NaN
  return Number.isFinite(t) && nowMs - t >= COMPOSE_WINDOW_WAIT_HINT_MS
}

/** 窓が見当たらないときの案内（取り消しへの導線を含む。L0_012 AC11） */
export function windowWaitHint(ja: boolean): string {
  const n = Math.round(COMPOSE_WINDOW_WAIT_HINT_MS / 1000)
  return ja
    ? `${n} 秒たっても Claude Code の窓が見当たらないときは、タスクバーで窓を探してください。見つからなければ「合成を取り消す」でやめて、もう一度始められます。`
    : `If no Claude Code window has appeared after ${n} seconds, look for it on the taskbar. If you cannot find it, press "Cancel the composition" and start again.`
}

export function composeCaseView(s: CaseStatusInput, ja: boolean, nowMs: number): CaseViewModel {
  const L = (j: string, e: string): string => (ja ? j : e)
  const caseView = deriveCaseView(s)
  const round = s.round ?? 1
  const roundMax = s.roundMax ?? COMPOSE_ROUND_MAX
  const counts = s.counts ?? ZERO
  // 改訂中は「前の巡の指摘」を持つ（その巡の結果は prevCounts。無ければ counts）
  const carriedCounts = s.prevCounts ?? s.counts ?? ZERO
  const rows = findingRows(s.findings ?? [], ja)
  const receptacles = s.receptacles ?? []
  const pathText = receptacles.join(ja ? '、' : ', ')
  const compositeId = s.result?.compositeId ?? s.compositeRequestId
  const roundText = L(`第 ${round} 巡／${roundMax}`, `Round ${round}/${roundMax}`)
  const turnName = { ai: 'AI', ccpit: 'CCPIT', you: L('あなた', 'You'), none: NONE }
  const elapsed = formatElapsed(s.phaseStartedAt, nowMs)
  const excluded = excludedIdsLine(s.phase, s.excludedIds ?? [], ja)

  const cancelBtn: CaseButton = {
    action: 'cancel',
    label: L('合成を取り消す', 'Cancel the composition')
  }
  const openPromoBtn = (): CaseButton => ({
    action: 'openPromotion',
    label: L('昇格画面で開く（承認はそこで）', 'Open in promotion (approve there)'),
    primary: true
  })
  const answerBtn = (option: ComposeAnswerOption, primary = false): CaseButton => ({
    action: option === 'consult' ? 'consult' : 'answer',
    option,
    label: optionButtonLabel(option, ja),
    ...(primary ? { primary: true } : {})
  })

  let headline = ''
  let detail: string[] = []
  let matrix: CaseMatrix
  let buttons: CaseButton[] = []
  let rejectsRemaining = 0
  let showAdjudicationInputs = false
  let activity: CaseViewModel['activity'] = null

  switch (caseView) {
    case 'composing':
      // L0_012: 窓つきの起動は、Claude Code の着手の合図の有無で「起動待ち」と「作業中」に分ける。
      // 合図の項目を持たない（窓なしの第 1 巡・旧い作業場・旧い main）ときは従来の文のまま
      if (s.ccStart === 'waiting') {
        headline = L(
          `起動待ち（第 ${round} 巡）：CCPIT が Claude Code を起動しました。新しい窓が開いて作業を始めるまで、少し待ってください（経過 ${elapsed}）。`,
          `Waiting for Claude Code (round ${round}): CCPIT has started Claude Code. Please wait while its new window opens and starts working (elapsed ${elapsed}).`
        )
        detail = [
          ...(windowWaitTooLong(s.phaseStartedAt, nowMs) ? [windowWaitHint(ja)] : []),
          ...(excluded ? [excluded] : [])
        ]
        matrix = {
          round: roundText,
          turn: turnName.ai,
          waitingOn: L('Claude Code の着手の合図（窓が開くまで）', 'The Claude Code start signal (until its window opens)'),
          elapsed,
          delta: NONE,
          next: L('合図が来たら作業中へ（自動）', 'Moves to working when the signal arrives (automatic)')
        }
        buttons = [cancelBtn]
        activity = 'spin'
        break
      }
      if (s.ccStart === 'working') {
        headline = L(
          `作業中（第 ${round} 巡）：Claude Code が作業場で合成提案を作っています（着手の合図を受け取りました）。選択肢が出たら、その窓で答えてください。それ以外の操作は要りません。`,
          `Working (round ${round}): Claude Code is building the composed proposal in the workspace (its start signal was received). If it asks you to choose, answer in that window. Nothing else is needed.`
        )
        detail = excluded ? [excluded] : []
        matrix = {
          round: roundText,
          turn: turnName.ai,
          waitingOn: L('合成 CC の合図（READY）', 'The composition CC READY signal'),
          elapsed,
          delta: NONE,
          next: L('検査へ（自動）', 'Moves to checking (automatic)')
        }
        buttons = [cancelBtn]
        activity = 'pulse'
        break
      }
      headline = L(
        `合成中（第 ${round} 巡）：Claude Code が作業場で合成提案を作っています。選択肢が出たら、そのウィンドウで選んでください。`,
        `Composing (round ${round}): Claude Code is building the composed proposal in the workspace. Answer its choices in that window.`
      )
      detail = excluded ? [excluded] : []
      matrix = {
        round: roundText,
        turn: turnName.ai,
        waitingOn: L('合成 CC の合図（READY）', 'The composition CC READY signal'),
        elapsed,
        delta: NONE,
        next: L('検査へ（自動）', 'Moves to checking (automatic)')
      }
      buttons = [cancelBtn]
      break
    case 'revising': {
      headline = L(
        `改訂中（第 ${round} 巡）：前回の指摘（差分 ${carriedCounts.diff}・不明 ${carriedCounts.unclear}）を AI が反映しています。操作は要りません。`,
        `Revising (round ${round}): the AI is addressing the previous findings (diff ${carriedCounts.diff}, unclear ${carriedCounts.unclear}). No action needed.`
      )
      const b = carriedCounts.base
      detail = [
        ...(b > 0
          ? [
              L(
                `原文への指摘 ${b} 件は受け皿に残しました: ${pathText}`,
                `${b} findings on the existing text were kept in: ${pathText}`
              )
            ]
          : []),
        ...(excluded ? [excluded] : [])
      ]
      matrix = {
        round: roundText,
        turn: turnName.ai,
        waitingOn: L('改訂 AI の合図（READY）', 'The revision AI READY signal'),
        elapsed,
        delta: L(
          `前巡: 差分 ${carriedCounts.diff}・不明 ${carriedCounts.unclear}`,
          `Previous round: diff ${carriedCounts.diff}, unclear ${carriedCounts.unclear}`
        ),
        next: L('検査へ（自動）', 'Moves to checking (automatic)')
      }
      buttons = [cancelBtn]
      break
    }
    case 'checking':
      headline = L(
        `検査中（第 ${round} 巡）：書込み範囲・元提案の変更の保持・golden の変化を CCPIT が検査しています。`,
        `Checking (round ${round}): CCPIT is verifying the write scope, preserved changes and golden drift.`
      )
      detail = excluded ? [excluded] : []
      matrix = {
        round: roundText,
        turn: turnName.ccpit,
        waitingOn: L('書込み範囲・保持・golden の変化の検査', 'Checks of write scope, preserved changes and golden drift'),
        elapsed,
        delta: NONE,
        next: L('レビューへ（自動）', 'Moves to review (automatic)')
      }
      buttons = [cancelBtn]
      break
    case 'reviewing':
      headline = L(
        `レビュー中（第 ${round} 巡）：独立レビュー（Codex）が golden との差分を審査しています。`,
        `Reviewing (round ${round}): the independent review (Codex) is examining the changes against golden.`
      )
      detail = excluded ? [excluded] : []
      matrix = {
        round: roundText,
        turn: L('CCPIT（Codex）', 'CCPIT (Codex)'),
        waitingOn: L('独立レビューの判定', 'The independent review verdict'),
        elapsed,
        delta: NONE,
        next: L('判定で承認待ち・改訂・停止', 'Approval, revision or stop, depending on the verdict')
      }
      buttons = [cancelBtn]
      break
    case 'awaiting-approval':
      headline = L(
        '登録しました。独立レビューは approve です。昇格画面で承認すると golden（ja・en）と手元へ入ります。',
        'Registered. The independent review approved it. Approve it in the promotion screen to apply it to golden (ja and en) and your copy.'
      )
      detail = [...adaptedDetailLines(s.result?.adapted, ja), ...(excluded ? [excluded] : [])]
      matrix = {
        round: roundText,
        turn: turnName.you,
        waitingOn: L('昇格画面の承認', 'Approval in the promotion screen'),
        elapsed,
        delta: formatDelta(counts, s.prevCounts, ja),
        next: L('承認で golden と手元へ', 'Approval applies it to golden and your copy')
      }
      buttons = [openPromoBtn()]
      break
    case 'awaiting-approval-base': {
      const b = counts.base
      headline = L(
        `登録しました。独立レビューは approve です。原文への指摘 ${b} 件は別の提案として受け皿に残しました。推奨と違う選択をするときだけ下を押してください。`,
        `Registered. The independent review approved it. ${b} findings on the existing text were kept in a holding file as a separate proposal. Press below only to choose differently.`
      )
      detail = [
        L(`受け皿: ${pathText}`, `Holding file: ${pathText}`),
        stopQuestionLine('d', 'split-and-proceed', ja, roundMax),
        // 第 3 巡では「原文への指摘を反映する」を出さない（自動の次の巡は始めない）。代わりに反映の道を示す
        ...(round >= roundMax
          ? [
              L(
                `第 ${roundMax} 巡のため、原文への指摘をこの合成で反映する選択はありません。反映するときは、受け皿から別の提案として起票してください。`,
                `This is round ${roundMax}, so the findings on the existing text cannot be addressed in this composition. To address them, file a separate proposal from the holding file.`
              )
            ]
          : []),
        ...adaptedDetailLines(s.result?.adapted, ja),
        ...(excluded ? [excluded] : [])
      ]
      matrix = {
        round: roundText,
        turn: turnName.you,
        waitingOn: L('昇格画面の承認', 'Approval in the promotion screen'),
        elapsed,
        delta: L(`差分 0・原文 ${b}`, `Diff 0, existing text ${b}`),
        next: L('押さなければこのまま承認待ち', 'Stays awaiting approval unless you press below')
      }
      buttons = [openPromoBtn(), ...(round < roundMax ? [answerBtn('address-base')] : []), answerBtn('hold')]
      break
    }
    case 'stopped': {
      const stop = s.stop
      const reason: StopReasonView = stop?.reason ?? 'a'
      const atLimit = round >= roundMax
      const c = stop?.counts ?? counts
      const aText = L(
        `止まりました（第 ${roundMax} 巡の上限）：差分の指摘 ${c.diff} 件・不明 ${c.unclear} 件が残っています。`,
        `Stopped (round limit ${roundMax}): ${c.diff} findings on the changes and ${c.unclear} unclear remain.`
      )
      const bText = L(
        `止まりました（指摘が増えた）：差分の指摘が前巡の ${stop?.prevDiff ?? s.prevCounts?.diff ?? 0} 件から ${c.diff} 件に増えました。`,
        `Stopped (findings increased): findings on the changes went from ${stop?.prevDiff ?? s.prevCounts?.diff ?? 0} to ${c.diff}.`
      )
      const cText = L(
        `止まりました（同じ指摘が戻った）：前巡と同じ指摘 ${stop?.repeated ?? 0} 件が残っています。`,
        `Stopped (same findings returned): ${stop?.repeated ?? 0} findings from the previous round came back.`
      )
      const eText = L(
        `止まりました（由来を確定できない）：AI が由来を決められなかった指摘が ${c.unclear} 件あります。`,
        `Stopped (origin unresolved): the AI could not settle the origin of ${c.unclear} findings.`
      )
      const bodies: Record<StopReasonView, string> = { a: aText, b: bText, c: cText, d: aText, e: eText }
      if (reason === 'a' || reason === 'd' || !atLimit) {
        headline = bodies[reason]
      } else {
        // 第 3 巡の (b)(c)(e) は (a) の主文の後ろに理由を添える
        const why: Record<'b' | 'c' | 'e', string> = {
          b: L(
            `理由: 差分の指摘が前巡の ${stop?.prevDiff ?? s.prevCounts?.diff ?? 0} 件から ${c.diff} 件に増えました。`,
            `Reason: findings on the changes went from ${stop?.prevDiff ?? s.prevCounts?.diff ?? 0} to ${c.diff}.`
          ),
          c: L(
            `理由: 前巡と同じ指摘 ${stop?.repeated ?? 0} 件が戻りました。`,
            `Reason: ${stop?.repeated ?? 0} findings from the previous round came back.`
          ),
          e: L(
            `理由: AI が由来を決められなかった指摘が ${c.unclear} 件あります。`,
            `Reason: the AI could not settle the origin of ${c.unclear} findings.`
          )
        }
        headline = `${aText} ${why[reason as 'b' | 'c' | 'e']}`
      }
      const opts = stopOptions(reason, round, roundMax, stop)
      // 第 3 巡では (a) と同じ補足にする
      const lineReason: StopReasonView = reason === 'd' ? 'a' : atLimit ? 'a' : reason
      detail = [stopQuestionLine(lineReason, opts.recommended, ja, roundMax), ...(excluded ? [excluded] : [])]
      matrix = {
        round: roundText,
        turn: turnName.you,
        waitingOn: L('1 問の回答', 'One question to answer'),
        elapsed,
        delta: formatDelta(counts, s.prevCounts, ja),
        next: L('回答するまで進まない', 'Does not proceed until you answer')
      }
      buttons = opts.options.map((o) => answerBtn(o, o === opts.recommended))
      // 棄却の理由の入力欄は回答待ち（「棄却して次の巡へ」を選んだ後）だけに出す。main も回答待ちでだけ記録を受け付ける
      showAdjudicationInputs = false
      break
    }
    case 'answer-pending': {
      rejectsRemaining = rows.filter((r) => r.canReject).length
      headline = L(
        `棄却の理由を記入してください（残り ${rejectsRemaining} 件）。全件記入すると次の巡が始まります。`,
        `Enter the rejection reasons (${rejectsRemaining} left). The next round starts when all are entered.`
      )
      detail = excluded ? [excluded] : []
      matrix = {
        round: roundText,
        turn: turnName.you,
        waitingOn: L(`残り ${rejectsRemaining} 件の棄却理由`, `Rejection reasons for ${rejectsRemaining} remaining`),
        elapsed,
        delta: formatDelta(counts, s.prevCounts, ja),
        next: L('全件記録で次の巡（自動）', 'Next round starts when all are recorded (automatic)')
      }
      buttons = [{ action: 'adjudicate', label: L('棄却を記録', 'Record rejection'), primary: true }]
      showAdjudicationInputs = true
      break
    }
    case 'held':
      headline = L('保留しています。昇格画面には出しません。', 'On hold. Not shown in the promotion screen.')
      detail = []
      matrix = {
        round: roundText,
        turn: turnName.you,
        waitingOn: L('保留の解除', 'Releasing the hold'),
        elapsed,
        delta: L(`差分 0・原文 ${counts.base}`, `Diff 0, existing text ${counts.base}`),
        next: L('昇格画面には出ない', 'Not shown in the promotion screen')
      }
      buttons = [answerBtn('resume-hold', true)]
      break
    case 'cancelled':
      headline = L('取り消しました。', 'Cancelled.')
      detail = []
      matrix = {
        round: roundText,
        turn: NONE,
        waitingOn: NONE,
        elapsed: NONE,
        delta: NONE,
        next: L('やり直せる', 'Can be started again')
      }
      break
    case 'failed': {
      headline = L('合成は登録されませんでした。', 'The composition was not registered.')
      const cause = `${s.result?.stage ? `[${s.result.stage}] ` : ''}${s.result?.error ?? ''}`.trim()
      detail = [
        ...(cause ? [cause] : []),
        L(
          'golden・手元には何も書かれていません（範囲外へ書かれた場合は元に戻してあります）。合成をやり直してください。',
          'Nothing was written to golden or your files (anything written outside scope was reverted). Start the composition again.'
        )
      ]
      matrix = {
        round: roundText,
        turn: turnName.you,
        waitingOn: NONE,
        elapsed: NONE,
        delta: NONE,
        next: L(`原因: ${cause || NONE}。やり直せる`, `Cause: ${cause || NONE}. Can be started again`)
      }
      break
    }
    case 'adopted': {
      // 終端。主ボタンは無く（buttons は空）、合成の開始ボタンはカードの外で戻る（composeFlowOwnsPrimary）
      const commit = s.adopted?.commit ?? ''
      headline = commit
        ? adoptedHeadline(commit, ja)
        : L('昇格しました。golden（ja・en）と手元へ入っています。', 'Promoted. It is in golden (ja and en) and your copy.')
      detail = []
      matrix = {
        round: roundText,
        turn: NONE,
        waitingOn: NONE,
        elapsed: NONE,
        delta: NONE,
        next: commit
          ? L(`昇格済み（golden commit ${shortCommit(commit)}）。`, `Promoted (golden commit ${shortCommit(commit)}). `) +
            adoptedNextLine(ja)
          : adoptedNextLine(ja)
      }
      break
    }
  }

  return {
    caseView,
    headline,
    detail,
    matrix,
    buttons,
    findings: rows,
    receptacles,
    sourceNote: sourceNoteFor(s, ja),
    showAdjudicationInputs,
    rejectsRemaining,
    unclearGateIds: rows.filter((r) => r.origin === 'unclear' && r.gateId && r.canReject).map((r) => r.gateId as string),
    compositeId,
    activity
  }
}

// ---- 棄却の記録・由来の選択（入力検査） ----

/**
 * 棄却の理由を送ってよいか。画面で止めるのは空だけ。「短すぎる」の基準は main の検査（isSubstantiveAdjudicationReason）が正で、
 * ここに文字数を写さない（二重に持つとずれる）。main の拒否の文面はそのまま画面に出す。
 */
export function canSubmitRejection(reason: string): boolean {
  return reason.trim().length > 0
}

/** (e) 由来を選んで改訂を頼む: 不明の指摘すべてに差分／原文が選ばれたら true */
export function originsReady(unclearGateIds: readonly string[], chosen: Readonly<Record<string, 'diff' | 'base'>>): boolean {
  return unclearGateIds.length > 0 && unclearGateIds.every((id) => chosen[id] === 'diff' || chosen[id] === 'base')
}

export function originsPayload(
  unclearGateIds: readonly string[],
  chosen: Readonly<Record<string, 'diff' | 'base'>>
): Array<{ gateId: string; origin: 'diff' | 'base' }> {
  return unclearGateIds.flatMap((id) => (chosen[id] ? [{ gateId: id, origin: chosen[id] }] : []))
}

// ---- 受け皿の一覧（候補ブラウザ） ----

export const RECEPTACLE_CLOSE_CHOICES: ReadonlyArray<{ how: ReceptacleClosedHow; ja: string; en: string }> = [
  { how: 'fixed', ja: '直した', en: 'Fixed' },
  { how: 'accepted', ja: '受け入れた', en: 'Accepted' },
  { how: 'merged', ja: '統合した', en: 'Merged' }
]

export function openReceptacles(list: readonly ReceptacleSummary[], skillName?: string): ReceptacleSummary[] {
  return list.filter((r) => r.status === 'open' && (skillName === undefined || r.skill === skillName))
}

export function receptacleBadgeLabel(openCount: number, ja: boolean): string {
  return ja ? `受け皿 ${openCount} 件` : `${openCount} holding file${openCount === 1 ? '' : 's'}`
}

export function receptacleStatusLabel(r: Pick<ReceptacleSummary, 'status' | 'closedHow'>, ja: boolean): string {
  if (r.status === 'open') return ja ? '未解決' : 'Open'
  const how = RECEPTACLE_CLOSE_CHOICES.find((c) => c.how === r.closedHow)
  return `${ja ? '閉じた' : 'Closed'}${how ? `（${ja ? how.ja : how.en}）` : ''}`
}
