import { useTranslation } from 'react-i18next'
import { Button } from './ui/button'

/**
 * 純 React 製 confirm dialog（shadcn dialog ベース）。
 *
 * 背景:
 *   window.confirm() を使うと Electron WebView の native dialog が表示される。
 *   閉じた後、WebView の focus state machine が壊れて「click では focus 移動しない / Tab では可」
 *   という症状が再現率 100% で発生する (CCPIT v1.3 RecoveryKit→Setup 遷移時に発覚)。
 *
 * 対策: native dialog を完全に使わず、React state + DOM overlay で confirm UI を再実装する。
 *
 * 使い方:
 *   const [open, setOpen] = useState(false)
 *   ...
 *   <Button onClick={() => setOpen(true)}>...</Button>
 *   <ConfirmDialog
 *     open={open}
 *     message="本当に...?"
 *     onConfirm={async () => { setOpen(false); await doSomething() }}
 *     onCancel={() => setOpen(false)}
 *   />
 */
interface ConfirmDialogProps {
  open: boolean
  title?: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  variant?: 'default' | 'destructive'
  onConfirm: () => void | Promise<void>
  onCancel: () => void
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  variant = 'default',
  onConfirm,
  onCancel,
}: ConfirmDialogProps): React.JSX.Element | null {
  const { t } = useTranslation()
  if (!open) return null

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onCancel} />
      <div className="relative bg-card border border-border rounded-lg shadow-lg w-full max-w-md mx-4 flex flex-col">
        {title && (
          <div className="px-6 pt-5 pb-2">
            <h3 className="text-base font-semibold">{title}</h3>
          </div>
        )}
        <div className="px-6 py-4">
          <p className="text-sm text-foreground whitespace-pre-wrap">{message}</p>
        </div>
        <div className="flex gap-2 justify-end px-6 pb-5">
          <Button variant="outline" onClick={onCancel}>
            {cancelLabel ?? t('common.cancel')}
          </Button>
          <Button
            variant={variant === 'destructive' ? 'destructive' : 'default'}
            onClick={() => void onConfirm()}
          >
            {confirmLabel ?? t('common.ok')}
          </Button>
        </div>
      </div>
    </div>
  )
}
