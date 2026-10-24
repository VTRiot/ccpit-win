#!/usr/bin/env node
'use strict'
/**
 * away-gate-hook.sh（足場）＋ away-gate-hook.cjs（AwayGate の build の写し）の試験（L0_013 W4）。
 *
 *   node away-gate-hook.test.cjs
 *
 * 見ること（HOME はすべて偽。本物の ~/.ccpit には触れない）:
 *   1. 番人（~/.ccpit/away-gate/bin/away-gate.cjs）が無い機械: 機を使う呼び出しでも exit 0・無出力・~/.ccpit を作らない
 *   2. 番人がある機械: 足場が判定本体を起こす（状態が無いので allow に倒れ、判定本体がログを書く）
 *   3. AWAYGATE_HOME の上書き: 番人の有無は上書き先で見る
 *   4. node が PATH に無い機械: exit 0・無出力
 * 番人が稼働して deny を出す判定は AwayGate 側の試験の持ち分（写しは build と sha256 で同一）。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const GATE = path.join(__dirname, 'away-gate-hook.sh').replace(/\\/g, '/')
const BASH = process.env.AGH_TEST_BASH || 'bash'

let passed = 0
const failures = []
function check(name, cond, extra) {
  if (cond) passed++
  else failures.push(`${name}${extra ? ' :: ' + extra : ''}`)
}

const probe = spawnSync(BASH, ['-c', 'echo ok'], { encoding: 'utf8' })
if (probe.status !== 0 || (probe.stdout || '').trim() !== 'ok') {
  console.log(`away-gate-hook.test: bash が起動できない（${BASH}）`)
  process.exit(1)
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'away-gate-hook-test-'))
const MACHINE_CALLS = [
  ['mcp__playwright__browser_click', { element: 'x', ref: 'e1' }],
  ['mcp__claude-in-chrome__computer', { action: 'screenshot' }],
  ['Bash', { command: 'npx vitest run' }],
  ['PowerShell', { command: 'Start-Process notepad' }]
]

function freshHome(name) {
  const h = path.join(root, name)
  fs.mkdirSync(h, { recursive: true })
  return h
}
function placeGuardian(agHome) {
  fs.mkdirSync(path.join(agHome, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(agHome, 'bin', 'away-gate.cjs'), '// 試験用の番人の代役（起こされてもすぐ終わる）\n')
}
function run(home, tool, toolInput, extraEnv = {}, pathOverride) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, ...extraEnv }
  if (!('AWAYGATE_HOME' in extraEnv)) delete env.AWAYGATE_HOME
  if (pathOverride !== undefined) env.PATH = pathOverride
  const input = JSON.stringify({ session_id: 'agh-test', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput, cwd: root })
  return spawnSync(BASH, [GATE], { input, env, encoding: 'utf8', timeout: 30000 })
}
function filesUnder(d) {
  const out = []
  if (!fs.existsSync(d)) return out
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) out.push(...filesUnder(p))
    else out.push(p)
  }
  return out
}

// 1. 番人が無い機械
{
  const home = freshHome('no-guardian')
  for (const [tool, ti] of MACHINE_CALLS) {
    const r = run(home, tool, ti)
    check(`1 番人なし ${tool}: exit 0・無出力`, r.status === 0 && (r.stdout || '') === '', JSON.stringify({ status: r.status, out: r.stdout, err: (r.stderr || '').slice(0, 200) }))
  }
  check('1 番人なし: ~/.ccpit を作らない', !fs.existsSync(path.join(home, '.ccpit')), filesUnder(home).join(','))
}

// 2. 番人がある機械（状態はまだ無い）: 足場が判定本体を起こし、判定本体は allow に倒れてログを書く
{
  const home = freshHome('guardian')
  const ag = path.join(home, '.ccpit', 'away-gate')
  placeGuardian(ag)
  const r = run(home, 'mcp__playwright__browser_click', { element: 'x', ref: 'e1' })
  check('2 番人あり: exit 0・無出力（状態が無いので allow）', r.status === 0 && (r.stdout || '') === '', JSON.stringify({ status: r.status, out: r.stdout }))
  const logs = filesUnder(ag).filter((f) => /hook-\d{8}\.log$/.test(f))
  check('2 番人あり: 判定本体が起きた（ログがある）', logs.length === 1, filesUnder(ag).join(','))
  const r2 = run(home, 'Bash', { command: 'ls' })
  check('2 番人あり・軽い呼び出し: exit 0・無出力', r2.status === 0 && (r2.stdout || '') === '')
}

// 3. AWAYGATE_HOME の上書き
{
  const home = freshHome('override')
  const custom = path.join(root, 'custom-ag')
  placeGuardian(path.join(home, '.ccpit', 'away-gate')) // 既定の場所には番人が居る
  const r = run(home, 'mcp__playwright__browser_click', { element: 'x', ref: 'e1' }, { AWAYGATE_HOME: custom })
  check('3 上書き先に番人なし: exit 0・無出力・上書き先を作らない', r.status === 0 && (r.stdout || '') === '' && !fs.existsSync(custom), filesUnder(custom).join(','))
  placeGuardian(custom)
  const r2 = run(home, 'mcp__playwright__browser_click', { element: 'x', ref: 'e1' }, { AWAYGATE_HOME: custom })
  const logs = filesUnder(custom).filter((f) => /hook-\d{8}\.log$/.test(f))
  check('3 上書き先に番人あり: 判定本体が上書き先にログを書く', r2.status === 0 && logs.length === 1, filesUnder(custom).join(','))
}

// 4. node が PATH に無い機械
{
  const home = freshHome('no-node')
  placeGuardian(path.join(home, '.ccpit', 'away-gate'))
  // bash 自身の場所だけを PATH にする（Git Bash では /usr/bin。node は入っていない）
  const where = spawnSync(BASH, ['-c', 'command -v cygpath >/dev/null && cygpath -w "$(dirname "$(command -v bash)")" || dirname "$(command -v bash)"'], { encoding: 'utf8' })
  const bashDir = (where.stdout || '').trim()
  const nodeVisible = spawnSync(BASH, ['-c', 'command -v node'], { encoding: 'utf8', env: { ...process.env, PATH: bashDir } })
  if (!bashDir || (nodeVisible.stdout || '').trim() !== '') {
    failures.push(`4 node の無い PATH を作れない（bash の場所 ${bashDir}・node が見える ${(nodeVisible.stdout || '').trim()}）`)
  } else {
    const r = run(home, 'mcp__playwright__browser_click', { element: 'x', ref: 'e1' }, {}, bashDir)
    check('4 node が無い: exit 0・無出力', r.status === 0 && (r.stdout || '') === '', JSON.stringify({ status: r.status, out: r.stdout, err: (r.stderr || '').slice(0, 200) }))
    check('4 node が無い: 判定本体は起きない（ログが無い）', filesUnder(path.join(home, '.ccpit', 'away-gate')).every((f) => !/hook-\d{8}\.log$/.test(f)))
  }
}

try { fs.rmSync(root, { recursive: true, force: true }) } catch (_) { /* 片付けの失敗は結果に影響しない */ }
console.log(`away-gate-hook.test: ${passed} passed, ${failures.length} failed`)
for (const f of failures) console.log('  FAIL ' + f)
process.exit(failures.length ? 1 : 0)
