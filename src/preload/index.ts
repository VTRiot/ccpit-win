import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { CommentThreadView } from '../main/services/commentOps'
import type {
  SkillInventoryResult,
  RemoveSkillResult,
  RestoreRemovedResult,
  ResolveCollisionResult
} from '../main/services/skillLifecycle'
import type { RestoreArchiveResult } from '../main/services/settingsChange'
import type {
  ComposeAdoptedInfo,
  ComposeAnswerOption,
  ComposeCaseFields,
  ComposeCcStart,
  ComposePhase,
  ReceptacleClosedHow,
  ReceptacleSummary
} from '../shared/composeContract'

// Enforcement 発火統計の型別集計（Part B Phase 2a）。main/services/enforcementStats.ts と同型を inline 複製（preload は main を import しない既存慣習に倣う）。
type EnforcementTypeStat = {
  total: number
  ranking: { key: string; count: number }[]
  scopeNote: string
}

// CC 検出 + DELEGATE 再起動。main/services/sessionRegistry.ts と同型を inline 複製。
type CcDetectedCcDto = {
  pid: number
  resolution: 'resolved' | 'resume-only' | 'unresolved'
  sessionId?: string
  cwd?: string
  status?: 'busy' | 'waiting' | 'idle' | 'unknown'
  name?: string
  waitingFor?: string
  createdAt?: string | null
}
type CcDetectSummaryDto = {
  total: number
  resolved: number
  resumeOnly: number
  unresolved: number
  sessions: CcDetectedCcDto[]
}
/** detectLiveSessions の判別共用体。列挙失敗は ok:false（fail-closed）。 */
type CcDetectResultDto = { ok: true; summary: CcDetectSummaryDto } | { ok: false; error: string }
/**
 * restartAll の戻り。bump 失敗のみ ok:false。bump 成功後の detect 失敗は
 * partial-success（ok:true + summary:null + detectError）。
 */
type CcRestartAllResultDto =
  | {
      ok: true
      generation: number
      summary: CcDetectSummaryDto | null
      detectError?: string
      pxpipeWarning?: string
    }
  | { ok: false; error: string }

// 提案の合成（main/services/composeLaunch.ts の ComposeStatus と同型を inline 複製）
// L0_011: 案件・巡・手番の項目は src/shared/composeContract.ts の契約（caseId を持つ作業場だけに付く）
type ComposeStatusDto = Partial<ComposeCaseFields> & {
  /** main が状態の変化ごとに採番する札（描画の報告に使う） */
  seq?: number
  workspaceDir: string
  skillName: string
  startedAt: string
  phase: ComposePhase
  compositeRequestId: string
  sourceIds: string[]
  /** 選ばなかった提案（合成の元に選ばず、この合成が終わるまで昇格候補から外れる提案）の request_id */
  excludedIds: string[]
  /** 改訂の合成のとき、置き換える旧合成提案の ID */
  revises?: string
  /** 昇格済みの印（合成台帳に application があるとき。案件・旧形式の両方） */
  adopted?: ComposeAdoptedInfo
  /** L0_012: 窓つきの合成 CC の着手の状況（窓つきの起動で段が running の間だけ） */
  ccStart?: ComposeCcStart
  result?: {
    ok: boolean
    stage?: string
    error?: string
    compositeId?: string
    filePath?: string
    adapted?: Array<{ key: string; sourceId: string; relPath: string; lang: 'ja' | 'en'; reason: string; preview: string }>
    review?: { status: string; verdict?: string; message?: string }
    finishedAt: string
  }
}
type ComposeStartResultDto =
  | { ok: true; workspaceDir: string; compositeRequestId: string; promptFilePath: string; appliedFlags: string[]; sourceIds: string[] }
  | { ok: false; error: string }

// 合成の元提案の選択（main/services/composeIpc.ts の ComposePickerItem と同型を inline 複製）
type ComposePickerItemDto = {
  requestId: string
  title: string
  adoptionLabel: string
  selectable: boolean
  reason?: 'unreviewed' | 'findings' | 'rejected' | 'adopted' | 'composite' | 'composed' | 'waiting' | 'notCandidate'
  detail?: string
}
type ComposeSelectableResultDto = { ok: true; items: ComposePickerItemDto[] } | { ok: false; error: string }

// FB02: BG-CC アクティビティイベント。main/services/bgccActivityBus.ts と同型を inline 複製。
type BgccActivityEventDto = {
  runId: string
  source: string
  seq: number
  ts: string
  kind: 'start' | 'assistant' | 'tool' | 'raw_stdout' | 'stderr' | 'result' | 'error'
  text: string
  phase?: string
  trigger?: 'manual' | 'startup'
  meta?: {
    ok?: boolean
    durationMs?: number
    costUsd?: number
    permissionDenied?: boolean
    exitCode?: number | null
    resultEventCount?: number
  }
}

// pxpipe 内蔵ダッシュボードの状態（main/pxpipeJaIpc.ts の PxpipeViewStatus と同型を inline 複製。
// preload は main を import しない既存慣習に倣う）。
type PxpipeViewStatusDto = {
  state:
    | 'proxy-down'
    | 'ja-down'
    | 'upstream-down'
    | 'ja-foreign'
    | 'ok'
    | 'ja-stale'
    | 'ja-disabled'
  viewUrl: string
  jaUrl: string
  enUrl: string
  jaPort: number
  upstreamPort: number
  proxyOwned: boolean
  jaOwned: boolean
  jaAutoStartEligible: boolean
  jaScriptSource?: 'manual' | 'bundled'
  jaDictTarget?: string
  reason?: string
}

// pxpipe スコープ状態および版状態（070 M4）
type ModelScopeResolutionDto = {
  concreteId: string
  displayName: string
  matchedBase: string | null
  isInScope: boolean
  isImplicitByPrefix: boolean
  reason: string
}
type PxpipeScopeStatusDto = {
  scopeBases: string[]
  effectiveScopeBases: string[]
  isScopeConsistent: boolean
  runningPort: number | null
  ambiguousPort?: boolean
  resolutions: ModelScopeResolutionDto[]
  fableModel: string
}
type SetScopeModelResultDto = {
  ok: boolean
  error?: string
  status: PxpipeScopeStatusDto
}
type PxpipeVersionStatusDto = {
  pinnedVersion: string
  runningVersion: string | null
  isVersionConsistent: boolean
}

const api = {
  /**
   * 「**ブランクではない UI が描画された**」通知（main 側 watchdog の解除条件）。
   * 「正常」通知ではない — ページ境界の fallback が出ている状態も ready として送り、
   * 分類（kind）だけを分ける。main は分類をログに残すが致命扱いはしない。
   * **fire-and-forget**（`invoke` の reject が二次障害になるのを避ける）。
   */
  rendererReady: (kind: 'ok' | 'page-error' | 'root-error'): void =>
    ipcRenderer.send('app:renderer-ready', kind),
  /**
   * renderer 側で捕捉したエラーを main のログへ送る（ErrorBoundary / global handler 用）。
   * **fire-and-forget**。通知の失敗が unhandled rejection になって二次障害を生むのを避ける。
   */
  reportRendererError: (payload: {
    scope: string
    errorId?: string
    message: string
    stack?: string
    componentStack?: string
  }): void => ipcRenderer.send('app:renderer-error', payload),

  // Golden
  goldenList: (): Promise<string[]> => ipcRenderer.invoke('golden:list'),
  goldenPreview: (templateName: string): Promise<{ relativePath: string; source: string }[]> =>
    ipcRenderer.invoke('golden:preview', templateName),
  // L0_013: settings.json の層ごとの差と、手元の層を外す・書き換える項目の承認の印（何も書かない）
  goldenPreviewSettingsLayers: (
    templateName: string
  ): Promise<import('../main/services/settingsLayers').SettingsLayersPreviewResult> =>
    ipcRenderer.invoke('golden:previewSettingsLayers', templateName),
  goldenDeploy: (
    templateName: string,
    password: string,
    settingsApproval?: string
  ): Promise<{ deployed: string[]; backedUp: string[]; errors: string[] }> =>
    ipcRenderer.invoke('golden:deploy', templateName, password, { settingsApproval }),
  goldenCheckExisting: (): Promise<{
    exists: boolean
    hasSettings: boolean
    hasClaude: boolean
  }> => ipcRenderer.invoke('golden:checkExisting'),

  // 起動時照合の確認待ち（§9.4）。renderer 側から取りに行く pull（D3）。
  goldenPendingReconcile: (): Promise<
    {
      path: string
      case: 'unchanged' | 'auto-update' | 'user-modified' | 'conflict' | 'new' | 'restore'
      owner: 'golden' | 'adopted' | 'user' | 'promoted'
      willBackup: boolean
      wouldChangeContent: boolean
      hasBaseRecord: boolean
      upstreamAdvanced: boolean
    }[]
  > => ipcRenderer.invoke('golden:pendingReconcile'),
  // ADR 0002 / 0004: 行ごとの出口を 1 回で確定させる唯一の書込経路。
  goldenResolveReconcile: (
    decisions: { path: string; action: 'apply' | 'promote' | 'unmanage' | 'defer' }[],
    options?: { proposePaths?: string[] }
  ): Promise<{
    applied: string[]
    promoted: string[]
    unmanaged: string[]
    deferred: string[]
    failed: { path: string; message: string }[]
    backups: string[]
    skipped: {
      path: string
      reason:
        | 'not-pending'
        | 'stale-destination'
        | 'no-base-record'
        | 'promote-failed'
        | 'no-ledger'
    }[]
    overlayDir: string
    overlayDurable: boolean
    manifestUpdated: boolean
    blocked?: 'source-unreadable' | 'path-collisions'
    proposeResults?: {
      txId: string
      packetPath: string
      launched: boolean
      autoExitSeconds: number
      sanitizedSummaries: {
        rel: string
        publicPath: string
        attentionCount: number
        sanitizedDiff: string
      }[]
      error?: string
    }
  }> => ipcRenderer.invoke('golden:resolveReconcile', decisions, options),
  goldenFollowUpState: (): Promise<
    {
      path: string
      kind: 'deferred' | 'unmanaged' | 'overlay'
      drifted: boolean | null
      lapsed?: boolean
      decidedAt?: string
    }[]
  > => ipcRenderer.invoke('golden:followUpState'),
  goldenRemanage: (
    paths: string[]
  ): Promise<{ unmanaged: string[]; deferred: string[]; manifestUpdated: boolean }> =>
    ipcRenderer.invoke('golden:remanage', paths),
  goldenDiscardOverlay: (paths: string[]): Promise<{ discarded: string[] }> =>
    ipcRenderer.invoke('golden:discardOverlay', paths),
  goldenListUndoGenerations: (): Promise<
    {
      generationStamp: string
      timestamp: string
      isLatest: boolean
      files: {
        rel: string
        destPath: string
        backupPath: string
        backupHash: string
        currentHash?: string
        canRestore: boolean
        notRestorableReason?: 'modified' | 'older_generation' | 'missing' | 'untracked'
      }[]
    }[]
  > => ipcRenderer.invoke('golden:listUndoGenerations'),
  goldenRestoreUndoBackups: (
    requests: { rel: string; generationStamp: string }[]
  ): Promise<
    {
      rel: string
      status: 'restored_and_promoted' | 'not_restored' | 'restored_overlay_failed'
      reason?: string
    }[]
  > => ipcRenderer.invoke('golden:restoreUndoBackups', requests),
  // CCPIT_064 / ADR 0003: 確認ダイアログの「Claude Code に相談」。書込経路ではない。
  goldenLaunchMergeConsult: (input: {
    paths: string[]
    proposalPaths?: string[]
  }): Promise<{
    ok: boolean
    error?: string
    promptFilePath?: string
    shell?: string
    appliedFlags?: string[]
    rejectedSettings?: string[]
    subjects?: string[]
    proposals?: number
  }> => ipcRenderer.invoke('golden:launchMergeConsult', input),
  goldenApplyReconcile: (
    paths: string[]
  ): Promise<{
    applied: string[]
    failed: { path: string; message: string }[]
    backups: string[]
    skipped: string[]
    manifestUpdated: boolean
    blocked?: 'source-unreadable' | 'path-collisions'
  }> => ipcRenderer.invoke('golden:applyReconcile', paths),
  goldenDeferReconcile: (
    paths: string[]
  ): Promise<{ deferred: string[]; manifestUpdated: boolean }> =>
    ipcRenderer.invoke('golden:deferReconcile', paths),

  // Golden Promotion Browser (Golden 昇格ブラウザ)
  goldenPromotionList: () => ipcRenderer.invoke('goldenPromotion:list'),
  goldenPromotionDiffDetail: (item: { source: string; skillName: string; capturedContent?: string }) =>
    ipcRenderer.invoke('goldenPromotion:diffDetail', {
      source: item.source,
      skillName: item.skillName,
      capturedContent: item.capturedContent
    }),
  goldenPromotionMarkViewed: (id: string) => ipcRenderer.invoke('goldenPromotion:markViewed', id),
  goldenPromotionSetState: (ids: string[], state: string) =>
    ipcRenderer.invoke('goldenPromotion:setState', { ids, state }),
  goldenPromotionRejectConflicted: (id: string) =>
    ipcRenderer.invoke('goldenPromotion:rejectConflicted', { id }),
  // golden を書き換える操作は password を取る（主処理が検証する。CCPIT_L0_003）
  goldenPromotionApply: (ids: string[], password: string) =>
    ipcRenderer.invoke('goldenPromotion:apply', { ids, password }),
  goldenPromotionListDeployed: () => ipcRenderer.invoke('goldenPromotion:listDeployed'),
  goldenPromotionWithdraw: (skillName: string, password: string) =>
    ipcRenderer.invoke('goldenPromotion:withdraw', { skillName, password }),
  goldenPromotionRestore: (skillName: string, password: string) =>
    ipcRenderer.invoke('goldenPromotion:restore', { skillName, password }),
  goldenPromotionRollback: (requestId: string, password: string) =>
    ipcRenderer.invoke('goldenPromotion:rollback', { requestId, password }),
  goldenPromotionGetLeaseStatus: () => ipcRenderer.invoke('goldenPromotion:getLeaseStatus'),
  goldenPromotionReleaseExpiredLease: (expectedLeaseId: string, password: string) =>
    ipcRenderer.invoke('goldenPromotion:releaseExpiredLease', { expectedLeaseId, password }),
  goldenPromotionCleanupArtifacts: (password: string) =>
    ipcRenderer.invoke('goldenPromotion:cleanupArtifacts', { password }),
  goldenPromotionVerifyEarlyRelease: () => ipcRenderer.invoke('goldenPromotion:verifyEarlyRelease'),
  goldenPromotionReleaseEarlyLease: (expectedLeaseId: string, password: string) =>
    ipcRenderer.invoke('goldenPromotion:releaseEarlyLease', { expectedLeaseId, password }),
  goldenPromotionDetectLedgerDrift: () => ipcRenderer.invoke('goldenPromotion:detectLedgerDrift'),
  goldenPromotionScanDiagnostics: () => ipcRenderer.invoke('goldenPromotion:scanDiagnostics'),
  goldenPromotionApplyLedgerCatchup: (
    unrecordedSha: string,
    approvalContext: { approvedBy: string; approvedAt: string; confirmationHash: string },
    password: string
  ) =>
    ipcRenderer.invoke('goldenPromotion:applyLedgerCatchup', {
      unrecordedSha,
      approvalContext,
      password
    }),
  onGoldenPromotionProgress: (callback: (data: any) => void) => {
    const handler = (_: any, data: any) => callback(data)
    ipcRenderer.on('goldenPromotion:progress', handler)
    return () => {
      ipcRenderer.removeListener('goldenPromotion:progress', handler)
    }
  },

  // Migration
  migrationScan: (
    projectPath: string
  ): Promise<
    { path: string; name: string; lines: number; sizeBytes: number; category: string }[]
  > => ipcRenderer.invoke('migration:scan', projectPath),
  migrationGeneratePack: (
    scannedFiles: {
      path: string
      name: string
      lines: number
      sizeBytes: number
      category: string
    }[]
  ): Promise<string> => ipcRenderer.invoke('migration:generatePack', scannedFiles),
  migrationParseImport: (
    mdContent: string
  ): Promise<{ filename: string; targetPath: string; content: string }[]> =>
    ipcRenderer.invoke('migration:parseImport', mdContent),
  migrationImportToGolden: (
    blocks: { filename: string; targetPath: string; content: string }[],
    templateName: string
  ): Promise<{ placed: string[]; errors: string[] }> =>
    ipcRenderer.invoke('migration:importToGolden', blocks, templateName),
  migrationImportPit: (
    filePath: string
  ): Promise<{
    entries: { path: string; content: string; lines: number }[]
    claudeMdPreview: string
    claudeMdLines: number
    rulesCount: number
    skillsCount: number
    coverageMapSummary: { totalRows: number; uncoveredCount: number } | null
    metricsRaw: string | null
    validationErrors: string[]
  }> => ipcRenderer.invoke('migration:importPit', filePath),
  migrationDeployPit: (
    entries: { path: string; content: string; lines: number }[]
  ): Promise<{ deployed: string[]; backedUp: string[]; errors: string[] }> =>
    ipcRenderer.invoke('migration:deployPit', entries),

  // Projects
  projectsList: (): Promise<
    {
      name: string
      path: string
      status: string
      createdAt: string
      // 034-B: confirmed 廃止。明示意思は protocol.json の history に統合。
    }[]
  > => ipcRenderer.invoke('projects:list'),
  projectsCreate: (
    projectPath: string,
    projectName: string
  ): Promise<{ success: boolean; created: string[]; errors: string[] }> =>
    ipcRenderer.invoke('projects:create', projectPath, projectName),
  projectsRemove: (projectPath: string): Promise<void> =>
    ipcRenderer.invoke('projects:remove', projectPath),
  projectsDiscover: (
    rootPath: string
  ): Promise<
    {
      path: string
      name: string
      hasClaudeMd: boolean
      hasCcpitDir: boolean
      alreadyManaged: boolean
    }[]
  > => ipcRenderer.invoke('projects:discover', rootPath),
  projectsImport: (
    paths: string[]
  ): Promise<{ name: string; path: string; status: string; createdAt: string }[]> =>
    ipcRenderer.invoke('projects:import', paths),
  projectsAddExternal: (
    projectPath: string
  ): Promise<{ name: string; path: string; createdAt: string; external?: boolean }[]> =>
    ipcRenderer.invoke('projects:addExternal', projectPath),
  projectsRemoveFromList: (paths: string[]): Promise<{ removed: string[] }> =>
    ipcRenderer.invoke('projects:removeFromList', paths),
  projectsSetFavorite: (projectPath: string, favorite: boolean): Promise<void> =>
    ipcRenderer.invoke('projects:setFavorite', projectPath, favorite),
  projectsSetPxpipeEnabled: (projectPath: string, enabled: boolean): Promise<void> =>
    ipcRenderer.invoke('projects:setPxpipeEnabled', projectPath, enabled),
  projectsConsumeMigrationNotice: (): Promise<{ migrated: number; total: number } | null> =>
    ipcRenderer.invoke('projects:consumeMigrationNotice'),
  // 034-B: protocol-history-v2 マイグレーション通知。
  projectsConsumeProtocolHistoryMigrationNotice: (): Promise<{
    migrated: number
    total: number
  } | null> => ipcRenderer.invoke('projects:consumeProtocolHistoryMigrationNotice'),

  // Recovery Kit
  rkSnapshot: (): Promise<{
    id: string
    timestamp: string
    knownGood: boolean
    label: 'manual' | 'pre-restore' | 'post-restore'
    fileCount: number
  }> => ipcRenderer.invoke('rk:snapshot'),
  rkList: (): Promise<
    {
      id: string
      timestamp: string
      knownGood: boolean
      label: 'manual' | 'pre-restore' | 'post-restore'
      fileCount: number
    }[]
  > => ipcRenderer.invoke('rk:list'),
  rkMarkKnownGood: (id: string): Promise<void> => ipcRenderer.invoke('rk:markKnownGood', id),
  rkDiff: (
    id: string
  ): Promise<
    {
      relativePath: string
      risk: string
      status: string
      currentContent?: string
      snapshotContent?: string
    }[]
  > => ipcRenderer.invoke('rk:diff', id),
  rkRestore: (
    id: string
  ): Promise<{ quarantinePath: string; restoredFiles: string[]; errors: string[] }> =>
    ipcRenderer.invoke('rk:restore', id),

  // Doctor Analysis
  daGenerate: (symptom: string): Promise<string> => ipcRenderer.invoke('da:generate', symptom),
  daSave: (content: string, outputDir: string): Promise<string> =>
    ipcRenderer.invoke('da:save', content, outputDir),
  daDefaultOutputDir: (): Promise<string> => ipcRenderer.invoke('da:defaultOutputDir'),

  // Health
  healthCheck: (): Promise<{ name: string; status: string; detail: string }[]> =>
    ipcRenderer.invoke('health:check'),
  healthDenyList: (): Promise<string[]> => ipcRenderer.invoke('health:denyList'),
  healthCcCli: (): Promise<boolean> => ipcRenderer.invoke('health:ccCli'),

  // App Config
  configGet: (): Promise<{
    splashDurationMs: number
    splashRareChance: number
    debugMode: boolean
    setupCompleted: boolean
    showSetupNav: boolean
    language: 'ja' | 'en'
    currentProfile: 'manx' | 'legacy'
    features: Record<
      | 'ccLaunchButton'
      | 'detectLinkRemove'
      | 'protocolBadge'
      | 'favoriteToggle'
      | 'autoMarking'
      | 'editMarkerUI'
      | 'pxpipeToggle',
      { enabled: boolean }
    >
    legacyMasterPath?: string
    lastBackupAt?: string
    cces?: { openingText?: string; allowAllProjects?: boolean }
    pxpipe?: { models?: string; fableModel?: string }
    specialEntries?: {
      id: string
      name: string
      path: string
      addDirs?: string[]
      effort?: string
      tabColor?: string
      pxpipeEnabled?: boolean
    }[]
    backstageCc?: { hidden?: boolean }
    contextUsage?: { warn1?: number; warn2?: number }
  }> => ipcRenderer.invoke('config:get'),
  configSet: (
    partial: Partial<{
      splashDurationMs: number
      splashRareChance: number
      debugMode: boolean
      setupCompleted: boolean
      showSetupNav: boolean
      language: 'ja' | 'en'
      currentProfile: 'manx' | 'legacy'
      features: Partial<
        Record<
          | 'ccLaunchButton'
          | 'detectLinkRemove'
          | 'protocolBadge'
          | 'favoriteToggle'
          | 'autoMarking'
          | 'editMarkerUI'
          | 'pxpipeToggle',
          { enabled: boolean }
        >
      >
      legacyMasterPath?: string
      lastBackupAt?: string
      cces?: { openingText?: string; allowAllProjects?: boolean }
      pxpipe?: { models?: string; fableModel?: string }
      specialEntries?: {
        id: string
        name: string
        path: string
        addDirs?: string[]
        effort?: string
        tabColor?: string
        pxpipeEnabled?: boolean
      }[]
      backstageCc?: { hidden?: boolean }
      contextUsage?: { warn1?: number; warn2?: number }
    }>
  ): Promise<{
    splashDurationMs: number
    splashRareChance: number
    debugMode: boolean
    setupCompleted: boolean
    showSetupNav: boolean
    language: 'ja' | 'en'
    currentProfile: 'manx' | 'legacy'
    features: Record<
      | 'ccLaunchButton'
      | 'detectLinkRemove'
      | 'protocolBadge'
      | 'favoriteToggle'
      | 'autoMarking'
      | 'editMarkerUI'
      | 'pxpipeToggle',
      { enabled: boolean }
    >
    legacyMasterPath?: string
    lastBackupAt?: string
    cces?: { openingText?: string; allowAllProjects?: boolean }
    pxpipe?: { models?: string; fableModel?: string }
    specialEntries?: {
      id: string
      name: string
      path: string
      addDirs?: string[]
      effort?: string
      tabColor?: string
      pxpipeEnabled?: boolean
    }[]
    backstageCc?: { hidden?: boolean }
    contextUsage?: { warn1?: number; warn2?: number }
  }> => ipcRenderer.invoke('config:set', partial),

  // Model Catalog (040 裏CC定石 第一利用者)
  modelCatalogGet: (): Promise<{
    fetchedAt: string
    source: 'official' | 'env'
    stale: boolean
    models: {
      id: string
      displayName?: string
      tier: 'current' | 'legacy' | 'deprecated' | 'limited'
    }[]
  } | null> => ipcRenderer.invoke('modelCatalog:get'),
  modelCatalogRefresh: (): Promise<{
    fetchedAt: string
    source: 'official' | 'env'
    stale: boolean
    models: {
      id: string
      displayName?: string
      tier: 'current' | 'legacy' | 'deprecated' | 'limited'
    }[]
  } | null> => ipcRenderer.invoke('modelCatalog:refresh'),
  // FB02 F9: モデル一覧キャッシュ削除（キャッシュのみ。次回起動時に自動再取得）。
  modelCatalogClear: (): Promise<{ ok: boolean; existed: boolean; error?: string }> =>
    ipcRenderer.invoke('modelCatalog:clear'),

  // BG-CC Activity (FB02)
  // 購読（push 型）。既存 API は全て invoke だが、実行中ストリームは要求応答型では表現できない
  // ため ipcRenderer.on を初導入する。戻り値は購読解除関数（呼び忘れは listener leak になるため
  // renderer 側 cleanup で必ず呼ぶ）。
  onBgccActivity: (cb: (ev: BgccActivityEventDto) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: BgccActivityEventDto): void => cb(ev)
    ipcRenderer.on('bgcc:activity', listener)
    return () => {
      ipcRenderer.removeListener('bgcc:activity', listener)
    }
  },
  // 遅延マウント補完: main 側 ring buffer の直近イベント（起動時 TTL 更新の失敗検知用）。
  bgccActivityRecent: (): Promise<BgccActivityEventDto[]> =>
    ipcRenderer.invoke('bgcc:activityRecent'),
  // FB02 F7: 生ログ。copy は main 側でクリップボード書込（大きなログの二重転送回避）。
  bgccLogCopy: (): Promise<{ ok: boolean; path?: string; bytes?: number; error?: string }> =>
    ipcRenderer.invoke('bgccLog:copy'),
  bgccLogOpenFolder: (): Promise<{ ok: boolean; error?: string; path?: string }> =>
    ipcRenderer.invoke('bgccLog:openFolder'),

  // Profile Switch
  profileGetState: (): Promise<{
    currentProfile: 'manx' | 'legacy'
    lastBackupAt?: string
    backupDir: string
    claudeDir: string
    legacyMasterPath?: string
  }> => ipcRenderer.invoke('profile:getState'),
  profileSwitchToLegacy: (): Promise<{ backupPath: string; legacyClaudeMdPath: string }> =>
    ipcRenderer.invoke('profile:switchToLegacy'),
  profileSwitchToManx: (): Promise<{ restoredPaths: string[] }> =>
    ipcRenderer.invoke('profile:switchToManx'),

  // CC Launch
  // 038: pxpipe = 経路指定（auto=per-project トグル / force=常に pxpipe / off=常に素起動）。
  //      tabColor = wt.exe 経路のタブ色（ps フォールバックでは無視される）。
  ccLaunch: (args: {
    projectPath: string
    flags: string[]
    pxpipe?: 'auto' | 'force' | 'off'
    /** 042: `-r` の所有 PJ 証明。主プロセスが証明の無い `-r` を strip する（多層防御の第2層）。 */
    resumeBinding?: { value: string; projectPath: string }
    tabColor?: string
  }): Promise<{ shell: string; spawned: boolean; error?: string }> =>
    ipcRenderer.invoke('cc:launch', args),

  // CC 検出 + DELEGATE generation 再起動
  // DTO は main を import せず preload inline 複製（既存慣習）。
  ccListSessions: (): Promise<CcDetectResultDto> => ipcRenderer.invoke('cc:listSessions'),
  ccRestartAll: (): Promise<CcRestartAllResultDto> => ipcRenderer.invoke('cc:restartAll'),

  // Protocol Marker
  protocolRead: (projectPath: string): Promise<unknown> =>
    ipcRenderer.invoke('protocol:read', projectPath),
  protocolWrite: (projectPath: string, marker: unknown, force?: boolean): Promise<void> =>
    ipcRenderer.invoke('protocol:write', projectPath, marker, force),
  protocolDetect: (projectPath: string): Promise<unknown> =>
    ipcRenderer.invoke('protocol:detect', projectPath),
  protocolAutoMark: (projectPath: string): Promise<{ written: boolean; marker: unknown }> =>
    ipcRenderer.invoke('protocol:autoMark', projectPath),
  protocolEditMarker: (
    projectPath: string,
    edits: {
      protocol: string
      revision: string
      stage: 'stable' | 'beta' | 'alpha' | 'experimental'
      variant: string | null
      variant_alias: string | null
    }
  ): Promise<unknown> => ipcRenderer.invoke('protocol:editMarker', projectPath, edits),
  protocolRescanMarker: (projectPath: string): Promise<unknown> =>
    ipcRenderer.invoke('protocol:rescanMarker', projectPath),
  // 034-B: Full Re-scan 根治版 — append-only history、changed/unchanged 件数も返却。
  protocolFullRescan: (): Promise<{
    processed: number
    skipped: number
    failed: number
    changed: number
    unchanged: number
  }> => ipcRenderer.invoke('protocol:fullRescan'),
  // 034-B (UX 課題 1): 履歴閲覧用。Edit Marker Dialog 内の履歴セクションで使用。
  protocolReadHistory: (projectPath: string): Promise<unknown[] | null> =>
    ipcRenderer.invoke('protocol:readHistory', projectPath),
  // 034-B (UX 課題 3): 軽量「手動編集済み」判定。ProtocolBadge アイコン表示用。
  protocolHasManualEntry: (
    projectPath: string
  ): Promise<{ hasManual: boolean; lastManualAt: string | null; historyCount: number }> =>
    ipcRenderer.invoke('protocol:hasManualEntry', projectPath),
  // 034-B: Full Re-scan 対象件数（履歴ベース）。確認ダイアログの動的件数表示用。
  protocolCountFullRescanTargets: (): Promise<number> =>
    ipcRenderer.invoke('protocol:countFullRescanTargets'),
  protocolProfiles: (): Promise<
    {
      id: string
      label: string
      protocol: string
      revision: string
      stage: 'stable' | 'beta' | 'alpha' | 'experimental'
      stage_inferred: false
      variant: string | null
      variant_alias: string | null
    }[]
  > => ipcRenderer.invoke('protocol:profiles'),

  // Settings Change (CC Request Inbox, 031)
  settingsRead: (): Promise<string> => ipcRenderer.invoke('settings:read'),
  settingsHasPassword: (): Promise<boolean> => ipcRenderer.invoke('settings:hasPassword'),
  settingsReadRequest: (
    filePath: string
  ): Promise<
    | {
        filePath: string
        kind: 'settings'
        frontmatter: {
          request_id: string
          created_at: string
          purpose: string
          target: string
          status: 'pending' | 'applied' | 'rolled_back' | 'rejected'
          kind: 'settings'
        }
        rawMarkdown: string
        proposedSettingsJson: string
        proposedSettingsParsed: unknown | null
        parseError: string | null
        /** main が読んだ content の hash。apply 時に照合し preview→apply TOCTOU を塞ぐ。 */
        previewHash?: string
      }
    | {
        filePath: string
        kind: 'skill'
        frontmatter: {
          request_id: string
          created_at: string
          purpose: string
          target: string
          status: 'pending' | 'applied' | 'rolled_back' | 'rejected'
          kind: 'skill'
        }
        rawMarkdown: string
        proposedSkillBody: string
        parseError: string | null
        previewHash?: string
      }
  > => ipcRenderer.invoke('settings:readRequest', filePath),
  // file-path 化: object でなく filePath + previewHash を渡す。main が実ファイルを読み、
  // preview→apply TOCTOU（content-changed）と kind:skill 採用ゲートを server-side で強制する。
  settingsApplyChange: (
    filePath: string,
    previewHash: string,
    password: string
  ): Promise<{
    success: boolean
    backupPath?: string
    appliedAt?: string
    error?: string
    /** PIKES r1.4 §7-3-A: UI で 3 種エラー区別表示するための reason code */
    reason?:
      | 'read-error'
      | 'content-changed'
      | 'review-required'
      | 'terminal-state'
      | 'authentication-failed'
      | 'auth-missing-for-skill'
      | 'json-syntax-error'
      | 'allowlist-violation'
      | 'kind-target-mismatch'
      | 'glob-not-allowed'
      | 'unc-not-allowed'
      | 'parent-not-found'
      | 'realpath-failed'
      | 'write-failed'
      | 'post-verify-failed'
      | 'golden-name-collision'
      | 'hook-prerequisite-missing'
    rolledBack?: boolean
    /** ケース2（先行衝突）で一時名に退避採用した場合の実 skill 名 */
    renamedTo?: string
  }> => ipcRenderer.invoke('settings:applyChange', filePath, previewHash, password),
  settingsListLogs: (): Promise<
    {
      timestamp: string
      request_id: string
      purpose: string
      result: 'applied' | 'rolled_back' | 'failed'
      backup_path: string
      error?: string
    }[]
  > => ipcRenderer.invoke('settings:listLogs'),
  settingsListBackups: (): Promise<{ id: string; path: string; sizeBytes: number }[]> =>
    ipcRenderer.invoke('settings:listBackups'),
  settingsRollback: (backupId: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('settings:rollback', backupId),

  // Skill Proposals (Part B 候補ブラウザ, 構想3)
  skillProposalsDefaultFolder: (): Promise<string> =>
    ipcRenderer.invoke('skillProposals:defaultFolder'),
  skillProposalsList: (
    folder: string
  ): Promise<
    {
      filePath: string
      requestId: string
      target: string
      skillName: string
      sourceProject: string
      /** 提案日（frontmatter created_at）。一覧の認知負荷低減に使う */
      createdAt: string
      adoptionLabel: string
      title: string
      what: string
      why: string
      how: string
      axes: { axis: string; score: number | null; rationale: string }[]
      reviewBox: { verdict: string; findings: string; reviewerId: string; ccRebuttal: string }
      parseError: string | null
      state: 'candidate' | 'adopted' | 'rejected' | 'held'
      alreadyAdopted: boolean
      goldenCollision: boolean
      goldenCollisionResolved: boolean
      /** 同名衝突時の、提案の中身と golden の関係（衝突なしは 'none'） */
      goldenCollisionStatus: 'none' | 'applied' | 'unapplied' | 'stale'
      needsReview: boolean
      /** 採用ゲートの状態可視化（B-2）。main 側で採用ゲートと同じ判定から導出した値 */
      gate: {
        hasValidApprove: boolean
        state:
          | 'unreviewed'
          | 'reviewed-unapproved'
          | 'stale-approve'
          | 'approved'
          | 'downgraded'
          | 'terminal'
          | 'not-gated'
        adoptBlockReason: string | null
        findingsAckRequired: boolean
        reviewButtonVisible: boolean
      }
    }[]
  > => ipcRenderer.invoke('skillProposals:list', folder),
  // --- 提案の独立レビュー導線（§B-1 / §B-3）---
  skillProposalsReviewerStatus: (): Promise<{
    available: boolean
    version?: string
    reason?: 'reviewer-unavailable'
    detail?: string
  }> => ipcRenderer.invoke('skillProposals:reviewerStatus'),
  /** B-3: 依頼文をクリップボードへ。B-1 が内部で使う文字列と同一関数の戻り値。 */
  skillProposalsReviewRequestText: (filePath: string): Promise<string> =>
    ipcRenderer.invoke('skillProposals:reviewRequestText', filePath),
  /** 解析エラーの修復依頼文をクリップボードへ。アプリは提案 MD を書き換えない（直すのは CC） */
  skillProposalsRepairRequestText: (filePath: string, folderPath?: string): Promise<string> =>
    ipcRenderer.invoke('skillProposals:repairRequestText', filePath, folderPath),
  /** 解析エラー提案の修復用 Claude Code を起動する（D1, AC1） */
  skillProposalsLaunchRepair: (
    filePath: string,
    folderPath?: string
  ): Promise<{
    ok: boolean
    error?: string
    promptFilePath?: string
    shell?: string
    rejectedSettings?: string[]
    appliedFlags?: string[]
    cwd?: string
    detectedSettings?: string[]
  }> => ipcRenderer.invoke('skillProposals:launchRepair', filePath, folderPath),
  /** 祖先プロジェクト設定検査（AC16） */
  skillProposalsCheckRepairEnvironment: (
    filePath: string
  ): Promise<{ ok: boolean; error?: string; detectedSettings: string[] }> =>
    ipcRenderer.invoke('skillProposals:checkRepairEnvironment', filePath),
  /** 方針つきで改稿+再レビューへ差し戻す依頼文（人間の一言をループへ投入する） */
  skillProposalsRevisionDirectiveText: (
    filePath: string,
    title: string,
    findings: string,
    direction: string
  ): Promise<string> =>
    ipcRenderer.invoke(
      'skillProposals:revisionDirectiveText',
      filePath,
      title,
      findings,
      direction
    ),
  // --- ユーザーコメント → CC 対話 ---
  /** コメントスレッドとゲート状態（表示と採用判定が同じ読み取り結果に基づくようにする） */
  skillProposalsCommentThread: (requestId: string, filePath: string): Promise<CommentThreadView> =>
    ipcRenderer.invoke('skillProposals:commentThread', requestId, filePath),
  /** コメント追加。`expectedProposalHash` 不一致なら保存されず retryable が返る（入力は捨てない） */
  skillProposalsAddComment: (
    requestId: string,
    filePath: string,
    body: string,
    expectedProposalHash: string
  ): Promise<{ ok: boolean; reason?: string; retryable?: boolean; commentId?: string }> =>
    ipcRenderer.invoke(
      'skillProposals:addComment',
      requestId,
      filePath,
      body,
      expectedProposalHash
    ),
  /** 取り下げ（`open` のときだけ。応答済みを無かったことにしない） */
  skillProposalsWithdrawComment: (
    requestId: string,
    filePath: string,
    commentId: string
  ): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('skillProposals:withdrawComment', requestId, filePath, commentId),
  /** 壊れたレコード 1 件の隔離（**UI 専用**。CC は隔離できない） */
  skillProposalsQuarantineComment: (
    requestId: string,
    commentId: string,
    reasonCode: string,
    observedProblem: string
  ): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke(
      'skillProposals:quarantineComment',
      requestId,
      commentId,
      reasonCode,
      observedProblem
    ),
  /** 応答の supersede（stale ack を拒みたいときの出口。`resolved` のときだけ） */
  skillProposalsSupersedeComment: (
    requestId: string,
    filePath: string,
    commentId: string
  ): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('skillProposals:supersedeComment', requestId, filePath, commentId),
  /** CC への対話依頼文（クリップボードへ渡す）。**起動しないので設定は効かない** */
  skillProposalsCommentDialogueText: (requestId: string, filePath: string): Promise<string> =>
    ipcRenderer.invoke('skillProposals:commentDialogueText', requestId, filePath),
  /**
   * 導線①: アプリが CC を起動して応答させる。依頼文は temp ファイル＋env で渡し、
   * 起動引数には長文も temp パスも載せない（`flags` は空白連結されるため）。設定が効くのはこちら。
   */
  skillProposalsLaunchDialogue: (
    requestId: string,
    filePath: string
  ): Promise<{
    ok: boolean
    error?: string
    promptFilePath?: string
    shell?: string
    /** 安全でないため起動引数から除外した設定値（UI が警告として出す） */
    rejectedSettings?: string[]
    /** 実際に CC へ渡した起動引数（設定が効いているかの物理証拠。UI が表示する） */
    appliedFlags?: string[]
  }> => ipcRenderer.invoke('skillProposals:launchDialogue', requestId, filePath),

  /** B-1: レビュー実行（read-only sandbox）。成功時のみ台帳へ upsert される。 */
  skillProposalsReview: (
    filePath: string
  ): Promise<
    | { status: 'ok'; requestId: string; verdict: string; findings: string; proposalHash: string }
    | {
        status: 'reviewer-unavailable' | 'proposal-id-missing' | 'launch-failed' | 'output-unusable'
        message: string
      }
  > => ipcRenderer.invoke('skillProposals:review', filePath),
  skillProposalsSetState: (
    requestId: string,
    state: 'candidate' | 'adopted' | 'rejected' | 'held',
    opts?: { acknowledgeNoApply?: boolean; folder?: string }
  ): Promise<void> => ipcRenderer.invoke('skillProposals:setState', requestId, state, opts),
  // 提案の合成: 主ボタン（合成して golden へ入れる）・進み具合・取り消し・進み具合の push 通知
  skillProposalsComposeStart: (input: { skillName: string; sourceIds?: string[] }): Promise<ComposeStartResultDto> =>
    ipcRenderer.invoke('skillProposals:composeStart', input),
  skillProposalsComposeSelectable: (input: { skillName: string }): Promise<ComposeSelectableResultDto> =>
    ipcRenderer.invoke('skillProposals:composeSelectable', input),
  skillProposalsComposeDiscard: (input: { compositeId: string }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('skillProposals:composeDiscard', input),
  skillProposalsComposeRevise: (input: { compositeId: string }): Promise<ComposeStartResultDto> =>
    ipcRenderer.invoke('skillProposals:composeRevise', input),
  skillProposalsComposeStatus: (): Promise<ComposeStatusDto[]> => ipcRenderer.invoke('skillProposals:composeStatus'),
  skillProposalsComposeCancel: (workspaceDir: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('skillProposals:composeCancel', workspaceDir),
  onComposeStatus: (cb: (s: ComposeStatusDto) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, s: ComposeStatusDto): void => cb(s)
    ipcRenderer.on('compose:status', listener)
    return () => {
      ipcRenderer.removeListener('compose:status', listener)
    }
  },
  // L0_011: 停止の 1 問への回答・指摘ごとの棄却の記録・描画の報告・受け皿の一覧と閉じる
  skillProposalsComposeAnswer: (input: {
    caseId: string
    option: ComposeAnswerOption
    origins?: Array<{ gateId: string; origin: 'diff' | 'base' }>
  }): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('skillProposals:composeAnswer', input),
  skillProposalsComposeAdjudicate: (input: {
    caseId: string
    compositeId: string
    gateId: string
    reason: string
  }): Promise<{ ok: boolean; error?: string; remaining?: number }> =>
    ipcRenderer.invoke('skillProposals:composeAdjudicate', input),
  composeRendered: (seq: number): void => {
    void ipcRenderer.invoke('skillProposals:composeRendered', seq).catch(() => undefined)
  },
  skillProposalsReceptacles: (input?: { skillName?: string }): Promise<ReceptacleSummary[]> =>
    ipcRenderer.invoke('skillProposals:receptacles', input ?? {}),
  skillProposalsReceptacleClose: (input: {
    path: string
    how: ReceptacleClosedHow
  }): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('skillProposals:receptacleClose', input),
  // 採用は main 集約 atomic ゲート経由（settings:applyChange を包む）。戻り値は applyChange と同型 + review-required。
  skillProposalsAdopt: (
    filePath: string,
    password: string,
    override: boolean,
    /**
     * 指摘を承知したうえで採用することを示すペイロード（降格ラベル、または推奨のまま
     * 据え置いた指摘を含む提案が対象）。main が現在の提案・レビュー内容から 3 値を
     * 再計算して照合するため、画面に出ていた内容と一致しない ack は拒否される。
     */
    findingsAck?: {
      accepted: true
      labelShown?: string
      proposalHash: string
      findingsHash: string
      adjudicationsKey: string
    },
    /**
     * コメント応答側の ack。**`findingsAck` とは次元が別**（r39#1）。
     * 混ぜて 1 つにすると、コメントが stale 化しただけで既存の `deferred` ack まで
     * 巻き添え失効する。main が現 content から再計算して照合する点は findingsAck と同じ。
     */
    commentsAck?: { proposalHashAtAck: string; commentsKey: string },
    expectedHash?: string
  ): Promise<{
    success: boolean
    backupPath?: string
    appliedAt?: string
    error?: string
    reason?:
      | 'read-error'
      | 'content-changed'
      | 'review-required'
      | 'terminal-state'
      | 'findings-ack-required'
      // ユーザーコメント系。**break-glass では免除されない**（未応答のまま採用させない）
      | 'comments-unanswered'
      | 'comments-broken'
      | 'comments-ack-required'
      | 'authentication-failed'
      | 'auth-missing-for-skill'
      | 'json-syntax-error'
      | 'allowlist-violation'
      | 'kind-target-mismatch'
      | 'glob-not-allowed'
      | 'unc-not-allowed'
      | 'parent-not-found'
      | 'realpath-failed'
      | 'write-failed'
      | 'post-verify-failed'
      | 'golden-name-collision'
    rolledBack?: boolean
    renamedTo?: string
    /** コメント系ブロックの人間向け説明（main が組み立て、UI はそのまま出す） */
    commentDetail?: string
  }> =>
    ipcRenderer.invoke(
      'skillProposals:adopt',
      filePath,
      password,
      override,
      findingsAck ?? null,
      commentsAck ?? null,
      expectedHash
    ),

  // Skill Firing Stats (Part B 発火統計, 構想4-A, 読み取り専用)
  skillFiringStatsCompute: (): Promise<{
    stats: {
      skill: string
      count: number
      lastFiredAt: string | null
      byProject: { project: string; count: number }[]
    }[]
    totalFirings: number
    filesScanned: number
    scopeNote: string
  }> => ipcRenderer.invoke('skillFiringStats:compute'),
  // Enforcement Stats (Part B Phase 2a, countable 4型 発火可視化, 読み取り専用。skill は skillFiringStatsCompute を使用)
  enforcementStatsCompute: (): Promise<{
    hooksStop: EnforcementTypeStat
    rulesB: EnforcementTypeStat
    deny: { settingsJson: EnforcementTypeStat; rulePolicy: EnforcementTypeStat; scopeNote: string }
    marshal: EnforcementTypeStat
    rulesLayerA: { note: string }
    filesScanned: number
  }> => ipcRenderer.invoke('enforcementStats:compute'),
  skillMdOpen: (
    skillName: string
  ): Promise<{ ok: boolean; reason?: 'not-found'; error?: string; path: string }> =>
    ipcRenderer.invoke('skillMd:open', skillName),

  // Emergency override (Part B 判断H, Doctor 経由)
  emergencyOverrideCreate: (input: {
    name: string
    reason: string
    drDecisionId: string
    expiresAt?: string
  }): Promise<void> => ipcRenderer.invoke('emergencyOverride:create', input),
  emergencyOverrideListObsolete: (): Promise<
    {
      name: string
      goldenVersion: string
      reason: string
      drDecisionId: string
      createdAt: string
      expiresAt?: string
    }[]
  > => ipcRenderer.invoke('emergencyOverride:listObsolete'),
  emergencyOverrideRemove: (name: string): Promise<void> =>
    ipcRenderer.invoke('emergencyOverride:remove', name),

  // Skill Lifecycle（採用済み skill の棚卸し・撤去・衝突解決。CCPIT_058）
  skillLifecycleList: (): Promise<
    { ok: true; result: SkillInventoryResult } | { ok: false; error: string }
  > => ipcRenderer.invoke('skillLifecycle:list'),
  skillLifecycleRemove: (args: { name: string; stateToken: string }): Promise<RemoveSkillResult> =>
    ipcRenderer.invoke('skillLifecycle:remove', args),
  skillLifecycleRestoreRemoved: (removalId: string): Promise<RestoreRemovedResult> =>
    ipcRenderer.invoke('skillLifecycle:restoreRemoved', removalId),
  skillLifecycleResolveCollision: (args: {
    originalName: string
    tempName: string
    keep: 'original' | 'temp'
    stateToken: string
  }): Promise<ResolveCollisionResult> =>
    ipcRenderer.invoke('skillLifecycle:resolveCollision', args),
  skillLifecycleRestoreArchive: (args: {
    name: string
    archivePath: string
  }): Promise<RestoreArchiveResult> => ipcRenderer.invoke('skillLifecycle:restoreArchive', args),

  // Developer Tools
  devGetCcpitDir: (): Promise<string> => ipcRenderer.invoke('dev:getCcpitDir'),
  devGetClaudeDir: (): Promise<string> => ipcRenderer.invoke('dev:getClaudeDir'),
  devToggleDevTools: (): Promise<void> => ipcRenderer.invoke('dev:toggleDevTools'),
  devRelaunchApp: (): Promise<void> => ipcRenderer.invoke('dev:relaunchApp'),

  // App
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),

  // System
  selectFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:selectFolder'),
  selectFile: (): Promise<string | null> => ipcRenderer.invoke('dialog:selectFile'),
  selectPitFile: (): Promise<string | null> => ipcRenderer.invoke('dialog:selectPitFile'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),
  openPath: (folderPath: string): Promise<string> =>
    ipcRenderer.invoke('shell:openPath', folderPath),
  clipboardWrite: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:write', text),
  // 036: CCES (ClaudeCode-ExtensionsSummary) Ver.1.0
  ccesGenerate: (args: {
    projectPath: string
  }): Promise<
    | {
        ok: true
        markdown: string
        bytes: number
        oversized: boolean
        summary: { metadata: { projectName: string } } & Record<string, unknown>
      }
    | { ok: false; error: string }
  > => ipcRenderer.invoke('cces:generate', args),

  // MCP (Model Context Protocol) — Phase A
  mcpListServers: (args: {
    scope: 'global' | 'project'
    projectPath?: string
  }): Promise<
    | {
        ok: true
        servers: {
          name: string
          command?: string
          args?: string[]
          env?: Record<string, string>
          type?: 'stdio' | 'sse' | 'http'
          url?: string
          headers?: Record<string, string>
          disabledTools?: string[]
        }[]
      }
    | { ok: false; error: string }
  > => ipcRenderer.invoke('mcp:listServers', args),
  mcpAddServer: (args: {
    scope: 'global' | 'project'
    server: {
      name: string
      command?: string
      args?: string[]
      env?: Record<string, string>
      type?: 'stdio' | 'sse' | 'http'
      url?: string
      headers?: Record<string, string>
      disabledTools?: string[]
    }
    projectPath?: string
  }): Promise<{ ok: boolean; error?: string; cliStdout?: string; cliStderr?: string }> =>
    ipcRenderer.invoke('mcp:addServer', args),
  mcpRemoveServer: (args: {
    scope: 'global' | 'project'
    name: string
    projectPath?: string
  }): Promise<{ ok: boolean; error?: string; cliStdout?: string; cliStderr?: string }> =>
    ipcRenderer.invoke('mcp:removeServer', args),
  mcpUpdateDisabledTools: (args: {
    scope: 'global' | 'project'
    name: string
    disabledTools: string[]
    projectPath?: string
  }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('mcp:updateDisabledTools', args),
  mcpCheckCli: (): Promise<boolean> => ipcRenderer.invoke('mcp:checkCli'),

  // pxpipe ダッシュボード統合（R1/R2/R3）。handler 実体は main/pxpipeJaIpc.ts。
  // 埋め込みビューは別オリジン(127.0.0.1:port)で描画されるため、これらの API は
  // 同一オリジンポリシーにより iframe 内からは到達できない（特権露出ゼロ）。
  pxpipeViewStatus: (): Promise<PxpipeViewStatusDto> => ipcRenderer.invoke('pxpipeView:status'),
  pxpipeViewStart: (): Promise<{
    ok: boolean
    reason?: string
    status?: PxpipeViewStatusDto
  }> => ipcRenderer.invoke('pxpipeView:start'),
  pxpipeViewStopJa: (): Promise<{
    ok: boolean
    reason?: string
    status?: PxpipeViewStatusDto
  }> => ipcRenderer.invoke('pxpipeView:stopJa'),
  pxpipeViewPickJaScript: (): Promise<{
    ok: boolean
    canceled: boolean
    reason?: string
    status?: PxpipeViewStatusDto
  }> => ipcRenderer.invoke('pxpipeView:pickJaScript'),

  // pxpipe 画像化スコープと版（070 M4）
  pxpipe: {
    getScopeStatus: (): Promise<PxpipeScopeStatusDto> => ipcRenderer.invoke('pxpipe:getScopeStatus'),
    setScopeModel: (model: string, on: boolean): Promise<SetScopeModelResultDto> =>
      ipcRenderer.invoke('pxpipe:setScopeModel', { model, on }),
    getVersionStatus: (): Promise<PxpipeVersionStatusDto> => ipcRenderer.invoke('pxpipe:getVersionStatus')
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
