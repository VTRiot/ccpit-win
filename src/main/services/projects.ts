import { readFile, writeFile, mkdir, copyFile } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'
import { app } from 'electron'
import {
  resolveDirCreatedAt,
  runCreatedAtToCtimeMigration,
  runProtocolHistoryV2Migration,
  type MigrationNotice,
  type ProjectsMigrationPaths
} from './projectsMigration'

const CCPIT_DIR = join(app.getPath('home'), '.ccpit')
const PROJECTS_FILE = join(CCPIT_DIR, 'projects.json')
const MIGRATIONS_FILE = join(CCPIT_DIR, 'migrations.json')

const MIGRATION_PATHS: ProjectsMigrationPaths = {
  parcFermeDir: CCPIT_DIR,
  projectsFile: PROJECTS_FILE,
  migrationsFile: MIGRATIONS_FILE
}

let pendingMigrationNotice: MigrationNotice | null = null

export function consumePendingMigrationNotice(): MigrationNotice | null {
  const notice = pendingMigrationNotice
  pendingMigrationNotice = null
  return notice
}

// 034-B: protocol-history-v2 マイグレーション通知（別 slot）。
// 既存 pendingMigrationNotice (createdAt 用) と独立して管理することで、
// 起動時に複数マイグレーションが走った場合に両方の Toast を表示できる。
let pendingProtocolHistoryMigrationNotice: MigrationNotice | null = null

export function consumePendingProtocolHistoryMigrationNotice(): MigrationNotice | null {
  const notice = pendingProtocolHistoryMigrationNotice
  pendingProtocolHistoryMigrationNotice = null
  return notice
}

export type LocationType = 'local' | 'remote-readonly' | 'remote-full'

export interface ProjectEntry {
  name: string
  path: string
  createdAt: string
  parent_id?: string | null
  groupKey?: string | null
  documents?: string[]
  favorite?: boolean
  location_type?: LocationType
  // 034-B: confirmed フィールドは廃止。
  // 「明示意思」の正典は protocol.json の history（append-only event log）に統合。
  // Full Re-scan の skip 判定は getLatestManualEntry(path) で行う。
  // 既存データの confirmed フィールドはマイグレーションで削除される（v1→v2 同時実施）。
}

async function ensureDir(dir: string): Promise<void> {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }
}

/** projects.json を読み込む */
export async function loadProjects(): Promise<ProjectEntry[]> {
  await ensureDir(CCPIT_DIR)

  // 033-B: createdAt → ctime マイグレーション
  const createdAtNotice = await runCreatedAtToCtimeMigration(MIGRATION_PATHS)
  if (createdAtNotice) {
    pendingMigrationNotice = createdAtNotice
  }

  // 034-B: protocol-history-v2 マイグレーション
  // - 各 PJ の .ccpit/protocol.json を v1 → v2 (append-only history) に変換
  // - projects.json から confirmed フィールドを削除
  // - バックアップ作成、冪等
  const protocolHistoryNotice = await runProtocolHistoryV2Migration(MIGRATION_PATHS)
  if (protocolHistoryNotice) {
    pendingProtocolHistoryMigrationNotice = protocolHistoryNotice
  }

  if (!existsSync(PROJECTS_FILE)) return []
  const content = await readFile(PROJECTS_FILE, 'utf-8')
  return JSON.parse(content)
}

/** projects.json に保存 */
async function saveProjects(projects: ProjectEntry[]): Promise<void> {
  await ensureDir(CCPIT_DIR)
  await writeFile(PROJECTS_FILE, JSON.stringify(projects, null, 2), 'utf-8')
}

const P4_TEMPLATE = `# CLAUDE.md — {{PROJECT_NAME}}

> CCPIT managed. グローバル構成: ~/.claude/

## プロジェクト定義
\`_Prompt\\_Prj\\\` 配下の最新 rev を参照すること。

## 環境
| 項目 | 値 |
|------|-----|
| 言語 | （要記入） |
| フレームワーク | （要記入） |

## 最上位命題
（要記入）
`

/** 新規プロジェクト作成 */
export async function createProject(
  projectPath: string,
  projectName: string
): Promise<{ success: boolean; created: string[]; errors: string[] }> {
  const result = { success: true, created: [] as string[], errors: [] as string[] }

  const filesToCreate: { path: string; content: string }[] = [
    {
      path: join(projectPath, 'CLAUDE.md'),
      content: P4_TEMPLATE.replace('{{PROJECT_NAME}}', projectName)
    },
    {
      path: join(projectPath, 'CLAUDE.local.md'),
      content: `# CLAUDE.local.md — ${projectName}\n\n> ローカル固有設定。Git にコミットしない。\n`
    }
  ]

  const dirsToCreate = [
    join(projectPath, '.claude', 'rules'),
    join(projectPath, '_Prompt', '_Prj'),
    join(projectPath, '_Prompt', '_fromdesignai'),
    join(projectPath, '_Prompt', '_frombuilderai')
  ]

  // ディレクトリ作成
  for (const dir of dirsToCreate) {
    try {
      await mkdir(dir, { recursive: true })
      result.created.push(dir)
    } catch (err) {
      result.errors.push(`${dir}: ${err instanceof Error ? err.message : String(err)}`)
      result.success = false
    }
  }

  // ファイル作成
  for (const file of filesToCreate) {
    try {
      if (existsSync(file.path)) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
        await copyFile(file.path, `${file.path}.bak.${timestamp}`)
      }
      await writeFile(file.path, file.content, 'utf-8')
      result.created.push(file.path)
    } catch (err) {
      result.errors.push(`${file.path}: ${err instanceof Error ? err.message : String(err)}`)
      result.success = false
    }
  }

  // projects.json に登録
  if (result.success) {
    const projects = await loadProjects()
    const existing = projects.findIndex((p) => p.path === projectPath)
    const entry: ProjectEntry = {
      name: projectName,
      path: projectPath,
      createdAt: await resolveDirCreatedAt(projectPath),
      location_type: 'local',
      favorite: false
    }
    if (existing >= 0) {
      projects[existing] = entry
    } else {
      projects.push(entry)
    }
    await saveProjects(projects)
  }

  return result
}

/** プロジェクト一覧を取得（プロトコル判定は ProtocolBadge / autoMarker 経由で行う） */
export async function listProjects(): Promise<ProjectEntry[]> {
  return loadProjects()
}

/** プロジェクトを削除（レジストリからのみ。ファイルは消さない） */
export async function removeProject(projectPath: string): Promise<void> {
  const projects = await loadProjects()
  const filtered = projects.filter((p) => p.path !== projectPath)
  await saveProjects(filtered)
}

/**
 * 複数の PJ パスを一括インポート（projects.json に追記のみ）。
 * ファイルシステムは変更しない。CLAUDE.md は既存前提。
 * 既に登録済みのパスはスキップ。
 */
export async function importProjects(paths: string[]): Promise<ProjectEntry[]> {
  const projects = await loadProjects()
  const existingSet = new Set(projects.map((p) => p.path.toLowerCase()))

  const added: ProjectEntry[] = []
  for (const projectPath of paths) {
    if (existingSet.has(projectPath.toLowerCase())) continue
    const segments = projectPath.split(/[\\/]/)
    const name = segments[segments.length - 1] || projectPath
    const entry: ProjectEntry = {
      name,
      path: projectPath,
      createdAt: await resolveDirCreatedAt(projectPath),
      location_type: 'local',
      favorite: false
    }
    projects.push(entry)
    added.push(entry)
  }

  if (added.length > 0) {
    await saveProjects(projects)
  }
  return added
}

/**
 * 複数の PJ パスを一括でリストから外す。
 * ファイルシステム操作は一切行わない（PJ 本体は無傷）。
 */
export async function removeProjectsFromList(paths: string[]): Promise<{ removed: string[] }> {
  const projects = await loadProjects()
  const targetSet = new Set(paths.map((p) => p.toLowerCase()))
  const filtered = projects.filter((p) => !targetSet.has(p.path.toLowerCase()))
  const removedCount = projects.length - filtered.length
  if (removedCount > 0) {
    await saveProjects(filtered)
  }
  return { removed: paths }
}

/** projects.json に登録済みのパス一覧（ステータス再判定なし、軽量） */
export async function listManagedPaths(): Promise<string[]> {
  const projects = await loadProjects()
  return projects.map((p) => p.path)
}

/** Favorite フラグを toggle */
export async function setFavorite(projectPath: string, favorite: boolean): Promise<void> {
  const projects = await loadProjects()
  const idx = projects.findIndex((p) => p.path === projectPath)
  if (idx < 0) return
  projects[idx] = { ...projects[idx], favorite }
  await saveProjects(projects)
}

// 034-B: setConfirmed 関数は廃止（confirmed フィールドが廃止されたため）。
// 「明示意思」の永続化は appendProtocolEntry(path, 'manual', marker) で行う（protocol.json の history）。
