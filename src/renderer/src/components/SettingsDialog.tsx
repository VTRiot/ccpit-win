import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Settings, Wrench, Info, Clipboard, RefreshCcw, Terminal } from 'lucide-react'
import { Button } from './ui/button'
import { Label } from './ui/label'
import { Checkbox } from './ui/checkbox'
import { cn } from '../lib/utils'
import { MaintenanceDialog } from './MaintenanceDialog'
import { AboutDialog } from './AboutDialog'
import { formatCatalogTimestamp } from '../lib/catalogFormat'
import { announceModelCatalogChanged } from '../lib/modelCatalogEvent'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'
import { setBgccHiddenPref, openBgccPanel } from '../hooks/useBgccActivity'

interface SettingsDialogProps {
  theme: 'dark' | 'light'
  onToggleTheme: () => void
  language: 'en' | 'ja'
  onToggleLanguage: () => void
  showSetupNav: boolean
  onToggleShowSetupNav: (next: boolean) => Promise<void>
  onResetSetup: () => Promise<void>
}

export function SettingsDialogTrigger(props: SettingsDialogProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [maintenanceOpen, setMaintenanceOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const { t } = useTranslation()

  // 036: CCES settings (opening text). allowAllProjects switch was moved to MaintenanceDialog (037 Phase 2-B).
  const [ccesOpening, setCcesOpening] = useState<string>('')

  // 040: 裏CC定石（BG headless CC）共通の可視性設定 + モデルカタログ手動更新。
  const [backstageHidden, setBackstageHidden] = useState(false)
  const [catalogFetchedAt, setCatalogFetchedAt] = useState<string | null>(null)
  const [refreshingCatalog, setRefreshingCatalog] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      try {
        const cfg = await window.api.configGet()
        if (cancelled) return
        setCcesOpening(cfg.cces?.openingText ?? '')
        setBackstageHidden(cfg.backstageCc?.hidden ?? false)
      } catch {
        /* ignore */
      }
      try {
        const catalog = await window.api.modelCatalogGet()
        if (cancelled) return
        setCatalogFetchedAt(catalog?.fetchedAt ?? null)
      } catch {
        /* ignore */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  const persistCces = async (next: {
    openingText?: string
    allowAllProjects?: boolean
  }): Promise<void> => {
    try {
      const cfg = await window.api.configGet()
      const merged = { ...(cfg.cces ?? {}), ...next }
      await window.api.configSet({ cces: merged })
    } catch {
      /* ignore — UI keeps optimistic value */
    }
  }

  const resetCcesOpeningToDefault = (): void => {
    const def = t('settings.cces.openingDefault')
    setCcesOpening(def)
    void persistCces({ openingText: def })
  }

  const handleToggleBackstageHidden = async (next: boolean): Promise<void> => {
    setBackstageHidden(next)
    // FB02 F6: パネル自動オープン抑止をストアへ即同期（config 再読なしで反映）
    setBgccHiddenPref(next)
    try {
      await window.api.configSet({ backstageCc: { hidden: next } })
    } catch {
      /* ignore — UI keeps optimistic value */
    }
  }

  const handleRefreshModelCatalog = async (): Promise<void> => {
    setRefreshingCatalog(true)
    // FB02 A1 補完: singleflight で実行中の startup run に相乗りした場合 manual の start
    // イベントが出ないため、手動操作時はローカルにもパネルを開く（hidden=true 時は開かない）。
    if (!backstageHidden) openBgccPanel()
    try {
      const catalog = await window.api.modelCatalogRefresh()
      setCatalogFetchedAt(catalog?.fetchedAt ?? null)
      // 053 実装レビュー2巡目 medium [1]: 取得成功をマウント済みの LaunchMenu /
      // FableLaunchButton へ伝搬（Fable バージョン選択肢の陳腐化防止）。失敗時は通知しない。
      // 054 以降は summary → useBgccActivity 経由でも announce が飛ぶため手動 refresh は
      // 二重発火になるが、再読は冪等（費用は購読者 × 2 IPC が 1 回分）。bus 経路が切れた
      // ときの保険としてこの明示 announce は意図的に残す。
      if (catalog) announceModelCatalogChanged()
    } catch {
      /* ignore — R-4: 失敗時もUIエラー通知はしない */
    } finally {
      setRefreshingCatalog(false)
    }
  }

  const handleOpenMaintenance = (): void => {
    setOpen(false)
    setMaintenanceOpen(true)
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-3 px-3 py-2 text-sm rounded-md text-muted-foreground hover:bg-sidebar-hover hover:text-foreground transition-colors w-full"
      >
        <Settings size={18} />
        {t('sidebar.settings')}
      </button>

      <MaintenanceDialog
        open={maintenanceOpen}
        onClose={() => setMaintenanceOpen(false)}
        onResetSetup={props.onResetSetup}
        showSetupNav={props.showSetupNav}
        onToggleShowSetupNav={props.onToggleShowSetupNav}
      />
      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />

          <div className="relative bg-card border border-border rounded-lg shadow-lg w-full max-w-sm mx-4 flex flex-col">
            <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
              <h2 className="text-base font-semibold">{t('settings.title')}</h2>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setOpen(false)}
                className="h-8 w-8"
              >
                <X size={16} />
              </Button>
            </div>

            <div className="p-4 space-y-5">
              {/* Language */}
              <div className="space-y-2">
                <Label>{t('settings.language')}</Label>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      if (props.language !== 'en') props.onToggleLanguage()
                    }}
                    className={cn(
                      'flex-1 px-3 py-2 rounded-md text-sm font-medium border transition-colors',
                      props.language === 'en'
                        ? 'border-primary bg-primary/10 text-foreground'
                        : 'border-border text-muted-foreground hover:bg-accent'
                    )}
                  >
                    {t('settings.english')}
                  </button>
                  <button
                    onClick={() => {
                      if (props.language !== 'ja') props.onToggleLanguage()
                    }}
                    className={cn(
                      'flex-1 px-3 py-2 rounded-md text-sm font-medium border transition-colors',
                      props.language === 'ja'
                        ? 'border-primary bg-primary/10 text-foreground'
                        : 'border-border text-muted-foreground hover:bg-accent'
                    )}
                  >
                    {t('settings.japanese')}
                  </button>
                </div>
              </div>

              {/* Theme */}
              <div className="space-y-2">
                <Label>{t('settings.theme')}</Label>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      if (props.theme !== 'dark') props.onToggleTheme()
                    }}
                    className={cn(
                      'flex-1 px-3 py-2 rounded-md text-sm font-medium border transition-colors',
                      props.theme === 'dark'
                        ? 'border-primary bg-primary/10 text-foreground'
                        : 'border-border text-muted-foreground hover:bg-accent'
                    )}
                  >
                    {t('settings.dark')}
                  </button>
                  <button
                    onClick={() => {
                      if (props.theme !== 'light') props.onToggleTheme()
                    }}
                    className={cn(
                      'flex-1 px-3 py-2 rounded-md text-sm font-medium border transition-colors',
                      props.theme === 'light'
                        ? 'border-primary bg-primary/10 text-foreground'
                        : 'border-border text-muted-foreground hover:bg-accent'
                    )}
                  >
                    {t('settings.light')}
                  </button>
                </div>
              </div>

              {/* CCES divider */}
              <div className="relative py-1">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-border" />
                </div>
                <div className="relative flex justify-center">
                  <span className="bg-card px-3 text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                    <Clipboard size={12} />
                    {t('settings.cces.title')}
                  </span>
                </div>
              </div>

              {/* CCES opening text */}
              <div className="space-y-2">
                <Label>{t('settings.cces.openingLabel')}</Label>
                <textarea
                  rows={3}
                  value={ccesOpening}
                  placeholder={t('settings.cces.openingDefault')}
                  onChange={(e) => setCcesOpening(e.target.value)}
                  onBlur={() => void persistCces({ openingText: ccesOpening })}
                  className="w-full rounded-md border border-border bg-background text-foreground p-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full gap-2 text-muted-foreground"
                  onClick={resetCcesOpeningToDefault}
                >
                  <RefreshCcw size={14} />
                  {t('settings.cces.openingReset')}
                </Button>
              </div>

              {/* 040: 裏CC定石（BG headless CC）divider */}
              <div className="relative py-1">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-border" />
                </div>
                <div className="relative flex justify-center">
                  <span className="bg-card px-3 text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                    <Terminal size={12} />
                    {t('settings.backstageCc.title')}
                  </span>
                </div>
              </div>

              {/* 040: 可視性チェックボックス + モデル一覧手動更新 */}
              <div className="space-y-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox
                    checked={backstageHidden}
                    onCheckedChange={(v) => void handleToggleBackstageHidden(v === true)}
                  />
                  <span className="text-sm">{t('settings.backstageCc.hiddenCheckbox')}</span>
                </label>
                {/* FB02 F8: 意味論の明示 + コスト透明性はツールチップで（確認ダイアログは D3 で不採用）。
                    既知の制約: disabled（実行中）はポインタイベントが出ずツールチップ不発 — spinner が代替表示 */}
                <TooltipProvider delayDuration={150}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full gap-2"
                        disabled={refreshingCatalog}
                        onClick={() => void handleRefreshModelCatalog()}
                      >
                        <RefreshCcw
                          size={14}
                          className={refreshingCatalog ? 'animate-spin' : undefined}
                        />
                        {t('settings.backstageCc.refreshButton')}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="z-[80] max-w-xs">
                      <p>{t('settings.backstageCc.refreshTooltipKeep')}</p>
                      <p>{t('settings.backstageCc.refreshTooltipCost')}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                {catalogFetchedAt && (
                  <p className="text-[11px] text-muted-foreground/70">
                    {t('settings.backstageCc.lastFetched', {
                      date: formatCatalogTimestamp(catalogFetchedAt)
                    })}
                  </p>
                )}
              </div>

              {/* Maintenance divider */}
              <div className="relative py-1">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-border" />
                </div>
                <div className="relative flex justify-center">
                  <span className="bg-card px-3 text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                    <Wrench size={12} />
                    {t('settings.maintenance')}
                  </span>
                </div>
              </div>

              {/* Open Maintenance button */}
              <Button variant="outline" className="w-full gap-2" onClick={handleOpenMaintenance}>
                <Wrench size={16} />
                {t('settings.openMaintenance')}
              </Button>

              {/* About button */}
              <Button
                variant="ghost"
                className="w-full gap-2 text-muted-foreground"
                onClick={() => {
                  setOpen(false)
                  setAboutOpen(true)
                }}
              >
                <Info size={16} />
                {t('about.title')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
