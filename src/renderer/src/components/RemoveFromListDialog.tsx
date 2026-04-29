import { useTranslation } from 'react-i18next'
import { MultiSelectDialog } from './MultiSelectDialog'
import { toNativePath } from '../lib/utils'

interface ProjectEntry {
  name: string
  path: string
  status: string
  createdAt: string
}

interface RemoveFromListDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: ProjectEntry[]
  onRemoved: (paths: string[]) => void
}

export function RemoveFromListDialog({
  open,
  onOpenChange,
  projects,
  onRemoved,
}: RemoveFromListDialogProps): React.JSX.Element {
  const { t } = useTranslation()

  const handleConfirm = async (selected: ProjectEntry[]): Promise<void> => {
    if (selected.length === 0) return
    const paths = selected.map((p) => p.path)
    await window.api.projectsRemoveFromList(paths)
    onRemoved(paths)
  }

  return (
    <MultiSelectDialog<ProjectEntry>
      open={open}
      onOpenChange={onOpenChange}
      title={t('pages.projects.removeFromList.title')}
      description={t('pages.projects.removeFromList.description')}
      warning={t('pages.projects.removeFromList.warning')}
      items={projects}
      getKey={(p) => p.path}
      confirmLabel={t('pages.projects.removeFromList.remove')}
      onConfirm={handleConfirm}
      emptyMessage={t('pages.projects.noProjects')}
      renderItem={(p): React.ReactNode => (
        <div>
          <div className="font-medium text-sm truncate">{p.name}</div>
          <div className="text-xs text-muted-foreground font-mono truncate">
            {toNativePath(p.path)}
          </div>
        </div>
      )}
    />
  )
}
