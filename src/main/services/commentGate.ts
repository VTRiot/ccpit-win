/**
 * ユーザーコメント → CC 対話の**判定核**（純粋関数のみ・副作用なし）。
 *
 * 設計正本: `_Prompt/02_buildai/20260805_1631_proposal-review-harvest/user_comment_dialogue_plan.md`
 * （独立レビュー r1〜r58 で収束。本ファイルの分岐はほぼ全てレビュー由来なので、
 *   変更するときは対応する `rNN#M` を読んでから触ること）
 *
 * **命題（§0）**: 「ユーザーリクエスト / 指摘により、ユーザーの望む形の Skill へ昇華させる」。
 * だから「CC が答えた」で終わりにせず、**答えるまで採用できない**という形にしてある。
 *
 * ## なぜ 3 層に分かれているか（r32#1 / r42#1）
 *
 * | 層 | 何を見るか | 外れたときの扱い |
 * |---|---|---|
 * | 1  | レコードの**形**（保存時に検証済みの形が保たれているか） | **hard block**（修復が要る） |
 * | 1b | `removed` の snapshot 実在 | **ack 要求**（hard block ではない） |
 * | 2  | stale か（応答後に提案が変わったか） | **ack 要求** |
 * | 3  | `evidence` の再判定 | **警告の強さのみ**（要否を変えない） |
 *
 * ここを混ぜると「ユーザーが ack しても採用できない」実装になる。混ぜてはいけない。
 */
import { createHash } from 'crypto'

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

/** 応答を書いた道具の名前。**改ざん耐性ではなく事故検出**（r4#3）— 同じマシンの CC は同じ値を書ける。 */
export const RESPONSE_WRITER = 'proposal-comment-respond'
/** 既知の schemaVersion。未知の値は「自前で書いていない」とみなす。 */
export const COMMENT_SCHEMA_VERSION = 1

/**
 * `evidence.quote` の長さフロア（空白除き）。**kind で分ける**（r31#1）。
 * - `present` は引用に**箇所を一意に指させる**のが役目なので長さが要る
 * - `removed` / `already_absent` は「その記述が無いこと」の同定が役目。
 *   「telemetry を入れないで」のような**短い禁止対象が正当にあり得る**ので 30 字を課すと詰む
 */
export const QUOTE_FLOOR_PRESENT = 30
export const QUOTE_FLOOR_ABSENT = 3

export type EvidenceKind = 'present' | 'removed' | 'already_absent'
export type CommentDecision = 'applied' | 'declined'
export type CommentStatus = 'open' | 'resolved' | 'withdrawn' | 'quarantined' | 'superseded'

export interface CommentEvidence {
  kind: EvidenceKind
  quote: string
  /** `already_absent` のみ必須。**コメント本文に逐語で出現する**こと（r50#4） */
  userPhraseQuote?: string
  /** `removed` のみ必須 */
  beforeSnapshotSha256?: string
  /** `removed` のみ必須（>= 1） */
  beforeQuoteOccurrences?: number
}

export interface CommentResponse {
  decision: CommentDecision
  body: string
  at: string
  baseProposalSha256: string
  proposalHashAtResponse: string
  evidence?: CommentEvidence[]
  writer: string
  schemaVersion: number
}

export interface ProposalComment {
  id: string
  body: string
  at: string
  proposalHashAtComment: string
  status: CommentStatus
  response?: CommentResponse | null
  withdrawnAt?: string
  withdrawnBy?: string
  proposalHashAtWithdraw?: string
  quarantinedAt?: string
  quarantinedBy?: string
  quarantinedReasonCode?: string
  observedProblem?: string
  originalRecord?: unknown
  supersededAt?: string
  supersededBy?: string
  proposalHashAtSupersede?: string
}

// ---------------------------------------------------------------------------
// 小さな述語
// ---------------------------------------------------------------------------

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0
const isParsableDate = (v: unknown): boolean => typeof v === 'string' && !Number.isNaN(Date.parse(v))
const nonSpaceLength = (s: string): number => s.replace(/\s+/g, '').length

/**
 * 応答理由の実質性。**裁定理由と同一のフロア**を使う（別実装を作らない・r4#5）。
 * `skillProposals.ts` の `isSubstantiveReason` と同じ規則で、水増しを弾く。
 */
export function isSubstantiveBody(body: unknown): boolean {
  if (typeof body !== 'string') return false
  const trimmed = body.trim()
  if (trimmed.length < 30) return false
  if (nonSpaceLength(trimmed) < 30) return false
  return new Set(trimmed.replace(/\s+/g, '')).size >= 15
}

/** `needle` が `haystack` に何回現れるか（重なりなし・逐語）。 */
export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let n = 0
  let i = haystack.indexOf(needle)
  while (i !== -1) {
    n += 1
    i = haystack.indexOf(needle, i + needle.length)
  }
  return n
}

// ---------------------------------------------------------------------------
// 層 1: レコードの妥当性
// ---------------------------------------------------------------------------

export type ShapeCode =
  | 'ok'
  | 'open'
  | 'broken-open'
  | 'broken-resolved'
  | 'broken-withdrawn'
  | 'broken-quarantined'
  | 'broken-superseded'
  | 'unknown-status'

export interface ShapeResult {
  code: ShapeCode
  /** true なら**採用を妨げない形**である（`open` は false — 未応答なので当然止める） */
  passes: boolean
  /** `broken-*` は hard block（修復が要る）。`open` は「未応答」であって壊れてはいない */
  broken: boolean
  reason: string | null
}

const shapeOk: ShapeResult = { code: 'ok', passes: true, broken: false, reason: null }
const shapeBroken = (code: ShapeCode, reason: string): ShapeResult => ({
  code,
  passes: false,
  broken: true,
  reason
})

/**
 * `evidence` 配列の**形**の妥当性（採用直前 content との突合はここでやらない・r32#1）。
 * `commentBody` は `already_absent` の `userPhraseQuote` 照合に要る。
 */
function evidenceShapeOk(ev: unknown, responseBody: string, commentBody: string): string | null {
  if (!Array.isArray(ev) || ev.length === 0) return 'evidence が非空配列でない'
  for (const raw of ev) {
    if (!raw || typeof raw !== 'object') return 'evidence 要素がオブジェクトでない'
    const e = raw as CommentEvidence
    if (e.kind !== 'present' && e.kind !== 'removed' && e.kind !== 'already_absent') {
      return `evidence.kind が未知（${String(e.kind)}）`
    }
    if (typeof e.quote !== 'string') return 'evidence.quote が文字列でない'
    const floor = e.kind === 'present' ? QUOTE_FLOOR_PRESENT : QUOTE_FLOOR_ABSENT
    if (nonSpaceLength(e.quote) < floor) return `evidence.quote が短すぎる（${e.kind} は空白除き ${floor} 字以上）`
    if (e.kind === 'already_absent') {
      // 機械が何も検証できない kind なので、せめて**応答本文とコメント本文の双方へ結び付ける**（r37#4 / r49#4 / r50#4）
      if (!responseBody.includes(e.quote)) return 'already_absent: 応答本文が quote を逐語で含まない'
      if (!isNonEmptyString(e.userPhraseQuote) || nonSpaceLength(e.userPhraseQuote) < QUOTE_FLOOR_ABSENT) {
        return 'already_absent: userPhraseQuote が無い / 短すぎる'
      }
      if (!commentBody.includes(e.userPhraseQuote)) {
        return 'already_absent: コメント本文が userPhraseQuote を逐語で含まない'
      }
    }
    if (e.kind === 'removed') {
      if (!isNonEmptyString(e.beforeSnapshotSha256)) return 'removed: beforeSnapshotSha256 が無い'
      if (typeof e.beforeQuoteOccurrences !== 'number' || e.beforeQuoteOccurrences < 1) {
        return 'removed: beforeQuoteOccurrences が 1 以上でない'
      }
    } else if (e.beforeSnapshotSha256 !== undefined || e.beforeQuoteOccurrences !== undefined) {
      // r28#3: removed 以外でこの 2 項目を持つのは形の誤り（黙って受けない）
      return `${e.kind}: removed 専用フィールドを持っている`
    }
  }
  return null
}

/**
 * コメントレコード 1 件の**形**を検証する。保存時と採用時の**両方**が通る唯一の関数（r29#2）。
 * ここに ack や stale の判定を混ぜないこと（保存時点で ack は存在しないので、混ぜると正常保存が落ちる）。
 */
export function validateCommentRecordShape(comment: unknown): ShapeResult {
  if (!comment || typeof comment !== 'object') return shapeBroken('broken-open', 'コメントがオブジェクトでない')
  const c = comment as ProposalComment

  // 共通: 壊れた `open` を「未応答」と混同しない（r14#5）
  const baseOk =
    isNonEmptyString(c.id) && isNonEmptyString(c.body) && isParsableDate(c.at) && isNonEmptyString(c.proposalHashAtComment)

  switch (c.status) {
    case 'open':
      if (!baseOk) return shapeBroken('broken-open', 'open レコードの必須項目が壊れている')
      return { code: 'open', passes: false, broken: false, reason: '未応答のコメントがあります' }

    case 'resolved': {
      if (!baseOk) return shapeBroken('broken-resolved', 'resolved レコードの基本項目が壊れている')
      const r = c.response
      if (!r || typeof r !== 'object') return shapeBroken('broken-resolved', 'response が無い')
      if (r.decision !== 'applied' && r.decision !== 'declined') {
        return shapeBroken('broken-resolved', `decision が未知（${String(r.decision)}）`)
      }
      if (!isSubstantiveBody(r.body)) return shapeBroken('broken-resolved', '応答理由が空・水増し（実質性フロア未達）')
      if (!isParsableDate(r.at)) return shapeBroken('broken-resolved', 'response.at が解析不能')
      if (!isNonEmptyString(r.proposalHashAtResponse)) return shapeBroken('broken-resolved', 'proposalHashAtResponse が無い')
      if (!isNonEmptyString(r.baseProposalSha256)) return shapeBroken('broken-resolved', 'baseProposalSha256 が無い')
      if (r.writer !== RESPONSE_WRITER) return shapeBroken('broken-resolved', 'writer が既定値でない')
      if (r.schemaVersion !== COMMENT_SCHEMA_VERSION) return shapeBroken('broken-resolved', 'schemaVersion が未知')
      // `applied` は evidence 必須 / `declined` は任意（在るなら同じ検証・r52#1 / r53#1）
      const hasEvidence = r.evidence !== undefined && r.evidence !== null
      if (r.decision === 'applied' && !hasEvidence) return shapeBroken('broken-resolved', 'applied なのに evidence が無い')
      if (hasEvidence) {
        const why = evidenceShapeOk(r.evidence, r.body, c.body)
        if (why) return shapeBroken('broken-resolved', why)
      }
      return shapeOk
    }

    case 'withdrawn':
      if (!baseOk) return shapeBroken('broken-withdrawn', 'withdrawn レコードの基本項目が壊れている')
      if (!isParsableDate(c.withdrawnAt)) return shapeBroken('broken-withdrawn', 'withdrawnAt が解析不能')
      if (c.withdrawnBy !== 'user') return shapeBroken('broken-withdrawn', 'withdrawnBy が user でない')
      if (!isNonEmptyString(c.proposalHashAtWithdraw)) return shapeBroken('broken-withdrawn', 'proposalHashAtWithdraw が無い')
      return shapeOk

    case 'quarantined':
      // 隔離は壊れたレコードの退避先なので、基本項目の健全性は問わない（問うと退避できない）
      if (!isNonEmptyString(c.id)) return shapeBroken('broken-quarantined', 'id が無い')
      if (!isParsableDate(c.quarantinedAt)) return shapeBroken('broken-quarantined', 'quarantinedAt が解析不能')
      if (c.quarantinedBy !== 'user') return shapeBroken('broken-quarantined', 'quarantinedBy が user でない')
      if (c.originalRecord === undefined) return shapeBroken('broken-quarantined', 'originalRecord が保持されていない')
      return shapeOk

    case 'superseded':
      if (!baseOk) return shapeBroken('broken-superseded', 'superseded レコードの基本項目が壊れている')
      if (!isParsableDate(c.supersededAt)) return shapeBroken('broken-superseded', 'supersededAt が解析不能')
      if (c.supersededBy !== 'user') return shapeBroken('broken-superseded', 'supersededBy が user でない')
      if (!isNonEmptyString(c.proposalHashAtSupersede)) return shapeBroken('broken-superseded', 'proposalHashAtSupersede が無い')
      return shapeOk

    default:
      return shapeBroken('unknown-status', `未知の status（${String((c as { status?: unknown }).status)}）`)
  }
}

// ---------------------------------------------------------------------------
// 層 3: evidence の再判定（**警告の強さのみ**を決める）
// ---------------------------------------------------------------------------

export type WarnLevel = 'none' | 'weak' | 'medium' | 'strong'

export interface EvidenceRecheck {
  kind: EvidenceKind
  occurrences: number
  level: WarnLevel
  message: string
}

/**
 * 採用直前 content に対して `evidence` を再判定する。
 * **戻り値の用途は警告の強さだけ**（保存の可否ではない・r42#1）。
 * 保存時は同じ出現数ロジックで**保存可否**を決めるが、採用時は決めない。
 */
export function recheckEvidenceAgainstContent(ev: CommentEvidence[] | undefined, content: string): EvidenceRecheck[] {
  if (!Array.isArray(ev)) return []
  return ev.map((e) => {
    const n = countOccurrences(content, e.quote)
    if (e.kind === 'present') {
      if (n === 1) return { kind: e.kind, occurrences: n, level: 'weak' as WarnLevel, message: '引用箇所は残っています' }
      if (n === 0) {
        return { kind: e.kind, occurrences: n, level: 'strong' as WarnLevel, message: '要望が反映されていた記述が見つかりません（消えた可能性）' }
      }
      return { kind: e.kind, occurrences: n, level: 'strong' as WarnLevel, message: '反映箇所を一意に特定できません（記述が重複しています）' }
    }
    // removed / already_absent は「無いこと」が正
    if (n === 0) return { kind: e.kind, occurrences: n, level: 'weak' as WarnLevel, message: '当該記述は戻っていません' }
    return {
      kind: e.kind,
      occurrences: n,
      level: 'strong' as WarnLevel,
      message: e.kind === 'removed' ? '削除したはずの記述が戻っています' : '入っていないはずの記述が現れています'
    }
  })
}

/** 保存時の可否判定（採用時と**同じロジック / 違う用途**）。外れたら保存しない。 */
export function validateEvidenceAgainstContent(ev: CommentEvidence[] | undefined, content: string): string | null {
  if (!Array.isArray(ev)) return null
  for (const e of ev) {
    const n = countOccurrences(content, e.quote)
    if (e.kind === 'present' && n !== 1) return `present の引用が保存直前 content にちょうど 1 回でない（${n} 回）`
    if (e.kind !== 'present' && n !== 0) return `${e.kind} の引用が保存直前 content に出現する（${n} 回）`
  }
  return null
}

// ---------------------------------------------------------------------------
// 正準形（ack と監査の鍵）
// ---------------------------------------------------------------------------

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf-8').digest('hex')

/**
 * `commentsKey` の正準形。**ack 画面でユーザーに見せた情報はすべて鍵に束縛する**（r19#1）。
 *
 * - 対象は `ackRequiredItems`（stale ∪ already_absent ∪ snapshot 欠落 removed ∪ quarantined ∪ superseded）
 * - `commentId` の**文字列**昇順（数値比較ではない）
 * - キー順は固定。`JSON.stringify` の既定出力を sha256
 *
 * ここを変えると既存 ack が全て無効になる。golden-value テストで固定してある。
 */
export function computeCommentsKey(requestId: string, items: ProposalComment[]): string {
  const canon = items
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((c) => canonicalItem(c))
  return sha256(JSON.stringify({ requestId, items: canon }))
}

function canonicalItem(c: ProposalComment): Record<string, unknown> {
  if (c.status === 'quarantined') {
    return {
      id: c.id,
      status: 'quarantined',
      originalRecord: c.originalRecord ?? null,
      quarantinedAt: c.quarantinedAt ?? '',
      quarantinedBy: c.quarantinedBy ?? ''
    }
  }
  if (c.status === 'superseded') {
    return {
      id: c.id,
      status: 'superseded',
      commentBody: c.body,
      commentAt: c.at,
      proposalHashAtComment: c.proposalHashAtComment,
      supersededAt: c.supersededAt ?? '',
      supersededBy: c.supersededBy ?? '',
      proposalHashAtSupersede: c.proposalHashAtSupersede ?? ''
    }
  }
  if (c.status === 'withdrawn') {
    return {
      id: c.id,
      status: 'withdrawn',
      commentBody: c.body,
      commentAt: c.at,
      proposalHashAtComment: c.proposalHashAtComment,
      withdrawnAt: c.withdrawnAt ?? '',
      withdrawnBy: c.withdrawnBy ?? '',
      proposalHashAtWithdraw: c.proposalHashAtWithdraw ?? ''
    }
  }
  const r = c.response
  return {
    id: c.id,
    status: c.status,
    commentBody: c.body,
    commentAt: c.at,
    proposalHashAtComment: c.proposalHashAtComment,
    decision: r?.decision ?? '',
    body: r?.body ?? '',
    at: r?.at ?? '',
    baseProposalSha256: r?.baseProposalSha256 ?? '',
    proposalHashAtResponse: r?.proposalHashAtResponse ?? '',
    // `evidence` が無い応答は**キー自体を出さない**（null を入れない・r53#2）
    ...(r?.evidence ? { evidence: r.evidence } : {}),
    writer: r?.writer ?? '',
    schemaVersion: r?.schemaVersion ?? 0
  }
}

/**
 * 採用監査に残す「採用時点の全コメント状態」の鍵（r55#2）。
 * **ゲート条件ではない** — 「採用した瞬間にどの応答一式が有効だったか」を第三者が再検証するための値。
 * `open` は 0 件であることも材料に含める（未応答が無かったことを監査値から言えるように）。
 */
export function computeCommentAdoptionSnapshotKey(requestId: string, comments: ProposalComment[]): string {
  const nonBlocking = comments.filter((c) => c.status !== 'open')
  const canon = nonBlocking
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((c) => canonicalItem(c))
  const openCount = comments.length - nonBlocking.length
  return sha256(JSON.stringify({ requestId, openCount, items: canon }))
}

// ---------------------------------------------------------------------------
// ストア単位のゲート（**コメント単位より先に評価する**）
// ---------------------------------------------------------------------------

export type RepairKind = 'corrupt_store' | 'missing_store'

export interface RepairAck {
  acknowledgedAt?: string
  acknowledgedBy?: string
  reasonCode?: string
  waived?: boolean
  schemaVersion?: number
  corruptPath?: string
  corruptSha256?: string
  observedCorruptPathExists?: boolean
  observedCorruptSha256?: string | null
  missingOrMismatchedAt?: string
  missingPath?: string
  observedAt?: string
}

export interface RepairRecord {
  kind?: RepairKind
  at?: string
  corruptPath?: string
  corruptSha256?: string
  missingPath?: string
  observedAt?: string
  configCorruptPath?: string
  configCorruptSha256?: string
  ack?: RepairAck | null
}

export interface StoreGateResult {
  passes: boolean
  reason: string | null
}

/**
 * ストア単位の通過条件。**破損復旧は「全提案に影響するグローバル操作」**（r30#2）なので、
 * ここが通らない限りコメント単位を論じても意味がない。
 *
 * `repair.kind` ごとに ack の正規形が違う（r35#2）。`missing_store` に `corruptPath` を要求すると
 * **存在しないものを要求することになり恒久 block** になる。r34#2 で開けた穴を r35#2 で塞いだ箇所。
 *
 * @param quarantineFileExists `reasonCode: "reviewed"` の実体照合（退避ファイルの実在と sha256 一致）
 */
export function evaluateStoreGate(
  repair: RepairRecord | null | undefined,
  quarantineFileExists: (path: string, expectedSha256: string) => boolean
): StoreGateResult {
  if (!repair) return { passes: true, reason: null }
  const ack = repair.ack
  if (!ack) {
    return {
      passes: false,
      reason:
        repair.kind === 'missing_store'
          ? 'コメントストアが失われています。内容不明のまま放棄することをユーザーが確認するまで採用できません'
          : 'コメントストアの破損復旧が未確認です。退避ファイルを確認してから採用してください'
    }
  }
  if (!isParsableDate(ack.acknowledgedAt)) return { passes: false, reason: 'repair.ack.acknowledgedAt が解析不能' }
  if (ack.acknowledgedBy !== 'user') return { passes: false, reason: 'repair.ack.acknowledgedBy が user でない' }
  if (ack.waived !== true) return { passes: false, reason: 'repair.ack.waived が true でない（放棄の明示が無い）' }
  if (ack.schemaVersion !== COMMENT_SCHEMA_VERSION) return { passes: false, reason: 'repair.ack.schemaVersion が未知' }

  if (repair.kind === 'missing_store') {
    if (ack.reasonCode !== 'store_missing_acknowledged') {
      return { passes: false, reason: 'missing_store の reasonCode が store_missing_acknowledged でない' }
    }
    if (!isNonEmptyString(ack.missingPath) || ack.missingPath !== repair.missingPath) {
      return { passes: false, reason: 'repair.ack.missingPath が repair と一致しない' }
    }
    if (!isParsableDate(ack.observedAt)) return { passes: false, reason: 'repair.ack.observedAt が解析不能' }
    return { passes: true, reason: null }
  }

  // corrupt_store
  if (ack.reasonCode !== 'reviewed' && ack.reasonCode !== 'corrupt_file_missing') {
    return { passes: false, reason: 'corrupt_store の reasonCode が未知' }
  }
  if (ack.corruptPath !== repair.corruptPath) return { passes: false, reason: 'repair.ack.corruptPath が repair と一致しない' }
  if (ack.corruptSha256 !== repair.corruptSha256) {
    return { passes: false, reason: 'repair.ack.corruptSha256 が repair と一致しない' }
  }
  if (ack.reasonCode === 'reviewed') {
    // 「中身を読んだ」を名乗るなら**実体が在って一致している**こと（r12#2）。
    // 記録の有無だけで通すと、退避ファイルが消えていても形式だけの ack が作れてしまう
    if (!quarantineFileExists(String(repair.corruptPath ?? ''), String(repair.corruptSha256 ?? ''))) {
      return { passes: false, reason: 'reviewed ack だが退避ファイルが実在しない / sha256 不一致' }
    }
    return { passes: true, reason: null }
  }
  // corrupt_file_missing: 「確認できなかった」ことを構造化して残す（r22#1）
  if (typeof ack.observedCorruptPathExists !== 'boolean') {
    return { passes: false, reason: 'observedCorruptPathExists が boolean でない' }
  }
  if (!(typeof ack.observedCorruptSha256 === 'string' || ack.observedCorruptSha256 === null)) {
    return { passes: false, reason: 'observedCorruptSha256 が string / null でない' }
  }
  if (!isParsableDate(ack.missingOrMismatchedAt)) return { passes: false, reason: 'missingOrMismatchedAt が解析不能' }
  return { passes: true, reason: null }
}

// ---------------------------------------------------------------------------
// 合成: コメント採用ゲート
// ---------------------------------------------------------------------------

export interface CommentAdoptionGateInput {
  requestId: string
  comments: ProposalComment[]
  /** 採用直前の提案 content */
  currentContent: string
  currentProposalHash: string
  repair?: RepairRecord | null
  /** 退避ファイルの実在＋ sha256 一致（ストア単位ゲート用） */
  quarantineFileExists?: (path: string, expectedSha256: string) => boolean
  /** `removed` の snapshot 実在＋ sha256 一致（層 1b 用） */
  snapshotMatches?: (commentId: string, expectedSha256: string) => boolean
  /** 現在記録されている ack（無ければ null） */
  ack?: { proposalHashAtAck?: string; commentsKey?: string } | null
}

export interface CommentAdoptionGateResult {
  passes: boolean
  /** hard block（修復が要る）。ack では解除できない */
  hardBlockers: string[]
  /** ack を取れば解除できる項目 */
  ackRequired: ProposalComment[]
  ackSatisfied: boolean
  openCount: number
  /** 表示用の警告（要否は変えない） */
  warnings: Array<{ commentId: string; level: WarnLevel; message: string }>
  commentsKey: string
  commentAdoptionSnapshotKey: string
  reason: string | null
}

/**
 * ストア単位 → コメント単位の順で評価し、**hard block / ack 要求 / 警告**を分けて返す。
 *
 * `passes` は「レコードが妥当 かつ 必要な ack が取得済み」。
 * **出現数の不一致は hard block にしない**（r32#1）— ack を取れば通る。
 */
export function evaluateCommentAdoptionGate(input: CommentAdoptionGateInput): CommentAdoptionGateResult {
  const {
    requestId,
    comments,
    currentContent,
    currentProposalHash,
    repair,
    quarantineFileExists = () => false,
    snapshotMatches = () => false,
    ack
  } = input

  const hardBlockers: string[] = []
  const ackRequired: ProposalComment[] = []
  const warnings: Array<{ commentId: string; level: WarnLevel; message: string }> = []
  let openCount = 0

  // --- ストア単位が先（読めないストアでコメントを論じても意味がない） ---
  const store = evaluateStoreGate(repair, quarantineFileExists)
  if (!store.passes) hardBlockers.push(store.reason ?? 'コメントストアの復旧が未確認です')

  for (const c of comments) {
    const shape = validateCommentRecordShape(c)
    if (shape.broken) {
      hardBlockers.push(`コメント ${c.id ?? '(id 不明)'}: ${shape.reason}`)
      continue
    }
    if (shape.code === 'open') {
      openCount += 1
      continue
    }
    if (c.status === 'quarantined' || c.status === 'superseded') {
      // 隔離 / supersede は**ユーザーの判断**なので ack の束縛対象に入れる（r55#1 / r58#1）
      ackRequired.push(c)
      continue
    }
    if (c.status === 'withdrawn') continue

    const r = c.response
    if (!r) continue

    // --- 層 1b: removed の snapshot 実在（ack 要求へ回す・hard block ではない） ---
    let snapshotMissing = false
    for (const e of r.evidence ?? []) {
      if (e.kind !== 'removed') continue
      if (!snapshotMatches(c.id, String(e.beforeSnapshotSha256 ?? ''))) snapshotMissing = true
    }

    // --- 層 2: stale か ---
    const stale = r.proposalHashAtResponse !== currentProposalHash
    const hasAlreadyAbsent = (r.evidence ?? []).some((e) => e.kind === 'already_absent')
    if (stale || hasAlreadyAbsent || snapshotMissing) ackRequired.push(c)

    // --- 層 3: 警告（要否は変えない） ---
    for (const rc of recheckEvidenceAgainstContent(r.evidence, currentContent)) {
      if (rc.level !== 'none') warnings.push({ commentId: c.id, level: rc.level, message: rc.message })
    }
    if (snapshotMissing) {
      warnings.push({ commentId: c.id, level: 'strong', message: '削除の証跡（スナップショット）が確認できません' })
    }
  }

  const commentsKey = computeCommentsKey(requestId, ackRequired)
  const commentAdoptionSnapshotKey = computeCommentAdoptionSnapshotKey(requestId, comments)

  // ack は「鍵の一致」＋「ack 時点の提案 hash が採用直前と同じ」の両方で判定（r41#1）。
  // 後者が無いと **ack 後にさらに改稿しても ack が生き残る**（commentsKey は応答時点の材料しか持たないため）。
  const ackSatisfied =
    ackRequired.length === 0 ||
    (!!ack && ack.commentsKey === commentsKey && ack.proposalHashAtAck === currentProposalHash)

  const passes = hardBlockers.length === 0 && openCount === 0 && ackSatisfied
  let reason: string | null = null
  if (hardBlockers.length > 0) reason = hardBlockers[0]
  else if (openCount > 0) reason = `未応答のコメントが ${openCount} 件あります`
  else if (!ackSatisfied) reason = `確認が必要なコメント応答が ${ackRequired.length} 件あります`

  return {
    passes,
    hardBlockers,
    ackRequired,
    ackSatisfied,
    openCount,
    warnings,
    commentsKey,
    commentAdoptionSnapshotKey,
    reason
  }
}
