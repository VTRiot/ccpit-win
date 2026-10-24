#!/usr/bin/env node
/*
 * file-url-backtick-gate.test.cjs — 検出核 file-url-backtick-detect.cjs の単体試験と、bash 足場を通す試験。
 * 実行: node file-url-backtick-gate.test.cjs（0=全 PASS / 1=FAIL）
 */
'use strict'
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { detect, judge } = require('./file-url-backtick-detect.cjs')

let pass = 0, fail = 0
function test(name, fn) {
  try { fn(); pass++; console.log('  OK  ' + name) }
  catch (e) { fail++; console.log('  NG  ' + name + ' :: ' + e.message) }
}
const URL = 'file:///C:/Work/Some_Project/_Prompt/002_%E5%A0%B1%E5%91%8A_%E6%9B%B8.html'

// --- 単体（判定） ---
test('裸の URL → block', () => assert.ok(judge('報告書: ' + URL)))
test('実際に壊れた形（見出しの直後に裸の URL）→ block', () => assert.ok(judge('【HTML報告書】' + URL)))
test('行頭の裸の URL → block', () => assert.ok(judge('結果\n' + URL + '\n以上')))
test('大文字の FILE:/// → block', () => assert.ok(judge('見て ' + URL.replace('file', 'FILE'))))
test('表のセルの中の裸の URL → block', () => assert.ok(judge('| 報告書 | ' + URL + ' |')))
test('インラインコードで囲む → 非 block', () => assert.strictEqual(judge('報告書: `' + URL + '`'), null))
test('二重バッククォートで囲む → 非 block', () => assert.strictEqual(judge('報告書: `` ' + URL + ' ``'), null))
test('``` のコードブロックの中 → 非 block', () => assert.strictEqual(judge('貼る:\n```text\n' + URL + '\n```\n以上'), null))
test('~~~ のコードブロックの中 → 非 block', () => assert.strictEqual(judge('~~~\n' + URL + '\n~~~'), null))
test('語としての `file:///` への言及 → 非 block', () => assert.strictEqual(judge('返信に添える `file:///`（エンコード済・コード表記）を守る'), null))
test('閉じていないバッククォートは囲みにならない → block', () => assert.ok(judge('片側だけ `' + URL)))
test('空行をまたぐバッククォートは組にならない → block', () => assert.ok(judge('段落 `a\n\n' + URL + ' と b`')))
test('囲みが 1 つ・裸が 1 つ混在 → block', () => assert.ok(judge('`' + URL + '` と ' + URL)))
test('http(s) の URL は対象外 → 非 block', () => assert.strictEqual(judge('https://example.com/a_b_c'), null))
test('空本文は fail-open', () => assert.strictEqual(judge(''), null))
test('detect: FUBG_TEXT で block-JSON（reason に書き直し指示）', () => {
  const j = JSON.parse(detect({ FUBG_TEXT: '見て ' + URL }))
  assert.strictEqual(j.decision, 'block')
  assert.ok(/バッククォート/.test(j.reason) && /pathToFileURL/.test(j.reason))
})
test('detect: 転写不在は fail-open', () => assert.strictEqual(detect({ LAT_TRANSCRIPT: 'Z:/nope/none.jsonl' }), ''))

// --- bash 足場を通す試験（転写 fixture・mode・再入・soft） ---
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fubg-'))
const tr = path.join(tmp, 's.jsonl').replace(/\\/g, '/')
const writeTranscript = (text) => fs.writeFileSync(tr,
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'q' }] } }) + '\n' +
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n')
const cfg = (mode) => { const p = path.join(tmp, mode + '.json').replace(/\\/g, '/'); fs.writeFileSync(p, JSON.stringify({ fileUrlBacktickGateMode: mode })); return p }
const gate = path.join(__dirname, 'file-url-backtick-gate.sh').replace(/\\/g, '/')
const sent = path.join(tmp, 'sent').replace(/\\/g, '/')
function runGate(config, active) {
  const input = JSON.stringify({ session_id: 'aaaaaaaa-1111-2222-3333-444444444444', transcript_path: tr, stop_hook_active: !!active })
  const r = spawnSync('bash', [gate], { input, encoding: 'utf8', env: Object.assign({}, process.env, { FUBG_CONFIG: config, FUBG_SENTINEL_DIR: sent }) })
  return { code: r.status, out: (r.stdout || '').trim() }
}
writeTranscript('【HTML報告書】' + URL)
test('足場: 裸の URL を strict（設定なし）で block、exit 0', () => { const r = runGate('/nonexistent'); assert.strictEqual(r.code, 0); assert.strictEqual(JSON.parse(r.out).decision, 'block') })
test('足場: stop_hook_active=true は何も出さない（再入の抑止）', () => assert.strictEqual(runGate('/nonexistent', true).out, ''))
test('足場: off は何も出さない', () => assert.strictEqual(runGate(cfg('off')).out, ''))
test('足場: soft は 1 回目だけ block、2 回目は出さない', () => {
  const c = cfg('soft')
  assert.ok(runGate(c).out.length > 0)
  assert.strictEqual(runGate(c).out, '')
})
writeTranscript('【HTML報告書】`' + URL + '`')
test('足場: 囲んだ URL は strict でも出さない', () => assert.strictEqual(runGate('/nonexistent').out, ''))
fs.rmSync(tmp, { recursive: true, force: true })

console.log(`\n=== file-url-backtick-detect: ${pass} passed, ${fail} failed ===`)
process.exit(fail === 0 ? 0 : 1)
