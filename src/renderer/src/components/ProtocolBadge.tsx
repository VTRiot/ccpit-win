import { useTranslation } from 'react-i18next'
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from './ui/tooltip'
import { cn } from '../lib/utils'
import { formatBadgeView, type ProtocolMarkerView } from '../lib/protocolBadge'

export type { ProtocolMarkerView }

interface ProtocolBadgeProps {
  marker: ProtocolMarkerView | null | undefined
  loading?: boolean
}

export function ProtocolBadge({ marker, loading }: ProtocolBadgeProps): React.JSX.Element | null {
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

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              'inline-flex items-center rounded-full border px-2 py-0.5 text-xs cursor-help',
              view.className,
              view.isInferred && 'opacity-70'
            )}
          >
            {view.text}
          </span>
        </TooltipTrigger>
        <TooltipContent>{detail}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
