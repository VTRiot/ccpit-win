import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Plus,
  FolderOpen,
  Trash2,
  Check,
  X,
  Loader2,
  ExternalLink,
  Search,
  ListMinus,
  RefreshCw,
  RotateCw,
  Star,
  ChevronDown,
  Clipboard,
  Plug,
  Pin,
  FolderPlus,
} from 'lucide-react'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Checkbox } from '../components/ui/checkbox'
import { Toast } from '../components/ui/toast'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '../components/ui/dropdown-menu'
import { LaunchMenu } from '../components/LaunchMenu'
import { FableLaunchButton } from '../components/FableLaunchButton'
import { ProjectDiscoveryDialog } from '../components/ProjectDiscoveryDialog'
import { RemoveFromListDialog } from '../components/RemoveFromListDialog'
import { ProtocolBadge, type ProtocolMarkerView } from '../components/ProtocolBadge'
import { EditMarkerDialog, type EditMarkerSubmit } from '../components/EditMarkerDialog'
import { FullRescanConfirmDialog } from '../components/FullRescanConfirmDialog'
import { CcRestartConfirmDialog } from '../components/CcRestartConfirmDialog'
import { SpecialEntryAddDialog } from '../components/SpecialEntryAddDialog'

// preload の検出戻り型を api から導出（型重複を避ける）
type CcDetectResult = Awaited<ReturnType<typeof window.api.ccListSessions>>
type CcDetectSummary = Extract<CcDetectResult, { ok: true }>['summary']
import { useFeatureFlag } from '../hooks/useFeatureFlag'
import { cn, toNativePath } from '../lib/utils'
import {
  applyProjectsView,
  loadProjectsViewState,
  saveProjectsViewState,
  SORT_MODES,
  type ProjectsViewState,
  type SortMode,
} from '../lib/projectsView'
import { isCcesEnabled, CCES_CONFIG_CHANGED_EVENT } from '../lib/ccesEnabled'
import { pruneLaunchOptionsIfOrphan, remainingAfterRemoval } from '../lib/launchOptions'
import {
  removeSpecialEntry,
  planProjectRows,
  rowPrimaryPath,
  unmergedSpecialPaths,
  resolveRowPxpipeEnabled,
  resolveRowPxpipeMode,
  buildRowPxpipeToggle,
  resolveRowOverrides,
  resolveProjectsEmptyState,
  type SpecialRow
} from '../lib/specialEntries'

// 038 Feature B: 特別行エントリの view 型（preload の configGet 戻りから導出・型重複回避）
type AppConfigView = Awaited<ReturnType<typeof window.api.configGet>>
type SpecialEntryView = NonNullable<AppConfigView['specialEntries']>[number]

interface ProjectEntry {
  name: string
  path: string
  createdAt: string
  favorite?: boolean
  pxpipeEnabled?: boolean
  external?: boolean
  location_type?: string
  // 034-B: confirmed 廃止。明示意思は protocol.json の history (append-only event log) に統合。
}

// 036/037: CCES Generate ボタン。039 Feature B で特別行にも配線するため、通常行の
// インライン IIFE から挙動不変のまま抽出した共用コンポーネント（enable × busy で
// disabled / tooltip を切替。スタイル・文言・判定は 036/037 実装のまま）。
function CcesGenerateButton({
  enabled,
  busy,
  onGenerate
}: {
  enabled: boolean
  busy: boolean
  onGenerate: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={busy || !enabled}
      onClick={onGenerate}
      title={t(enabled ? 'pages.projects.cces.tooltip' : 'pages.projects.cces.disabledTooltip')}
      className={cn(
        'gap-1.5',
        enabled
          ? 'bg-[hsl(180_55%_42%)] hover:bg-[hsl(180_55%_50%)] text-white border-[hsl(180_55%_42%)]'
          : 'opacity-40',
      )}
    >
      {busy ? <Loader2 size={14} className="animate-spin" /> : <Clipboard size={14} />}
      {t('pages.projects.cces.generate')}
    </Button>
  )
}

export function ProjectsPage(): React.JSX.Element {
  const { t } = useTranslation()
  const showLaunchButton = useFeatureFlag('ccLaunchButton')
  const showDetectLinkRemove = useFeatureFlag('detectLinkRemove')
  const showProtocolBadge = useFeatureFlag('protocolBadge')
  const autoMarkingEnabled = useFeatureFlag('autoMarking')
  const showFavorite = useFeatureFlag('favoriteToggle')
  const showPxpipe = useFeatureFlag('pxpipeToggle')
  const showEditMarkerUI = useFeatureFlag('editMarkerUI')
  const [projects, setProjects] = useState<ProjectEntry[]>([])
  const [showCreate, setShowCreate] = useState(false)
  const [showDiscover, setShowDiscover] = useState(false)
  const [showRemoveFromList, setShowRemoveFromList] = useState(false)
  const [newName, setNewName] = useState('')
  const [newPath, setNewPath] = useState('')
  const [creating, setCreating] = useState(false)
  const [createResult, setCreateResult] = useState<{ success: boolean; created: string[]; errors: string[] } | null>(null)
  const [launchMessage, setLaunchMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [markers, setMarkers] = useState<Record<string, ProtocolMarkerView | null>>({})
  const [scanningMarkers, setScanningMarkers] = useState(false)
  const [editMarkerOpen, setEditMarkerOpen] = useState(false)
  const [editingPath, setEditingPath] = useState<string | null>(null)
  const [viewState, setViewState] = useState<ProjectsViewState>(() => loadProjectsViewState())
  // 034-B: 2 マイグレーション通知を結合表示するため message 形式に変更
  const [migrationToast, setMigrationToast] = useState<{ open: boolean; message: string }>({
    open: false,
    message: '',
  })
  // 034-B (UX 課題 3): 各 PJ の「手動編集済み」判定情報。ProtocolBadge アイコン表示と Tooltip 用
  const [historyMeta, setHistoryMeta] = useState<
    Record<string, { hasManual: boolean; lastManualAt: string | null; historyCount: number }>
  >({})
  // 034 + 034-B: Full Re-scan 用の状態（changed/unchanged 追加）
  const [fullRescanDialogOpen, setFullRescanDialogOpen] = useState(false)
  const [fullRescanToast, setFullRescanToast] = useState<{
    open: boolean
    kind: 'success' | 'error'
    processed: number
    skipped: number
    failed: number
    changed: number
    unchanged: number
  }>({
    open: false,
    kind: 'success',
    processed: 0,
    skipped: 0,
    failed: 0,
    changed: 0,
    unchanged: 0,
  })

  // 検出 + DELEGATE generation 再起動の状態
  const [ccRestartDialogOpen, setCcRestartDialogOpen] = useState(false)
  const [ccRestartSummary, setCcRestartSummary] = useState<CcDetectSummary | null>(null)
  const [ccRestartInFlight, setCcRestartInFlight] = useState(false)
  const [ccRestartToast, setCcRestartToast] = useState<{
    open: boolean
    kind: 'success' | 'error' | 'warning'
    message: string
  }>({ open: false, kind: 'success', message: '' })

  // 再起動ボタン: 活性 CC を CIM 全列挙で検出して確認ダイアログを開く。
  // 列挙失敗（ok:false）は fail-visible でエラー表示し、空＝green に潰さない。
  const handleCcRestartOpen = async (): Promise<void> => {
    try {
      const result = await window.api.ccListSessions()
      if (!result.ok) {
        setCcRestartToast({
          open: true,
          kind: 'error',
          message: t('pages.projects.ccRestart.detectError', { error: result.error }),
        })
        return
      }
      setCcRestartSummary(result.summary)
      setCcRestartDialogOpen(true)
    } catch (e) {
      console.error('ccListSessions error:', e)
      setCcRestartToast({
        open: true,
        kind: 'error',
        message: t('pages.projects.ccRestart.error'),
      })
    }
  }

  // 確認後の実行: settings generation を +1（DIRECT kill なし）。各 CC は次の Stop 到達時に
  // 自己再起動する＝「キュー投入」であり「再起動完了」ではない（Codex High）。
  const executeCcRestart = async (): Promise<void> => {
    setCcRestartDialogOpen(false)
    setCcRestartInFlight(true)
    try {
      const result = await window.api.ccRestartAll()
      if (!result.ok) {
        setCcRestartToast({ open: true, kind: 'error', message: result.error })
        return
      }
      // pxpipe ensure 失敗の可視化（007 調整#2 / Juiz 追補①）。restart 自体は成功しているので
      //   kind は warning（amber）に留め、警告文を併記する（error 赤にはしない＝quiet no-op を排除）。
      const pxpipeWarn = result.pxpipeWarning
      const withWarn = (base: string): string =>
        pxpipeWarn
          ? `${base}\n${t('pages.projects.ccRestart.pxpipeWarn', { reason: pxpipeWarn })}`
          : base
      // bump 成功後の detect 失敗は partial-success（generation は上がっている）。
      if (result.summary === null) {
        setCcRestartToast({
          open: true,
          kind: pxpipeWarn ? 'warning' : 'success',
          message: withWarn(
            t('pages.projects.ccRestart.queuedPartial', {
              generation: result.generation,
              error: result.detectError ?? '',
            })
          ),
        })
        return
      }
      setCcRestartToast({
        open: true,
        kind: pxpipeWarn ? 'warning' : 'success',
        message: withWarn(
          t('pages.projects.ccRestart.queued', {
            generation: result.generation,
            total: result.summary.total,
            resolved: result.summary.resolved,
            resumeOnly: result.summary.resumeOnly,
            unresolved: result.summary.unresolved,
          })
        ),
      })
    } catch (e) {
      console.error('ccRestartAll error:', e)
      setCcRestartToast({ open: true, kind: 'error', message: t('pages.projects.ccRestart.error') })
    } finally {
      setCcRestartInFlight(false)
    }
  }

  useEffect(() => {
    saveProjectsViewState(viewState)
  }, [viewState])

  const handleLaunched = (result: { shell: string; spawned: boolean; error?: string }): void => {
    if (result.spawned) {
      setLaunchMessage({ kind: 'ok', text: t('pages.projects.launch.successWith', { shell: result.shell }) })
    } else {
      setLaunchMessage({ kind: 'err', text: result.error ?? t('pages.projects.launch.error') })
    }
    setTimeout(() => setLaunchMessage(null), 3000)
  }

  // 036: CCES Generate. Per-project click → calls main with that project's path.
  const [ccesBusy, setCcesBusy] = useState<string | null>(null)
  // 037 Phase 2-B: CCES 有効性スイッチ（cces.allowAllProjects）の現在値。
  // - false (既定): manx / manx-host のみボタン enable、他は灰抜き
  // - true: 全 PJ enable（MaintenanceDialog の CCES Advanced タブで切替）
  const [ccesAllowAll, setCcesAllowAll] = useState<boolean>(false)
  // 038 Feature B: ピン留め特別行（config specialEntries 駆動）。既定 [] = 行なし。
  const [specialEntries, setSpecialEntries] = useState<SpecialEntryView[]>([])
  // 039 FB③: 特別枠追加ダイアログの開閉。
  const [showAddSpecial, setShowAddSpecial] = useState(false)
  useEffect(() => {
    const refetch = async (): Promise<void> => {
      try {
        const cfg = await window.api.configGet()
        setCcesAllowAll(cfg.cces?.allowAllProjects ?? false)
        setSpecialEntries(cfg.specialEntries ?? [])
      } catch {
        /* keep current value */
      }
    }
    void refetch()
    window.addEventListener(CCES_CONFIG_CHANGED_EVENT, refetch)
    return () => window.removeEventListener(CCES_CONFIG_CHANGED_EVENT, refetch)
  }, [])

  /**
   * 044: 特別行を**唯一の描画サイト**にする。特別行に載っているパスは通常行から除外する。
   *
   * `applyProjectsView` に渡すのは生の `projects` ではなく `rowPlan.normalProjects`。
   * ⚠ 一方で **prune の残存判定には dedupe 前の `projects` を渡し続けること**（下の
   * `handleRemoveSpecialEntry` / `handleRemove` / 一括削除）。dedupe 後を渡すと「もう居ない」と
   * 誤認して、まだ生きている行の起動オプションのバケツを消す（`launchOptions.ts` の
   * `remainingAfterRemoval` doc が明記する危険な向き。回帰テストで固定済み）。
   *
   * `useMemo` は使わない（既存の `visibleProjects` も毎レンダ計算）。そのぶん `rowPlan` は毎レンダ
   * 新オブジェクトになるため、**useEffect の依存配列に渡してはいけない**（無限ループになる）。
   * effect 内では `planProjectRows` を呼び直す。
   */
  const rowPlan = planProjectRows(specialEntries, projects)
  const visibleProjects = applyProjectsView(rowPlan.normalProjects, viewState)
  const emptyState = resolveProjectsEmptyState({
    specialRowCount: rowPlan.specialRows.length,
    normalCount: rowPlan.normalProjects.length,
    visibleNormalCount: visibleProjects.length
  })
  type Row = SpecialRow<SpecialEntryView, ProjectEntry>

  // 044: 行ごとの派生値を JSX の外で確定させる。
  // - merged  = 同一パスが projects.json にも在る（＝統合行）
  // - rowPath = marker / historyMeta / CCES / 主プロセス書込の**唯一のキー**（rowPrimaryPath の doc 参照）
  // - pxpipeOn= 表示用の実効値（主プロセスの OR 意味論の写し）
  const specialRowViews = rowPlan.specialRows.map((row) => ({
    row,
    entry: row.entry,
    merged: row.project !== null,
    rowPath: rowPrimaryPath(row),
    pxpipeOn: resolveRowPxpipeEnabled(row)
  }))

  /**
   * 044: 行単位の pxpipe トグル（統合行・未統合行の両方を担う）。
   *
   * 表示値が OR（`resolveRowPxpipeEnabled`）なので、統合行では書込先が 2 経路になりうる。
   * 片側だけ書くと「OFF にしたのに OR が残って消せない」「降格したら ON が黙って消える」の
   * どちらかが起きる（`buildRowPxpipeToggle` の doc 参照）。
   *
   * 通常行側は必ず `project.path` の生文字列で書く。主プロセスの `setPxpipeEnabled` は
   * `p.path === projectPath` の**完全一致**で、外すと**沈黙 no-op**（`projects.ts:279`）。
   *
   * 2 経路のうち片方だけ永続化されて他方が失敗した場合、UI を推測で辻褄合わせしない。
   * 旧値へ戻したうえで **両ストアを読み直す**（`finally`）＝表示は必ず永続値に一致し、
   * ユーザーには「トグルが効かなかった」ことが見える。043 の read-back 原則と同型。
   */
  const handleToggleRowPxpipe = async (row: Row): Promise<void> => {
    const { next, nextEntries, specialChanged, projectWritePath } = buildRowPxpipeToggle(
      specialEntries,
      row
    )
    const prevEntries = specialEntries
    const prevProjects = projects

    if (specialChanged) setSpecialEntries(nextEntries as SpecialEntryView[])
    if (projectWritePath !== null) {
      setProjects((ps) =>
        ps.map((p) => (p.path === projectWritePath ? { ...p, pxpipeEnabled: next } : p))
      )
    }

    try {
      if (projectWritePath !== null) {
        await window.api.projectsSetPxpipeEnabled(projectWritePath, next)
      }
      if (specialChanged) {
        await window.api.configSet({ specialEntries: nextEntries as SpecialEntryView[] })
      }
    } catch {
      setSpecialEntries(prevEntries)
      setProjects(prevProjects)
      setLaunchMessage({ kind: 'err', text: t('pages.projects.pxpipe.toggleError') })
      setTimeout(() => setLaunchMessage(null), 3000)
    } finally {
      await Promise.allSettled([
        loadProjectList(),
        window.api.configGet().then((cfg) => setSpecialEntries(cfg.specialEntries ?? []))
      ])
    }
  }

  // 039 FB②: 特別行の「削除」= specialEntries から当該 id を除去して config:set で永続化。
  // projects.json・実フォルダ・.ccpit/protocol.json（marker）には一切触れない。
  // 044: 統合行では「削除」ではなく**降格**（通常行として再表示される）。confirm 文言を分ける。
  const handleRemoveSpecialEntry = async (row: Row): Promise<void> => {
    const entry = row.entry
    const confirmKey =
      row.project !== null
        ? 'pages.projects.special.removeConfirmMerged'
        : 'pages.projects.special.removeConfirm'
    if (!confirm(t(confirmKey, { name: entry.name }))) return
    const prev = specialEntries
    const next = removeSpecialEntry(prev, entry.id)
    setSpecialEntries(next)
    try {
      await window.api.configSet({ specialEntries: next })
      // 043: 永続化に成功したときだけ起動オプションのバケツも捨てる（巻き戻し時に消さないため）。
      // 同一パスの通常行が残っているなら捨てない（handleRemove と同じ理由）。
      pruneLaunchOptionsIfOrphan(entry.path, [
        ...next.map((s) => s.path),
        ...projects.map((p) => p.path)
      ])
    } catch {
      setSpecialEntries(prev)
    }
  }

  // 039 FB③: 特別枠追加ダイアログからの確定。純関数 buildSpecialEntry が組んだ次配列を受け取り、
  // config:set で永続化する（楽観更新 + 失敗時巻き戻し）。
  const handleAddSpecialEntry = async (next: SpecialEntryView[]): Promise<void> => {
    const prev = specialEntries
    setSpecialEntries(next)
    try {
      await window.api.configSet({ specialEntries: next })
    } catch {
      setSpecialEntries(prev)
    }
  }

  const handleCcesGenerate = async (projectPath: string, projectName: string): Promise<void> => {
    setCcesBusy(projectPath)
    try {
      const result = await window.api.ccesGenerate({ projectPath })
      if (result.ok) {
        const kb = (result.bytes / 1024).toFixed(1)
        if (result.oversized) {
          setLaunchMessage({
            kind: 'err',
            text: t('pages.projects.cces.oversizedWarning', { project: projectName, size: kb }),
          })
        } else {
          setLaunchMessage({
            kind: 'ok',
            text: t('pages.projects.cces.copied', { project: projectName, size: kb }),
          })
        }
      } else {
        setLaunchMessage({
          kind: 'err',
          text: t('pages.projects.cces.error', { reason: result.error }),
        })
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      setLaunchMessage({ kind: 'err', text: t('pages.projects.cces.error', { reason }) })
    } finally {
      setCcesBusy(null)
      setTimeout(() => setLaunchMessage(null), 3000)
    }
  }

  const loadProjectList = async (): Promise<void> => {
    const list = await window.api.projectsList()
    setProjects(list)
  }

  // 034-B: 各 PJ の hasManualEntry / lastManualAt / historyCount を取得
  const fetchHistoryMeta = useCallback(async (paths: string[]): Promise<void> => {
    if (paths.length === 0) return
    const results = await Promise.all(
      paths.map(async (p) => {
        try {
          const r = await window.api.protocolHasManualEntry(p)
          return [p, r] as const
        } catch {
          return [p, { hasManual: false, lastManualAt: null, historyCount: 0 }] as const
        }
      })
    )
    setHistoryMeta((prev) => {
      const next = { ...prev }
      for (const [path, meta] of results) {
        next[path] = meta
      }
      return next
    })
  }, [])

  const scanMarkers = useCallback(
    async (paths: string[], allowAutoWrite: boolean): Promise<void> => {
      if (paths.length === 0) return
      setScanningMarkers(true)
      try {
        const results = await Promise.all(
          paths.map(async (p) => {
            try {
              if (allowAutoWrite) {
                const r = await window.api.protocolAutoMark(p)
                return [p, r.marker as ProtocolMarkerView] as const
              }
              const m = (await window.api.protocolRead(p)) as ProtocolMarkerView | null
              return [p, m] as const
            } catch {
              return [p, null] as const
            }
          })
        )
        setMarkers((prev) => {
          const next = { ...prev }
          for (const [path, marker] of results) {
            next[path] = marker
          }
          return next
        })
      } finally {
        setScanningMarkers(false)
      }
    },
    []
  )

  useEffect(() => {
    void (async (): Promise<void> => {
      await loadProjectList()
      // 034-B: 2 マイグレーション通知を取得して結合
      const createdAtNotice = await window.api.projectsConsumeMigrationNotice()
      const historyNotice = await window.api.projectsConsumeProtocolHistoryMigrationNotice()
      const messages: string[] = []
      if (createdAtNotice && createdAtNotice.migrated > 0) {
        messages.push(
          t('pages.projects.migration.createdAtUpdated', { count: createdAtNotice.migrated })
        )
      }
      if (historyNotice && historyNotice.migrated > 0) {
        messages.push(
          t('pages.projects.migration.protocolHistoryV2', { count: historyNotice.migrated })
        )
      }
      if (messages.length > 0) {
        setMigrationToast({ open: true, message: messages.join('\n') })
      }
    })()
  }, [t])

  // 044: ここは **dedupe 前の `projects` 全件**を走査し続けること。統合行の marker / historyMeta は
  // この経路が `project.path` キーで充填する（`rowPrimaryPath` がそのキーを引く前提）。
  // `visibleProjects` や `rowPlan.normalProjects` に絞ると、統合行のバッジと手動編集済み表示が
  // 黙って消える（型エラーにならず `undefined` になるだけなので気づけない）。
  useEffect(() => {
    if (!showProtocolBadge) return
    if (projects.length === 0) return
    const paths = projects.map((p) => p.path)
    void scanMarkers(paths, autoMarkingEnabled)
    void fetchHistoryMeta(paths)
  }, [projects, showProtocolBadge, autoMarkingEnabled, scanMarkers, fetchHistoryMeta])

  // 039 Feature B: 特別行（specialEntries）の marker 読取。projects.json 未登録パスのため
  // protocolAutoMark（.ccpit/protocol.json への書込あり）は使わず、read-only の protocolRead
  // 経路（scanMarkers の allowAutoWrite=false）を再利用する。CCES enable 判定は通常行と同一の
  // isCcesEnabled（037 意味論の一貫適用）。marker ロード前は安全側 enable（既存仕様のまま）。
  // 044: 対象を**未統合行だけ**に絞る。統合行は上の通常行スキャンが既に処理しており、同一パスへ
  // 書込（autoMark）と読取を同時に投げないため。依存は state 実体のみ（派生配列を入れると
  // setMarkers が毎回新オブジェクトを返すので無限ループになる）。
  useEffect(() => {
    if (!showProtocolBadge) return
    const paths = unmergedSpecialPaths(planProjectRows(specialEntries, projects).specialRows)
    if (paths.length === 0) return
    void scanMarkers(paths, false)
  }, [specialEntries, projects, showProtocolBadge, scanMarkers])

  // 034: Full Re-scan の起点。確認ダイアログを開くだけで、実行は executeFullRescan で行う。
  const handleFullRescan = (): void => {
    setFullRescanDialogOpen(true)
  }

  // 034-B: Full Re-scan 実行（根治版、append-only history）。
  // - main 側 IPC で全 PJ を強制再判定（履歴に manual エントリある PJ は保護）
  // - 完了後に projects/markers/historyMeta を再 load
  // - scanningMarkers state を true に維持して NR-8（実行中の他操作）を抑止
  // - 戻り値の changed/unchanged を Toast に表示（UX 課題 2）
  const executeFullRescan = async (): Promise<void> => {
    setFullRescanDialogOpen(false)
    setScanningMarkers(true)
    try {
      const result = await window.api.protocolFullRescan()
      await loadProjectList()
      const paths = projects.map((p) => p.path)
      if (paths.length > 0) {
        await scanMarkers(paths, false)
        await fetchHistoryMeta(paths)
      }
      setFullRescanToast({
        open: true,
        kind: result.failed > 0 ? 'error' : 'success',
        processed: result.processed,
        skipped: result.skipped,
        failed: result.failed,
        changed: result.changed,
        unchanged: result.unchanged,
      })
    } catch (e) {
      console.error('fullRescan error:', e)
      setFullRescanToast({
        open: true,
        kind: 'error',
        processed: 0,
        skipped: 0,
        failed: -1,
        changed: 0,
        unchanged: 0,
      })
    } finally {
      setScanningMarkers(false)
    }
  }

  // 034-B: 再判定対象件数は履歴ベースで main 側 IPC から取得
  const [fullRescanTargetCount, setFullRescanTargetCount] = useState(0)
  useEffect(() => {
    void (async (): Promise<void> => {
      const target = await window.api.protocolCountFullRescanTargets()
      setFullRescanTargetCount(target)
    })()
  }, [projects, historyMeta])

  const handleToggleFavorite = async (project: ProjectEntry): Promise<void> => {
    const next = !(project.favorite ?? false)
    await window.api.projectsSetFavorite(project.path, next)
    setProjects((prev) =>
      prev.map((p) => (p.path === project.path ? { ...p, favorite: next } : p))
    )
  }

  const handleTogglePxpipeEnabled = async (project: ProjectEntry): Promise<void> => {
    const next = !(project.pxpipeEnabled ?? false)
    await window.api.projectsSetPxpipeEnabled(project.path, next)
    setProjects((prev) =>
      prev.map((p) => (p.path === project.path ? { ...p, pxpipeEnabled: next } : p))
    )
  }

  const handleSelectPath = async (): Promise<void> => {
    const folder = await window.api.selectFolder()
    if (folder) setNewPath(folder)
  }

  // 格納フォルダ外の既存フォルダを、フルパスで手動登録（自動探索は通さない）。external:true で視覚区別。
  const handleAddExternal = async (): Promise<void> => {
    const folder = await window.api.selectFolder()
    if (!folder) return
    await window.api.projectsAddExternal(folder)
    await loadProjectList()
  }

  const handleCreate = async (): Promise<void> => {
    if (!newName.trim() || !newPath.trim()) return
    setCreating(true)
    setCreateResult(null)
    const result = await window.api.projectsCreate(newPath, newName)
    setCreateResult(result)
    setCreating(false)
    if (result.success) {
      await loadProjectList()
      setNewName('')
      setNewPath('')
    }
  }

  const handleRemove = async (path: string): Promise<void> => {
    await window.api.projectsRemove(path)
    // 043: PJ 単位の起動オプションも捨てる。残すと削除→再登録で BypassMode:true 等が黙って蘇り、
    // 「未登録 PJ は DEFAULT_OPTIONS（継承ゼロ）」が成立しない。
    // ただし**同一パスの行が他に残っているなら捨てない**（特別行と通常行はバケツを共有するため。
    // 実装レビュー指摘 [1]: 片方の削除で他方の設定を巻き添えにしない）。
    // 残存判定は主プロセスの規則の写し。単体削除 `removeProject` は**完全一致**で消す
    // （`projects.ts`）ので 'exact'。ここを緩めると、主が残した行のバケツを消してしまう。
    pruneLaunchOptionsIfOrphan(path, [
      ...remainingAfterRemoval(
        projects.map((p) => p.path),
        [path],
        'exact'
      ),
      ...specialEntries.map((s) => s.path)
    ])
    await loadProjectList()
  }

  const handleOpenFolder = async (path: string): Promise<void> => {
    await window.api.openPath(path)
  }

  const handleOpenEditMarker = (path: string): void => {
    setEditingPath(path)
    setEditMarkerOpen(true)
  }

  const handleSubmitEditMarker = async (edits: EditMarkerSubmit): Promise<void> => {
    if (!editingPath) return
    const updated = (await window.api.protocolEditMarker(editingPath, edits)) as ProtocolMarkerView
    setMarkers((prev) => ({ ...prev, [editingPath]: updated }))
    // 034-B: main 側で履歴に manual エントリが追加される（appendProtocolEntry）。
    // confirmed フィールドは廃止、ProtocolBadge の hasManualEntry は次回 hasManualEntry 取得で反映。
  }

  const handleRescanMarker = async (path: string): Promise<void> => {
    if (!confirm(t('editMarker.confirmRescan'))) return
    const updated = (await window.api.protocolRescanMarker(path)) as ProtocolMarkerView
    setMarkers((prev) => ({ ...prev, [path]: updated }))
  }

  return (
    <div className="max-w-5xl mx-auto">
      <Toast
        open={migrationToast.open}
        message={migrationToast.message}
        onClose={() => setMigrationToast((prev) => ({ ...prev, open: false }))}
        durationMs={6000}
      />
      <Toast
        open={fullRescanToast.open}
        message={
          fullRescanToast.kind === 'success'
            ? t('pages.projects.fullRescan.success', {
                processed: fullRescanToast.processed,
                changed: fullRescanToast.changed,
                unchanged: fullRescanToast.unchanged,
                skipped: fullRescanToast.skipped,
              })
            : t('pages.projects.fullRescan.error', { failed: fullRescanToast.failed })
        }
        variant={fullRescanToast.kind}
        onClose={() => setFullRescanToast((prev) => ({ ...prev, open: false }))}
        durationMs={5000}
      />
      <FullRescanConfirmDialog
        open={fullRescanDialogOpen}
        onOpenChange={setFullRescanDialogOpen}
        targetCount={fullRescanTargetCount}
        onConfirm={() => void executeFullRescan()}
      />
      <Toast
        open={ccRestartToast.open}
        message={ccRestartToast.message}
        variant={ccRestartToast.kind}
        onClose={() => setCcRestartToast((prev) => ({ ...prev, open: false }))}
        durationMs={6000}
      />
      <CcRestartConfirmDialog
        open={ccRestartDialogOpen}
        onOpenChange={setCcRestartDialogOpen}
        summary={ccRestartSummary}
        onConfirm={() => void executeCcRestart()}
      />
      <div className="flex items-center justify-between mb-6 gap-2 flex-wrap">
        <h1 className="text-xl font-bold">{t('pages.projects.title')}</h1>
        <div className="flex flex-1 items-center gap-2 flex-wrap justify-end">
          {showProtocolBadge && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleFullRescan}
              disabled={scanningMarkers}
              className="order-1 gap-1.5"
              title={t('pages.projects.protocolBadge.fullRescan')}
            >
              <RefreshCw size={14} className={scanningMarkers ? 'animate-spin' : ''} />
              {t('pages.projects.protocolBadge.fullRescan')}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleCcRestartOpen()}
            disabled={ccRestartInFlight}
            className="order-1 gap-1.5"
            title={t('pages.projects.ccRestart.button')}
          >
            <RotateCw size={14} className={ccRestartInFlight ? 'animate-spin' : ''} />
            {t('pages.projects.ccRestart.button')}
          </Button>
          {showDetectLinkRemove && (
            <>
              <Button variant="outline" size="sm" onClick={() => setShowDiscover(true)} className="order-2 gap-1.5">
                <Search size={14} />
                {t('pages.projects.discover.button')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setShowRemoveFromList(true)} className="order-3 gap-1.5">
                <ListMinus size={14} />
                {t('pages.projects.removeFromList.button')}
              </Button>
            </>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={handleAddExternal}
            className="order-4 gap-1.5"
            title={t('pages.projects.external.title')}
          >
            <FolderPlus size={14} />
            {t('pages.projects.external.button')}
          </Button>
          {/* 039 FB③: 特別枠（ピン留め行）を UI から追加する導線。特別行は launch / CCES /
              openFolder に使え pxpipe 専用ではないため、隣の外部フォルダ登録と同じく常時表示する
              （Codex 指摘#1: pxpipeToggle OFF の既定ユーザーにも導線が要る）。 */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowAddSpecial(true)}
            className="order-4 gap-1.5"
            title={t('pages.projects.special.addTitle')}
          >
            <Pin size={14} />
            {t('pages.projects.special.addButton')}
          </Button>
          {/* SortGroup: 並び順 + ★お気に入り (要件 2: 常に並び順 → お気に入り の順)
              order-5 xl:order-4 で「+ 新規」と前後切替 (要件 3: xl 以上で 1 段化)
              w-full justify-end xl:w-auto で xl 未満は下段右寄せ折返、xl 以上は 1 段で通常配置 */}
          <div className="order-5 xl:order-4 flex w-full xl:w-auto items-center justify-end gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5">
                  {t('pages.projects.sort.label')}: {t(`pages.projects.sort.${viewState.sortMode}`)}
                  <ChevronDown size={14} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuRadioGroup
                  value={viewState.sortMode}
                  onValueChange={(value) =>
                    setViewState((prev) => ({ ...prev, sortMode: value as SortMode }))
                  }
                >
                  {SORT_MODES.map((mode) => (
                    <DropdownMenuRadioItem key={mode} value={mode}>
                      {t(`pages.projects.sort.${mode}`)}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            {showFavorite && (
              <label className="flex items-center gap-1.5 text-sm cursor-pointer select-none">
                <Checkbox
                  checked={viewState.filterFavoritesOnly}
                  onCheckedChange={(checked) =>
                    setViewState((prev) => ({
                      ...prev,
                      filterFavoritesOnly: checked === true,
                    }))
                  }
                  aria-label={t('pages.projects.filter.favoritesOnly')}
                />
                <span>{t('pages.projects.filter.favoritesOnly')}</span>
              </label>
            )}
          </div>
          {/* 要件 4: 「+ 新規プロジェクト」は常に右上 (xl 未満は上段最右、xl 以上は 1 段最右) */}
          <Button
            onClick={() => { setShowCreate(!showCreate); setCreateResult(null) }}
            variant={showCreate ? 'outline' : 'default'}
            size="sm"
            className="order-4 xl:order-5"
          >
            <Plus size={16} /> {t('pages.projects.newProject')}
          </Button>
        </div>
      </div>

      {launchMessage && (
        <div
          className={cn(
            'mb-4 rounded-md border px-3 py-2 text-sm',
            launchMessage.kind === 'ok'
              ? 'border-green-500/30 bg-green-500/10 text-green-600'
              : 'border-destructive/30 bg-destructive/10 text-destructive'
          )}
        >
          {launchMessage.text}
        </div>
      )}

      {/* Create Form */}
      {showCreate && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>{t('pages.projects.newProject')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>{t('pages.projects.projectName')}</Label>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t('pages.projects.projectNamePlaceholder')}
              />
            </div>
            <div className="space-y-2">
              <Label>{t('pages.projects.projectPath')}</Label>
              <div className="flex gap-2">
                <Input value={newPath} onChange={(e) => setNewPath(e.target.value)} className="flex-1" placeholder="C:\Projects\my-project" />
                <Button variant="outline" onClick={handleSelectPath}>
                  <FolderOpen size={16} /> {t('pages.projects.selectPath')}
                </Button>
              </div>
            </div>

            {createResult && (
              <div className={cn('flex items-center gap-2 text-sm', createResult.success ? 'text-green-500' : 'text-destructive')}>
                {createResult.success ? <Check size={16} /> : <X size={16} />}
                {createResult.success ? t('pages.projects.createSuccess') : t('pages.projects.createError')}
              </div>
            )}

            <Button onClick={handleCreate} disabled={creating || !newName.trim() || !newPath.trim()}>
              {creating ? <><Loader2 size={16} className="animate-spin" /> {t('pages.projects.creating')}</> : t('pages.projects.create')}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Discovery Dialog */}
      {showDetectLinkRemove && (
        <ProjectDiscoveryDialog
          open={showDiscover}
          onOpenChange={setShowDiscover}
          onImported={() => {
            void loadProjectList()
          }}
        />
      )}

      {/* Remove from List Dialog */}
      {showDetectLinkRemove && (
        <RemoveFromListDialog
          open={showRemoveFromList}
          onOpenChange={setShowRemoveFromList}
          projects={projects}
          onRemoved={(paths) => {
            // 043: 一覧から外した PJ の起動オプションも捨てる（handleRemove と同じ理由）。
            // 特別行として残るパスは孤児でないため捨てない。
            // 一括削除 `removeProjectsFromList` は **大小非依存**で消す（`projects.ts`）ので
            // 'caseInsensitive'。exact だと表記違いの行を残存と誤認し、孤児バケツが生き残る。
            const remaining = [
              ...remainingAfterRemoval(
                projects.map((p) => p.path),
                paths,
                'caseInsensitive'
              ),
              ...specialEntries.map((s) => s.path)
            ]
            paths.forEach((p) => pruneLaunchOptionsIfOrphan(p, remaining))
            void loadProjectList()
          }}
        />
      )}

      {/* Edit Marker Dialog (034-B: projectPath 追加で履歴セクション表示) */}
      {showEditMarkerUI && (
        <EditMarkerDialog
          open={editMarkerOpen}
          onOpenChange={(o) => {
            setEditMarkerOpen(o)
            if (!o) setEditingPath(null)
          }}
          current={editingPath ? (markers[editingPath] ?? null) : null}
          projectPath={editingPath}
          onSubmit={handleSubmitEditMarker}
        />
      )}

      {/* 039 FB③: 特別枠追加ダイアログ。 */}
      <SpecialEntryAddDialog
        open={showAddSpecial}
        onOpenChange={setShowAddSpecial}
        existing={specialEntries}
        onAdd={(next) => void handleAddSpecialEntry(next)}
      />

      {/* 038 Feature B: ピン留め特別行。applyProjectsView（favorites filter / sort）を通さず
          常に一覧最上部に固定表示する。specialEntries が空（配布既定）なら何も出ない。
          044: 同一パスの通常行はここへ統合され、下の一覧からは除外される（唯一の描画サイト）。 */}
      {rowPlan.specialRows.length > 0 && (
        <div className="space-y-2 mb-2">
          {specialRowViews.map(({ row, entry, merged, rowPath, pxpipeOn }) => (
            <Card
              key={`special:${entry.id}`}
              className="border-l-4 border-l-purple-500/70 bg-purple-500/5"
            >
              <CardContent className="p-4 flex items-center gap-4">
                {/* 039 FB②: 通常行の Star スロットに合わせた整列プレースホルダ。特別行は常に
                    ピン留め表示のため非対話（お気に入り機能は持たせない＝設計レーン支持済み）。
                    044: 統合行でも Star は出さない。特別行は applyProjectsView を通らない固定行で、
                    favorite は並び替え・絞り込み専用の属性だから固定行では効果を持たない。値は
                    projects.json に残り、特別枠から外せば通常行の Star が復活する（可逆）。 */}
                {showFavorite && (
                  <div
                    className="flex h-8 w-8 items-center justify-center text-purple-400/70"
                    title={t(
                      merged
                        ? 'pages.projects.special.pinnedTitleMerged'
                        : 'pages.projects.special.pinnedTitle'
                    )}
                  >
                    <Pin size={14} className="fill-current" />
                  </div>
                )}
                {showPxpipe && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                      'h-8 w-8',
                      pxpipeOn
                        ? 'text-sky-400 hover:text-sky-500'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                    onClick={() => void handleToggleRowPxpipe(row)}
                    title={t(
                      pxpipeOn ? 'pages.projects.pxpipe.disable' : 'pages.projects.pxpipe.enable'
                    )}
                  >
                    <Plug size={14} className={pxpipeOn ? 'fill-current' : ''} />
                  </Button>
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className="font-medium">{entry.name}</span>
                    <span className="rounded border border-purple-500/50 bg-purple-500/10 px-1.5 py-0.5 text-[10px] font-medium text-purple-400">
                      {t('pages.projects.special.badge')}
                    </span>
                    {/* 044: 統合行であることの可視化。一括削除ダイアログで projects.json 側の登録を
                        外したとき、このバッジが消えることが操作成功のフィードバックになる。 */}
                    {merged && (
                      <span
                        className="rounded border border-sky-500/50 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-400"
                        title={t('pages.projects.special.mergedBadgeTitle')}
                      >
                        {t('pages.projects.special.mergedBadge')}
                      </span>
                    )}
                    {row.project?.external && (
                      <span className="rounded border border-amber-500/50 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">
                        {t('pages.projects.external.badge')}
                      </span>
                    )}
                    {/* 044: marker は元々特別行でも取得済み（CCES enable 判定が既に消費している）。
                        統合行で通常行を隠す以上、ここに出さないと ProtocolBadge と「手動編集済み」
                        表示が失われる。キーは rowPath＝実際に marker を書いた側の文字列。 */}
                    {showProtocolBadge && (
                      <ProtocolBadge
                        marker={markers[rowPath]}
                        loading={scanningMarkers && markers[rowPath] === undefined}
                        hasManualEntry={historyMeta[rowPath]?.hasManual}
                        lastManualAt={historyMeta[rowPath]?.lastManualAt}
                        historyCount={historyMeta[rowPath]?.historyCount}
                      />
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground font-mono truncate">
                    {toNativePath(rowPath)}
                  </div>
                </div>
                {showLaunchButton && showPxpipe && (
                  <FableLaunchButton
                    projectPath={rowPath}
                    onLaunched={handleLaunched}
                    optionOverrides={resolveRowOverrides(entry, merged)}
                    tabColor={entry.tabColor}
                  />
                )}
                {showLaunchButton && (
                  <LaunchMenu
                    projectPath={rowPath}
                    onLaunched={handleLaunched}
                    showFable={showPxpipe}
                    optionOverrides={resolveRowOverrides(entry, merged)}
                    // 044: 旧実装は `entry.pxpipeEnabled ? 'force' : 'off'` を明示で渡していたが、
                    // 主プロセスの 'off' は projects.json を一切見ずに素通しする（ipc.ts:401）。
                    // 統合行では 'auto' を返し、主プロセスに projects.json を読ませる。
                    pxpipe={resolveRowPxpipeMode(row)}
                    tabColor={entry.tabColor}
                    // 044: marker の編集・再判定は .ccpit/protocol.json への書込を伴う。未登録パスへ
                    // 暗黙に書かない措置（上の read-only スキャン）を尊重し、統合行だけに出す。
                    showEditMarker={showEditMarkerUI && merged}
                    onEditMarker={merged ? () => handleOpenEditMarker(rowPath) : undefined}
                    onRescanMarker={merged ? () => void handleRescanMarker(rowPath) : undefined}
                  />
                )}
                {/* 039 Feature B: 特別行にも CCES 生成を配線。handler / enable 判定 / busy 排他は
                    通常行と同一（成果物はクリップボード CCES サマリ + CC固有ID 併記）。 */}
                <CcesGenerateButton
                  enabled={isCcesEnabled(markers[rowPath], ccesAllowAll)}
                  busy={ccesBusy === rowPath}
                  onGenerate={() => void handleCcesGenerate(rowPath, entry.name)}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-foreground"
                  onClick={() => handleOpenFolder(rowPath)}
                  title={t('pages.projects.openFolder', 'フォルダを開く')}
                >
                  <ExternalLink size={14} />
                </Button>
                {/* 039 FB②: 特別行の削除（= specialEntries からの除去のみ）。通常行のゴミ箱と
                    同位置・同スタイル。実フォルダ・projects.json・marker には触れない。
                    044: 統合行では「降格」＝通常行として再表示される（可逆）。文言を分ける。 */}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                  onClick={() => void handleRemoveSpecialEntry(row)}
                  title={t(
                    merged
                      ? 'pages.projects.special.removeMerged'
                      : 'pages.projects.special.remove'
                  )}
                >
                  <Trash2 size={14} />
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Project List
          044: 旧実装の 2 段分岐は「visible が空 ⇔ favorites フィルタで空」に乗っていた。dedupe を
          入れると filterFavoritesOnly=false でも空になり得るため、判定を純関数へ委譲する。 */}
      {emptyState === 'noProjects' ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            {t('pages.projects.noProjects')}
          </CardContent>
        </Card>
      ) : emptyState === 'noFavorites' ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            {t('pages.projects.noFavorites')}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {visibleProjects.map((project) => (
            <Card
              key={project.path}
              className={cn(
                project.external && 'border-l-4 border-l-amber-500/70 bg-amber-500/5'
              )}
            >
              <CardContent className="p-4 flex items-center gap-4">
                {showFavorite && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                      'h-8 w-8',
                      project.favorite
                        ? 'text-yellow-400 hover:text-yellow-500'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                    onClick={() => handleToggleFavorite(project)}
                    title={t(
                      project.favorite
                        ? 'pages.projects.favorite.unfavorite'
                        : 'pages.projects.favorite.favorite'
                    )}
                  >
                    <Star
                      size={14}
                      className={project.favorite ? 'fill-current' : ''}
                    />
                  </Button>
                )}
                {showPxpipe && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                      'h-8 w-8',
                      project.pxpipeEnabled
                        ? 'text-sky-400 hover:text-sky-500'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                    onClick={() => handleTogglePxpipeEnabled(project)}
                    title={t(
                      project.pxpipeEnabled
                        ? 'pages.projects.pxpipe.disable'
                        : 'pages.projects.pxpipe.enable'
                    )}
                  >
                    <Plug size={14} className={project.pxpipeEnabled ? 'fill-current' : ''} />
                  </Button>
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className="font-medium">{project.name}</span>
                    {showProtocolBadge && (
                      <ProtocolBadge
                        marker={markers[project.path]}
                        loading={scanningMarkers && markers[project.path] === undefined}
                        hasManualEntry={historyMeta[project.path]?.hasManual}
                        lastManualAt={historyMeta[project.path]?.lastManualAt}
                        historyCount={historyMeta[project.path]?.historyCount}
                      />
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground font-mono truncate">{toNativePath(project.path)}</div>
                </div>
                {/* 038 Feature A: pxp 経由 Fable ワンクリック起動（LaunchMenu の左・pxpipeToggle 配下） */}
                {showLaunchButton && showPxpipe && (
                  <FableLaunchButton projectPath={project.path} onLaunched={handleLaunched} />
                )}
                {showLaunchButton && (
                  <LaunchMenu
                    projectPath={project.path}
                    onLaunched={handleLaunched}
                    showEditMarker={showEditMarkerUI}
                    onEditMarker={() => handleOpenEditMarker(project.path)}
                    onRescanMarker={() => void handleRescanMarker(project.path)}
                    showFable={showPxpipe}
                  />
                )}
                {/* 036: CCES Generate (per-project, clipboard-based) */}
                {/* 037 Phase 2-B: スイッチ × 自動判定で disabled / tooltip を切替 */}
                <CcesGenerateButton
                  enabled={isCcesEnabled(markers[project.path], ccesAllowAll)}
                  busy={ccesBusy === project.path}
                  onGenerate={() => void handleCcesGenerate(project.path, project.name)}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-foreground"
                  onClick={() => handleOpenFolder(project.path)}
                  title={t('pages.projects.openFolder', 'フォルダを開く')}
                >
                  <ExternalLink size={14} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                  onClick={() => handleRemove(project.path)}
                  title={t('pages.projects.remove')}
                >
                  <Trash2 size={14} />
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
