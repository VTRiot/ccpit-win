import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Camera, Loader2, Star, GitCompare, RotateCcw, Check } from 'lucide-react'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { cn, toNativePath } from '../lib/utils'
import ReactDiffViewer from 'react-diff-viewer-continued'

type SnapshotLabel = 'manual' | 'pre-restore' | 'post-restore'

interface SnapshotInfo {
  id: string
  timestamp: string
  knownGood: boolean
  label: SnapshotLabel
  fileCount: number
}

const LABEL_TEXT: Record<SnapshotLabel, string> = {
  'manual': '手動 / Manual',
  'pre-restore': '復元前 / Pre-restore',
  'post-restore': '復元後 / Post-restore',
}

const LABEL_COLORS: Record<SnapshotLabel, string> = {
  'manual': 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  'pre-restore': 'bg-orange-500/10 text-orange-400 border-orange-500/20',
  'post-restore': 'bg-green-500/10 text-green-400 border-green-500/20',
}

/** ISO っぽいフォルダ名タイムスタンプ（`2026-04-13T01-57-02-423Z`）を Date に戻す */
function parseSnapshotTimestamp(ts: string): Date | null {
  const m = ts.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/)
  if (!m) return null
  return new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`)
}

function formatTimestamp(ts: string): string {
  const d = parseSnapshotTimestamp(ts)
  if (!d) return ts
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const da = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${y}/${mo}/${da} ${h}:${mi}`
}

function formatRelative(ts: string): string {
  const d = parseSnapshotTimestamp(ts)
  if (!d) return ''
  const diffMs = Date.now() - d.getTime()
  const sec = Math.floor(diffMs / 1000)
  if (sec < 60) return `${sec} 秒前`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 時間前`
  const day = Math.floor(hr / 24)
  return `${day} 日前`
}

interface FileDiff {
  relativePath: string
  risk: string
  status: string
  currentContent?: string
  snapshotContent?: string
}

interface RestoreResult {
  quarantinePath: string
  restoredFiles: string[]
  errors: string[]
}

const RISK_COLORS: Record<string, string> = {
  high: 'bg-red-500/10 text-red-500 border-red-500/20',
  medium: 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20',
  low: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
}

const STATUS_COLORS: Record<string, string> = {
  added: 'text-green-500',
  removed: 'text-red-500',
  modified: 'text-yellow-500',
}

export function RKPage(): React.JSX.Element {
  const { t } = useTranslation()
  const [snapshots, setSnapshots] = useState<SnapshotInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [snapshotMsg, setSnapshotMsg] = useState('')
  const [selectedDiff, setSelectedDiff] = useState<string | null>(null)
  const [diffs, setDiffs] = useState<FileDiff[]>([])
  const [diffLoading, setDiffLoading] = useState(false)
  const [expandedDiff, setExpandedDiff] = useState<string | null>(null)
  const [restoreResult, setRestoreResult] = useState<RestoreResult | null>(null)
  const [restoring, setRestoring] = useState(false)

  const loadSnapshots = async (): Promise<void> => {
    const list = await window.api.rkList()
    setSnapshots(list)
  }

  useEffect(() => { loadSnapshots() }, [])

  const handleTakeSnapshot = async (): Promise<void> => {
    setLoading(true)
    setSnapshotMsg('')
    const info = await window.api.rkSnapshot()
    setSnapshotMsg(t('pages.rk.snapshotTaken', { count: info.fileCount }))
    await loadSnapshots()
    setLoading(false)
  }

  const handleMarkKnownGood = async (id: string): Promise<void> => {
    await window.api.rkMarkKnownGood(id)
    await loadSnapshots()
  }

  const handleDiff = async (id: string): Promise<void> => {
    setSelectedDiff(id)
    setExpandedDiff(null)
    setDiffs([])
    setDiffLoading(true)
    try {
      const result = await window.api.rkDiff(id)
      setDiffs(result)
    } finally {
      setDiffLoading(false)
    }
  }

  const handleRestore = async (id: string): Promise<void> => {
    setRestoring(true)
    const result = await window.api.rkRestore(id)
    setRestoreResult(result)
    setRestoring(false)
    // 復元後の diff をクリアし、最新 post-restore snapshot との比較を自動実行
    setDiffs([])
    setSelectedDiff(null)
    const list = await window.api.rkList()
    setSnapshots(list)
    const latestPost = list.find((s) => s.label === 'post-restore')
    if (latestPost) {
      await handleDiff(latestPost.id)
    }
  }

  const snapshotPath = toNativePath(
    `${window.electron?.process?.env?.USERPROFILE || '~'}/.ccpit/snapshots/`
  )

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">{t('pages.rk.title')}</h1>
        <Button onClick={handleTakeSnapshot} disabled={loading} size="sm">
          {loading ? <Loader2 size={16} className="animate-spin" /> : <Camera size={16} />}
          {loading ? t('pages.rk.taking') : t('pages.rk.takeSnapshot')}
        </Button>
      </div>

      {/* Snapshot save path (read-only) */}
      <div className="rounded-md border border-border bg-muted/30 p-3">
        <p className="text-xs font-medium text-muted-foreground mb-1">{t('settings.snapshotPath')}</p>
        <code className="text-xs font-mono text-foreground">{snapshotPath}</code>
      </div>

      {snapshotMsg && (
        <div className="flex items-center gap-2 text-sm text-green-500">
          <Check size={16} /> {snapshotMsg}
        </div>
      )}

      {/* Restore Result */}
      {restoreResult && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-green-500">
              <Check size={18} /> {t('pages.rk.restoreComplete')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div><span className="text-muted-foreground">{t('pages.rk.quarantine')}:</span> <code className="text-xs font-mono">{toNativePath(restoreResult.quarantinePath)}</code></div>
            <div>{t('pages.rk.restoredFiles', { count: restoreResult.restoredFiles.length })}</div>
            {restoreResult.errors.length > 0 && (
              <div className="text-destructive">{restoreResult.errors.length} errors</div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Snapshot List */}
      <Card>
        <CardHeader>
          <CardTitle>{t('pages.rk.snapshots')}</CardTitle>
        </CardHeader>
        <CardContent>
          {snapshots.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('pages.rk.noSnapshots')}</p>
          ) : (
            <div className="space-y-2">
              {snapshots.map((snap) => (
                <div key={snap.id} className="flex items-center gap-3 p-3 rounded-md bg-muted/30 border border-border/50">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium">{formatTimestamp(snap.timestamp)}</span>
                      <span className="text-xs text-muted-foreground">({formatRelative(snap.timestamp)})</span>
                      <span className={cn('text-xs px-1.5 py-0.5 rounded border', LABEL_COLORS[snap.label] ?? LABEL_COLORS.manual)}>
                        {LABEL_TEXT[snap.label] ?? LABEL_TEXT.manual}
                      </span>
                      {snap.knownGood && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-green-500/10 text-green-500 border border-green-500/20 flex items-center gap-1">
                          <Star size={10} /> {t('pages.rk.knownGood')}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">{t('pages.rk.files', { count: snap.fileCount })}</div>
                  </div>
                  <div className="flex gap-1">
                    {!snap.knownGood && (
                      <Button variant="ghost" size="sm" onClick={() => handleMarkKnownGood(snap.id)} title={t('pages.rk.markKnownGood')}>
                        <Star size={14} />
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => handleDiff(snap.id)} title={t('pages.rk.compare')}>
                      <GitCompare size={14} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => { if (confirm(t('pages.rk.restoreConfirm'))) handleRestore(snap.id) }}
                      disabled={restoring}
                      title={t('pages.rk.restore')}
                    >
                      <RotateCcw size={14} />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Diff View */}
      {selectedDiff && (
        <Card>
          <CardHeader>
            <CardTitle>{t('pages.rk.diff')}</CardTitle>
          </CardHeader>
          <CardContent>
            {diffLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 size={16} className="animate-spin" /> {t('pages.rk.analyzing', '差分を解析中...')}
              </div>
            ) : diffs.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('pages.rk.noDiff')}</p>
            ) : (
              <div className="space-y-2">
                {diffs.map((diff) => (
                  <div key={diff.relativePath} className="border border-border rounded-md overflow-hidden">
                    <button
                      onClick={() => setExpandedDiff(expandedDiff === diff.relativePath ? null : diff.relativePath)}
                      className="w-full flex items-center gap-2 p-2.5 text-left hover:bg-muted/30 transition-colors"
                    >
                      <span className={cn('text-xs px-1.5 py-0.5 rounded border', RISK_COLORS[diff.risk])}>
                        {t(`pages.rk.risk.${diff.risk}`)}
                      </span>
                      <span className="font-mono text-xs flex-1">{diff.relativePath}</span>
                      <span className={cn('text-xs', STATUS_COLORS[diff.status])}>
                        {t(`pages.rk.fileStatus.${diff.status}`)}
                      </span>
                    </button>
                    {expandedDiff === diff.relativePath && diff.status === 'modified' && (
                      <div className="border-t border-border text-xs overflow-auto max-h-64">
                        <ReactDiffViewer
                          oldValue={diff.snapshotContent || ''}
                          newValue={diff.currentContent || ''}
                          splitView={false}
                          useDarkTheme
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
