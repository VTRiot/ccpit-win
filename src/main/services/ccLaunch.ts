import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join, normalize } from 'path'

function getPathDirs(): string[] {
  const env = process.env.PATH || process.env.Path || ''
  const sep = process.platform === 'win32' ? ';' : ':'
  return env.split(sep).filter(Boolean)
}

export function whichExe(name: string): string | null {
  const dirs = getPathDirs()
  for (const dir of dirs) {
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return null
}

export interface LaunchArgs {
  projectPath: string
  flags: string[]
}

export interface LaunchResult {
  shell: string
  spawned: boolean
  error?: string
}

/**
 * CC を指定 PJ のカレントディレクトリで起動する。
 * シェル選定: wt.exe（Windows Terminal）優先、なければ powershell.exe。
 * spawn は detached + stdio:ignore で fire-and-forget。
 */
export function launchCc(args: LaunchArgs): LaunchResult {
  const projectPath = normalize(args.projectPath)
  if (!existsSync(projectPath)) {
    return { shell: '', spawned: false, error: `Project path not found: ${projectPath}` }
  }

  const wt = whichExe('wt.exe')
  const ps = whichExe('powershell.exe')

  // claude を引数とともに 1 行コマンドにビルド
  const claudeCmd = ['claude', ...args.flags.filter((f) => f.length > 0)].join(' ')

  if (wt) {
    // wt -d <path> powershell.exe -NoExit -Command "claude ..."
    const wtArgs = ['-d', projectPath, 'powershell.exe', '-NoExit', '-Command', claudeCmd]
    try {
      const child = spawn(wt, wtArgs, { detached: true, stdio: 'ignore', shell: false })
      child.unref()
      return { shell: 'wt.exe', spawned: true }
    } catch (e) {
      return { shell: 'wt.exe', spawned: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  if (ps) {
    // powershell -NoExit -Command "cd '<path>'; claude ..."
    const psArgs = ['-NoExit', '-Command', `cd '${projectPath}'; ${claudeCmd}`]
    try {
      const child = spawn(ps, psArgs, { detached: true, stdio: 'ignore', shell: false })
      child.unref()
      return { shell: 'powershell.exe', spawned: true }
    } catch (e) {
      return {
        shell: 'powershell.exe',
        spawned: false,
        error: e instanceof Error ? e.message : String(e),
      }
    }
  }

  return { shell: '', spawned: false, error: 'No shell found (wt.exe or powershell.exe)' }
}
