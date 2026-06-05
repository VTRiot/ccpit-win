import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { computeEnforcementStats, clearEnforcementStatsCache } from '../enforcementStats'
import { clearFiringStatsCache } from '../skillFiringStats'

let root: string

// --- fixture ヘルパ（監査 §3 で確定した実 JSONL 形状に準拠） ---

function skillLine(skill: string): string {
  return JSON.stringify({
    message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill } }] },
    timestamp: '2026-05-01T00:00:00Z',
    cwd: 'C:/proj',
    sessionId: 's'
  })
}

/** stop_hook_summary。durationMs 付き = 完走 hook。block 時は blockingCmd を durationMs 欠落で混ぜる。 */
function stopLine(opts: {
  commands: string[]
  blockingCommands?: string[]
  hookErrors?: string[]
  preventedContinuation?: boolean
}): string {
  const infos = [
    ...opts.commands.map((command) => ({ command, durationMs: 100 })),
    ...(opts.blockingCommands ?? []).map((command) => ({ command })) // durationMs 欠落 = ブロック hook
  ]
  return JSON.stringify({
    type: 'system',
    subtype: 'stop_hook_summary',
    hookInfos: infos,
    hookErrors: opts.hookErrors ?? [],
    preventedContinuation: opts.preventedContinuation ?? false,
    timestamp: '2026-05-02T00:00:00Z',
    cwd: 'C:/proj'
  })
}

/** deny tool_result。withToolUseResult=true で兄弟 toolUseResult 同文を付け、二重計上しないことを検証。 */
function denyLine(content: string, withToolUseResult = false): string {
  const rec: Record<string, unknown> = {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', content, is_error: true, tool_use_id: 't' }]
    },
    timestamp: '2026-05-03T00:00:00Z'
  }
  if (withToolUseResult) rec.toolUseResult = 'Error: ' + content
  return JSON.stringify(rec)
}

/** Bash tool_use。codex-companion を含めば marshal 1 起動。 */
function bashLine(command: string, cwd = 'C:/proj/ax'): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', name: 'Bash', input: { command } }]
    },
    cwd,
    timestamp: '2026-05-04T00:00:00Z'
  })
}

async function writeSession(name: string, lines: string[]): Promise<void> {
  const dir = join(root, 'proj')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, name), lines.join('\n'), 'utf-8')
}

beforeEach(async () => {
  clearEnforcementStatsCache()
  clearFiringStatsCache()
  root = join(tmpdir(), `ccpit-enf-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(root, { recursive: true })
})

afterEach(async () => {
  clearEnforcementStatsCache()
  clearFiringStatsCache()
  await rm(root, { recursive: true, force: true })
})

describe('computeEnforcementStats', () => {
  it('hooks(Stop): 1 stop_hook_summary = 1 cycle, ranking per hook command (basename)', async () => {
    await writeSession('s1.jsonl', [
      stopLine({
        commands: ['$HOME/.claude/hooks/report-gate.sh', '$HOME/.claude/hooks/debug-report-gate.sh']
      }),
      stopLine({ commands: ['$HOME/.claude/hooks/report-gate.sh'] })
    ])
    const res = await computeEnforcementStats({ projectsRoot: root })
    expect(res.hooksStop.total).toBe(2) // 2 Stop サイクル
    const byKey = Object.fromEntries(res.hooksStop.ranking.map((r) => [r.key, r.count]))
    expect(byKey['report-gate.sh']).toBe(2)
    expect(byKey['debug-report-gate.sh']).toBe(1)
    // 降順
    expect(res.hooksStop.ranking[0].key).toBe('report-gate.sh')
  })

  it('hooks(Stop): node-runner hooks display the script name, not "node"', async () => {
    await writeSession('s1.jsonl', [
      stopLine({
        commands: [
          'node "${CLAUDE_PLUGIN_ROOT}/scripts/stop-review-gate-hook.mjs"',
          '$HOME/.claude/hooks/report-gate.sh'
        ]
      })
    ])
    const res = await computeEnforcementStats({ projectsRoot: root })
    const byKey = Object.fromEntries(res.hooksStop.ranking.map((r) => [r.key, r.count]))
    expect(byKey['stop-review-gate-hook.mjs']).toBe(1) // node に丸めず実スクリプト名
    expect(byKey['report-gate.sh']).toBe(1)
    expect(byKey['node']).toBeUndefined()
  })

  it('rules層B: only blocked stops counted; attribution = durationMs-missing hook', async () => {
    await writeSession('s1.jsonl', [
      stopLine({ commands: ['report-gate.sh'] }), // 非ブロック
      stopLine({
        commands: ['report-gate.sh'],
        blockingCommands: ['$HOME/.claude/hooks/settings-guard.sh'],
        hookErrors: ['blocked: protected path']
      }),
      stopLine({ commands: ['report-gate.sh'], preventedContinuation: true }) // hookErrors 空でも preventedContinuation
    ])
    const res = await computeEnforcementStats({ projectsRoot: root })
    expect(res.rulesB.total).toBe(2) // hookErrors 非空 1 + preventedContinuation 1
    const byKey = Object.fromEntries(res.rulesB.ranking.map((r) => [r.key, r.count]))
    expect(byKey['settings-guard.sh']).toBe(1)
    expect(byKey['(unattributed)']).toBe(1) // preventedContinuation だが durationMs 欠落 hook 無し
  })

  it('deny: 2 series split (tool_form vs action_form) and no double count with toolUseResult', async () => {
    await writeSession('s1.jsonl', [
      denyLine('Permission to use Bash with command rm -rf /tmp has been denied.'), // tool_form
      denyLine('Permission to use Edit has been denied.'), // tool_form
      denyLine(
        'Permission for this action has been denied. Reason: User deny rule prohibits PowerShell. If you have other tasks',
        true
      ), // action_form + 兄弟 toolUseResult
      denyLine('not a permission message', false) // is_error だが Permission パターン無し → 非カウント
    ])
    const res = await computeEnforcementStats({ projectsRoot: root })
    expect(res.deny.settingsJson.total).toBe(2) // tool_form 2
    expect(res.deny.rulePolicy.total).toBe(1) // action_form 1（toolUseResult で 2 にならない）
    const toolKeys = Object.fromEntries(res.deny.settingsJson.ranking.map((r) => [r.key, r.count]))
    expect(toolKeys['Bash']).toBe(1)
    expect(toolKeys['Edit']).toBe(1)
    expect(res.deny.rulePolicy.ranking[0].key).toContain('PowerShell')
  })

  it('marshal-review: only launch subcommands counted, ranked by subcommand; codex-review distinguished; ancillary excluded', async () => {
    await writeSession('s1.jsonl', [
      bashLine('node "C:/x/codex-companion.mjs" adversarial-review --wait --scope working-tree'), // marshal-review
      bashLine('node "C:/x/codex-companion.mjs" adversarial-review --json'), // marshal-review
      bashLine('node "C:/x/codex-companion.mjs" task "review prompt"'), // codex-review
      bashLine('node "C:/x/codex-companion.mjs" review'), // codex-review (native)
      bashLine('node "C:/x/codex-companion.mjs" status batch'), // 付帯操作 → 非カウント
      bashLine('node "C:/x/codex-companion.mjs" --help'), // 非カウント
      bashLine('npm run build'), // codex-companion 無し → 非カウント
      // 非 Bash の codex-companion 言及は非カウント
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'mentions codex-companion but not a Bash tool_use' }]
        },
        cwd: 'C:/x'
      })
    ])
    const res = await computeEnforcementStats({ projectsRoot: root })
    expect(res.marshal.total).toBe(4) // adversarial-review 2 + task 1 + review 1（status/--help/build 除外）
    const byKey = Object.fromEntries(res.marshal.ranking.map((r) => [r.key, r.count]))
    expect(byKey['adversarial-review (marshal-review)']).toBe(2)
    expect(byKey['task (codex-review)']).toBe(1)
    expect(byKey['review (codex-review)']).toBe(1)
    expect(res.marshal.ranking[0].key).toBe('adversarial-review (marshal-review)') // 降順
  })

  it('mixed record types in one file are counted in a single pass; Skill tool_use is ignored (no skill in result)', async () => {
    await writeSession('s1.jsonl', [
      skillLine('rumination'), // skill は enforcementStats では無視（種別ノイズ）
      stopLine({ commands: ['report-gate.sh'], blockingCommands: ['guard.sh'], hookErrors: ['x'] }),
      denyLine('Permission to use Bash has been denied.'),
      denyLine('Permission for this action has been denied. Reason: policy'),
      bashLine('node codex-companion.mjs adversarial-review')
    ])
    const res = await computeEnforcementStats({ projectsRoot: root })
    expect(res.hooksStop.total).toBe(1)
    expect(res.rulesB.total).toBe(1)
    expect(res.deny.settingsJson.total).toBe(1)
    expect(res.deny.rulePolicy.total).toBe(1)
    expect(res.marshal.total).toBe(1) // skill 行があっても他型に混入しない
    expect(res.filesScanned).toBe(1)
  })

  it('returns all-zero (with notes) for a non-existent projects root', async () => {
    const res = await computeEnforcementStats({ projectsRoot: join(root, 'does-not-exist') })
    expect(res.hooksStop.total).toBe(0)
    expect(res.rulesB.total).toBe(0)
    expect(res.deny.settingsJson.total).toBe(0)
    expect(res.deny.rulePolicy.total).toBe(0)
    expect(res.marshal.total).toBe(0)
    expect(res.hooksStop.scopeNote.length).toBeGreaterThan(0)
    expect(res.rulesLayerA.note.length).toBeGreaterThan(0)
  })

  it('scope notes: ja default / en, and rules層A reference note present', async () => {
    await writeSession('s1.jsonl', [stopLine({ commands: ['report-gate.sh'] })])
    const ja = await computeEnforcementStats({ projectsRoot: root })
    expect(ja.deny.scopeNote).toContain('近似')
    expect(ja.marshal.scopeNote).toContain('起動回数')
    expect(ja.rulesLayerA.note).toContain('計数対象外')
    const en = await computeEnforcementStats({ projectsRoot: root, lang: 'en' })
    expect(en.deny.scopeNote.toLowerCase()).toContain('approximate')
    expect(en.rulesLayerA.note.toLowerCase()).toContain('not counted')
  })

  it('recomputes consistently across cache (cache hit on unchanged files)', async () => {
    await writeSession('s1.jsonl', [
      stopLine({ commands: ['report-gate.sh'] }),
      denyLine('Permission to use Bash has been denied.'),
      bashLine('node codex-companion.mjs')
    ])
    const a = await computeEnforcementStats({ projectsRoot: root })
    const b = await computeEnforcementStats({ projectsRoot: root })
    expect(b.hooksStop.total).toBe(a.hooksStop.total)
    expect(b.deny.settingsJson.total).toBe(a.deny.settingsJson.total)
    expect(b.marshal.total).toBe(a.marshal.total)
  })
})
