import { useEffect } from 'react'
import { Check } from 'lucide-react'
import { cn } from '../../lib/utils'

interface ToastProps {
  open: boolean
  message: string
  onClose: () => void
  durationMs?: number
}

const DEFAULT_DURATION_MS = 2000

export function Toast({ open, message, onClose, durationMs = DEFAULT_DURATION_MS }: ToastProps): React.JSX.Element | null {
  useEffect(() => {
    if (!open) return
    const id = setTimeout(onClose, durationMs)
    return () => clearTimeout(id)
  }, [open, durationMs, onClose])

  if (!open) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'fixed bottom-6 left-1/2 -translate-x-1/2 z-50',
        'flex items-center gap-2 rounded-md border border-green-600/50 bg-green-600 text-white',
        'px-4 py-2 text-sm font-medium shadow-lg',
        'animate-in fade-in slide-in-from-bottom-2'
      )}
    >
      <Check size={16} />
      <span>{message}</span>
    </div>
  )
}
