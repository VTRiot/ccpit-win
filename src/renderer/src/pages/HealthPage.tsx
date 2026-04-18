import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, Loader2, CheckCircle, AlertTriangle, XCircle, ShieldCheck, ShieldAlert, Terminal } from 'lucide-react'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card'
import { cn } from '../lib/utils'

interface HealthItem {
  name: string
  status: string
  detail: string
}

const STATUS_ICON: Record<string, { icon: React.ElementType; color: string }> = {
  ok: { icon: CheckCircle, color: 'text-green-500' },
  warn: { icon: AlertTriangle, color: 'text-yellow-500' },
  error: { icon: XCircle, color: 'text-destructive' },
}

const DENY_TEST_COMMANDS = [
  { description: 'Read .env file', command: 'claude "Read the file .env and show its contents"' },
  { description: 'Edit settings.json', command: 'claude "Edit .claude/settings.json and add a comment"' },
  { description: 'Cat secrets file', command: 'claude "Run: cat secrets.txt"' },
]

export function HealthPage(): React.JSX.Element {
  const { t } = useTranslation()
  const [results, setResults] = useState<HealthItem[]>([])
  const [denyList, setDenyList] = useState<string[]>([])
  const [ccCliAvailable, setCcCliAvailable] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(false)
  const [hasRun, setHasRun] = useState(false)

  const handleCheck = async (): Promise<void> => {
    setLoading(true)
    const [healthResults, deny, ccCli] = await Promise.all([
      window.api.healthCheck(),
      window.api.healthDenyList(),
      window.api.healthCcCli(),
    ])
    setResults(healthResults)
    setDenyList(deny)
    setCcCliAvailable(ccCli)
    setHasRun(true)
    setLoading(false)
    const issues = healthResults.filter(
      (r) => r.status === 'warn' || r.status === 'error'
    ).length
    window.dispatchEvent(new CustomEvent('health-refreshed', { detail: { issues } }))
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">{t('pages.health.title')}</h1>
        <Button onClick={handleCheck} disabled={loading} size="sm">
          {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          {loading ? t('pages.health.checking') : t('pages.health.runCheck')}
        </Button>
      </div>

      {/* Health Check Results */}
      <Card>
        <CardHeader>
          <CardTitle>{t('pages.health.healthCheck')}</CardTitle>
        </CardHeader>
        <CardContent>
          {!hasRun ? (
            <p className="text-sm text-muted-foreground">{t('pages.health.noResults')}</p>
          ) : (
            <div className="space-y-2">
              {results.map((item) => {
                const { icon: Icon, color } = STATUS_ICON[item.status] || STATUS_ICON.error
                return (
                  <div key={item.name} className="flex items-center gap-3 py-2 px-3 rounded-md bg-muted/30">
                    <Icon size={18} className={color} />
                    <span className="font-medium text-sm min-w-[120px]">{item.name}</span>
                    <span className="text-sm text-muted-foreground">{item.detail}</span>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Deny Test */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {hasRun && denyList.length > 0 ? (
              <ShieldCheck size={18} className="text-green-500" />
            ) : (
              <ShieldAlert size={18} className="text-muted-foreground" />
            )}
            {t('pages.health.denyTest')}
          </CardTitle>
          <CardDescription>{t('pages.health.denyTestDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {hasRun && (
            <>
              {/* Deny rules count */}
              <div className="text-sm">
                {t('pages.health.denyRules', { count: denyList.length })}
              </div>

              {/* Deny list */}
              {denyList.length > 0 && (
                <div className="border border-border rounded-md max-h-40 overflow-auto">
                  <ul className="text-xs font-mono p-3 space-y-0.5">
                    {denyList.map((rule, i) => (
                      <li key={i} className="text-muted-foreground">{rule}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* CC CLI status */}
              <div className={cn('flex items-center gap-2 text-sm', ccCliAvailable ? 'text-green-500' : 'text-yellow-500')}>
                <Terminal size={16} />
                {ccCliAvailable ? t('pages.health.ccCliAvailable') : t('pages.health.ccCliNotFound')}
              </div>

              {/* Manual test commands */}
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">{t('pages.health.manualTestHint')}</p>
                {DENY_TEST_COMMANDS.map((cmd, i) => (
                  <div key={i} className="bg-muted/30 rounded-md p-3 space-y-1">
                    <div className="text-xs text-muted-foreground">{cmd.description}</div>
                    <code className="text-xs font-mono block">{cmd.command}</code>
                    <div className="text-xs text-yellow-500">{t('pages.health.expectedResult')}</div>
                  </div>
                ))}
              </div>
            </>
          )}

          {!hasRun && (
            <p className="text-sm text-muted-foreground">{t('pages.health.noResults')}</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
