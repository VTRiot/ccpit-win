#!/usr/bin/env node
/**
 * 独立レビュー結果を**レビュー台帳へ保存する唯一の経路**。
 *
 * 設計正本: `_Prompt/02_buildai/20260825_1105_review-ledger-write-chokepoint_dev_log.md` §2-3。
 * 姉妹実装: `proposal-comment-respond.cjs`（コメント側の同型チョークポイント）。
 *
 * ## なぜ要るのか（2026-08-25 の実事故）
 * 台帳 `~/.ccpit/proposal-reviews.json` には正規の書込経路が無く、各 CC が 3 つの skill に
 * 散った散文から手書き JSON を組んでいた。結果、`adjudications[].id` を JSON 数値で書いた
 * エントリが生まれ、canonical decimal string を要求する読み側（アプリ正本 `evaluateHarvest` と
 * Stop hook 検出核 `judgeHarvest`）の**両方**が「裁定の形式が不正」を返した。
 * 裁定は実質的な理由文つきで 3 件とも書かれていたのに、システムからは「1 件も無い」と
 * 評価され、ユーザーは「裁定を記録して」と指示する手数を払わされた。
 *
 * 真因は「読み側は fail-closed で厳格、書き側は無検証」という非対称である。
 * 本スクリプトはその非対称を消す: **書込直前に読み側と同じ述語を通し、ok でなければ書かない。**
 * これにより「書けた ＝ ゲートを通る」が保証される。
 *
 * ## 呼び手に自己申告させない（本スクリプトの核心）
 * `proposal_hash` と `adjudicationsFor` は **引数で受け取らない**。前者は request_id から
 * 提案 MD を引き当てて実測し、後者は記録する findings から計算する。呼び手が値を持てると
 * 「承認されていない版に承認を貼る」捏造の余地が生まれるため、構造的に持たせない。
 *
 * ## 所在（配布）
 * 配布正本は golden/common/scripts/（golden deploy で ~/.claude/scripts/ へ配置される。skill 本文は
 * 配備先を `node ~/.claude/scripts/proposal-review-record.cjs` で指す）。検出核は隣接の hooks/ から解決する
 * （`loadDetector`）。回帰テストは配布対象外のため scripts/proposal-review-record.test.cjs に置く。
 *
 * ## 使い方
 *   node proposal-review-record.cjs --request-id <id> --batch-file <json>
 *   node proposal-review-record.cjs --request-id <id> --batch-file <json> --dry-run
 *     ↑ 書込を一切行わず、実際の書込経路と**同一の検査ロジック**（findings/adjudications 検査 →
 *       提案 MD 実測 → 既存台帳とのマージ → judgeHarvest）を通して結果を先読みする。
 *       検査だけの別実装ではなく、書込直前の分岐でしか lock/write に進まないだけなので、
 *       dry-run が通ったのに本番が弾かれる、という乖離が構造的に起きない。
 *   node proposal-review-record.cjs --check-contract
 *     ↑ 呼び手（skill 側）の実行前検証。書込はしない。検出核を実際に解決し、
 *       書込前検査に使う述語関数の実在と §5 転記の往復（生成→挿入→再パース）を
 *       実行で確かめた場合にのみ契約行を出力して exit 0。
 *
 * ## 明示降格（recommend-with-findings）の記録
 *   node proposal-review-record.cjs --request-id <id> --batch-file <降格 json> [--dry-run]
 *   node proposal-review-record.cjs --check-downgrade-contract
 * 降格 batch は `{ "downgrade": { "to": "recommend-with-findings", "reason": "<実質的な理由>" } }` だけ。
 * トップレベルに `downgrade` キーが在れば降格モード、無ければ通常記録（キーは衝突しない）。
 * **先に通常の batch でレビュー（全指摘に終端裁定）を記録してから**降格する。降格の 4 つの台帳キー
 * （downgradedTo / downgradedAt / downgradedFromHash / downgradedContentHash）は呼び手から受け取らず、
 * 時刻は実測・2 つの hash は提案 MD から導出する。未降格の提案は本スクリプトが frontmatter へ降格マーカーを
 * 追記する（S0）。降格済みの提案は書き換えず台帳だけを整合させる（S1・`reason` は渡せない）。
 * 台帳のレビューがこの本文を対象にしていること（proposal_hash が降格前 or 現本文と一致）を前提に要求し、
 * 書く前に検出核の実関数を一時領域で通す。降格後に再レビューを通常記録したら、降格 batch をもう一度流す。
 *
 * ## §5 自動転記（v2）
 * 台帳への書込と同時に、提案 MD の「## 5. レビューボックス」を台帳内容から**自動で書き直す**。
 * 手で転記させると (a) 転記漏れで §5 が pending のまま残る、(b) 転記の後に proposal_hash を
 * 記録し直し忘れて承認が stale 化する、の 2 事故が起きる（2026-08-09 embed-fix で実発生）。
 * 順序が本質: **§5 を転記した後の本文**に対して proposal_hash を実測してから台帳へ書く。
 * §5 見出しが無い/複数ある提案は fail closed（書式契約 C1 を満たしてから来ること）。
 * 転記内容は batch 入力から決定的に導出する（時刻を含めない）ので、同一 batch での再実行は
 * 同一本文・同一 hash に収束する（中断からの復旧 = 再実行）。
 *
 * batch JSON:
 * {
 *   "verdict": "approve" | "needs-attention" | ...,
 *   "findings": "<[n] 連番を含むレビュー本文。読者の言語（既定: 日本語）>",
 *   "findingsOriginal": "<レビュアが別言語で返した場合の原文（任意）>",
 *   "reviewerId": "codex-independent",
 *   "ccRebuttal": "<レビューの経緯・反論（任意）>",
 *   "reviewRounds": 4,
 *   "adjudications": [ { "id": "1", "decision": "rejected"|"deferred", "reason": "..." } ]
 * }
 */
'use strict'
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')

const HOME = os.homedir()
/**
 * 経路は env で差し替えられる。**本番と検証で判定を分岐させない**ための注入点であり、
 * 検出核 `recommend-review-detect.cjs` の `RRG_*` と同じ思想（テストは実体を隔離 fixture で回す）。
 * 未指定なら実配置を使う。
 */
const LEDGER = process.env.PRR_LEDGER || path.join(HOME, '.ccpit', 'proposal-reviews.json')
const PROPOSALS = process.env.PRR_PROPOSALS || path.join(HOME, '.ccpit', 'proposals')
const LOCK = `${LEDGER}.lock`

/** 裁定の終端はこの 2 つだけ。`fixed` は存在しない（直したなら再レビューへ戻る）。 */
const TERMINAL_DECISIONS = new Set(['rejected', 'deferred'])
/** 裁定 id は canonical decimal string のみ。先頭ゼロ・空白付き・数値型は fail closed。 */
const CANONICAL_ID_RE = /^(0|[1-9][0-9]*)$/
/** 裁定理由・findings の実質性フロア（読み側 `isSubstantiveReason` と同じ思想）。 */
const MIN_REASON_CHARS = 30
const MIN_REASON_UNIQUE = 15
/** ひらがな・カタカナ・CJK 統合漢字。読者言語（日本語）判定に使う。 */
const CJK_RE = /[぀-ヿ㐀-䶿一-鿿]/

/**
 * `--check-contract` が名乗る契約 id。呼び手 skill はこの行の実出力を期待値として照合する。
 * 文字列 grep と違い、検出核の解決と述語関数の実在を**実行して確かめた後**にしか出力されないため、
 * 「コメントに語が在るだけで成立」する偽陽性が無い。CLI・述語・入力 schema を変える時は
 * 版数を上げ、呼び手側（skill 本文）を追従させること。
 */
const CONTRACT_ID = 'PRR_CONTRACT v2'
/**
 * 降格モード（batch JSON の `downgrade` キー）の契約 id。`--check-contract` の出力（v2）は既存の呼び手が
 * 照合しているため変えず、降格に要る述語と導出の往復は `--check-downgrade-contract` が別に名乗る。
 * 降格モードを使う呼び手は、実行前にこの行の実出力を確認すること。
 */
const DOWNGRADE_CONTRACT_ID = 'PRR_DOWNGRADE_CONTRACT v1'

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex')

/**
 * 失敗は throw で伝搬させ、最上位で `[NG]` を出して exit 1 する。
 * 検査中に `process.exit` を直接呼ぶと finally が走らず、lock/tmp が残留するため。
 */
class FailError extends Error {}
function fail(msg) {
  throw new FailError(msg)
}

/**
 * 検出核の解決。**隣接の hooks/ を最優先**する — 本スクリプトの所在は配布正本 golden/common/scripts/ と
 * 配備先 ~/.claude/scripts/ の 2 つで、どちらでも `../hooks/recommend-review-detect.cjs` が
 * 同じ配布物の検出核を指す（正本では配布正本と同一実体、配備先では配置済み実体）。
 * 無ければ配備先の絶対パスへフォールバック。どちらも無ければ落とす —
 * 「検査できないから素通しする」は本スクリプトの存在理由に反する。
 */
function loadDetector() {
  const candidates = [
    path.join(__dirname, '..', 'hooks', 'recommend-review-detect.cjs'),
    path.join(HOME, '.claude', 'hooks', 'recommend-review-detect.cjs')
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return { mod: require(p), from: p }
    }
  }
  fail(`検出核が見つかりません（検査できないので書きません）:\n  ${candidates.join('\n  ')}`)
}

/**
 * frontmatter の request_id で提案 MD を引き当てる（`proposal-comment-respond.cjs` と同一規則）。
 * 0 件でも**複数でも** fail closed — 複数一致を先勝ちで拾うと `fs.readdirSync` の順序依存で
 * proposal_hash の対象が揺れ、台帳キーと実際に検査した本文の対応が曖昧になるため。
 */
function findProposal(requestId) {
  if (!fs.existsSync(PROPOSALS)) fail(`提案プールがありません: ${PROPOSALS}`)
  const hits = []
  for (const f of fs.readdirSync(PROPOSALS)) {
    if (!f.endsWith('.md')) continue
    const p = path.join(PROPOSALS, f)
    const raw = fs.readFileSync(p, 'utf8')
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!m) continue
    const line = m[1].split(/\r?\n/).find((l) => /^request_id:\s*/.test(l))
    if (line && line.replace(/^request_id:\s*/, '').trim() === requestId) hits.push({ path: p, raw })
  }
  if (hits.length === 0) fail(`提案 MD が見つかりません: ${requestId}`)
  if (hits.length > 1) {
    fail(
      `同一 request_id の提案 MD が複数あります（どれが正か判定できないので書きません）: ${requestId}\n  ` +
        hits.map((h) => h.path).join('\n  ')
    )
  }
  return hits[0]
}

function isSubstantive(s) {
  if (typeof s !== 'string') return false
  const t = s.trim()
  if (t.length < MIN_REASON_CHARS) return false
  const dense = t.replace(/\s+/g, '')
  if (dense.length < MIN_REASON_CHARS) return false
  return new Set(dense).size >= MIN_REASON_UNIQUE
}

function valueOf(args, name) {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null
}

// --- §5 自動転記（v2） ---------------------------------------------------------
/**
 * §5 見出し。読み側（skillProposals.ts の findValue パース）は `## 5. レビューボックス`
 * 配下の `- key: value` 単行リストを読む。テンプレ揺れ（`##★5.`）も 1 件なら受ける。
 */
const SECTION5_HEAD_RE = /^## ?★?5\. ?レビューボックス[ \t]*$/gm

/**
 * フェンスで囲んだコードブロック（CommonMark: 行頭の空白 0〜3 個＋同じ文字 3 個以上の ``` か ~~~。
 * 閉じは同じ文字で開きと同じ数以上・後ろは空白だけ。閉じが無ければ文書の終わりまで）の中身と
 * フェンスの行を、同じ長さの空白に置き換えた文字列を返す。改行は残すので、位置は元の文字列と一致する。
 * 読み側（CCPIT の skillProposals.ts の maskFencedCodeBlocks）と同じ規則。
 *
 * §5 の見出しと節の終わりは、この文字列の上で探す。提案の「## 3.」には SKILL.md の全文が入り、
 * skill-proposal-emitter のように提案の書式の見本（「## 5. レビューボックス」）を本文に持つスキルもある。
 * 2026-09-28 069 M3: 以前はコードブロックの中の見本も見出しに数え、「§5 見出しが複数あります」で
 * 記録できなかった（コードブロックの中の `## ` で節を切ることもあった）。
 */
function maskFencedCodeBlocks(text) {
  const lines = text.split('\n')
  let fenceChar = ''
  let fenceLen = 0
  const out = []
  for (const line of lines) {
    const cr = line.endsWith('\r') ? '\r' : ''
    const content = cr ? line.slice(0, -1) : line
    const blank = ' '.repeat(content.length) + cr
    if (!fenceChar) {
      const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(content)
      // バッククォートのフェンスの情報文字列にはバッククォートを含めない（CommonMark）
      if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
        fenceChar = open[1][0]
        fenceLen = open[1].length
        out.push(blank)
        continue
      }
      out.push(line)
      continue
    }
    const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(content)
    out.push(blank)
    if (close && close[1][0] === fenceChar && close[1].length >= fenceLen) {
      fenceChar = ''
      fenceLen = 0
    }
  }
  return out.join('\n')
}

/** §5 の各値は**単行**でなければ読み側が拾えない。改行・連続空白を潰し、上限で切る。 */
function collapseLine(s, cap) {
  const t = String(s || '')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > cap ? `${t.slice(0, cap - 1)}…` : t
}

/**
 * 台帳へ書く entry から §5 本文を**決定的に**組む（時刻・hash を含めない）。
 * - hash 類を書かないのは自己参照回避（§5 に hash を書く → 本文が変わる → hash が変わる）。
 * - 件数は batch の adjudications から導出する。judgeHarvest の結果を使うと
 *   「hash 実測 → 検査」の順序と循環するため、ここでは入力から数える。
 */
function buildSection5(entry, counts) {
  const findingsLine =
    counts.findingCount > 0
      ? `${collapseLine(entry.findings, 300)}（指摘 ${counts.findingCount} 件: 棄却 ${counts.rejected} / 据置 ${counts.deferred}）`
      : collapseLine(entry.findings, 300)
  return [
    `- review_verdict: ${entry.verdict}`,
    `- findings: ${findingsLine}`,
    `- reviewer_id: ${entry.reviewerId}`,
    `- cc_rebuttal: ${entry.ccRebuttal ? collapseLine(entry.ccRebuttal, 300) : 'なし'}`,
    '- note: 正本は台帳（proposal-reviews.json）。本欄は record スクリプトの自動転記で、hash 値は台帳側のみに保持する（本ファイルに書くと自己参照で必ず不一致になるため記載しない）。proposal_hash は本転記後の本文で実測済み。'
  ].join('\n')
}

/**
 * 提案 MD の §5 セクション本文を差し替えた新本文を返す。fail closed:
 * 見出しが 0 件（書式契約 C1 違反）でも複数件（どれが正か不明）でも書かない。
 * セクション範囲は次の `## ` 見出しまで（無ければ EOF まで）。
 * 見出しも節の終わりも、コードブロックの外だけから探す（maskFencedCodeBlocks・位置は raw と一致）。
 */
function transcribeSection5(raw, body) {
  const masked = maskFencedCodeBlocks(raw)
  const heads = [...masked.matchAll(SECTION5_HEAD_RE)]
  if (heads.length === 0) {
    fail(
      '提案 MD に「## 5. レビューボックス」が見つかりません（§5 転記先なし）。\n' +
        '  書式契約 C1 の §5 見出しを提案 MD に用意してから記録してください。'
    )
  }
  if (heads.length > 1) fail('提案 MD に §5 見出しが複数あります（どれが正か判定できないので書きません）')
  const h = heads[0]
  // 改行は元の文書に合わせる（CRLF の文書に LF を混ぜない）。見出しの正規表現の `$` は `\r` の前で一致するので、
  // CRLF の見出しの行の `\r` はここで消費する（069 M3 で、CRLF の提案の書き直しが改行を混ぜていたのを直した）
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  let bodyStart = h.index + h[0].length
  if (raw[bodyStart] === '\r') bodyStart += 1
  const rest = raw.slice(bodyStart)
  const next = masked.slice(bodyStart).search(/\r?\n## /)
  const tail = next >= 0 ? rest.slice(next) : eol
  const bodyText = body.replace(/\r?\n/g, eol)
  return `${raw.slice(0, h.index)}${h[0]}${eol}${eol}${bodyText}${eol}${tail.startsWith('\n') || tail.startsWith('\r') ? tail : `${eol}${tail}`}`
}

// --- 明示降格（recommend-with-findings）の書込（batch JSON のキー `downgrade`） -------------------
/**
 * 降格モードが受け付ける batch JSON のキー。**これ以外は全て落とす**（新モードなので寛容にする理由が無い）。
 * 4 つの台帳キー（downgradedTo / downgradedAt / downgradedFromHash / downgradedContentHash）は
 * 呼び手から受け取らない — 時刻は実測、2 つの hash は提案 MD から導出する（未レビューの本文へ
 * 降格を貼る捏造の余地を作らない。`proposal_hash` を呼び手に持たせないのと同じ設計）。
 */
const DOWNGRADE_SELF_DECLARED = ['downgradedTo', 'downgradedAt', 'downgradedFromHash', 'downgradedContentHash']
const REVIEW_BATCH_KEYS = [
  'verdict',
  'findings',
  'findingsOriginal',
  'reviewerId',
  'ccRebuttal',
  'reviewRounds',
  'adjudications',
  'kind'
]
const DOWNGRADE_INNER_KEYS = ['to', 'reason']
/** 降格 frontmatter の理由の上限（単行化して切る）。 */
const DOWNGRADE_REASON_CAP = 400

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** batch JSON を検査する（書込・I/O なし）。降格モードの入力契約はここで全て決まる。 */
function validateDowngradeSpec(spec, label) {
  if (!isPlainObject(spec.downgrade)) fail('downgrade はオブジェクトでなければなりません（例: {"to":"recommend-with-findings","reason":"…"}）')
  const selfDeclared = DOWNGRADE_SELF_DECLARED.filter((k) => k in spec)
  if (selfDeclared.length) {
    fail(
      `${selfDeclared.join(' / ')} は受け付けません。この値は本スクリプトが実測・導出します（自己申告させない設計）`
    )
  }
  const mixed = REVIEW_BATCH_KEYS.filter((k) => k in spec)
  if (mixed.length) {
    fail(
      `降格 batch にレビュー内容（${mixed.join(' / ')}）を混ぜられません。\n` +
        '  レビュー内容は先に通常の batch（--request-id/--batch-file）で記録してから、降格 batch を別に渡してください。'
    )
  }
  const extraTop = Object.keys(spec).filter((k) => k !== 'downgrade')
  if (extraTop.length) fail(`降格 batch は downgrade キーだけを受け付けます。余分なキー: ${extraTop.join(' / ')}`)
  const extraInner = Object.keys(spec.downgrade).filter((k) => !DOWNGRADE_INNER_KEYS.includes(k))
  if (extraInner.length) {
    fail(
      `downgrade の中で受け付けるのは ${DOWNGRADE_INNER_KEYS.join(' / ')} だけです。余分なキー: ${extraInner.join(' / ')}\n` +
        '  降格時刻と 2 つの hash は本スクリプトが実測・導出します（自己申告させない設計）'
    )
  }
  if (spec.downgrade.to !== label) {
    fail(`downgrade.to は ${label} でなければなりません（実際: ${JSON.stringify(spec.downgrade.to)}）`)
  }
  if ('reason' in spec.downgrade) {
    const reason = spec.downgrade.reason
    if (typeof reason !== 'string') fail('downgrade.reason は文字列でなければなりません')
    // 理由は提案の frontmatter の 1 行へ**そのまま**書く。黙って畳む・切る・エスケープする代わりに、
    // 元どおり保存できない理由は明示的に拒否する（保存値と入力値が食い違う記録を作らない）。
    if (/[\r\n\u0085\u2028\u2029]/.test(reason)) fail('downgrade.reason は 1 行でなければなりません（改行を含めないでください）')
    if (reason.length > DOWNGRADE_REASON_CAP) {
      fail(`downgrade.reason が長すぎます（${reason.length} 文字 > 上限 ${DOWNGRADE_REASON_CAP}）。要点に絞ってください`)
    }
    if (reason !== reason.trim()) fail('downgrade.reason の先頭・末尾に空白を含めないでください')
    if (/["\\#]/.test(reason)) {
      fail(
        'downgrade.reason に二重引用符（"）・バックスラッシュ（\\）・シャープ（#）は使えません' +
          '（読み側は行内の # 以降を注釈として捨てるため、frontmatter へ元どおり保存・復元できません）'
      )
    }
  }
}

/**
 * 降格の状態判定と最終エントリの導出（**純粋**・I/O なし）。
 *
 * S0（未降格）: `adoption_label: recommend` でマーカー行が無い → frontmatter へ降格マーカーを追記した本文を組む。
 * S1（降格済み）: `adoption_label: recommend-with-findings` ＋ `downgraded_at` 有り → 本文は書かない。
 * それ以外は fail（他の label・マーカーが片側だけ・重複 等）。
 *
 * 捏造防止の核は 2 つ:
 *   1. 2 つの hash は**この関数が提案本文から導出する**（呼び手からは何も受け取らない）
 *   2. 台帳の既存 `proposal_hash` が降格前 content（fromHash）か現本文（curHash・マーカー付きの現ファイルに
 *      対して通常記録された型）と一致していること＝レビューが**この本文**を対象にしていること。
 *      逆変換はマーカー行と label しか動かさないので、curHash 型でも本文はレビューされた内容のままである。
 */
function planDowngrade({ raw, prev, spec, detect, now }) {
  const label = detect.DOWNGRADE_LABEL
  if (!prev) fail('台帳にレビュー記録がありません。先に通常の batch でレビューを記録してください')
  if (!isSubstantive(prev.findings)) {
    fail('台帳の findings が実質的でないため降格しません（降格の対象となるレビューの実体がありません）')
  }
  const fm = detect.frontmatter(raw)
  if (!fm) fail('提案 MD の frontmatter を解析できません')
  const count = (re) => (fm.match(re) || []).length
  const nAt = count(/^downgraded_at:/gm)
  const nReason = count(/^downgrade_reason:/gm)
  const nLabel = count(/^adoption_label:/gm)
  const curLabel = detect.fmField(fm, 'adoption_label')

  // adoption_label の行は**ちょうど 1 件**（重複は、先頭だけを読む検出核と後勝ちのパーサで解釈が割れる）
  let state
  if (nLabel === 1 && curLabel === 'recommend' && nAt === 0 && nReason === 0) {
    state = 'S0'
  } else if (nLabel === 1 && curLabel === label && nAt === 1 && nReason <= 1 && detect.fmField(fm, 'downgraded_at') !== '') {
    state = 'S1'
  } else {
    fail(
      '提案の降格の状態が想定外です（S0＝`adoption_label: recommend` 1 件でマーカー無し／' +
        `S1＝\`adoption_label: ${label}\` 1 件 ＋ downgraded_at 1 件、のどちらでもありません）。\n` +
        `  adoption_label=${JSON.stringify(curLabel)}（${nLabel} 件） downgraded_at=${nAt} 件 downgrade_reason=${nReason} 件\n` +
        '  提案の frontmatter を確認してください（片側だけのマーカー・重複は自動では直しません）。'
    )
  }

  let unmarked
  let stamped
  let at
  if (state === 'S0') {
    if (typeof spec.downgrade.reason !== 'string' || !isSubstantive(spec.downgrade.reason)) {
      fail('この提案は未降格です。downgrade.reason（実質的な理由）が必須です（frontmatter の downgrade_reason へ書きます）')
    }
    at = now
    const re = /^(adoption_label:[ \t]*)recommend[ \t]*(\r?)$/m
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!re.test(m[0])) {
      fail(
        'adoption_label の行が canonical 表記（`adoption_label: recommend` ちょうど 1 行・引用符とコメント無し）ではないため、' +
          '可逆に降格マーカーを書けません。提案の frontmatter を直してから再実行してください。'
      )
    }
    // 入力は validateDowngradeSpec が「1 行・上限内・前後空白なし・`"` `\` `#` なし」に限っている（読み側は行内の
    // # 以降を注釈として捨てる）。先頭が記号・末尾が `'` のときだけ二重引用符で包む（読み側が引用符・記号を
    // 解釈する位置を避ける。包みは外して読まれる）。`: ` は両方の読み方が最初のコロンで分けるので包み不要。
    const reason = spec.downgrade.reason
    const reasonLine = /^['[\]{}&*!|>%@`-]|'$/.test(reason) ? `"${reason}"` : reason
    const newFm = m[0].replace(
      re,
      (_all, p, cr) =>
        `${p}${label}${cr}\ndowngraded_at: ${at}${cr}\ndowngrade_reason: ${reasonLine}${cr}`
    )
    stamped = newFm + raw.slice(m[0].length)
    unmarked = raw
    // 書く前の可逆性検査: 読み側と同じ正準逆変換で、元の本文にバイト単位で戻ること
    if (detect.invertDowngrade(stamped) !== raw) {
      fail('降格マーカーを追記した本文が、読み側の逆変換で元の本文に戻りません（書きません）。frontmatter の表記を確認してください。')
    }
  } else {
    if ('reason' in spec.downgrade) {
      fail(
        'この提案は既に降格済みです。downgrade.reason は渡せません（降格の理由は提案 frontmatter の downgrade_reason が正です）。'
      )
    }
    at = detect.fmField(fm, 'downgraded_at')
    if (Number.isNaN(Date.parse(at))) fail(`提案 frontmatter の downgraded_at が日時として解析できません: ${JSON.stringify(at)}`)
    stamped = raw
    unmarked = detect.invertDowngrade(raw)
    const ufm = unmarked === null ? '' : detect.frontmatter(unmarked)
    if (
      unmarked === null ||
      detect.fmField(ufm, 'adoption_label') !== 'recommend' ||
      /^downgraded_at:/m.test(ufm) ||
      /^downgrade_reason:/m.test(ufm)
    ) {
      fail('降格済みの提案ですが、読み側の逆変換で降格前の姿（adoption_label: recommend・マーカー無し）に戻りません。frontmatter を確認してください。')
    }
  }

  const fromHash = sha256(unmarked)
  const curHash = sha256(stamped)
  const stored = typeof prev.proposal_hash === 'string' ? prev.proposal_hash : ''
  if (stored !== fromHash && stored !== curHash) {
    fail(
      '台帳のレビューがこの提案の本文を対象にしていません（レビューの後に本文が変わっています）。\n' +
        `  台帳 proposal_hash : ${stored || '(無し)'}\n` +
        `  降格前の本文 hash  : ${fromHash}\n` +
        `  現本文 hash        : ${curHash}\n` +
        '  先に現本文に対するレビューを通常の batch で記録し直してから降格してください。'
    )
  }
  const final = {
    ...prev,
    proposal_hash: fromHash,
    downgradedTo: label,
    downgradedAt: at,
    downgradedFromHash: fromHash,
    downgradedContentHash: curHash
  }
  const consistent =
    state === 'S1' &&
    ['proposal_hash', 'downgradedTo', 'downgradedAt', 'downgradedFromHash', 'downgradedContentHash'].every(
      (k) => prev[k] === final[k]
    )
  return { state, stamped, unmarked, at, fromHash, curHash, final, consistent }
}

/**
 * 検出核の実関数（`detectDetailed`＝非公開の `judgeDowngraded` を含む）を、**一時ディレクトリ**に置いた
 * 「書き換え後の提案 1 件＋最終エントリだけの台帳」に対して実行する（書込前検査）。
 * 実データには触れない。state は必ず新規の空 `{}`（adopted/rejected の免除で素通りさせない）、
 * env は 3 経路だけの新規オブジェクト（所有権 env・実配置を持ち込まない）。
 * 戻り値: { blockedAll, scannedCount }。1 件ちょうど走査され、block 対象が空であること。
 */
function stagedDetectorCheck(detect, requestId, stampedRaw, finalEntry) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prr-dg-'))
  try {
    const proposals = path.join(dir, 'proposals')
    fs.mkdirSync(proposals)
    fs.writeFileSync(path.join(proposals, 'staged.md'), stampedRaw, 'utf8')
    const reviews = path.join(dir, 'reviews.json')
    fs.writeFileSync(reviews, JSON.stringify({ [requestId]: finalEntry }), 'utf8')
    const states = path.join(dir, 'states.json')
    fs.writeFileSync(states, '{}', 'utf8')
    const d = detect.detectDetailed({
      RRG_PROPOSALS_DIR: proposals,
      RRG_REVIEWS_PATH: reviews,
      RRG_STATES_PATH: states
    })
    return { blockedAll: d.blockedAll, scannedCount: d.scannedCount }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** 降格モードの述語の実在確認（なければ検査できないので書かない）。 */
function requireDowngradePredicates(detect, detectFrom) {
  for (const fn of ['contentHash', 'invertDowngrade', 'judgeHarvest', 'detectDetailed', 'frontmatter', 'fmField']) {
    if (typeof detect[fn] !== 'function') {
      fail(`検出核に述語 ${fn} がありません（別実装/旧版の可能性。降格は検査できないので書きません）: ${detectFrom}`)
    }
  }
  if (typeof detect.DOWNGRADE_LABEL !== 'string' || !detect.DOWNGRADE_LABEL) {
    fail(`検出核に定数 DOWNGRADE_LABEL がありません（別実装/旧版の可能性）: ${detectFrom}`)
  }
}

function runDowngrade(requestId, spec, detect, detectFrom, dryRun) {
  requireDowngradePredicates(detect, detectFrom)
  validateDowngradeSpec(spec, detect.DOWNGRADE_LABEL)

  let lockFd = null
  if (!dryRun) {
    try {
      lockFd = fs.openSync(LOCK, 'wx')
    } catch {
      fail(`lockfile が既に在ります（他ライタが書込中の可能性）: ${LOCK}`)
    }
  }
  const tmp = `${LEDGER}.tmp`
  let mdTmp = null
  try {
    const prop = findProposal(requestId)
    const origHash = sha256(prop.raw)
    const raw1 = fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, 'utf8') : '{}'
    const h1 = sha256(raw1)
    let ledger
    try {
      ledger = JSON.parse(raw1)
    } catch {
      fail(`台帳が読めません（不正な JSON）: ${LEDGER}`)
    }
    const plan = planDowngrade({ raw: prop.raw, prev: ledger[requestId], spec, detect, now: new Date().toISOString() })
    const { state, stamped, final } = plan

    // --- 書込前検査（読み側と同じ述語を、書く最終形に通す。「書けた＝ゲートを通る」保証） ---
    const harvest = detect.judgeHarvest(final, stamped)
    if (!harvest.ok) {
      fail(
        `${dryRun ? '[dry-run] ' : ''}刈り取り判定を通らないため降格を書き込みません: ${harvest.reason}\n` +
          `  検出核: ${detectFrom}\n` +
          '  降格は全指摘に終端裁定（rejected/deferred の 1:1）が揃った記録にだけ書けます。'
      )
    }
    const staged = stagedDetectorCheck(detect, requestId, stamped, final)
    if (staged.scannedCount !== 1 || staged.blockedAll.length > 0) {
      fail(
        `${dryRun ? '[dry-run] ' : ''}検出核（降格鎖の判定）を通らないため書き込みません。\n` +
          `  走査件数=${staged.scannedCount} block=${JSON.stringify(staged.blockedAll)}\n` +
          `  検出核: ${detectFrom}`
      )
    }

    const report = (head) => {
      process.stdout.write(`${head}\n`)
      process.stdout.write(`  状態             : ${state === 'S0' ? 'S0 未降格（提案 frontmatter へ降格マーカーを追記）' : 'S1 降格済み（提案は書き換えない）'}\n`)
      process.stdout.write(`  downgradedTo     : ${final.downgradedTo}\n`)
      process.stdout.write(`  downgradedAt     : ${final.downgradedAt}\n`)
      process.stdout.write(`  proposal_hash    : ${final.proposal_hash}（降格前の本文で実測）\n`)
      process.stdout.write(`  downgradedFromHash    : ${final.downgradedFromHash}\n`)
      process.stdout.write(`  downgradedContentHash : ${final.downgradedContentHash}（降格後の本文で実測）\n`)
      process.stdout.write(`  検出核による書込前検査 : 降格鎖 ok（一時領域で実行・走査 1 件）\n`)
    }
    if (plan.consistent) {
      process.stdout.write(`[OK]${dryRun ? '[dry-run]' : ''} ${requestId}: 降格鎖は既に現本文と整合しています（書込なし）\n`)
      return 0
    }
    if (dryRun) {
      report(`[OK][dry-run] ${requestId}: 検査のみ（書込は行っていません）`)
      return 0
    }

    ledger[requestId] = final
    // lock を尊重しない書き手への深層防御（読込時点との一致を確認してから置換する）
    const raw2 = fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, 'utf8') : '{}'
    if (sha256(raw2) !== h1) fail('CAS 不一致: 読込後に他者が台帳を更新しました。やり直してください')
    // 提案プールは台帳 lock の管轄外。検査した本文と保存直前の提案が同一かを再実測する
    const prop2 = findProposal(requestId)
    if (sha256(prop2.raw) !== origHash) {
      fail('提案 MD が検査後に変更されました（検査した本文と保存対象が一致しません）。やり直してください')
    }

    // --- MD（S0 のみ）→ 台帳 の順。逆だと MD の書込失敗時に「台帳だけ降格済み」が恒久化する。
    //     この順なら、途中で落ちても再実行が S1 として台帳側を追いつかせる ---
    if (state === 'S0') {
      const mdBak = `${prop.path}.bak`
      if (!fs.existsSync(mdBak)) fs.copyFileSync(prop.path, mdBak)
      mdTmp = `${prop.path}.tmp`
      fs.writeFileSync(mdTmp, stamped, 'utf8')
      fs.renameSync(mdTmp, prop.path)
      mdTmp = null
      // 提案 MD を書く他ライタは台帳 lock を取らない。rename 直後に別の書込が入ったら、台帳を進めず止める
      // （安全側に倒れる。並行書込下で「必ず収束」までは保証しない＝やり直し対象）
      if (fs.readFileSync(prop.path, 'utf8') !== stamped) {
        fail('提案 MD が降格マーカー書込の直後に別の書込で変わりました。台帳は更新していません。状態を確認して再実行してください。')
      }
    }
    const bak = `${LEDGER}.bak`
    if (fs.existsSync(LEDGER) && !fs.existsSync(bak)) fs.copyFileSync(LEDGER, bak)
    fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2), 'utf8')
    fs.renameSync(tmp, LEDGER)

    report(`[OK] ${requestId}: 明示降格を記録しました`)
    if (state === 'S0') process.stdout.write(`  提案 MD          : ${prop.path}（バックアップ: ${prop.path}.bak）\n`)
    if (harvest.deferred.length) {
      process.stdout.write(`  ※ deferred があるため、採用時にユーザーの ack（責任譲渡）が要ります\n`)
    }
  } finally {
    if (lockFd !== null) {
      fs.closeSync(lockFd)
      try {
        fs.unlinkSync(tmp)
      } catch {
        /* rename 済み（成功時）で tmp が無いのが正常 */
      }
      if (mdTmp) {
        try {
          fs.unlinkSync(mdTmp)
        } catch {
          /* rename 済みなら mdTmp = null で到達しない。失敗残骸のみ掃除 */
        }
      }
      try {
        fs.unlinkSync(LOCK)
      } catch {
        /* 解放失敗は握る（既に消えている場合） */
      }
    }
  }
  return 0
}

function main(argv) {
  const args = argv.slice(2)
  const requestId = valueOf(args, '--request-id')
  const batchFile = valueOf(args, '--batch-file')

  // 呼び手に持たせてはいけない値を、フラグとしても受け付けない（黙って無視せず落とす）
  for (const dead of [
    '--proposal-hash',
    '--adjudications-for',
    '--reviewed-at',
    '--downgraded-to',
    '--downgraded-at',
    '--downgraded-from-hash',
    '--downgraded-content-hash'
  ]) {
    if (args.includes(dead)) {
      fail(`${dead} は受け付けません。この値は本スクリプトが実測・計算します（自己申告させない設計）`)
    }
  }
  // --- 契約自己検査（書込なし） ---
  // 呼び手 skill が「別配備のこのスクリプトが期待どおりの述語・CLI を持つか」を実行前に
  // 機械検証する入口。検出核を実際に解決し、書込経路が使う述語関数の実在を確かめてから
  // しか契約行を出さない（独立レビュー r2 指摘: grep 文字列一致はコメントでも成立する）。
  if (args.includes('--check-contract')) {
    const { mod: detect, from: detectFrom } = loadDetector()
    for (const fn of ['judgeHarvest', 'extractFindingIds']) {
      if (typeof detect[fn] !== 'function') {
        fail(`検出核に述語 ${fn} がありません（別実装/旧版の可能性）: ${detectFrom}`)
      }
    }
    // §5 転記の往復自己検査: 生成 → fixture へ挿入 → 読み側と同じ単行規則で再パースし、
    // verdict が往復することを**実行で**確かめる。転記機能が壊れた版に v2 を名乗らせない。
    const probe = { verdict: 'approve', findings: 'FINDINGS: none（契約自己検査）', reviewerId: 'contract-probe', ccRebuttal: '' }
    const fixture = '---\nrequest_id: contract-probe\n---\n\n## 5. レビューボックス\n\n- review_verdict: pending\n\n## 6. 次節\n'
    const out = transcribeSection5(fixture, buildSection5(probe, { findingCount: 0, rejected: 0, deferred: 0 }))
    const line = out.split(/\r?\n/).find((l) => /^- review_verdict: /.test(l))
    if (!line || line !== '- review_verdict: approve' || !/\n## 6\. 次節/.test(out)) {
      fail('§5 転記の往復自己検査に失敗しました（transcribeSection5 が期待形を返しません）')
    }
    // コードブロックの中の見本の §5 見出しを数えず、本物の §5 だけを書き直すこと（069 M3）
    const fenced =
      '---\nrequest_id: contract-probe\n---\n\n## 3. 変更後の完成版\n\n````markdown\n## 5. レビューボックス\n\n- review_verdict: 見本\n```\n## 6. 見本の次節\n```\n````\n\n' +
      '## 5. レビューボックス\n\n- review_verdict: pending\n\n```text\n## 7. §5 の中のコードブロックの行\n```\n\n## 6. 次節\n'
    const outF = transcribeSection5(fenced, buildSection5(probe, { findingCount: 0, rejected: 0, deferred: 0 }))
    const verdictLines = outF.split(/\r?\n/).filter((l) => /^- review_verdict: /.test(l))
    if (
      verdictLines.join('|') !== '- review_verdict: 見本|- review_verdict: approve' ||
      !/\n## 6\. 次節/.test(outF) ||
      /## 7\. §5 の中のコードブロックの行/.test(outF)
    ) {
      fail('§5 転記の往復自己検査に失敗しました（コードブロックの中の見出しを数えています）')
    }
    process.stdout.write(
      `${CONTRACT_ID} cli=--request-id,--batch-file predicates=judgeHarvest,extractFindingIds transcribe=section5 detector=${detectFrom}\n`
    )
    return 0
  }

  // --- 降格モードの契約自己検査（書込なし。`--check-contract` の出力は変えないため別フラグ） ---
  // 検出核を実際に解決し、降格に要る述語の実在と、**降格の導出→書込前検査の往復**（未降格の見本の提案で
  // 降格を導出し、検出核の実関数を一時領域で通す）を実行で確かめた場合にのみ契約行を出す。
  if (args.includes('--check-downgrade-contract')) {
    const { mod: detect, from: detectFrom } = loadDetector()
    requireDowngradePredicates(detect, detectFrom)
    const probeFindings = 'FINDINGS: none（契約自己検査のための見本であり、実データには一切書き込まれない）'
    const probeRaw =
      '---\nrequest_id: contract-probe\nkind: skill\nadoption_label: recommend\n---\n\n## 5. レビューボックス\n\n- review_verdict: approve\n'
    const probePrev = {
      verdict: 'approve',
      findings: probeFindings,
      reviewerId: 'contract-probe',
      adjudicationsFor: sha256(probeFindings),
      proposal_hash: sha256(probeRaw)
    }
    const spec = { downgrade: { to: detect.DOWNGRADE_LABEL, reason: '契約自己検査のための見本の降格理由であり、実データには一切書き込まれない。' } }
    validateDowngradeSpec(spec, detect.DOWNGRADE_LABEL)
    const plan = planDowngrade({ raw: probeRaw, prev: probePrev, spec, detect, now: new Date().toISOString() })
    const staged = stagedDetectorCheck(detect, 'contract-probe', plan.stamped, plan.final)
    if (!detect.judgeHarvest(plan.final, plan.stamped).ok || staged.scannedCount !== 1 || staged.blockedAll.length > 0) {
      fail('降格の往復自己検査に失敗しました（導出した降格が検出核の判定を通りません）')
    }
    process.stdout.write(
      `${DOWNGRADE_CONTRACT_ID} batch-key=downgrade label=${detect.DOWNGRADE_LABEL} ` +
        `predicates=contentHash,invertDowngrade,judgeHarvest,detectDetailed detector=${detectFrom}\n`
    )
    return 0
  }

  if (!requestId || !batchFile) fail('usage: --request-id <id> --batch-file <json> [--dry-run] | --check-contract')

  const spec = JSON.parse(fs.readFileSync(batchFile, 'utf8'))
  const { mod: detect, from: detectFrom } = loadDetector()

  // 降格モード: batch JSON にトップレベルキー `downgrade` が在るかだけで一意に分岐する（通常記録のキーとは衝突しない）
  if (isPlainObject(spec) && Object.prototype.hasOwnProperty.call(spec, 'downgrade')) {
    return runDowngrade(requestId, spec, detect, detectFrom, args.includes('--dry-run'))
  }

  // --- findings ---
  const findings = spec.findings
  if (typeof findings !== 'string' || findings.trim() === '') fail('batch JSON に findings がありません')
  if (!CJK_RE.test(findings)) {
    fail(
      'findings に日本語が含まれていません。台帳は読者の言語で書く規約です。\n' +
        '  レビュアが別言語で返した場合は、訳文を findings に、原文を findingsOriginal に入れてください。\n' +
        '  （英語のまま記録すると、採用可否を判断する人間が毎回翻訳を強いられます）'
    )
  }

  const ids = detect.extractFindingIds(findings)
  if (ids === null) {
    fail(
      'findings から指摘 id を同定できません（`[1]` 形式の連番になっていますか）。\n' +
        '  指摘が 0 件のときは findings に FINDINGS: none と明記してください（verdict: approve と組で刈り取り判定を通ります）'
    )
  }

  // --- adjudications ---
  const adj = spec.adjudications
  if (ids.length > 0 && (!Array.isArray(adj) || adj.length === 0)) {
    fail(`指摘が ${ids.length} 件ありますが adjudications が空です。全件に終端裁定が要ります`)
  }
  const seen = new Set()
  for (const a of Array.isArray(adj) ? adj : []) {
    if (!a || typeof a.id !== 'string') {
      fail(
        `adjudications[].id は**文字列**でなければなりません（例: "1"）。` +
          `実際: ${JSON.stringify(a && a.id)}（${typeof (a && a.id)}）。\n` +
          '  数値で書くと、アプリ正本 evaluateHarvest と検出核 judgeHarvest の双方が\n' +
          '  「裁定の形式が不正」を返し、裁定が 1 件も無いものとして扱われます。\n' +
          '  ここで自動変換しないのは、呼び手の側を直さないと同じ誤りが再発するためです。'
      )
    }
    if (!CANONICAL_ID_RE.test(a.id)) fail(`adjudications[].id が canonical decimal string ではありません: ${JSON.stringify(a.id)}`)
    if (seen.has(a.id)) fail(`裁定 id が重複しています: ${a.id}`)
    seen.add(a.id)
    if (!TERMINAL_DECISIONS.has(a.decision)) {
      fail(
        `decision が終端ではありません: ${JSON.stringify(a.decision)}（id=${a.id}）。\n` +
          `  使えるのは ${[...TERMINAL_DECISIONS].join(' / ')} だけです。` +
          '「修正した」は終端裁定ではありません（直したなら再レビューへ戻ってください）。'
      )
    }
    if (!isSubstantive(a.reason)) fail(`裁定理由が実質的ではありません（水増し / 短すぎ）: id=${a.id}`)
  }
  if (seen.size !== ids.length || !ids.every((id) => seen.has(id))) {
    fail(
      `裁定が指摘と 1:1 対応していません。指摘=[${ids.join(',')}] 裁定=[${[...seen].join(',')}]（欠け・余分は不可）`
    )
  }

  // §5 転記用の件数は**入力から**数える（judgeHarvest の結果を使うと
  // 「転記 → hash 実測 → 検査」の順序と循環する。1:1 検査済みなので同値）。
  const counts = {
    findingCount: ids.length,
    rejected: (Array.isArray(adj) ? adj : []).filter((a) => a.decision === 'rejected').length,
    deferred: (Array.isArray(adj) ? adj : []).filter((a) => a.decision === 'deferred').length
  }

  // --- エントリ組み立て（hash 類は全てこちらで計算する） ---
  const now = new Date().toISOString()
  const entry = {
    requestId,
    kind: typeof spec.kind === 'string' && spec.kind ? spec.kind : 'skill',
    verdict: String(spec.verdict || '').trim(),
    findings,
    ...(typeof spec.findingsOriginal === 'string' && spec.findingsOriginal
      ? { findingsOriginal: spec.findingsOriginal }
      : {}),
    reviewerId: String(spec.reviewerId || '').trim(),
    ...(typeof spec.ccRebuttal === 'string' && spec.ccRebuttal ? { ccRebuttal: spec.ccRebuttal } : {}),
    reviewedAt: now,
    review_status: 'reviewed',
    adjudicationsFor: sha256(findings),
    ...(Array.isArray(adj) && adj.length
      ? { adjudications: adj.map((a) => ({ id: a.id, decision: a.decision, reason: a.reason, at: now })) }
      : {}),
    ...(Number.isInteger(spec.reviewRounds) ? { reviewRounds: spec.reviewRounds } : {})
  }
  if (!entry.verdict) fail('batch JSON に verdict がありません')
  if (!entry.reviewerId) fail('batch JSON に reviewerId がありません')

  // --- dry-run: 書込経路と同一の検査（提案実測 → 既存台帳とのマージ → judgeHarvest）を
  //     lock を取らずに通し、結果だけ先読みする。lock/書込に進む分岐がここで return するだけで、
  //     判定ロジック自体は本番と共有しているため、dry-run が通って本番が弾かれる乖離は起きない。
  if (args.includes('--dry-run')) {
    const prop = findProposal(requestId)
    // 本番と同一順序: §5 転記後の本文を先に組み、**その本文**で proposal_hash を実測する
    const newRaw = transcribeSection5(prop.raw, buildSection5(entry, counts))
    entry.proposal_hash = sha256(newRaw)

    const raw1 = fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, 'utf8') : '{}'
    let ledger
    try {
      ledger = JSON.parse(raw1)
    } catch {
      fail(`台帳が読めません（不正な JSON）: ${LEDGER}`)
    }
    const prev = ledger[requestId]
    const final = { ...(prev || {}), ...entry }
    for (const k of ['findingsOriginal', 'ccRebuttal', 'adjudications', 'reviewRounds']) {
      if (!(k in entry)) delete final[k]
    }

    const harvest = detect.judgeHarvest(final, newRaw)
    if (!harvest.ok) {
      fail(
        `[dry-run] 刈り取り判定を通らないため、本番実行でも書き込めません: ${harvest.reason}\n` +
          `  検出核: ${detectFrom}`
      )
    }
    process.stdout.write(`[OK][dry-run] ${requestId}: 検査のみ（書込は行っていません）\n`)
    process.stdout.write(`  verdict          : ${final.verdict}\n`)
    process.stdout.write(`  proposal_hash    : ${final.proposal_hash}（§5 転記後の本文で実測）\n`)
    process.stdout.write(`  §5 転記          : 本番実行時に提案 MD のレビューボックスを自動更新します\n`)
    process.stdout.write(`  adjudicationsFor : ${final.adjudicationsFor}（findings から計算）\n`)
    process.stdout.write(
      `  刈り取り         : ok / 指摘 ${harvest.findingCount} 件 ` +
        `(棄却 ${harvest.rejected.length} / 据置 ${harvest.deferred.length})\n`
    )
    if (harvest.deferred.length) {
      process.stdout.write(`  ※ deferred があるため、採用時にユーザーの ack（責任譲渡）が要ります\n`)
    }
    return 0
  }

  // --- 直列単一書込（lock を先に取得し、提案実測 → 検査 → 保存を全て lock 下で行う） ---
  // 提案 MD の実測や judgeHarvest を lock 外でやると、検査した本文と保存時点の本文が
  // 別物になり得る（TOCTOU）。lock 取得に失敗した場合は他者の lock に触れない（try に入らない）。
  let lockFd
  try {
    lockFd = fs.openSync(LOCK, 'wx')
  } catch {
    fail(`lockfile が既に在ります（他ライタが書込中の可能性）: ${LOCK}`)
  }
  const tmp = `${LEDGER}.tmp`
  let mdTmp = null
  try {
    // 提案 MD の §5 転記本文を組み、**転記後の本文**で proposal_hash を実測する
    // （proposal_hash は呼び手から取らない。転記前の本文で測ると、保存する MD と
    //   台帳の hash が恒常的に食い違う）。
    const prop = findProposal(requestId)
    const origHash = sha256(prop.raw)
    const newRaw = transcribeSection5(prop.raw, buildSection5(entry, counts))
    entry.proposal_hash = sha256(newRaw)

    const raw1 = fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, 'utf8') : '{}'
    const h1 = sha256(raw1)
    let ledger
    try {
      ledger = JSON.parse(raw1)
    } catch {
      fail(`台帳が読めません（不正な JSON）: ${LEDGER}`)
    }
    const prev = ledger[requestId]
    const isNew = !prev

    // 保存する最終オブジェクト（既存エントリとのマージ結果）を先に組む。
    // 検査対象と保存対象が別物だと「書けた＝ゲートを通る」保証が壊れるため、
    // 本スクリプト管理の任意フィールドは entry に無ければ旧値も残さない（残留 adjudications 等の防止）。
    const final = { ...(prev || {}), ...entry }
    for (const k of ['findingsOriginal', 'ccRebuttal', 'adjudications', 'reviewRounds']) {
      if (!(k in entry)) delete final[k]
    }

    // --- 最終検査: 読み側と同じ述語を、保存する最終オブジェクト + **転記後の本文**に通す（本スクリプトの存在理由） ---
    const harvest = detect.judgeHarvest(final, newRaw)
    if (!harvest.ok) {
      fail(
        `刈り取り判定を通らないため書き込みません: ${harvest.reason}\n` +
          `  検出核: ${detectFrom}\n` +
          '  台帳へ書けても ゲートで落ちる記録は、書かないほうが良い記録です。'
      )
    }
    ledger[requestId] = final

    // lock を尊重しない書き手への深層防御（lock 下でも読込時点との一致を確認してから置換する）
    const raw2 = fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, 'utf8') : '{}'
    if (sha256(raw2) !== h1) fail('CAS 不一致: 読込後に他者が台帳を更新しました。やり直してください')

    // 提案プールは台帳 lock の管轄外（emit 側ツールはこの lock を取らない）。
    // 検査した本文と保存時点の提案が同一か、保存直前に再探索・再実測で確認する
    // （1 件性は findProposal 内で再強制。検査後の変更・差替・重複追加をここで検出）。
    // 照合対象は **転記前の実測 origHash**。final.proposal_hash は転記後の値なので、
    // ここで比べると必ず不一致になる（自己参照）。
    const prop2 = findProposal(requestId)
    if (sha256(prop2.raw) !== origHash) {
      fail('提案 MD が検査後に変更されました（検査した本文と保存対象が一致しません）。やり直してください')
    }

    // --- §5 転記を先に確定（MD → 台帳の順。逆だと「台帳は新 hash、MD は旧本文」の
    //     不整合が MD 書込失敗時に恒久化する。この順なら失敗時も台帳が旧のままで、
    //     再実行すれば転記が冪等に収束する） ---
    const mdBak = `${prop.path}.bak`
    if (!fs.existsSync(mdBak)) fs.copyFileSync(prop.path, mdBak)
    mdTmp = `${prop.path}.tmp`
    fs.writeFileSync(mdTmp, newRaw, 'utf8')
    fs.renameSync(mdTmp, prop.path)
    mdTmp = null

    const bak = `${LEDGER}.bak`
    if (fs.existsSync(LEDGER) && !fs.existsSync(bak)) fs.copyFileSync(LEDGER, bak)
    fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2), 'utf8')
    fs.renameSync(tmp, LEDGER)

    process.stdout.write(`[OK] ${requestId}: レビュー記録を${isNew ? '新規作成' : '更新'}しました\n`)
    process.stdout.write(`  verdict          : ${final.verdict}\n`)
    process.stdout.write(`  proposal_hash    : ${final.proposal_hash}（§5 転記後の本文で実測）\n`)
    process.stdout.write(`  §5 転記          : ${prop.path}（バックアップ: ${mdBak}）\n`)
    process.stdout.write(`  adjudicationsFor : ${final.adjudicationsFor}（findings から計算）\n`)
    process.stdout.write(
      `  刈り取り         : ok / 指摘 ${harvest.findingCount} 件 ` +
        `(棄却 ${harvest.rejected.length} / 据置 ${harvest.deferred.length})\n`
    )
    if (harvest.deferred.length) {
      process.stdout.write(`  ※ deferred があるため、採用時にユーザーの ack（責任譲渡）が要ります\n`)
    }
  } finally {
    fs.closeSync(lockFd)
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* rename 済み（成功時）で tmp が無いのが正常 */
    }
    if (mdTmp) {
      try {
        fs.unlinkSync(mdTmp)
      } catch {
        /* rename 済みなら mdTmp = null で到達しない。失敗残骸のみ掃除 */
      }
    }
    try {
      fs.unlinkSync(LOCK)
    } catch {
      /* 解放失敗は握る（既に消えている場合） */
    }
  }
  return 0
}

module.exports = {
  isSubstantive,
  CANONICAL_ID_RE,
  TERMINAL_DECISIONS,
  CJK_RE,
  sha256,
  buildSection5,
  transcribeSection5,
  planDowngrade,
  stagedDetectorCheck,
  validateDowngradeSpec
}

if (require.main === module) {
  try {
    process.exit(main(process.argv))
  } catch (err) {
    process.stderr.write(`[NG] ${err && err.message ? err.message : String(err)}\n`)
    process.exit(1)
  }
}
