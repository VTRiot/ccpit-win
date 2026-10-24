#!/usr/bin/env node
'use strict'
/**
 * skill-edit-auth-guard.sh の試験（L0_013 W4 で golden に入れるときに足した）。
 *
 *   node skill-edit-auth-guard.test.cjs
 *
 * ~/.claude/skills/<名前>/SKILL.md を Edit・Write・MultiEdit・NotebookEdit で直接書こうとしたら deny を出し、
 * それ以外のパス（補助の .md・SKILL.md の退避・別の場所）では何も出さないこと。bash が無い環境は FAIL にする
 * （見張り役が動かない環境を「通った」としない）。
 */
const path = require('path')
const { spawnSync } = require('child_process')

const GATE = path.join(__dirname, 'skill-edit-auth-guard.sh').replace(/\\/g, '/')
const BASH = process.env.SEAG_TEST_BASH || 'bash'

let passed = 0
const failures = []
function check(name, cond, extra) {
  if (cond) passed++
  else failures.push(`${name}${extra ? ' :: ' + extra : ''}`)
}

function run(filePath, toolName = 'Edit') {
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: { file_path: filePath } })
  return spawnSync(BASH, [GATE], { input, encoding: 'utf8', timeout: 20000 })
}

const probe = spawnSync(BASH, ['-c', 'echo ok'], { encoding: 'utf8' })
if (probe.status !== 0 || (probe.stdout || '').trim() !== 'ok') {
  console.log(`skill-edit-auth-guard.test: bash が起動できない（${BASH}）`)
  process.exit(1)
}

const denies = (r) => {
  try {
    const o = JSON.parse(r.stdout)
    return o.hookSpecificOutput.hookEventName === 'PreToolUse' && o.hookSpecificOutput.permissionDecision === 'deny'
  } catch (_) {
    return false
  }
}

// deny が出る形
const denyCases = [
  ['/c/Users/u/.claude/skills/foo/SKILL.md', 'Edit'],
  ['C:/Users/u/.claude/skills/foo/SKILL.md', 'Write'],
  ['C:\\Users\\u\\.claude\\skills\\foo\\SKILL.md', 'MultiEdit'],
  ['/home/u/.claude/skills/bar-baz/SKILL.md', 'NotebookEdit']
]
for (const [p, tool] of denyCases) {
  const r = run(p, tool)
  check(`deny: ${tool} ${p}`, r.status === 0 && denies(r), JSON.stringify({ status: r.status, out: r.stdout }))
}

// 何も出ない形
const passCases = [
  '/c/Users/u/.claude/skills/foo/notes.md',
  '/c/Users/u/.claude/skills/foo/SKILL.md.bak.20261021',
  '/c/Users/u/.claude/rules/SKILL.md',
  '/c/work/repo/skills/foo/SKILL.md.txt',
  ''
]
for (const p of passCases) {
  const r = run(p)
  check(`pass: ${p || '(空)'}`, r.status === 0 && (r.stdout || '').trim() === '', JSON.stringify({ status: r.status, out: r.stdout }))
}

console.log(`skill-edit-auth-guard.test: ${passed} passed, ${failures.length} failed`)
for (const f of failures) console.log('  FAIL ' + f)
process.exit(failures.length ? 1 : 0)
