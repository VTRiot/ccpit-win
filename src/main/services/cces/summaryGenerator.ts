/**
 * CCES Ver.1.0 — Summary generator + Markdown formatter.
 *
 * Two responsibilities, separated:
 *   - generateExtensionsSummary: scan Global + Project, compute mergeNotes, build the typed model.
 *   - formatAsMarkdown:          turn the typed model into a Markdown document for clipboard.
 *
 * Why this separation matters (Ver.1.5 / 2.0 step plan):
 *   - Ver.1.5 will add formatAsHandOver(summary) without touching the data model.
 *   - Ver.2.0 will add formatAsTelosManifest(summary) and may consume the typed model directly.
 *   - This means Ver.1.0 → Ver.2.0 can leapfrog Ver.1.5; no Ver.1.5-only conversions are required.
 *
 * DO NOT inline formatting into generation without consulting Ver.1.5 / 2.0 plans.
 */

import { createHash } from 'crypto'
import { basename } from 'path'
import { computeMergeNotes, scanGlobal, scanProject } from './extensionScanner'
import {
  type ExtensionsSummary,
  type GlobalLayer,
  type ProjectLayer,
  CCES_FORMAT_VERSION,
  OVERSIZED_THRESHOLD_BYTES,
} from './types'

interface GenerateOpts {
  claudeDir: string
  projectPath: string
  opening: string
  /** 本 project の cwd に登録された CC固有ID 群（ipc が ccRegistry から引いて渡す・任意）。 */
  ccIds?: string[]
}

export async function generateExtensionsSummary(opts: GenerateOpts): Promise<ExtensionsSummary> {
  const [globalLayer, projectLayer] = await Promise.all([
    scanGlobal(opts.claudeDir),
    scanProject(opts.projectPath),
  ])
  const mergeNotes = computeMergeNotes(globalLayer, projectLayer)
  const projectName = basename(opts.projectPath) || opts.projectPath

  // Hash the summary body (everything except metadata.generatedAt/hostHash) so the same
  // configuration produces a stable identifier across runs.
  const hostHash = computeHostHash({
    opening: opts.opening,
    global: globalLayer,
    project: projectLayer,
    mergeNotes,
  })

  // Build with placeholder oversized=false; real value is set after formatting.
  const summary: ExtensionsSummary = {
    metadata: {
      generatedAt: new Date().toISOString(),
      version: CCES_FORMAT_VERSION,
      hostHash,
      projectPath: opts.projectPath,
      projectName,
      ccIds: opts.ccIds,
    },
    opening: opts.opening,
    global: globalLayer,
    project: projectLayer,
    mergeNotes,
    oversized: false,
  }

  // Compute oversized flag based on Markdown bytes.
  const md = formatAsMarkdown(summary)
  summary.oversized = Buffer.byteLength(md, 'utf8') > OVERSIZED_THRESHOLD_BYTES
  return summary
}

function computeHostHash(body: {
  opening: string
  global: GlobalLayer
  project: ProjectLayer
  mergeNotes: ExtensionsSummary['mergeNotes']
}): string {
  // Deterministic serialization: scanX functions return data sorted by name,
  // so JSON.stringify on the same logical content produces the same string.
  const canonical = JSON.stringify(body)
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

// ---------- Markdown formatter ----------

export function formatAsMarkdown(summary: ExtensionsSummary): string {
  const lines: string[] = []
  lines.push('# Claude Code Extensions Summary')
  lines.push('')
  lines.push(...renderMetadata(summary))
  lines.push('')
  // 039 FB④ (LITM): 先頭ダイジェスト。長文の中間が読み飛ばされても、要点は冒頭で拾える。
  // 正はあくまで各セクション本文で、ここは典拠への索引（typed model からの導出のみ）。
  lines.push(...renderDigest(summary))
  lines.push('')
  if (summary.opening.trim().length > 0) {
    lines.push('## Opening')
    lines.push('')
    lines.push(summary.opening.trim())
    lines.push('')
  }
  lines.push('## Global (~/.claude/)')
  lines.push('')
  lines.push(...renderLayer(summary.global, 'global'))
  lines.push('')
  lines.push('## Project')
  lines.push('')
  lines.push(`> Path: \`${summary.metadata.projectPath}\``)
  lines.push('')
  lines.push(...renderLayer(summary.project, 'project'))
  lines.push('')
  lines.push('## Merge Notes')
  lines.push('')
  lines.push(...renderMergeNotes(summary))
  lines.push('')
  // 039 FB④ (LITM): 末尾リキャップ。文書末でも読むべき最重要点（衝突と優先規則）を再掲する。
  lines.push(...renderCriticalRecap(summary))
  return lines.join('\n')
}

/** opening の最初の非空行（Digest/Recap の 1 行要約用）。無ければ '(none)'。 */
function firstNonEmptyLine(text: string): string {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  return line ?? '(none)'
}

/**
 * 039 FB④: 先頭ダイジェスト（read first）。各レイヤの件数と主要な名前一覧、衝突要旨を
 * typed model から導出して並べる。バイト数（oversized）は 2-pass 再計算で古くなり得るため
 * 意図的に載せない（DECISION (c)）。
 */
function renderDigest(summary: ExtensionsSummary): string[] {
  const g = summary.global
  const p = summary.project
  const lines: string[] = []
  lines.push('## Digest (read first)')
  lines.push('')
  lines.push('> LITM 対策の要約。正は各セクション本文で、ここはその索引。')
  lines.push('')
  lines.push(`- Project: \`${summary.metadata.projectPath}\` (${summary.metadata.projectName})`)
  lines.push(`- CC IDs: ${(summary.metadata.ccIds ?? []).join(', ') || '(none)'}`)
  lines.push(
    `- Global: rules ${g.rules.length}, skills ${g.skills.regular.length} regular / ${g.skills.catalyst.length} catalyst, ` +
      `hooks ${g.hooks.files.length}, mcp ${g.mcp.configured ? `${g.mcp.servers.length} server(s)` : 'not configured'}, ` +
      `subagents ${g.subagents.deployed ? g.subagents.agents.length : 'not deployed'}, plugins ${g.plugins.plugins.length}, ` +
      `marketplaces ${g.marketplaces.length}`
  )
  lines.push(
    `- Project: CLAUDE.md ${p.claudeMd ? 'present' : 'absent'}, CLAUDE.local.md ${p.claudeLocal ? 'present' : 'absent'}, ` +
      `rules ${p.rules.length}, skills ${p.skills.regular.length} regular / ${p.skills.catalyst.length} catalyst, ` +
      `agents ${p.agents.length}, commands ${p.commands.length}`
  )
  lines.push(
    `- Merge Notes: ${summary.mergeNotes.length === 0 ? 'no collisions' : `${summary.mergeNotes.length} collision(s)`}`
  )
  if (g.rules.length > 0) {
    lines.push(`- Global rule names: ${g.rules.map((r) => r.name).join(', ')}`)
  }
  if (g.skills.regular.length > 0) {
    lines.push(`- Global skill names: ${g.skills.regular.map((s) => s.name).join(', ')}`)
  }
  if (p.rules.length > 0) {
    lines.push(`- Project rule names: ${p.rules.map((r) => r.name).join(', ')}`)
  }
  if (p.skills.regular.length > 0) {
    lines.push(`- Project skill names: ${p.skills.regular.map((s) => s.name).join(', ')}`)
  }
  return lines
}

/**
 * 039 FB④: 末尾リキャップ（re-stated for LITM）。文書末でも必ず拾うべき最重要点
 * （典拠の所在・優先規則・衝突・opening 要点）を再掲する。詳細は各セクションが正。
 */
function renderCriticalRecap(summary: ExtensionsSummary): string[] {
  const lines: string[] = []
  lines.push('## Critical Recap (re-stated for LITM)')
  lines.push('')
  lines.push('> 長文末尾でも読むべき要点の再掲。詳細は上記各セクションが正。')
  lines.push('')
  lines.push('- 典拠: 上記の各セクション本文が正。本節はその再掲。')
  lines.push(
    '- Precedence: per MANX Protocol r7 §3-3, the Project layer overrides Global on name collision.'
  )
  lines.push(`- Project: \`${summary.metadata.projectPath}\` (${summary.metadata.projectName})`)
  lines.push(`- CC IDs: ${(summary.metadata.ccIds ?? []).join(', ') || '(none)'}`)
  if (summary.mergeNotes.length === 0) {
    lines.push('- Merge Notes: no name collisions (Project adds to Global without override).')
  } else {
    lines.push(
      `- Merge Notes (${summary.mergeNotes.length}): ` +
        summary.mergeNotes.map((n) => `${n.kind} \`${n.name}\``).join(', ')
    )
  }
  if (summary.opening.trim().length > 0) {
    lines.push(`- Opening (first line): ${firstNonEmptyLine(summary.opening)}`)
  }
  return lines
}

function renderMetadata(summary: ExtensionsSummary): string[] {
  return [
    '## Metadata',
    '',
    `- generatedAt: ${summary.metadata.generatedAt}`,
    `- version: ${summary.metadata.version}`,
    `- hostHash: ${summary.metadata.hostHash}`,
    `- projectPath: \`${summary.metadata.projectPath}\``,
    `- projectName: ${summary.metadata.projectName}`,
    `- ccIds: ${(summary.metadata.ccIds ?? []).join(', ') || '(none)'}`,
  ]
}

function renderLayer(
  layer: GlobalLayer | ProjectLayer,
  scope: 'global' | 'project',
): string[] {
  const lines: string[] = []

  // CLAUDE.md
  lines.push('### CLAUDE.md')
  lines.push('')
  if (layer.claudeMd) {
    lines.push(`- path: \`${layer.claudeMd.path}\``)
    lines.push(`- size: ${layer.claudeMd.size} bytes`)
    lines.push(`- sha256: ${layer.claudeMd.sha256}`)
    lines.push('')
    lines.push('````markdown')
    lines.push(layer.claudeMd.content)
    lines.push('````')
  } else {
    lines.push('_(not present)_')
  }
  lines.push('')

  // CLAUDE.local.md (project only)
  if (scope === 'project') {
    const projectLayer = layer as ProjectLayer
    lines.push('### CLAUDE.local.md')
    lines.push('')
    if (projectLayer.claudeLocal) {
      lines.push(`- path: \`${projectLayer.claudeLocal.path}\``)
      lines.push(`- size: ${projectLayer.claudeLocal.size} bytes`)
      lines.push('')
      lines.push('````markdown')
      lines.push(projectLayer.claudeLocal.content)
      lines.push('````')
    } else {
      lines.push('_(not present)_')
    }
    lines.push('')

    // settings.json (project only) — keys only
    lines.push('### .claude/settings.json (keys only — values are deliberately excluded)')
    lines.push('')
    if (projectLayer.settings) {
      lines.push(...projectLayer.settings.keys.map((k) => `- ${k}`))
    } else {
      lines.push('_(not present)_')
    }
    lines.push('')

    // settings.local.json (project only) — keys only
    lines.push('### .claude/settings.local.json (keys only — values are deliberately excluded)')
    lines.push('')
    if (projectLayer.settingsLocal) {
      lines.push(...projectLayer.settingsLocal.keys.map((k) => `- ${k}`))
    } else {
      lines.push('_(not present)_')
    }
    lines.push('')
  }

  // Rules
  lines.push('### Rules')
  lines.push('')
  if (layer.rules.length === 0) {
    lines.push('_(no rules)_')
  } else {
    for (const r of layer.rules) {
      lines.push(`- **${r.name}** — ${r.firstHeadingOrLine}`)
    }
  }
  lines.push('')

  // Skills (Regular)
  lines.push('### Skills (Regular)')
  lines.push('')
  if (layer.skills.regular.length === 0) {
    lines.push('_(no regular skills)_')
  } else {
    for (const s of layer.skills.regular) {
      lines.push(`- **${s.name}** — ${s.description}`)
      lines.push(`  - path: \`${s.path}\``)
      if (s.groupName) {
        lines.push(`  - groupName: ${s.groupName}`)
      }
    }
  }
  lines.push('')

  // Skills (Catalyst)
  lines.push('### Skills (Catalyst)')
  lines.push('')
  if (layer.skills.catalyst.length === 0) {
    lines.push('_(no catalyst skills)_')
  } else {
    lines.push('> ※ 触媒型: answers are not given; questions are thrown back at the user.')
    lines.push('')
    for (const s of layer.skills.catalyst) {
      lines.push(`- **${s.name}** — ${s.description}`)
      lines.push(`  - path: \`${s.path}\``)
      if (s.groupName) {
        lines.push(`  - groupName: ${s.groupName}`)
      }
    }
  }
  lines.push('')

  // Hooks (global only — project hooks are not standard in MANX r7)
  if (scope === 'global') {
    const globalLayer = layer as GlobalLayer
    lines.push('### Hooks')
    lines.push('')
    if (globalLayer.hooks.files.length === 0) {
      lines.push('_(no hook scripts)_')
    } else {
      lines.push('Files:')
      for (const f of globalLayer.hooks.files) {
        lines.push(`- ${f.name} (${f.path})`)
      }
    }
    if (globalLayer.hooks.registrations.length > 0) {
      lines.push('')
      lines.push('Registrations (from settings.json):')
      for (const r of globalLayer.hooks.registrations) {
        const matcher = r.matcher.length > 0 ? r.matcher : '(any)'
        lines.push(`- ${r.type} | matcher: \`${matcher}\` | command: \`${r.command}\``)
      }
    }
    lines.push('')

    // MCP
    lines.push('### MCP')
    lines.push('')
    if (!globalLayer.mcp.configured) {
      lines.push('_MCP: not configured_')
    } else {
      lines.push('Servers:')
      for (const s of globalLayer.mcp.servers) {
        lines.push(`- ${s.name}`)
      }
    }
    if (globalLayer.mcp.cacheStatus) {
      lines.push(`- cacheStatus: ${globalLayer.mcp.cacheStatus}`)
    }
    lines.push('')

    // Subagents
    lines.push('### Subagents')
    lines.push('')
    if (!globalLayer.subagents.deployed) {
      lines.push('_Subagents: not deployed_')
    } else {
      for (const a of globalLayer.subagents.agents) {
        lines.push(`- **${a.name}** — ${a.description}`)
      }
    }
    lines.push('')

    // Plugins
    lines.push('### Plugins')
    lines.push('')
    if (globalLayer.plugins.plugins.length === 0) {
      lines.push('_(no plugins)_')
    } else {
      for (const p of globalLayer.plugins.plugins) {
        lines.push(`- **${p.name}** (marketplace: ${p.marketplace})`)
      }
    }
    lines.push('')

    // Marketplaces
    lines.push('### Marketplaces')
    lines.push('')
    if (globalLayer.marketplaces.length === 0) {
      lines.push('_(no marketplaces)_')
    } else {
      for (const m of globalLayer.marketplaces) {
        const lu = m.lastUpdated ? ` (lastUpdated: ${m.lastUpdated})` : ''
        lines.push(`- **${m.id}** — ${m.source}${lu}`)
      }
    }
    lines.push('')
  } else {
    // Project layer: agents + commands
    const projectLayer = layer as ProjectLayer
    lines.push('### .claude/agents/')
    lines.push('')
    if (projectLayer.agents.length === 0) {
      lines.push('_(no project agents)_')
    } else {
      for (const a of projectLayer.agents) {
        lines.push(`- **${a.name}** — ${a.description}`)
      }
    }
    lines.push('')

    lines.push('### .claude/commands/')
    lines.push('')
    if (projectLayer.commands.length === 0) {
      lines.push('_(no project commands)_')
    } else {
      for (const c of projectLayer.commands) {
        lines.push(`- **${c.name}** — ${c.description}`)
      }
    }
    lines.push('')
  }

  return lines
}

function renderMergeNotes(summary: ExtensionsSummary): string[] {
  if (summary.mergeNotes.length === 0) {
    return [
      '_(no name collisions detected — Project layer adds to Global without override)_',
      '',
      'Note: per MANX Protocol r7 §3-3, when a project has a same-named rule / skill / setting,',
      'the project-layer entry overrides the global one. None were detected for this project.',
    ]
  }
  const lines: string[] = []
  lines.push('Per MANX Protocol r7 §3-3, when a project has a same-named entry, it overrides Global:')
  lines.push('')
  for (const n of summary.mergeNotes) {
    lines.push(`- **${n.kind}**: \`${n.name}\` — overridden by Project`)
  }
  return lines
}
