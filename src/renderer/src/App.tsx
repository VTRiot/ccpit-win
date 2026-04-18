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
  const [setupCompleted, setSetupCompleted] = useState(false)
  const { theme, toggleTheme } = useTheme()
  const { language, toggleLanguage } = useLanguage()
  const [healthStatus, setHealthStatus] = useState<HealthStatus>({
    configured: true,
    issues: 0,
    projectCount: 0,
  })

  const resetSetup = async (): Promise<void> => {
    await window.api.configSet({ setupCompleted: false })
    setSetupCompleted(false)
    setActivePage('setup')
  }

  const handleSetupCompleted = (): void => {
    setSetupCompleted(true)
    setActivePage('projects')
  }

  useEffect(() => {
    const runStartupChecks = async (): Promise<void> => {
      try {
        const config = await window.api.configGet()
        if (config.setupCompleted) {
          setSetupCompleted(true)
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
          setupCompleted={setupCompleted}
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
