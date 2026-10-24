#!/usr/bin/env node
/*
 * recommend-review-detect.cjs — レビュー債務 検出ゲートの「検出核」（純粋判定）。
 *
 * 役割（testable-stop-hook-gate-authoring §1 の node 核）:
 *   「何を言うべきか」だけを担う。停止を止めるべき提案が在れば完成した block-JSON を
 *   JSON.stringify で stdout に出し、bash 足場は printf のみ（JSON エスケープ事故ゼロ）。
 *   判定不能・対象なしは空出力＝非 block。
 *
 * 判定（発注 20260805_1631_proposal-review-harvest §A-1 判定表の機械条件）:
 *   走査対象は adoption_label が recommend / recommend-with-findings の提案。
 *
 *   label = recommend:
 *     レビュー記録なし                                        → block（未レビュー・従来からの判定）
 *     clears = (verdict === approve) かつ (proposal_hash === 現ファイルの sha256) → 通過
 *     clears でない（needs-attention / stale approve / hash 欠落 / その他 verdict）:
 *       reviewedAt < A1_EPOCH        → 通過（有効起点より前の既存債務は免除）
 *       reviewedAt >= A1_EPOCH       → block（本強化の本体）
 *       reviewedAt 欠落・解析不能     → block（後述の fail-closed 例外）
 *
 *   label = recommend-with-findings（三択(c) の明示降格）:
 *     以下を全て満たす → 通過。1 つでも欠けたら block。
 *       - 台帳に当該 request_id の review 記録が存在する
 *       - 台帳 downgradedTo === 'recommend-with-findings' かつ frontmatter に downgraded_at がある（双方）
 *       - review 記録の findings が非空（実レビューの実体がある）
 *       - downgradedFromHash === proposal_hash（降格元 = レビューされた content と同一）
 *       - downgradedContentHash === 現ファイルの sha256（降格マーカー追記後、本文が変わっていない）
 *
 * なぜ clears を単一述語にしたか:
 *   clears は採用ゲート（skillProposals.ts の needsReviewBeforeAdopt）の解除条件と**字面で同一**である。
 *   verdict を名指し列挙する実装（needs-attention だけを対象にする等）は needs-rework / adopt-with-edits /
 *   stale approve を取りこぼす。単一述語の否定で覆うことで、hook と採用ゲートの二重定義も生まれない。
 *   特に stale approve（approve 後に提案本文が書き換わった状態）は、採用ゲートが hash 不一致で拒否する一方
 *   hook が通してしまうと「採用不能な提案を放置して終了できる」穴になる。
 *
 * なぜ降格に hash チェーンを張るか:
 *   降格には frontmatter 追記が必要でファイル hash が必ず変わるため、proposal_hash と現ファイルを直接
 *   比較すると正規の降格が自分自身を失効させる。よって
 *     レビュー対象(proposal_hash) → 降格元(downgradedFromHash) → 降格後(downgradedContentHash) → 現ファイル
 *   の鎖で見る。マーカー追記以外の変更が入れば鎖のどこかが必ず切れて block する。
 *
 * fail-open の向き: proposals 不在 / 読めない / JSON 破損（parse throw）→ 空扱い＝非 block。
 *   破損を過剰 block（cry-wolf）に倒さない。
 * fail-closed の例外は 1 点のみ: 非 clears の recommend で reviewedAt が欠落・解析不能な場合は block。
 *   免除の証明責任は記録側にあり、reviewedAt を落とすだけで永久免除になる穴を塞ぐ
 *   （採用ゲートで proposal_hash 欠落を fail closed 扱いするのと同じ思想）。
 *
 * 所有権フィルタ（2026-08-22・追いかけっこバグ修正）:
 *   旧実装は共有プールを**全走査**したため、**自分が一度も触っとらん他セッションの提案**で
 *   停止が block された。相手が編集を続ける限り自力で解消できず、解消しようとすると他人の
 *   ファイルを書き換えることになって追いかけっこになる（2026-08-07 に comment-response-gate で
 *   実発生、2026-08-21 に本 hook で再発・同一セッションが 3 回 block）。
 *   本 hook は soft なリマインダ層であり、真の強制点は採用ゲート（needsReviewBeforeAdopt・
 *   fail-closed・hash 束縛・無改変）である。リマインダの宛先は**行動できる者**でなければならん。
 *   自分が出した提案ならレビューを回すことも降格も棄却もできるが、他人の提案には行動できない。
 *   よって検査対象を「自セッションが Write/Edit した提案」へ絞る。これは機能の縮退ではなく、
 *   リマインダを宛先の正しい形へ戻す変更である。
 *
 * env（テスタブル化）:
 *   RRG_PROPOSALS_DIR : 提案プール（既定 ~/.ccpit/proposals）
 *   RRG_STATES_PATH   : 状態ストア（既定 ~/.ccpit/proposal-states.json）
 *   RRG_REVIEWS_PATH  : レビューストア（既定 ~/.ccpit/proposal-reviews.json）
 *   RRG_GATE_DIR      : 観測ログの出力先（既定 ~/.ccpit/.recommend-review-gate）
 *   -- 所有権（優先順位は resolveOwnershipMode を見よ。定義されていること自体がスイッチ） --
 *   RRG_STDIN_JSON    : 本番。gate.sh が hook 入力 JSON を stdin へ流す
 *   RRG_TRANSCRIPT    : 転写の実パス（テスト・dry-run）
 *   RRG_SESSION_ID    : session_id（転写解決元）
 *   RRG_OWNED_FILES   : 所有集合の直接指定（; 区切り。空でも「対象ゼロ」の正当な指定）
 *   RRG_CWD           : 相対 file_path の解決基準（本番は hook 入力の cwd を使う）
 *   ※ A1_EPOCH は env でも config でも動かせない定数にしてある。免除境界を後から動かせると
 *      それ自体がゲートの緩和経路になるため。
 */
'use strict'
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
/**
 * 所有権プリミティブ（共有正本 hook-ownership.cjs）。
 * **require に失敗しても従来モード（全走査）へは落とさない** — 落とすと本 hook のバグ
 * （他人の債務で停止不能）へ静かに退行する。所有権 env が指定されている場合は
 * `unavailable`（＝沈黙）に倒す。resolveOwnershipMode を見よ。
 */
let ownership = null
try {
  ownership = require('./hook-ownership.cjs')
} catch {
  /* fail-open: 不在時の扱いは resolveOwnershipMode が決める */
}

/**
 * A-1 の有効起点（EPOCH）。この時刻**以降**に台帳へ記録されたレビュー結果にのみ本強化の block を適用する。
 * 値は既存債務の凍結スナップショットを書き出した実時刻であり、同一値が
 * `_evidence/legacy_exempt_snapshot.md` に記録されている（相互照合可能）。
 * 起点より前のレビューは免除されるが、免除は**本 hook の block 判定のみ**であり、
 * 採用ゲート（approve 必須・hash 束縛）は無改変で効き続ける。
 */
const A1_EPOCH_ISO = '2026-08-06T04:14:36.367Z'
const A1_EPOCH_MS = Date.parse(A1_EPOCH_ISO)

/** 採用ゲートを解除する肯定的 terminal verdict。skillProposals.ts の ADOPTION_CLEARING_VERDICT と同値。 */
const CLEARING_VERDICT = 'approve'
/** 三択(c) の降格ラベル。 */
const DOWNGRADE_LABEL = 'recommend-with-findings'

/**
 * 裁定の理由に課すフロア（`harvest_ux_plan.md` §4-3）。
 * 「対象外」の一言・空白埋め・同語反復といった**明白な水増しを弾くための下限**であって、
 * 理由の質を保証するものではない。質の判断はユーザーが理由の全文を読んで行う。
 */
const MIN_ADJUDICATION_REASON_CHARS = 30
const MIN_ADJUDICATION_REASON_UNIQUE_CHARS = 15
/**
 * 裁定の終端語彙（オーナー裁定 2026-08-06）。**この 2 つしか存在しない**。
 *
 * - `rejected` — 指摘が的外れ。CC が根拠付きで棄却した。ユーザーに残る判断は採否のみ
 * - `deferred` — 指摘は妥当だが未修正。**推奨バッジは維持**し、採用時に
 *   「承認されていないが承知の上で採用する」チェックで**責任をユーザーへ譲渡**する
 *
 * `fixed`（修正して再レビュー待ち）は**意図的に存在しない**。修正したなら再レビューを回して
 * 最新の指摘に対して裁定し直す（刈り取りはループ）。「待ち」を終端状態として置くと、
 * 直したと言い張って止まる経路が生まれる。
 */
const DECISION_REJECTED = 'rejected'
const DECISION_DEFERRED = 'deferred'
const TERMINAL_DECISIONS = new Set([DECISION_REJECTED, DECISION_DEFERRED])

/**
 * finding id の正準形（`harvest_ux_plan.md` §4-1・レビュー r4#3）。
 * 先頭ゼロ（`[01]`）・空文字・空白混じりを弾く。抽出側と裁定側の**両方**に同じ形を課す。
 */
const CANONICAL_ID_RE = /^[1-9][0-9]*$/

/** block 理由に埋める値プレビューの上限長（ログ肥大・機微データ引用の抑制。app 側と同値）。 */
const ID_PREVIEW_MAX = 50

/**
 * 型不正の原因がひと目で分かる短い値表示。`JSON.stringify` で文字列と数値を見分けられる形にし
 * （`"1"` vs `1`）、stringify 不能値（undefined 等）は `String()` に落とす。50 字超は切り詰める。
 */
function previewValue(v) {
  const s = JSON.stringify(v)
  const t = typeof s === 'string' ? s : String(v)
  return t.length > ID_PREVIEW_MAX ? t.slice(0, ID_PREVIEW_MAX) + '…' : t
}

/**
 * レビュー本文から finding の id を抽出する（`harvest_ux_plan.md` §4-1）。
 *
 * **行単位の単純一致で行う**。ブロック切り出し（次の `[n]` まで lookahead で囲う等）に頼らない —
 * 設計時に lookahead 版を書いたところ JS に存在しない `\Z` を使って静かに件数を取りこぼした。
 * 判定の中核が正規表現の細部で壊れる構造にしない。
 *
 * 戻り値: id 配列 / 指摘ゼロなら [] / **判定不能なら null（呼び出し側で fail closed）**
 */
function extractFindingIds(findings) {
  if (typeof findings !== 'string') return null // 台帳に配列格納の実例あり
  const ids = []
  for (const line of findings.split(/\r?\n/)) {
    const m = line.match(/^\s*\[(\d+)\]/)
    if (!m) continue
    // canonical decimal string 以外は **正規化せず弾く**（r4#3）。`[01]` を静かに '1' へ
    // 丸めると、レビュアーが書いた id と裁定 id の対応が実装依存になる。
    if (!CANONICAL_ID_RE.test(m[1])) return null
    ids.push(Number(m[1]))
  }
  if (ids.length === 0) {
    // 「指摘ゼロ」は明示されている場合のみ認める。旧形式・形式崩れは判定不能扱い。
    return /FINDINGS:\s*none/i.test(findings) ? [] : null
  }
  // 1..N の連番・重複なし・昇順を要求する。`[1]` が 2 件あると裁定 1 件で複数指摘を
  // 処理済みに見せられるため、finding と裁定の 1:1 対応を id の形で保証する。
  for (let i = 0; i < ids.length; i++) {
    if (ids[i] !== i + 1) return null
  }
  return ids.map(String)
}

/** 裁定の理由が実質的か（水増しを弾くフロア）。 */
function isSubstantiveReason(reason) {
  if (typeof reason !== 'string') return false
  const trimmed = reason.trim()
  if (trimmed.length < MIN_ADJUDICATION_REASON_CHARS) return false
  const dense = trimmed.replace(/\s+/g, '')
  if (dense.length < MIN_ADJUDICATION_REASON_CHARS) return false // 空白埋め
  if (new Set(dense).size < MIN_ADJUDICATION_REASON_UNIQUE_CHARS) return false // 同語反復
  return true
}

/** 刈り取り未完（＝ラベルを「指摘つき」へ落とす）を表す結果。 */
function notHarvested(reason) {
  return { ok: false, reason, findingCount: 0, rejected: [], deferred: [] }
}

/**
 * 「この review 記録は、いま手元にある content を対象としたものか」（TS 正本 `reviewCoversContent` と同一規則）。
 *
 * 素朴に `proposal_hash === contentHash(txt)` だけで見ると、**正規降格した提案が必ず落ちる**。
 * 降格は frontmatter へ `adoption_label` / `downgraded_at` を追記するのでファイル hash は必ず変わる。
 * 2026-08-07 実測: 降格済み 20 件が全滅し、しかも「content hash 不一致だから再レビューせよ」という
 * **誤った対処**を指示していた（実体は「裁定が 1 件も無い」）。
 *
 * よって §5-3 の **hash チェーン**を判定に入れる:
 *   レビュー対象 content(proposal_hash) → 降格元(downgradedFromHash)
 *   → 降格後(downgradedContentHash) → 現ファイル
 * **緩めない**: 鎖のどこか 1 つでも切れていれば false（本文が書き換わっている ＝ 再レビューが要る）。
 */
function reviewCoversContent(review, txt) {
  const storedHash = typeof review.proposal_hash === 'string' ? review.proposal_hash : ''
  if (!storedHash) return false
  const current = contentHash(txt)
  if (storedHash === current) return true
  return (
    review.downgradedTo === DOWNGRADE_LABEL &&
    review.downgradedFromHash === storedHash &&
    typeof review.downgradedContentHash === 'string' &&
    review.downgradedContentHash === current
  )
}

/**
 * 「CC が指摘を刈り取ったか」を判定する（`harvest_ux_plan.md` §3）。
 *
 * オーナー要求: 推奨バッジは「レビュアーが approve と言った」ではなく
 * **「CC が指摘を全部裁定し切った」**を意味する。裁定の終端は 2 つ:
 * `rejected`（的外れと根拠付きで棄却）と `deferred`（妥当だが未修正・ユーザー判断へ委譲）。
 * 修正した場合は終端ではなく**再レビューへ戻る**（`fixed` という裁定は存在しない）。
 *
 * 戻り値: `{ ok, reason, findingCount, rejected[], deferred[] }`
 * - `ok: true` — 推奨バッジ維持。`deferred` が 1 件でもあれば採用時に ack（責任譲渡）が要る
 * - `ok: false` — 未裁定が残る ＝ 刈り取り未完。`reason` が理由
 */
function judgeHarvest(review, txt) {
  if (!review) return notHarvested('未レビュー')
  if (!reviewCoversContent(review, txt)) {
    return notHarvested('レビューが現内容に対するものでない（content hash 不一致）')
  }
  const ids = extractFindingIds(review.findings)
  if (ids === null) return notHarvested('レビュー本文から指摘を同定できない')
  const verdict = String(review.verdict || '')
    .trim()
    .toLowerCase()
  if (ids.length === 0) {
    // 指摘ゼロを名乗るなら verdict と整合していること（矛盾レビューの素通しを塞ぐ）
    if (verdict !== CLEARING_VERDICT) return notHarvested('指摘ゼロだが verdict が approve でない')
    return { ok: true, reason: null, findingCount: 0, rejected: [], deferred: [] }
  }
  // **順序が意味を持つ**: 「裁定が無い」を先に見る。逆順だと `adjudicationsFor` が未記録の
  // 未裁定エントリまで「古い裁定がある」と誤診断し、対処（再レビュー）を誤らせる（2026-08-07 実測）。
  const adj = review.adjudications
  if (!Array.isArray(adj) || adj.length === 0) return notHarvested('裁定が記録されていない')
  if (review.adjudicationsFor !== contentHash(review.findings)) {
    return notHarvested('裁定が現在の指摘に対するものでない')
  }
  const seen = new Set()
  for (const a of adj) {
    // 裁定 id も canonical decimal string のみ（r4#3）。数値型・先頭ゼロ・空白付きは fail closed。
    // 理由には期待形と実値（プレビュー＋型名）を並記する。実事故（2026-08-25）: JSON 数値の id を
    // 書いて「形式が不正」だけ返され、型が原因だと台帳を開いて突き合わせるまで分からなかった。
    if (!a || typeof a.id !== 'string' || !CANONICAL_ID_RE.test(a.id)) {
      const v = a ? a.id : a
      return notHarvested(
        '裁定の形式が不正: id は canonical decimal string（文字列、例 "1"）が必要。実際: ' +
          previewValue(v) +
          '（' +
          typeof v +
          '）'
      )
    }
    if (seen.has(a.id)) return notHarvested('裁定 id が重複している')
    seen.add(a.id)
  }
  // 欠けも余分も許さない（全単射）。片方向だけだと余分な裁定や重複が実装差に委ねられる。
  if (seen.size !== ids.length || !ids.every((id) => seen.has(id))) {
    return notHarvested('裁定が指摘と 1:1 対応していない')
  }
  const rejected = []
  const deferred = []
  for (const a of adj) {
    if (!TERMINAL_DECISIONS.has(a.decision)) {
      // `fixed` 等の非終端はここで落ちる。直したなら再レビューを回して裁定し直す。
      return notHarvested(
        '指摘 ' + a.id + ' が未裁定（' + String(a.decision) + '）＝刈り取り未完。修正したなら再レビューへ'
      )
    }
    if (!isSubstantiveReason(a.reason)) return notHarvested('指摘 ' + a.id + ' の裁定理由が実質的でない')
    ;(a.decision === DECISION_DEFERRED ? deferred : rejected).push(a.id)
  }
  return { ok: true, reason: null, findingCount: ids.length, rejected, deferred }
}
/** 走査対象ラベル。 */
const SCANNED_LABELS = new Set(['recommend', DOWNGRADE_LABEL])

/**
 * JSON を読む。**不在/空 → {}**（未作成の正常系）。**破損（parse throw）→ null**（fail-open の合図）。
 * 破損を {} と同一視すると「既レビューを未レビューと誤認→過剰 block（cry-wolf）」になるため区別する。
 */
function readJsonObject(p) {
  let raw
  try {
    raw = fs.readFileSync(p, 'utf8')
  } catch {
    return {} // 不在 → {}
  }
  if (!raw.trim()) return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return null // 破損 → fail-open
  }
}

function frontmatter(txt) {
  const m = txt.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  return m ? m[1] : ''
}

// 単一行スカラーのみ読む（YAML 複数行/配列はマッチせず '' → 当該提案をスキップ＝fail-open 方向）。
function fmField(fm, key) {
  const re = new RegExp('^' + key + ':[ \\t]*(.*)$', 'm')
  const m = fm.match(re)
  if (!m) return ''
  return m[1]
    .replace(/\s*#.*$/, '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim()
}

/**
 * 提案 content の hash。採用ゲート（skillProposals.ts computeProposalHash）と**同一方式**でなければ
 * ならない: readFileSync(p,'utf8') が返す文字列の sha256（正規化しない）。方式が分岐すると
 * 「アプリでは一致するのに hook では不一致」という cry-wolf を生む。
 */
function contentHash(txt) {
  return crypto.createHash('sha256').update(txt, 'utf8').digest('hex')
}

// adopted/rejected は確定バッジ（レビュー・採否が終了）＝免除。
// held は **免除しない**: held は non-terminal な保留状態で独立レビューの証拠ではなく、
// proposal-review-backlog-sweep §2 も「held は除外しない＝レビュー対象」とする。held を免除すると
// 未レビューの recommend が保留のまま hook から永久に隠れる（レビュー債務の盲点）。
const EXEMPT_STATES = new Set(['adopted', 'rejected'])
const MAX_LISTED = 8

/** recommend ラベルの判定。通過なら null、block なら理由サフィックスを返す。 */
function judgeRecommend(review, txt) {
  if (!review) return '（未レビュー）'
  // 解除条件は「レビュアーが approve と言ったか」ではなく **「CC が指摘を裁定し切ったか」**。
  const harvest = judgeHarvest(review, txt)
  if (harvest.ok) return null
  const why = harvest.reason
  const at = typeof review.reviewedAt === 'string' ? Date.parse(review.reviewedAt) : NaN
  if (!isNaN(at) && at < A1_EPOCH_MS) return null // 起点より前の既存債務は免除（従来どおり）
  // 起点以降 / reviewedAt 欠落・解析不能（＝免除を証明できない）は block
  return '（' + why + (isNaN(at) ? ' / reviewedAt 欠落または解析不能' : '') + '）'
}

/**
 * 降格の**正準逆変換**。現ファイルから降格マーカーを取り除き `adoption_label` を `recommend` へ戻す。
 *
 * 何のためか（設計レビュア 2026-08-06 確認事項への回答 = 選択肢(a)）:
 *   hash 2 本鎖は「レビュー対象 → 降格直前」と「降格後 → 現ファイル」を縛るが、
 *   **降格操作そのもの**（fromHash → contentHash の遷移）は降格者の自己申告であり、
 *   その 1 手の中で本文を丸ごと書き換えても両端の hash は辻褄が合ってしまう。
 *   検証を降格ツール側に置いても「検証を回さない降格者」には効かない（強制点に無い）。
 *   そこで**強制点である hook 側**で、現ファイルから降格を逆変換して復元した content の hash が
 *   レビュー対象 hash と一致することを要求する。運用 frontmatter キーの追記/変更以外を触っていれば
 *   復元は一致せず block する。降格前 content を保存せずに「降格操作の本文非改変」を証明できる。
 *
 * 逆変換が許す差分は次の 3 つだけ:
 *   - `adoption_label: recommend` → `recommend-with-findings`
 *   - `downgraded_at:` 行の追記
 *   - `downgrade_reason:` 行の追記（任意）
 * これ以外（本文改変・他キーの並べ替え等）は復元不能となり fail closed。
 * 副次効果として、降格操作は「最小・機械的な編集」であることを強制される。
 */
function invertDowngrade(txt) {
  const fmMatch = txt.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fmMatch) return null
  const fmEnd = fmMatch[0].length
  let fm = txt.slice(0, fmEnd)
  const rest = txt.slice(fmEnd)
  // 降格マーカー行を行末込みで除去（frontmatter 末尾行でも `---` を壊さない）
  fm = fm.replace(/^downgraded_at:.*\r?\n/m, '')
  fm = fm.replace(/^downgrade_reason:.*\r?\n/m, '')
  // ラベルを降格前へ戻す。
  // CRLF 対応: /m の `$` は \n の直前に一致するが、行末の \r は `[ \t]*` が消費できない。
  // \r を捕獲して復元しないと、CRLF の提案ファイルでは**正規の降格でも逆変換が復元できず過剰 block**になる。
  fm = fm.replace(/^(adoption_label:[ \t]*)recommend-with-findings[ \t]*(\r?)$/m, '$1recommend$2')
  return fm + rest
}

/** recommend-with-findings ラベルの判定。通過なら null、block なら理由サフィックスを返す。 */
function judgeDowngraded(review, txt, fm) {
  if (!review) return '（降格ラベルだが台帳にレビュー記録が無い）'
  const hasLedgerMark = String(review.downgradedTo || '').trim() === DOWNGRADE_LABEL
  const hasFmMark = fmField(fm, 'downgraded_at') !== ''
  if (!hasLedgerMark && !hasFmMark) return '（降格記録が台帳・frontmatter の双方に無い）'
  if (!hasLedgerMark) return '（降格記録が frontmatter のみ・台帳に無い）'
  // 案内文が要求している以上、downgradedAt も実際に検証する（案内と強制のズレを残さない）。
  // 降格イベントの時刻が欠落・解析不能なら降格履歴が監査できないので fail closed。
  if (
    typeof review.downgradedAt !== 'string' ||
    review.downgradedAt.trim() === '' ||
    isNaN(Date.parse(review.downgradedAt))
  ) {
    return '（台帳の downgradedAt が欠落または解析不能）'
  }
  if (!hasFmMark) return '（降格記録が台帳のみ・frontmatter に無い）'
  // findings は**文字列であること**まで要求する。String(...) で潰すと、`{}` のような非文字列が
  // "[object Object]" になって「非空」と誤判定され、実体のない台帳でも降格解除できてしまう。
  if (typeof review.findings !== 'string' || review.findings.trim() === '') {
    return '（findings が空または文字列でない＝実レビューの実体が無い）'
  }
  const storedHash = typeof review.proposal_hash === 'string' ? review.proposal_hash : ''
  const fromHash = typeof review.downgradedFromHash === 'string' ? review.downgradedFromHash : ''
  if (!fromHash || !storedHash || fromHash !== storedHash) {
    return '（downgradedFromHash がレビュー対象 content と不一致）'
  }
  const afterHash = typeof review.downgradedContentHash === 'string' ? review.downgradedContentHash : ''
  if (!afterHash || afterHash !== contentHash(txt)) {
    return '（降格後に本文が変更されている＝downgradedContentHash 不一致）'
  }
  // 降格操作そのものの本文非改変を、正準逆変換で強制点側から証明する（設計レビュア確認事項(a)）。
  // 上の 2 本の hash は降格者の自己申告であり、降格の 1 手で本文を書き換えても両端は辻褄が合う。
  const restored = invertDowngrade(txt)
  if (restored === null || contentHash(restored) !== storedHash) {
    return '（降格操作で本文が改変されている＝逆変換した content がレビュー対象と不一致）'
  }
  return null
}

/**
 * 所有権モードの解決。**env 優先順位を一箇所に集約する**（本番と検証で経路を分岐させないため）。
 *
 * 優先順位（上が強い）:
 *   1. RRG_STDIN_JSON … **本番**。gate.sh が hook 入力 JSON を stdin へ流す
 *   2. RRG_TRANSCRIPT / RRG_SESSION_ID … 転写を直接指定（テスト・dry-run）
 *   3. RRG_OWNED_FILES … 所有集合を直接指定（テスト）。空文字でも「対象ゼロ」の正当な指定
 *   いずれも未定義 → null（＝所有権モード無効。**従来どおり全走査**）
 *
 * 既定を全走査に残すのは意図的である。版数スキュー（gate.sh と検出核の片方だけが古い）でも
 * 「現状のバグへ戻るだけ」で悪化しないため、安全ネットとして機能する。
 *
 * 一方、「env が定義されている」こと自体がスイッチであり、**値の解決に失敗しても全走査へは戻さない**。
 * 戻すと本 hook のバグ（他人の債務で停止不能）へ静かに退行する。解決失敗は unavailable（沈黙）へ倒す。
 */
function resolveOwnershipMode(env) {
  const hasStdin = env.RRG_STDIN_JSON !== undefined
  const hasTranscript = env.RRG_TRANSCRIPT !== undefined || env.RRG_SESSION_ID !== undefined
  const hasOwned = env.RRG_OWNED_FILES !== undefined
  if (!hasStdin && !hasTranscript && !hasOwned) return null
  const unavailable = {
    state: 'unavailable',
    owned: new Set(),
    transcriptFiles: 0,
    ownedTotal: 0,
    parseErrors: 0,
    readErrors: 0,
    limitExceeded: false,
    degraded: false
  }
  // 共有モジュール不在（版数スキュー）でも全走査へは落とさない
  if (!ownership) return unavailable
  if (hasStdin) {
    const s = ownership.readStdinJson()
    if (!s) return unavailable
    return ownership.resolveOwnership({
      transcript: s.transcript,
      sessionId: s.sessionId,
      cwd: s.cwd
    })
  }
  if (hasTranscript) {
    return ownership.resolveOwnership({
      transcript: env.RRG_TRANSCRIPT || null,
      sessionId: env.RRG_SESSION_ID || null,
      cwd: env.RRG_CWD || null
    })
  }
  return ownership.resolveOwnership({
    owned: env.RRG_OWNED_FILES.split(';').filter(Boolean),
    cwd: env.RRG_CWD || null
  })
}

/**
 * 第2パス（判定）。`owned` が Set なら**その集合に含まれる提案だけ**を判定する。
 *
 * **所有権フィルタはループ先頭（seen を消費する前）に置くこと（位置 A）。**
 * `seen.add` の後に置くと、他人のファイルが先に来た場合に rid を消費してしまい、後続の
 * **自分の**同 rid ファイルが `seen.has` で無条件 skip される ＝ 重複なりすまし防御ごと
 * silent bypass する。ここを「同じでしょ」と動かすと防御が静かに死ぬ。
 *
 * dup 判定の母集合は**全体（ridCountAll）**である。所有集合で数え直すと、他人の同 rid ファイルが
 * 母数から消えて「なりすまし免除」が確実に成功する（攻撃者は何もしないだけでよい）。
 * 全体で数える結果「他人が自分の rid を squat すると自分が止まる」が、免除の join key が
 * 実際に曖昧である以上これは正しい fail-closed である。
 */
function judgePass(scanned, ridCountAll, states, reviews, owned) {
  const blocked = []
  const seen = new Set()
  for (const item of scanned) {
    if (owned && !owned.has(item.key)) continue // ← 位置 A（seen を消費する前）
    if (seen.has(item.rid)) continue
    seen.add(item.rid)
    if ((ridCountAll.get(item.rid) || 0) > 1) {
      blocked.push(item.rid + '（request_id 重複 / 別の提案と衝突し免除の照合先が一意に定まらない）')
      continue
    }
    if (EXEMPT_STATES.has(states[item.rid])) continue // 確定バッジ（adopted/rejected）は免除
    const review = reviews[item.rid]
    const why =
      item.label === DOWNGRADE_LABEL
        ? judgeDowngraded(review, item.txt, item.fm)
        : judgeRecommend(review, item.txt)
    if (why) blocked.push(item.rid + why)
  }
  return blocked
}

/**
 * 純粋判定（構造化）。**判定は 1 回だけ実行し**、block-JSON の整形も dry-run 表示も
 * ここが返した同じ構造体から作る。二重実行すると表示と判定が乖離しうるため
 * （観測が本番を観測していない状態になる）。**argv は一切見ない**（観測と本番の非分岐）。
 *
 * 戻り値: { blocked[], blockedAll[], scannedCount, ownership, reason, fingerprint }
 *   blockedAll … 所有権フィルタ**なし**で判定した集合。telemetry の参考値。
 *                （単独ではゲート死亡の判定に使えない — 他人の債務だけが在る正常状態でも
 *                 blockedAll>0 かつ blocked===0 になるため。死亡シグナルは ownership.state を見る）
 */
function detectDetailed(env) {
  const home = os.homedir()
  const proposalsDir = env.RRG_PROPOSALS_DIR || path.join(home, '.ccpit', 'proposals')
  const statesPath = env.RRG_STATES_PATH || path.join(home, '.ccpit', 'proposal-states.json')
  const reviewsPath = env.RRG_REVIEWS_PATH || path.join(home, '.ccpit', 'proposal-reviews.json')
  const own = resolveOwnershipMode(env)
  const nil = {
    blocked: [],
    blockedAll: [],
    scannedCount: 0,
    ownership: own,
    reason: '',
    fingerprint: ''
  }

  let entries
  try {
    entries = fs.readdirSync(proposalsDir)
  } catch {
    return nil // proposals 不在 → fail-open（非 block）
  }
  const states = readJsonObject(statesPath)
  const reviews = readJsonObject(reviewsPath)
  // ストア破損（parse throw → null）は fail-open（非 block）。既レビューを未レビューと誤認した
  // 過剰 block（cry-wolf）を避ける向きに倒す。不在/空（{}）は正常系として続行する。
  if (states === null || reviews === null) return nil

  // 第1パス: 走査対象ラベルの提案を集める（本文も保持する — hash 照合に要る）。
  // **所有権で絞らない。** ここで絞ると他人の同 rid ファイルが ridCount から消え、
  // なりすまし免除が確実に成功する（judgePass のコメント参照）。
  const scanned = []
  const ridCountAll = new Map()
  for (const name of entries) {
    if (!/\.md$/i.test(name)) continue
    const full = path.join(proposalsDir, name)
    let txt
    try {
      txt = fs.readFileSync(full, 'utf8')
    } catch {
      continue
    }
    const fm = frontmatter(txt)
    if (!fm) continue
    const label = fmField(fm, 'adoption_label')
    if (!SCANNED_LABELS.has(label)) continue
    const rid = fmField(fm, 'request_id')
    if (!rid) continue
    // 所有権集合と突合するキー。両側に必ず同じ正準化を通す。
    const key = ownership ? ownership.normPath(full, null) : null
    scanned.push({ rid, label, txt, fm, file: full, key })
    ridCountAll.set(rid, (ridCountAll.get(rid) || 0) + 1)
  }

  const blockedAll = judgePass(scanned, ridCountAll, states, reviews, null)
  const blocked = own ? judgePass(scanned, ridCountAll, states, reviews, own.owned) : blockedAll

  if (blocked.length === 0) {
    return { blocked, blockedAll, scannedCount: scanned.length, ownership: own, reason: '', fingerprint: '' }
  }
  const listed =
    blocked.slice(0, MAX_LISTED).join(', ') +
    (blocked.length > MAX_LISTED ? ' ほか計 ' + blocked.length + ' 件' : '')
  const scopeNote = own
    ? '本ゲートは**自セッションが Write / Edit した提案のみ**を対象とします' +
      '（他セッション由来のレビュー債務は本 hook では止めません。採用ゲートが hash 束縛で担保します）。' +
      '全件は node ~/.claude/hooks/recommend-review-detect.cjs --dry-run --all で確認できます。'
    : ''
  const reason =
    'レビュー債務の残る提案が ' +
    blocked.length +
    ' 件あります（' +
    listed +
    '）。独立レビュー（codex 等 / proposal-review-backlog-sweep）を経て、指摘を受けた提案は次の三択のいずれかまで進めてください: ' +
    '(a) findings を改稿反映して再レビューし approve を得る / (b) 棄却して rejected にする / ' +
    '(c) recommend-with-findings へ明示降格する（台帳の downgradedTo・downgradedAt・downgradedFromHash・' +
    'downgradedContentHash と、提案 frontmatter の adoption_label・downgraded_at を双方そろえる）。' +
    'ccRebuttal の記載だけでは解除になりません（実改稿 or 明示降格が必要）。' +
    '免除は adopted/rejected（確定バッジ）と、有効起点 ' +
    A1_EPOCH_ISO +
    ' より前に記録された既存レビューのみです（held は保留＝レビュー未証明のため免除しません）。' +
    scopeNote +
    '抑制は ~/.ccpit/app-config.json の "recommendReviewMode"' +
    '（soft=セッション1回 / strict=毎ターン / off=無効。未設定時は "emissionMode" にフォールバック、既定 soft）。'
  // 集合の安定 fingerprint。gate.sh の soft sentinel をこれでキーし、
  // 初回リマインド後に対象が増えた（集合が変わった）ら再 block させる。
  const fingerprint = crypto
    .createHash('sha1')
    .update(blocked.slice().sort().join(','))
    .digest('hex')
    .slice(0, 12)
  return { blocked, blockedAll, scannedCount: scanned.length, ownership: own, reason, fingerprint }
}

/** 純粋判定。停止を止めるべき提案が在れば block-JSON 文字列を、無ければ '' を返す。 */
function detect(env) {
  const d = detectDetailed(env)
  if (d.blocked.length === 0) return ''
  return JSON.stringify(
    { decision: 'block', reason: d.reason, fingerprint: d.fingerprint },
    null,
    2
  )
}

/**
 * 観測ログ。**ゲートが静かに死んでいないか**を後から確認するための唯一の自動経路。
 * stderr は gate.sh が 2>/dev/null で捨てるため観測点にならない（無効な安心材料）。
 *
 * 死亡シグナルは `blockedAll > 0 && blocked === 0` **ではない** — 他人の債務だけが在る状態は
 * 本フィルタ導入後の**正常な定常状態**であり、それを死亡と判定すると誤報になる。
 * 実際の死亡シグナルは `ownershipState !== "active"` の継続、または active かつ
 * `ownedTotal === 0` の継続（稼働セッションは通常 1 件以上ファイルを書く）。
 */
function writeTelemetry(env, d) {
  try {
    const dir =
      env.RRG_GATE_DIR || path.join(os.homedir(), '.ccpit', '.recommend-review-gate')
    const file = path.join(dir, 'telemetry.jsonl')
    const MAX_TELEMETRY_BYTES = 1024 * 1024
    fs.mkdirSync(dir, { recursive: true })
    try {
      if (fs.statSync(file).size > MAX_TELEMETRY_BYTES) fs.rmSync(file, { force: true })
    } catch {
      /* 未作成なら何もしない */
    }
    const o = d.ownership
    const rec = {
      ts: new Date().toISOString(),
      ownershipState: o ? o.state : 'disabled',
      transcriptFiles: o ? o.transcriptFiles : 0,
      ownedTotal: o ? o.ownedTotal : 0,
      parseErrors: o ? o.parseErrors : 0,
      readErrors: o ? o.readErrors || 0 : 0,
      limitExceeded: o ? o.limitExceeded : false,
      degraded: o ? !!o.degraded : false,
      scanned: d.scannedCount,
      blocked: d.blocked.length,
      blockedAll: d.blockedAll.length
    }
    fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8')
  } catch {
    /* 観測は本判定を邪魔しない（全面 fail-open） */
  }
}

if (require.main === module) {
  // **argv はここでだけ読む。** detectDetailed に argv を渡すと観測と本番が分岐する。
  const dryRun = process.argv.includes('--dry-run')
  const showAll = process.argv.includes('--all')
  try {
    if (dryRun) {
      const env = Object.assign({}, process.env)
      // --all は所有権 env を外して「全件ならどう見えるか」を出す（本番判定は変えない）
      if (showAll) {
        delete env.RRG_STDIN_JSON
        delete env.RRG_TRANSCRIPT
        delete env.RRG_SESSION_ID
        delete env.RRG_OWNED_FILES
      }
      const d = detectDetailed(env)
      const o = d.ownership
      process.stdout.write(
        (o
          ? '[所有権モード] state=' +
            o.state +
            ' 転写ファイル=' +
            o.transcriptFiles +
            ' 編集ファイル総数=' +
            o.ownedTotal +
            ' parseErrors=' +
            o.parseErrors +
            ' limitExceeded=' +
            o.limitExceeded
          : '[従来モード] 全走査（所有権 env 未指定）') + '\n'
      )
      process.stdout.write(
        '走査対象=' + d.scannedCount + ' / block=' + d.blocked.length + ' / 所有権無し換算=' + d.blockedAll.length + '\n'
      )
      for (const b of d.blocked) process.stdout.write('  - ' + b + '\n')
      process.exit(0)
    }
    const d = detectDetailed(process.env)
    writeTelemetry(process.env, d)
    if (d.blocked.length > 0) {
      process.stdout.write(
        JSON.stringify({ decision: 'block', reason: d.reason, fingerprint: d.fingerprint }, null, 2) + '\n'
      )
    }
  } catch {
    // fail-open: 判定不能は非 block（cry-wolf 回避）
  }
  process.exit(0)
}

module.exports = {
  detect,
  detectDetailed,
  resolveOwnershipMode,
  frontmatter,
  fmField,
  readJsonObject,
  contentHash,
  invertDowngrade,
  extractFindingIds,
  isSubstantiveReason,
  judgeHarvest,
  A1_EPOCH_ISO,
  DOWNGRADE_LABEL,
  DECISION_REJECTED,
  DECISION_DEFERRED,
  MIN_ADJUDICATION_REASON_CHARS,
  MIN_ADJUDICATION_REASON_UNIQUE_CHARS
}
