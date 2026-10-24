#!/usr/bin/env node
'use strict'

/**
 * pending-reaper.cjs の単体検証（2026-10-08 棚卸し §5 の 3 件目）。
 *
 *   node _Tools/pending-reaper.test.cjs
 *
 * 本体を require して再利用する（複製を書かない。residual-detect.test.cjs と同じ考え）。
 * 固定するのは 2026-10-08 の棚卸しで直した読み違い 2 つと、処置の表の読み方:
 *   1. 欄の中の `\|`（縦棒のエスケープ）を列の区切りと読まない（#49 が「最終実測 不明」と出ていた）
 *   2. 「済み・放置・注視・クローズ」の行は腐りに出さない（済みの行が 30 日経つと #76 のように出ていた）
 *   3. 処置の表は、処置か根拠の欄が空の行を「閉じた」と数えない
 *
 * vitest には載せない（_Tools は ccpit の試験の root の外）。
 */

const fs = require('fs')
const path = require('path')
const os = require('os')

// 本体は require 時に CCPIT_ROOT を読むので、先に試験用の作業場を作ってから読む
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-reaper-test-'))
process.env.CCPIT_ROOT = root
const reaper = require(path.join(__dirname, 'pending-reaper.cjs'))

const lane = path.join(root, '_Prompt', '01_designai')
const build = path.join(root, '_Prompt', '02_buildai', 'r')
const evidence = path.join(root, '_Prompt', '02_buildai', 'evidence')
const gemini = path.join(root, '_Prompt', '02_buildai', 'gemini')
for (const d of [lane, build, evidence, gemini]) fs.mkdirSync(d, { recursive: true })

let passed = 0
const failures = []
const pending = [] // 非同期の試験（並んで 2 本起こす試験）の終わりを結果の前に待つ
function it(name, fn) {
  try {
    const r = fn()
    if (r && typeof r.then === 'function') {
      pending.push(r.then(() => { passed++ }, (e) => { failures.push(`${name}: ${e.message}`) }))
    } else {
      passed++
    }
  } catch (e) { failures.push(`${name}: ${e.message}`) }
}
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || ''} 期待 ${JSON.stringify(b)} 実際 ${JSON.stringify(a)}`) }
function has(arr, re, msg) { if (!arr.some(s => re.test(s))) throw new Error(`${msg || ''} ${re} を含む行が無い: ${JSON.stringify(arr)}`) }
function hasNot(arr, re, msg) { if (arr.some(s => re.test(s))) throw new Error(`${msg || ''} ${re} を含む行がある: ${JSON.stringify(arr)}`) }

/* ----------------------------------------------------------- 台帳の腐り ---- */

const NOW = new Date('2026-10-08T02:00:00+09:00')
fs.writeFileSync(path.join(lane, 'TASK_LEDGER.md'), [
  '# 台帳',
  '',
  '| # | 状態 | 題 | 最終実測 | 次 |',
  '|---|---|---|---|---|',
  '| 1 | **踏み抜く** | `\\| tail -c 3` を含む題（新しい） | **2026-10-01**（実測） | なし |',
  '| 2 | **済み（2026-09-01）** | 古いが済み | **2026-08-01** | なし |',
  '| 3 | **放置（再起動条件: x）** | 古いが放置 | **2026-08-01** | なし |',
  '| 4 | **注視** | 古いが注視 | **2026-08-01** | なし |',
  '| 5 | **踏み抜く** | 古くて未完了 | **2026-08-01** | なし |',
  '| 6 | **踏み抜く** | 新しいが未再確認 | **2026-10-05**・未再確認 | なし |',
  '| 7 | **踏み抜く** | `\\| x` を含み古い | **2026-08-01** | なし |',
  '| 8 | **completed** | 英語の閉じ語 | **2026-08-01** | なし |',
  '',
].join('\n'))

const stale = reaper.staleLedgerRows(NOW)

it('`\\|` を含む新しい行は腐りに出ない（列が崩れて 4 列目を落とさない）', () => { hasNot(stale, /^#1 /) })
it('済み・放置・注視・completed の行は古くても腐りに出ない', () => {
  hasNot(stale, /^#2 /); hasNot(stale, /^#3 /); hasNot(stale, /^#4 /); hasNot(stale, /^#8 /)
})
it('未完了で 30 日超の行は腐りに出る', () => { has(stale, /^#5 /) })
it('未再確認の行は新しくても腐りに出る', () => { has(stale, /^#6 .*未再確認/) })
it('`\\|` を含む古い行は、日付が読めた形で腐りに出る（「不明」にならない）', () => {
  has(stale, /^#7 .*最終実測 2026-08-01/); hasNot(stale, /^#7 .*不明/)
})
it('腐りの件数は 3（#5・#6・#7）', () => { eq(stale.length, 3, '件数') })

/* --------------------------------------------- 受け皿の無い Pending 行 ---- */

const pendingDoc = (rows) => [
  '# 文書', '', '## 本文', '', 'x', '',
  '## スコープ外提案（Pending）', '',
  '| 項目 | 受け皿 |', '|---|---|',
  ...rows, '',
  '## 用語集', '', '| 語 | 意味 |', '|---|---|', '| a | b |', '',
].join('\n')

fs.writeFileSync(path.join(lane, 'doc_a.md'), pendingDoc([
  '| 台帳あり | 作業台帳 `_Prompt/01_designai/TASK_LEDGER.md` #12 |',
  '| 段あり | `X_MILESTONES.md` の M3 |',
  '| リストあり | `X_BOUND_PENDING.md` の B2 |',
  '| 処置済み | ― |',
  '| 処置の欄が空 | ― |',
  '| 根拠の欄が空 | ― |',
  '| 孤児 | ― |',
  '| 無し | ― |',
]))
fs.writeFileSync(path.join(build, 'doc_b.md'), pendingDoc(['| 実装側の孤児 | ― |']))
fs.writeFileSync(path.join(evidence, 'doc_c.md'), pendingDoc(['| 証跡の見本の行 | ― |']))
fs.writeFileSync(path.join(gemini, 'doc_d.md'), pendingDoc(['| Gemini の報告の行 | ― |']))
fs.writeFileSync(path.join(lane, 'PENDING_DISPOSITIONS.md'), [
  '# 処置の表', '',
  '| 文書 | 行の頭 | 処置 | 根拠・受け皿 |', '|---|---|---|---|',
  '| `_Prompt/01_designai/doc_a.md` | 処置済み | 済み | 台帳 #1 で閉じた |',
  '| `_Prompt/01_designai/doc_a.md` | 処置の欄が空 |  | 根拠だけ書いた |',
  '| `_Prompt/01_designai/doc_a.md` | 根拠の欄が空 | 済み |  |',
  '',
].join('\n'))

const disposed = reaper.loadDispositions()
const orphans = reaper.orphanPendingRows()

it('処置の表は、処置と根拠の両方が埋まった行だけを「閉じた」と読む', () => {
  eq(disposed.has('_Prompt/01_designai/doc_a.md::処置済み'), true, '両方埋まった行')
  eq(disposed.has('_Prompt/01_designai/doc_a.md::処置の欄が空'), false, '処置が空の行')
  eq(disposed.has('_Prompt/01_designai/doc_a.md::根拠の欄が空'), false, '根拠が空の行')
})
it('台帳 #・MILESTONES の M#・BOUND_PENDING の B#・処置の表の行・「無し」は孤児に出ない', () => {
  hasNot(orphans, /台帳あり|段あり|リストあり|処置済み|:: 無し/)
})
it('処置の表で欄が空の行は孤児のまま', () => { has(orphans, /処置の欄が空/); has(orphans, /根拠の欄が空/) })
it('受け皿の無い行は孤児に出る（設計レーンの文書・実装側の新しい文書とも）', () => {
  has(orphans, /doc_a\.md :: 孤児/); has(orphans, /doc_b\.md :: 実装側の孤児/)
})
it('証跡の見本（/evidence/）と Gemini の置き場（02_buildai/gemini/）は見ない', () => {
  hasNot(orphans, /証跡の見本|Gemini の報告/)
})
it('孤児の件数は 4（孤児・処置の欄が空・根拠の欄が空・実装側の孤児）', () => { eq(orphans.length, 4, '件数') })

/* --------------------------- どこに置いても動く（L0_013 W4・AC21）---- */

const { spawnSync } = require('child_process')
const SELF = path.join(__dirname, 'pending-reaper.cjs')
const markers = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-reaper-markers-'))
const nested = path.join(root, 'ccpit', 'src', 'deep')
fs.mkdirSync(nested, { recursive: true })
const noLedger = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-reaper-noledger-'))
/** CCPIT_ROOT を外した環境で、フックとして 1 回起こす */
function hook(input, extraEnv = {}) {
  const env = { ...process.env, PENDING_REAPER_MARKER_DIR: markers, ...extraEnv }
  delete env.CCPIT_ROOT
  return spawnSync(process.execPath, [SELF], { input: JSON.stringify(input), env, encoding: 'utf8', timeout: 30000 })
}
const injected = (r) => {
  try { return JSON.parse(r.stdout).hookSpecificOutput.additionalContext.includes('PENDING-REAPER-END') } catch (_) { return false }
}

it('(a) cwd から上へ辿って台帳を持つディレクトリを ROOT にする', () => {
  eq(reaper.findLedgerRoot(nested), root, '辿った ROOT')
  const r = hook({ cwd: nested, session_id: 'a-1' })
  eq(r.status, 0, '終了コード'); eq(injected(r), true, '差し込み')
})
it('(b) 台帳の無い cwd では沈黙 exit 0・非注入', () => {
  eq(reaper.findLedgerRoot(noLedger), null, '辿った ROOT')
  const r = hook({ cwd: noLedger, session_id: 'b-1' })
  eq(r.status, 0, '終了コード'); eq(r.stdout, '', '出力')
})
it('(b2) CCPIT_ROOT があるときは、cwd がその中のときだけ出す（従来どおり）', () => {
  const r1 = hook({ cwd: noLedger, session_id: 'b2-1' }, { CCPIT_ROOT: root })
  eq(r1.stdout, '', '外の cwd')
  const r2 = hook({ cwd: nested, session_id: 'b2-2' }, { CCPIT_ROOT: root })
  eq(injected(r2), true, '中の cwd')
})
it('(c) 同じ session_id の 2 回目（幅の内）は沈黙・幅の外（compact・resume の後）は出す', () => {
  process.env.PENDING_REAPER_MARKER_DIR = markers
  const t0 = Date.now()
  const W = reaper.DEDUPE_WINDOW_MS
  eq(reaper.claimSession('c-1', t0), true, '1 回目')
  eq(reaper.claimSession('c-1', t0 + 1), false, '幅の内の 2 回目')
  eq(reaper.claimSession('c-1', t0 + W - 1), false, '幅の端の内')
  eq(reaper.claimSession('c-1', t0 + W + 1), true, '幅の外（次の SessionStart）')
  eq(reaper.claimSession('c-1', t0 + W + 2), false, '更新した後の 2 回目')
  eq(reaper.claimSession('c-2', t0 + 3), true, '別の session_id')
  eq(reaper.claimSession(undefined, t0 + 4), true, 'key が無い入力は目印を使わずに出す')
})
it('(c1) 幅の外の SessionStart に 2 本が同時に来ても、勝つのは 1 本（境目が無い）', () => {
  process.env.PENDING_REAPER_MARKER_DIR = markers
  const t0 = Date.now()
  const W = reaper.DEDUPE_WINDOW_MS
  eq(reaper.claimSession('c1-x', t0), true, '最初の SessionStart')
  // 2 本とも同じ「最後の更新時刻」を見てから印を取りに行く: 1 本だけが印を作れる
  const later = t0 + W * 3 + 123
  const a = reaper.claimSession('c1-x', later)
  const b = reaper.claimSession('c1-x', later)
  eq([a, b].filter(Boolean).length, 1, '勝った本数')
  // どの時刻（区切りの境目にあたる時刻を含む）でも 2 本目は沈黙
  for (const off of [0, 59999, 60000, 60001]) {
    const sid = `c1-edge-${off}`
    eq(reaper.claimSession(sid, off), true, `1 本目 ${off}`)
    eq(reaper.claimSession(sid, off + 1), false, `2 本目 ${off}`)
  }
})
it('(c1b) 時計が巻き戻って目印が未来の時刻でも、次の SessionStart は出す・その 2 本目は沈黙', () => {
  process.env.PENDING_REAPER_MARKER_DIR = markers
  const future = Date.now() + 10 * 60 * 1000
  eq(reaper.claimSession('c1b', future), true, '未来の時刻で 1 本目（目印の更新時刻が未来になる）')
  const now = Date.now()
  eq(reaper.claimSession('c1b', now), true, '今の時刻の SessionStart')
  eq(reaper.claimSession('c1b', now + 1), false, 'その 2 本目')
})
it('(c1c) 3 本が同時に来ても勝つのは 1 本', () => {
  process.env.PENDING_REAPER_MARKER_DIR = markers
  const t0 = Date.now()
  eq(reaper.claimSession('c1c', t0), true, '最初')
  const later = t0 + reaper.DEDUPE_WINDOW_MS * 2
  const wins = [0, 1, 2].map(() => reaper.claimSession('c1c', later)).filter(Boolean).length
  eq(wins, 1, '勝った本数')
})
it('(c2) 並んで 2 本起こすと 1 本だけ差し込む', () => {
  const env = { ...process.env, PENDING_REAPER_MARKER_DIR: markers }
  delete env.CCPIT_ROOT
  const { spawn } = require('child_process')
  const run = () => new Promise((res) => {
    const c = spawn(process.execPath, [SELF], { env })
    let out = ''
    c.stdout.on('data', (d) => { out += d })
    c.on('close', (code) => res({ status: code, stdout: out }))
    c.stdin.end(JSON.stringify({ cwd: nested, session_id: 'c2-parallel' }))
  })
  return Promise.all([run(), run()]).then((rs) => {
    eq(rs.filter(injected).length, 1, '差し込んだ本数')
    eq(rs.every((r) => r.status === 0), true, '両方 exit 0')
  })
})
it('(c3) 特殊な文字・長大な session_id でも目印はフォルダの外に出ず、2 本目は沈黙', () => {
  const now = Date.now()
  for (const sid of ['../../escape', 'a/b\\c:d*e?f', 'x'.repeat(1000)]) {
    eq(reaper.claimSession(sid, now), true, `1 回目 ${sid.slice(0, 12)}`)
    eq(reaper.claimSession(sid, now + 1), false, `2 回目 ${sid.slice(0, 12)}`)
  }
  const outside = fs.readdirSync(path.dirname(markers)).filter((n) => n === 'escape' || n.startsWith('escape.'))
  eq(outside.length, 0, 'フォルダの外の目印')
  eq(fs.readdirSync(markers).every((n) => /^[0-9a-f]{32}(\.\d+)?$/.test(n)), true, '目印の名前は固定長の 16 進')
})
it('(c4) session_id が無くても transcript_path で 2 本目は沈黙', () => {
  const r1 = hook({ cwd: nested, transcript_path: path.join(root, 't-c4.jsonl') })
  const r2 = hook({ cwd: nested, transcript_path: path.join(root, 't-c4.jsonl') })
  eq(injected(r1), true, '1 本目')
  eq(r2.stdout, '', '2 本目')
})
it('(d) 走査の上限: 上限を超えたら打ち切り、truncated を立てる', () => {
  const big = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-reaper-big-'))
  const d = path.join(big, '_Prompt', '01_designai')
  fs.mkdirSync(d, { recursive: true })
  for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(d, `doc_${i}.md`), pendingDoc([`| 孤児 ${i} | ― |`]))
  const all = reaper.orphanPendingRows(big)
  eq(all.truncated, false, '上限の内')
  eq(all.length, 12, '全部')
  const cut = reaper.orphanPendingRows(big, { files: 5, bytes: 1e9 })
  eq(cut.truncated, true, 'ファイル数の上限')
  eq(cut.length, 5, '打ち切った数')
  const cutWalk = reaper.orphanPendingRows(big, { files: 100, bytes: 1e9, walkEntries: 3 })
  eq(cutWalk.truncated, true, '辿る項目の上限')
  try { fs.rmSync(big, { recursive: true, force: true }) } catch (_) { /* 片付け */ }
})

/* ---------------------------------------------------------------- 結果 ---- */

Promise.all(pending).then(() => {
  for (const d of [root, markers, noLedger]) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch (_) { /* 作業場の片付けの失敗は結果に影響しない */ }
  }
  console.log(`pending-reaper.test: ${passed} passed, ${failures.length} failed`)
  for (const f of failures) console.log('  FAIL ' + f)
  process.exit(failures.length ? 1 : 0)
})
