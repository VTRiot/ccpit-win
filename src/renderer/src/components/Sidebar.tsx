import { BookOpen, FolderOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../lib/utils'
import { SettingsDialogTrigger } from './SettingsDialog'
import type { PageId } from '../App'

interface SidebarProps {
  activePage: PageId
  onNavigate: (page: PageId) => void
  theme: 'dark' | 'light'
  onToggleTheme: () => void
  language: 'en' | 'ja'
  onToggleLanguage: () => void
  setupCompleted: boolean
  onResetSetup: () => Promise<void>
}

const ALL_NAV_ITEMS: { id: PageId; labelKey: string; icon: React.ElementType }[] = [
  { id: 'setup', labelKey: 'sidebar.setup', icon: BookOpen },
  { id: 'projects', labelKey: 'sidebar.projects', icon: FolderOpen },
]

export function Sidebar({ activePage, onNavigate, theme, onToggleTheme, language, onToggleLanguage, setupCompleted, onResetSetup }: SidebarProps): React.JSX.Element {
  const { t } = useTranslation()
  const NAV_ITEMS = setupCompleted
    ? ALL_NAV_ITEMS.filter((it) => it.id !== 'setup')
    : ALL_NAV_ITEMS

  return (
    <nav className="w-52 bg-sidebar border-r border-sidebar-border flex flex-col py-3">
      <div className="px-4 py-2 mb-2">
        <span className="text-sm font-bold text-foreground tracking-tight">{t('app.title')}</span>
      </div>
      <div className="flex flex-col gap-0.5 px-2">
        {NAV_ITEMS.map(({ id, labelKey, icon: Icon }) => (
          <button
            key={id}
            onClick={() => onNavigate(id)}
            className={cn(
              'flex items-center gap-3 px-3 py-2 text-sm rounded-md transition-colors',
              activePage === id
                ? 'bg-sidebar-active text-foreground font-medium'
                : 'text-muted-foreground hover:bg-sidebar-hover hover:text-foreground'
            )}
          >
            <Icon size={18} />
            {t(labelKey)}
          </button>
        ))}
      </div>
      <div className="mt-auto px-2">
        <SettingsDialogTrigger
          theme={theme}
          onToggleTheme={onToggleTheme}
          language={language}
          onToggleLanguage={onToggleLanguage}
          onResetSetup={onResetSetup}
        />
      </div>
    </nav>
  )
}
