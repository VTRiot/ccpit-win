import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderOpen } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from './ui/dialog'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'
import {
  buildSpecialEntry,
  pathBasename,
  type SpecialEntryLike,
} from '../lib/specialEntries'

interface SpecialEntryAddDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 既存の特別行（重複判定と id 発番に使う）。 */
  existing: readonly SpecialEntryLike[]
  /** 追加確定時のコールバック。新しい特別行配列全体を渡す（呼び出し側で configSet 永続化）。 */
  onAdd: (next: SpecialEntryLike[]) => void | Promise<void>
}

/**
 * 039 FB③: 特別枠（specialEntries）を UI から追加するダイアログ。
 * path + name の 2 入力に絞った簡素構成。詳細フィールド（addDirs / effort / tabColor /
 * pxpipeEnabled）は従来どおり ~/.ccpit/app-config.json 直編集で足す（ダイアログ肥大回避）。
 * 判定ロジックは lib/specialEntries.ts の純関数へ寄せ、node env の unit test で固定している。
 */
export function SpecialEntryAddDialog({
  open,
  onOpenChange,
  existing,
  onAdd,
}: SpecialEntryAddDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  // name をユーザーが手で編集したら basename 自動補完を止める（意図の尊重）。
  const [nameTouched, setNameTouched] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // 開くたびに入力をリセット（前回値の持ち越しを防ぐ）。
  useEffect(() => {
    if (open) {
      setPath('')
      setName('')
      setNameTouched(false)
      setError(null)
      setSubmitting(false)
    }
  }, [open])

  const handleSelectFolder = async (): Promise<void> => {
    const folder = await window.api.selectFolder()
    if (folder) {
      setPath(folder)
      // name 未編集なら basename で追従補完（表示上の親切）。
      if (!nameTouched) setName(pathBasename(folder))
    }
  }

  const handleAdd = async (): Promise<void> => {
    const result = buildSpecialEntry(existing, path, name)
    if (!result.ok) {
      setError(t(`pages.projects.special.addError.${result.reason}`))
      return
    }
    setSubmitting(true)
    try {
      await onAdd([...existing, result.entry])
      onOpenChange(false)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('pages.projects.special.addDialogTitle')}</DialogTitle>
          <DialogDescription className="whitespace-pre-line">
            {t('pages.projects.special.addDialogDescription')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>{t('pages.projects.projectPath')}</Label>
            <div className="flex gap-2">
              <Input
                value={path}
                onChange={(e) => {
                  setPath(e.target.value)
                  if (!nameTouched) setName(pathBasename(e.target.value))
                  setError(null)
                }}
                className="flex-1 font-mono"
                placeholder="C:\path\to\project"
              />
              <Button variant="outline" onClick={() => void handleSelectFolder()}>
                <FolderOpen size={16} /> {t('pages.projects.selectPath')}
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <Label>{t('pages.projects.projectName')}</Label>
            <Input
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setNameTouched(true)
                setError(null)
              }}
              placeholder={t('pages.projects.projectNamePlaceholder')}
            />
          </div>

          {error && <div className="text-sm text-destructive">{error}</div>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('pages.projects.special.addCancel')}
          </Button>
          <Button onClick={() => void handleAdd()} disabled={submitting || !path.trim()}>
            {t('pages.projects.special.addConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
