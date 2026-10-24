import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, Loader2, CheckCircle, AlertTriangle, XCircle, Info, ShieldCheck, ShieldAlert, Terminal } from 'lucide-react'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card'
import { cn } from '../lib/utils'

interface HealthItem {
  name: string
  status: string
  detail: string
}

/**
 * Golden 追従の未解決一覧（ADR 0002）。
 *
 * ADR 0001 D3 は「後で」を残した根拠に「未追従として記録・**可視化**される」を挙げているが、
 * 実際には `deferred` を表示する画面がどこにも無かった（本件の実測で判明）。
 * 「もう問わない」を足すなら沈黙が増えるので、先にこの穴を塞ぐ。
 */
interface FollowUpItem {
  path: string
  kind: 'deferred' | 'unmanaged' | 'overlay'
  drifted: boolean | null
  lapsed?: boolean
  decidedAt?: string
}

const STATUS_ICON: Record<string, { icon: React.ElementType; color: string }> = {
  ok: { icon: CheckCircle, color: 'text-green-500' },
  warn: { icon: AlertTriangle, color: 'text-yellow-500' },
  error: { icon: XCircle, color: 'text-destructive' },
  info: { icon: Info, color: 'text-blue-500' },
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
  const [followUp, setFollowUp] = useState<FollowUpItem[]>([])
  type UndoGroup = Awaited<ReturnType<typeof window.api.goldenListUndoGenerations>>[number]
  const [undoGenerations, setUndoGenerations] = useState<UndoGroup[]>([])
  const [loading, setLoading] = useState(false)
  const [hasRun, setHasRun] = useState(false)

  const handleCheck = async (): Promise<void> => {
    setLoading(true)
    const [healthResults, deny, ccCli, follow, undos] = await Promise.all([
      window.api.healthCheck(),
      window.api.healthDenyList(),
      window.api.healthCcCli(),
      // 未追従は起動時ではなくここで実測する（列挙された数件だけ・見る人が居るときだけ）。
      window.api.goldenFollowUpState().catch(() => [] as FollowUpItem[]),
      // 戻せる上書き世代の一覧を取得 (AC9, AC12)
      window.api.goldenListUndoGenerations().catch(() => [] as UndoGroup[])
    ])
    setResults(healthResults)
    setDenyList(deny)
    setCcCliAvailable(ccCli)
    setFollowUp(follow)
    setUndoGenerations(undos)
    setHasRun(true)
    setLoading(false)
    const issues = healthResults.filter(
      (r) => r.status === 'warn' || r.status === 'error'
    ).length
    window.dispatchEvent(new CustomEvent('health-refreshed', { detail: { issues } }))
  }

  /** 「もう問わない」を取り消す。次回起動で再提示される（`deferred` へ戻す）。 */
  const handleRemanage = async (path: string): Promise<void> => {
    await window.api.goldenRemanage([path])
    setFollowUp(await window.api.goldenFollowUpState().catch(() => [] as FollowUpItem[]))
  }

  /**
   * 反映（overlay）を破棄する。
   * 失効した反映もユーザーの内容の唯一の控えになりうるので、確認してから消す。
   */
  const handleDiscardOverlay = async (path: string): Promise<void> => {
    if (!window.confirm(t('goldenReconcile.followUp.discardConfirm'))) return
    await window.api.goldenDiscardOverlay([path])
    setFollowUp(await window.api.goldenFollowUpState().catch(() => [] as FollowUpItem[]))
  }

  /**
   * 上書きされたファイルを元に戻し、overlay へ反映・台帳更新する (AC10, AC11)。
   */
  const handleRestoreUndo = async (rel: string, generationStamp: string): Promise<void> => {
    if (!window.confirm(t('goldenReconcile.undo.confirmRestore', { path: rel }))) return
    setLoading(true)
    try {
      await window.api.goldenRestoreUndoBackups([{ rel, generationStamp }])
      await handleCheck()
    } catch (err) {
      console.error('[HealthPage] failed to restore undo', err)
      setLoading(false)
    }
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

      {/* Golden 追従（ADR 0002: 未追従を沈黙させない / ADR 0004: 戻せる上書き） */}
      {hasRun && (
        <Card>
          <CardHeader>
            <CardTitle>{t('goldenReconcile.followUp.title')}</CardTitle>
            <CardDescription>
              {followUp.length === 0 && undoGenerations.length === 0
                ? t('goldenReconcile.followUp.none')
                : t('goldenReconcile.followUp.summary', {
                    n: followUp.filter((f) => f.kind !== 'overlay').length,
                    unmanaged: followUp.filter((f) => f.kind === 'unmanaged').length,
                    overlay: followUp.filter((f) => f.kind === 'overlay').length
                  })}
            </CardDescription>
          </CardHeader>
          {(followUp.length > 0 || undoGenerations.length > 0) && (
            <CardContent className="space-y-6">
              {followUp.length > 0 && (
                <div className="space-y-2">
                  {followUp.map((f) => (
                    <div
                      key={`${f.kind}:${f.path}`}
                      className="flex items-center gap-3 py-2 px-3 rounded-md bg-muted/30"
                    >
                      <span className="font-mono text-xs break-all flex-1">{f.path}</span>
                      <span className="text-xs text-muted-foreground shrink-0">
                        {t(`goldenReconcile.followUp.kind.${f.kind}`)}
                      </span>
                      {f.drifted !== null && (
                        <span
                          className={cn(
                            'text-xs shrink-0',
                            f.drifted ? 'text-yellow-600' : 'text-muted-foreground'
                          )}
                        >
                          {f.drifted
                            ? t('goldenReconcile.followUp.drifted')
                            : t('goldenReconcile.followUp.notDrifted')}
                        </span>
                      )}
                      {f.lapsed && (
                        <span className="text-xs text-yellow-600 shrink-0">
                          {t('goldenReconcile.followUp.lapsed')}
                        </span>
                      )}
                      {f.kind === 'unmanaged' && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={loading}
                          onClick={() => void handleRemanage(f.path)}
                        >
                          {t('goldenReconcile.followUp.remanage')}
                        </Button>
                      )}
                      {f.kind === 'overlay' && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={loading}
                          onClick={() => void handleDiscardOverlay(f.path)}
                        >
                          {t('goldenReconcile.followUp.discard')}
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* 戻せる上書き（アンドゥ導線・AC9, AC12, AC13, AC14） */}
              <div className="pt-4 border-t border-border space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-semibold">{t('goldenReconcile.undo.title')}</h4>
                  <span className="text-xs text-muted-foreground">
                    {t('goldenReconcile.undo.latestOnlyNote')}
                  </span>
                </div>
                {undoGenerations.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t('goldenReconcile.undo.none')}</p>
                ) : (
                  <div className="space-y-3">
                    {undoGenerations.map((g) => (
                      <div
                        key={g.generationStamp}
                        className={cn(
                          'p-3 rounded-md border text-xs space-y-2',
                          g.isLatest
                            ? 'border-primary/40 bg-muted/30'
                            : 'border-border bg-muted/10 opacity-70'
                        )}
                      >
                        <div className="flex items-center justify-between font-medium">
                          <span>
                            {t('goldenReconcile.undo.generationLabel', { stamp: g.generationStamp })}
                          </span>
                          {g.isLatest ? (
                            <span className="text-green-600 font-semibold">
                              {t('goldenReconcile.undo.latestBadge')}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">
                              {t('goldenReconcile.undo.olderBadge')}
                            </span>
                          )}
                        </div>
                        <ul className="space-y-1.5">
                          {g.files.map((f) => (
                            <li
                              key={f.rel}
                              className="flex items-center justify-between gap-2 pt-1 border-t border-border/40"
                            >
                              <span className="font-mono break-all flex-1">{f.rel}</span>
                              <div className="flex items-center gap-2 shrink-0">
                                {f.canRestore ? (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={loading}
                                    onClick={() => void handleRestoreUndo(f.rel, g.generationStamp)}
                                  >
                                    {t('goldenReconcile.undo.restoreButton')}
                                  </Button>
                                ) : (
                                  <span className="text-muted-foreground">
                                    {f.notRestorableReason
                                      ? t(`goldenReconcile.undo.reason.${f.notRestorableReason}`)
                                      : t('goldenReconcile.undo.cannotRestore')}
                                  </span>
                                )}
                              </div>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </CardContent>
          )}
        </Card>
      )}

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
