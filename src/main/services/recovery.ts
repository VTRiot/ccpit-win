import { readdir, readFile, writeFile, copyFile, mkdir, rename } from 'fs/promises'
import { join, relative } from 'path'
import { existsSync } from 'fs'
import { createHash } from 'crypto'
import { app } from 'electron'

const CCPIT_DIR = join(app.getPath('home'), '.ccpit')
const SNAPSHOTS_DIR = join(CCPIT_DIR, 'snapshots')
const CLAUDE_DIR = join(app.getPath('home'), '.claude')

/** Snapshot 対象 allowlist（構成ファイルのみ） */
const SNAPSHOT_TARGETS = [
  'settings.json',
  'settings.local.json',
  'CLAUDE.md',
  'rules',
  'skills',
  'hooks',
]

export type SnapshotLabel = 'manual' | 'pre-restore' | 'post-restore'

export interface FileManifestEntry {
  relativePath: string
  hash: string
  sizeBytes: number
}

export interface SnapshotManifest {
  timestamp: string
  knownGood: boolean
  label: SnapshotLabel
  files: FileManifestEntry[]
}

export interface SnapshotInfo {
  id: string
  timestamp: string
  knownGood: boolean
  label: SnapshotLabel
  fileCount: number
}

export interface FileDiff {
  relativePath: string
  risk: 'high' | 'medium' | 'low'
  status: 'added' | 'removed' | 'modified' | 'unchanged'
  currentContent?: string
  snapshotContent?: string
}

/** 再帰的にファイルパスを取得 */
async function walkDir(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return []
  const entries = await readdir(dir, { withFileTypes: true })
  const paths: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      paths.push(...(await walkDir(full)))
    } else if (!entry.name.endsWith('.bak') && !entry.name.startsWith('.bak.')) {
      paths.push(full)
    }
  }
  return paths
}

/** ~/.claude/ 配下で SNAPSHOT_TARGETS にマッチするファイルのみ列挙 */
async function walkClaudeTargets(): Promise<string[]> {
  const result: string[] = []
  for (const target of SNAPSHOT_TARGETS) {
    const full = join(CLAUDE_DIR, target)
    if (!existsSync(full)) continue
    const stat = await readdir(CLAUDE_DIR, { withFileTypes: true }).then((es) =>
      es.find((e) => e.name === target)
    )
    if (!stat) continue
    if (stat.isDirectory()) {
      result.push(...(await walkDir(full)))
    } else {
      result.push(full)
    }
  }
  return result
}

async function fileHash(filePath: string): Promise<string> {
  const content = await readFile(filePath)
  return createHash('sha256').update(content).digest('hex')
}

function assessRisk(relativePath: string): 'high' | 'medium' | 'low' {
  const p = relativePath.replace(/\\/g, '/')
  if (p === 'settings.json' || p === 'settings.local.json') return 'high'
  // hooks/ 配下の変更は settings.json と同等リスク（MANX hooks Phase 1）
  if (p.startsWith('hooks/')) return 'high'
  if (p === 'CLAUDE.md') return 'medium'
  return 'low'
}

/** snapshot 取得 */
export async function takeSnapshot(label: SnapshotLabel = 'manual'): Promise<SnapshotInfo> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const snapshotDir = join(SNAPSHOTS_DIR, timestamp)
  await mkdir(snapshotDir, { recursive: true })

  const files = await walkClaudeTargets()
  const manifest: SnapshotManifest = {
    timestamp,
    knownGood: false,
    label,
    files: [],
  }

  for (const filePath of files) {
    const rel = relative(CLAUDE_DIR, filePath)
    const destPath = join(snapshotDir, rel)
    const destDir = join(destPath, '..')
    await mkdir(destDir, { recursive: true })
    await copyFile(filePath, destPath)

    const hash = await fileHash(filePath)
    const content = await readFile(filePath)
    manifest.files.push({
      relativePath: rel,
      hash,
      sizeBytes: content.length,
    })
  }

  await writeFile(
    join(snapshotDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf-8'
  )

  return {
    id: timestamp,
    timestamp,
    knownGood: false,
    label,
    fileCount: manifest.files.length,
  }
}

/** snapshot 一覧 */
export async function listSnapshots(): Promise<SnapshotInfo[]> {
  await mkdir(SNAPSHOTS_DIR, { recursive: true })
  if (!existsSync(SNAPSHOTS_DIR)) return []

  const entries = await readdir(SNAPSHOTS_DIR, { withFileTypes: true })
  const snapshots: SnapshotInfo[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const manifestPath = join(SNAPSHOTS_DIR, entry.name, 'manifest.json')
    if (!existsSync(manifestPath)) continue

    const content = await readFile(manifestPath, 'utf-8')
    const manifest: SnapshotManifest = JSON.parse(content)
    snapshots.push({
      id: entry.name,
      timestamp: manifest.timestamp,
      knownGood: manifest.knownGood,
      label: manifest.label ?? 'manual',
      fileCount: manifest.files.length,
    })
  }

  return snapshots.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
}

/** Known Good マーク */
export async function markKnownGood(snapshotId: string): Promise<void> {
  // 既存の Known Good を解除
  const all = await listSnapshots()
  for (const snap of all) {
    const manifestPath = join(SNAPSHOTS_DIR, snap.id, 'manifest.json')
    const content = await readFile(manifestPath, 'utf-8')
    const manifest: SnapshotManifest = JSON.parse(content)
    if (manifest.knownGood && snap.id !== snapshotId) {
      manifest.knownGood = false
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')
    }
  }

  // 指定を Known Good に
  const manifestPath = join(SNAPSHOTS_DIR, snapshotId, 'manifest.json')
  const content = await readFile(manifestPath, 'utf-8')
  const manifest: SnapshotManifest = JSON.parse(content)
  manifest.knownGood = true
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')
}

/** snapshot と現在の差分を取得 */
export async function diffSnapshot(snapshotId: string): Promise<FileDiff[]> {
  const snapshotDir = join(SNAPSHOTS_DIR, snapshotId)
  const diffs: FileDiff[] = []

  const snapshotFiles = await walkDir(snapshotDir)
  const currentFiles = await walkClaudeTargets()

  const snapshotRels = new Set<string>()
  for (const f of snapshotFiles) {
    const rel = relative(snapshotDir, f)
    if (rel === 'manifest.json') continue
    snapshotRels.add(rel)
  }

  const currentRels = new Set<string>()
  for (const f of currentFiles) {
    currentRels.add(relative(CLAUDE_DIR, f))
  }

  // modified + unchanged
  for (const rel of snapshotRels) {
    const snapshotPath = join(snapshotDir, rel)
    const currentPath = join(CLAUDE_DIR, rel)
    const snapshotContent = await readFile(snapshotPath, 'utf-8').catch(() => '')

    if (!currentRels.has(rel)) {
      diffs.push({ relativePath: rel, risk: assessRisk(rel), status: 'removed', snapshotContent })
      continue
    }

    const currentContent = await readFile(currentPath, 'utf-8').catch(() => '')
    const snapshotHash = createHash('sha256').update(snapshotContent).digest('hex')
    const currentHash = createHash('sha256').update(currentContent).digest('hex')

    if (snapshotHash !== currentHash) {
      diffs.push({ relativePath: rel, risk: assessRisk(rel), status: 'modified', currentContent, snapshotContent })
    }
  }

  // added (in current but not in snapshot)
  for (const rel of currentRels) {
    if (!snapshotRels.has(rel)) {
      const currentContent = await readFile(join(CLAUDE_DIR, rel), 'utf-8').catch(() => '')
      diffs.push({ relativePath: rel, risk: assessRisk(rel), status: 'added', currentContent })
    }
  }

  // Sort: high risk first
  const riskOrder = { high: 0, medium: 1, low: 2 }
  diffs.sort((a, b) => riskOrder[a.risk] - riskOrder[b.risk])

  return diffs
}

/** Soft Restore */
export async function softRestore(snapshotId: string): Promise<{
  quarantinePath: string
  restoredFiles: string[]
  errors: string[]
}> {
  const snapshotDir = join(SNAPSHOTS_DIR, snapshotId)
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const quarantineDir = join(CCPIT_DIR, 'quarantine', timestamp)

  const result = { quarantinePath: quarantineDir, restoredFiles: [] as string[], errors: [] as string[] }

  // Step 1: 復元前 snapshot を自動取得
  await takeSnapshot('pre-restore')

  // Step 2: 現在のファイルを quarantine に退避（allowlist 対象のみ）
  const currentFiles = await walkClaudeTargets()
  for (const filePath of currentFiles) {
    const rel = relative(CLAUDE_DIR, filePath)
    const quarantinePath = join(quarantineDir, rel)
    const quarantineParent = join(quarantinePath, '..')
    try {
      await mkdir(quarantineParent, { recursive: true })
      await rename(filePath, quarantinePath)
    } catch (err) {
      result.errors.push(`quarantine ${rel}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Step 3: snapshot から復元
  const snapshotFiles = await walkDir(snapshotDir)
  for (const filePath of snapshotFiles) {
    const rel = relative(snapshotDir, filePath)
    if (rel === 'manifest.json') continue
    const destPath = join(CLAUDE_DIR, rel)
    const destParent = join(destPath, '..')
    try {
      await mkdir(destParent, { recursive: true })
      await copyFile(filePath, destPath)
      result.restoredFiles.push(rel)
    } catch (err) {
      result.errors.push(`restore ${rel}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Step 4: 復元後 snapshot を自動取得
  await takeSnapshot('post-restore')

  return result
}
