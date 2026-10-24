#!/usr/bin/env node
/*
 * handover-declaration-gate.test.cjs — 検出核 handover-declaration-detect.cjs の dry-run テスト。
 * §2 検証の非分岐: 本番と同じ detect() を require。CCPIT_071 §7 AC1〜7・10・r1レビュー追加2件をカバー。
 * 実行: node handover-declaration-gate.test.cjs（0=全 PASS / 1=FAIL）
 */
'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('assert')
const { detect, hasJudgmentEvidenceTable, hasDecisionBlockUnderH1 } = require('./handover-declaration-detect.cjs')
const { stripFences } = require('./last-human-text.cjs')

let pass = 0, fail = 0
function test(name, fn) {
  try { fn(); pass++; console.log('  OK  ' + name) }
  catch (e) { fail++; console.log('  NG  ' + name + ' :: ' + e.message) }
}
const isBlock = (o) => !!o && JSON.parse(o).decision === 'block'
const reasonOf = (o) => JSON.parse(o).reason

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hdg-'))
function writeFile(name, content) {
  const p = path.join(TMP, name)
  fs.writeFileSync(p, content)
  return p
}

const DROP = '以降のPATHのファイルの指示に従い、実行してください。'

const orderGoodPath = writeFile(
  'order-good.md',
  '# 発注\n\n## 受け入れ条件\n\n| # | 条件 | 判定方法 | 証跡の形 | 区分 |\n|---|---|---|---|---|\n| 1 | x | y | z | MUST |\n'
)
const orderBadPath = writeFile('order-bad.md', '# 発注\n\nただの文章。表は無い。\n')
const orderMissingPath = path.join(TMP, 'order-missing.md')

const reportGoodPath = writeFile(
  'report-good.md',
  '# タイトル\n\n> [!DECISION]\n> 今回は handover-cc に準拠していません。理由: x\n\n## 2. 節\n\n本文\n'
)
const reportNoBlockPath = writeFile('report-no-block.md', '# タイトル\n\n## 2. 節\n\n判断ブロック無し\n')

test('hasJudgmentEvidenceTable: 判定方法・証跡の見出し表あり', () => {
  assert.strictEqual(hasJudgmentEvidenceTable(fs.readFileSync(orderGoodPath, 'utf8')), true)
})
test('hasJudgmentEvidenceTable: 表なし', () => {
  assert.strictEqual(hasJudgmentEvidenceTable(fs.readFileSync(orderBadPath, 'utf8')), false)
})
test('hasJudgmentEvidenceTable: コードフェンス内の偽表は数えない', () => {
  const md = '# x\n\n```\n| 判定方法 | 証跡 |\n|---|---|\n```\n'
  assert.strictEqual(hasJudgmentEvidenceTable(md), false)
})
test('hasDecisionBlockUnderH1: H1直下にあり', () => {
  assert.strictEqual(hasDecisionBlockUnderH1(fs.readFileSync(reportGoodPath, 'utf8')), true)
})
test('hasDecisionBlockUnderH1: 無い', () => {
  assert.strictEqual(hasDecisionBlockUnderH1(fs.readFileSync(reportNoBlockPath, 'utf8')), false)
})
test('hasDecisionBlockUnderH1: H2より後にあっても数えない', () => {
  const md = '# x\n\n## 2\n\n> [!DECISION]\n> 準拠していません\n'
  assert.strictEqual(hasDecisionBlockUnderH1(md), false)
})
test('stripFences: フェンス内を除去（```）', () => {
  assert.strictEqual(stripFences('前\n```\n秘密\n```\n後'), '前\n後')
})
test('stripFences: フェンス内を除去（~~~、Codexレビュー指摘[3]反映）', () => {
  assert.strictEqual(stripFences('前\n~~~\n秘密\n~~~\n後'), '前\n後')
})
test('stripFences: 開始フェンスより短い連は閉じない（4連の中に3連が現れても閉じない）', () => {
  const input = '前\n````\n内側の```で閉じない\n````\n後'
  assert.strictEqual(stripFences(input), '前\n後')
})

// --- AC6/AC7: 発注でない・本文が空・転写不在は非block ---
test('AC6: 発注でない貼り付け（定型文言なし）は非block', () => {
  assert.strictEqual(detect({ HDG_TEXT: 'コミットメッセージ: fix: xxx\nhttps://example.com/pr/1' }), '')
})
test('AC7: 本文が空は非block', () => {
  assert.strictEqual(detect({ HDG_TEXT: '' }), '')
})
test('AC7: 転写不在（HDG_TEXT未指定）は非block', () => {
  assert.strictEqual(
    detect({ LAT_TRANSCRIPT: path.join(os.tmpdir(), 'nope-' + Date.now() + '.jsonl') }),
    ''
  )
})

// --- AC1: 発注の型: 行が無い ---
test('AC1: 発注の型:行が無いと block', () => {
  const out = detect({ HDG_TEXT: DROP + '"' + orderGoodPath + '"' })
  assert.ok(isBlock(out))
  assert.ok(/missing-declaration/.test(reasonOf(out)))
})

// --- AC2: 指示MDのパスが実在しない ---
test('AC2: 指示MDのパス不在は block', () => {
  const out = detect({ HDG_TEXT: DROP + '"' + orderMissingPath + '"\n発注の型: handover-cc 準拠' })
  assert.ok(isBlock(out))
  assert.ok(/order-path-missing/.test(reasonOf(out)))
})

// --- AC3: 準拠だが表が無い／準拠で表があれば通す ---
test('AC3: 「準拠」だが判定方法・証跡の表が無いと block', () => {
  const out = detect({ HDG_TEXT: DROP + '"' + orderBadPath + '"\n発注の型: handover-cc 準拠' })
  assert.ok(isBlock(out))
  assert.ok(/missing-ac-table/.test(reasonOf(out)))
})
test('AC2/AC3 通過: 「準拠」で実在パス＋表ありは非block', () => {
  const out = detect({ HDG_TEXT: DROP + '"' + orderGoodPath + '"\n発注の型: handover-cc 準拠' })
  assert.strictEqual(out, '')
})

// --- AC4: 非準拠で報告書MD不在／判断ブロック不在 ---
function nonCompliantText(reportId, quoted, orderPath) {
  return DROP + '"' + (orderPath || orderGoodPath) + '"\n発注の型: handover-cc 非準拠（報告書: ' + reportId + '／maintainerの返事: 「' + quoted + '」）'
}
test('AC4: report_id の報告書が実在しないと block', () => {
  const out = detect({ HDG_TEXT: nonCompliantText('no-such-report-id', 'まかせます'), HDG_CWD: TMP })
  assert.ok(isBlock(out))
  assert.ok(/report-missing/.test(reasonOf(out)))
})
test('AC4: 報告書はあるが判断ブロックが無いと block', () => {
  const reportId = path.basename(reportNoBlockPath, '.md')
  const out = detect({ HDG_TEXT: nonCompliantText(reportId, 'まかせます'), HDG_CWD: TMP })
  assert.ok(isBlock(out))
  assert.ok(/missing-decision-block/.test(reasonOf(out)))
})

// --- AC5 / r1レビュー: 人間の返事の逐語確認 ---
// HDG_RECORDS はパース済みオブジェクト配列を期待する（lht.loadRecords の出力形と同じ）。
// paste-delimiter 系テストの rec()（JSONL文字列を作る版）とは目的が違うので混同しない。
function rec(type, content, isMeta) {
  const m = { type, message: { role: type, content } }
  if (isMeta !== undefined) m.isMeta = isMeta
  return m
}
const reportGoodId = path.basename(reportGoodPath, '.md')
const presentTurn = rec('assistant', [
  { type: 'text', text: '報告書を示します。今回は handover-cc に準拠していません。報告書: ' + reportGoodId }
])

test('AC5: 提示ターンより後に人間が「まかせます」→ 通す', () => {
  const records = [presentTurn, rec('user', 'まかせます')]
  const out = detect({
    HDG_TEXT: nonCompliantText(reportGoodId, 'まかせます'),
    HDG_CWD: TMP,
    HDG_RECORDS: records
  })
  assert.strictEqual(out, '')
})

test('AC5: 人間の生発言に逐語が無いと block', () => {
  const records = [presentTurn, rec('user', 'だめです')]
  const out = detect({
    HDG_TEXT: nonCompliantText(reportGoodId, 'まかせます'),
    HDG_CWD: TMP,
    HDG_RECORDS: records
  })
  assert.ok(isBlock(out))
  assert.ok(/reply-not-confirmed/.test(reasonOf(out)))
})

test('AC5: 逐語がツール結果にしか無いと block（人間発言として数えない）', () => {
  const records = [presentTurn, rec('user', [{ type: 'tool_result', content: 'まかせます' }])]
  const out = detect({
    HDG_TEXT: nonCompliantText(reportGoodId, 'まかせます'),
    HDG_CWD: TMP,
    HDG_RECORDS: records
  })
  assert.ok(isBlock(out))
})

test('AC5: 逐語が停止フック差し戻し文（isMeta:true）にしか無いと block', () => {
  const records = [presentTurn, rec('user', 'Stop hook feedback:\nまかせます、という指摘があります', true)]
  const out = detect({
    HDG_TEXT: nonCompliantText(reportGoodId, 'まかせます'),
    HDG_CWD: TMP,
    HDG_RECORDS: records
  })
  assert.ok(isBlock(out))
})

test('AC5: 逐語がタスク通知文（isMeta無し・既知パターン）にしか無いと block', () => {
  const records = [presentTurn, rec('user', '<task-notification>まかせます、と書いてあります</task-notification>')]
  const out = detect({
    HDG_TEXT: nonCompliantText(reportGoodId, 'まかせます'),
    HDG_CWD: TMP,
    HDG_RECORDS: records
  })
  assert.ok(isBlock(out))
})

test('r1レビュー追加1: 報告書の提示と投下が同じ返答内（提示ターンが現在ターンより前に無い）→ block', () => {
  // 提示マーカーが「現在のターン」の中にしか無い（過去に提示ターンが存在しない）
  const records = [rec('user', '無関係な過去の発言。まかせます。')]
  const sameTurnText =
    '報告書を示します。今回は handover-cc に準拠していません。報告書: ' +
    reportGoodId +
    '\n\n' +
    nonCompliantText(reportGoodId, 'まかせます')
  const out = detect({ HDG_TEXT: sameTurnText, HDG_CWD: TMP, HDG_RECORDS: records })
  assert.ok(isBlock(out))
  assert.ok(/reply-not-anchored/.test(reasonOf(out)))
})

test('r1レビュー追加2: 承認後に無関係な一言が挟まっても、提示ターン後の人間発言全件から見つかれば通す', () => {
  const records = [presentTurn, rec('user', 'まかせます'), rec('user', 'あと急いでね')]
  const out = detect({
    HDG_TEXT: nonCompliantText(reportGoodId, 'まかせます'),
    HDG_CWD: TMP,
    HDG_RECORDS: records
  })
  assert.strictEqual(out, '')
})

test('コードフェンス内のデコイ report_id は提示と認めない', () => {
  const decoyTurn = rec('assistant', [
    { type: 'text', text: '例:\n```\n報告書: ' + reportGoodId + ' 今回は handover-cc に準拠していません\n```\n' }
  ])
  const records = [decoyTurn, rec('user', 'まかせます')]
  const out = detect({
    HDG_TEXT: nonCompliantText(reportGoodId, 'まかせます'),
    HDG_CWD: TMP,
    HDG_RECORDS: records
  })
  assert.ok(isBlock(out))
  assert.ok(/reply-not-anchored/.test(reasonOf(out)))
})

test('AC10: report_id が再提示された場合、直近の提示ターンを起点に使う', () => {
  const oldPresent = rec('assistant', [
    { type: 'text', text: '古い提示。今回は handover-cc に準拠していません。報告書: ' + reportGoodId }
  ])
  const records = [
    oldPresent,
    rec('user', '無関係の返事その1'),
    presentTurn, // 直近の再提示
    rec('user', 'まかせます')
  ]
  const out = detect({
    HDG_TEXT: nonCompliantText(reportGoodId, 'まかせます'),
    HDG_CWD: TMP,
    HDG_RECORDS: records
  })
  assert.strictEqual(out, '')
})

test('AC10: 壊れたJSONL行・末尾不完全行があっても他の行は読める', () => {
  const brokenLines = [
    '{not valid json',
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '報告書を示します。今回は handover-cc に準拠していません。報告書: ' + reportGoodId }] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'まかせます' } })
  ]
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hdg-tp-')), 'x.jsonl')
  fs.writeFileSync(f, brokenLines.join('\n') + '\n{"type":"user"') // 末尾不完全行
  const out = detect({
    HDG_TEXT: nonCompliantText(reportGoodId, 'まかせます'),
    LAT_TRANSCRIPT: f,
    HDG_CWD: TMP
  })
  assert.strictEqual(out, '')
})

test('AC10: 逐語が短すぎる（1文字）と block', () => {
  const shortReportId = reportGoodId
  const out = detect({
    HDG_TEXT: nonCompliantText(shortReportId, '可'),
    HDG_CWD: TMP,
    HDG_RECORDS: [presentTurn, rec('user', '可')]
  })
  assert.ok(isBlock(out))
  assert.ok(/reply-quote-too-short/.test(reasonOf(out)))
})

// --- Codex 実装レビュー指摘の反映テスト ---
test('指摘[1]: 非準拠宣言でも指示MDパスの実在検査を適用する', () => {
  const out = detect({
    HDG_TEXT: DROP + '"' + orderMissingPath + '"\n発注の型: handover-cc 非準拠（報告書: ' + reportGoodId + '／maintainerの返事: 「まかせます」）',
    HDG_CWD: TMP
  })
  assert.ok(isBlock(out))
  assert.ok(/order-path-missing/.test(reasonOf(out)))
})
test('指摘[1]: 発注の型: 行より前に quoted path が無い（パス未検出）と block', () => {
  const out = detect({ HDG_TEXT: DROP + '\n発注の型: handover-cc 準拠' })
  assert.ok(isBlock(out))
  assert.ok(/order-path-missing/.test(reasonOf(out)))
})
test('指摘[2]: 先頭 | の無い受け入れ条件表も判定方法・証跡の見出しとして認める', () => {
  const md = '# x\n\n## 受け入れ条件\n条件 | 判定方法 | 証跡の形 | 区分\n---|---|---|---\n1 | a | b | c | MUST\n'
  assert.strictEqual(hasJudgmentEvidenceTable(md), true)
})
test('第2ラウンド指摘[1]: git-bash形式パス（/c/...）も正規化して実在確認できる', () => {
  const winPath = orderGoodPath // 例: C:\...\order-good.md 相当（実際は posix 区切りで作成）
  const drive = winPath[0].toLowerCase()
  const rest = winPath.slice(2).replace(/\\/g, '/')
  const gitBashPath = '/' + drive + rest
  const out = detect({ HDG_TEXT: DROP + '"' + gitBashPath + '"\n発注の型: handover-cc 準拠' })
  assert.strictEqual(out, '')
})
test('第2ラウンド指摘[2]: info-string 付きの行（```js）は閉じフェンスとして数えない', () => {
  const md =
    '# x\n\n```\nダミー\n```js\nまだ閉じない\n```\n\n## 受け入れ条件\n\n| # | 判定方法 | 証跡 |\n|---|---|---|\n| 1 | y | z |\n'
  // 1個目の```で開いたフェンスは、途中の```js（info-string付き）では閉じず、次の素の```まで続く。
  // 旧実装（info-string付きでも閉じると誤判定）だと```jsで誤って閉じ、直後の```が新規フェンス開始と
  // 誤認されてEOFまで閉じなくなり、本物の受け入れ条件表がフェンス内に埋没してfalseになっていた。
  assert.strictEqual(hasJudgmentEvidenceTable(md), true)
})
test('第3ラウンド指摘: HDG_CWD が git-bash形式（/c/...）でも報告書解決できる', () => {
  const drive = TMP[0].toLowerCase()
  const rest = TMP.slice(2).replace(/\\/g, '/')
  const gitBashCwd = '/' + drive + rest
  const out = detect({
    HDG_TEXT: nonCompliantText(reportGoodId, 'まかせます'),
    HDG_CWD: gitBashCwd,
    HDG_RECORDS: [presentTurn, rec('user', 'まかせます')]
  })
  assert.strictEqual(out, '')
})
test('指摘[5]: report_id が複数ファイルに一致する（曖昧）と解決不能で null', () => {
  const dupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hdg-dup-'))
  const dupId = 'dup-report-id'
  fs.writeFileSync(path.join(dupDir, dupId + '.md'), '# x\n\n> [!DECISION]\n> 今回は handover-cc に準拠していません\n')
  fs.mkdirSync(path.join(dupDir, 'sub'))
  fs.writeFileSync(path.join(dupDir, 'sub', dupId + '.md'), '# y\n\n> [!DECISION]\n> 今回は handover-cc に準拠していません\n')
  const resolved = require('./handover-declaration-detect.cjs').resolveReportPath(dupDir, dupId)
  assert.strictEqual(resolved, null)
})

console.log(`\n=== handover-declaration-detect: ${pass} passed, ${fail} failed ===`)
process.exit(fail === 0 ? 0 : 1)
