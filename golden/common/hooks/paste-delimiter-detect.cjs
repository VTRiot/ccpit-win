#!/usr/bin/env node
/*
 * paste-delimiter-detect.cjs — 「貼り付け文の区切り」義務化ゲートの検出核（純粋判定）。
 *
 * 背景: 実装レーン・他 AI へ「そのまま貼る」文（投下プロンプト等）を CLI に出すとき、コードフェンスだけでは
 *   端末上で枠が見えず、人間がコピー範囲を目視で切り出す作業を強いられる。この是正は memory に 5 回
 *   書かれても再発した（2026-09-14 / 09-24 / 09-25 ×3）。心がけでは守れないので機械強制する。
 *
 * 判定（最後の assistant 応答本文に対して）:
 *   (a) 貼り付け語（投下プロンプト / 貼って / 貼り付け / コピペ / 転記 / ここからコピー 等）を含み、かつ
 *       コードフェンス（```）があるのに、開始区切り「ここから」と終了区切り「ここまで」の両方が無い → block
 *   (b) 「投下プロンプトは <ファイル> に書いた／保存した」と述べるだけで区切り行が無い → block
 *       （ファイル保存は補助、CLI 掲載が主）
 *   区切り行の判定: 行頭が =/＝/━/─/- のいずれかの連続で始まり「ここから」または「ここまで」を含む行。
 *
 * fail-open（§4）: 転写が読めない・応答本文が空・貼り付け語が無い → 非 block。
 *
 * env（§3）:
 *   LAT_TRANSCRIPT / LAT_SESSION_ID : 転写の指定（テスト・dry-run）
 *   PDG_TEXT                        : 応答本文を直接注入（単体テスト用。指定時は転写を読まない）
 */
'use strict'
const lat = require('./last-assistant-text.cjs')

const PASTE_WORDS_RE = /(投下プロンプト|貼っ|貼り付|貼る|コピペ|転記|ここからコピー|そのまま貼|に貼)/
const FENCE_RE = /^\s*```/m
const DELIM_START_RE = /^[\s]*[=＝━─\-＝]{3,}.*ここから/m
const DELIM_END_RE = /^[\s]*[=＝━─\-＝]{3,}.*ここまで/m
const FILE_ONLY_RE = /投下プロンプト[^\n]{0,40}(に書い|へ書い|に保存|へ保存|に出力|に置い|に焼い)/

function judge(text) {
  if (!text || !PASTE_WORDS_RE.test(text)) return null
  const hasStart = DELIM_START_RE.test(text)
  const hasEnd = DELIM_END_RE.test(text)
  if (hasStart && hasEnd) return null
  if (FENCE_RE.test(text)) return 'fence-without-delimiter'
  if (FILE_ONLY_RE.test(text)) return 'file-only'
  return null
}

function reasonFor(kind) {
  const common =
    'maintainerに貼ってもらう文（投下プロンプト等）は、CLI の返答本文に全文を載せ、次の 2 行で挟むこと（区切り行はコピー範囲に含めない旨を一言添える）:\n' +
    '＝＝＝＝＝ ここから貼る ＝＝＝＝＝\n（本文）\n＝＝＝＝＝ ここまで ＝＝＝＝＝\n' +
    '区切りの内側に説明・注釈を混ぜない。複数あるなら ①②で番号を付ける。ファイル保存は補助で CLI 掲載が主。' +
    '根拠: rules/paste-and-approval-phrasing（memory 5 本を統合）。抑制: ~/.ccpit/app-config.json の "pasteDelimiterGateMode"（soft/strict/off）。'
  if (kind === 'file-only') {
    return '投下プロンプトを「ファイルに書いた」と述べるだけで、CLI に区切り付きで掲載していません。' + common
  }
  return '貼り付け文をコードフェンスだけで出しています。CLI ではフェンスの枠が見えず、コピー範囲が分かりません。' + common
}

/** 純粋判定。block 対象なら block-JSON 文字列、無ければ ''。 */
function detect(env, stdinJson) {
  let text
  if (env.PDG_TEXT !== undefined) text = env.PDG_TEXT
  else text = lat.lastAssistantText(env, stdinJson)
  const kind = judge(text)
  if (!kind) return ''
  return JSON.stringify({ decision: 'block', reason: reasonFor(kind) }, null, 2)
}

if (require.main === module) {
  try {
    const stdin = process.env.PDG_STDIN_JSON ? lat.readStdinJson() : null
    const out = detect(process.env, stdin)
    if (out) process.stdout.write(out + '\n')
  } catch {
    /* fail-open */
  }
  process.exit(0)
}

module.exports = { detect, judge }
