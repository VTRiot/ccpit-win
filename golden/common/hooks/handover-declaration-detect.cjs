#!/usr/bin/env node
/*
 * handover-declaration-detect.cjs — 「発注の型」宣言義務化ゲートの検出核（純粋判定）。
 *
 * 背景: CCPIT_071（受け入れ条件プロトコル改訂）。実装レーンの報告に作話が混ざる往復を減らすため、
 *   設計レーンが実装レーンへ発注する際、その発注が handover-cc の新方式（4列受け入れ条件）に
 *   準拠しているかを人間へ宣言させる。宣言の形式が無い・崩れている投下は Stop hook で止める。
 *
 * 判定（最後の assistant 応答本文が「発注」＝投下プロンプトの定型文言を含むときのみ検査）:
 *   1. `発注の型:` 行があり、値が「handover-cc 準拠」か「handover-cc 非準拠（報告書: <id>／maintainerの
 *      返事: 「<逐語>」）」のどちらかである
 *   2. 投下プロンプトが指す指示MDファイルが実在する
 *   3. 「準拠」のとき: 指示MDに「判定方法」「証跡」を見出しに持つ表がある
 *      （既知の限定: 「条件」「区分」列の有無までは検査しない。発注元 CCPIT_071 §3-2 の検査仕様どおり。
 *      区分列も検査対象に含めるかは発注元への申し送り事項。Codex レビューで複数回指摘・棄却済み）
 *   4. 「非準拠」のとき: report_id の報告書MDが実在し、H1直下（次の `##` より前、コードフェンス外）に
 *      `> [!DECISION]` の判断ブロックがある
 *   5. 「非準拠」のとき: 宣言に写した返事の逐語が、その report_id を提示した assistant ターンのうち
 *      現在のターンより前で直近（最も新しい）のものより後に現れた「人間の生発言」（last-human-text.cjs）の
 *      いずれかに含まれる。**直近を採る理由**: 同じ report_id の報告書を出し直した場合、承認は出し直した
 *      版に対して取るべきであり、古い提示ターンを起点にすると版違いの承認を通してしまう
 *      （検収差し戻し01 F3反映）。提示ターンが見つからない（＝報告書の提示と投下が同じ返答内、または
 *      一度も提示されていない）場合は検査失敗（Codex レビュー指摘[2][5]反映）
 *
 * fail-open: 転写が読めない・本文が空・発注検出（定型文言）が無い → 非 block。
 *   分類できない記録は「人間の同意」として数えない（fail-open とは別軸。Codex レビュー指摘[6]反映）。
 *
 * env:
 *   LAT_TRANSCRIPT / LAT_SESSION_ID : 転写の指定（last-assistant-text.cjs 経由でテスト・dry-run）
 *   HDG_TEXT                        : 応答本文を直接注入（check 1-4 の単体テスト用。転写を読まない）
 */
'use strict'
const fs = require('fs')
const path = require('path')
const lat = require('./last-assistant-text.cjs')
const lht = require('./last-human-text.cjs')

const DROP_PROMPT_RE = /以降のPATHのファイルの指示に従い/
const QUOTED_PATH_RE = /"((?:[A-Za-z]:[\/\\]|\/)[^"]+?\.md)"/
const DECL_LINE_RE = /^発注の型:\s*(.+)$/m
const COMPLIANT_VALUE = 'handover-cc 準拠'
const NONCOMPLIANT_RE = /^handover-cc 非準拠[（(]報告書:\s*([^／\/]+)[／\/]maintainerの返事:\s*「([\s\S]*?)」[）)]$/
const MIN_QUOTE_LEN = 2

const SKIP_DIR_RE = /^(\.git|node_modules|dist|out|build|\.ccpit)$/
const MAX_FILES_SCANNED = 20000

// git-bash 形式 /c/Users/... を Windows Node が解決できる C:/Users/... へ正規化する。
// last-assistant-text.cjs の同名処理と同じロジックだが、当該ファイルは一切改変しない方針のため
// ここに複製する（Codex レビュー第2ラウンド指摘[1]反映）。
function normalizeGitBashPath(p) {
  const m = typeof p === 'string' && /^\/([a-zA-Z])\/(.*)$/.exec(p)
  return m ? m[1].toUpperCase() + ':/' + m[2] : p
}

function reasonFor(code, extra) {
  const base = '発注の型の宣言が仕様を満たしていません（' + code + '）。'
  const guide =
    ' handover-cc §2-5 のとおり、投下プロンプトを出す返答の本文に `発注の型:` 行を書くこと。' +
    '準拠なら `handover-cc 準拠`、非準拠なら `handover-cc 非準拠（報告書: <report_id>／maintainerの返事: 「<逐語>」）`。' +
    '抑制: ~/.ccpit/app-config.json の "handoverDeclarationGateMode"（soft/strict/off）。'
  const detail = extra ? ' 詳細: ' + extra : ''
  return base + detail + guide
}

const FENCE_OPEN_RE = /^\s*(`{3,}|~{3,})/
// 閉じフェンスは CommonMark 規約上、マーカーの後に空白以外を置けない（情報文字列は開始行のみ許される）。
const FENCE_CLOSE_RE = /^\s*(`{3,}|~{3,})\s*$/

/** 行配列を走査し、各行が「コードフェンスの中か外か」を示す真偽値配列を返す。
 *  開始フェンスと同じ文字種・同じ長さ以上・末尾が空白のみの行でのみ閉じる（``` と ~~~ の混同・
 *  長さ違いのフェンス・info-string 付きの偽閉じ行の誤対応を避ける。CommonMark のフェンス規約に準拠。
 *  Codex レビュー第2ラウンド指摘[2]反映）。 */
function computeFenceMask(lines) {
  const mask = new Array(lines.length).fill(false)
  let fenceChar = null
  let fenceLen = 0
  for (let i = 0; i < lines.length; i++) {
    if (fenceChar) {
      mask[i] = true
      const closeM = FENCE_CLOSE_RE.exec(lines[i])
      if (closeM && closeM[1][0] === fenceChar && closeM[1].length >= fenceLen) {
        fenceChar = null
        fenceLen = 0
      }
      continue
    }
    const openM = FENCE_OPEN_RE.exec(lines[i])
    if (openM) {
      fenceChar = openM[1][0]
      fenceLen = openM[1].length
      mask[i] = true
    }
  }
  return mask
}

/** コードフェンス外の行だけを対象に、テーブルヘッダ行（判定方法・証跡の両方を含む区切り行）の
 *  直後に区切り行（|---|等）があるかを見る。先頭 `|` の省略を許す GFM 表記も対象にする。 */
function hasJudgmentEvidenceTable(md) {
  if (!md) return false
  const lines = md.split('\n')
  const inFence = computeFenceMask(lines)
  for (let i = 0; i < lines.length; i++) {
    if (inFence[i]) continue
    const line = lines[i]
    if (line.indexOf('|') >= 0 && line.indexOf('判定方法') >= 0 && line.indexOf('証跡') >= 0) {
      // 区切り行判定: 先頭 `|` の有無を問わず、`-` を含みパイプ・コロン・空白・ダッシュのみで構成される行
      const next = lines[i + 1] || ''
      if (/^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/.test(next)) return true
    }
  }
  return false
}

/** H1 直下（次の H2 より前、コードフェンス外）に `> [!DECISION]` の行があるか。 */
function hasDecisionBlockUnderH1(md) {
  if (!md) return false
  const lines = md.split('\n')
  const inFence = computeFenceMask(lines)
  let h1 = -1
  let h2 = lines.length
  for (let i = 0; i < lines.length; i++) {
    if (inFence[i]) continue
    const line = lines[i]
    if (h1 < 0 && /^#\s+/.test(line)) {
      h1 = i
      continue
    }
    if (h1 >= 0 && /^##\s+/.test(line)) {
      h2 = i
      break
    }
  }
  if (h1 < 0) return false
  for (let i = h1 + 1; i < h2; i++) {
    if (inFence[i]) continue
    if (/^\s*>\s*\[!DECISION\]/.test(lines[i])) return true
  }
  return false
}

function walkFiles(root, onFile, state) {
  state = state || { count: 0 }
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return state
  }
  for (const ent of entries) {
    if (state.count >= MAX_FILES_SCANNED) return state
    if (ent.isDirectory()) {
      if (SKIP_DIR_RE.test(ent.name)) continue
      walkFiles(path.join(root, ent.name), onFile, state)
      continue
    }
    if (!ent.isFile() || !ent.name.endsWith('.md')) continue
    state.count++
    onFile(path.join(root, ent.name))
  }
  return state
}

/** cwd 配下（_Prompt があればそちらに限定）を走査し、report_id に一致する報告書 MD のパスを返す。
 *  ファイル名一致・frontmatter 一致のいずれも複数件ヒットしたら「解決不能」として null を返す
 *  （どれを採るか走査順に依存させない。安全側＝止める方向に倒す。Codex レビュー指摘[5]反映）。 */
function resolveReportPath(cwd, reportId) {
  if (!cwd || !reportId) return null
  let root = cwd
  const promptDir = path.join(cwd, '_Prompt')
  try {
    if (fs.statSync(promptDir).isDirectory()) root = promptDir
  } catch {
    /* cwd 直下を走査 */
  }
  const nameMatches = []
  const fmMatches = []
  const fmRe = new RegExp('^report_id:\\s*' + reportId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'm')
  walkFiles(root, (file) => {
    const base = path.basename(file, '.md')
    if (base === reportId) {
      nameMatches.push(file)
      return
    }
    let content
    try {
      content = fs.readFileSync(file, 'utf8').slice(0, 4096)
    } catch {
      return
    }
    if (fmRe.test(content)) fmMatches.push(file)
  })
  if (nameMatches.length === 1) return nameMatches[0]
  if (nameMatches.length === 0 && fmMatches.length === 1) return fmMatches[0]
  return null
}

function safeRead(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/**
 * 純粋判定。env.HDG_TEXT / lat.lastAssistantText で本文を取得し、
 * env.HDG_CWD（無ければ stdinJson.cwd）で report_id 解決の起点を得る。
 * block 対象なら block-JSON 文字列、無ければ ''。
 */
function detect(env, stdinJson) {
  let text
  if (env.HDG_TEXT !== undefined) text = env.HDG_TEXT
  else text = lat.lastAssistantText(env, stdinJson)
  if (!text || !DROP_PROMPT_RE.test(text)) return ''

  const declMatch = DECL_LINE_RE.exec(text)
  if (!declMatch) return block('missing-declaration')
  const declValue = declMatch[1].trim()

  const pathMatch = QUOTED_PATH_RE.exec(text)
  const orderPath = pathMatch ? normalizeGitBashPath(pathMatch[1]) : null
  if (!orderPath) return block('order-path-missing')
  if (!fs.existsSync(orderPath)) return block('order-path-missing', orderPath)

  if (declValue === COMPLIANT_VALUE) {
    const md = safeRead(orderPath)
    if (!hasJudgmentEvidenceTable(md)) return block('missing-ac-table', orderPath)
    return ''
  }

  const nc = NONCOMPLIANT_RE.exec(declValue)
  if (!nc) return block('bad-declaration-value', declValue)
  const reportId = nc[1].trim()
  const quoted = nc[2]

  const cwd = normalizeGitBashPath(env.HDG_CWD || (stdinJson && stdinJson.cwd) || process.cwd())
  const reportPath = resolveReportPath(cwd, reportId)
  if (!reportPath) return block('report-missing', reportId)
  const reportMd = safeRead(reportPath)
  if (!hasDecisionBlockUnderH1(reportMd)) return block('missing-decision-block', reportId)

  if (quoted.length < MIN_QUOTE_LEN) return block('reply-quote-too-short', reportId)

  const records = env.HDG_RECORDS || lht.loadRecords(env, stdinJson)
  const currentTurnStart = lht.lastHumanIndex(records, records.length)
  const presentIdx = lht.findLastPresentationIndex(records, reportId, currentTurnStart < 0 ? records.length : currentTurnStart + 1)
  if (presentIdx < 0) return block('reply-not-anchored', reportId)
  const humanTexts = lht.humanRealTextsAfter(records, presentIdx)
  const found = humanTexts.some((t) => t.indexOf(quoted) >= 0)
  if (!found) return block('reply-not-confirmed', reportId)

  return ''
}

function block(code, extra) {
  return JSON.stringify({ decision: 'block', reason: reasonFor(code, extra) }, null, 2)
}

if (require.main === module) {
  try {
    const stdin = process.env.HDG_STDIN_JSON ? lat.readStdinJson() : null
    const out = detect(process.env, stdin)
    if (out) process.stdout.write(out + '\n')
  } catch {
    /* fail-open */
  }
  process.exit(0)
}

module.exports = { detect, hasJudgmentEvidenceTable, hasDecisionBlockUnderH1, resolveReportPath }
