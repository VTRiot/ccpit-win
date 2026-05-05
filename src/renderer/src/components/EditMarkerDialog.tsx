import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
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
import { ProtocolHistoryList } from './ProtocolHistoryList'
import type { ProtocolMarkerView } from '../lib/protocolBadge'

const STAGE_OPTIONS = ['stable', 'beta', 'alpha', 'experimental'] as const
type Stage = (typeof STAGE_OPTIONS)[number]

const PROTOCOL_SUGGESTIONS = ['manx', 'manx-host', 'asama', 'macau', 'legacy', 'unknown']

export interface EditMarkerSubmit {
  protocol: string
  revision: string
  stage: Stage
  variant: string | null
  variant_alias: string | null
}

interface EditMarkerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** ダイアログを開いた時点の現値。null の場合は新規入力扱い。 */
  current: ProtocolMarkerView | null
  // 034-B (UX 課題 1): 履歴閲覧セクションのため。null の場合は履歴表示しない。
  projectPath: string | null
  onSubmit: (edits: EditMarkerSubmit) => void | Promise<void>
}

export function EditMarkerDialog({
  open,
  onOpenChange,
  current,
  projectPath,
  onSubmit,
}: EditMarkerDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const [protocol, setProtocol] = useState('')
  const [revision, setRevision] = useState('')
  const [stage, setStage] = useState<Stage>('experimental')
  const [variant, setVariant] = useState('')
  const [variantAlias, setVariantAlias] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // ダイアログを開いた時点の現値をフォームに反映（FSA r3 §3-4）
  useEffect(() => {
    if (!open) return
    setProtocol(current?.protocol ?? 'manx')
    setRevision(current?.revision === '?' ? '' : (current?.revision ?? ''))
    setStage((current?.stage as Stage) ?? 'experimental')
    setVariant(current?.variant ?? '')
    setVariantAlias(current?.variant_alias ?? '')
  }, [open, current])

  const handleSave = async (): Promise<void> => {
    if (!protocol.trim()) return
    if (!confirm(t('editMarker.confirmSave'))) return
    setSubmitting(true)
    try {
      await onSubmit({
        protocol: protocol.trim(),
        revision: revision.trim() || '?',
        stage,
        variant: variant.trim() || null,
        variant_alias: variantAlias.trim() || null,
      })
      onOpenChange(false)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('editMarker.dialogTitle')}</DialogTitle>
          <DialogDescription>{t('editMarker.notice')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label>{t('editMarker.fieldProtocol')}</Label>
            <Input
              list="edit-marker-protocol-suggestions"
              value={protocol}
              onChange={(e) => setProtocol(e.target.value)}
              placeholder={PROTOCOL_SUGGESTIONS.join(' / ')}
            />
            <datalist id="edit-marker-protocol-suggestions">
              {PROTOCOL_SUGGESTIONS.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </div>

          <div className="space-y-1">
            <Label>{t('editMarker.fieldRevision')}</Label>
            <Input
              value={revision}
              onChange={(e) => setRevision(e.target.value)}
              placeholder="r5"
            />
          </div>

          <div className="space-y-1">
            <Label>{t('editMarker.fieldStage')}</Label>
            <select
              value={stage}
              onChange={(e) => setStage(e.target.value as Stage)}
              className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
            >
              {STAGE_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <Label>{t('editMarker.fieldVariant')}</Label>
            <Input value={variant} onChange={(e) => setVariant(e.target.value)} />
          </div>

          <div className="space-y-1">
            <Label>{t('editMarker.fieldVariantAlias')}</Label>
            <Input
              value={variantAlias}
              onChange={(e) => setVariantAlias(e.target.value)}
            />
          </div>
        </div>

        {/* 034-B (UX 課題 1): 履歴閲覧セクション */}
        {open && <ProtocolHistoryList projectPath={projectPath} />}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('editMarker.cancelButton')}
          </Button>
          <Button onClick={handleSave} disabled={submitting || !protocol.trim()}>
            {t('editMarker.saveButton')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
