import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Trash2, Copy, FolderOpen } from 'lucide-react'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { Toast } from '../components/ui/toast'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { formatCatalogTimestamp } from '../lib/catalogFormat'

/**
 * FB02 F9: Maintenance の BG-CC タブ。
 * - カタログ Clear（削除のみ・確認ダイアログ付き）: デバッグ・検収用（旧 T0 手順のボタン化）。
 *   通常の更新フローには削除を入れない（stale-ok フォールバック喪失を防ぐ設計判断 — 設計計画 r2）。
 * - 生ログのコピー / フォルダを開く: 可視ターミナル窓削除後の診断の逃げ道（F7）。
 * 配置先の判断: devTools タブは debugMode ゲートで一般ユーザーに届かず、health は read-only
 * 診断のため破壊的操作を混ぜない — 専用タブが最小の驚き。
 */
export function BgccMaintenancePage(): React.JSX.Element {
  const { t } = useTranslation()
  const [fetchedAt, setFetchedAt] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [toast, setToast] = useState<{
    message: string
    variant: 'success' | 'error'
  } | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async (): Promise<void> => {
      try {
        const catalog = await window.api.modelCatalogGet()
        if (!cancelled) setFetchedAt(catalog?.fetchedAt ?? null)
      } catch {
        /* fail-open: 表示は「キャッシュなし」に落ちる */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const handleClearConfirmed = async (): Promise<void> => {
    setConfirmOpen(false)
    try {
      const r = await window.api.modelCatalogClear()
      if (r.ok) {
        setFetchedAt(null)
        setToast({ message: t('pages.bgcc.catalogCard.cleared'), variant: 'success' })
      } else {
        setToast({
          message: t('pages.bgcc.catalogCard.clearFailed', { error: r.error ?? '' }),
          variant: 'error'
        })
      }
    } catch (e) {
      setToast({
        message: t('pages.bgcc.catalogCard.clearFailed', { error: String(e) }),
        variant: 'error'
      })
    }
  }

  const handleCopyLog = async (): Promise<void> => {
    try {
      const r = await window.api.bgccLogCopy()
      if (r.ok) {
        setToast({ message: t('common.copied'), variant: 'success' })
      } else {
        setToast({
          message: t('pages.bgcc.logCard.copyFailed', { error: r.error ?? '' }),
          variant: 'error'
        })
      }
    } catch (e) {
      setToast({
        message: t('pages.bgcc.logCard.copyFailed', { error: String(e) }),
        variant: 'error'
      })
    }
  }

  const handleOpenFolder = async (): Promise<void> => {
    try {
      const r = await window.api.bgccLogOpenFolder()
      if (!r.ok) {
        setToast({
          message: t('pages.bgcc.logCard.openFailed', { error: r.error ?? '' }),
          variant: 'error'
        })
      }
      // 成功時はフォルダウィンドウ自体がフィードバック（トースト不要）
    } catch (e) {
      setToast({
        message: t('pages.bgcc.logCard.openFailed', { error: String(e) }),
        variant: 'error'
      })
    }
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('pages.bgcc.catalogCard.title')}</CardTitle>
          <CardDescription>{t('pages.bgcc.catalogCard.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {fetchedAt
              ? t('pages.bgcc.catalogCard.current', { date: formatCatalogTimestamp(fetchedAt) })
              : t('pages.bgcc.catalogCard.none')}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            disabled={!fetchedAt}
            onClick={() => setConfirmOpen(true)}
          >
            <Trash2 size={14} />
            {t('pages.bgcc.catalogCard.clearButton')}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('pages.bgcc.logCard.title')}</CardTitle>
          <CardDescription>{t('pages.bgcc.logCard.description')}</CardDescription>
        </CardHeader>
        <CardContent className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => void handleCopyLog()}
          >
            <Copy size={14} />
            {t('pages.bgcc.logCard.copyButton')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => void handleOpenFolder()}
          >
            <FolderOpen size={14} />
            {t('pages.bgcc.logCard.openButton')}
          </Button>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmOpen}
        title={t('pages.bgcc.catalogCard.confirmTitle')}
        message={t('pages.bgcc.catalogCard.confirmMessage')}
        variant="destructive"
        onConfirm={handleClearConfirmed}
        onCancel={() => setConfirmOpen(false)}
      />
      <Toast
        open={toast !== null}
        message={toast?.message ?? ''}
        variant={toast?.variant ?? 'success'}
        onClose={() => setToast(null)}
      />
    </div>
  )
}
