import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeftRight,
  Folder,
  RefreshCw,
  Monitor,
  RotateCcw,
  Copy,
  FileJson,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Button } from '../components/ui/button'

const AUTH_MASK_KEYS = ['password', 'authPassword', 'auth']

type ProfileState = {
  currentProfile: 'manx' | 'legacy'
  lastBackupAt?: string
  backupDir: string
  claudeDir: string
  legacyMasterPath?: string
}

function maskSecrets(json: Record<string, unknown>): Record<string, unknown> {
  const cloned: Record<string, unknown> = { ...json }
  for (const key of AUTH_MASK_KEYS) {
    if (key in cloned) {
      cloned[key] = '***'
    }
  }
  return cloned
}

function formatDateTime(iso?: string): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    const pad = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  } catch {
    return iso
  }
}

export function DebugPage(): React.JSX.Element {
  const { t } = useTranslation()
  const [splashDurationMs, setSplashDurationMs] = useState(3000)
  const [splashRareChance, setSplashRareChance] = useState(0.033)
  const [profileState, setProfileState] = useState<ProfileState | null>(null)
  const [appConfigJson, setAppConfigJson] = useState<string>('')
  const [switching, setSwitching] = useState(false)
  const [copiedTimer, setCopiedTimer] = useState(false)

  const refreshAppConfig = useCallback(async (): Promise<void> => {
    const cfg = await window.api.configGet()
    setSplashDurationMs(cfg.splashDurationMs)
    setSplashRareChance(cfg.splashRareChance)
    const masked = maskSecrets(cfg as unknown as Record<string, unknown>)
    setAppConfigJson(JSON.stringify(masked, null, 2))
    const ps = await window.api.profileGetState()
    setProfileState(ps)
  }, [])

  useEffect(() => {
    refreshAppConfig()
  }, [refreshAppConfig])

  const handleSplashDurationChange = (value: number): void => {
    setSplashDurationMs(value)
    window.api.configSet({ splashDurationMs: value }).then(refreshAppConfig)
  }

  const handleSplashRareChange = (value: number): void => {
    setSplashRareChance(value)
    window.api.configSet({ splashRareChance: value }).then(refreshAppConfig)
  }

  const handleSwitchToLegacy = async (): Promise<void> => {
    if (!confirm(t('settings.devTools.profileSwitch.confirmToLegacy'))) return
    setSwitching(true)
    try {
      await window.api.profileSwitchToLegacy()
      await refreshAppConfig()
    } catch (err) {
      alert(`Error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSwitching(false)
    }
  }

  const handleSwitchToManx = async (): Promise<void> => {
    if (!confirm(t('settings.devTools.profileSwitch.confirmToManx'))) return
    setSwitching(true)
    try {
      await window.api.profileSwitchToManx()
      await refreshAppConfig()
    } catch (err) {
      alert(`Error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSwitching(false)
    }
  }

  const handleOpenCcpit = async (): Promise<void> => {
    const dir = await window.api.devGetCcpitDir()
    await window.api.openPath(dir)
  }

  const handleOpenClaude = async (): Promise<void> => {
    const dir = await window.api.devGetClaudeDir()
    await window.api.openPath(dir)
  }

  const handleReloadUi = (): void => {
    location.reload()
  }

  const handleToggleDevTools = async (): Promise<void> => {
    await window.api.devToggleDevTools()
  }

  const handleResetSetup = async (): Promise<void> => {
    if (!confirm(t('settings.devTools.quickActions.resetConfirm'))) return
    await window.api.configSet({ setupCompleted: false })
    await window.api.devRelaunchApp()
  }

  const handleCopyConfig = async (): Promise<void> => {
    await window.api.clipboardWrite(appConfigJson)
    setCopiedTimer(true)
    setTimeout(() => setCopiedTimer(false), 1500)
  }

  const currentProfileLabel = profileState?.currentProfile === 'legacy'
    ? t('settings.devTools.profileSwitch.profileLegacy')
    : t('settings.devTools.profileSwitch.profileManx')

  const lastBackupLabel = profileState?.lastBackupAt
    ? formatDateTime(profileState.lastBackupAt)
    : t('settings.devTools.profileSwitch.never')

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-xl font-bold">{t('settings.devTools.title')}</h1>
        <p className="text-sm text-muted-foreground mt-1">{t('settings.devTools.enabled')}</p>
      </div>

      {/* Profile Switch */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ArrowLeftRight size={16} />
            {t('settings.devTools.profileSwitch.title')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">
              {t('settings.devTools.profileSwitch.currentProfile')}:
            </span>
            <span
              className={
                'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold ' +
                (profileState?.currentProfile === 'legacy'
                  ? 'bg-orange-600 text-white'
                  : 'bg-blue-600 text-white')
              }
            >
              {currentProfileLabel}
            </span>
          </div>

          <div>
            {profileState?.currentProfile === 'manx' ? (
              <Button
                variant="outline"
                onClick={handleSwitchToLegacy}
                disabled={switching}
                className="gap-2"
              >
                <ArrowLeftRight size={16} />
                {t('settings.devTools.profileSwitch.switchToLegacy')}
              </Button>
            ) : (
              <Button
                variant="outline"
                onClick={handleSwitchToManx}
                disabled={switching}
                className="gap-2"
              >
                <ArrowLeftRight size={16} />
                {t('settings.devTools.profileSwitch.switchToManx')}
              </Button>
            )}
          </div>

          <div className="space-y-1 text-xs text-muted-foreground">
            <div>
              {t('settings.devTools.profileSwitch.lastBackup')}: {lastBackupLabel}
            </div>
            <div>
              {t('settings.devTools.profileSwitch.backupLocation')}:{' '}
              <span className="font-mono">{profileState?.backupDir ?? ''}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Quick Actions */}
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.devTools.quickActions.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" className="gap-2" onClick={handleOpenCcpit}>
              <Folder size={16} />
              {t('settings.devTools.quickActions.openCcpit')}
            </Button>
            <Button variant="outline" className="gap-2" onClick={handleOpenClaude}>
              <Folder size={16} />
              {t('settings.devTools.quickActions.openClaude')}
            </Button>
            <Button variant="outline" className="gap-2" onClick={handleReloadUi}>
              <RefreshCw size={16} />
              {t('settings.devTools.quickActions.reloadUi')}
            </Button>
            <Button variant="outline" className="gap-2" onClick={handleToggleDevTools}>
              <Monitor size={16} />
              {t('settings.devTools.quickActions.toggleDevTools')}
            </Button>
            <Button variant="outline" className="gap-2" onClick={handleResetSetup}>
              <RotateCcw size={16} />
              {t('settings.devTools.quickActions.resetSetup')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Splash Settings */}
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.splashSettings')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <p className="text-sm font-medium">{t('settings.splashDuration')}</p>
            <p className="text-xs text-muted-foreground">{t('settings.splashDurationDescription')}</p>
            <div className="flex items-center gap-3 mt-1">
              <input
                type="range"
                min="500"
                max="10000"
                step="100"
                value={splashDurationMs}
                onChange={(e) => handleSplashDurationChange(parseInt(e.target.value))}
                className="flex-1"
              />
              <span className="text-sm font-mono w-20 text-right">
                {(splashDurationMs / 1000).toFixed(1)}s
              </span>
            </div>
          </div>

          <div className="space-y-1">
            <p className="text-sm font-medium">{t('settings.splashRareChance')}</p>
            <p className="text-xs text-muted-foreground">{t('settings.splashRareChanceDescription')}</p>
            <div className="flex items-center gap-3 mt-1">
              <input
                type="range"
                min="0"
                max="1"
                step="0.001"
                value={splashRareChance}
                onChange={(e) => handleSplashRareChange(parseFloat(e.target.value))}
                className="flex-1"
              />
              <span className="text-sm font-mono w-16 text-right">
                {(splashRareChance * 100).toFixed(1)}%
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* app-config.json Viewer */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileJson size={16} />
            {t('settings.devTools.configViewer.title')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <pre className="text-xs bg-muted/30 border border-border rounded-md p-3 overflow-auto max-h-80 font-mono">
            {appConfigJson}
          </pre>
          <Button variant="outline" size="sm" className="gap-2" onClick={handleCopyConfig}>
            <Copy size={14} />
            {copiedTimer ? t('common.copied') : t('settings.devTools.configViewer.copy')}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
