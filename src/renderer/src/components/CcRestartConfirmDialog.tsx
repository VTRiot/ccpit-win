import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from './ui/dialog'
import { Button } from './ui/button'

/** preload の CcDetectedCcDto と同形（renderer は preload 型を参照）。procEnum(CIM) 検出の 1 件。 */
interface DetectedCc {
  pid: number
  resolution: 'resolved' | 'resume-only' | 'unresolved'
  sessionId?: string
  cwd?: string
  status?: 'busy' | 'waiting' | 'idle' | 'unknown'
  name?: string
  waitingFor?: string
  createdAt?: string | null
}

/** preload の CcDetectSummaryDto と同形。procEnum(CIM) 列挙の集計（fail-closed: resume-only / unresolved も含む）。 */
interface CcDetectSummary {
  total: number
  resolved: number
  resumeOnly: number
  unresolved: number
  sessions: DetectedCc[]
}

interface CcRestartConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  summary: CcDetectSummary | null
  onConfirm: () => void | Promise<void>
}

/** resolution 別バッジ色（resolved=緑 / resume-only=琥珀 / unresolved=赤＝fail-closed 警告色）。 */
function resolutionBadgeClass(resolution: DetectedCc['resolution']): string {
  switch (resolution) {
    case 'resolved':
      return 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
    case 'resume-only':
      return 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
    default:
      return 'bg-rose-500/15 text-rose-600 dark:text-rose-400'
  }
}

/** cwd を末尾 2 セグメントに短縮（プレビュー用） */
function shortCwd(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean)
  return parts.length <= 2 ? cwd : '…' + parts.slice(-2).join('/')
}

/**
 * Bulk CC restart: 全 CC 再起動の確認ダイアログ。
 * procEnum(CIM) 列挙の summary をプレビューしてから明示確認を求める。直接 kill はせず、
 * 確認後に generation を +1 bump し、各 CC が次の Stop（安全な完了点）で自己 resume する（DELEGATE 主軸）。
 * resume-only / unresolved（fail-closed で取りこぼさず可視化）も件数と一覧で表示する。
 */
export function CcRestartConfirmDialog({
  open,
  onOpenChange,
  summary,
  onConfirm,
}: CcRestartConfirmDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const sessions = summary?.sessions ?? []
  const total = summary?.total ?? sessions.length
  const resolutionLabel = (r: DetectedCc['resolution']): string =>
    r === 'resolved'
      ? t('pages.projects.ccRestart.resResolved')
      : r === 'resume-only'
        ? t('pages.projects.ccRestart.resResumeOnly')
        : t('pages.projects.ccRestart.resUnresolved')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('pages.projects.ccRestart.dialogTitle')}</DialogTitle>
          <DialogDescription className="whitespace-pre-line">
            {t('pages.projects.ccRestart.dialogBody', { count: total })}
          </DialogDescription>
        </DialogHeader>

        {summary && (
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{t('pages.projects.ccRestart.countTotal', { n: summary.total })}</span>
            <span>{t('pages.projects.ccRestart.countResolved', { n: summary.resolved })}</span>
            <span>{t('pages.projects.ccRestart.countResumeOnly', { n: summary.resumeOnly })}</span>
            <span>{t('pages.projects.ccRestart.countUnresolved', { n: summary.unresolved })}</span>
          </div>
        )}

        <div className="max-h-64 overflow-y-auto space-y-1.5 text-sm">
          {sessions.length === 0 && (
            <p className="text-muted-foreground py-2">{t('pages.projects.ccRestart.empty')}</p>
          )}
          {sessions.map((s) => (
            <div
              key={s.sessionId ?? String(s.pid)}
              className="flex items-center justify-between gap-2 rounded border px-2 py-1.5"
            >
              <div className="min-w-0">
                <div className="truncate font-medium">
                  {s.name ?? s.sessionId?.slice(0, 8) ?? `PID ${s.pid}`}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {s.cwd ? shortCwd(s.cwd) : t('pages.projects.ccRestart.noCwd', { pid: s.pid })}
                </div>
              </div>
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${resolutionBadgeClass(s.resolution)}`}
              >
                {resolutionLabel(s.resolution)}
              </span>
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('pages.projects.ccRestart.cancel')}
          </Button>
          <Button
            disabled={total === 0}
            onClick={() => {
              void onConfirm()
            }}
          >
            {t('pages.projects.ccRestart.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
