import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from './ui/dialog'
import { Checkbox } from './ui/checkbox'
import { Button } from './ui/button'
import { cn } from '../lib/utils'

export interface MultiSelectDialogProps<T> {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  warning?: string
  items: T[]
  getKey: (item: T) => string
  isDisabled?: (item: T) => boolean
  renderItem: (item: T, checked: boolean) => React.ReactNode
  confirmLabel: string
  cancelLabel?: string
  onConfirm: (selected: T[]) => void | Promise<void>
  emptyMessage?: string
  toolbarSlot?: React.ReactNode
}

export function MultiSelectDialog<T>({
  open,
  onOpenChange,
  title,
  description,
  warning,
  items,
  getKey,
  isDisabled,
  renderItem,
  confirmLabel,
  cancelLabel,
  onConfirm,
  emptyMessage,
  toolbarSlot,
}: MultiSelectDialogProps<T>): React.JSX.Element {
  const { t } = useTranslation()
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [submitting, setSubmitting] = useState(false)

  // dialog が閉じる/開くとき、選択を初期化
  useEffect(() => {
    if (!open) setSelectedKeys(new Set())
  }, [open])

  const selectableItems = useMemo(
    () => items.filter((item) => !isDisabled?.(item)),
    [items, isDisabled]
  )

  const handleToggle = (key: string, checked: boolean): void => {
    setSelectedKeys((prev) => {
      const next = new Set(prev)
      if (checked) next.add(key)
      else next.delete(key)
      return next
    })
  }

  const handleSelectAll = (): void => {
    setSelectedKeys(new Set(selectableItems.map(getKey)))
  }

  const handleDeselectAll = (): void => {
    setSelectedKeys(new Set())
  }

  const handleConfirm = async (): Promise<void> => {
    setSubmitting(true)
    try {
      const selected = items.filter((item) => selectedKeys.has(getKey(item)))
      await onConfirm(selected)
      onOpenChange(false)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
          {warning && (
            <div className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-600">
              {warning}
            </div>
          )}
        </DialogHeader>

        {toolbarSlot}

        {/* Select All / Deselect All */}
        <div className="flex items-center gap-2 text-xs">
          <Button variant="outline" size="sm" onClick={handleSelectAll} disabled={selectableItems.length === 0}>
            {t('common.selectAll')}
          </Button>
          <Button variant="outline" size="sm" onClick={handleDeselectAll} disabled={selectedKeys.size === 0}>
            {t('common.deselectAll')}
          </Button>
          <span className="ml-auto text-muted-foreground">
            {t('common.selectedCount', { selected: selectedKeys.size, total: items.length })}
          </span>
        </div>

        {/* Item list */}
        <div className="max-h-[50vh] overflow-auto space-y-1 border border-border rounded-md p-2">
          {items.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              {emptyMessage ?? t('common.noItems')}
            </div>
          ) : (
            items.map((item) => {
              const key = getKey(item)
              const disabled = isDisabled?.(item) ?? false
              const checked = selectedKeys.has(key)
              return (
                <label
                  key={key}
                  className={cn(
                    'flex items-start gap-3 rounded-sm px-2 py-1.5 cursor-pointer',
                    disabled
                      ? 'opacity-50 cursor-not-allowed'
                      : 'hover:bg-accent/40',
                    checked && !disabled && 'bg-accent/30'
                  )}
                >
                  <Checkbox
                    checked={checked}
                    disabled={disabled}
                    onCheckedChange={(v) => handleToggle(key, v === true)}
                    className="mt-0.5"
                  />
                  <div className="flex-1 min-w-0">{renderItem(item, checked)}</div>
                </label>
              )
            })
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {cancelLabel ?? t('common.cancel')}
          </Button>
          <Button onClick={handleConfirm} disabled={submitting || selectedKeys.size === 0}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
