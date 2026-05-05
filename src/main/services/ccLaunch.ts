import { spawn } from 'child_process'
import { existsSync, lstatSync } from 'fs'
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
    // 037 Phase 2-C: WindowsApps "App Execution Alias" は reparse point (symlink) で
    // existsSync が false を返す（内部 stat が EACCES を発生させる）。lstat で symlink
    // 判定して救済する。これがないと wt.exe を検出できず powershell.exe フォールバックに
    // 落ち、Electron GUI app からの spawn で新規ウィンドウが生成されない。
    try {
      const st = lstatSync(candidate)
      if (st.isSymbolicLink()) return candidate
    } catch {
      /* not present, try next dir */
    }
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

export interface LaunchSpec {
  shell: 'wt.exe' | 'powershell.exe'
  command: string
  args: string[]
}

/**
 * 037 Phase 2-C: spawn 引数の組み立てを純関数化。Electron GUI app からの spawn では
 * `detached + stdio:ignore` でも新規コンソールウィンドウが生成されないため、cmd.exe の
 * `start` 経由で起動して独立ウィンドウを確実に作る。`start` の第 1 引数は空タイトル `""`
 * が必須（パス文字列をタイトルと誤解しないため）。
 */
export function buildLaunchSpec(
  args: LaunchArgs,
  exePaths: { wt: string | null; ps: string | null }
): LaunchSpec | { error: string } {
  const projectPath = normalize(args.projectPath)
  const claudeCmd = ['claude', ...args.flags.filter((f) => f.length > 0)].join(' ')

  if (exePaths.wt) {
    // 037 Phase 2-C 追加: wt.exe は GUI アプリで自前のウィンドウを生成するため、
    // cmd /c start を経由せず直接 spawn する。cmd 中継プロセスが消え、
    // フォーカス制御（ipc.ts 側 BrowserWindow.blur）と組合せて新ウィンドウが
    // CCPIT 前面に出やすくなる。ps 経路は console アプリのため cmd /c start 維持。
    return {
      shell: 'wt.exe',
      command: exePaths.wt,
      args: ['-d', projectPath, 'powershell.exe', '-NoExit', '-Command', claudeCmd],
    }
  }

  if (exePaths.ps) {
    return {
      shell: 'powershell.exe',
      command: 'cmd.exe',
      args: [
        '/c',
        'start',
        '""',
        '/D',
        projectPath,
        exePaths.ps,
        '-NoExit',
        '-Command',
        claudeCmd,
      ],
    }
  }

  return { error: 'No shell found (wt.exe or powershell.exe)' }
}

/**
 * CC を指定 PJ のカレントディレクトリで起動する。
 * シェル選定: wt.exe（Windows Terminal）優先、なければ powershell.exe。
 * spawn は cmd.exe /c start 経由 + detached + stdio:ignore で fire-and-forget。
 */
export function launchCc(args: LaunchArgs): LaunchResult {
  const projectPath = normalize(args.projectPath)
  if (!existsSync(projectPath)) {
    return { shell: '', spawned: false, error: `Project path not found: ${projectPath}` }
  }

  const spec = buildLaunchSpec(args, {
    wt: whichExe('wt.exe'),
    ps: whichExe('powershell.exe'),
  })
  if ('error' in spec) {
    return { shell: '', spawned: false, error: spec.error }
  }

  try {
    const child = spawn(spec.command, spec.args, {
      detached: true,
      stdio: 'ignore',
      shell: false,
    })
    child.unref()
    return { shell: spec.shell, spawned: true }
  } catch (e) {
    return {
      shell: spec.shell,
      spawned: false,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}
