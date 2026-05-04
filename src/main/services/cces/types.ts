/**
 * CCES (ClaudeCode-ExtensionsSummary) Ver.1.0 — Data model.
 *
 * Models the "hand of cards" that Claude Code sees when launched from a project:
 *   Global (~/.claude/) + Project (<projectPath>/ + <projectPath>/.claude/)
 *
 * Per MANX Protocol r7 §3-1〜3-3: the project layer takes precedence over global
 * when names collide; we surface those collisions via {@link ExtensionsSummary.mergeNotes}.
 */

export interface ExtensionsSummaryMetadata {
  /**
   * Generated timestamp (ISO 8601).
   *
   * Why this exists in Ver.1.0 (despite not being read by Ver.1.0 code):
   * - Ver.1.5 will use this to log CCES generations into HandOver Vol.X.
   * - Ver.2.0 will use this to detect outdated summaries during auto-sync.
   *
   * DO NOT REMOVE without consulting Ver.1.5 / 2.0 implementation plan.
   */
  generatedAt: string

  /**
   * Format version. 'v1.0' for this implementation.
   *
   * Why this exists in Ver.1.0:
   * - Ver.1.5 / 2.0 will use this to distinguish summary formats and migrate.
   *
   * DO NOT REMOVE without consulting Ver.1.5 / 2.0 implementation plan.
   */
  version: 'v1.0'

  /**
   * SHA-256 of the canonicalized summary body (everything except metadata).
   *
   * Why this exists in Ver.1.0 (despite not being read by Ver.1.0 code):
   * - Ver.2.0 auto-sync uses this as the cheap diff check ("did anything change since last summary?").
   * - Avoids expensive content compares when nothing changed.
   *
   * DO NOT REMOVE without consulting Ver.2.0 implementation plan.
   */
  hostHash: string

  /**
   * Absolute project path. Identifies which project this summary describes.
   *
   * The summary is per-project: CC's hand of cards differs by project.
   * Same Global layer, different Project layer.
   */
  projectPath: string

  /**
   * Project basename (display label).
   */
  projectName: string
}

/**
 * A skill entry, originating from either Global or Project scope.
 */
export interface Skill {
  /** Slug from frontmatter `name:` or directory basename. */
  name: string
  /** Frontmatter `description:` (single-line), or '(no description)' if missing. */
  description: string
  /** Regular skill (flat layout) or catalyst skill (under a grouping subdir). */
  type: 'regular' | 'catalyst'
  /** Grouping subdirectory name when nested (e.g. 'catalysts'). Undefined for flat skills. */
  groupName?: string
  /** Origin layer. */
  scope: 'global' | 'project'
  /** Absolute path to SKILL.md (so the design AI can request the body if needed). */
  path: string
}

/**
 * A CLAUDE.md or CLAUDE.local.md snapshot.
 */
export interface ClaudeMd {
  path: string
  size: number
  sha256: string
  content: string
}

/**
 * One hook registration entry from settings.json (PreToolUse / Stop / etc.).
 */
export interface HookRegistration {
  type: string
  matcher: string
  command: string
}

/**
 * Bare reference for a rule file (~/.claude/rules/*.md).
 */
export interface RuleEntry {
  name: string
  /** Either the first markdown heading line, or the first non-empty line. */
  firstHeadingOrLine: string
}

/**
 * Discovered subagent (~/.claude/agents/*.md or <pj>/.claude/agents/*.md).
 */
export interface SubagentEntry {
  name: string
  description: string
}

/**
 * Discovered project-local command (<pj>/.claude/commands/*.md).
 *
 * MANX Protocol r7 §3-3 introduces commands/ as a project-only layer.
 */
export interface CommandEntry {
  name: string
  description: string
}

/**
 * Marketplace registration entry (~/.claude/plugins/known_marketplaces.json).
 */
export interface MarketplaceEntry {
  id: string
  source: string
  lastUpdated?: string
}

/**
 * Plugin registration (under a marketplace).
 */
export interface PluginEntry {
  marketplace: string
  name: string
}

/**
 * Hook bundle (file list + settings.json registrations).
 */
export interface HooksLayer {
  files: Array<{ name: string; path: string }>
  registrations: HookRegistration[]
}

/**
 * MCP configuration snapshot (no credential values, just structure).
 */
export interface McpLayer {
  configured: boolean
  servers: Array<{ name: string }>
  cacheStatus?: string
}

/**
 * Subagents bundle.
 */
export interface SubagentsLayer {
  deployed: boolean
  agents: SubagentEntry[]
}

/**
 * Plugins bundle.
 */
export interface PluginsLayer {
  plugins: PluginEntry[]
}

/**
 * Settings.json structure summary (top-level keys only — values are excluded for security).
 *
 * scanSettings MUST NOT include values. Scanning auth.password / API keys / etc. and
 * outputting them would be a credential leak.
 */
export interface SettingsLayer {
  keys: string[]
}

/**
 * Global (~/.claude/) layer of CC's hand.
 */
export interface GlobalLayer {
  claudeMd?: ClaudeMd
  rules: RuleEntry[]
  skills: { regular: Skill[]; catalyst: Skill[] }
  hooks: HooksLayer
  mcp: McpLayer
  subagents: SubagentsLayer
  plugins: PluginsLayer
  marketplaces: MarketplaceEntry[]
}

/**
 * Project (<projectPath>/ + <projectPath>/.claude/) layer of CC's hand.
 */
export interface ProjectLayer {
  claudeMd?: ClaudeMd
  claudeLocal?: ClaudeMd
  settings?: SettingsLayer
  settingsLocal?: SettingsLayer
  rules: RuleEntry[]
  skills: { regular: Skill[]; catalyst: Skill[] }
  agents: SubagentEntry[]
  commands: CommandEntry[]
}

/**
 * Where a Global-layer item is overridden by a Project-layer item.
 */
export interface MergeNote {
  kind: 'rule' | 'skill' | 'settingKey'
  name: string
  overriddenIn: 'project'
}

/**
 * Top-level CCES summary.
 *
 * Why this is a structured type and not just a Markdown string:
 * - Ver.1.0 outputs Markdown via formatAsMarkdown(summary).
 * - Ver.1.5 will add formatAsHandOver(summary) without changing the data model.
 * - Ver.2.0 will add formatAsTelosManifest(summary) and use the data model directly.
 * - Therefore Ver.1.0 → Ver.2.0 direct path is preserved (no Ver.1.5 dependency).
 *
 * DO NOT REMOVE the structural shape without consulting Ver.1.5 / 2.0 plans.
 */
export interface ExtensionsSummary {
  metadata: ExtensionsSummaryMetadata
  /** User-configured opening text (or i18n default). */
  opening: string
  global: GlobalLayer
  project: ProjectLayer
  /** Items where a project-layer entry overrides a global-layer entry of the same name. */
  mergeNotes: MergeNote[]
  /** True when the formatted Markdown exceeds the soft size threshold (informational). */
  oversized: boolean
}

/** IPC return value. */
export type CcesGenerateResult =
  | {
      ok: true
      summary: ExtensionsSummary
      markdown: string
      bytes: number
      oversized: boolean
    }
  | { ok: false; error: string }

/** Soft threshold (bytes) above which the summary is flagged as oversized. */
export const OVERSIZED_THRESHOLD_BYTES = 100 * 1024
