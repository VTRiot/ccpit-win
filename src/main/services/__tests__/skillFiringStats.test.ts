import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { computeFiringStats, clearFiringStatsCache } from '../skillFiringStats'

let root: string

function skillLine(skill: string, timestamp: string, cwd: string): string {
  return JSON.stringify({
    message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill }, caller: { type: 'direct' } }] },
    timestamp,
    cwd,
    sessionId: 's'
  })
}

beforeEach(async () => {
  clearFiringStatsCache()
  root = join(tmpdir(), `ccpit-firing-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(root, { recursive: true })
})

afterEach(async () => {
  clearFiringStatsCache()
  await rm(root, { recursive: true, force: true })
})

describe('computeFiringStats', () => {
  it('aggregates per skill: count, lastFiredAt, byProject', async () => {
    const projA = join(root, 'projA')
    const projB = join(root, 'projB')
    await mkdir(projA, { recursive: true })
    await mkdir(projB, { recursive: true })
    await writeFile(
      join(projA, 's1.jsonl'),
      [
        skillLine('report', '2026-05-01T10:00:00Z', 'C:/projA'),
        skillLine('report', '2026-05-02T10:00:00Z', 'C:/projA'),
        skillLine('investigation', '2026-05-01T11:00:00Z', 'C:/projA')
      ].join('\n'),
      'utf-8'
    )
    await writeFile(
      join(projB, 's2.jsonl'),
      [skillLine('report', '2026-05-03T10:00:00Z', 'C:/projB')].join('\n'),
      'utf-8'
    )

    const res = await computeFiringStats({ projectsRoot: root })
    expect(res.filesScanned).toBe(2)
    expect(res.totalFirings).toBe(4)
    const report = res.stats.find((s) => s.skill === 'report')!
    expect(report.count).toBe(3)
    expect(report.lastFiredAt).toBe('2026-05-03T10:00:00Z') // 最大
    // PRJ 別: projA 2 / projB 1（多い順）
    expect(report.byProject[0]).toEqual({ project: 'C:/projA', count: 2 })
    expect(report.byProject[1]).toEqual({ project: 'C:/projB', count: 1 })
    // count 降順で report が先頭
    expect(res.stats[0].skill).toBe('report')
  })

  it('scope limit: ignores non-Skill tool_use, non-tool_use, and malformed lines', async () => {
    const proj = join(root, 'projC')
    await mkdir(proj, { recursive: true })
    const lines = [
      skillLine('report', '2026-05-01T10:00:00Z', 'C:/projC'), // ◯ 1 件
      JSON.stringify({
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
        timestamp: '2026-05-01T10:01:00Z',
        cwd: 'C:/projC'
      }), // ✗ Skill 以外の tool_use → 除外
      JSON.stringify({
        message: { content: [{ type: 'text', text: 'hello' }] },
        timestamp: '2026-05-01T10:02:00Z',
        cwd: 'C:/projC'
      }), // ✗ tool_use でない → 除外
      '{ this is not json', // ✗ 破損行 → skip
      JSON.stringify({ note: 'no message field' }) // ✗ message なし → 除外
    ]
    await writeFile(join(proj, 's.jsonl'), lines.join('\n'), 'utf-8')

    const res = await computeFiringStats({ projectsRoot: root })
    expect(res.totalFirings).toBe(1)
    expect(res.stats).toHaveLength(1)
    expect(res.stats[0].skill).toBe('report')
  })

  it('returns empty for a non-existent projects root', async () => {
    const res = await computeFiringStats({ projectsRoot: join(root, 'nope') })
    expect(res.stats).toEqual([])
    expect(res.totalFirings).toBe(0)
    expect(res.filesScanned).toBe(0)
  })

  it('includes a scope note (ja default / en)', async () => {
    const ja = await computeFiringStats({ projectsRoot: root })
    expect(ja.scopeNote).toContain('CLAUDE.md')
    const en = await computeFiringStats({ projectsRoot: root, lang: 'en' })
    expect(en.scopeNote.toLowerCase()).toContain('not all activations')
  })

  it('recomputes consistently across cache (cache hit on unchanged files)', async () => {
    const proj = join(root, 'projD')
    await mkdir(proj, { recursive: true })
    await writeFile(join(proj, 's.jsonl'), skillLine('report', '2026-05-01T10:00:00Z', 'C:/projD'), 'utf-8')
    const r1 = await computeFiringStats({ projectsRoot: root })
    const r2 = await computeFiringStats({ projectsRoot: root }) // 2 回目はキャッシュ経由
    expect(r2.totalFirings).toBe(r1.totalFirings)
    expect(r2.stats[0].count).toBe(1)
  })
})
