import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PencilLine, Settings } from 'lucide-react'
import { cn } from '../lib/utils'

interface HistoryMarker {
  protocol: string
  revision: string
  stage: string
  variant: string | null
  variant_alias: string | null
}

interface HistoryEntry {
  timestamp: string
  source: 'auto' | 'manual'
  app_version: string
  marker: HistoryMarker
}

interface ProtocolHistoryListProps {
  projectPath: string | null
}

/**
 * 034-B (UX 課題 1): EditMarkerDialog 内に表示する履歴セクション。
 * append-only history を時系列降順で表示し、auto/manual を視覚的に区別する。
 *
 * 表示しないフィールド:
 *   - detection_evidence, applied_by, applied_at, stage_inferred, detection_confidence
 *   - 主要フィールド (protocol/revision/stage/variant) + source + timestamp のみ表示
 *   - 過剰回避（NR-24）
 */
export function ProtocolHistoryList({
  projectPath,
}: ProtocolHistoryListProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!projectPath) {
      setEntries([])
      return
    }
    let cancelled = false
    void (async (): Promise<void> => {
      setLoading(true)
      try {
        const result = (await window.api.protocolReadHistory(
          projectPath
        )) as HistoryEntry[] | null
        if (!cancelled) setEntries(result || [])
      } catch {
        if (!cancelled) setEntries([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return (): void => {
      cancelled = true
    }
  }, [projectPath])

  if (!projectPath) return null

  return (
    <div className="border-t border-border pt-3 mt-2">
      <div className="text-xs font-semibold mb-2">
        {t('editMarker.history.title')} ({entries.length})
      </div>
      {loading && <div className="text-xs text-muted-foreground">...</div>}
      {!loading && entries.length === 0 && (
        <div className="text-xs text-muted-foreground">{t('editMarker.history.empty')}</div>
      )}
      {!loading && entries.length > 0 && (
        <div className="max-h-48 overflow-y-auto space-y-1 pr-1">
          {[...entries].reverse().map((e, i) => (
            <div
              key={`${e.timestamp}-${i}`}
              className={cn(
                'text-xs flex items-start gap-2 py-1 px-2 rounded',
                e.source === 'manual'
                  ? 'bg-muted/40 font-medium'
                  : 'bg-transparent text-muted-foreground'
              )}
            >
              {e.source === 'manual' ? (
                <PencilLine size={12} className="mt-0.5 shrink-0" />
              ) : (
                <Settings size={12} className="mt-0.5 shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <div className="font-mono">
                  {e.marker.protocol} {e.marker.revision} {e.marker.stage}
                  {e.marker.variant_alias
                    ? ` [${e.marker.variant_alias}]`
                    : e.marker.variant
                    ? ` (${e.marker.variant})`
                    : ''}
                </div>
                <div className="text-[10px] opacity-70">
                  {new Date(e.timestamp).toLocaleString()} ·{' '}
                  {e.source === 'manual'
                    ? t('editMarker.history.sourceManual')
                    : t('editMarker.history.sourceAuto')}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
