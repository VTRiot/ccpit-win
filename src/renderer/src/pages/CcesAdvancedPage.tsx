import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Label } from '../components/ui/label'
import { cn } from '../lib/utils'
import { CCES_CONFIG_CHANGED_EVENT } from '../lib/ccesEnabled'

/**
 * 037 Phase 2-B: CCES Advanced タブ。
 *
 * MaintenanceDialog 内で「奥深く」配置されるスイッチ。
 * 切替時に CustomEvent (CCES_CONFIG_CHANGED_EVENT) を dispatch して、
 * ProjectsPage の CCES Generate ボタン挙動を即時反映させる。
 */
export function CcesAdvancedPage(): React.JSX.Element {
  const { t } = useTranslation()
  const [allowAll, setAllowAll] = useState<boolean>(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const cfg = await window.api.configGet()
        if (!cancelled) setAllowAll(cfg.cces?.allowAllProjects ?? false)
      } catch {
        /* ignore */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const persist = async (next: boolean): Promise<void> => {
    setAllowAll(next)
    try {
      const cfg = await window.api.configGet()
      const merged = { ...(cfg.cces ?? {}), allowAllProjects: next }
      await window.api.configSet({ cces: merged })
      window.dispatchEvent(new CustomEvent(CCES_CONFIG_CHANGED_EVENT))
    } catch {
      /* keep optimistic value */
    }
  }

  return (
    <div className="space-y-4 max-w-xl">
      <h2 className="text-lg font-semibold">{t('settings.ccesAdvanced.title')}</h2>
      <div className="space-y-2">
        <Label>{t('settings.ccesAdvanced.allowAllProjectsLabel')}</Label>
        <div className="flex gap-2">
          <button
            onClick={() => void persist(true)}
            className={cn(
              'flex-1 px-3 py-2 rounded-md text-sm font-medium border transition-colors',
              allowAll
                ? 'border-primary bg-primary/10 text-foreground'
                : 'border-border text-muted-foreground hover:bg-accent',
            )}
          >
            {t('settings.ccesAdvanced.allowAllOn')}
          </button>
          <button
            onClick={() => void persist(false)}
            className={cn(
              'flex-1 px-3 py-2 rounded-md text-sm font-medium border transition-colors',
              !allowAll
                ? 'border-primary bg-primary/10 text-foreground'
                : 'border-border text-muted-foreground hover:bg-accent',
            )}
          >
            {t('settings.ccesAdvanced.allowAllOff')}
          </button>
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-line">
          {t('settings.ccesAdvanced.allowAllProjectsHelp')}
        </p>
      </div>
    </div>
  )
}
