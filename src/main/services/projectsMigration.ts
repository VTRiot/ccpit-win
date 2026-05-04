import { stat, readFile, writeFile, copyFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
// Note: 直接ファイル import で electron `app` 依存（profilesLoader 経由）を回避（vitest 容易性）
import { parseAppliedAtToIso } from './protocol/protocolWriter'
import type {
  ProtocolMarker,
  ProtocolHistoryFile,
  ProtocolHistoryEntry,
  ProtocolEntrySource,
} from './protocol/types'

export const CREATED_AT_TO_CTIME_MIGRATION_KEY = 'createdAt-to-ctime'
export const CREATED_AT_MIGRATION_BACKUP_SUFFIX = '.bak.before-createdAt-ctime-migration'

// 034-B: protocol.json v1 → v2 マイグレーション。
// 旧フラット ProtocolMarker を ProtocolHistoryFile (append-only history v2) に変換し、
// 同時に projects.json から confirmed フィールドを削除する。
export const PROTOCOL_HISTORY_V2_MIGRATION_KEY = 'protocol-history-v2'
export const PROTOCOL_HISTORY_BACKUP_SUFFIX = '.bak.before-protocol-history-v2'

export interface ProjectsMigrationPaths {
  parcFermeDir: string
  projectsFile: string
  migrationsFile: string
}

export interface MigrationsRecord {
  [key: string]: string
}

export interface MigrationNotice {
  migrated: number
  total: number
}

export interface ProjectEntryShape {
  name: string
  path: string
  createdAt: string
  [key: string]: unknown
}

async function ensureDir(dir: string): Promise<void> {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }
}

/**
 * PJ ディレクトリの作成日を ISO 8601 で返す。
 * birthtime → mtime → 現在時刻 の順でフォールバック。
 * Linux で birthtime が信頼できない（1970-01-01 等）ケースに備える。
 */
export async function resolveDirCreatedAt(projectPath: string): Promise<string> {
  try {
    const s = await stat(projectPath)
    if (s.birthtime instanceof Date && s.birthtime.getTime() > 0) {
      return s.birthtime.toISOString()
    }
    if (s.mtime instanceof Date && s.mtime.getTime() > 0) {
      return s.mtime.toISOString()
    }
  } catch {
    // ディレクトリ未存在・権限エラー等
  }
  return new Date().toISOString()
}

export async function loadMigrationsRecord(migrationsFile: string): Promise<MigrationsRecord> {
  if (!existsSync(migrationsFile)) return {}
  try {
    const content = await readFile(migrationsFile, 'utf-8')
    const parsed = JSON.parse(content)
    return parsed && typeof parsed === 'object' ? (parsed as MigrationsRecord) : {}
  } catch {
    return {}
  }
}

export async function saveMigrationsRecord(
  paths: ProjectsMigrationPaths,
  record: MigrationsRecord
): Promise<void> {
  await ensureDir(paths.parcFermeDir)
  await writeFile(paths.migrationsFile, JSON.stringify(record, null, 2), 'utf-8')
}

export async function isMigrationApplied(migrationsFile: string, key: string): Promise<boolean> {
  const record = await loadMigrationsRecord(migrationsFile)
  return Boolean(record[key])
}

/**
 * createdAt フィールドの意味を「CCPIT 登録時刻」から「PJ ディレクトリ ctime」に
 * 書き換えるマイグレーション。冪等性: 既に適用済みなら no-op。
 *
 * 戻り値: マイグレーション通知（実行された場合）または null（skip）。
 */
export async function runCreatedAtToCtimeMigration(
  paths: ProjectsMigrationPaths
): Promise<MigrationNotice | null> {
  if (await isMigrationApplied(paths.migrationsFile, CREATED_AT_TO_CTIME_MIGRATION_KEY)) {
    return null
  }

  const record = await loadMigrationsRecord(paths.migrationsFile)

  if (!existsSync(paths.projectsFile)) {
    record[CREATED_AT_TO_CTIME_MIGRATION_KEY] = new Date().toISOString()
    await saveMigrationsRecord(paths, record)
    return null
  }

  const backupPath = `${paths.projectsFile}${CREATED_AT_MIGRATION_BACKUP_SUFFIX}`
  if (!existsSync(backupPath)) {
    await copyFile(paths.projectsFile, backupPath)
  }

  let projects: ProjectEntryShape[]
  try {
    const content = await readFile(paths.projectsFile, 'utf-8')
    const parsed = JSON.parse(content)
    if (!Array.isArray(parsed)) {
      record[CREATED_AT_TO_CTIME_MIGRATION_KEY] = new Date().toISOString()
      await saveMigrationsRecord(paths, record)
      return null
    }
    projects = parsed as ProjectEntryShape[]
  } catch {
    record[CREATED_AT_TO_CTIME_MIGRATION_KEY] = new Date().toISOString()
    await saveMigrationsRecord(paths, record)
    return null
  }

  let migratedCount = 0
  for (const project of projects) {
    if (typeof project?.path !== 'string') continue
    const newCreatedAt = await resolveDirCreatedAt(project.path)
    if (newCreatedAt !== project.createdAt) {
      project.createdAt = newCreatedAt
      migratedCount++
    }
  }

  await writeFile(paths.projectsFile, JSON.stringify(projects, null, 2), 'utf-8')

  record[CREATED_AT_TO_CTIME_MIGRATION_KEY] = new Date().toISOString()
  await saveMigrationsRecord(paths, record)

  return { migrated: migratedCount, total: projects.length }
}

// ── 034-B: protocol-history-v2 マイグレーション ──

function isHistoryFile(value: unknown): value is ProtocolHistoryFile {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return v.version === 2 && Array.isArray(v.history)
}

function isLegacyMarker(value: unknown): value is ProtocolMarker {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.protocol === 'string' && typeof v.revision === 'string'
}

async function migrateProtocolFileToV2(file: string): Promise<boolean> {
  if (!existsSync(file)) return false

  // バックアップ（既存があれば skip = 冪等）
  const backupPath = `${file}${PROTOCOL_HISTORY_BACKUP_SUFFIX}`
  if (!existsSync(backupPath)) {
    try {
      await copyFile(file, backupPath)
    } catch {
      // バックアップ失敗は continue 不能、warn
      console.warn(`[migrateProtocolFileToV2] backup failed: ${file}`)
      return false
    }
  }

  let parsed: unknown
  try {
    const content = await readFile(file, 'utf-8')
    parsed = JSON.parse(content)
  } catch {
    // JSON parse 失敗 → corrupted バックアップにリネーム + 空 history で初期化
    const corruptedPath = `${file}.bak.corrupted-${Date.now()}`
    try {
      await copyFile(file, corruptedPath)
    } catch {
      // バックアップ失敗、ログ + 続行
    }
    const emptyV2: ProtocolHistoryFile = { version: 2, history: [] }
    await writeFile(file, JSON.stringify(emptyV2, null, 2), 'utf-8')
    return true
  }

  // すでに v2 → 冪等 skip
  if (isHistoryFile(parsed)) return false

  // v1 (旧フラット) → v2 変換
  if (isLegacyMarker(parsed)) {
    const oldMarker = parsed
    const source: ProtocolEntrySource =
      oldMarker.detection_confidence === 'explicit' ? 'manual' : 'auto'

    let timestamp: string
    if (oldMarker.applied_at && /^\d{10}$/.test(oldMarker.applied_at)) {
      timestamp = parseAppliedAtToIso(oldMarker.applied_at)
    } else {
      try {
        const s = await stat(file)
        timestamp = s.mtime.toISOString()
      } catch {
        timestamp = new Date().toISOString()
      }
    }

    const entry: ProtocolHistoryEntry = {
      timestamp,
      source,
      app_version: oldMarker.applied_by || 'ccpit-pre-2.0.0',
      marker: oldMarker,
    }
    const newFile: ProtocolHistoryFile = { version: 2, history: [entry] }
    await writeFile(file, JSON.stringify(newFile, null, 2), 'utf-8')
    return true
  }

  // 未知形式 → corrupted リネーム + 空 history
  const corruptedPath = `${file}.bak.corrupted-${Date.now()}`
  try {
    await copyFile(file, corruptedPath)
  } catch {
    // 続行
  }
  const emptyV2: ProtocolHistoryFile = { version: 2, history: [] }
  await writeFile(file, JSON.stringify(emptyV2, null, 2), 'utf-8')
  return true
}

/**
 * 034-B: protocol-history-v2 マイグレーション。
 *
 * 1. 各 PJ の `.ccpit/protocol.json` を v1 から v2 に変換
 *    - confidence='explicit' → source='manual'
 *    - それ以外 → source='auto'
 *    - timestamp は applied_at からの推定 or ファイル mtime
 *    - バックアップ `.bak.before-protocol-history-v2` を作成
 * 2. 同時に projects.json から `confirmed` フィールドを削除（confirmed 廃止）
 * 3. migrations.json に履歴記録（冪等性管理）
 *
 * 戻り値: { migrated: 変換した PJ 件数, total: 全 PJ 件数 }
 */
export async function runProtocolHistoryV2Migration(
  paths: ProjectsMigrationPaths
): Promise<MigrationNotice | null> {
  if (await isMigrationApplied(paths.migrationsFile, PROTOCOL_HISTORY_V2_MIGRATION_KEY)) {
    return null
  }

  const record = await loadMigrationsRecord(paths.migrationsFile)

  // projects.json が無い → マイグレーション履歴だけ記録して終了
  if (!existsSync(paths.projectsFile)) {
    record[PROTOCOL_HISTORY_V2_MIGRATION_KEY] = new Date().toISOString()
    await saveMigrationsRecord(paths, record)
    return null
  }

  let projects: ProjectEntryShape[]
  try {
    const content = await readFile(paths.projectsFile, 'utf-8')
    const parsed = JSON.parse(content)
    if (!Array.isArray(parsed)) {
      record[PROTOCOL_HISTORY_V2_MIGRATION_KEY] = new Date().toISOString()
      await saveMigrationsRecord(paths, record)
      return null
    }
    projects = parsed as ProjectEntryShape[]
  } catch {
    record[PROTOCOL_HISTORY_V2_MIGRATION_KEY] = new Date().toISOString()
    await saveMigrationsRecord(paths, record)
    return null
  }

  // (1) 各 PJ の protocol.json v1 → v2
  let migratedCount = 0
  for (const project of projects) {
    if (typeof project?.path !== 'string') continue
    const protocolFile = join(project.path, '.ccpit', 'protocol.json')
    try {
      const migrated = await migrateProtocolFileToV2(protocolFile)
      if (migrated) migratedCount++
    } catch (e) {
      console.error(`[runProtocolHistoryV2Migration] failed for ${project.path}:`, e)
      // 個別失敗は continue（NR-1）
    }
  }

  // (2) projects.json から confirmed フィールドを削除
  let confirmedRemoved = 0
  for (const project of projects) {
    if ('confirmed' in project) {
      delete (project as Record<string, unknown>).confirmed
      confirmedRemoved++
    }
  }
  if (confirmedRemoved > 0) {
    await writeFile(paths.projectsFile, JSON.stringify(projects, null, 2), 'utf-8')
  }

  // (3) 履歴記録
  record[PROTOCOL_HISTORY_V2_MIGRATION_KEY] = new Date().toISOString()
  await saveMigrationsRecord(paths, record)

  return { migrated: migratedCount, total: projects.length }
}
