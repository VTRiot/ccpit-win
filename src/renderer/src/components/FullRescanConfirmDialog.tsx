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

interface FullRescanConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 再判定対象件数（confirmed !== true な PJ の数） */
  targetCount: number
  onConfirm: () => void | Promise<void>
}

/**
 * 034: Full Re-scan の確認ダイアログ。
 * 全 PJ 再判定は破壊的操作のため、対象件数を表示して明示的に確認を求める。
 * confirmed=true の PJ は保護される旨を本文で明示する。
 */
export function FullRescanConfirmDialog({
  open,
  onOpenChange,
  targetCount,
  onConfirm,
}: FullRescanConfirmDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('pages.projects.fullRescanDialog.title')}</DialogTitle>
          <DialogDescription className="whitespace-pre-line">
            {t('pages.projects.fullRescanDialog.body', { count: targetCount })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('pages.projects.fullRescanDialog.cancel')}
          </Button>
          <Button
            onClick={() => {
              void onConfirm()
            }}
          >
            {t('pages.projects.fullRescanDialog.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
