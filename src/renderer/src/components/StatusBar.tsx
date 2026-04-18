import { useTranslation } from 'react-i18next'
import type { HealthStatus } from '../App'

interface StatusBarProps {
  healthStatus: HealthStatus
}

export function StatusBar({ healthStatus }: StatusBarProps): React.JSX.Element {
  const { t } = useTranslation()

  const goldenText = !healthStatus.configured
    ? t('statusbar.notConfigured')
    : healthStatus.issues > 0
      ? t('statusbar.goldenIssues', { count: healthStatus.issues })
      : t('statusbar.golden')

  return (
    <footer className="h-7 bg-statusbar border-t border-border flex items-center px-4 text-xs text-statusbar-foreground gap-6">
      <span>{goldenText}</span>
      <span>{t('statusbar.projects', { count: healthStatus.projectCount })}</span>
      <span>v0.1.0</span>
    </footer>
  )
}
