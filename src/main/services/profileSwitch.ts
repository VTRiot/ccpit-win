import { existsSync, mkdirSync, renameSync, rmSync, copyFileSync } from 'fs'
import { join } from 'path'
import { app, dialog } from 'electron'
import { getConfig, setConfig, type Profile } from './appConfig'
import { createBackupZip, getBackupDir } from './backup'

const MANX_STASH_DIR = '_manx_stash'
const BACKED_UP_PATHS = ['CLAUDE.md', 'rules', 'skills', 'hooks'] as const

function getClaudeDir(): string {
  return join(app.getPath('home'), '.claude')
}

function getManxStashDir(): string {
  return join(getClaudeDir(), MANX_STASH_DIR)
}

function formatTimestamp(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const ymd = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
  const hm = `${pad(d.getHours())}${pad(d.getMinutes())}`
  return `${ymd}_${hm}`
}

/** package.json の version を取得 */
function getAppVersion(): string {
  try {
    return app.getVersion()
  } catch {
    return 'unknown'
  }
}

export interface ProfileState {
  currentProfile: Profile
  lastBackupAt?: string
  backupDir: string
  claudeDir: string
  legacyMasterPath?: string
}

export function getState(): ProfileState {
  const cfg = getConfig()
  return {
    currentProfile: cfg.currentProfile,
    lastBackupAt: cfg.lastBackupAt,
    backupDir: getBackupDir(),
    claudeDir: getClaudeDir(),
    legacyMasterPath: cfg.legacyMasterPath,
  }
}

function buildSwitchToLegacyManifest(): Record<string, unknown> {
  return {
    created_at: new Date().toISOString(),
    operation: 'profile_switch_to_legacy',
    profile_from: 'manx',
    profile_to: 'legacy',
    backed_up_paths: [...BACKED_UP_PATHS].map((p) => (p === 'CLAUDE.md' ? p : p + '/')),
    restore_target: '~/.claude/',
    ccpit_version: getAppVersion(),
    note: 'MANX → Legacy 切替前の自動バックアップ。CCPIT Developer Tools → Profile Switch → MANX に復帰 で復元可能',
  }
}

/** MANX → Legacy 切替 */
export async function switchToLegacy(): Promise<{
  backupPath: string
  legacyClaudeMdPath: string
}> {
  const cfg = getConfig()
  if (cfg.currentProfile === 'legacy') {
    throw new Error('Already on legacy profile')
  }

  // 1. Legacy CLAUDE.md のパスを決定
  let legacyPath = cfg.legacyMasterPath
  if (!legacyPath || !existsSync(legacyPath)) {
    const result = await dialog.showOpenDialog({
      title: 'Select Legacy CLAUDE.md (v1 master)',
      properties: ['openFile'],
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    })
    if (result.canceled || result.filePaths.length === 0) {
      throw new Error('Legacy CLAUDE.md selection canceled')
    }
    legacyPath = result.filePaths[0]
    setConfig({ legacyMasterPath: legacyPath })
  }

  const claudeDir = getClaudeDir()
  if (!existsSync(claudeDir)) {
    throw new Error(`${claudeDir} does not exist. Run setup first.`)
  }

  // 2. zip バックアップ作成
  const ts = formatTimestamp(new Date())
  const backupFilename = `${ts}_manx_backup.zip`
  const backupPath = join(getBackupDir(), backupFilename)
  createBackupZip(backupPath, [...BACKED_UP_PATHS], buildSwitchToLegacyManifest())

  // 3. _manx_stash/ に退避
  const stashDir = getManxStashDir()
  if (existsSync(stashDir)) {
    rmSync(stashDir, { recursive: true, force: true })
  }
  mkdirSync(stashDir, { recursive: true })

  for (const entry of BACKED_UP_PATHS) {
    const src = join(claudeDir, entry)
    if (!existsSync(src)) continue
    const dest = join(stashDir, entry)
    renameSync(src, dest)
  }

  // 4. Legacy CLAUDE.md を配置
  const destClaudeMd = join(claudeDir, 'CLAUDE.md')
  copyFileSync(legacyPath, destClaudeMd)

  // 5. 状態保存
  setConfig({
    currentProfile: 'legacy',
    lastBackupAt: new Date().toISOString(),
  })

  return { backupPath, legacyClaudeMdPath: destClaudeMd }
}

/** Legacy → MANX 復帰 */
export function switchToManx(): { restoredPaths: string[] } {
  const cfg = getConfig()
  if (cfg.currentProfile === 'manx') {
    throw new Error('Already on manx profile')
  }

  const claudeDir = getClaudeDir()
  const stashDir = getManxStashDir()
  if (!existsSync(stashDir)) {
    throw new Error(`${stashDir} not found. Cannot restore MANX profile.`)
  }

  const restored: string[] = []
  for (const entry of BACKED_UP_PATHS) {
    const src = join(stashDir, entry)
    const dest = join(claudeDir, entry)
    if (!existsSync(src)) continue
    if (existsSync(dest)) {
      rmSync(dest, { recursive: true, force: true })
    }
    renameSync(src, dest)
    restored.push(entry)
  }

  // _manx_stash/ を削除（二重保持しない）
  rmSync(stashDir, { recursive: true, force: true })

  setConfig({ currentProfile: 'manx' })

  return { restoredPaths: restored }
}
