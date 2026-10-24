import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, AlertTriangle, Info, FileText, X, Layers, ExternalLink } from 'lucide-react'
import { Button } from '../components/ui/button'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { cn } from '../lib/utils'

type ListResult = Awaited<ReturnType<typeof window.api.skillLifecycleList>>
type InventoryResult = Extract<ListResult, { ok: true }>['result']
type InventoryEntry = InventoryResult['entries'][number]
type CollisionPair = InventoryResult['collisionPairs'][number]
type RestorableRemoval = InventoryResult['restorableRemovals'][number]
type SkillBucket = InventoryEntry['bucket']

const BUCKET_ORDER: SkillBucket[] = ['bypass', 'missing', 'drift', 'clean']
const BUCKET_CLS: Record<SkillBucket, string> = {
  bypass: 'bg-amber-500/15 text-amber-600',
  missing: 'bg-red-500/15 text-red-600',
  drift: 'bg-orange-500/15 text-orange-600',
  clean: 'bg-green-500/15 text-green-600'
}

/** 撤去直後の「元に戻す」導線。Toast コンポーネントはアクションボタンを持たないため専用実装。 */
function UndoBar({
  message,
  onUndo,
  onDismiss
}: {
  message: string
  onUndo: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  useEffect(() => {
    const id = setTimeout(onDismiss, 8000)
    return () => clearTimeout(id)
  }, [onDismiss])
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-md border border-border bg-popover text-popover-foreground px-4 py-2 text-sm shadow-lg">
      <span>{message}</span>
      <button className="font-medium text-primary hover:underline" onClick={onUndo}>
        {t('skillLifecycle.undo')}
      </button>
    </div>
  )
}

export function SkillLifecyclePage(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const ja = i18n.language.startsWith('ja')

  const [data, setData] = useState<InventoryResult | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [selectedEntry, setSelectedEntry] = useState<InventoryEntry | null>(null)
  const [showFullContent, setShowFullContent] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState<InventoryEntry | null>(null)
  const [confirmRollback, setConfirmRollback] = useState<InventoryEntry | null>(null)
  const [confirmCollision, setConfirmCollision] = useState<{
    pair: CollisionPair
    keep: 'original' | 'temp'
  } | null>(null)
  const [confirmRestore, setConfirmRestore] = useState<RestorableRemoval | null>(null)
  const [undo, setUndo] = useState<{ message: string; removalId: string } | null>(null)
  const [flashError, setFlashError] = useState<string | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const res = await window.api.skillLifecycleList()
      if (res.ok) {
        setData(res.result)
        setLoadError(null)
        setSelectedEntry((prev) => {
          if (!prev) return res.result.entries[0] ?? null
          return res.result.entries.find((e) => e.name === prev.name) ?? res.result.entries[0] ?? null
        })
      } else {
        setLoadError(res.error)
      }
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const flash = (msg: string): void => {
    setFlashError(msg)
    setTimeout(() => setFlashError(null), 5000)
  }

  const doRemove = async (entry: InventoryEntry): Promise<void> => {
    setConfirmRemove(null)
    const res = await window.api.skillLifecycleRemove({ name: entry.name, stateToken: entry.stateToken })
    if (res.success && res.removalId) {
      setUndo({
        message: t('skillLifecycle.removed', { name: entry.name }),
        removalId: res.removalId
      })
      void reload()
    } else {
      flash(t('skillLifecycle.error', { message: res.error ?? res.reason ?? 'unknown' }))
    }
  }

  const doUndo = async (): Promise<void> => {
    if (!undo) return
    const id = undo.removalId
    setUndo(null)
    const res = await window.api.skillLifecycleRestoreRemoved(id)
    if (res.success) {
      flash(t('skillLifecycle.restored'))
      void reload()
    } else {
      flash(t('skillLifecycle.error', { message: res.error ?? res.reason ?? 'unknown' }))
    }
  }

  /** 撤去した skill を後からでも戻す導線（addendum-02 W-1）。トーストの undo と同じ API を
   *  同じ引数で呼ぶ — 「直後に押した場合と同じ結果」を実装差で崩さないため。 */
  const doRestoreRemoved = async (item: RestorableRemoval): Promise<void> => {
    setConfirmRestore(null)
    const res = await window.api.skillLifecycleRestoreRemoved(item.record.id)
    if (res.success) {
      flash(t('skillLifecycle.restored'))
      void reload()
    } else {
      flash(t('skillLifecycle.error', { message: res.error ?? res.reason ?? 'unknown' }))
    }
  }

  const doRollback = async (entry: InventoryEntry): Promise<void> => {
    setConfirmRollback(null)
    if (!entry.registryEntry?.archivePath) return
    const res = await window.api.skillLifecycleRestoreArchive({
      name: entry.name,
      archivePath: entry.registryEntry.archivePath
    })
    if (res.success) {
      flash(t('skillLifecycle.rolledBack'))
      void reload()
    } else {
      flash(t('skillLifecycle.error', { message: res.error ?? res.reason ?? 'unknown' }))
    }
  }

  const doResolveCollision = async (
    pair: CollisionPair,
    keep: 'original' | 'temp'
  ): Promise<void> => {
    setConfirmCollision(null)
    const res = await window.api.skillLifecycleResolveCollision({
      originalName: pair.originalName,
      tempName: pair.tempName,
      keep,
      stateToken: pair.stateToken
    })
    if (res.success) {
      flash(ja ? '衝突を解決しました。' : 'Collision resolved.')
      void reload()
    } else {
      flash(t('skillLifecycle.error', { message: res.error ?? res.reason ?? 'unknown' }))
    }
  }

  const fmtDate = (iso: string | null): string => {
    if (!iso) return '-'
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
  }

  return (
    <div className="flex flex-col h-full gap-3">
      <div className="flex items-center gap-2 shrink-0">
        <h2 className="text-base font-semibold">{t('skillLifecycle.title')}</h2>
        <span className="text-xs text-muted-foreground">{t('skillLifecycle.subtitle')}</span>
        <div className="ml-auto">
          <Button variant="ghost" size="icon" onClick={() => void reload()} disabled={busy} className="h-8 w-8">
            <RefreshCw size={14} className={cn(busy && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {flashError && (
        <div className="flex items-start gap-2 text-xs bg-red-500/10 text-red-700 rounded p-2 shrink-0">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>{flashError}</span>
        </div>
      )}

      {loadError && (
        <div className="flex items-start gap-2 text-sm bg-red-500/15 text-red-700 border border-red-400 rounded p-3 shrink-0">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>{loadError}</span>
        </div>
      )}

      {data && !loadError && (
        <div className="flex-1 overflow-auto flex flex-col gap-4">
          {data.registryReadError && (
            <div className="flex items-start gap-2 text-sm bg-red-500/15 text-red-700 border border-red-400 rounded p-3 shrink-0">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span>
                {t('skillLifecycle.registryError', { path: data.registryPath })}: {data.registryReadError}
              </span>
            </div>
          )}
          {data.ledgerReadError && (
            <div className="flex items-start gap-2 text-sm bg-red-500/15 text-red-700 border border-red-400 rounded p-3 shrink-0">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span>
                {t('skillLifecycle.ledgerError', { path: data.ledgerPath })}: {data.ledgerReadError}
              </span>
            </div>
          )}
          {data.pendingRemovals.length > 0 && (
            <div className="flex items-start gap-2 text-xs bg-amber-500/10 text-amber-700 rounded p-2 shrink-0">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>
                {t('skillLifecycle.pendingRemovals', {
                  names: data.pendingRemovals.map((r) => `${r.name} (${r.id})`).join(', ')
                })}
              </span>
            </div>
          )}
          {data.duplicateNames.length > 0 && (
            <div className="flex items-start gap-2 text-xs bg-amber-500/10 text-amber-700 rounded p-2 shrink-0">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{t('skillLifecycle.duplicateNames', { names: data.duplicateNames.join(', ') })}</span>
            </div>
          )}

          {/* 撤去した skill の復元（addendum-02 W-1）。撤去直後のトーストは 8 秒で消えるため、
              後から・再起動後でもここから戻せることが親発注 AC-3 の実体になる。 */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-sm font-medium">
              <span>{t('skillLifecycle.restorableTitle')}</span>
              <span className="text-muted-foreground font-normal">
                ({data.restorableRemovals.length})
              </span>
              <span className="text-xs text-muted-foreground font-normal">
                {t('skillLifecycle.restorableHint')}
              </span>
            </div>
            {data.ledgerReadError ? (
              <div className="text-xs text-amber-700 px-1 py-1">
                {t('skillLifecycle.undetermined')}
              </div>
            ) : data.restorableRemovals.length === 0 ? (
              <div className="text-xs text-muted-foreground px-1 py-1">
                {t('skillLifecycle.noEntries')}
              </div>
            ) : (
              <div className="border border-border rounded-md divide-y divide-border">
                {data.restorableRemovals.map((item) => {
                  // レジストリが読めないときは書き戻しを伴うものだけ止める。書き戻しを伴わない
                  // もの（ゲート迂回由来）はレジストリに触れないので通す（Codex #1）。
                  const blockedByRegistry = item.writesRegistry && data.registryReadError !== null
                  const blocked = !item.movedToExists || blockedByRegistry
                  return (
                    <div
                      key={item.record.id}
                      className="flex items-center gap-2 px-3 py-1.5 text-xs"
                    >
                      <span
                        className="font-mono flex-1 truncate"
                        title={item.record.movedTo ?? item.record.name}
                      >
                        {item.record.name}
                      </span>
                      {!item.movedToExists && (
                        <span className="px-1.5 py-0.5 rounded bg-red-500/15 text-red-600 shrink-0">
                          {t('skillLifecycle.quarantineMissingBadge')}
                        </span>
                      )}
                      {blockedByRegistry && (
                        <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 shrink-0">
                          {t('skillLifecycle.restoreBlockedByRegistryBadge')}
                        </span>
                      )}
                      <span className="text-muted-foreground shrink-0">
                        {fmtDate(item.record.removedAt)}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={blocked}
                        onClick={() => setConfirmRestore(item)}
                      >
                        {t('skillLifecycle.restore')}
                      </Button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* 中断した衝突解決。0 件でも節ごと消さない（addendum-02 W-2）。 */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-sm font-medium">
              <span>{t('skillLifecycle.interruptedSectionTitle')}</span>
              <span className="text-muted-foreground font-normal">
                ({data.possibleInterruptedCollisions.length})
              </span>
            </div>
            {data.registryReadError || data.ledgerReadError ? (
              <div className="text-xs text-amber-700 px-1 py-1">
                {t('skillLifecycle.undetermined')}
              </div>
            ) : data.possibleInterruptedCollisions.length === 0 ? (
              <div className="text-xs text-muted-foreground px-1 py-1">
                {t('skillLifecycle.noIssues')}
              </div>
            ) : (
              <div className="flex items-start gap-2 text-xs bg-amber-500/10 text-amber-700 rounded p-2">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>
                  {t('skillLifecycle.interruptedCollisions', {
                    names: data.possibleInterruptedCollisions.map((h) => h.originalName).join(', ')
                  })}
                </span>
              </div>
            )}
          </div>

          {/* 同名衝突。0 件でも節ごと消さない — 「無い」と「壊れていて描画されていない」を
              画面上で区別できるようにする（addendum-02 W-2）。読取失敗時は「異常なし」と
              言わず「未判定」と言う（Codex #6）。 */}
          <div
            className={cn(
              'rounded-md p-3 flex flex-col gap-2 border',
              data.collisionPairs.length > 0 ? 'border-orange-400' : 'border-border'
            )}
          >
            <div className="flex items-center gap-2 text-sm font-medium">
              <span className={cn(data.collisionPairs.length > 0 && 'text-orange-700')}>
                {t('skillLifecycle.collisionSectionTitle')}
              </span>
              <span className="text-muted-foreground font-normal">
                ({data.collisionPairs.length})
              </span>
            </div>
            {data.registryReadError ? (
              <div className="text-xs text-amber-700">{t('skillLifecycle.undetermined')}</div>
            ) : data.collisionPairs.length === 0 ? (
              <div className="text-xs text-muted-foreground">{t('skillLifecycle.noIssues')}</div>
            ) : (
              data.collisionPairs.map((pair) => (
                <div
                  key={`${pair.originalName}::${pair.tempName}`}
                  className="flex items-center gap-2 text-xs px-1 py-1"
                >
                  <span className="flex-1 font-mono truncate">
                    {t('skillLifecycle.collisionDescription', {
                      originalName: pair.originalName,
                      tempName: pair.tempName
                    })}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setConfirmCollision({ pair, keep: 'original' })}
                  >
                    {t('skillLifecycle.collisionKeepOriginal')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setConfirmCollision({ pair, keep: 'temp' })}
                  >
                    {t('skillLifecycle.collisionKeepTemp')}
                  </Button>
                </div>
              ))
            )}
          </div>

          {/* 2 ペイン構成: 左=4区分リスト、右=詳細ペイン (G-3) */}
          <div className="flex gap-4 flex-1 min-h-0">
            {/* 左ペイン: 4 区分リスト */}
            <div className="flex-1 flex flex-col gap-4 overflow-y-auto pr-1">
              {BUCKET_ORDER.map((bucket) => {
                const rows = data.entries.filter((e) => e.bucket === bucket)
                return (
                  <div key={bucket} className="flex flex-col gap-1">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <span className={cn('text-xs px-2 py-0.5 rounded', BUCKET_CLS[bucket])}>
                        {t(`skillLifecycle.bucket.${bucket}`)}
                      </span>
                      <span className="text-muted-foreground font-normal">({rows.length})</span>
                      <span className="text-xs text-muted-foreground font-normal">
                        {t(`skillLifecycle.bucketHint.${bucket}`)}
                      </span>
                    </div>
                    {rows.length === 0 ? (
                      <div className="text-xs text-muted-foreground px-1 py-1">
                        {t('skillLifecycle.noEntries')}
                      </div>
                    ) : (
                      <div className="border border-border rounded-md divide-y divide-border">
                        {rows.map((entry) => {
                          const isSelected = selectedEntry?.name === entry.name
                          return (
                            <div
                              key={entry.name}
                              onClick={() => setSelectedEntry(entry)}
                              className={cn(
                                'flex flex-col gap-1 p-2.5 text-xs cursor-pointer transition-colors border-l-2',
                                isSelected
                                  ? 'bg-primary/10 border-l-primary shadow-sm'
                                  : 'hover:bg-muted/40 border-l-transparent'
                              )}
                            >
                              <div className="flex items-center gap-2">
                                <span className="font-semibold text-sm text-foreground truncate">
                                  {entry.skillDetail?.title || entry.name}
                                </span>
                                <span className="font-mono text-[11px] text-muted-foreground truncate">
                                  ({entry.name})
                                </span>
                                {entry.targetMismatch && (
                                  <span className="px-1.5 py-0.5 rounded bg-red-500/15 text-red-600 shrink-0 text-[10px]">
                                    {t('skillLifecycle.targetMismatchBadge')}
                                  </span>
                                )}
                                {entry.readError && (
                                  <span
                                    className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 shrink-0 text-[10px]"
                                    title={entry.readError}
                                  >
                                    {t('skillLifecycle.readErrorBadge')}
                                  </span>
                                )}
                                <span className="ml-auto text-[11px] text-muted-foreground shrink-0">
                                  {fmtDate(entry.adoptedAt)}
                                </span>
                              </div>
                              {entry.skillDetail?.description && (
                                <p className="text-[11px] text-muted-foreground line-clamp-1">
                                  {entry.skillDetail.description}
                                </p>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {/* 右ペイン: 選択したスキルの詳細ビュー (G-3) */}
            <div className="w-[380px] shrink-0 border border-border rounded-lg bg-card p-4 flex flex-col gap-3 overflow-y-auto">
              {selectedEntry ? (
                <>
                  <div className="flex items-start justify-between gap-2 border-b border-border pb-3">
                    <div className="flex flex-col gap-0.5">
                      <div className="flex items-center gap-2">
                        <h3 className="font-bold text-base text-foreground">
                          {selectedEntry.skillDetail?.title || selectedEntry.name}
                        </h3>
                        <span
                          className={cn('text-[10px] px-1.5 py-0.5 rounded', BUCKET_CLS[selectedEntry.bucket])}
                        >
                          {t(`skillLifecycle.bucket.${selectedEntry.bucket}`)}
                        </span>
                      </div>
                      <span className="font-mono text-xs text-muted-foreground">
                        {selectedEntry.name}
                      </span>
                    </div>
                  </div>

                  {/* アクションボタン */}
                  <div className="flex items-center gap-2">
                    {selectedEntry.canRestoreArchive && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-xs h-7"
                        onClick={() => setConfirmRollback(selectedEntry)}
                      >
                        {t('skillLifecycle.rollbackArchive')}
                      </Button>
                    )}
                    <Button
                      variant="destructive"
                      size="sm"
                      className="text-xs h-7"
                      onClick={() => setConfirmRemove(selectedEntry)}
                    >
                      {t('skillLifecycle.remove')}
                    </Button>
                    {selectedEntry.skillDetail?.rawContent && (
                      <Button
                        variant="secondary"
                        size="sm"
                        className="text-xs h-7 ml-auto flex items-center gap-1"
                        onClick={() => setShowFullContent(true)}
                      >
                        <FileText size={12} />
                        {t('skillLifecycle.viewRawContent')}
                      </Button>
                    )}
                  </div>

                  {/* メタ情報カード */}
                  <div className="bg-muted/40 rounded-md p-2.5 flex flex-col gap-1.5 text-xs">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{t('skillLifecycle.path')}:</span>
                      <span
                        className="font-mono truncate max-w-[220px]"
                        title={selectedEntry.filePath ?? 'N/A'}
                      >
                        {selectedEntry.filePath ?? 'N/A'}
                      </span>
                    </div>
                    {selectedEntry.adoptedAt && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">採用日時:</span>
                        <span>{fmtDate(selectedEntry.adoptedAt)}</span>
                      </div>
                    )}
                    {selectedEntry.registryEntry?.source && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{t('skillLifecycle.origin')}:</span>
                        <span className="font-mono truncate max-w-[220px]">
                          {selectedEntry.registryEntry.source}
                        </span>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{t('skillLifecycle.archive')}:</span>
                      <span>
                        {selectedEntry.canRestoreArchive
                          ? t('skillLifecycle.hasArchive')
                          : t('skillLifecycle.noArchive')}
                      </span>
                    </div>
                  </div>

                  {/* What / Why / How 構造化情報 */}
                  <div className="flex flex-col gap-2">
                    <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      {t('skillLifecycle.detailTitle')}
                    </h4>

                    {/* What */}
                    <div className="bg-muted/20 border border-border/60 rounded p-2 text-xs flex flex-col gap-1">
                      <div className="flex items-center gap-1.5 font-medium text-foreground">
                        <Info size={13} className="text-blue-500" />
                        <span>What (概要・目的)</span>
                      </div>
                      <p className="text-muted-foreground whitespace-pre-wrap">
                        {selectedEntry.skillDetail?.what ||
                          selectedEntry.skillDetail?.description ||
                          '説明なし'}
                      </p>
                    </div>

                    {/* Why */}
                    {selectedEntry.skillDetail?.why && (
                      <div className="bg-muted/20 border border-border/60 rounded p-2 text-xs flex flex-col gap-1">
                        <div className="flex items-center gap-1.5 font-medium text-foreground">
                          <Layers size={13} className="text-purple-500" />
                          <span>Why (背景・動機)</span>
                        </div>
                        <p className="text-muted-foreground whitespace-pre-wrap">
                          {selectedEntry.skillDetail.why}
                        </p>
                      </div>
                    )}

                    {/* How */}
                    {selectedEntry.skillDetail?.how && (
                      <div className="bg-muted/20 border border-border/60 rounded p-2 text-xs flex flex-col gap-1">
                        <div className="flex items-center gap-1.5 font-medium text-foreground">
                          <ExternalLink size={13} className="text-emerald-500" />
                          <span>How (使い方・発火条件)</span>
                        </div>
                        <p className="text-muted-foreground whitespace-pre-wrap">
                          {selectedEntry.skillDetail.how}
                        </p>
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-center p-6 text-muted-foreground">
                  <FileText size={32} className="mb-2 opacity-40" />
                  <p className="text-xs">{t('skillLifecycle.detailEmpty')}</p>
                </div>
              )}
            </div>
          </div>

          {(data.goldenExcludedCount > 0 || data.catalystInfo.count > 0) && (
            <div className="flex flex-col gap-1 text-xs text-muted-foreground shrink-0">
              {data.goldenExcludedCount > 0 && (
                <div className="flex items-center gap-2">
                  <Info size={13} />
                  {t('skillLifecycle.goldenExcluded', { n: data.goldenExcludedCount })}
                </div>
              )}
              {data.catalystInfo.count > 0 && (
                <div className="flex items-center gap-2">
                  <Info size={13} />
                  {t('skillLifecycle.catalystInfo', { n: data.catalystInfo.count })}
                  {data.catalystInfo.names.length > 0 && (
                    <span className="font-mono truncate">({data.catalystInfo.names.join(', ')})</span>
                  )}
                </div>
              )}
              {data.catalystInfo.collidesWithManaged.length > 0 && (
                <div className="flex items-center gap-2 text-amber-700">
                  <AlertTriangle size={13} />
                  {t('skillLifecycle.catalystCollision', {
                    names: data.catalystInfo.collidesWithManaged.join(', ')
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmRemove !== null}
        title={t('skillLifecycle.removeConfirmTitle')}
        message={
          confirmRemove ? t('skillLifecycle.removeConfirmMessage', { name: confirmRemove.name }) : ''
        }
        variant="destructive"
        onConfirm={() => {
          if (confirmRemove) void doRemove(confirmRemove)
        }}
        onCancel={() => setConfirmRemove(null)}
      />
      <ConfirmDialog
        open={confirmRollback !== null}
        title={t('skillLifecycle.rollbackConfirmTitle')}
        message={
          confirmRollback
            ? t('skillLifecycle.rollbackConfirmMessage', { name: confirmRollback.name })
            : ''
        }
        onConfirm={() => {
          if (confirmRollback) void doRollback(confirmRollback)
        }}
        onCancel={() => setConfirmRollback(null)}
      />
      <ConfirmDialog
        open={confirmRestore !== null}
        title={t('skillLifecycle.restoreConfirmTitle')}
        message={
          confirmRestore
            ? t('skillLifecycle.restoreConfirmMessage', { name: confirmRestore.record.name })
            : ''
        }
        onConfirm={() => {
          if (confirmRestore) void doRestoreRemoved(confirmRestore)
        }}
        onCancel={() => setConfirmRestore(null)}
      />
      <ConfirmDialog
        open={confirmCollision !== null}
        title={t('skillLifecycle.collisionTitle', { n: 1 })}
        message={
          confirmCollision
            ? t('skillLifecycle.collisionDescription', {
                originalName: confirmCollision.pair.originalName,
                tempName: confirmCollision.pair.tempName
              })
            : ''
        }
        variant="destructive"
        onConfirm={() => {
          if (confirmCollision) void doResolveCollision(confirmCollision.pair, confirmCollision.keep)
        }}
        onCancel={() => setConfirmCollision(null)}
      />

      {undo && (
        <UndoBar message={undo.message} onUndo={() => void doUndo()} onDismiss={() => setUndo(null)} />
      )}

      {/* SKILL.md 全文表示モーダル (G-3) */}
      {showFullContent && selectedEntry?.skillDetail?.rawContent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
          <div className="bg-card border border-border rounded-lg shadow-xl w-full max-w-4xl max-h-[85vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between p-4 border-b border-border">
              <div className="flex items-center gap-2">
                <FileText size={18} className="text-primary" />
                <h3 className="font-semibold text-base">
                  {selectedEntry.skillDetail.title} ({selectedEntry.name}) - {t('skillLifecycle.rawContentModalTitle')}
                </h3>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => setShowFullContent(false)}
              >
                <X size={16} />
              </Button>
            </div>
            <div className="flex-1 overflow-auto p-4 bg-muted/20 font-mono text-xs whitespace-pre-wrap leading-relaxed select-text">
              {selectedEntry.skillDetail.rawContent}
            </div>
            <div className="p-3 border-t border-border flex justify-end bg-card">
              <Button variant="outline" size="sm" onClick={() => setShowFullContent(false)}>
                閉じる
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
