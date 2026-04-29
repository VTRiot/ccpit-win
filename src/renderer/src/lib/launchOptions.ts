export const LAUNCH_OPTIONS_STORAGE_KEY = 'ccpit-launch-options'

export const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'dontAsk',
  'bypassPermissions',
] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

export interface LaunchOptions {
  skipPermissions: boolean
  permissionMode: PermissionMode
  continueLast: boolean
  resume: { enabled: boolean; value: string }
  verbose: boolean
  addDir: { enabled: boolean; value: string }
  ideAutoConnect: boolean
  effort: EffortLevel
}

export const DEFAULT_OPTIONS: LaunchOptions = {
  skipPermissions: false,
  permissionMode: 'default',
  continueLast: false,
  resume: { enabled: false, value: '' },
  verbose: false,
  addDir: { enabled: false, value: '' },
  ideAutoConnect: false,
  effort: 'medium',
}

export function loadLaunchOptions(): LaunchOptions {
  try {
    const raw = localStorage.getItem(LAUNCH_OPTIONS_STORAGE_KEY)
    if (!raw) return DEFAULT_OPTIONS
    const parsed = JSON.parse(raw) as Partial<LaunchOptions>
    return { ...DEFAULT_OPTIONS, ...parsed }
  } catch {
    return DEFAULT_OPTIONS
  }
}

export function saveLaunchOptions(opts: LaunchOptions): void {
  localStorage.setItem(LAUNCH_OPTIONS_STORAGE_KEY, JSON.stringify(opts))
}

export function buildFlags(opts: LaunchOptions): string[] {
  const flags: string[] = []
  if (opts.skipPermissions) flags.push('--dangerously-skip-permissions')
  if (opts.permissionMode !== 'default') flags.push('--permission-mode', opts.permissionMode)
  if (opts.continueLast) flags.push('-c')
  const resumeValue = opts.resume.value.trim()
  if (opts.resume.enabled && resumeValue) flags.push('-r', resumeValue)
  if (opts.verbose) flags.push('--verbose')
  if (opts.addDir.enabled) {
    opts.addDir.value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((dir) => flags.push('--add-dir', dir))
  }
  if (opts.ideAutoConnect) flags.push('--ide')
  if (opts.effort !== 'medium') flags.push('--effort', opts.effort)
  return flags
}
