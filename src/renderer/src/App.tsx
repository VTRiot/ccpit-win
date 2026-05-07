import { useState, useEffect } from 'react'
import { Sidebar } from './components/Sidebar'
import { StatusBar } from './components/StatusBar'
import { useTheme } from './hooks/useTheme'
import { useLanguage } from './hooks/useLanguage'
import { SetupPage } from './pages/SetupPage'
import { ProjectsPage } from './pages/ProjectsPage'

export type PageId = 'setup' | 'projects'

export interface HealthStatus {
  configured: boolean
  issues: number
  projectCount: number
}

function App(): React.JSX.Element {
  const [activePage, setActivePage] = useState<PageId>('setup')
  const [showSetupNav, setShowSetupNav] = useState(false)
  const { theme, toggleTheme } = useTheme()
  const { language, toggleLanguage } = useLanguage()
  const [healthStatus, setHealthStatus] = useState<HealthStatus>({
    configured: true,
    issues: 0,
    projectCount: 0,
  })

  const resetSetup = async (): Promise<void> => {
    // 再 Setup 時は Setup ナビを強制表示にして「ナビ非表示で Setup 不能」を防ぐ
    await window.api.configSet({ setupCompleted: false, showSetupNav: true })
    setShowSetupNav(true)
    setActivePage('setup')
  }

  const handleSetupCompleted = async (): Promise<void> => {
    // Setup 完了時に Setup ナビを自動非表示。完了済ユーザーは Maintenance > RK のトグルで再表示可能。
    // setupCompleted=true は Wizard 側で既に configSet 済 (FreshStartWizard.tsx:54 / MigrationWizard.tsx:161)
    await window.api.configSet({ showSetupNav: false })
    setShowSetupNav(false)
    setActivePage('projects')
  }

  const handleToggleShowSetupNav = async (next: boolean): Promise<void> => {
    await window.api.configSet({ showSetupNav: next })
    setShowSetupNav(next)
    if (!next && activePage === 'setup') {
      setActivePage('projects')
    }
  }

  useEffect(() => {
    const runStartupChecks = async (): Promise<void> => {
      try {
        const config = await window.api.configGet()
        // 永続化値を絶対尊重 (強制矯正なし)。
        // activePage 起動時遷移条件: setupCompleted=true、または showSetupNav=false (ユーザー意図的に Setup ナビ非表示で運用中)。
        // 残り (setupCompleted=false かつ showSetupNav=true) は初期値 'setup' のまま = 新規ユーザー Setup 画面。
        // showSetupNav=false で起動した場合の Setup 復活経路: Settings → Maintenance → Recovery Kit タブのトグル ON。
        setShowSetupNav(config.showSetupNav)
        if (config.setupCompleted || !config.showSetupNav) {
          setActivePage('projects')
        }

        // Check if configured
        const existing = await window.api.goldenCheckExisting()
        if (!existing.hasSettings) {
          setHealthStatus({ configured: false, issues: 0, projectCount: 0 })
          return
        }

        // Run health check + get project count
        const [healthResults, projects] = await Promise.all([
          window.api.healthCheck(),
          window.api.projectsList(),
        ])

        const issues = healthResults.filter(
          (item) => item.status === 'warn' || item.status === 'error'
        ).length

        setHealthStatus({
          configured: true,
          issues,
          projectCount: projects.length,
        })
      } catch {
        // Silently fail on startup check
      }
    }

    runStartupChecks()

    const onRefresh = (e: Event): void => {
      const issues = (e as CustomEvent<{ issues: number }>).detail.issues
      setHealthStatus((prev) => ({ ...prev, issues }))
    }
    window.addEventListener('health-refreshed', onRefresh)
    return () => window.removeEventListener('health-refreshed', onRefresh)
  }, [])

  const renderPage = (): React.JSX.Element => {
    switch (activePage) {
      case 'setup':
        return <SetupPage onSetupCompleted={handleSetupCompleted} />
      case 'projects':
        return <ProjectsPage />
    }
  }

  return (
    <>
      <div className="flex flex-1 min-h-0">
        <Sidebar
          activePage={activePage}
          onNavigate={setActivePage}
          theme={theme}
          onToggleTheme={toggleTheme}
          language={language}
          onToggleLanguage={toggleLanguage}
          showSetupNav={showSetupNav}
          onToggleShowSetupNav={handleToggleShowSetupNav}
          onResetSetup={resetSetup}
        />
        <main className="flex-1 overflow-auto p-6">
          {renderPage()}
        </main>
      </div>
      <StatusBar healthStatus={healthStatus} />
    </>
  )
}

export default App
