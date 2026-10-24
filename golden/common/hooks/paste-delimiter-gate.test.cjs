#!/usr/bin/env node
/*
 * paste-delimiter-gate.test.cjs — 検出核 paste-delimiter-detect.cjs の dry-run テスト。
 * §2 検証の非分岐: 本番と同じ detect()/judge() を require。§3: PDG_TEXT と fixture 転写で検証。
 * 実行: node paste-delimiter-gate.test.cjs（0=全 PASS / 1=FAIL）
 */
'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('assert')
const { detect, judge } = require('./paste-delimiter-detect.cjs')
const { lastAssistantTextFromLines } = require('./last-assistant-text.cjs')

let pass = 0, fail = 0
function test(name, fn) {
  try { fn(); pass++; console.log('  OK  ' + name) }
  catch (e) { fail++; console.log('  NG  ' + name + ' :: ' + e.message) }
}
const isBlock = (o) => !!o && JSON.parse(o).decision === 'block'

const GOOD =
  '実装レーンへの投下プロンプト。区切り行はコピーに含めない。\n\n＝＝＝＝＝ ここから貼る ＝＝＝＝＝\n' +
  '```\n057 §4 を訂正せよ\n```\n＝＝＝＝＝ ここまで ＝＝＝＝＝\n補足は外。'
const BAD_FENCE = '以下を Antigravity に貼ってくれ。\n\n```\n057 §4 を訂正せよ\n```\n'
const BAD_FILE = '投下プロンプトは C:/x/070_m3a-go.md に書いておきました。'
const NO_PASTE = '調査結果:\n```\nls -la\n```\nこれは実行例。'
const HALF = '貼ってくれ。\n━━━━━ ▼ 投下プロンプト ここから ▼ ━━━━━\n```\nx\n```\n（終了行なし）'
const LINE_DELIM = '貼ってくれ。\n----- ここから -----\n本文\n----- ここまで -----'

test('区切り両方あり → 非 block', () => assert.strictEqual(judge(GOOD), null))
test('フェンスのみ → block(fence-without-delimiter)', () => assert.strictEqual(judge(BAD_FENCE), 'fence-without-delimiter'))
test('ファイルに書いたと述べるだけ → block(file-only)', () => assert.strictEqual(judge(BAD_FILE), 'file-only'))
test('貼り付け語なしのフェンスは対象外', () => assert.strictEqual(judge(NO_PASTE), null))
test('開始行だけで終了行なし → block', () => assert.strictEqual(judge(HALF), 'fence-without-delimiter'))
test('ハイフン区切り（フェンス無し）も区切りとして許容', () => assert.strictEqual(judge(LINE_DELIM), null))
test('空本文は fail-open', () => assert.strictEqual(judge(''), null))

test('detect: PDG_TEXT 注入で block-JSON', () => {
  const out = detect({ PDG_TEXT: BAD_FENCE })
  assert.ok(isBlock(out))
  assert.ok(/ここから貼る/.test(JSON.parse(out).reason))
})
test('detect: 転写不在は fail-open', () => {
  assert.strictEqual(detect({ LAT_TRANSCRIPT: path.join(os.tmpdir(), 'nope-' + Date.now() + '.jsonl') }), '')
})

// fixture 転写: user → assistant(text) → assistant(tool_use) → user(tool_result) → assistant(text)
function rec(type, content) { return JSON.stringify({ type, message: { role: type, content } }) }
test('転写: ターン内の分割チャンクを連結して判定（区切りが後半チャンクにあれば非 block）', () => {
  const lines = [
    rec('user', [{ type: 'text', text: 'やって' }]),
    rec('assistant', [{ type: 'text', text: '貼ってくれ。\n＝＝＝＝＝ ここから貼る ＝＝＝＝＝\n```\nx\n```' }]),
    rec('assistant', [{ type: 'tool_use', name: 'Bash', input: {} }]),
    rec('user', [{ type: 'tool_result', content: 'ok' }]),
    rec('assistant', [{ type: 'text', text: '＝＝＝＝＝ ここまで ＝＝＝＝＝' }])
  ]
  const t = lastAssistantTextFromLines(lines.join('\n') + '\n')
  assert.strictEqual(judge(t), null)
})
test('転写: 直前ターンの違反は拾わない（最終が user 発話なら空）', () => {
  const lines = [rec('assistant', [{ type: 'text', text: BAD_FENCE }]), rec('user', [{ type: 'text', text: '次' }])]
  assert.strictEqual(lastAssistantTextFromLines(lines.join('\n') + '\n'), '')
})
test('転写 fixture ファイル経由で block', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pdg-')), 'x.jsonl')
  fs.writeFileSync(f, rec('user', [{ type: 'text', text: 'q' }]) + '\n' + rec('assistant', [{ type: 'text', text: BAD_FILE }]) + '\n')
  assert.ok(isBlock(detect({ LAT_TRANSCRIPT: f })))
})

console.log(`\n=== paste-delimiter-detect: ${pass} passed, ${fail} failed ===`)
process.exit(fail === 0 ? 0 : 1)
