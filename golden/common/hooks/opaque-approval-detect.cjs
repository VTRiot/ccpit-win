#!/usr/bin/env node
/*
 * opaque-approval-detect.cjs — 「符牒で承認を求める質問」禁止ゲートの検出核（純粋判定）。
 *
 * 背景: 「承認③は案Cでいいですか」のように、番号・記号だけで判断を求めると、人間には何を承認するのか
 *   復元できず、聞き返しで 1 ターン無駄になる。maintainer逐語（2026-09-20）「『実装レーンのプランを承認して
 *   いいか』という聞き方にしてほしい」。memory 3 本（09-03 / 09-20 / 09-24）に書かれても再発した。
 *
 * 判定（最後の assistant 応答本文に対して）: 次のいずれかを含めば block。
 *   (1) 承認/確認/判断/ゲート/ステップ + 丸数字か 1〜2 桁の裸番号（例: 承認③, 承認3, ゲート 2）
 *   (2) 案[A-Z] / Option [A-Z] / プラン[A-Z] を「で／に／を／か」で受けた質問（例: 案Cでいいですか、A か B か）
 *   (3) 選択肢を「A/B/C」「A・B・C」のメニュー形で並べる（判断の丸投げ。present-decisions-not-decision-trees）
 *   ただし括弧で中身を補っていても符牒が主語なら block（符牒を主語にした時点で「それ何だっけ」を誘発する）。
 *
 * fail-open: 転写が読めない・本文が空 → 非 block。
 * env: LAT_TRANSCRIPT / LAT_SESSION_ID / OAG_TEXT（本文直接注入）
 */
'use strict'
const lat = require('./last-assistant-text.cjs')

const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮'
const NUMBERED_GATE_RE = new RegExp('(承認|確認|判断|ゲート|ステップ|段階)\\s?(?:[' + CIRCLED + ']|[0-9０-９]{1,2}(?![0-9０-９.\\-/年月日時分秒%]))')
const LETTER_OPTION_RE = /(案|プラン|オプション|Option|Plan)\s?[A-Z]\s?(で|に|を|か|が|は)/
const MENU_RE = /(^|\s|「)[A-C](\s?[\/／・]\s?[A-C]){1,}(\s|」|の|で|か|$)/m
const QUESTION_HINT_RE = /(ですか|ますか|でしょうか|でいい|いいか|よいか|どちら|どれ|選ん|承認|決めて|判断|\?|？)/

function judge(text) {
  if (!text) return null
  if (!QUESTION_HINT_RE.test(text)) return null
  if (NUMBERED_GATE_RE.test(text)) return 'numbered-gate'
  if (LETTER_OPTION_RE.test(text)) return 'letter-option'
  if (MENU_RE.test(text)) return 'menu'
  return null
}

function reasonFor(kind) {
  const head = {
    'numbered-gate': '「承認③」「ゲート 2」のように番号だけで判断を求めています。',
    'letter-option': '「案C でいいですか」のように符牒で選択を求めています。',
    'menu': '「A/B/C」のメニュー形で選択肢を並べています（判断の丸投げ）。'
  }[kind]
  return (
    head +
    '人間には番号・記号が何を指すか復元できません。書き直し: (1) 答えてほしいことを中身の名前で一文にする（例:「実装レーンの 070 Plan（pxpipe を Opus に切り替える手順）を承認していいか」）。' +
    '(2) 推奨を 1 つ決めて理由 1 行。(3) 棄却した案とその理由を並べる（隠さない）。(4) 符牒は使わない。A/B/C メニューは出さず、既定値つき Yes/No 1 問にする。' +
    '根拠: rules/paste-and-approval-phrasing（memory 3 本を統合）。抑制: ~/.ccpit/app-config.json の "opaqueApprovalGateMode"（soft/strict/off）。'
  )
}

function detect(env, stdinJson) {
  const text = env.OAG_TEXT !== undefined ? env.OAG_TEXT : lat.lastAssistantText(env, stdinJson)
  const kind = judge(text)
  if (!kind) return ''
  return JSON.stringify({ decision: 'block', reason: reasonFor(kind) }, null, 2)
}

if (require.main === module) {
  try {
    const stdin = process.env.OAG_STDIN_JSON ? lat.readStdinJson() : null
    const out = detect(process.env, stdin)
    if (out) process.stdout.write(out + '\n')
  } catch {
    /* fail-open */
  }
  process.exit(0)
}

module.exports = { detect, judge }
