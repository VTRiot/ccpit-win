import { whichExe } from './ccLaunch'

/**
 * Windows の scoop/npm 系ラッパーは実体が `claude.cmd` で、Node の child_process は
 * 既定 `shell: false` で `.cmd` を CreateProcess 経由実行できない。絶対パス +
 * `shell: true` の組合せで起動する。`.exe` または POSIX 環境では `shell: false`。
 */
export function resolveClaudeBin(): { command: string; useShell: boolean } {
  if (process.platform === 'win32') {
    const cmd = whichExe('claude.cmd')
    if (cmd) return { command: cmd, useShell: true }
    const exe = whichExe('claude.exe')
    if (exe) return { command: exe, useShell: false }
  }
  const bare = whichExe('claude')
  if (bare) return { command: bare, useShell: false }
  return { command: 'claude', useShell: false }
}
