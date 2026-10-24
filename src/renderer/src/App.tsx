import { useState, useEffect } from 'react'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Sidebar } from './components/Sidebar'
import { StatusBar } from './components/StatusBar'
import { BgccActivityPanel } from './components/BgccActivityPanel'
import { GoldenReconcileDialog } from './components/GoldenReconcileDialog'
import { useTheme } from './hooks/useTheme'
import { useLanguage } from './hooks/useLanguage'
import { startBgccSubscription } from './hooks/useBgccActivity'
import { SetupPage } from './pages/SetupPage'
import { ProjectsPage } from './pages/ProjectsPage'
import { SkillProposalsPage } from './pages/SkillProposalsPage'
import { SkillLifecyclePage } from './pages/SkillLifecyclePage'
import { EnforcementStatsPage } from './pages/EnforcementStatsPage'
import { PxpipeDashboardPage } from './pages/PxpipeDashboardPage'
import { GoldenPromotionPage } from './pages/GoldenPromotionPage'

export type PageId =
  | 'setup'
  | 'projects'
  | 'adoption'
  | 'goldenPromotion'
  | 'skillLifecycle'
  | 'enforcementStats'
  | 'pxpipeDashboard'

/**
 * 開発時のみエラー詳細（message / stack）を画面へ出す。
 * 本番は分類 + 要約 + エラー ID までに留め、詳細は main のログへ回す（修正方針レビュー r5#2）。
 * 例外 message にはローカルパス・URL・IPC 名が入りうるため。
 */
const IS_DEV = import.meta.env.DEV

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
    projectCount: 0
  })
  const [debugMode, setDebugMode] = useState(false)

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
        setDebugMode(config.debugMode ?? false)
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
          window.api.projectsList()
        ])

        const issues = healthResults.filter(
          (item) => item.status === 'warn' || item.status === 'error'
        ).length

        setHealthStatus({
          configured: true,
          issues,
          projectCount: projects.length
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
    const onDebugModeChange = (e: Event): void => {
      const isDebug = (e as CustomEvent<boolean>).detail
      setDebugMode(Boolean(isDebug))
    }
    window.addEventListener('health-refreshed', onRefresh)
    window.addEventListener('debug-mode-changed', onDebugModeChange)
    return () => {
      window.removeEventListener('health-refreshed', onRefresh)
      window.removeEventListener('debug-mode-changed', onDebugModeChange)
    }
  }, [])

  // 画面間の移動の依頼（提案の合成が登録・承認まで進んだとき、Golden 昇格画面を開く）
  // Setup（CCPIT_L0_004 W5）: Golden 昇格画面の「パスワード未登録」の案内から。Setup のナビは完了後に消えるので、
  // RK の「Setup ナビを常に表示」と同じ永続の設定を入れてから移る（戻るのは Setup の完了か、RK のトグルを切ったとき）
  useEffect(() => {
    const onNavigate = (e: Event): void => {
      const detail = (e as CustomEvent<{ page?: PageId; showSetupNav?: boolean }>).detail
      const page = detail?.page
      if (page === 'goldenPromotion' || page === 'adoption') setActivePage(page)
      if (page === 'setup' && detail?.showSetupNav === true) {
        void window.api
          .configSet({ showSetupNav: true })
          .catch(() => undefined)
          .finally(() => {
            setShowSetupNav(true)
            setActivePage('setup')
          })
      }
    }
    window.addEventListener('ccpit:navigate', onNavigate)
    return () => window.removeEventListener('ccpit:navigate', onNavigate)
  }, [])

  // FB02: BG-CC アクティビティ購読（live 先付け → 設定読込 → backlog replay。
  // refcount 化済みのため StrictMode の二重 effect でも listener は1本に保たれる）。
  useEffect(() => startBgccSubscription(), [])

  const renderPage = (): React.JSX.Element => {
    switch (activePage) {
      case 'setup':
        return <SetupPage onSetupCompleted={handleSetupCompleted} />
      case 'projects':
        return <ProjectsPage />
      case 'adoption':
        return <SkillProposalsPage />
      case 'goldenPromotion':
        return <GoldenPromotionPage />
      case 'skillLifecycle':
        return <SkillLifecyclePage />
      case 'enforcementStats':
        return <EnforcementStatsPage />
      case 'pxpipeDashboard':
        return <PxpipeDashboardPage />
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
          debugMode={debugMode}
        />
        {/* PXP ダッシュボードは iframe を最大化したいので、共通の余白とスクロールを外す
            （四辺 24px ＝ 縦横 48px を取り戻す。スクロールは iframe 内部へ一本化）。 */}
        <main
          className={
            activePage === 'pxpipeDashboard'
              ? 'flex-1 overflow-hidden p-0'
              : 'flex-1 overflow-auto p-6'
          }
        >
          {/* ページ境界: 1 ページの障害で shell とナビまで巻き込まない。
              key に activePage を渡し、画面を移動したら境界の状態をリセットする。 */}
          <ErrorBoundary
            key={activePage}
            variant="page"
            showDetail={IS_DEV}
            onReset={() => setActivePage('projects')}
          >
            {renderPage()}
          </ErrorBoundary>
        </main>
      </div>
      <StatusBar healthStatus={healthStatus} />
      {/* FB02: ページ非依存の固定オーバーレイ（開閉状態はモジュールストアが持つ） */}
      <BgccActivityPanel />
      {/* §9.4 / P5: 起動時照合でユーザー判断が要る差分の確認。
          Setup ウィザード中は出さない（配置そのものが進行中で、確認の前提が揃っていない）。 */}
      <GoldenReconcileDialog enabled={activePage !== 'setup'} />
    </>
  )
}

/**
 * ルート。**ここが最後の砦**なので、境界の外側には何も置かない。
 *
 * `app:renderer-ready` は「**ブランクではない UI が描画された**」通知であって
 * 「正常」通知ではない（修正方針レビュー r6#1）。main 側の watchdog は
 * 「空のまま放置されない」ことだけを守るので、ページ境界の fallback が出ている状態も
 * ready として送り、分類だけを分ける。送らないのは「何も描画できていない」ときだけ。
 */
function AppRoot(): React.JSX.Element {
  useEffect(() => {
    // DOM 反映後に送る（render 中・useLayoutEffect では「描画された」の証明にならない）
    try {
      const root = document.getElementById('root')
      if (!root || root.childElementCount === 0) return // 空なら送らない = watchdog を解除しない
      window.api?.rendererReady?.('ok')
    } catch {
      /* 通知できなくても描画は続く。watchdog 側が拾う */
    }
  }, [])

  return (
    <ErrorBoundary variant="root" showDetail={IS_DEV}>
      <App />
    </ErrorBoundary>
  )
}

export default AppRoot
