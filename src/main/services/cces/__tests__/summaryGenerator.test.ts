import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { generateExtensionsSummary, formatAsMarkdown } from '../summaryGenerator'
import type { ExtensionsSummary } from '../types'

let workdir: string
let claudeDir: string
let projectDir: string

beforeEach(async () => {
  workdir = join(tmpdir(), `cces-summary-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  claudeDir = join(workdir, '.claude')
  projectDir = join(workdir, 'project')
  await mkdir(claudeDir, { recursive: true })
  await mkdir(projectDir, { recursive: true })
})

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true })
})

describe('generateExtensionsSummary', () => {
  it('produces metadata with the expected shape', async () => {
    const summary = await generateExtensionsSummary({
      claudeDir,
      projectPath: projectDir,
      opening: 'Here is the snapshot.',
    })
    expect(summary.metadata.version).toBe('v1.0')
    expect(summary.metadata.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(summary.metadata.hostHash).toMatch(/^[0-9a-f]{64}$/)
    expect(summary.metadata.projectPath).toBe(projectDir)
    expect(summary.metadata.projectName).toBe('project')
    expect(summary.opening).toBe('Here is the snapshot.')
  })

  it('produces a stable hostHash when content is unchanged', async () => {
    const a = await generateExtensionsSummary({ claudeDir, projectPath: projectDir, opening: 'X' })
    const b = await generateExtensionsSummary({ claudeDir, projectPath: projectDir, opening: 'X' })
    expect(a.metadata.hostHash).toBe(b.metadata.hostHash)
  })

  it('changes hostHash when content changes', async () => {
    const a = await generateExtensionsSummary({ claudeDir, projectPath: projectDir, opening: 'X' })
    // Add a project-level skill — should perturb the hash.
    const skillDir = join(projectDir, '.claude', 'skills', 'new-skill')
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: new-skill\ndescription: added\n---\n',
      'utf-8',
    )
    const b = await generateExtensionsSummary({ claudeDir, projectPath: projectDir, opening: 'X' })
    expect(a.metadata.hostHash).not.toBe(b.metadata.hostHash)
  })

  it('flags oversized=false for a small empty project', async () => {
    const summary = await generateExtensionsSummary({
      claudeDir,
      projectPath: projectDir,
      opening: '',
    })
    expect(summary.oversized).toBe(false)
  })
})

describe('formatAsMarkdown', () => {
  it('includes the opening section when opening is non-empty', async () => {
    const summary = await generateExtensionsSummary({
      claudeDir,
      projectPath: projectDir,
      opening: 'Hello world',
    })
    const md = formatAsMarkdown(summary)
    expect(md).toContain('## Opening')
    expect(md).toContain('Hello world')
  })

  it('omits the opening section when opening is empty', async () => {
    const summary = await generateExtensionsSummary({
      claudeDir,
      projectPath: projectDir,
      opening: '',
    })
    const md = formatAsMarkdown(summary)
    expect(md).not.toContain('## Opening')
  })

  it('renders catalyst skills under their own subsection with the warning note', async () => {
    const skillsDir = join(claudeDir, 'skills', 'catalysts', 'subtraction-design')
    await mkdir(skillsDir, { recursive: true })
    await writeFile(
      join(skillsDir, 'SKILL.md'),
      '---\nname: subtraction-design\ndescription: catalyst skill\n---\n',
      'utf-8',
    )
    const summary = await generateExtensionsSummary({
      claudeDir,
      projectPath: projectDir,
      opening: '',
    })
    const md = formatAsMarkdown(summary)
    expect(md).toContain('### Skills (Catalyst)')
    expect(md).toContain('subtraction-design')
    expect(md).toContain('※ 触媒型')
  })

  it('emits a "_Subagents: not deployed_" line when no agents/ exists', async () => {
    const summary = await generateExtensionsSummary({
      claudeDir,
      projectPath: projectDir,
      opening: '',
    })
    const md = formatAsMarkdown(summary)
    expect(md).toContain('_Subagents: not deployed_')
  })

  it('reports "_MCP: not configured_" when settings has no mcpServers', async () => {
    await writeFile(join(claudeDir, 'settings.json'), JSON.stringify({ permissions: {} }), 'utf-8')
    const summary = await generateExtensionsSummary({
      claudeDir,
      projectPath: projectDir,
      opening: '',
    })
    const md = formatAsMarkdown(summary)
    expect(md).toContain('_MCP: not configured_')
  })

  it('does not leak settings.json values into the rendered Markdown', async () => {
    const projectClaudeDir = join(projectDir, '.claude')
    await mkdir(projectClaudeDir, { recursive: true })
    await writeFile(
      join(projectClaudeDir, 'settings.local.json'),
      JSON.stringify({ permissions: { allow: ['SECRET_VALUE_DO_NOT_LEAK'] } }),
      'utf-8',
    )
    const summary = await generateExtensionsSummary({
      claudeDir,
      projectPath: projectDir,
      opening: '',
    })
    const md = formatAsMarkdown(summary)
    expect(md).toContain('settings.local.json')
    expect(md).toContain('permissions')
    expect(md).not.toContain('SECRET_VALUE_DO_NOT_LEAK')
  })

  it('includes Merge Notes section even when no collisions', async () => {
    const summary = await generateExtensionsSummary({
      claudeDir,
      projectPath: projectDir,
      opening: '',
    })
    const md = formatAsMarkdown(summary)
    expect(md).toContain('## Merge Notes')
    expect(md).toContain('no name collisions detected')
  })

  it('renders project CLAUDE.md content fully', async () => {
    await writeFile(join(projectDir, 'CLAUDE.md'), '# Project Constitution\n\nbody body body', 'utf-8')
    const summary = await generateExtensionsSummary({
      claudeDir,
      projectPath: projectDir,
      opening: '',
    })
    const md = formatAsMarkdown(summary)
    expect(md).toContain('Project Constitution')
    expect(md).toContain('body body body')
  })
})

describe('ExtensionsSummary shape sanity', () => {
  it('has all top-level fields populated by the generator', async () => {
    const summary: ExtensionsSummary = await generateExtensionsSummary({
      claudeDir,
      projectPath: projectDir,
      opening: 'x',
    })
    expect(summary.metadata).toBeDefined()
    expect(summary.global).toBeDefined()
    expect(summary.project).toBeDefined()
    expect(summary.mergeNotes).toBeDefined()
    expect(typeof summary.oversized).toBe('boolean')
  })
})
