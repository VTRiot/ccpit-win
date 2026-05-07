import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, RefreshCw, Loader2, AlertTriangle } from 'lucide-react'
import { Button } from '../components/ui/button'
import { Card, CardContent } from '../components/ui/card'
import { cn } from '../lib/utils'
import { McpServerCard } from '../components/mcp/McpServerCard'
import { McpEditDialog, type McpEditValue } from '../components/mcp/McpEditDialog'

type Scope = 'global' | 'project'

interface McpServerEntry {
  name: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  type?: 'stdio' | 'sse' | 'http'
  url?: string
  headers?: Record<string, string>
  disabledTools?: string[]
}

interface ProjectListItem {
  name: string
  path: string
}

export function McpPage(): React.JSX.Element {
  const { t } = useTranslation()
  const [scope, setScope] = useState<Scope>('global')
  const [cliAvailable, setCliAvailable] = useState<boolean | null>(null)
  const [projects, setProjects] = useState<ProjectListItem[]>([])
  const [selectedProject, setSelectedProject] = useState<string>('')
  const [servers, setServers] = useState<McpServerEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editTarget, setEditTarget] = useState<McpServerEntry | null>(null)
  const [editOpen, setEditOpen] = useState(false)

  // CLI 可否確認 + プロジェクト一覧取得
  useEffect(() => {
    void window.api.mcpCheckCli().then(setCliAvailable)
    void window.api.projectsList().then((list) => {
      setProjects(list.map((p) => ({ name: p.name, path: p.path })))
    })
  }, [])

  const refresh = useCallback(async () => {
    if (scope === 'project' && !selectedProject) {
      setServers([])
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    const args =
      scope === 'project' && selectedProject
        ? { scope, projectPath: selectedProject }
        : { scope }
    const res = await window.api.mcpListServers(args)
    if (res.ok) {
      setServers(res.servers)
    } else {
      setServers([])
      setError(res.error)
    }
    setLoading(false)
  }, [scope, selectedProject])

  // scope / project 変更時の自動再読込（refresh 内で early-return も処理）。
  // refresh ボタンと共有のため refresh callback を再利用する設計。
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
  }, [refresh])

  const handleAdd = (): void => {
    setEditTarget(null)
    setEditOpen(true)
  }

  const handleEdit = (server: McpServerEntry): void => {
    setEditTarget(server)
    setEditOpen(true)
  }

  const handleRemove = useCallback(
    async (name: string) => {
      if (!confirm(t('pages.mcp.confirmRemove', { name }))) return
      const args =
        scope === 'project' && selectedProject
          ? { scope, name, projectPath: selectedProject }
          : { scope, name }
      const res = await window.api.mcpRemoveServer(args)
      if (!res.ok) {
        setError(res.error ?? 'unknown error')
        return
      }
      await refresh()
    },
    [scope, selectedProject, refresh, t]
  )

  const handleSave = useCallback(
    async (value: McpEditValue) => {
      const projectPath = scope === 'project' ? selectedProject : undefined
      // Replace 動作: 同名 server 既存ならまず remove → 再 add で更新を表現
      if (editTarget && editTarget.name === value.name) {
        const removeRes = await window.api.mcpRemoveServer({
          scope,
          name: editTarget.name,
          projectPath
        })
        if (!removeRes.ok) {
          setError(removeRes.error ?? 'remove failed')
          return
        }
      }
      const addRes = await window.api.mcpAddServer({
        scope,
        server: value,
        projectPath
      })
      if (!addRes.ok) {
        setError(addRes.error ?? 'add failed')
        return
      }
      setEditOpen(false)
      await refresh()
    },
    [scope, selectedProject, editTarget, refresh]
  )

  const projectScopeReady = scope === 'global' || (scope === 'project' && !!selectedProject)
  const writesDisabled = cliAvailable === false

  return (
    <div className="max-w-5xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">{t('pages.mcp.title')}</h1>
        <Button onClick={refresh} disabled={loading || !projectScopeReady} size="sm" variant="outline">
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          <span className="ml-1">{t('pages.mcp.refresh')}</span>
        </Button>
      </div>

      {writesDisabled && (
        <Card>
          <CardContent className="py-3 flex items-start gap-2 text-sm text-yellow-600 dark:text-yellow-400">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <span>{t('pages.mcp.cliMissing')}</span>
          </CardContent>
        </Card>
      )}

      {/* sub-tabs: Global / Project */}
      <div className="flex border-b border-border">
        {(['global', 'project'] as Scope[]).map((s) => (
          <button
            key={s}
            onClick={() => setScope(s)}
            className={cn(
              'px-4 py-2 text-sm border-b-2 transition-colors',
              scope === s
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {t(s === 'global' ? 'pages.mcp.subtab.global' : 'pages.mcp.subtab.project')}
          </button>
        ))}
      </div>

      {scope === 'project' && (
        <div className="flex items-center gap-2">
          <label className="text-sm text-muted-foreground">{t('pages.mcp.selectProject')}</label>
          <select
            value={selectedProject}
            onChange={(e) => setSelectedProject(e.target.value)}
            className="bg-background border border-border rounded px-2 py-1 text-sm"
          >
            <option value="">{t('pages.mcp.notSelected')}</option>
            {projects.map((p) => (
              <option key={p.path} value={p.path}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {scope === 'project' && !selectedProject && (
        <div className="text-sm text-muted-foreground border border-dashed border-border rounded p-6 text-center">
          {t('pages.mcp.selectProjectHint')}
        </div>
      )}

      {projectScopeReady && (
        <>
          {error && (
            <div className="text-sm text-destructive border border-destructive/50 rounded p-3 whitespace-pre-wrap">
              {error}
            </div>
          )}

          {!loading && servers.length === 0 && (
            <div className="text-sm text-muted-foreground border border-dashed border-border rounded p-6 text-center">
              {t('pages.mcp.noServers')}
            </div>
          )}

          <div className="space-y-2">
            {servers.map((srv) => (
              <McpServerCard
                key={srv.name}
                server={srv}
                onEdit={() => handleEdit(srv)}
                onRemove={() => handleRemove(srv.name)}
                disabled={writesDisabled}
              />
            ))}
          </div>

          <div>
            <Button onClick={handleAdd} disabled={writesDisabled} size="sm">
              <Plus size={14} className="mr-1" />
              {t('pages.mcp.addServer')}
            </Button>
          </div>
        </>
      )}

      <McpEditDialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        initial={editTarget}
        onSave={handleSave}
      />
    </div>
  )
}
