import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Play, MoreHorizontal } from 'lucide-react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from './ui/dropdown-menu'
import { Checkbox } from './ui/checkbox'
import {
  PERMISSION_MODES,
  EFFORT_LEVELS,
  DEFAULT_OPTIONS,
  loadLaunchOptions,
  saveLaunchOptions,
  buildFlags,
  type LaunchOptions,
  type PermissionMode,
  type EffortLevel,
} from '../lib/launchOptions'

interface LaunchMenuProps {
  projectPath: string
  onLaunched?: (result: { shell: string; spawned: boolean; error?: string }) => void
}

export function LaunchMenu({ projectPath, onLaunched }: LaunchMenuProps): React.JSX.Element {
  const { t } = useTranslation()
  const [opts, setOpts] = useState<LaunchOptions>(DEFAULT_OPTIONS)
  const [launching, setLaunching] = useState(false)

  useEffect(() => {
    setOpts(loadLaunchOptions())
  }, [])

  const update = <K extends keyof LaunchOptions>(key: K, value: LaunchOptions[K]): void => {
    const next = { ...opts, [key]: value }
    setOpts(next)
    saveLaunchOptions(next)
  }

  const handleLaunch = async (): Promise<void> => {
    setLaunching(true)
    try {
      const flags = buildFlags(opts)
      const result = await window.api.ccLaunch({ projectPath, flags })
      onLaunched?.(result)
    } finally {
      setLaunching(false)
    }
  }

  return (
    <div className="flex items-center gap-1">
      <Button
        variant="default"
        size="sm"
        className="gap-1.5"
        onClick={handleLaunch}
        disabled={launching}
        title={t('pages.projects.launch.launchTitle')}
      >
        <Play size={14} />
        {t('pages.projects.launch.launch')}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            title={t('pages.projects.launch.optionsTitle')}
          >
            <MoreHorizontal size={14} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80 p-3">
          <DropdownMenuLabel className="text-sm font-semibold">
            {t('pages.projects.launch.optionsTitle')}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />

          <div className="space-y-3 p-1">
            <label className="flex items-center gap-2 cursor-pointer">
              <Checkbox
                checked={opts.skipPermissions}
                onCheckedChange={(v) => update('skipPermissions', v === true)}
              />
              <span className="text-sm">{t('pages.projects.launch.opts.skipPermissions')}</span>
            </label>

            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">
                {t('pages.projects.launch.opts.permissionMode')}
              </span>
              <select
                value={opts.permissionMode}
                onChange={(e) => update('permissionMode', e.target.value as PermissionMode)}
                className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
              >
                {PERMISSION_MODES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>

            <label className="flex items-center gap-2 cursor-pointer">
              <Checkbox
                checked={opts.continueLast}
                onCheckedChange={(v) => update('continueLast', v === true)}
              />
              <span className="text-sm">{t('pages.projects.launch.opts.continueLast')}</span>
            </label>

            <div className="space-y-1">
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={opts.resume.enabled}
                  onCheckedChange={(v) =>
                    update('resume', { ...opts.resume, enabled: v === true })
                  }
                />
                <span className="text-sm">{t('pages.projects.launch.opts.resume')}</span>
              </label>
              {opts.resume.enabled && (
                <Input
                  value={opts.resume.value}
                  onChange={(e) => update('resume', { ...opts.resume, value: e.target.value })}
                  placeholder={t('pages.projects.launch.opts.resumePlaceholder')}
                  className="text-sm"
                />
              )}
            </div>

            <label className="flex items-center gap-2 cursor-pointer">
              <Checkbox
                checked={opts.verbose}
                onCheckedChange={(v) => update('verbose', v === true)}
              />
              <span className="text-sm">{t('pages.projects.launch.opts.verbose')}</span>
            </label>

            <div className="space-y-1">
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={opts.addDir.enabled}
                  onCheckedChange={(v) =>
                    update('addDir', { ...opts.addDir, enabled: v === true })
                  }
                />
                <span className="text-sm">{t('pages.projects.launch.opts.addDir')}</span>
              </label>
              {opts.addDir.enabled && (
                <Input
                  value={opts.addDir.value}
                  onChange={(e) => update('addDir', { ...opts.addDir, value: e.target.value })}
                  placeholder={t('pages.projects.launch.opts.addDirPlaceholder')}
                  className="text-sm font-mono"
                />
              )}
            </div>

            <label className="flex items-center gap-2 cursor-pointer">
              <Checkbox
                checked={opts.ideAutoConnect}
                onCheckedChange={(v) => update('ideAutoConnect', v === true)}
              />
              <span className="text-sm">{t('pages.projects.launch.opts.ideAutoConnect')}</span>
            </label>

            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">
                {t('pages.projects.launch.opts.effort')}
              </span>
              <select
                value={opts.effort}
                onChange={(e) => update('effort', e.target.value as EffortLevel)}
                className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
              >
                {EFFORT_LEVELS.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
