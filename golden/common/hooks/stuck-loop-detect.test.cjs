'use strict'
// stuck-loop-detect.v4.cjs の単体テスト。記録形状は 2026-09-12 のプローブ transcript の実測に合わせる。
// 検証する性質（v4 = 理由別 count・=== THRESHOLD・human でエピソード終了・壊れた行は沈黙）:
//   T1  2 件 → 沈黙                          T2  3 件 → 出る（形式契約）
//   T3  3 件 + 注入 → 沈黙                   T4  3+注入+2 沈黙 / 3+注入+3 出る / 3+注入+3+注入+3 出る / …+2 沈黙
//   T5  注入が認識されないまま 4 件・6 件 → 沈黙（=== の意味: 認識不能な注入は「無視」され count が伸びて出ない。沈黙ではなく無視——
//       同じ状態で再び呼ばれれば再び出る（T15b/c）。「出さない側」への一般化はしない——第 6 巡 32）
//   T6  理由切替: A×3+注入A+B×3 出る(B) / +注入B 沈黙 / +A×1 沈黙 / A,A,B,A（無注入）→ 出る(A)（理由別積算）
//   T7  人間の発言でエピソード終了: A×2+human+A×1 → 沈黙 / A×2+human+A×3 → 出る
//   T8  別 key の注入は count を戻さない → 出る
//   T9  tool_result 配列の user 記録は block でも human でもない: A×2+toolres+A×1 → 出る
//   T10 壊れた行: 3 件の間に壊れた行 → 沈黙 / 注入行が壊れた（3+壊れ+asst）→ 沈黙 / 切替行が壊れた → 沈黙
//   T11 transcript 不在 → 沈黙 exit 0
//   T12 足場: 正常核は転送 / exit 1 核 沈黙 / decision 沈黙 / \u0064ecision 沈黙 / null 沈黙 / 配列 沈黙 / 余分キー 沈黙 / 非 JSON 沈黙 / v1 形 systemMessage は転送
//   T13 v1 fixture: 例外なく判定でき、出る ⇔ 末尾理由の件数がちょうど 3
//   T14 窓: 窓が先頭を含まない場合は境界（boundary / inject(key)）が窓内にある時だけ出る。境界なし → 沈黙、4→3 の窓外脱落 → 沈黙
//   T15 前提の限界（第 3 巡 22）: 注入が記録されずに同じ状態で再び呼ばれると再び出る——保証しないことを固定
//   T9c 配列 content の user 記録（text 配列）は boundary にならない（第 3 巡 24）
//   T16 観測ログ: 既定無効・許可先限定・上限超で追記しない・書けなくても出力不変・正当な再発火（inj 増）と重複（inj/bnd 不変）を区別できる粒度
const { spawnSync } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const os = require('os')

const HOOKS = __dirname
const CORE = path.join(HOOKS, 'stuck-loop-detect.cjs')
const GATE = path.join(HOOKS, 'stuck-loop-gate.sh')
const TMPD = fs.mkdtempSync(path.join(os.tmpdir(), 'sld-v4-'))
const V1FIX = path.join(HOOKS, 'stuck-loop-detect.fixture-loop.jsonl')
const core = require(CORE)

let fail = 0
let n = 0
let skipped = 0
function check(name, cond, detail) {
  n++
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''))
  if (!cond) fail++
}
// 環境上その検査を実行できない時だけ使う（PASS には数えない。RESULT 行に件数を出す）
function skip(name, why) {
  skipped++
  console.log('SKIP ' + name + '  ' + why)
}

const blk = (r) => JSON.stringify({ type: 'user', message: { role: 'user', content: 'Stop hook feedback:\n' + r } })
const asst = (t) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t || 'working' }] } })
const inj = (key, nid) => JSON.stringify({ type: 'attachment', attachment: { type: 'hook_additional_context', content: ['【反復検知 ' + key + '】' + (nid ? ' (nid:' + nid + ')' : '') + ' 同一理由の停止フック発火が…'], hookName: 'Stop', hookEvent: 'Stop' }, uuid: 'x' })
const toolres = (t) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: t }] } })
const human = (t) => JSON.stringify({ type: 'user', message: { role: 'user', content: t || '次はこれをやって' } })

function write(name, lines) {
  const p = path.join(TMPD, name + '.jsonl')
  fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8')
  return p
}
function run(tp, c) {
  const r = spawnSync(process.execPath, [c || CORE], { input: JSON.stringify({ transcript_path: tp }), encoding: 'utf8', env: Object.assign({}, process.env, { SLD_LOG: '' }) })
  return { out: (r.stdout || '').trim(), status: r.status }
}
function parsed(out) {
  try { return JSON.parse(out) } catch (e) { return null }
}
function keyOf(out) {
  const j = parsed(out)
  const m = j && j.hookSpecificOutput && String(j.hookSpecificOutput.additionalContext).match(/【反復検知 ([0-9a-f]{12})】/)
  return m ? m[1] : null
}
const A = 'テスト理由 A が繰り返し発火している'
const B = 'テスト理由 B（別）が繰り返し発火している'
const seqA = (k) => Array.from({ length: k }, () => [blk(A), asst()]).flat()
const seqB = (k) => Array.from({ length: k }, () => [blk(B), asst()]).flat()

// T1
check('T1 2 件 → 沈黙', run(write('t1', seqA(2))).out === '')

// T2
const t2 = run(write('t2', seqA(3)))
const t2j = parsed(t2.out)
check('T2 3 件 → 出る', !!t2j, t2.out.slice(0, 60))
check('T2 hookEventName=Stop', !!(t2j && t2j.hookSpecificOutput && t2j.hookSpecificOutput.hookEventName === 'Stop'))
check('T2 additionalContext がタグで始まる', !!(t2j && typeof t2j.hookSpecificOutput.additionalContext === 'string' && t2j.hookSpecificOutput.additionalContext.indexOf('【反復検知 ') === 0))
check('T2 decision 無し', t2.out.indexOf('"decision"') < 0)
check('T2 systemMessage 無し', t2.out.indexOf('"systemMessage"') < 0)
check('T2 exit 0', t2.status === 0)
const KA = keyOf(t2.out)
check('T2 key 抽出', !!KA)

// T3
check('T3 3 件 + 注入 → 沈黙', run(write('t3', seqA(3).concat([inj(KA), asst()]))).out === '')

// T4
check('T4a 3+注入+2 → 沈黙', run(write('t4a', seqA(3).concat([inj(KA), asst()], seqA(2)))).out === '')
const t4b = run(write('t4b', seqA(3).concat([inj(KA), asst()], seqA(3))))
check('T4b 3+注入+3 → 出る', keyOf(t4b.out) === KA)
check('T4b 件数は「前回の通知以降」3', /前回の通知以降で 3 件/.test(t4b.out))
check('T4c 3+注入+3+注入+3 → 出る', keyOf(run(write('t4c', seqA(3).concat([inj(KA)], seqA(3), [inj(KA)], seqA(3)))).out) === KA)
check('T4d 3+注入+3+注入+2 → 沈黙', run(write('t4d', seqA(3).concat([inj(KA)], seqA(3), [inj(KA)], seqA(2)))).out === '')

// T5 認識不能は出さない側
check('T5a 4 件 無注入 → 沈黙', run(write('t5a', seqA(4))).out === '')
check('T5b 6 件 無注入 → 沈黙', run(write('t5b', seqA(6))).out === '')
check('T5c 3+注入(認識不能な形状)+3 → 沈黙', run(write('t5c', seqA(3).concat([JSON.stringify({ type: 'attachment', attachment: { type: 'something_else', content: ['【反復検知 ' + KA + '】'] } })], seqA(3)))).out === '')

// T6 理由切替
const t6a = run(write('t6a', seqA(3).concat([inj(KA)], seqB(3))))
const KB = keyOf(t6a.out)
check('T6a A×3+注入A+B×3 → 出る（B）', !!KB && KB !== KA)
check('T6b +注入B → 沈黙', run(write('t6b', seqA(3).concat([inj(KA)], seqB(3), [inj(KB)]))).out === '')
check('T6c +A×1 → 沈黙（A は 0 から 1）', run(write('t6c', seqA(3).concat([inj(KA)], seqB(3), [inj(KB)], seqA(1)))).out === '')
check('T6d A,A,B,A 無注入 → 出る（A の理由別積算 = 3）', keyOf(run(write('t6d', seqA(2).concat(seqB(1), seqA(1)))).out) === KA)
check('T6e A,A,B,B → 沈黙（B は 2）', run(write('t6e', seqA(2).concat(seqB(2)))).out === '')

// T7 human でエピソード終了
check('T7a A×2+human+A×1 → 沈黙', run(write('t7a', seqA(2).concat([human(), asst()], seqA(1)))).out === '')
check('T7b A×2+human+A×3 → 出る', keyOf(run(write('t7b', seqA(2).concat([human(), asst()], seqA(3)))).out) === KA)
check('T7c A×3+human → 沈黙（lastKey 消滅）', run(write('t7c', seqA(3).concat([human()]))).out === '')

// T8
check('T8 別 key の注入は count を戻さない → 出る', keyOf(run(write('t8', seqA(3).concat([inj('000000000000')]))).out) === KA)

// T9
check('T9a tool_result 配列の user 記録は block に数えない', run(write('t9a', seqA(2).concat([toolres('Stop hook feedback:\n' + A)]))).out === '')
check('T9b tool_result 配列の user 記録はエピソードを切らない → 出る', keyOf(run(write('t9b', seqA(2).concat([toolres('ok'), asst()], seqA(1)))).out) === KA)
const textArr = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '自動生成の通知' }] } })
check('T9c text 配列の user 記録も boundary にならない → A×2+配列+A×1 で出る', keyOf(run(write('t9c', seqA(2).concat([textArr, asst()], seqA(1)))).out) === KA)

// T10 壊れた行 → 沈黙
check('T10a 3 件の間に壊れた行 → 沈黙', run(write('t10a', [blk(A), '{broken', asst(), blk(A), 'not json at all', blk(A)])).out === '')
check('T10b 注入行が壊れた（3+壊れ+asst）→ 沈黙', run(write('t10b', seqA(3).concat([inj(KA).slice(0, 40), asst()]))).out === '')
check('T10c 切替行が壊れた（A,A,壊れ,A）→ 沈黙', run(write('t10c', seqA(2).concat([blk(B).slice(0, 30)], seqA(1)))).out === '')
check('T10d 空行・空白行は無視 → 出る', keyOf(run(write('t10d', [blk(A), '', '   ', blk(A), blk(A)])).out) === KA)

// T11
const t11 = run(path.join(TMPD, 'no-such.jsonl'))
check('T11 transcript 不在 → 沈黙 exit 0', t11.out === '' && t11.status === 0)

// T12 bash 足場
const bash = spawnSync('bash', ['--version'], { encoding: 'utf8' })
if (bash.status === 0) {
  const tp = write('t12', seqA(3))
  const input = JSON.stringify({ transcript_path: tp })
  const gate = (c) => spawnSync('bash', [GATE], { input, encoding: 'utf8', env: Object.assign({}, process.env, { SLD_CORE: c, SLD_LOG: '' }) })
  const mk = (name, src) => { const p = path.join(TMPD, name + '.cjs'); fs.writeFileSync(p, src); return p }
  const g1 = gate(CORE)
  check('T12a 足場経由で転送される', keyOf((g1.stdout || '').trim()) === KA && g1.status === 0, (g1.stdout || '').slice(0, 60))
  const silent = (name, src, label) => {
    const g = gate(mk(name, src))
    check('T12 ' + label + ' → 沈黙', (g.stdout || '').trim() === '' && g.status === 0, (g.stdout || '').slice(0, 60))
  }
  silent('bad', 'process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"Stop",additionalContext:"【反復検知 ' + KA + '】"}})+"\\n"); process.exit(1)\n', 'b 出力後に exit 1')
  silent('dec', 'process.stdout.write(JSON.stringify({decision:"block",reason:"x"})+"\\n")\n', 'c decision')
  silent('esc', 'process.stdout.write(\'{"\\\\u0064ecision":"block","reason":"x"}\\n\')\n', 'd \\u0064ecision（エスケープ）')
  silent('nul', 'process.stdout.write("null\\n")\n', 'e null')
  silent('arr', 'process.stdout.write("[1]\\n")\n', 'f 配列')
  silent('ext', 'process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"Stop",additionalContext:"x"},extra:1})+"\\n")\n', 'g 余分な最上位キー')
  silent('ev', 'process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:"x"}})+"\\n")\n', 'h hookEventName が Stop でない')
  silent('junk', 'process.stdout.write("not json\\n")\n', 'i 非 JSON')
  const gv1 = gate(mk('v1', 'process.stdout.write(JSON.stringify({systemMessage:"v1 形"})+"\\n")\n'))
  check('T12j v1 形 systemMessage は転送', (gv1.stdout || '').trim() === '{"systemMessage":"v1 形"}' && gv1.status === 0)
  // 第 3 巡 限定事項: 重複キー（後勝ちで検査を通る）は検査済みオブジェクトの再シリアライズで 1 通りに正規化されて転送される
  const gdup = gate(mk('dup', 'process.stdout.write(\'{"hookSpecificOutput":{"hookEventName":"PreToolUse","hookEventName":"Stop","additionalContext":"x"}}\\n\')\n'))
  check('T12k 重複キーは再シリアライズで 1 通りに正規化されて転送', (gdup.stdout || '').trim() === '{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"x"}}' && gdup.status === 0, (gdup.stdout || '').slice(0, 80))
} else {
  console.log('SKIP T12 bash が無い')
}

// T13 v1 fixture
if (fs.existsSync(V1FIX)) {
  const lines = fs.readFileSync(V1FIX, 'utf8').split('\n')
  let d = null, threw = false
  try { d = core.decide(lines) } catch (e) { threw = true }
  // 期待値は実装と独立に固定する（第 3 巡 28）: fixture は 2026-09-10 事故 transcript の末尾。
  // 末尾の "Stop hook feedback:" user 文字列記録を手で数えると同一理由が 3 件、その前に人間の user 文字列記録がある。
  // 第 4 巡 35: fixture を sha256 で固定し、期待 key / run を定数で照合する（実装から期待値を計算しない）
  const FIX_SHA = '93a9ece95679e20a37e24263012307b5465943de14b1aaf73bbf09dd7331d1ca'
  const FIX_KEY = 'f963a474d1e3'   // 理由「テスト理由 XYZ が繰り返し発火している」の sha256 先頭 12 桁（2026-09-12 に手で確認）
  const sha = crypto.createHash('sha256').update(fs.readFileSync(V1FIX)).digest('hex')
  check('T13 v1 fixture: 内容が固定版と一致（sha256）', sha === FIX_SHA, sha)
  check('T13 v1 fixture: 例外なし', !threw)
  check('T13 v1 fixture: 出る・key と run が固定値と一致', !!d && d.key === FIX_KEY && d.run === 3, JSON.stringify(d))
} else {
  check('T13 v1 fixture が存在する（不在は SKIP ではなく FAIL——第 4 巡 35）', false, V1FIX)
}

// T14 窓（第 3 巡 23: 窓外脱落を通知枠の復活にしない）
const pad = Array.from({ length: 30 }, () => asst('x'.repeat(100 * 1024)))
const bigp = write('t14a', pad.concat([human(), asst()], seqA(3)))
check('T14a 窓が先頭を含まず、窓内に boundary + 3 件 → 出る', fs.statSync(bigp).size > core.WINDOW_BYTES && keyOf(run(bigp).out) === KA)
check('T14b 3 件が窓外・窓内 0 件 → 沈黙', run(write('t14b', seqA(3).concat(pad))).out === '')
const t14t = core.tailInfo(bigp)
check('T14c 窓先頭の断片行は捨てられ、全行が JSON・truncated=true', t14t.truncated && t14t.text.split('\n').filter((l) => l.trim()).every((l) => { try { JSON.parse(l); return true } catch (e) { return false } }))
check('T14d 窓が先頭を含まず、境界なしで 3 件 → 沈黙', run(write('t14d', pad.concat(seqA(3)))).out === '')
// T14e 同じファイルへ追記して窓を動かす: A×1 + 1.5MB + A×3（先頭が窓内・count 4）→ 沈黙。追記で A0 が窓外へ → それでも沈黙
const t14e = write('t14e', seqA(1).concat(pad.slice(0, 15), seqA(3)))
check('T14e-1 先頭が窓内で A×4 → 沈黙', fs.statSync(t14e).size < core.WINDOW_BYTES && run(t14e).out === '')
fs.appendFileSync(t14e, pad.slice(0, 10).join('\n') + '\n')
check('T14e-2 追記で 4 件目が窓外に落ち、窓内 3 件（境界なし）→ 沈黙', fs.statSync(t14e).size > core.WINDOW_BYTES && core.tailInfo(t14e).truncated && run(t14e).out === '')
// T14h 窓内に改行が無い（1 行が 2MiB 超）→ 全体を捨てて沈黙
const t14h = path.join(TMPD,'t14h.jsonl')
fs.writeFileSync(t14h, 'x'.repeat(core.WINDOW_BYTES + 1024) + '\n' + seqA(3).join('\n') + '\n')
check('T14h 窓内に改行が無い → 全体を捨てて沈黙', run(t14h).out === '')
const t14i = path.join(TMPD,'t14i.jsonl')
fs.writeFileSync(t14i, seqA(3).join('\n') + '\n' + 'x'.repeat(core.WINDOW_BYTES + 1024))
check('T14i 窓全体が改行なしの断片 → text は空・沈黙', core.tailInfo(t14i).text === '' && run(t14i).out === '')
check('T14f 窓が先頭を含まず、窓内に inject(A) + 3 件 → 出る', keyOf(run(write('t14f', pad.concat([inj(KA), asst()], seqA(3)))).out) === KA)
check('T14g 窓が先頭を含まず、窓内に inject(B) + A×3 → 沈黙（別 key の注入は境界にならない）', run(write('t14g', pad.concat([inj('000000000000'), asst()], seqA(3)))).out === '')

// T16 観測ログ（第 4 巡 36・第 5 巡 39〜41）: 既定は無効。許可先（tmpdir / ~/.claude/hooks/logs）配下の *.log のみ。
//   上限超のファイルには追記しない。書けなくても出力は変わらない。記録粒度は「正当な再発火」と「重複」を区別できること。
{
  const logp = path.join(TMPD, 't16.log')
  const envL = (p) => { const e = Object.assign({}, process.env); if (p === undefined) delete e.SLD_LOG; else e.SLD_LOG = p; return e }
  const runL = (tp, p) => spawnSync(process.execPath, [CORE], { input: JSON.stringify({ transcript_path: tp }), encoding: 'utf8', env: envL(p) })
  const recsOf = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) : [])
  const t16 = write('t16', seqA(3))
  const rl = runL(t16, logp)
  const recs = recsOf(logp)
  const r0 = recs[0] || {}
  const nidOf = (out) => { const j = parsed(out); const m = j && String(j.hookSpecificOutput.additionalContext).match(/\(nid:([0-9a-f]{12}:[0-9a-f]{12})\)/); return m ? m[1] : null }
  check('T16a 出た呼出しはログ 1 行（stage=read・fired=true・key・run=3・cnt=3・inj=0・bnd=0・injNids=[]・truncated=false・range=[0,size]・nid=乱数 12 hex:key・tid は 12 桁 hex・ino は数値・transcript は basename）',
    keyOf(rl.stdout) === KA && recs.length === 1 && r0.stage === 'read' && r0.fired === true && r0.key === KA && r0.run === 3 && r0.cnt === 3 && r0.inj === 0 && r0.bnd === 0 &&
    Array.isArray(r0.injNids) && r0.injNids.length === 0 && r0.truncated === false && r0.broken === false && r0.anchored === true && Array.isArray(r0.range) && r0.range[0] === 0 && r0.range[1] === fs.statSync(t16).size &&
    /^[0-9a-f]{12}:[0-9a-f]{12}$/.test(r0.nid) && r0.nid.endsWith(':' + KA) && /^[0-9a-f]{12}$/.test(r0.tid) && typeof r0.ino === 'number' && r0.ino === fs.statSync(t16).ino && r0.transcript === 't16.jsonl')
  check('T16a2 出力メッセージにログと同じ nid が埋め込まれる（注入記録から回収できる）', nidOf(rl.stdout) === r0.nid)
  const rl2 = runL(write('t16b', seqA(2)), logp)
  const recs2 = recsOf(logp)
  check('T16b 沈黙した呼出しもログに残る（fired=false・key=null・cnt=2・nid=null・別 tid）', rl2.stdout === '' && recs2.length === 2 && recs2[1].fired === false && recs2[1].key === null && recs2[1].cnt === 2 && recs2[1].nid === null && recs2[1].tid !== r0.tid)
  fs.appendFileSync(t16, [inj(KA, r0.nid), asst()].concat(seqA(3)).join('\n') + '\n')
  const rl3 = runL(t16, logp)
  const recs3 = recsOf(logp)
  check('T16c 前の通知が nid 付きで記録された後の新規 3 件 → 出る。後行の injNids に前行の nid が含まれる（正当な再発火・同じ tid・同じ key・inj=1）', keyOf(rl3.stdout) === KA && recs3.length === 3 && recs3[2].fired === true && recs3[2].key === KA && recs3[2].inj === 1 && recs3[2].tid === r0.tid && recs3[2].injNids.indexOf(r0.nid) >= 0)
  check('T16c2 2 回目の nid は乱数部が前回と異なり、同じ transcript なら ino が同じで size は増えている（世代同一の補助指標）', recs3[2].nid !== r0.nid && recs3[2].nid.endsWith(':' + KA) && recs3[2].ino === r0.ino && recs3[2].size > r0.size)
  const rl3b = runL(t16, logp)
  const recs3b = recsOf(logp)
  check('T16d 未追記で再呼出し（重複通知）→ 出るが、後行の injNids に前行の nid が **無い**（truncated=false）——逸脱判定「前提の崩れ」の形', keyOf(rl3b.stdout) === KA && recs3b.length === 4 && recs3b[3].fired === true && recs3b[3].tid === recs3[2].tid && recs3b[3].truncated === false && recs3b[3].injNids.indexOf(recs3[2].nid) < 0)
  const t16d2 = write('t16d2', seqA(3))
  fs.copyFileSync(t16d2, path.join(TMPD, 'same-name'))
  fs.mkdirSync(path.join(TMPD, 'other'))
  const t16d3 = path.join(TMPD, 'other', 't16d2.jsonl')
  fs.copyFileSync(t16d2, t16d3)
  runL(t16d2, logp)
  runL(t16d3, logp)
  const recsD = recsOf(logp)
  check('T16d2 同名別 transcript（別ディレクトリの t16d2.jsonl）は tid が異なる——basename の衝突では逸脱と誤判定しない', recsD.length === 6 && recsD[4].transcript === recsD[5].transcript && recsD[4].tid !== recsD[5].tid)
  const defp = path.join(os.homedir(), '.claude', 'hooks', 'stuck-loop-detect.log')
  const before = fs.existsSync(defp) ? fs.statSync(defp).size : -1
  const rl4 = runL(t16, undefined)
  const after = fs.existsSync(defp) ? fs.statSync(defp).size : -1
  check('T16e SLD_LOG 未設定 → 既定で書かない（旧既定パスのサイズ不変）・出力は変わらない', keyOf(rl4.stdout) === KA && before === after)
  runL(t16, '')
  check('T16f SLD_LOG=\'\' → 書かない', recsOf(logp).length === 6)
  const bad1 = path.join(HOOKS, 't16-forbidden.log')
  runL(t16, bad1)
  check('T16g 許可先以外（hooks 直下）→ 書かない', !fs.existsSync(bad1) && core.logPath() === null)
  const bad2 = path.join(TMPD, 't16.json')
  runL(t16, bad2)
  check('T16h 拡張子 .log 以外 → 書かない', !fs.existsSync(bad2))
  runL(t16, 't16-rel.log')
  check('T16i 相対パス → 書かない', !fs.existsSync(path.join(process.cwd(), 't16-rel.log')) && !fs.existsSync(path.join(HOOKS, 't16-rel.log')))
  const big = path.join(TMPD, 't16-big.log')
  fs.writeFileSync(big, 'x'.repeat(core.LOG_CAP_BYTES - 1) + '\n')
  const bsz = fs.statSync(big).size
  const rl5 = runL(t16, big)
  check('T16j ちょうど上限（1 MiB）のログには追記しない（追記後に上限を超える）・出力は変わらない', keyOf(rl5.stdout) === KA && bsz === core.LOG_CAP_BYTES && fs.statSync(big).size === bsz)
  const near = path.join(TMPD, 't16-near.log')
  fs.writeFileSync(near, 'x'.repeat(core.LOG_CAP_BYTES - 4096) + '\n')
  runL(t16, near)
  check('T16j2 上限まで余裕があれば追記する（追記後も上限以下）', fs.statSync(near).size > core.LOG_CAP_BYTES - 4095 && fs.statSync(near).size <= core.LOG_CAP_BYTES)
  const rl6 = runL(t16, path.join(TMPD, 'no-such-dir', 't16.log'))
  check('T16k 書けない先（存在しないディレクトリ）でも出力は変わらない', keyOf(rl6.stdout) === KA && !fs.existsSync(path.join(TMPD, 'no-such-dir')))
  const rl7 = runL(path.join(TMPD, 'nope.jsonl'), logp)
  const recs7 = recsOf(logp)
  check('T16l transcript 不在の呼出しもログに残る（stage=no_transcript・fired=false・tid=null）', rl7.stdout === '' && recs7.length === 7 && recs7[6].stage === 'no_transcript' && recs7[6].fired === false && recs7[6].tid === null)
  const rl8 = runL(write('t16m', seqA(2).concat(['{not json'])), logp)
  const recs8 = recsOf(logp)
  check('T16m JSON 破損で沈黙した呼出しは broken=true', rl8.stdout === '' && recs8.length === 8 && recs8[7].broken === true && recs8[7].fired === false)
  // 第 6 巡 43: symlink / junction 経由で許可先の外へ書けない
  const victim = path.join(TMPD, 'victim.json')
  fs.writeFileSync(victim, '{"keep":true}\n')
  const link = path.join(TMPD, 't16n-link.log')
  let linked = false
  try { fs.symlinkSync(victim, link, 'file'); linked = true } catch (e) { skip('T16n ファイル symlink を経由した追記', 'symlink 作成不可: ' + e.code) }
  if (linked) {
    const rl9 = runL(t16, link)
    check('T16n 許可先内の *.log がファイル symlink → 書かない（リンク先は不変）・出力は変わらない', keyOf(rl9.stdout) === KA && fs.readFileSync(victim, 'utf8') === '{"keep":true}\n' && fs.lstatSync(link).isSymbolicLink())
  }
  fs.mkdirSync(path.join(os.homedir(), '.claude', 'tmp'), { recursive: true })
  const outside = fs.mkdtempSync(path.join(os.homedir(), '.claude', 'tmp', 'sld-t16o-'))
  const jdir = path.join(TMPD, 'jdir')
  let junctioned = false
  try { fs.symlinkSync(outside, jdir, 'junction'); junctioned = true } catch (e) { skip('T16o ディレクトリ junction を経由した追記', 'junction 作成不可: ' + e.code) }
  if (junctioned) {
    const rl10 = runL(t16, path.join(jdir, 't16o.log'))
    check('T16o 許可先内のディレクトリ junction が許可先の外を指す → 書かない（親の realpath で判定）・出力は変わらない', keyOf(rl10.stdout) === KA && fs.readdirSync(outside).length === 0)
    try { fs.rmdirSync(jdir) } catch (e) { try { fs.unlinkSync(jdir) } catch (e2) {} }
  }
  try { fs.rmSync(outside, { recursive: true, force: true }) } catch (e) {}
  const dirAsLog = path.join(TMPD, 't16p.log')
  fs.mkdirSync(dirAsLog)
  const rl11 = runL(t16, dirAsLog)
  check('T16p *.log がディレクトリ → 書かない・出力は変わらない', keyOf(rl11.stdout) === KA && fs.readdirSync(dirAsLog).length === 0)
}

// T15 前提の限界（第 3 巡 22・第 4 巡 35）: 同じ transcript ファイルへ追記しながら順に呼び出し、各呼出しの出力を検証する
const t15 = write('t15', seqA(3))
check('T15a 初回: A×3 → 出る', keyOf(run(t15).out) === KA)
check('T15b 未追記のまま再呼出し → 再び出る（「新規 block なしに再通知しない」は保証しない）', keyOf(run(t15).out) === KA)
fs.appendFileSync(t15, [JSON.stringify({ type: 'attachment', attachment: { type: 'unknown_shape', content: ['【反復検知 ' + KA + '】'] } }), asst()].join('\n') + '\n')
check('T15c 認識不能な形の注入を追記して再呼出し → 再び出る（認識不能は無視であり沈黙ではない）', keyOf(run(t15).out) === KA)
fs.appendFileSync(t15, [inj(KA), asst()].join('\n') + '\n')
check('T15d 認識可能な注入を追記して再呼出し → 沈黙', run(t15).out === '')
fs.appendFileSync(t15, seqA(3).join('\n') + '\n')
check('T15e さらに A×3 追記 → 出る（注入後の新規 3 件）', keyOf(run(t15).out) === KA)

try { fs.rmSync(TMPD, { recursive: true, force: true }) } catch (e) {}
console.log((fail ? 'RESULT: ' + fail + ' FAIL / ' + n : 'RESULT: ALL PASS (' + n + ')') + (skipped ? ' / SKIP ' + skipped : ''))
process.exit(fail ? 1 : 0)
