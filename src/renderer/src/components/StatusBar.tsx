import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Terminal } from 'lucide-react'
import type { HealthStatus } from '../App'
import { useBgccActivity, openBgccPanel } from '../hooks/useBgccActivity'
import { indicatorStatus, formatBadge, type BgccIndicatorStatus } from '../lib/bgccActivity'

interface StatusBarProps {
  healthStatus: HealthStatus
}

// FB02 F5: BG-CC インジケータの状態ドット色。idle も薄く常時表示する（発見可能性 =
// 「静かな起動時更新もここを見れば分かる」）。running のみ点滅。
function bgccDotClass(status: BgccIndicatorStatus): string {
  switch (status) {
    case 'running':
      return 'bg-amber-400 animate-pulse'
    case 'succeeded':
      return 'bg-green-500'
    case 'failed':
      return 'bg-red-500'
    default:
      return 'bg-muted-foreground/40'
  }
}

export function StatusBar({ healthStatus }: StatusBarProps): React.JSX.Element {
  const { t } = useTranslation()
  const [version, setVersion] = useState('')
  const { runs, unseen } = useBgccActivity()
  const bgccStatus = indicatorStatus(runs)
  const badge = formatBadge(unseen)

  useEffect(() => {
    window.api.getAppVersion().then(setVersion)
  }, [])

  const goldenText = !healthStatus.configured
    ? t('statusbar.notConfigured')
    : healthStatus.issues > 0
      ? t('statusbar.goldenIssues', { count: healthStatus.issues })
      : t('statusbar.golden')

  return (
    <footer className="h-7 bg-statusbar border-t border-border flex items-center px-4 text-xs text-statusbar-foreground gap-6">
      <span>{goldenText}</span>
      <span>{t('statusbar.projects', { count: healthStatus.projectCount })}</span>
      <span>{version ? `v${version}` : ''}</span>
      {/* FB02 F5: BG-CC アクティビティインジケータ（クリックでパネル。ラベルは ja/en 共通の
          固定短文字列 = ステータスバーはみ出し対策。状態語はパネル側でローカライズ表示） */}
      <button
        onClick={openBgccPanel}
        title={t('bgcc.indicator.title')}
        className="ml-auto flex items-center gap-1.5 hover:text-foreground transition-colors"
      >
        <Terminal size={12} />
        <span>BG-CC</span>
        <span className={`h-2 w-2 rounded-full ${bgccDotClass(bgccStatus)}`} />
        {badge && (
          <span className="rounded-full bg-primary text-primary-foreground text-[10px] leading-none px-1.5 py-0.5">
            {badge}
          </span>
        )}
      </button>
    </footer>
  )
}
