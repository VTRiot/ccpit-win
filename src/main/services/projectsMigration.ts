import { stat, readFile, writeFile, copyFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'

export const CREATED_AT_TO_CTIME_MIGRATION_KEY = 'createdAt-to-ctime'
export const CREATED_AT_MIGRATION_BACKUP_SUFFIX = '.bak.before-createdAt-ctime-migration'

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
