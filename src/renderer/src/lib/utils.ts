import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/** OS ネイティブのパス区切り文字に正規化して表示する */
export function toNativePath(p: string): string {
  if (!p) return p
  const isWindows =
    (typeof window !== 'undefined' && window.electron?.process?.platform === 'win32') ||
    (typeof navigator !== 'undefined' && /Win/i.test(navigator.platform))
  if (isWindows) {
    return p.replace(/\//g, '\\')
  }
  return p.replace(/\\/g, '/')
}
