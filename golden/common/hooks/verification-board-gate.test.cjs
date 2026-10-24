#!/usr/bin/env node
/*
 * verification-board-gate.test.cjs — 検出核 verification-board-detect.cjs の dry-run テスト。
 *
 * testable-stop-hook-gate-authoring §2（検証の非分岐）: 本番と同じ detect() を require で再利用する
 * （bash grep 二重実装をしない）。§3: env 注入 + isolated fixture で免除/block/fail-open を検証。
 *
 * 実行: node verification-board-gate.test.cjs  （終了コード 0=全 PASS / 1=FAIL）
 */
'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('assert')
const { detect } = require('./verification-board-detect.cjs')

const T8 = '20260714'
const T6 = '260714'
let pass = 0
let fail = 0

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vbg-test-'))
}
function writeMd(dir, name, frontmatter) {
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, name)
  fs.writeFileSync(p, '---\n' + frontmatter + '\n---\n\n# body\n', 'utf8')
  return p
}
function touch(dir, name) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), 'x', 'utf8')
}
function baseEnv(root, over) {
  return Object.assign(
    { VBG_PROJECT_DIR: root, VBG_PROMPT_DIR: path.join(root, '_Prompt'), VBG_CHANGES: '1', VBG_TODAY_8: T8, VBG_TODAY_6: T6 },
    over || {}
  )
}
function isBlock(out) {
  if (!out) return false
  const j = JSON.parse(out)
  return j.decision === 'block'
}
function test(name, fn) {
  try {
    fn()
    pass++
    console.log('  OK  ' + name)
  } catch (e) {
    fail++
    console.log('  NG  ' + name + ' :: ' + e.message)
  }
}

// 1. コード変更なし → 非 block（VBG_CHANGES 空）
test('変更なしは常に非 block', () => {
  const root = mkTmp()
  const bd = path.join(root, '_Prompt', '02_buildai')
  writeMd(bd, `${T8}_0231_report.md`, 'status: completed-pending-user-verification')
  const out = detect(baseEnv(root, { VBG_CHANGES: '' }))
  assert.strictEqual(out, '')
})

// 2. 視認待ち報告 + ボードなし → block
test('視認待ち報告でボード無しは block', () => {
  const root = mkTmp()
  const bd = path.join(root, '_Prompt', '02_buildai')
  writeMd(bd, `${T8}_0231_report.md`, 'status: completed-pending-user-verification')
  const out = detect(baseEnv(root))
  assert.ok(isBlock(out), 'block を期待')
  assert.ok(/視認ボード/.test(JSON.parse(out).reason))
})

// 3. 視認待ち報告 + 同ディレクトリにボードあり → 非 block
test('同ディレクトリに視認ボードがあれば非 block', () => {
  const root = mkTmp()
  const bd = path.join(root, '_Prompt', '02_buildai')
  writeMd(bd, `${T8}_0231_report.md`, 'status: completed-pending-user-verification')
  touch(bd, `${T8}_視認ボード.html`)
  const out = detect(baseEnv(root))
  assert.strictEqual(out, '')
})

// 4. 視認待ちでない報告（closed）→ 非 block
test('status が closed の報告は対象外（非 block）', () => {
  const root = mkTmp()
  const bd = path.join(root, '_Prompt', '02_buildai')
  writeMd(bd, `${T8}_0231_report.md`, 'status: closed')
  const out = detect(baseEnv(root))
  assert.strictEqual(out, '')
})

// 5. _Prompt 不在 → fail-open（非 block）
test('_Prompt 不在は fail-open（非 block）', () => {
  const root = mkTmp()
  const out = detect(baseEnv(root))
  assert.strictEqual(out, '')
})

// 6. 昨日付けの視認待ち報告は対象外（今日付けのみ）
test('今日付けでない報告は対象外（非 block）', () => {
  const root = mkTmp()
  const bd = path.join(root, '_Prompt', '02_buildai')
  writeMd(bd, `20260713_0231_report.md`, 'status: completed-pending-user-verification')
  const out = detect(baseEnv(root))
  assert.strictEqual(out, '')
})

// 7. output_dir 明示先にボードがあれば非 block（絶対パス）
test('output_dir 明示先のボードを見る（絶対パス）', () => {
  const root = mkTmp()
  const md = path.join(root, '_Prompt', '01_designai')
  const boardDir = path.join(root, 'boards')
  const abs = boardDir.replace(/\\/g, '/')
  writeMd(md, `${T8}_0231_report.md`, `status: completed-pending-user-verification\noutput_dir: ${abs}`)
  touch(boardDir, `${T8}_視認ボード.html`)
  const out = detect(baseEnv(root))
  assert.strictEqual(out, '')
})

// 8. board を含む英名 HTML も許容（大小無視）
test('board を含む英名 HTML も視認ボードとして許容', () => {
  const root = mkTmp()
  const bd = path.join(root, '_Prompt', '02_buildai')
  writeMd(bd, `${T6}_0231_report.md`, 'status: completed-pending-user-verification')
  touch(bd, `${T6}_FB01_Board.html`)
  const out = detect(baseEnv(root))
  assert.strictEqual(out, '')
})

console.log(`\n=== verification-board-detect: ${pass} passed, ${fail} failed ===`)
process.exit(fail === 0 ? 0 : 1)
