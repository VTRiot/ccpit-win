import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderOpen, Loader2 } from 'lucide-react'
import { Input } from './ui/input'
import { Button } from './ui/button'
import { MultiSelectDialog } from './MultiSelectDialog'
import { toNativePath } from '../lib/utils'

interface DiscoveryCandidate {
  path: string
  name: string
  hasClaudeMd: boolean
  hasCcpitDir: boolean
  alreadyManaged: boolean
}

interface ProjectDiscoveryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported: (paths: string[]) => void
}

export function ProjectDiscoveryDialog({
  open,
  onOpenChange,
  onImported,
}: ProjectDiscoveryDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const [rootPath, setRootPath] = useState('')
  const [scanning, setScanning] = useState(false)
  const [candidates, setCandidates] = useState<DiscoveryCandidate[]>([])

  const handleSelectRoot = async (): Promise<void> => {
    const folder = await window.api.selectFolder()
    if (folder) setRootPath(folder)
  }

  const handleScan = async (): Promise<void> => {
    if (!rootPath.trim()) return
    setScanning(true)
    try {
      const result = await window.api.projectsDiscover(rootPath)
      setCandidates(result)
    } finally {
      setScanning(false)
    }
  }

  const handleConfirm = async (selected: DiscoveryCandidate[]): Promise<void> => {
    if (selected.length === 0) return
    const paths = selected.map((c) => c.path)
    await window.api.projectsImport(paths)
    onImported(paths)
    setCandidates([])
    setRootPath('')
  }

  return (
    <MultiSelectDialog<DiscoveryCandidate>
      open={open}
      onOpenChange={onOpenChange}
      title={t('pages.projects.discover.title')}
      description={t('pages.projects.discover.description')}
      items={candidates}
      getKey={(c) => c.path}
      isDisabled={(c) => c.alreadyManaged}
      confirmLabel={t('pages.projects.discover.import')}
      onConfirm={handleConfirm}
      emptyMessage={t('pages.projects.discover.noResults')}
      toolbarSlot={
        <div className="flex items-center gap-2">
          <Input
            value={rootPath}
            onChange={(e) => setRootPath(e.target.value)}
            placeholder={t('pages.projects.discover.rootPlaceholder')}
            className="flex-1 text-sm font-mono"
          />
          <Button variant="outline" size="sm" onClick={handleSelectRoot} className="gap-1.5">
            <FolderOpen size={14} />
            {t('pages.projects.discover.browse')}
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={handleScan}
            disabled={scanning || !rootPath.trim()}
            className="gap-1.5"
          >
            {scanning && <Loader2 size={14} className="animate-spin" />}
            {t('pages.projects.discover.scan')}
          </Button>
        </div>
      }
      renderItem={(c): React.ReactNode => (
        <div>
          <div className="font-medium text-sm truncate">{c.name}</div>
          <div className="text-xs text-muted-foreground font-mono truncate">
            {toNativePath(c.path)}
          </div>
          <div className="mt-0.5 flex gap-2 text-[10px] text-muted-foreground">
            {c.hasClaudeMd && <span>✓ CLAUDE.md</span>}
            {c.hasCcpitDir && <span>✓ .ccpit</span>}
            {c.alreadyManaged && (
              <span className="text-amber-500">{t('pages.projects.discover.alreadyManaged')}</span>
            )}
          </div>
        </div>
      )}
    />
  )
}
