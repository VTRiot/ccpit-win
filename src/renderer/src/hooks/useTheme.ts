import { useState, useEffect } from 'react'

type Theme = 'dark' | 'light'

const STORAGE_KEY = 'ccpit-theme'

export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored === 'light' ? 'light' : 'dark'
  })

  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
    localStorage.setItem(STORAGE_KEY, theme)
  }, [theme])

  // 初回マウント時にデフォルトで dark を適用
  useEffect(() => {
    if (!localStorage.getItem(STORAGE_KEY)) {
      document.documentElement.classList.add('dark')
    }
  }, [])

  const toggleTheme = (): void => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))
  }

  return { theme, toggleTheme }
}
