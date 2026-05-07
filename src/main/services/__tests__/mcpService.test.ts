import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  listMcpServers,
  readClaudeJson,
  readProjectMcpJson,
  classifyTools,
  classifyRisk,
  looksLikePlainSecret,
  getProjectMcpJsonPath,
  type McpPaths,
  type McpServer
} from '../mcpService'
import { isWriteTool, hasAuthEnv } from '../mcp/writeKeywords'

let workdir: string
let paths: McpPaths
let projectDir: string

beforeEach(async () => {
  workdir = join(
    tmpdir(),
    `ccpit-mcp-service-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  await mkdir(workdir, { recursive: true })
  paths = { claudeJsonPath: join(workdir, '.claude.json') }
  projectDir = join(workdir, 'pj')
  await mkdir(projectDir, { recursive: true })
})

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true })
})

async function writeClaudeJson(content: object): Promise<void> {
  await writeFile(paths.claudeJsonPath, JSON.stringify(content, null, 2), 'utf-8')
}

async function writeProjectMcpJson(content: object): Promise<void> {
  await writeFile(getProjectMcpJsonPath(projectDir), JSON.stringify(content, null, 2), 'utf-8')
}

describe('isWriteTool', () => {
  it('detects write prefixes', () => {
    expect(isWriteTool('create_issue')).toBe(true)
    expect(isWriteTool('update_repo')).toBe(true)
    expect(isWriteTool('delete_thing')).toBe(true)
    expect(isWriteTool('push_files')).toBe(true)
    expect(isWriteTool('merge_pull_request')).toBe(true)
  })

  it('detects write suffixes', () => {
    expect(isWriteTool('repo_create')).toBe(true)
    expect(isWriteTool('issue_update')).toBe(true)
  })

  it('returns false for read-only names', () => {
    expect(isWriteTool('list_issues')).toBe(false)
    expect(isWriteTool('get_repository')).toBe(false)
    expect(isWriteTool('search_code')).toBe(false)
    expect(isWriteTool('read_wiki_contents')).toBe(false)
  })

  it('is case-insensitive for prefixes', () => {
    expect(isWriteTool('CREATE_THING')).toBe(true)
  })
})

describe('hasAuthEnv', () => {
  it('detects token / pat / api_key / secret keys', () => {
    expect(hasAuthEnv({ GITHUB_PERSONAL_ACCESS_TOKEN: 'x' })).toBe(true)
    expect(hasAuthEnv({ MY_API_KEY: 'x' })).toBe(true)
    expect(hasAuthEnv({ DB_PASSWORD: 'x' })).toBe(true)
    expect(hasAuthEnv({ OAUTH_CLIENT_ID: 'x' })).toBe(true)
    expect(hasAuthEnv({ STRIPE_SECRET: 'x' })).toBe(true)
  })

  it('returns false when env is empty / undefined', () => {
    expect(hasAuthEnv(undefined)).toBe(false)
    expect(hasAuthEnv({})).toBe(false)
  })

  it('returns false when no auth-like key is present', () => {
    expect(hasAuthEnv({ DEBUG: '1', LOG_LEVEL: 'info' })).toBe(false)
  })
})

describe('classifyTools', () => {
  it('partitions tool names into write / read', () => {
    const { writeTools, readTools } = classifyTools([
      'create_issue',
      'list_issues',
      'delete_repository',
      'get_user',
      'merge_pull_request'
    ])
    expect(writeTools).toEqual(['create_issue', 'delete_repository', 'merge_pull_request'])
    expect(readTools).toEqual(['list_issues', 'get_user'])
  })
})

describe('classifyRisk', () => {
  it('returns safe for env-less, no disabledTools', () => {
    const s: McpServer = { name: 'deepwiki', command: 'npx', args: ['-y', 'mcp-deepwiki@latest'] }
    expect(classifyRisk(s)).toBe('safe')
  })

  it('returns strict when env contains auth indicator', () => {
    const s: McpServer = {
      name: 'github',
      command: 'npx',
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_PERSONAL_ACCESS_TOKEN}' }
    }
    expect(classifyRisk(s)).toBe('strict')
  })

  it('returns strict when disabledTools includes write tools (auth env なしでも)', () => {
    const s: McpServer = {
      name: 'custom',
      command: 'npx',
      env: {},
      disabledTools: ['create_thing']
    }
    expect(classifyRisk(s)).toBe('strict')
  })

  it('returns caution when env has only non-auth keys', () => {
    const s: McpServer = {
      name: 'verbose',
      command: 'npx',
      env: { DEBUG: '1' }
    }
    expect(classifyRisk(s)).toBe('caution')
  })
})

describe('looksLikePlainSecret', () => {
  it('passes ${VAR} format', () => {
    expect(looksLikePlainSecret('${GITHUB_PERSONAL_ACCESS_TOKEN}')).toBe(false)
    expect(looksLikePlainSecret('${API_KEY_2}')).toBe(false)
  })

  it('passes empty string', () => {
    expect(looksLikePlainSecret('')).toBe(false)
  })

  it('flags github PAT-looking strings', () => {
    expect(looksLikePlainSecret('ghp_abcdefghij1234567890')).toBe(true)
    expect(looksLikePlainSecret('github_pat_11AAAA_zzzz')).toBe(true)
  })

  it('flags long opaque tokens', () => {
    expect(looksLikePlainSecret('abc123XYZ_very_long_random_string_32chars')).toBe(true)
  })

  it('does not flag short literal values', () => {
    expect(looksLikePlainSecret('debug')).toBe(false)
    expect(looksLikePlainSecret('1')).toBe(false)
  })
})

describe('listMcpServers', () => {
  it('returns [] when ~/.claude.json is missing', async () => {
    const servers = await listMcpServers('global', undefined, paths)
    expect(servers).toEqual([])
  })

  it('returns [] when JSON is malformed', async () => {
    await writeFile(paths.claudeJsonPath, '{ this is not json', 'utf-8')
    const servers = await listMcpServers('global', undefined, paths)
    expect(servers).toEqual([])
  })

  it('returns [] when mcpServers section is absent', async () => {
    await writeClaudeJson({ otherStuff: true })
    const servers = await listMcpServers('global', undefined, paths)
    expect(servers).toEqual([])
  })

  it('reads global mcpServers entries', async () => {
    await writeClaudeJson({
      mcpServers: {
        deepwiki: { command: 'npx', args: ['-y', 'mcp-deepwiki@latest'] },
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_PERSONAL_ACCESS_TOKEN}' },
          disabledTools: ['create_issue']
        }
      }
    })
    const servers = await listMcpServers('global', undefined, paths)
    expect(servers).toHaveLength(2)
    const dw = servers.find((s) => s.name === 'deepwiki')
    expect(dw?.command).toBe('npx')
    const gh = servers.find((s) => s.name === 'github')
    expect(gh?.disabledTools).toEqual(['create_issue'])
  })

  it('returns [] for project scope when projectPath omitted', async () => {
    const servers = await listMcpServers('project', undefined, paths)
    expect(servers).toEqual([])
  })

  it('reads project .mcp.json entries', async () => {
    await writeProjectMcpJson({
      mcpServers: {
        local: { command: 'node', args: ['./local-server.js'] }
      }
    })
    const servers = await listMcpServers('project', projectDir, paths)
    expect(servers).toHaveLength(1)
    expect(servers[0].name).toBe('local')
  })
})

describe('readClaudeJson / readProjectMcpJson', () => {
  it('returns {} for missing files', async () => {
    expect(await readClaudeJson(paths)).toEqual({})
    expect(await readProjectMcpJson(projectDir)).toEqual({})
  })

  it('returns parsed content', async () => {
    await writeClaudeJson({ mcpServers: { a: { command: 'x' } }, other: 1 })
    const json = await readClaudeJson(paths)
    expect(json.mcpServers?.a?.command).toBe('x')
    expect((json as { other?: unknown }).other).toBe(1)
  })
})
