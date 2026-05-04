import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, rm, writeFile, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  runProtocolHistoryV2Migration,
  loadMigrationsRecord,
  isMigrationApplied,
  PROTOCOL_HISTORY_V2_MIGRATION_KEY,
  PROTOCOL_HISTORY_BACKUP_SUFFIX,
  type ProjectsMigrationPaths,
} from '../projectsMigration'
import type { ProtocolHistoryFile, ProtocolMarker } from '../protocol'

let workdir: string
let parcFermeDir: string
let projectsFile: string
let migrationsFile: string
let paths: ProjectsMigrationPaths

beforeEach(async () => {
  workdir = join(
    tmpdir(),
    `ccpit-protocol-migration-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
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

function legacyMarker(overrides: Partial<ProtocolMarker> = {}): ProtocolMarker {
  return {
    protocol: 'manx',
    revision: 'r5',
    stage: 'experimental',
    stage_inferred: false,
    variant: null,
    variant_alias: null,
    applied_at: '2604300643',
    applied_by: 'ccpit-1.0.0',
    detection_evidence: null,
    detection_confidence: 'explicit',
    ...overrides,
  }
}

async function setupProjectWithLegacyMarker(
  projectName: string,
  marker: ProtocolMarker
): Promise<string> {
  const projectPath = join(workdir, projectName)
  await mkdir(join(projectPath, '.ccpit'), { recursive: true })
  await writeFile(
    join(projectPath, '.ccpit', 'protocol.json'),
    JSON.stringify(marker, null, 2),
    'utf-8'
  )
  return projectPath
}

describe('034-B: protocolHistoryV2Migration', () => {
  it('TC-MIG-1: v1 (フラット) → v2、confidence="explicit" → source="manual"', async () => {
    const pj = await setupProjectWithLegacyMarker('PJ-explicit', legacyMarker({ detection_confidence: 'explicit' }))
    await writeFile(projectsFile, JSON.stringify([{ name: 'PJ-explicit', path: pj, createdAt: '' }], null, 2), 'utf-8')

    const notice = await runProtocolHistoryV2Migration(paths)
    expect(notice).not.toBeNull()
    expect(notice!.migrated).toBe(1)

    const protocolFile = join(pj, '.ccpit', 'protocol.json')
    const parsed = JSON.parse(await readFile(protocolFile, 'utf-8')) as ProtocolHistoryFile
    expect(parsed.version).toBe(2)
    expect(parsed.history.length).toBe(1)
    expect(parsed.history[0].source).toBe('manual')
  })

  it('TC-MIG-2: v1 → v2、confidence="low" → source="auto"', async () => {
    const pj = await setupProjectWithLegacyMarker(
      'PJ-low',
      legacyMarker({ detection_confidence: 'low', applied_at: null, applied_by: 'ccpit-1.0.0' })
    )
    await writeFile(projectsFile, JSON.stringify([{ name: 'PJ-low', path: pj, createdAt: '' }], null, 2), 'utf-8')

    await runProtocolHistoryV2Migration(paths)

    const protocolFile = join(pj, '.ccpit', 'protocol.json')
    const parsed = JSON.parse(await readFile(protocolFile, 'utf-8')) as ProtocolHistoryFile
    expect(parsed.history[0].source).toBe('auto')
  })

  it('TC-MIG-3: 冪等性（v2 → v2 で変化なし、history に追加されない）', async () => {
    const pj = await setupProjectWithLegacyMarker('PJ-idem', legacyMarker())
    await writeFile(projectsFile, JSON.stringify([{ name: 'PJ-idem', path: pj, createdAt: '' }], null, 2), 'utf-8')

    // 1 回目: v1 → v2
    await runProtocolHistoryV2Migration(paths)
    expect(await isMigrationApplied(migrationsFile, PROTOCOL_HISTORY_V2_MIGRATION_KEY)).toBe(true)

    // 2 回目: 既に applied なので no-op を返す
    const notice2 = await runProtocolHistoryV2Migration(paths)
    expect(notice2).toBeNull()

    // history が増えていないことを確認
    const protocolFile = join(pj, '.ccpit', 'protocol.json')
    const parsed = JSON.parse(await readFile(protocolFile, 'utf-8')) as ProtocolHistoryFile
    expect(parsed.history.length).toBe(1)
  })

  it('TC-MIG-4: バックアップ作成（.bak.before-protocol-history-v2）', async () => {
    const pj = await setupProjectWithLegacyMarker('PJ-bak', legacyMarker())
    await writeFile(projectsFile, JSON.stringify([{ name: 'PJ-bak', path: pj, createdAt: '' }], null, 2), 'utf-8')

    await runProtocolHistoryV2Migration(paths)

    const backupPath = join(pj, '.ccpit', 'protocol.json' + PROTOCOL_HISTORY_BACKUP_SUFFIX)
    expect(existsSync(backupPath)).toBe(true)
    // バックアップは旧 v1 形式を保持
    const parsed = JSON.parse(await readFile(backupPath, 'utf-8')) as ProtocolMarker
    expect(parsed.protocol).toBe('manx')
    expect(parsed.detection_confidence).toBe('explicit')
  })

  it('TC-MIG-5: 個別 PJ 破損でも他 PJ は処理継続', async () => {
    const pj1 = await setupProjectWithLegacyMarker('PJ-ok', legacyMarker())
    // 破損 PJ: 不正な JSON
    const pj2 = join(workdir, 'PJ-broken')
    await mkdir(join(pj2, '.ccpit'), { recursive: true })
    await writeFile(join(pj2, '.ccpit', 'protocol.json'), 'INVALID JSON{{{', 'utf-8')
    const pj3 = await setupProjectWithLegacyMarker('PJ-ok2', legacyMarker())

    await writeFile(
      projectsFile,
      JSON.stringify(
        [
          { name: 'PJ-ok', path: pj1, createdAt: '' },
          { name: 'PJ-broken', path: pj2, createdAt: '' },
          { name: 'PJ-ok2', path: pj3, createdAt: '' },
        ],
        null,
        2
      ),
      'utf-8'
    )

    const notice = await runProtocolHistoryV2Migration(paths)
    expect(notice).not.toBeNull()

    // pj1, pj3 は v2 化成功
    const p1 = JSON.parse(
      await readFile(join(pj1, '.ccpit', 'protocol.json'), 'utf-8')
    ) as ProtocolHistoryFile
    expect(p1.version).toBe(2)
    const p3 = JSON.parse(
      await readFile(join(pj3, '.ccpit', 'protocol.json'), 'utf-8')
    ) as ProtocolHistoryFile
    expect(p3.version).toBe(2)
    // pj2 (破損) は corrupted 退避 + 空 v2 で初期化
    const p2Content = await readFile(join(pj2, '.ccpit', 'protocol.json'), 'utf-8')
    const p2 = JSON.parse(p2Content) as ProtocolHistoryFile
    expect(p2.version).toBe(2)
    expect(p2.history.length).toBe(0)
  })

  it('TC-MIG-6: projects.json から confirmed フィールドを削除', async () => {
    const pj = await setupProjectWithLegacyMarker('PJ-conf', legacyMarker())
    await writeFile(
      projectsFile,
      JSON.stringify(
        [
          { name: 'PJ-conf', path: pj, createdAt: '', confirmed: true },
          { name: 'PJ-conf2', path: pj + '-2', createdAt: '', confirmed: false },
        ],
        null,
        2
      ),
      'utf-8'
    )

    await runProtocolHistoryV2Migration(paths)

    const projectsContent = JSON.parse(await readFile(projectsFile, 'utf-8'))
    expect(projectsContent[0]).not.toHaveProperty('confirmed')
    expect(projectsContent[1]).not.toHaveProperty('confirmed')
  })

  it('TC-MIG-7: マイグレーション履歴記録（migrations.json）', async () => {
    await writeFile(projectsFile, JSON.stringify([], null, 2), 'utf-8')
    await runProtocolHistoryV2Migration(paths)

    const record = await loadMigrationsRecord(migrationsFile)
    expect(record[PROTOCOL_HISTORY_V2_MIGRATION_KEY]).toBeDefined()
    expect(typeof record[PROTOCOL_HISTORY_V2_MIGRATION_KEY]).toBe('string')
  })
})
