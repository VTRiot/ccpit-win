import { useTranslation } from 'react-i18next'
import { PencilLine } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from './ui/tooltip'
import { cn } from '../lib/utils'
import {
  formatBadgeView,
  localizeBadgeText,
  type ProtocolMarkerView,
} from '../lib/protocolBadge'

export type { ProtocolMarkerView }

interface ProtocolBadgeProps {
  marker: ProtocolMarkerView | null | undefined
  loading?: boolean
  // 034-B (UX 課題 3): 「手動編集済み」識別マーカー。
  // hasManualEntry=true ならバッジ右に PencilLine アイコンを表示。
  hasManualEntry?: boolean
  lastManualAt?: string | null
  historyCount?: number
}

export function ProtocolBadge({
  marker,
  loading,
  hasManualEntry,
  lastManualAt,
  historyCount,
}: ProtocolBadgeProps): React.JSX.Element | null {
  const { t } = useTranslation()

  if (loading) {
    return (
      <span className="inline-flex animate-pulse items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground">
        ...
      </span>
    )
  }

  if (marker === undefined || marker === null) {
    return null
  }

  const view = formatBadgeView(marker)
  if (!view) return null

  const detail = (
    <div className="space-y-1 text-xs max-w-xs">
      {view.isInferred && (
        <div className="font-semibold text-amber-400">
          {t('pages.projects.protocolBadge.inferredNotice')}
        </div>
      )}
      <div>
        <span className="text-muted-foreground">protocol: </span>
        {marker.protocol}
      </div>
      <div>
        <span className="text-muted-foreground">revision: </span>
        {marker.revision}
      </div>
      <div>
        <span className="text-muted-foreground">stage: </span>
        {marker.stage}
        {view.isInferred && ` (${t('pages.projects.protocolBadge.inferred')})`}
      </div>
      {marker.variant && (
        <div>
          <span className="text-muted-foreground">variant: </span>
          {marker.variant}
          {marker.variant_alias && ` [${marker.variant_alias}]`}
        </div>
      )}
      <div>
        <span className="text-muted-foreground">confidence: </span>
        {marker.detection_confidence}
      </div>
      {marker.detection_evidence && (
        <div className="break-words">
          <span className="text-muted-foreground">evidence: </span>
          {marker.detection_evidence}
        </div>
      )}
      {marker.applied_at && (
        <div>
          <span className="text-muted-foreground">applied_at: </span>
          {marker.applied_at}
        </div>
      )}
      <div>
        <span className="text-muted-foreground">applied_by: </span>
        {marker.applied_by}
      </div>
    </div>
  )

  // 034-B: 履歴情報を Tooltip に追加表示
  const detailWithHistory =
    hasManualEntry !== undefined ? (
      <div className="space-y-1 text-xs max-w-xs">
        {detail}
        <div className="border-t border-border/50 pt-1 mt-1">
          <span className="text-muted-foreground">history: </span>
          {historyCount ?? 0} {t('pages.projects.protocolBadge.historyEntries')}
          {hasManualEntry && lastManualAt && (
            <>
              {', '}
              <span className="text-muted-foreground">last manual: </span>
              {new Date(lastManualAt).toLocaleString()}
            </>
          )}
        </div>
      </div>
    ) : (
      detail
    )

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center gap-1">
            <span
              className={cn(
                'inline-flex items-center rounded-full border px-2 py-0.5 text-xs cursor-help',
                view.className
              )}
            >
              {localizeBadgeText(view.text, t)}
            </span>
            {hasManualEntry === true && (
              <PencilLine
                size={12}
                className="text-muted-foreground shrink-0"
                aria-label={t('pages.projects.protocolBadge.manualEdited')}
              />
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent>{detailWithHistory}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
