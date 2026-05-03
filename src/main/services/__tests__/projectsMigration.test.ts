import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, rm, writeFile, readFile, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  resolveDirCreatedAt,
  runCreatedAtToCtimeMigration,
  loadMigrationsRecord,
  isMigrationApplied,
  CREATED_AT_TO_CTIME_MIGRATION_KEY,
  CREATED_AT_MIGRATION_BACKUP_SUFFIX,
  type ProjectsMigrationPaths
} from '../projectsMigration'

let workdir: string
let parcFermeDir: string
let projectsFile: string
let migrationsFile: string
let paths: ProjectsMigrationPaths

beforeEach(async () => {
  workdir = join(
    tmpdir(),
    `ccpit-projects-migration-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  await mkdir(workdir, { recursive: true })
  parcFermeDir = join(workdir, '.ccpit')
  projectsFile = join(parcFermeDir, 'projects.json')
  migrationsFile = join(parcFermeDir, 'migrations.json')
  paths = { parcFermeDir, projectsFile, migrationsFile }
  await mkdir(parcFermeDir, { recursive: true })
})

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true })
})

describe('resolveDirCreatedAt', () => {
  it('TC1: returns birthtime ISO 8601 string for an existing directory', async () => {
    const targetDir = join(workdir, 'project-a')
    await mkdir(targetDir, { recursive: true })
    const result = await resolveDirCreatedAt(targetDir)
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    const realStat = await stat(targetDir)
    const expected =
      realStat.birthtime.getTime() > 0
        ? realStat.birthtime.toISOString()
        : realStat.mtime.toISOString()
    expect(result).toBe(expected)
  })

  it('TC2: returns current time fallback when path does not exist', async () => {
    const before = Date.now()
    const result = await resolveDirCreatedAt(join(workdir, 'does-not-exist'))
    const after = Date.now()
    const t = new Date(result).getTime()
    expect(t).toBeGreaterThanOrEqual(before)
    expect(t).toBeLessThanOrEqual(after + 1000)
  })

  it('TC3: returns distinct values for directories created at different times', async () => {
    const dir1 = join(workdir, 'dir1')
    await mkdir(dir1, { recursive: true })
    await new Promise((r) => setTimeout(r, 50))
    const dir2 = join(workdir, 'dir2')
    await mkdir(dir2, { recursive: true })
    const v1 = await resolveDirCreatedAt(dir1)
    const v2 = await resolveDirCreatedAt(dir2)
    expect(new Date(v2).getTime()).toBeGreaterThanOrEqual(new Date(v1).getTime())
  })
})

describe('runCreatedAtToCtimeMigration - idempotency', () => {
  it('TC4: skips migration if marker is already present', async () => {
    await writeFile(
      migrationsFile,
      JSON.stringify({ [CREATED_AT_TO_CTIME_MIGRATION_KEY]: '2026-01-01T00:00:00Z' }),
      'utf-8'
    )
    await writeFile(
      projectsFile,
      JSON.stringify([{ name: 'a', path: workdir, createdAt: 'old-value' }]),
      'utf-8'
    )
    const result = await runCreatedAtToCtimeMigration(paths)
    expect(result).toBeNull()
    const after = JSON.parse(await readFile(projectsFile, 'utf-8'))
    expect(after[0].createdAt).toBe('old-value')
  })

  it('TC5: writes marker even when projects.json does not exist (no-op for first install)', async () => {
    expect(existsSync(projectsFile)).toBe(false)
    const result = await runCreatedAtToCtimeMigration(paths)
    expect(result).toBeNull()
    expect(await isMigrationApplied(migrationsFile, CREATED_AT_TO_CTIME_MIGRATION_KEY)).toBe(true)
  })

  it('TC6: second run is a no-op (idempotent)', async () => {
    const projectDir = join(workdir, 'pj1')
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      projectsFile,
      JSON.stringify([{ name: 'pj1', path: projectDir, createdAt: 'bulk-shared-value' }]),
      'utf-8'
    )
    const first = await runCreatedAtToCtimeMigration(paths)
    expect(first).not.toBeNull()
    const second = await runCreatedAtToCtimeMigration(paths)
    expect(second).toBeNull()
  })
})

describe('runCreatedAtToCtimeMigration - core behavior', () => {
  it('TC7: rewrites bulk-shared createdAt to per-PJ ctime values', async () => {
    const dirA = join(workdir, 'pjA')
    const dirB = join(workdir, 'pjB')
    await mkdir(dirA, { recursive: true })
    await new Promise((r) => setTimeout(r, 50))
    await mkdir(dirB, { recursive: true })
    const sharedCreatedAt = '2026-04-29T21:06:50.102Z'
    await writeFile(
      projectsFile,
      JSON.stringify([
        { name: 'pjA', path: dirA, createdAt: sharedCreatedAt, status: 'legacy', favorite: false },
        { name: 'pjB', path: dirB, createdAt: sharedCreatedAt, status: 'legacy', favorite: true }
      ]),
      'utf-8'
    )
    const notice = await runCreatedAtToCtimeMigration(paths)
    expect(notice).not.toBeNull()
    expect(notice?.total).toBe(2)
    expect(notice?.migrated).toBeGreaterThan(0)

    const after = JSON.parse(await readFile(projectsFile, 'utf-8'))
    expect(after[0].createdAt).not.toBe(sharedCreatedAt)
    expect(after[1].createdAt).not.toBe(sharedCreatedAt)
  })

  it('TC8: preserves all non-createdAt fields (status, favorite, location_type, etc.)', async () => {
    const dir = join(workdir, 'pj-preserve')
    await mkdir(dir, { recursive: true })
    await writeFile(
      projectsFile,
      JSON.stringify([
        {
          name: 'pj-preserve',
          path: dir,
          createdAt: 'old',
          status: 'manx',
          favorite: true,
          location_type: 'local',
          parent_id: null,
          documents: ['doc1.md']
        }
      ]),
      'utf-8'
    )
    await runCreatedAtToCtimeMigration(paths)
    const after = JSON.parse(await readFile(projectsFile, 'utf-8'))
    expect(after[0].name).toBe('pj-preserve')
    expect(after[0].status).toBe('manx')
    expect(after[0].favorite).toBe(true)
    expect(after[0].location_type).toBe('local')
    expect(after[0].parent_id).toBeNull()
    expect(after[0].documents).toEqual(['doc1.md'])
  })

  it('TC9: creates a backup file before mutating projects.json', async () => {
    const dir = join(workdir, 'pj-backup')
    await mkdir(dir, { recursive: true })
    await writeFile(
      projectsFile,
      JSON.stringify([{ name: 'pj-backup', path: dir, createdAt: 'old' }]),
      'utf-8'
    )
    const backupPath = `${projectsFile}${CREATED_AT_MIGRATION_BACKUP_SUFFIX}`
    expect(existsSync(backupPath)).toBe(false)
    await runCreatedAtToCtimeMigration(paths)
    expect(existsSync(backupPath)).toBe(true)
    const backup = JSON.parse(await readFile(backupPath, 'utf-8'))
    expect(backup[0].createdAt).toBe('old')
  })

  it('TC10: handles missing PJ directories with fallback (no error)', async () => {
    const goodDir = join(workdir, 'good')
    await mkdir(goodDir, { recursive: true })
    await writeFile(
      projectsFile,
      JSON.stringify([
        { name: 'good', path: goodDir, createdAt: 'shared' },
        { name: 'gone', path: join(workdir, 'does-not-exist'), createdAt: 'shared' }
      ]),
      'utf-8'
    )
    const notice = await runCreatedAtToCtimeMigration(paths)
    expect(notice?.total).toBe(2)
    const after = JSON.parse(await readFile(projectsFile, 'utf-8'))
    expect(after[0].createdAt).not.toBe('shared')
    expect(after[1].createdAt).not.toBe('shared')
  })

  it('TC11: handles malformed projects.json gracefully (marker only)', async () => {
    await writeFile(projectsFile, '{not valid json', 'utf-8')
    const notice = await runCreatedAtToCtimeMigration(paths)
    expect(notice).toBeNull()
    expect(await isMigrationApplied(migrationsFile, CREATED_AT_TO_CTIME_MIGRATION_KEY)).toBe(true)
  })

  it('TC12: writes migrations.json record after a successful run', async () => {
    const dir = join(workdir, 'pj-record')
    await mkdir(dir, { recursive: true })
    await writeFile(
      projectsFile,
      JSON.stringify([{ name: 'pj-record', path: dir, createdAt: 'old' }]),
      'utf-8'
    )
    expect(existsSync(migrationsFile)).toBe(false)
    await runCreatedAtToCtimeMigration(paths)
    expect(existsSync(migrationsFile)).toBe(true)
    const record = await loadMigrationsRecord(migrationsFile)
    expect(record[CREATED_AT_TO_CTIME_MIGRATION_KEY]).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})
