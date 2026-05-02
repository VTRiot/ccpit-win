import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { X, HeartPulse, Shield, Stethoscope, Wrench, Inbox } from 'lucide-react'
import { Button } from './ui/button'
import { cn } from '../lib/utils'
import { HealthPage } from '../pages/HealthPage'
import { RKPage } from '../pages/RKPage'
import { DAPage } from '../pages/DAPage'
import { DebugPage } from '../pages/DebugPage'
import { CCRequestInboxPage } from '../pages/CCRequestInboxPage'

type Tab = 'health' | 'rk' | 'da' | 'inbox' | 'devTools'

interface MaintenanceDialogProps {
  open: boolean
  onClose: () => void
}

export function MaintenanceDialog({
  open,
  onClose
}: MaintenanceDialogProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<Tab>('health')
  const [debugMode, setDebugMode] = useState(false)

  useEffect(() => {
    window.api.configGet().then((config) => setDebugMode(config.debugMode))
  }, [open])

  if (!open) return null

  const tabs: { id: Tab; labelKey: string; icon: React.ElementType; label?: string }[] = [
    { id: 'health', labelKey: 'pages.health.title', icon: HeartPulse },
    { id: 'rk', labelKey: 'settings.recoveryKit', icon: Shield },
    { id: 'da', labelKey: 'settings.doctorAnalysis', icon: Stethoscope },
    { id: 'inbox', labelKey: 'settings.requestInbox', icon: Inbox },
    ...(debugMode
      ? [{ id: 'devTools' as Tab, labelKey: 'settings.devTools.title', icon: Wrench }]
      : [])
  ]

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      <div
        className="relative bg-background border border-border rounded-lg shadow-xl flex flex-col"
        style={{ width: 'calc(100vw - 80px)', height: 'calc(100vh - 80px)' }}
      >
        {/* Header with tabs */}
        <div className="flex items-center border-b border-border shrink-0">
          <div className="flex">
            {tabs.map(({ id, labelKey, icon: Icon, label }) => (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className={cn(
                  'flex items-center gap-2 px-5 py-3 text-sm font-medium border-b-2 transition-colors',
                  activeTab === id
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                )}
              >
                <Icon size={16} />
                {label ?? t(labelKey)}
              </button>
            ))}
          </div>
          <div className="ml-auto pr-3">
            <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8">
              <X size={16} />
            </Button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-6">
          {activeTab === 'health' && <HealthPage />}
          {activeTab === 'rk' && <RKPage />}
          {activeTab === 'da' && <DAPage />}
          {activeTab === 'inbox' && <CCRequestInboxPage />}
          {activeTab === 'devTools' && debugMode && <DebugPage />}
        </div>
      </div>
    </div>
  )
}
