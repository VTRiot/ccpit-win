import { readdir } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'

export interface DiscoveryCandidate {
  path: string
  name: string
  hasClaudeMd: boolean
  hasCcpitDir: boolean
  alreadyManaged: boolean
}

const DEFAULT_MAX_DEPTH = 4
const EXCLUDE_DIR_NAMES = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  '.cache',
  '.next',
  '.turbo',
])

/**
 * 指定 root 配下を再帰走査し、CLAUDE.md を持つディレクトリを発見する。
 * 隠しディレクトリ（先頭ドット）と EXCLUDE_DIR_NAMES はスキップ。
 */
async function walkClaudeMd(
  root: string,
  maxDepth: number = DEFAULT_MAX_DEPTH
): Promise<string[]> {
  const found: string[] = []

  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    const hasClaudeMd = entries.some((e) => e.isFile() && e.name === 'CLAUDE.md')
    if (hasClaudeMd) found.push(dir)

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.')) continue
      if (EXCLUDE_DIR_NAMES.has(entry.name)) continue
      await visit(join(dir, entry.name), depth + 1)
    }
  }

  await visit(root, 0)
  return found
}

/**
 * Discover CC project candidates under the given root.
 * Returns candidates marked with whether they're already managed.
 */
export async function discoverClaudeProjects(
  rootPath: string,
  managedPaths: string[]
): Promise<DiscoveryCandidate[]> {
  if (!existsSync(rootPath)) return []
  const managedSet = new Set(managedPaths.map((p) => p.toLowerCase()))
  const dirs = await walkClaudeMd(rootPath)
  return dirs.map((dir) => {
    const segments = dir.split(/[\\/]/)
    const name = segments[segments.length - 1] || dir
    return {
      path: dir,
      name,
      hasClaudeMd: true,
      hasCcpitDir: existsSync(join(dir, '.ccpit')),
      alreadyManaged: managedSet.has(dir.toLowerCase()),
    }
  })
}
