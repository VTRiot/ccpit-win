import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Plus,
  FolderOpen,
  Trash2,
  Check,
  X,
  Loader2,
  ExternalLink,
  Search,
  ListMinus,
  RefreshCw,
  Star,
  ChevronDown,
  Clipboard,
} from 'lucide-react'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Checkbox } from '../components/ui/checkbox'
import { Toast } from '../components/ui/toast'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '../components/ui/dropdown-menu'
import { LaunchMenu } from '../components/LaunchMenu'
import { ProjectDiscoveryDialog } from '../components/ProjectDiscoveryDialog'
import { RemoveFromListDialog } from '../components/RemoveFromListDialog'
import { ProtocolBadge, type ProtocolMarkerView } from '../components/ProtocolBadge'
import { EditMarkerDialog, type EditMarkerSubmit } from '../components/EditMarkerDialog'
import { FullRescanConfirmDialog } from '../components/FullRescanConfirmDialog'
import { useFeatureFlag } from '../hooks/useFeatureFlag'
import { cn, toNativePath } from '../lib/utils'
import {
  applyProjectsView,
  loadProjectsViewState,
  saveProjectsViewState,
  SORT_MODES,
  type ProjectsViewState,
  type SortMode,
} from '../lib/projectsView'
import { isCcesEnabled, CCES_CONFIG_CHANGED_EVENT } from '../lib/ccesEnabled'

interface ProjectEntry {
  name: string
  path: string
  createdAt: string
  favorite?: boolean
  location_type?: string
  // 034-B: confirmed 廃止。明示意思は protocol.json の history (append-only event log) に統合。
}

export function ProjectsPage(): React.JSX.Element {
  const { t } = useTranslation()
  const showLaunchButton = useFeatureFlag('ccLaunchButton')
  const showDetectLinkRemove = useFeatureFlag('detectLinkRemove')
  const showProtocolBadge = useFeatureFlag('protocolBadge')
  const autoMarkingEnabled = useFeatureFlag('autoMarking')
  const showFavorite = useFeatureFlag('favoriteToggle')
  const showEditMarkerUI = useFeatureFlag('editMarkerUI')
  const [projects, setProjects] = useState<ProjectEntry[]>([])
  const [showCreate, setShowCreate] = useState(false)
  const [showDiscover, setShowDiscover] = useState(false)
  const [showRemoveFromList, setShowRemoveFromList] = useState(false)
  const [newName, setNewName] = useState('')
  const [newPath, setNewPath] = useState('')
  const [creating, setCreating] = useState(false)
  const [createResult, setCreateResult] = useState<{ success: boolean; created: string[]; errors: string[] } | null>(null)
  const [launchMessage, setLaunchMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [markers, setMarkers] = useState<Record<string, ProtocolMarkerView | null>>({})
  const [scanningMarkers, setScanningMarkers] = useState(false)
  const [editMarkerOpen, setEditMarkerOpen] = useState(false)
  const [editingPath, setEditingPath] = useState<string | null>(null)
  const [viewState, setViewState] = useState<ProjectsViewState>(() => loadProjectsViewState())
  // 034-B: 2 マイグレーション通知を結合表示するため message 形式に変更
  const [migrationToast, setMigrationToast] = useState<{ open: boolean; message: string }>({
    open: false,
    message: '',
  })
  // 034-B (UX 課題 3): 各 PJ の「手動編集済み」判定情報。ProtocolBadge アイコン表示と Tooltip 用
  const [historyMeta, setHistoryMeta] = useState<
    Record<string, { hasManual: boolean; lastManualAt: string | null; historyCount: number }>
  >({})
  // 034 + 034-B: Full Re-scan 用の状態（changed/unchanged 追加）
  const [fullRescanDialogOpen, setFullRescanDialogOpen] = useState(false)
  const [fullRescanToast, setFullRescanToast] = useState<{
    open: boolean
    kind: 'success' | 'error'
    processed: number
    skipped: number
    failed: number
    changed: number
    unchanged: number
  }>({
    open: false,
    kind: 'success',
    processed: 0,
    skipped: 0,
    failed: 0,
    changed: 0,
    unchanged: 0,
  })

  useEffect(() => {
    saveProjectsViewState(viewState)
  }, [viewState])

  const visibleProjects = applyProjectsView(projects, viewState)

  const handleLaunched = (result: { shell: string; spawned: boolean; error?: string }): void => {
    if (result.spawned) {
      setLaunchMessage({ kind: 'ok', text: t('pages.projects.launch.successWith', { shell: result.shell }) })
    } else {
      setLaunchMessage({ kind: 'err', text: result.error ?? t('pages.projects.launch.error') })
    }
    setTimeout(() => setLaunchMessage(null), 3000)
  }

  // 036: CCES Generate. Per-project click → calls main with that project's path.
  const [ccesBusy, setCcesBusy] = useState<string | null>(null)
  // 037 Phase 2-B: CCES 有効性スイッチ（cces.allowAllProjects）の現在値。
  // - false (既定): manx / manx-host のみボタン enable、他は灰抜き
  // - true: 全 PJ enable（MaintenanceDialog の CCES Advanced タブで切替）
  const [ccesAllowAll, setCcesAllowAll] = useState<boolean>(false)
  useEffect(() => {
    const refetch = async (): Promise<void> => {
      try {
        const cfg = await window.api.configGet()
        setCcesAllowAll(cfg.cces?.allowAllProjects ?? false)
      } catch {
        /* keep current value */
      }
    }
    void refetch()
    window.addEventListener(CCES_CONFIG_CHANGED_EVENT, refetch)
    return () => window.removeEventListener(CCES_CONFIG_CHANGED_EVENT, refetch)
  }, [])
  const handleCcesGenerate = async (projectPath: string, projectName: string): Promise<void> => {
    setCcesBusy(projectPath)
    try {
      const result = await window.api.ccesGenerate({ projectPath })
      if (result.ok) {
        const kb = (result.bytes / 1024).toFixed(1)
        if (result.oversized) {
          setLaunchMessage({
            kind: 'err',
            text: t('pages.projects.cces.oversizedWarning', { project: projectName, size: kb }),
          })
        } else {
          setLaunchMessage({
            kind: 'ok',
            text: t('pages.projects.cces.copied', { project: projectName, size: kb }),
          })
        }
      } else {
        setLaunchMessage({
          kind: 'err',
          text: t('pages.projects.cces.error', { reason: result.error }),
        })
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      setLaunchMessage({ kind: 'err', text: t('pages.projects.cces.error', { reason }) })
    } finally {
      setCcesBusy(null)
      setTimeout(() => setLaunchMessage(null), 3000)
    }
  }

  const loadProjectList = async (): Promise<void> => {
    const list = await window.api.projectsList()
    setProjects(list)
  }

  // 034-B: 各 PJ の hasManualEntry / lastManualAt / historyCount を取得
  const fetchHistoryMeta = useCallback(async (paths: string[]): Promise<void> => {
    if (paths.length === 0) return
    const results = await Promise.all(
      paths.map(async (p) => {
        try {
          const r = await window.api.protocolHasManualEntry(p)
          return [p, r] as const
        } catch {
          return [p, { hasManual: false, lastManualAt: null, historyCount: 0 }] as const
        }
      })
    )
    setHistoryMeta((prev) => {
      const next = { ...prev }
      for (const [path, meta] of results) {
        next[path] = meta
      }
      return next
    })
  }, [])

  const scanMarkers = useCallback(
    async (paths: string[], allowAutoWrite: boolean): Promise<void> => {
      if (paths.length === 0) return
      setScanningMarkers(true)
      try {
        const results = await Promise.all(
          paths.map(async (p) => {
            try {
              if (allowAutoWrite) {
                const r = await window.api.protocolAutoMark(p)
                return [p, r.marker as ProtocolMarkerView] as const
              }
              const m = (await window.api.protocolRead(p)) as ProtocolMarkerView | null
              return [p, m] as const
            } catch {
              return [p, null] as const
            }
          })
        )
        setMarkers((prev) => {
          const next = { ...prev }
          for (const [path, marker] of results) {
            next[path] = marker
          }
          return next
        })
      } finally {
        setScanningMarkers(false)
      }
    },
    []
  )

  useEffect(() => {
    void (async (): Promise<void> => {
      await loadProjectList()
      // 034-B: 2 マイグレーション通知を取得して結合
      const createdAtNotice = await window.api.projectsConsumeMigrationNotice()
      const historyNotice = await window.api.projectsConsumeProtocolHistoryMigrationNotice()
      const messages: string[] = []
      if (createdAtNotice && createdAtNotice.migrated > 0) {
        messages.push(
          t('pages.projects.migration.createdAtUpdated', { count: createdAtNotice.migrated })
        )
      }
      if (historyNotice && historyNotice.migrated > 0) {
        messages.push(
          t('pages.projects.migration.protocolHistoryV2', { count: historyNotice.migrated })
        )
      }
      if (messages.length > 0) {
        setMigrationToast({ open: true, message: messages.join('\n') })
      }
    })()
  }, [t])

  useEffect(() => {
    if (!showProtocolBadge) return
    if (projects.length === 0) return
    const paths = projects.map((p) => p.path)
    void scanMarkers(paths, autoMarkingEnabled)
    void fetchHistoryMeta(paths)
  }, [projects, showProtocolBadge, autoMarkingEnabled, scanMarkers, fetchHistoryMeta])

  // 034: Full Re-scan の起点。確認ダイアログを開くだけで、実行は executeFullRescan で行う。
  const handleFullRescan = (): void => {
    setFullRescanDialogOpen(true)
  }

  // 034-B: Full Re-scan 実行（根治版、append-only history）。
  // - main 側 IPC で全 PJ を強制再判定（履歴に manual エントリある PJ は保護）
  // - 完了後に projects/markers/historyMeta を再 load
  // - scanningMarkers state を true に維持して NR-8（実行中の他操作）を抑止
  // - 戻り値の changed/unchanged を Toast に表示（UX 課題 2）
  const executeFullRescan = async (): Promise<void> => {
    setFullRescanDialogOpen(false)
    setScanningMarkers(true)
    try {
      const result = await window.api.protocolFullRescan()
      await loadProjectList()
      const paths = projects.map((p) => p.path)
      if (paths.length > 0) {
        await scanMarkers(paths, false)
        await fetchHistoryMeta(paths)
      }
      setFullRescanToast({
        open: true,
        kind: result.failed > 0 ? 'error' : 'success',
        processed: result.processed,
        skipped: result.skipped,
        failed: result.failed,
        changed: result.changed,
        unchanged: result.unchanged,
      })
    } catch (e) {
      console.error('fullRescan error:', e)
      setFullRescanToast({
        open: true,
        kind: 'error',
        processed: 0,
        skipped: 0,
        failed: -1,
        changed: 0,
        unchanged: 0,
      })
    } finally {
      setScanningMarkers(false)
    }
  }

  // 034-B: 再判定対象件数は履歴ベースで main 側 IPC から取得
  const [fullRescanTargetCount, setFullRescanTargetCount] = useState(0)
  useEffect(() => {
    void (async (): Promise<void> => {
      const target = await window.api.protocolCountFullRescanTargets()
      setFullRescanTargetCount(target)
    })()
  }, [projects, historyMeta])

  const handleToggleFavorite = async (project: ProjectEntry): Promise<void> => {
    const next = !(project.favorite ?? false)
    await window.api.projectsSetFavorite(project.path, next)
    setProjects((prev) =>
      prev.map((p) => (p.path === project.path ? { ...p, favorite: next } : p))
    )
  }

  const handleSelectPath = async (): Promise<void> => {
    const folder = await window.api.selectFolder()
    if (folder) setNewPath(folder)
  }

  const handleCreate = async (): Promise<void> => {
    if (!newName.trim() || !newPath.trim()) return
    setCreating(true)
    setCreateResult(null)
    const result = await window.api.projectsCreate(newPath, newName)
    setCreateResult(result)
    setCreating(false)
    if (result.success) {
      await loadProjectList()
      setNewName('')
      setNewPath('')
    }
  }

  const handleRemove = async (path: string): Promise<void> => {
    await window.api.projectsRemove(path)
    await loadProjectList()
  }

  const handleOpenFolder = async (path: string): Promise<void> => {
    await window.api.openPath(path)
  }

  const handleOpenEditMarker = (path: string): void => {
    setEditingPath(path)
    setEditMarkerOpen(true)
  }

  const handleSubmitEditMarker = async (edits: EditMarkerSubmit): Promise<void> => {
    if (!editingPath) return
    const updated = (await window.api.protocolEditMarker(editingPath, edits)) as ProtocolMarkerView
    setMarkers((prev) => ({ ...prev, [editingPath]: updated }))
    // 034-B: main 側で履歴に manual エントリが追加される（appendProtocolEntry）。
    // confirmed フィールドは廃止、ProtocolBadge の hasManualEntry は次回 hasManualEntry 取得で反映。
  }

  const handleRescanMarker = async (path: string): Promise<void> => {
    if (!confirm(t('editMarker.confirmRescan'))) return
    const updated = (await window.api.protocolRescanMarker(path)) as ProtocolMarkerView
    setMarkers((prev) => ({ ...prev, [path]: updated }))
  }

  return (
    <div className="max-w-5xl mx-auto">
      <Toast
        open={migrationToast.open}
        message={migrationToast.message}
        onClose={() => setMigrationToast((prev) => ({ ...prev, open: false }))}
        durationMs={6000}
      />
      <Toast
        open={fullRescanToast.open}
        message={
          fullRescanToast.kind === 'success'
            ? t('pages.projects.fullRescan.success', {
                processed: fullRescanToast.processed,
                changed: fullRescanToast.changed,
                unchanged: fullRescanToast.unchanged,
                skipped: fullRescanToast.skipped,
              })
            : t('pages.projects.fullRescan.error', { failed: fullRescanToast.failed })
        }
        variant={fullRescanToast.kind}
        onClose={() => setFullRescanToast((prev) => ({ ...prev, open: false }))}
        durationMs={5000}
      />
      <FullRescanConfirmDialog
        open={fullRescanDialogOpen}
        onOpenChange={setFullRescanDialogOpen}
        targetCount={fullRescanTargetCount}
        onConfirm={() => void executeFullRescan()}
      />
      <div className="flex items-center justify-between mb-6 gap-2 flex-wrap">
        <h1 className="text-xl font-bold">{t('pages.projects.title')}</h1>
        <div className="flex flex-1 items-center gap-2 flex-wrap justify-end">
          {showProtocolBadge && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleFullRescan}
              disabled={scanningMarkers}
              className="order-1 gap-1.5"
              title={t('pages.projects.protocolBadge.fullRescan')}
            >
              <RefreshCw size={14} className={scanningMarkers ? 'animate-spin' : ''} />
              {t('pages.projects.protocolBadge.fullRescan')}
            </Button>
          )}
          {showDetectLinkRemove && (
            <>
              <Button variant="outline" size="sm" onClick={() => setShowDiscover(true)} className="order-2 gap-1.5">
                <Search size={14} />
                {t('pages.projects.discover.button')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setShowRemoveFromList(true)} className="order-3 gap-1.5">
                <ListMinus size={14} />
                {t('pages.projects.removeFromList.button')}
              </Button>
            </>
          )}
          {/* SortGroup: 並び順 + ★お気に入り (要件 2: 常に並び順 → お気に入り の順)
              order-5 xl:order-4 で「+ 新規」と前後切替 (要件 3: xl 以上で 1 段化)
              w-full justify-end xl:w-auto で xl 未満は下段右寄せ折返、xl 以上は 1 段で通常配置 */}
          <div className="order-5 xl:order-4 flex w-full xl:w-auto items-center justify-end gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5">
                  {t('pages.projects.sort.label')}: {t(`pages.projects.sort.${viewState.sortMode}`)}
                  <ChevronDown size={14} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuRadioGroup
                  value={viewState.sortMode}
                  onValueChange={(value) =>
                    setViewState((prev) => ({ ...prev, sortMode: value as SortMode }))
                  }
                >
                  {SORT_MODES.map((mode) => (
                    <DropdownMenuRadioItem key={mode} value={mode}>
                      {t(`pages.projects.sort.${mode}`)}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            {showFavorite && (
              <label className="flex items-center gap-1.5 text-sm cursor-pointer select-none">
                <Checkbox
                  checked={viewState.filterFavoritesOnly}
                  onCheckedChange={(checked) =>
                    setViewState((prev) => ({
                      ...prev,
                      filterFavoritesOnly: checked === true,
                    }))
                  }
                  aria-label={t('pages.projects.filter.favoritesOnly')}
                />
                <span>{t('pages.projects.filter.favoritesOnly')}</span>
              </label>
            )}
          </div>
          {/* 要件 4: 「+ 新規プロジェクト」は常に右上 (xl 未満は上段最右、xl 以上は 1 段最右) */}
          <Button
            onClick={() => { setShowCreate(!showCreate); setCreateResult(null) }}
            variant={showCreate ? 'outline' : 'default'}
            size="sm"
            className="order-4 xl:order-5"
          >
            <Plus size={16} /> {t('pages.projects.newProject')}
          </Button>
        </div>
      </div>

      {launchMessage && (
        <div
          className={cn(
            'mb-4 rounded-md border px-3 py-2 text-sm',
            launchMessage.kind === 'ok'
              ? 'border-green-500/30 bg-green-500/10 text-green-600'
              : 'border-destructive/30 bg-destructive/10 text-destructive'
          )}
        >
          {launchMessage.text}
        </div>
      )}

      {/* Create Form */}
      {showCreate && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>{t('pages.projects.newProject')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>{t('pages.projects.projectName')}</Label>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t('pages.projects.projectNamePlaceholder')}
              />
            </div>
            <div className="space-y-2">
              <Label>{t('pages.projects.projectPath')}</Label>
              <div className="flex gap-2">
                <Input value={newPath} onChange={(e) => setNewPath(e.target.value)} className="flex-1" placeholder="C:\Projects\my-project" />
                <Button variant="outline" onClick={handleSelectPath}>
                  <FolderOpen size={16} /> {t('pages.projects.selectPath')}
                </Button>
              </div>
            </div>

            {createResult && (
              <div className={cn('flex items-center gap-2 text-sm', createResult.success ? 'text-green-500' : 'text-destructive')}>
                {createResult.success ? <Check size={16} /> : <X size={16} />}
                {createResult.success ? t('pages.projects.createSuccess') : t('pages.projects.createError')}
              </div>
            )}

            <Button onClick={handleCreate} disabled={creating || !newName.trim() || !newPath.trim()}>
              {creating ? <><Loader2 size={16} className="animate-spin" /> {t('pages.projects.creating')}</> : t('pages.projects.create')}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Discovery Dialog */}
      {showDetectLinkRemove && (
        <ProjectDiscoveryDialog
          open={showDiscover}
          onOpenChange={setShowDiscover}
          onImported={() => {
            void loadProjectList()
          }}
        />
      )}

      {/* Remove from List Dialog */}
      {showDetectLinkRemove && (
        <RemoveFromListDialog
          open={showRemoveFromList}
          onOpenChange={setShowRemoveFromList}
          projects={projects}
          onRemoved={() => {
            void loadProjectList()
          }}
        />
      )}

      {/* Edit Marker Dialog (034-B: projectPath 追加で履歴セクション表示) */}
      {showEditMarkerUI && (
        <EditMarkerDialog
          open={editMarkerOpen}
          onOpenChange={(o) => {
            setEditMarkerOpen(o)
            if (!o) setEditingPath(null)
          }}
          current={editingPath ? (markers[editingPath] ?? null) : null}
          projectPath={editingPath}
          onSubmit={handleSubmitEditMarker}
        />
      )}

      {/* Project List */}
      {projects.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            {t('pages.projects.noProjects')}
          </CardContent>
        </Card>
      ) : visibleProjects.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            {t('pages.projects.noFavorites')}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {visibleProjects.map((project) => (
            <Card key={project.path}>
              <CardContent className="p-4 flex items-center gap-4">
                {showFavorite && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                      'h-8 w-8',
                      project.favorite
                        ? 'text-yellow-400 hover:text-yellow-500'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                    onClick={() => handleToggleFavorite(project)}
                    title={t(
                      project.favorite
                        ? 'pages.projects.favorite.unfavorite'
                        : 'pages.projects.favorite.favorite'
                    )}
                  >
                    <Star
                      size={14}
                      className={project.favorite ? 'fill-current' : ''}
                    />
                  </Button>
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className="font-medium">{project.name}</span>
                    {showProtocolBadge && (
                      <ProtocolBadge
                        marker={markers[project.path]}
                        loading={scanningMarkers && markers[project.path] === undefined}
                        hasManualEntry={historyMeta[project.path]?.hasManual}
                        lastManualAt={historyMeta[project.path]?.lastManualAt}
                        historyCount={historyMeta[project.path]?.historyCount}
                      />
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground font-mono truncate">{toNativePath(project.path)}</div>
                </div>
                {showLaunchButton && (
                  <LaunchMenu
                    projectPath={project.path}
                    onLaunched={handleLaunched}
                    showEditMarker={showEditMarkerUI}
                    onEditMarker={() => handleOpenEditMarker(project.path)}
                    onRescanMarker={() => void handleRescanMarker(project.path)}
                  />
                )}
                {/* 036: CCES Generate (per-project, clipboard-based) */}
                {/* 037 Phase 2-B: スイッチ × 自動判定で disabled / tooltip を切替 */}
                {(() => {
                  const enabled = isCcesEnabled(markers[project.path], ccesAllowAll)
                  const busy = ccesBusy === project.path
                  return (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy || !enabled}
                      onClick={() => void handleCcesGenerate(project.path, project.name)}
                      title={t(enabled ? 'pages.projects.cces.tooltip' : 'pages.projects.cces.disabledTooltip')}
                      className={cn(
                        'gap-1.5',
                        enabled
                          ? 'bg-[hsl(180_55%_42%)] hover:bg-[hsl(180_55%_50%)] text-white border-[hsl(180_55%_42%)]'
                          : 'opacity-40',
                      )}
                    >
                      {busy ? <Loader2 size={14} className="animate-spin" /> : <Clipboard size={14} />}
                      {t('pages.projects.cces.generate')}
                    </Button>
                  )
                })()}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-foreground"
                  onClick={() => handleOpenFolder(project.path)}
                  title={t('pages.projects.openFolder', 'フォルダを開く')}
                >
                  <ExternalLink size={14} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                  onClick={() => handleRemove(project.path)}
                  title={t('pages.projects.remove')}
                >
                  <Trash2 size={14} />
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
