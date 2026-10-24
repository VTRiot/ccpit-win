import { BookOpen, FolderOpen, Sparkles, ShieldAlert, Gauge, GitCompare, Award } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../lib/utils'
import { SettingsDialogTrigger } from './SettingsDialog'
import { useFeatureFlag } from '../hooks/useFeatureFlag'
import type { PageId } from '../App'

interface SidebarProps {
  activePage: PageId
  onNavigate: (page: PageId) => void
  theme: 'dark' | 'light'
  onToggleTheme: () => void
  language: 'en' | 'ja'
  onToggleLanguage: () => void
  showSetupNav: boolean
  onToggleShowSetupNav: (next: boolean) => Promise<void>
  onResetSetup: () => Promise<void>
  debugMode?: boolean
}

const ALL_NAV_ITEMS: { id: PageId; labelKey: string; icon: React.ElementType }[] = [
  { id: 'setup', labelKey: 'sidebar.setup', icon: BookOpen },
  { id: 'projects', labelKey: 'sidebar.projects', icon: FolderOpen },
  { id: 'adoption', labelKey: 'settings.skillAdoption', icon: Sparkles },
  // 開発版・開発者モードでのみ表示される Golden 昇格ブラウザ（スキル提案ブラウザの直下に配置）
  { id: 'goldenPromotion', labelKey: 'settings.goldenPromotion', icon: Award },
  { id: 'skillLifecycle', labelKey: 'settings.skillLifecycle', icon: GitCompare },
  { id: 'enforcementStats', labelKey: 'settings.enforcementStats', icon: ShieldAlert },
  // 発火統計の直下に配置（オーナー指定）。pxpipe 未導入ユーザーには出さないため
  // pxpipeToggle が OFF の間は下の filter で除外する（既定 OFF ＝ 配布時は非表示）。
  { id: 'pxpipeDashboard', labelKey: 'settings.pxpipeDashboard', icon: Gauge },
]

export function Sidebar({ activePage, onNavigate, theme, onToggleTheme, language, onToggleLanguage, showSetupNav, onToggleShowSetupNav, onResetSetup, debugMode = false }: SidebarProps): React.JSX.Element {
  const { t } = useTranslation()
  // pxpipe 導入環境のみ PXP ダッシュボードを出す（既定 OFF の opt-in。Plug トグルと同じ判定）
  const pxpipeEnabled = useFeatureFlag('pxpipeToggle')
  // Setup ナビ表示判定: 絶対スイッチ。defaults true (新規) / handleSetupCompleted で false 自動切替 / resetSetup で true 自動切替
  // Golden 昇格ブラウザ: 開発者モード（debugMode=true）のときのみ表示（§2-1, §2-6, §5 条件 2 準拠）
  const NAV_ITEMS = ALL_NAV_ITEMS.filter(
    (it) =>
      (showSetupNav || it.id !== 'setup') &&
      (pxpipeEnabled || it.id !== 'pxpipeDashboard') &&
      (debugMode || it.id !== 'goldenPromotion')
  )

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
              'flex items-center gap-3 px-3 py-2 text-sm text-left break-keep rounded-md transition-colors',
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
          showSetupNav={showSetupNav}
          onToggleShowSetupNav={onToggleShowSetupNav}
          onResetSetup={onResetSetup}
        />
      </div>
    </nav>
  )
}
