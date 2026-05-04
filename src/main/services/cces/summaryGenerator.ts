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
  OVERSIZED_THRESHOLD_BYTES,
} from './types'

interface GenerateOpts {
  claudeDir: string
  projectPath: string
  opening: string
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
      version: 'v1.0',
      hostHash,
      projectPath: opts.projectPath,
      projectName,
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
  return lines.join('\n')
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
