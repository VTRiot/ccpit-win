import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Settings, Wrench, Info, RotateCcw } from 'lucide-react'
import { Button } from './ui/button'
import { Label } from './ui/label'
import { cn } from '../lib/utils'
import { MaintenanceDialog } from './MaintenanceDialog'
import { AboutDialog } from './AboutDialog'

interface SettingsDialogProps {
  theme: 'dark' | 'light'
  onToggleTheme: () => void
  language: 'en' | 'ja'
  onToggleLanguage: () => void
  onResetSetup: () => Promise<void>
}

export function SettingsDialogTrigger(props: SettingsDialogProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [maintenanceOpen, setMaintenanceOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const { t } = useTranslation()

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

      <MaintenanceDialog open={maintenanceOpen} onClose={() => setMaintenanceOpen(false)} />
      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />

          <div className="relative bg-card border border-border rounded-lg shadow-lg w-full max-w-sm mx-4 flex flex-col">
            <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
              <h2 className="text-base font-semibold">{t('settings.title')}</h2>
              <Button variant="ghost" size="icon" onClick={() => setOpen(false)} className="h-8 w-8">
                <X size={16} />
              </Button>
            </div>

            <div className="p-4 space-y-5">
              {/* Language */}
              <div className="space-y-2">
                <Label>{t('settings.language')}</Label>
                <div className="flex gap-2">
                  <button
                    onClick={() => { if (props.language !== 'en') props.onToggleLanguage() }}
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
                    onClick={() => { if (props.language !== 'ja') props.onToggleLanguage() }}
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
                    onClick={() => { if (props.theme !== 'dark') props.onToggleTheme() }}
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
                    onClick={() => { if (props.theme !== 'light') props.onToggleTheme() }}
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

              {/* Re-run setup */}
              <Button
                variant="ghost"
                className="w-full gap-2 text-muted-foreground"
                onClick={async () => { setOpen(false); await props.onResetSetup() }}
              >
                <RotateCcw size={16} />
                {t('settings.resetSetup')}
              </Button>

              {/* About button */}
              <Button variant="ghost" className="w-full gap-2 text-muted-foreground" onClick={() => { setOpen(false); setAboutOpen(true) }}>
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
