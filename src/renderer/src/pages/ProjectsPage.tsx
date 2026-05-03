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

interface ProjectEntry {
  name: string
  path: string
  createdAt: string
  favorite?: boolean
  location_type?: string
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
  const [migrationToast, setMigrationToast] = useState<{ open: boolean; count: number }>({
    open: false,
    count: 0,
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

  const loadProjectList = async (): Promise<void> => {
    const list = await window.api.projectsList()
    setProjects(list)
  }

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
      const notice = await window.api.projectsConsumeMigrationNotice()
      if (notice && notice.migrated > 0) {
        setMigrationToast({ open: true, count: notice.migrated })
      }
    })()
  }, [])

  useEffect(() => {
    if (!showProtocolBadge) return
    if (projects.length === 0) return
    const paths = projects.map((p) => p.path)
    void scanMarkers(paths, autoMarkingEnabled)
  }, [projects, showProtocolBadge, autoMarkingEnabled, scanMarkers])

  const handleRescan = async (): Promise<void> => {
    const paths = projects.map((p) => p.path)
    await scanMarkers(paths, autoMarkingEnabled)
  }

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
  }

  const handleRescanMarker = async (path: string): Promise<void> => {
    if (!confirm(t('editMarker.confirmRescan'))) return
    const updated = (await window.api.protocolRescanMarker(path)) as ProtocolMarkerView
    setMarkers((prev) => ({ ...prev, [path]: updated }))
  }

  return (
    <div className="max-w-3xl">
      <Toast
        open={migrationToast.open}
        message={t('pages.projects.migration.createdAtUpdated', { count: migrationToast.count })}
        onClose={() => setMigrationToast((prev) => ({ ...prev, open: false }))}
        durationMs={5000}
      />
      <div className="flex items-center justify-between mb-6 gap-2 flex-wrap">
        <h1 className="text-xl font-bold">{t('pages.projects.title')}</h1>
        <div className="flex items-center gap-2 flex-wrap">
          {showProtocolBadge && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleRescan}
              disabled={scanningMarkers}
              className="gap-1.5"
              title={t('pages.projects.protocolBadge.rescan')}
            >
              <RefreshCw size={14} className={scanningMarkers ? 'animate-spin' : ''} />
              {t('pages.projects.protocolBadge.rescan')}
            </Button>
          )}
          {showDetectLinkRemove && (
            <>
              <Button variant="outline" size="sm" onClick={() => setShowDiscover(true)} className="gap-1.5">
                <Search size={14} />
                {t('pages.projects.discover.button')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setShowRemoveFromList(true)} className="gap-1.5">
                <ListMinus size={14} />
                {t('pages.projects.removeFromList.button')}
              </Button>
            </>
          )}
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
          <Button onClick={() => { setShowCreate(!showCreate); setCreateResult(null) }} variant={showCreate ? 'outline' : 'default'} size="sm">
            <Plus size={16} /> {t('pages.projects.newProject')}
          </Button>
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

      {/* Edit Marker Dialog */}
      {showEditMarkerUI && (
        <EditMarkerDialog
          open={editMarkerOpen}
          onOpenChange={(o) => {
            setEditMarkerOpen(o)
            if (!o) setEditingPath(null)
          }}
          current={editingPath ? (markers[editingPath] ?? null) : null}
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
