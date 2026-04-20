import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'
import { app } from 'electron'
import AdmZip from 'adm-zip'
import { getParcFermeDir } from './appConfig'

const BACKUPS_SUBDIR = 'backups'

function getClaudeDir(): string {
  return join(app.getPath('home'), '.claude')
}

export function getBackupDir(): string {
  return join(getParcFermeDir(), BACKUPS_SUBDIR)
}

/** 再帰的にファイル列挙（相対パス） */
function walkDir(dir: string, base: string): string[] {
  const out: string[] = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walkDir(full, base))
    } else {
      out.push(relative(base, full))
    }
  }
  return out
}

/** ~/.claude/ 配下の指定パスを zip にまとめ、manifest を同梱 */
export function createBackupZip(
  zipPath: string,
  pathsToBackup: readonly string[],
  manifest: Record<string, unknown>
): void {
  const zip = new AdmZip()
  const claudeDir = getClaudeDir()

  for (const entry of pathsToBackup) {
    const full = join(claudeDir, entry)
    if (!existsSync(full)) continue
    const stat = statSync(full)
    if (stat.isDirectory()) {
      for (const rel of walkDir(full, claudeDir)) {
        const src = join(claudeDir, rel)
        const entryName = rel.split(/[\\/]/).join('/')
        zip.addFile(entryName, readFileSync(src))
      }
    } else {
      zip.addFile(entry, readFileSync(full))
    }
  }

  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'))

  const dir = join(zipPath, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  zip.writeZip(zipPath)
}

/** ~/.ccpit/backups/ に ZIP backup が 1 件以上存在するか */
export function hasAnyBackup(): boolean {
  const dir = getBackupDir()
  if (!existsSync(dir)) return false
  return readdirSync(dir).some((n) => n.endsWith('.zip'))
}
