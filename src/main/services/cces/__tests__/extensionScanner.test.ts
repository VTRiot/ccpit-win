import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  scanClaudeMd,
  scanRules,
  scanSkills,
  scanHooks,
  scanMcp,
  scanSubagents,
  scanCommands,
  scanSettings,
  scanGlobal,
  scanProject,
  computeMergeNotes,
  validateProjectPath,
} from '../extensionScanner'

let workdir: string
let claudeDir: string
let projectDir: string

beforeEach(async () => {
  workdir = join(tmpdir(), `cces-scanner-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  claudeDir = join(workdir, '.claude')
  projectDir = join(workdir, 'project')
  await mkdir(claudeDir, { recursive: true })
  await mkdir(projectDir, { recursive: true })
})

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true })
})

describe('scanClaudeMd', () => {
  it('returns content + sha256 + size when file exists', async () => {
    const path = join(claudeDir, 'CLAUDE.md')
    await writeFile(path, '# Hello\n', 'utf-8')
    const result = await scanClaudeMd(path)
    expect(result).toBeDefined()
    expect(result?.content).toBe('# Hello\n')
    expect(result?.size).toBe(8)
    expect(result?.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('returns undefined when file does not exist', async () => {
    const result = await scanClaudeMd(join(claudeDir, 'absent.md'))
    expect(result).toBeUndefined()
  })
})

describe('scanRules', () => {
  it('lists *.md files with first heading as description', async () => {
    const rulesDir = join(claudeDir, 'rules')
    await mkdir(rulesDir, { recursive: true })
    await writeFile(join(rulesDir, 'a.md'), '# Rule A\n\nbody', 'utf-8')
    await writeFile(join(rulesDir, 'b.md'), 'first line\n# later heading', 'utf-8')
    await writeFile(join(rulesDir, 'c.md.bak'), '# Backup, should be skipped', 'utf-8')
    const result = await scanRules(rulesDir)
    expect(result.map((r) => r.name)).toEqual(['a.md', 'b.md'])
    expect(result[0].firstHeadingOrLine).toBe('Rule A')
    expect(result[1].firstHeadingOrLine).toBe('first line')
  })

  it('returns empty array when rules dir does not exist', async () => {
    const result = await scanRules(join(claudeDir, 'no-rules'))
    expect(result).toEqual([])
  })
})

describe('scanSkills', () => {
  it('discovers flat skills as regular and catalysts/* as catalyst', async () => {
    const skillsDir = join(claudeDir, 'skills')
    // Flat regular skill
    await mkdir(join(skillsDir, 'rumination'), { recursive: true })
    await writeFile(
      join(skillsDir, 'rumination', 'SKILL.md'),
      '---\nname: rumination\ndescription: Fires before implementation\n---\n',
      'utf-8',
    )
    // Catalysts grouping
    await mkdir(join(skillsDir, 'catalysts', 'dual-axis-translation'), { recursive: true })
    await writeFile(
      join(skillsDir, 'catalysts', 'dual-axis-translation', 'SKILL.md'),
      '---\nname: dual-axis-translation\ndescription: Bidirectional translation\n---\n',
      'utf-8',
    )

    const result = await scanSkills(skillsDir, 'global')
    expect(result.regular.map((s) => s.name)).toEqual(['rumination'])
    expect(result.catalyst.map((s) => s.name)).toEqual(['dual-axis-translation'])
    expect(result.catalyst[0].type).toBe('catalyst')
    expect(result.catalyst[0].groupName).toBe('catalysts')
    expect(result.catalyst[0].scope).toBe('global')
    expect(result.regular[0].description).toBe('Fires before implementation')
  })

  it('uses fallback name and "(no description)" when frontmatter missing', async () => {
    const skillsDir = join(claudeDir, 'skills')
    await mkdir(join(skillsDir, 'no-frontmatter'), { recursive: true })
    await writeFile(join(skillsDir, 'no-frontmatter', 'SKILL.md'), '# Just a heading', 'utf-8')

    const result = await scanSkills(skillsDir, 'global')
    expect(result.regular[0].name).toBe('no-frontmatter')
    expect(result.regular[0].description).toBe('(no description)')
  })

  it('returns empty bundle when skills dir absent', async () => {
    const result = await scanSkills(join(claudeDir, 'no-skills'), 'global')
    expect(result.regular).toEqual([])
    expect(result.catalyst).toEqual([])
  })
})

describe('scanHooks', () => {
  it('lists .sh files and parses settings hooks registrations', async () => {
    const hooksDir = join(claudeDir, 'hooks')
    await mkdir(hooksDir, { recursive: true })
    await writeFile(join(hooksDir, 'a.sh'), '#!/bin/bash\n', 'utf-8')
    await writeFile(join(hooksDir, 'b.sh'), '#!/bin/bash\n', 'utf-8')
    const settingsHooks = {
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'a.sh', timeout: 10 }] }],
      PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'b.sh' }] }],
    }
    const result = await scanHooks(hooksDir, settingsHooks)
    expect(result.files.map((f) => f.name)).toEqual(['a.sh', 'b.sh'])
    expect(result.registrations).toHaveLength(2)
    expect(result.registrations[0].type).toBe('Stop')
    expect(result.registrations[1].type).toBe('PreToolUse')
    expect(result.registrations[1].matcher).toBe('Edit')
  })

  it('returns empty registrations when settings has no hooks', async () => {
    const hooksDir = join(claudeDir, 'hooks')
    await mkdir(hooksDir, { recursive: true })
    const result = await scanHooks(hooksDir, undefined)
    expect(result.registrations).toEqual([])
    expect(result.files).toEqual([])
  })
})

describe('scanMcp', () => {
  it('reports configured=true when settings has mcpServers keys', () => {
    const result = scanMcp({ mcpServers: { local: { command: 'foo' } } }, claudeDir)
    expect(result.configured).toBe(true)
    expect(result.servers.map((s) => s.name)).toEqual(['local'])
  })

  it('reports configured=false when settings has no mcpServers', () => {
    const result = scanMcp({ permissions: {} }, claudeDir)
    expect(result.configured).toBe(false)
    expect(result.servers).toEqual([])
  })

  it('reports cacheStatus when mcp-needs-auth-cache.json exists', async () => {
    await writeFile(join(claudeDir, 'mcp-needs-auth-cache.json'), '{}', 'utf-8')
    const result = scanMcp({}, claudeDir)
    expect(result.cacheStatus).toBe('cache-present')
  })
})

describe('scanSubagents', () => {
  it('returns deployed=false when neither agents/ nor subagents/ exists', async () => {
    const result = await scanSubagents(claudeDir)
    expect(result.deployed).toBe(false)
    expect(result.agents).toEqual([])
  })

  it('reads frontmatter from agents/*.md when dir exists', async () => {
    const agentsDir = join(claudeDir, 'agents')
    await mkdir(agentsDir, { recursive: true })
    await writeFile(
      join(agentsDir, 'researcher.md'),
      '---\nname: researcher\ndescription: Investigates code\n---\n',
      'utf-8',
    )
    const result = await scanSubagents(claudeDir)
    expect(result.deployed).toBe(true)
    expect(result.agents).toEqual([{ name: 'researcher', description: 'Investigates code' }])
  })
})

describe('scanCommands', () => {
  it('returns empty when commands dir absent', async () => {
    const result = await scanCommands(join(projectDir, '.claude', 'commands'))
    expect(result).toEqual([])
  })

  it('reads commands with frontmatter', async () => {
    const commandsDir = join(projectDir, '.claude', 'commands')
    await mkdir(commandsDir, { recursive: true })
    await writeFile(
      join(commandsDir, 'ship.md'),
      '---\nname: ship\ndescription: Ships the build\n---\n',
      'utf-8',
    )
    const result = await scanCommands(commandsDir)
    expect(result).toEqual([{ name: 'ship', description: 'Ships the build' }])
  })
})

describe('scanSettings', () => {
  it('returns top-level keys only and never includes values', async () => {
    const settingsPath = join(claudeDir, 'settings.json')
    await writeFile(
      settingsPath,
      JSON.stringify({
        permissions: { deny: ['some.rule'] },
        auth: { password: 'secret-leak-must-not-appear' },
        hooks: {},
      }),
      'utf-8',
    )
    const result = await scanSettings(settingsPath)
    expect(result.layer?.keys).toEqual(['auth', 'hooks', 'permissions'])
    // The credential value MUST NOT appear in the structured layer.
    expect(JSON.stringify(result.layer)).not.toContain('secret-leak-must-not-appear')
  })

  it('returns empty object when file invalid JSON', async () => {
    const settingsPath = join(claudeDir, 'settings.json')
    await writeFile(settingsPath, '{not valid json', 'utf-8')
    const result = await scanSettings(settingsPath)
    expect(result.layer).toBeUndefined()
  })
})

describe('scanGlobal + scanProject', () => {
  it('orchestrates both layers without errors when nothing exists', async () => {
    const g = await scanGlobal(claudeDir)
    expect(g.rules).toEqual([])
    expect(g.skills.regular).toEqual([])
    expect(g.skills.catalyst).toEqual([])
    expect(g.subagents.deployed).toBe(false)
    expect(g.mcp.configured).toBe(false)

    const p = await scanProject(projectDir)
    expect(p.rules).toEqual([])
    expect(p.commands).toEqual([])
    expect(p.claudeMd).toBeUndefined()
  })

  it('finds CLAUDE.md and .claude/skills/ on the project layer', async () => {
    await writeFile(join(projectDir, 'CLAUDE.md'), '# Project rules', 'utf-8')
    const projectSkills = join(projectDir, '.claude', 'skills', 'project-skill')
    await mkdir(projectSkills, { recursive: true })
    await writeFile(
      join(projectSkills, 'SKILL.md'),
      '---\nname: project-skill\ndescription: Project-only\n---\n',
      'utf-8',
    )
    const p = await scanProject(projectDir)
    expect(p.claudeMd?.content).toBe('# Project rules')
    expect(p.skills.regular.map((s) => s.name)).toEqual(['project-skill'])
    expect(p.skills.regular[0].scope).toBe('project')
  })
})

describe('computeMergeNotes', () => {
  it('flags rule and skill names that exist in both layers', async () => {
    // Global side
    const globalRules = join(claudeDir, 'rules')
    await mkdir(globalRules, { recursive: true })
    await writeFile(join(globalRules, 'shared.md'), '# Shared', 'utf-8')

    const globalSkillsDir = join(claudeDir, 'skills', 'shared-skill')
    await mkdir(globalSkillsDir, { recursive: true })
    await writeFile(join(globalSkillsDir, 'SKILL.md'), '---\nname: shared-skill\ndescription: x\n---\n', 'utf-8')

    // Project side
    const projectRules = join(projectDir, '.claude', 'rules')
    await mkdir(projectRules, { recursive: true })
    await writeFile(join(projectRules, 'shared.md'), '# Project override', 'utf-8')

    const projectSkillDir = join(projectDir, '.claude', 'skills', 'shared-skill')
    await mkdir(projectSkillDir, { recursive: true })
    await writeFile(join(projectSkillDir, 'SKILL.md'), '---\nname: shared-skill\ndescription: y\n---\n', 'utf-8')

    const g = await scanGlobal(claudeDir)
    const p = await scanProject(projectDir)
    const notes = computeMergeNotes(g, p)
    expect(notes).toEqual(
      expect.arrayContaining([
        { kind: 'rule', name: 'shared.md', overriddenIn: 'project' },
        { kind: 'skill', name: 'shared-skill', overriddenIn: 'project' },
      ]),
    )
  })

  it('returns empty when no name collisions', async () => {
    const g = await scanGlobal(claudeDir)
    const p = await scanProject(projectDir)
    expect(computeMergeNotes(g, p)).toEqual([])
  })
})

describe('validateProjectPath', () => {
  it('returns null for existing directory', () => {
    expect(validateProjectPath(projectDir)).toBeNull()
  })

  it('returns error string for non-existent path', () => {
    expect(validateProjectPath(join(workdir, 'absent'))).toBe('Project path does not exist')
  })
})
