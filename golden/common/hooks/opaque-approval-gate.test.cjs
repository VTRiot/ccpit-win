#!/usr/bin/env node
/*
 * opaque-approval-gate.test.cjs — 検出核 opaque-approval-detect.cjs の dry-run テスト。
 * 実行: node opaque-approval-gate.test.cjs（0=全 PASS / 1=FAIL）
 */
'use strict'
const assert = require('assert')
const { detect, judge } = require('./opaque-approval-detect.cjs')

let pass = 0, fail = 0
function test(name, fn) {
  try { fn(); pass++; console.log('  OK  ' + name) }
  catch (e) { fail++; console.log('  NG  ' + name + ' :: ' + e.message) }
}

test('「承認③は案Cでいいですか」→ block', () => assert.strictEqual(judge('承認③は案Cでいいですか？'), 'numbered-gate'))
test('「承認3 でいいか」（半角番号）→ block', () => assert.strictEqual(judge('承認3 でいいか'), 'numbered-gate'))
test('「案C でいいですか」→ block', () => assert.strictEqual(judge('案C でいいですか'), 'letter-option'))
test('「Plan B にしますか」→ block', () => assert.strictEqual(judge('Plan B にしますか'), 'letter-option'))
test('「A/B/C のどれにしますか」→ block(menu)', () => assert.strictEqual(judge('A/B/C のどれにしますか'), 'menu'))
test('括弧で中身を補っても符牒が主語なら block', () => assert.strictEqual(judge('承認②（プランの承認）でいいですか'), 'numbered-gate'))
test('中身の名前で聞く → 非 block', () => assert.strictEqual(judge('実装レーンの 070 Plan（pxpipe を Opus に切り替える手順）を承認していいか。推奨は承認。'), null))
test('質問でない文中の番号は対象外（「承認記録 approvals/069-r3.json」等）', () => assert.strictEqual(judge('承認記録 approvals/069-r3.json を保存した。'), null))
test('年月日・時刻の数字は誤検知しない', () => assert.strictEqual(judge('確認 2026-09-25 05:00 の記録ですか'), null))
test('「ステップ 12 まで完了」は質問語なしなら非 block', () => assert.strictEqual(judge('ステップ 12 まで完了した。'), null))
test('空本文は fail-open', () => assert.strictEqual(judge(''), null))
test('detect: OAG_TEXT で block-JSON（reason に書き直し指示）', () => {
  const out = detect({ OAG_TEXT: '承認③は案Cでいいですか' })
  const j = JSON.parse(out)
  assert.strictEqual(j.decision, 'block')
  assert.ok(/中身の名前/.test(j.reason))
})
test('detect: 転写不在は fail-open', () => assert.strictEqual(detect({ LAT_TRANSCRIPT: 'Z:/nope/none.jsonl' }), ''))

console.log(`\n=== opaque-approval-detect: ${pass} passed, ${fail} failed ===`)
process.exit(fail === 0 ? 0 : 1)
