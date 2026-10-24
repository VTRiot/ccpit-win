/**
 * ユーザーコメントの**ユーザー側操作**（追加 / 取り下げ / 隔離 / supersede）と、
 * UI へ返す表示用データの組み立て。
 *
 * 設計正本 §3-4c。CC 側の応答保存は `scripts/proposal-comment-respond.cjs` が担い、
 * **ここからは書かない**（応答は CC が書く / ユーザー操作はアプリが書く、の分離）。
 *
 * **ユーザー側も CC 側と同じ規律を通す**（r5#3）: 追加・取り下げも同一ストアモジュール経由で、
 * `.bak` → temp → atomic rename と非破壊マージを踏む。片側だけ雑だと同じストアが壊れる。
 */
import { randomUUID, createHash } from 'crypto'
import { readFileSync } from 'fs'
import {
  defaultCommentStorePaths,
  readCommentStore,
  writeCommentStore,
  initializeCommentStore,
  listComments,
  writeCommentSnapshot,
  snapshotMatches,
  quarantineFileMatches,
  emptyStore,
  type CommentStorePaths,
  type CommentStore
} from './commentStore'
import {
  evaluateCommentAdoptionGate,
  validateCommentRecordShape,
  type ProposalComment,
  type CommentAdoptionGateResult
} from './commentGate'

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf-8').digest('hex')

export interface CommentOpsResult {
  ok: boolean
  /** 失敗理由（UI がそのまま出せる日本語） */
  reason?: string
  /** CAS 不一致など、**入力を捨てずに**再確認を促すケース（r17#4） */
  retryable?: boolean
}

/** ストアを読み、未初期化なら**その場で初期化**して返す（初回利用で詰まないように） */
function loadOrInit(paths: CommentStorePaths): { store: CommentStore | null; problem: string | null } {
  const read = readCommentStore(paths)
  if (read.uninitialized) return { store: initializeCommentStore(paths), problem: null }
  if (read.problem) return { store: null, problem: read.problem.reason }
  return { store: read.store ?? emptyStore(), problem: null }
}

/**
 * コメントを追加する。
 *
 * **CAS**（r12#3）: 入力欄を開いた時点の提案 hash と保存直前の hash が一致すること。
 * 一致しなければ保存せず `retryable` を返す — **入力は捨てない**（r17#4）。
 * ユーザーが現在版を見て「これでいい」と決めたら `expectedProposalHash` を現在値にして再送する。
 *
 * 同一トランザクションで**そのコメント専用のスナップショット**を取る（r44#1）。
 * `removed` 証跡の基準時点を「コメント投稿時」に置くのが要点。
 */
export function addComment(
  requestId: string,
  body: string,
  proposalContent: string,
  expectedProposalHash: string,
  paths: CommentStorePaths = defaultCommentStorePaths()
): CommentOpsResult & { commentId?: string } {
  if (!body || body.trim().length === 0) return { ok: false, reason: 'コメントが空です' }
  const currentHash = sha256(proposalContent)
  if (expectedProposalHash && expectedProposalHash !== currentHash) {
    return {
      ok: false,
      retryable: true,
      reason: '提案が更新されました。内容を確認して送り直してください'
    }
  }
  const { store, problem } = loadOrInit(paths)
  if (!store) return { ok: false, reason: problem ?? 'コメントストアが読めません' }

  const list = store.requests[requestId] ?? []
  // id は UUID。連番は取り下げ後の再追加や並行追加で衝突し、CAS の一意性を壊す（r4#4）
  const id = randomUUID()
  if (list.some((c) => c && c.id === id)) return { ok: false, reason: 'id が衝突しました（再試行してください）' }

  const comment: ProposalComment = {
    id,
    body,
    at: new Date().toISOString(),
    proposalHashAtComment: currentHash,
    status: 'open',
    response: null
  }
  store.requests[requestId] = [...list, comment]
  // **スナップショットを先に書く**（ストア更新だけ成功して基準が無い状態を作らない）
  writeCommentSnapshot(paths, requestId, id, proposalContent)
  writeCommentStore(store, paths)
  return { ok: true, commentId: id }
}

/**
 * 取り下げ。**`open` のときだけ**（応答済みを無かったことにしない・r5#3）。
 * 納得できない応答は取り下げではなく `superseded` か新しいコメントで扱う。
 */
export function withdrawComment(
  requestId: string,
  commentId: string,
  proposalContent: string,
  paths: CommentStorePaths = defaultCommentStorePaths()
): CommentOpsResult {
  return mutate(requestId, commentId, paths, (c) => {
    if (c.status !== 'open') return { ok: false, reason: `open ではありません（${c.status}）` }
    return {
      ok: true,
      next: {
        ...c,
        status: 'withdrawn',
        withdrawnAt: new Date().toISOString(),
        withdrawnBy: 'user',
        proposalHashAtWithdraw: sha256(proposalContent)
      }
    }
  })
}

/**
 * 壊れたレコード 1 件の隔離（r53#3）。ストア全体の `--repair` では解除できない
 * 「schema-valid なストアの中に 1 件だけ壊れたレコードがある」ケースの出口。
 *
 * **CC は隔離できない**（UI 専用）。CC が壊れたレコードを作って自分で隔離する経路を残さない。
 */
export function quarantineComment(
  requestId: string,
  commentId: string,
  reasonCode: string,
  observedProblem: string,
  paths: CommentStorePaths = defaultCommentStorePaths()
): CommentOpsResult {
  return mutate(requestId, commentId, paths, (c) => ({
    ok: true,
    next: {
      id: c.id,
      body: c.body,
      at: c.at,
      proposalHashAtComment: c.proposalHashAtComment,
      status: 'quarantined',
      quarantinedAt: new Date().toISOString(),
      quarantinedBy: 'user',
      quarantinedReasonCode: reasonCode,
      observedProblem,
      // 壊れたレコードを**逐語で**保存する（何が壊れていたかを後から読めるように）
      originalRecord: c
    }
  }))
}

/**
 * 応答の supersede（r58#1）。「この応答はもう採用判断の材料にしない」というユーザーの判断。
 *
 * これが無いと、**stale ack を拒みたいユーザーに出口が無い**（`resolved` は取り下げられないため）。
 */
export function supersedeComment(
  requestId: string,
  commentId: string,
  proposalContent: string,
  paths: CommentStorePaths = defaultCommentStorePaths()
): CommentOpsResult {
  return mutate(requestId, commentId, paths, (c) => {
    if (c.status !== 'resolved') return { ok: false, reason: `resolved ではありません（${c.status}）` }
    return {
      ok: true,
      next: {
        ...c,
        status: 'superseded',
        supersededAt: new Date().toISOString(),
        supersededBy: 'user',
        proposalHashAtSupersede: sha256(proposalContent)
      }
    }
  })
}

function mutate(
  requestId: string,
  commentId: string,
  paths: CommentStorePaths,
  fn: (c: ProposalComment) => { ok: true; next: ProposalComment } | { ok: false; reason: string }
): CommentOpsResult {
  const { store, problem } = loadOrInit(paths)
  if (!store) return { ok: false, reason: problem ?? 'コメントストアが読めません' }
  const list = store.requests[requestId] ?? []
  const target = list.find((c) => c && c.id === commentId)
  if (!target) return { ok: false, reason: 'コメントが見つかりません' }
  const r = fn(target)
  if (!r.ok) return { ok: false, reason: r.reason }
  // 対象 1 件のみ差し替え（他 requestId / 他 commentId は保持）
  store.requests[requestId] = list.map((c) => (c && c.id === commentId ? r.next : c))
  writeCommentStore(store, paths)
  return { ok: true }
}

// ---------------------------------------------------------------------------
// UI へ返す表示用データ
// ---------------------------------------------------------------------------

export interface CommentThreadView {
  comments: ProposalComment[]
  /** 壊れているコメント（隔離の導線を出す対象） */
  brokenIds: string[]
  gate: CommentAdoptionGateResult | null
  /** ストアが読めない場合の理由（採用は hard block される） */
  storeProblem: string | null
  /** repair 復旧が未確認かどうか（**全提案に影響するグローバル状態**・r30#2） */
  repairPending: boolean
}

export function getCommentThread(
  requestId: string,
  proposalContent: string,
  paths: CommentStorePaths = defaultCommentStorePaths()
): CommentThreadView {
  const read = readCommentStore(paths)
  if (read.uninitialized) {
    return { comments: [], brokenIds: [], gate: null, storeProblem: null, repairPending: false }
  }
  if (read.problem) {
    return {
      comments: [],
      brokenIds: [],
      gate: null,
      storeProblem: read.problem.reason,
      repairPending: true
    }
  }
  const comments = listComments(requestId, read)
  const brokenIds = comments.filter((c) => validateCommentRecordShape(c).broken).map((c) => c?.id ?? '')
  const gate = evaluateCommentAdoptionGate({
    requestId,
    comments,
    currentContent: proposalContent,
    currentProposalHash: sha256(proposalContent),
    repair: read.store?.repair ?? null,
    quarantineFileExists: quarantineFileMatches,
    snapshotMatches: (commentId, expected) => snapshotMatches(paths, requestId, commentId, expected)
  })
  return {
    comments,
    brokenIds,
    gate,
    storeProblem: null,
    repairPending: !!read.store?.repair && !read.store.repair.ack
  }
}

/**
 * CC への対話依頼文を組み立てる。
 *
 * **処理対象は「依頼文を生成した時点で `open` だったコメント全件」**（snapshot・r18#4）。
 * 依頼後に足されたコメントは**次回の対話対象**であり、今回の応答保存を妨げない。
 * 固定しないと、コメントが増えるたびに依頼文を作り直す儀式へ戻る。
 */
export function buildCommentDialogueRequest(
  requestId: string,
  filePath: string,
  proposalContent: string,
  paths: CommentStorePaths = defaultCommentStorePaths()
): string {
  const view = getCommentThread(requestId, proposalContent, paths)
  const open = view.comments.filter((c) => c.status === 'open')
  const context = view.comments.filter((c) => c.status !== 'open')
  const currentHash = sha256(proposalContent)

  // 提案の「経緯」（§3-7）。無ければ**黙って隠さず**「記載なし」と書く
  let provenance = '（記載なし。提案元の文脈は不明。改稿時は元の意図を壊さないよう注意すること）'
  const m = proposalContent.match(/^-\s*(?:経緯|Context):\s*(.+)$/m)
  if (m) provenance = m[1].trim()

  const lines: string[] = [
    '# ユーザーコメントへの応答（CC 作業依頼）',
    '',
    '## 目的',
    '',
    'ユーザーのリクエスト / 指摘により、**ユーザーの望む形の Skill へ昇華させる**こと。',
    '「答えたから済んだ」で止めない。反映するなら改稿し、反映しないなら理由を書く。**無応答で終わらない**。',
    '',
    `## 対象提案: ${requestId}`,
    '',
    `- ファイル: ${filePath}`,
    `- 現在の content sha256: ${currentHash}`,
    '',
    '## 提案の経緯（提案元 CC の記録）',
    '',
    provenance,
    '',
    '## 処理対象のコメント（**この全件に応答すること**）',
    ''
  ]
  if (open.length === 0) {
    lines.push('（未応答のコメントはありません）')
  } else {
    for (const c of open) {
      lines.push(`### commentId: ${c.id}`)
      lines.push('')
      lines.push(`- 投稿時刻: ${c.at}`)
      lines.push(`- コメント時点の提案 hash: ${c.proposalHashAtComment}`)
      lines.push(`- 本文 sha256（CAS 用）: ${sha256(c.body)}`)
      lines.push('')
      lines.push('```')
      lines.push(c.body)
      lines.push('```')
      lines.push('')
    }
  }
  if (context.length > 0) {
    lines.push('## 文脈（**処理対象ではない**。参照のみ）')
    lines.push('')
    for (const c of context) {
      lines.push(`- ${c.id} [${c.status}] ${c.body.slice(0, 60)}${c.body.length > 60 ? '…' : ''}`)
    }
    lines.push('')
  }
  lines.push(
    '## 応答の書き方',
    '',
    '**提案 MD を改稿するのは CC。アプリは書かない。** 応答の保存は次のスクリプトだけを使うこと',
    '（直接 JSON を編集すると「壊れた resolved」を自分で作って自分でブロックされる）:',
    '',
    '```',
    'node ccpit/scripts/proposal-comment-respond.cjs --request-id <id> --batch-file <json>',
    '```',
    '',
    '- `decision` は **`applied`（この応答時点の提案に反映済み）/ `declined`（反映しない・理由付き）** の 2 つ',
    '- **コメント内の要望を列挙し、1 つずつ扱いを書くこと**。一部でも反映しないなら `declined` へ倒し、',
    '  `body` に「反映した要望 / 退けた要望」を箇条書きで明示する',
    '- `applied` には `evidence` が必須。`kind` は 3 種:',
    '  - `present` … 反映されている箇所の逐語引用（提案本文に**ちょうど 1 回**。空白除き 30 字以上）',
    '  - `removed` … 削除・縮小した記述の逐語引用（**そのコメントの snapshot に在り**、現本文に 0 回）',
    '  - `already_absent` … 「入れないで」と言われた記述で**もともと無い**もの（`userPhraseQuote` も必須）',
    '- 改稿したら**直後に hash を取り直して** `expectProposalSha256` に入れる',
    '- **コメントを取り下げてはならない**（応答するか、理由付きで `declined` にする）',
    '',
    'ユーザーが応答に納得しなければ次のコメントが足される。**終端を決めるのはユーザー**である。'
  )
  return lines.join('\n')
}

/** UI が採用要求に載せる ack ペイロード（**非永続**。findings ack と同じ扱い） */
export function buildCommentsAckPayload(
  requestId: string,
  proposalContent: string,
  paths: CommentStorePaths = defaultCommentStorePaths()
): { proposalHashAtAck: string; commentsKey: string } | null {
  const view = getCommentThread(requestId, proposalContent, paths)
  if (!view.gate || view.gate.ackRequired.length === 0) return null
  return { proposalHashAtAck: sha256(proposalContent), commentsKey: view.gate.commentsKey }
}

/** 提案 MD を読んで content を得る（IPC から使う小さなヘルパ） */
export function readProposalContent(filePath: string): string {
  return readFileSync(filePath, 'utf-8')
}
