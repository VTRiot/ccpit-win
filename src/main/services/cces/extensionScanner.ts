/**
 * CCES Ver.1.0 — Extension scanner.
 *
 * Scans the Global (~/.claude/) and Project (<projectPath>/ + <projectPath>/.claude/)
 * layers, producing structured data for each of the 7 Anthropic Extensions
 * (CLAUDE.md / Skills / MCP / Subagents / Hooks / Plugins / Marketplaces) plus the
 * project-only commands/ layer.
 *
 * Error strategy: per-file try/catch. A failing read does not abort the whole scan;
 * it leaves the affected entry empty (or annotated as unreadable) and the rest continues.
 * This is consistent with health.ts which also tolerates missing/unreadable layers.
 */

import { readFile, readdir } from 'fs/promises'
import { join } from 'path'
import { existsSync, statSync } from 'fs'
import { createHash } from 'crypto'
import type {
  ClaudeMd,
  CommandEntry,
  GlobalLayer,
  HookRegistration,
  HooksLayer,
  MarketplaceEntry,
  McpLayer,
  MergeNote,
  PluginEntry,
  PluginsLayer,
  ProjectLayer,
  RuleEntry,
  SettingsLayer,
  Skill,
  SubagentEntry,
  SubagentsLayer,
} from './types'

// ---------- Frontmatter parser ----------

/**
 * Extracts `name:` and `description:` from a YAML frontmatter block.
 * Returns empty object if no frontmatter or fields missing.
 *
 * Exported for unit testing. We avoid pulling in a full YAML library because the
 * frontmatter contract for SKILL.md / agents / commands is constrained to these two fields.
 */
export function parseFrontmatter(md: string): { name?: string; description?: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return {}
  const yaml = m[1]
  const name = yaml.match(/^name:\s*(.+)$/m)?.[1]?.trim()
  const description = yaml.match(/^description:\s*(.+)$/m)?.[1]?.trim()
  return { name, description }
}

// ---------- File-level helpers ----------

async function readClaudeMd(filePath: string): Promise<ClaudeMd | undefined> {
  if (!existsSync(filePath)) return undefined
  try {
    const content = await readFile(filePath, 'utf-8')
    const sha256 = createHash('sha256').update(content, 'utf8').digest('hex')
    return {
      path: filePath,
      size: Buffer.byteLength(content, 'utf8'),
      sha256,
      content,
    }
  } catch {
    return undefined
  }
}

function firstHeadingOrLine(content: string): string {
  const lines = content.split(/\r?\n/)
  const firstNonEmpty = lines.find((l) => l.trim().length > 0)
  if (!firstNonEmpty) return ''
  return firstNonEmpty.replace(/^#{1,6}\s+/, '').trim()
}

// ---------- scanClaudeMd ----------

export async function scanClaudeMd(filePath: string): Promise<ClaudeMd | undefined> {
  return readClaudeMd(filePath)
}

// ---------- scanRules ----------

export async function scanRules(rulesDir: string): Promise<RuleEntry[]> {
  if (!existsSync(rulesDir)) return []
  let entries: string[] = []
  try {
    const dirents = await readdir(rulesDir, { withFileTypes: true })
    entries = dirents
      .filter((e) => e.isFile() && e.name.endsWith('.md') && !e.name.endsWith('.bak'))
      .map((e) => e.name)
  } catch {
    return []
  }
  const out: RuleEntry[] = []
  for (const name of entries.sort()) {
    try {
      const content = await readFile(join(rulesDir, name), 'utf-8')
      out.push({ name, firstHeadingOrLine: firstHeadingOrLine(content) })
    } catch {
      out.push({ name, firstHeadingOrLine: '(unreadable)' })
    }
  }
  return out
}

// ---------- scanSkills ----------

interface SkillScanResult {
  regular: Skill[]
  catalyst: Skill[]
}

/**
 * Walks skills/ directory, recognizing two layouts:
 *   Flat:    <dir>/<name>/SKILL.md           → regular
 *   Nested:  <dir>/<group>/<name>/SKILL.md   → catalyst (if group === 'catalysts'), else regular w/ groupName
 *
 * The grouping subdir itself (e.g. 'catalysts') is NOT emitted as a skill.
 */
export async function scanSkills(skillsDir: string, scope: 'global' | 'project'): Promise<SkillScanResult> {
  const regular: Skill[] = []
  const catalyst: Skill[] = []
  if (!existsSync(skillsDir)) return { regular, catalyst }

  let topEntries: string[] = []
  try {
    const dirents = await readdir(skillsDir, { withFileTypes: true })
    topEntries = dirents.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return { regular, catalyst }
  }

  for (const name of topEntries.sort()) {
    const childPath = join(skillsDir, name)
    const flatSkillMd = join(childPath, 'SKILL.md')
    if (existsSync(flatSkillMd)) {
      const skill = await readSkill(name, flatSkillMd, scope, undefined, 'regular')
      regular.push(skill)
      continue
    }
    // Possibly a grouping subdir: look one level deeper.
    let grandchildren: string[] = []
    try {
      const inner = await readdir(childPath, { withFileTypes: true })
      grandchildren = inner.filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
      continue
    }
    for (const gname of grandchildren.sort()) {
      const skillMd = join(childPath, gname, 'SKILL.md')
      if (!existsSync(skillMd)) continue
      const type: 'regular' | 'catalyst' = name === 'catalysts' ? 'catalyst' : 'regular'
      const skill = await readSkill(gname, skillMd, scope, name, type)
      if (type === 'catalyst') {
        catalyst.push(skill)
      } else {
        regular.push(skill)
      }
    }
  }
  return { regular, catalyst }
}

async function readSkill(
  fallbackName: string,
  skillMdPath: string,
  scope: 'global' | 'project',
  groupName: string | undefined,
  type: 'regular' | 'catalyst',
): Promise<Skill> {
  let name = fallbackName
  let description = '(no description)'
  try {
    const content = await readFile(skillMdPath, 'utf-8')
    const fm = parseFrontmatter(content)
    if (fm.name) name = fm.name
    if (fm.description) description = fm.description
  } catch {
    description = '(unreadable)'
  }
  return { name, description, type, groupName, scope, path: skillMdPath }
}

// ---------- scanHooks ----------

export async function scanHooks(hooksDir: string, settingsHooks: unknown): Promise<HooksLayer> {
  const files: Array<{ name: string; path: string }> = []
  if (existsSync(hooksDir)) {
    try {
      const dirents = await readdir(hooksDir, { withFileTypes: true })
      for (const e of dirents) {
        if (e.isFile() && e.name.endsWith('.sh')) {
          files.push({ name: e.name, path: join(hooksDir, e.name) })
        }
      }
      files.sort((a, b) => a.name.localeCompare(b.name))
    } catch {
      /* ignore — empty list */
    }
  }
  const registrations = parseHookRegistrations(settingsHooks)
  return { files, registrations }
}

function parseHookRegistrations(settingsHooks: unknown): HookRegistration[] {
  const out: HookRegistration[] = []
  if (!settingsHooks || typeof settingsHooks !== 'object') return out
  for (const [hookType, groups] of Object.entries(settingsHooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue
    for (const group of groups) {
      if (!group || typeof group !== 'object') continue
      const matcher = typeof (group as { matcher?: unknown }).matcher === 'string'
        ? ((group as { matcher: string }).matcher)
        : ''
      const inner = (group as { hooks?: unknown }).hooks
      if (!Array.isArray(inner)) continue
      for (const h of inner) {
        if (!h || typeof h !== 'object') continue
        const command = typeof (h as { command?: unknown }).command === 'string'
          ? ((h as { command: string }).command)
          : ''
        out.push({ type: hookType, matcher, command })
      }
    }
  }
  return out
}

// ---------- scanMcp ----------

export function scanMcp(settings: Record<string, unknown> | undefined, claudeDir: string): McpLayer {
  const servers: Array<{ name: string }> = []
  let configured = false
  if (settings && typeof settings === 'object') {
    const mcp = (settings as { mcpServers?: unknown }).mcpServers
    if (mcp && typeof mcp === 'object') {
      for (const key of Object.keys(mcp as Record<string, unknown>)) {
        servers.push({ name: key })
        configured = true
      }
    }
  }
  let cacheStatus: string | undefined
  const cachePath = join(claudeDir, 'mcp-needs-auth-cache.json')
  if (existsSync(cachePath)) {
    cacheStatus = 'cache-present'
  }
  return { configured, servers, cacheStatus }
}

// ---------- scanSubagents ----------

export async function scanSubagents(claudeDir: string): Promise<SubagentsLayer> {
  // Try both ~/.claude/agents/ and ~/.claude/subagents/ (instruction r4 §1 mentions both as possible)
  const candidates = [join(claudeDir, 'agents'), join(claudeDir, 'subagents')]
  for (const dir of candidates) {
    if (!existsSync(dir)) continue
    try {
      const dirents = await readdir(dir, { withFileTypes: true })
      const files = dirents.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name)
      const agents: SubagentEntry[] = []
      for (const f of files.sort()) {
        try {
          const content = await readFile(join(dir, f), 'utf-8')
          const fm = parseFrontmatter(content)
          agents.push({
            name: fm.name ?? f.replace(/\.md$/, ''),
            description: fm.description ?? '(no description)',
          })
        } catch {
          agents.push({ name: f.replace(/\.md$/, ''), description: '(unreadable)' })
        }
      }
      return { deployed: true, agents }
    } catch {
      /* fall through */
    }
  }
  return { deployed: false, agents: [] }
}

// ---------- scanPluginsAndMarketplaces ----------

interface PluginsAndMarketplaces {
  plugins: PluginsLayer
  marketplaces: MarketplaceEntry[]
}

export async function scanPluginsAndMarketplaces(claudeDir: string): Promise<PluginsAndMarketplaces> {
  const pluginsDir = join(claudeDir, 'plugins')
  const knownPath = join(pluginsDir, 'known_marketplaces.json')
  const marketplaces: MarketplaceEntry[] = []
  const plugins: PluginEntry[] = []
  if (!existsSync(knownPath)) {
    return { plugins: { plugins }, marketplaces }
  }
  try {
    const raw = await readFile(knownPath, 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      for (const [id, info] of Object.entries(parsed as Record<string, unknown>)) {
        const source = pickStringFromSource(info)
        const lastUpdated = pickStringFromKey(info, 'lastUpdated')
        marketplaces.push({ id, source, lastUpdated })

        // Walk the marketplace's plugins/ dir if installLocation is on disk.
        const installLocation = pickStringFromKey(info, 'installLocation')
        if (installLocation) {
          const pluginsSub = join(installLocation, 'plugins')
          if (existsSync(pluginsSub)) {
            try {
              const dirents = await readdir(pluginsSub, { withFileTypes: true })
              for (const e of dirents) {
                if (e.isDirectory()) {
                  plugins.push({ marketplace: id, name: e.name })
                }
              }
            } catch {
              /* ignore */
            }
          }
        }
      }
    }
  } catch {
    /* ignore — return whatever we collected */
  }
  return { plugins: { plugins }, marketplaces }
}

function pickStringFromSource(info: unknown): string {
  if (!info || typeof info !== 'object') return ''
  const src = (info as { source?: unknown }).source
  if (typeof src === 'string') return src
  if (src && typeof src === 'object') {
    const repo = (src as { repo?: unknown }).repo
    const kind = (src as { source?: unknown }).source
    if (typeof repo === 'string' && typeof kind === 'string') return `${kind}:${repo}`
    if (typeof repo === 'string') return repo
    if (typeof kind === 'string') return kind
  }
  return ''
}

function pickStringFromKey(info: unknown, key: string): string | undefined {
  if (!info || typeof info !== 'object') return undefined
  const v = (info as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : undefined
}

// ---------- scanCommands (project-only, MANX r7 §3-3) ----------

export async function scanCommands(commandsDir: string): Promise<CommandEntry[]> {
  if (!existsSync(commandsDir)) return []
  try {
    const dirents = await readdir(commandsDir, { withFileTypes: true })
    const files = dirents.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name)
    const out: CommandEntry[] = []
    for (const f of files.sort()) {
      try {
        const content = await readFile(join(commandsDir, f), 'utf-8')
        const fm = parseFrontmatter(content)
        out.push({
          name: fm.name ?? f.replace(/\.md$/, ''),
          description: fm.description ?? firstHeadingOrLine(content) ?? '(no description)',
        })
      } catch {
        out.push({ name: f.replace(/\.md$/, ''), description: '(unreadable)' })
      }
    }
    return out
  } catch {
    return []
  }
}

// ---------- scanSettings ----------

/**
 * Returns top-level keys only. NEVER includes values — the settings.json may contain
 * credentials (auth.password, API keys, etc.) and we must not exfiltrate them.
 */
export async function scanSettings(settingsPath: string): Promise<{ layer?: SettingsLayer; raw?: Record<string, unknown> }> {
  if (!existsSync(settingsPath)) return {}
  try {
    const content = await readFile(settingsPath, 'utf-8')
    const parsed: unknown = JSON.parse(content)
    if (parsed && typeof parsed === 'object') {
      const keys = Object.keys(parsed as Record<string, unknown>).sort()
      return { layer: { keys }, raw: parsed as Record<string, unknown> }
    }
  } catch {
    /* unreadable / invalid JSON */
  }
  return {}
}

// ---------- Top-level orchestrators ----------

export async function scanGlobal(claudeDir: string): Promise<GlobalLayer> {
  const settingsResult = await scanSettings(join(claudeDir, 'settings.json'))
  const settingsRaw = settingsResult.raw

  const [claudeMd, rules, skills, hooks, subagents, pluginsAndMarkets] = await Promise.all([
    scanClaudeMd(join(claudeDir, 'CLAUDE.md')),
    scanRules(join(claudeDir, 'rules')),
    scanSkills(join(claudeDir, 'skills'), 'global'),
    scanHooks(
      join(claudeDir, 'hooks'),
      settingsRaw && typeof settingsRaw === 'object' ? (settingsRaw as { hooks?: unknown }).hooks : undefined,
    ),
    scanSubagents(claudeDir),
    scanPluginsAndMarketplaces(claudeDir),
  ])

  const mcp = scanMcp(settingsRaw, claudeDir)

  return {
    claudeMd,
    rules,
    skills,
    hooks,
    mcp,
    subagents,
    plugins: pluginsAndMarkets.plugins,
    marketplaces: pluginsAndMarkets.marketplaces,
  }
}

export async function scanProject(projectPath: string): Promise<ProjectLayer> {
  const projectClaudeDir = join(projectPath, '.claude')
  const settingsResult = await scanSettings(join(projectClaudeDir, 'settings.json'))
  const settingsLocalResult = await scanSettings(join(projectClaudeDir, 'settings.local.json'))

  const [claudeMd, claudeLocal, rules, skills, agents, commands] = await Promise.all([
    scanClaudeMd(join(projectPath, 'CLAUDE.md')),
    scanClaudeMd(join(projectPath, 'CLAUDE.local.md')),
    scanRules(join(projectClaudeDir, 'rules')),
    scanSkills(join(projectClaudeDir, 'skills'), 'project'),
    scanProjectAgents(join(projectClaudeDir, 'agents')),
    scanCommands(join(projectClaudeDir, 'commands')),
  ])

  return {
    claudeMd,
    claudeLocal,
    settings: settingsResult.layer,
    settingsLocal: settingsLocalResult.layer,
    rules,
    skills,
    agents,
    commands,
  }
}

async function scanProjectAgents(agentsDir: string): Promise<SubagentEntry[]> {
  if (!existsSync(agentsDir)) return []
  try {
    const dirents = await readdir(agentsDir, { withFileTypes: true })
    const files = dirents.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name)
    const out: SubagentEntry[] = []
    for (const f of files.sort()) {
      try {
        const content = await readFile(join(agentsDir, f), 'utf-8')
        const fm = parseFrontmatter(content)
        out.push({
          name: fm.name ?? f.replace(/\.md$/, ''),
          description: fm.description ?? '(no description)',
        })
      } catch {
        out.push({ name: f.replace(/\.md$/, ''), description: '(unreadable)' })
      }
    }
    return out
  } catch {
    return []
  }
}

// ---------- Merge note computation ----------

/**
 * Detects names that exist in both layers — the project-layer entry overrides Global per
 * MANX Protocol r7 §3-3.
 */
export function computeMergeNotes(globalLayer: GlobalLayer, projectLayer: ProjectLayer): MergeNote[] {
  const notes: MergeNote[] = []

  // Rules
  const globalRuleNames = new Set(globalLayer.rules.map((r) => r.name))
  for (const r of projectLayer.rules) {
    if (globalRuleNames.has(r.name)) {
      notes.push({ kind: 'rule', name: r.name, overriddenIn: 'project' })
    }
  }

  // Skills (regular + catalyst, by name)
  const globalSkillNames = new Set(
    [...globalLayer.skills.regular, ...globalLayer.skills.catalyst].map((s) => s.name),
  )
  for (const s of [...projectLayer.skills.regular, ...projectLayer.skills.catalyst]) {
    if (globalSkillNames.has(s.name)) {
      notes.push({ kind: 'skill', name: s.name, overriddenIn: 'project' })
    }
  }

  // Settings keys (top-level)
  if (projectLayer.settings && projectLayer.settings.keys.length > 0) {
    // Note: we can detect overrides only if scanGlobal exposes its settings keys too.
    // For Ver.1.0, we conservatively skip cross-layer settings comparison and only flag
    // when both layers were scanned with explicit overlap (left for Ver.1.5+).
  }

  return notes
}

// ---------- Path helpers ----------

/**
 * Validates that the project path exists and is a directory.
 * Returns null if valid, or an error string otherwise.
 */
export function validateProjectPath(projectPath: string): string | null {
  if (!existsSync(projectPath)) return 'Project path does not exist'
  try {
    const st = statSync(projectPath)
    if (!st.isDirectory()) return 'Project path is not a directory'
    return null
  } catch {
    return 'Project path is not accessible'
  }
}
