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
import type { SpecialProjectEntry } from './appConfig'
import { cwdMatches } from './sessionRegistry'

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
  /** pxpipe（トークン削減プロキシ）を経由して CC を起動するか（per-project・launch-time 反映） */
  pxpipeEnabled?: boolean
  location_type?: LocationType
  /** プロジェクト格納フォルダ(自動探索 root)外を手動フルパス登録した印。一覧で視覚区別する。 */
  external?: boolean
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

// PIKES r1.3 §9-5 + CCPIT v1.3: pikes_version + os + {os}_version 必須化、manx_role 据置 (pikes_role 移行は v1.4)
const P4_TEMPLATE = `---
pikes_version: r1.3
os: manx
manx_version: r10
manx_role: managed
---

# CLAUDE.md — {{PROJECT_NAME}}

> CCPIT managed. グローバル構成: ~/.claude/

## プロジェクト定義
\`_Prompt\\03_prj\\\` 配下の最新 rev を参照すること。

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
    join(projectPath, '_Prompt', '03_prj'),
    join(projectPath, '_Prompt', '01_designai'),
    join(projectPath, '_Prompt', '02_buildai')
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
export async function importProjects(
  paths: string[],
  opts?: { external?: boolean }
): Promise<ProjectEntry[]> {
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
      favorite: false,
      ...(opts?.external ? { external: true } : {})
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

/** pxpipe（トークン削減プロキシ経由）の per-project ON/OFF を設定 */
export async function setPxpipeEnabled(projectPath: string, enabled: boolean): Promise<void> {
  const projects = await loadProjects()
  const idx = projects.findIndex((p) => p.path === projectPath)
  if (idx < 0) return
  projects[idx] = { ...projects[idx], pxpipeEnabled: enabled }
  await saveProjects(projects)
}

/**
 * pxpipe フラグを読む（CC 起動時の軽量参照）。未設定は false。
 * パス比較は `cwdMatches`（大小文字・末尾区切り・スラッシュ方向を正準化）で行う。
 * 13_pxp Phase 1（Codex 総合クローズ判定 round3 指摘）: 素の `===` だとスペル差
 * （`C:/Projects/app` vs `C:\Projects\app\` 等）で同一ディレクトリを取りこぼす。
 */
export async function getPxpipeEnabled(projectPath: string): Promise<boolean> {
  const projects = await loadProjects()
  return projects.find((p) => cwdMatches(p.path, projectPath))?.pxpipeEnabled ?? false
}

/**
 * 13_pxp Phase 1（Codex 総合クローズ判定 round2 指摘・severity high）: あるパスが pxpipe
 * 経由かどうかは、通常 projects 一覧（`getPxpipeEnabled` 相当）だけでは判定できない。
 * 038 Feature B の特別枠（`appConfig.specialEntries`）は projects.json 未登録パスのため
 * `force` モードで起動され、通常一覧には現れない（ccLaunch.ts の PxpipeMode ドキュメント参照）。
 * 呼び出し元（`cc:restartAll` の中継未経由警告判定）は両方を見る必要があるため、
 * I/O（loadProjects の fs 読取・getConfig）から判定ロジックを分離した純関数として提供する。
 *
 * 特別枠側のパス比較も `cwdMatches` で正準化する（round3 指摘）: specialEntries は
 * ユーザーが app-config.json を直接編集して登録するため、`launchCc` に渡す実際の cwd と
 * スペル（大小文字・末尾区切り・スラッシュ方向）が完全一致しない現実的な可能性がある。
 */
export function resolveIsPxpipeEnabled(
  cwd: string,
  normalProjectEnabled: boolean,
  specialEntries: SpecialProjectEntry[]
): boolean {
  if (normalProjectEnabled) return true
  return specialEntries.some((e) => cwdMatches(e.path, cwd) && e.pxpipeEnabled === true)
}

// 034-B: setConfirmed 関数は廃止（confirmed フィールドが廃止されたため）。
// 「明示意思」の永続化は appendProtocolEntry(path, 'manual', marker) で行う（protocol.json の history）。
