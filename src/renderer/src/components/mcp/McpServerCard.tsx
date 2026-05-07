import { useTranslation } from 'react-i18next'
import { Pencil, Trash2 } from 'lucide-react'
import { Button } from '../ui/button'
import { Card, CardContent } from '../ui/card'
import { classifyRiskView, type RiskTier } from '../../lib/mcp/writeKeywordsView'

interface McpServerCardProps {
  server: {
    name: string
    command?: string
    args?: string[]
    env?: Record<string, string>
    type?: 'stdio' | 'sse' | 'http'
    url?: string
    headers?: Record<string, string>
    disabledTools?: string[]
  }
  onEdit: () => void
  onRemove: () => void
  disabled?: boolean
}

const RISK_STYLE: Record<RiskTier, string> = {
  safe: 'bg-green-500/15 text-green-700 dark:text-green-400 border-green-500/30',
  caution: 'bg-yellow-500/15 text-yellow-700 dark:text-yellow-400 border-yellow-500/30',
  strict: 'bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30'
}

export function McpServerCard({
  server,
  onEdit,
  onRemove,
  disabled
}: McpServerCardProps): React.JSX.Element {
  const { t } = useTranslation()
  const risk = classifyRiskView(server)
  const envCount = Object.keys(server.env ?? {}).length
  const disabledCount = (server.disabledTools ?? []).length

  const commandSummary = server.url
    ? server.url
    : `${server.command ?? ''} ${(server.args ?? []).join(' ')}`.trim()

  return (
    <Card>
      <CardContent className="py-3 flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-medium truncate">{server.name}</span>
            <span
              className={`px-2 py-0.5 text-xs rounded border ${RISK_STYLE[risk]}`}
              title={t(`pages.mcp.risk.${risk}.tooltip`)}
            >
              {t(`pages.mcp.risk.${risk}.label`)}
            </span>
            {server.type && server.type !== 'stdio' && (
              <span className="text-xs px-1.5 py-0.5 rounded border border-border text-muted-foreground">
                {server.type}
              </span>
            )}
          </div>
          <div className="text-xs text-muted-foreground font-mono truncate mt-1" title={commandSummary}>
            {commandSummary || '—'}
          </div>
          <div className="text-xs text-muted-foreground mt-1 flex gap-3 flex-wrap">
            {envCount > 0 && (
              <span>
                {t('pages.mcp.envCount', { count: envCount })}
              </span>
            )}
            {disabledCount > 0 && (
              <span>
                {t('pages.mcp.disabledToolsCount', { count: disabledCount })}
              </span>
            )}
          </div>
        </div>
        <div className="flex gap-1 shrink-0">
          <Button onClick={onEdit} disabled={disabled} size="sm" variant="outline">
            <Pencil size={14} />
            <span className="ml-1">{t('common.edit')}</span>
          </Button>
          <Button onClick={onRemove} disabled={disabled} size="sm" variant="outline">
            <Trash2 size={14} />
            <span className="ml-1">{t('common.delete')}</span>
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
