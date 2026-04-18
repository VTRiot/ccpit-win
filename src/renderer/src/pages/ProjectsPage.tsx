import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, FolderOpen, Trash2, Check, X, Loader2, ExternalLink } from 'lucide-react'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { cn, toNativePath } from '../lib/utils'

interface ProjectEntry {
  name: string
  path: string
  status: string
  createdAt: string
}

const STATUS_COLORS: Record<string, string> = {
  manx: 'bg-green-500/10 text-green-500 border-green-500/20',
  legacy: 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20',
  uninitialized: 'bg-muted text-muted-foreground border-border',
}

export function ProjectsPage(): React.JSX.Element {
  const { t } = useTranslation()
  const [projects, setProjects] = useState<ProjectEntry[]>([])
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newPath, setNewPath] = useState('')
  const [creating, setCreating] = useState(false)
  const [createResult, setCreateResult] = useState<{ success: boolean; created: string[]; errors: string[] } | null>(null)

  const loadProjectList = async (): Promise<void> => {
    const list = await window.api.projectsList()
    setProjects(list)
  }

  useEffect(() => {
    loadProjectList()
  }, [])

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

  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold">{t('pages.projects.title')}</h1>
        <Button onClick={() => { setShowCreate(!showCreate); setCreateResult(null) }} variant={showCreate ? 'outline' : 'default'} size="sm">
          <Plus size={16} /> {t('pages.projects.newProject')}
        </Button>
      </div>

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

      {/* Project List */}
      {projects.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            {t('pages.projects.noProjects')}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {projects.map((project) => (
            <Card key={project.path}>
              <CardContent className="p-4 flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium">{project.name}</span>
                    <span className={cn('text-xs px-2 py-0.5 rounded-full border', STATUS_COLORS[project.status] || STATUS_COLORS.uninitialized)}>
                      {t(`pages.projects.status.${project.status}`)}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground font-mono truncate">{toNativePath(project.path)}</div>
                </div>
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
