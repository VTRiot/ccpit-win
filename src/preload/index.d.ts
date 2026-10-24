import { ElectronAPI } from '@electron-toolkit/preload'
import type { CommentThreadView } from '../main/services/commentOps'
import type {
  SkillInventoryResult,
  RemoveSkillResult,
  RestoreRemovedResult,
  ResolveCollisionResult
} from '../main/services/skillLifecycle'
import type { RestoreArchiveResult } from '../main/services/settingsChange'
import type { GoldenWriteAuthReason } from '../main/services/goldenWriteAuth'
import type {
  ComposeAdoptedInfo,
  ComposeAnswerOption,
  ComposeCaseFields,
  ComposeCcStart,
  ComposePhase,
  ReceptacleClosedHow,
  ReceptacleSummary
} from '../shared/composeContract'

// Enforcement 発火統計の型別集計（Part B Phase 2a）。main/services/enforcementStats.ts と同型を inline 複製。
interface EnforcementTypeStat {
  total: number
  ranking: { key: string; count: number }[]
  scopeNote: string
}

// CC 検出 + DELEGATE 再起動。main/services と同型を inline 複製。
interface CcDetectedCcDto {
  pid: number
  resolution: 'resolved' | 'resume-only' | 'unresolved'
  sessionId?: string
  cwd?: string
  status?: 'busy' | 'waiting' | 'idle' | 'unknown'
  name?: string
  waitingFor?: string
  createdAt?: string | null
}
interface CcDetectSummaryDto {
  total: number
  resolved: number
  resumeOnly: number
  unresolved: number
  sessions: CcDetectedCcDto[]
}
type CcDetectResultDto = { ok: true; summary: CcDetectSummaryDto } | { ok: false; error: string }
type CcRestartAllResultDto =
  | {
      ok: true
      generation: number
      summary: CcDetectSummaryDto | null
      detectError?: string
      pxpipeWarning?: string
    }
  | { ok: false; error: string }

// 提案の合成（main/services/composeLaunch.ts の ComposeStatus と同型）
// L0_011: 案件・巡・手番の項目は src/shared/composeContract.ts の契約（caseId を持つ作業場だけに付く）
interface ComposeStatusDto extends Partial<ComposeCaseFields> {
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

// 合成の元提案の選択（main/services/composeIpc.ts の ComposePickerItem と同型）
interface ComposePickerItemDto {
  requestId: string
  title: string
  adoptionLabel: string
  selectable: boolean
  /** 選べない理由 */
  reason?: 'unreviewed' | 'findings' | 'rejected' | 'adopted' | 'composite' | 'composed' | 'waiting' | 'notCandidate'
  /** composed／waiting のときその合成提案の ID、findings のとき verdict */
  detail?: string
}
type ComposeSelectableResultDto = { ok: true; items: ComposePickerItemDto[] } | { ok: false; error: string }

// FB02: BG-CC アクティビティイベント（main/services/bgccActivityBus.ts と同型）。
interface BgccActivityEventDto {
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

interface ParcFermeAPI {
  /** 「ブランクではない UI が描画された」通知（main 側 watchdog の解除条件）。fire-and-forget */
  rendererReady(kind: 'ok' | 'page-error' | 'root-error'): void
  /** renderer 側で捕捉したエラーを main のログへ送る。fire-and-forget */
  reportRendererError(payload: {
    scope: string
    errorId?: string
    message: string
    stack?: string
    componentStack?: string
  }): void
  goldenList(): Promise<string[]>
  goldenPreview(templateName: string): Promise<{ relativePath: string; source: string }[]>
  /** L0_013: settings.json の層ごとの差と承認の印（何も書かない） */
  goldenPreviewSettingsLayers(
    templateName: string
  ): Promise<import('../main/services/settingsLayers').SettingsLayersPreviewResult>
  /** settingsApproval は goldenPreviewSettingsLayers が返した印（承認が要るときだけ） */
  goldenDeploy(
    templateName: string,
    password: string,
    settingsApproval?: string
  ): Promise<{ deployed: string[]; backedUp: string[]; errors: string[] }>
  goldenCheckExisting(): Promise<{
    exists: boolean
    hasSettings: boolean
    hasClaude: boolean
  }>
  goldenPendingReconcile(): Promise<
    {
      path: string
      case: 'unchanged' | 'auto-update' | 'user-modified' | 'conflict' | 'new' | 'restore'
      owner: 'golden' | 'adopted' | 'user' | 'promoted'
      willBackup: boolean
      wouldChangeContent: boolean
      hasBaseRecord: boolean
      upstreamAdvanced: boolean
    }[]
  >
  goldenResolveReconcile(
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
      reason: 'not-pending' | 'stale-destination' | 'no-base-record' | 'promote-failed' | 'no-ledger'
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
  }>
  goldenFollowUpState(): Promise<
    {
      path: string
      kind: 'deferred' | 'unmanaged' | 'overlay'
      drifted: boolean | null
      lapsed?: boolean
      decidedAt?: string
    }[]
  >
  goldenRemanage(
    paths: string[]
  ): Promise<{ unmanaged: string[]; deferred: string[]; manifestUpdated: boolean }>
  goldenDiscardOverlay(paths: string[]): Promise<{ discarded: string[] }>
  goldenListUndoGenerations(): Promise<
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
  >
  goldenRestoreUndoBackups(
    requests: { rel: string; generationStamp: string }[]
  ): Promise<
    {
      rel: string
      status: 'restored_and_promoted' | 'not_restored' | 'restored_overlay_failed'
      reason?: string
    }[]
  >
  // CCPIT_064 / ADR 0003: 確認ダイアログの「Claude Code に相談」。書込経路ではない。
  goldenLaunchMergeConsult(input: {
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
  }>
  goldenApplyReconcile(paths: string[]): Promise<{
    applied: string[]
    failed: { path: string; message: string }[]
    backups: string[]
    skipped: string[]
    manifestUpdated: boolean
    blocked?: 'source-unreadable' | 'path-collisions'
  }>
  goldenDeferReconcile(paths: string[]): Promise<{ deferred: string[]; manifestUpdated: boolean }>

  // Golden Promotion Browser (Golden 昇格ブラウザ)
  /** 選んだ候補 1 件の差分の表示（一覧では作らない。CCPIT_L0_004 W6）。差分が無ければ null */
  goldenPromotionDiffDetail(item: {
    source: string
    skillName: string
    capturedContent?: string
  }): Promise<string | null>
  goldenPromotionList(): Promise<
    {
      id: string
      title: string
      skillName: string
      addedAt: string
      source: 'rescue' | 'normal' | 'proposal'
      state: 'pending' | 'dismissed' | 'applied_unpushed' | 'distributed'
      diffState?: 'new' | 'modified' | 'identical' | 'stale-local' | 'diverged' | 'proposal-conflict'
      targetPath: string
      localPath: string
      description: string
      diffSummary?: string
      diffDetail?: string
      skillDetail?: {
        name: string
        title: string
        description: string
        what?: string
        why?: string
        how?: string
        rawContent?: string
      }
      isAdopted?: boolean
      authorStatement: string
      lane: string
      viewed: boolean
      promotedAt?: string
      commitSha?: string
      capturedContent?: string
      skippedFiles?: {
        relPath: string
        reason: 'bak-file' | 'os-vcs-artifact' | 'size-exceeded' | 'symlink-or-special' | 'pending-translation'
        size: number
      }[]
      extraGoldenFiles?: {
        relPath: string
        size: number
      }[]
      proposalRequestId?: string
      proposalHash?: string
      proposalFilePath?: string
      isConflicted?: boolean
      conflictCount?: number
      conflictPeers?: {
        id: string
        requestId: string
        title: string
        addedAt: string
        hash12: string
        filePath: string
        proposalState: string
      }[]
      diverged?: boolean
      companionFilesCount?: number
      /** 合成提案が有効なとき、その元提案の request_id（この提案が代わりに昇格される） */
      composeSources?: string[]
      /** 元提案が有効な合成提案に置き換えられているとき、その合成提案の request_id（個別には昇格できない） */
      composedInto?: string
      /** 合成の元に選ばれなかった提案が、合成提案の昇格を待っているとき、その合成提案の request_id（個別には昇格できない） */
      composeWaitingFor?: string
      /** 元提案が、登録済みだが有効でない（未 approve など）合成提案の元になっているとき、その合成提案の request_id（表示専用・個別には昇格できない） */
      composeHeldBy?: string
      /** 握っている合成提案が異常で通常の却下では解けない: missing＝MD が提案プールに無い／changed＝登録後に MD が書き換わった／adopted＝台帳が registered のまま adopted */
      composeHoldAbnormal?: 'missing' | 'changed' | 'adopted'
      /** golden を git から読めず、この行の判定が確かでない。反映できない（理由は diffSummary） */
      gitReadError?: boolean
    }[]
  >
  goldenPromotionMarkViewed(id: string): Promise<{ ok: boolean }>
  goldenPromotionSetState(
    ids: string[],
    state: 'pending' | 'dismissed' | 'applied_unpushed' | 'distributed'
  ): Promise<{ ok: boolean }>
  goldenPromotionRejectConflicted(id: string): Promise<{
    ok: boolean
    requestId?: string
    error?: string
  }>
  // golden を書き換える操作は password を取る。誤り・未入力・未登録なら主処理が何も書かずに reason 付きで返す（CCPIT_L0_003）
  goldenPromotionApply(ids: string[], password: string): Promise<{
    success: boolean
    commitSha?: string
    manifestSha256?: string
    appliedItems: string[]
    error?: string
    runnerLog?: string
    reason?: GoldenWriteAuthReason
  }>
  goldenPromotionListDeployed(): Promise<
    {
      name: string
      title: string
      description: string
      jaPath: string
      enPath: string
      hasEn: boolean
      status: 'deployed' | 'withdrawn'
      detail: {
        name: string
        title: string
        description: string
        what?: string
        why?: string
        how?: string
        rawContent?: string
      }
      promotedAt?: string
      withdrawnAt?: string
      ledgerMismatch?: boolean
      mismatchedFiles?: {
        path: string
        ledgerHash: string
        actualHash: string
      }[]
    }[] & {
      ledgerCorrupt?: boolean
      ledgerError?: string
      skills?: any[]
    }
  >
  goldenPromotionWithdraw(skillName: string, password: string): Promise<{
    success: boolean
    appliedItems: string[]
    error?: string
    reason?: GoldenWriteAuthReason
  }>
  goldenPromotionRestore(skillName: string, password: string): Promise<{
    success: boolean
    appliedItems: string[]
    error?: string
    reason?: GoldenWriteAuthReason
  }>
  goldenPromotionRollback(requestId: string, password: string): Promise<{
    success: boolean
    requestId: string
    commitSha?: string
    restoredGolden: string[]
    restoredLocal: string[]
    restoredRecords: string[]
    skipped: Array<{ path: string; reason: string }>
    error?: string
    reason?: GoldenWriteAuthReason
  }>
  goldenPromotionGetLeaseStatus(): Promise<{
    exists: boolean
    leaseId?: string
    blob?: {
      lane: string
      issued_by: string
      issued_at: string
      expires_at: string
      manifest_sha256: string
      base_master: string
      session8: string
    }
    rawContent?: string
    parseError?: string
    isExpired?: boolean
    remainingSeconds?: number
    expiresAtIso?: string
    currentMasterMatches?: boolean
    currentMaster?: string
    orphanedWorktrees?: Array<{ path: string; branch: string }>
    /** リース・blob・master を git から読めなかった理由（CCPIT_L0_014）。あるとき exists:false は「リースが無い」ではなく「確かめられなかった」 */
    readError?: string
    /** 残置 worktree の一覧を git から読めなかった理由（CCPIT_L0_014）。あるとき orphanedWorktrees の空は「0 件」ではない */
    worktreeReadError?: string
    matchingRunRecord?: {
      runId: string
      pid: number
      lane: string
      manifestSha256: string
      leaseId?: string
      currentStep?: { i: number; n: number; name: string }
      startedAt: string
      lastHeartbeatAt: string
      endedAt?: string
      exitCode?: number
      repoDir: string
    }
    isOwnerAlive?: boolean
    earlyReleaseEntitlement?: {
      entitled: boolean
      reason?: string
      runningRunId?: string
      runningPid?: number
    }
  }>
  goldenPromotionReleaseExpiredLease(expectedLeaseId: string, password: string): Promise<{
    success: boolean
    releasedLeaseId: string
    error?: string
    reason?: GoldenWriteAuthReason
  }>
  goldenPromotionCleanupArtifacts(password: string): Promise<{
    cleanedWorktrees: string[]
    cleanedBranches: string[]
    cleanedTempDirs: string[]
    keptUnknownOwner?: string[]
    success?: false
    error?: string
    reason?: GoldenWriteAuthReason
  }>
  goldenPromotionVerifyEarlyRelease(): Promise<{
    entitled: boolean
    reason?: string
    runningRunId?: string
    runningPid?: number
    reconciledRunIds?: string[]
  }>
  goldenPromotionReleaseEarlyLease(expectedLeaseId: string, password: string): Promise<{
    success: boolean
    releasedLeaseId: string
    cancelled?: boolean
    error?: string
    reason?: GoldenWriteAuthReason
  }>
  goldenPromotionDetectLedgerDrift(): Promise<{
    hasDrift: boolean
    unrecordedCommits: Array<{
      sha: string
      shortSha: string
      appliedBy: string
      subject: string
      skillsAffected: string[]
    }>
    ledgerStatus?: 'ok' | 'not-found' | 'corrupt'
    ledgerError?: string
    /** 履歴（git log・diff-tree）を読めず、ずれの検出が完了しなかった理由。あるときの hasDrift:false は「ずれ無し」ではない */
    gitScanError?: string
  }>
  /** 一覧の検出が完了したかの診断（読み取りだけ）。rescueScanError があるとき、救済候補の 0 件は「確かに無い」ではない */
  goldenPromotionScanDiagnostics(): Promise<{ rescueScanError?: string }>
  goldenPromotionApplyLedgerCatchup(
    unrecordedSha: string,
    approvalContext: { approvedBy: string; approvedAt: string; confirmationHash: string },
    password: string
  ): Promise<{
    success: boolean
    commitSha?: string
    error?: string
    reason?: GoldenWriteAuthReason
  }>
  onGoldenPromotionProgress(callback: (data: {
    runId: string
    stepIndex: number
    totalSteps: number
    stepName: string
    timestamp: string
    leaseId?: string
  }) => void): () => void

  migrationScan(
    projectPath: string
  ): Promise<{ path: string; name: string; lines: number; sizeBytes: number; category: string }[]>
  migrationGeneratePack(
    scannedFiles: {
      path: string
      name: string
      lines: number
      sizeBytes: number
      category: string
    }[]
  ): Promise<string>
  migrationParseImport(
    mdContent: string
  ): Promise<{ filename: string; targetPath: string; content: string }[]>
  migrationImportToGolden(
    blocks: { filename: string; targetPath: string; content: string }[],
    templateName: string
  ): Promise<{ placed: string[]; errors: string[] }>
  migrationImportPit(filePath: string): Promise<{
    entries: { path: string; content: string; lines: number }[]
    claudeMdPreview: string
    claudeMdLines: number
    rulesCount: number
    skillsCount: number
    coverageMapSummary: { totalRows: number; uncoveredCount: number } | null
    metricsRaw: string | null
    validationErrors: string[]
  }>
  migrationDeployPit(
    entries: { path: string; content: string; lines: number }[]
  ): Promise<{ deployed: string[]; backedUp: string[]; errors: string[] }>

  projectsList(): Promise<
    {
      name: string
      path: string
      status: string
      createdAt: string
      // 034-B: confirmed 廃止。明示意思は protocol.json の history に統合。
    }[]
  >
  projectsCreate(
    projectPath: string,
    projectName: string
  ): Promise<{ success: boolean; created: string[]; errors: string[] }>
  projectsRemove(projectPath: string): Promise<void>
  projectsDiscover(rootPath: string): Promise<
    {
      path: string
      name: string
      hasClaudeMd: boolean
      hasCcpitDir: boolean
      alreadyManaged: boolean
    }[]
  >
  projectsImport(
    paths: string[]
  ): Promise<{ name: string; path: string; status: string; createdAt: string }[]>
  projectsAddExternal(
    projectPath: string
  ): Promise<{ name: string; path: string; createdAt: string; external?: boolean }[]>
  projectsRemoveFromList(paths: string[]): Promise<{ removed: string[] }>
  projectsSetFavorite(projectPath: string, favorite: boolean): Promise<void>
  projectsSetPxpipeEnabled(projectPath: string, enabled: boolean): Promise<void>
  projectsConsumeMigrationNotice(): Promise<{ migrated: number; total: number } | null>
  // 034-B: protocol-history-v2 マイグレーション通知。
  projectsConsumeProtocolHistoryMigrationNotice(): Promise<{
    migrated: number
    total: number
  } | null>

  rkSnapshot(): Promise<{
    id: string
    timestamp: string
    knownGood: boolean
    label: 'manual' | 'pre-restore' | 'post-restore'
    fileCount: number
  }>
  rkList(): Promise<
    {
      id: string
      timestamp: string
      knownGood: boolean
      label: 'manual' | 'pre-restore' | 'post-restore'
      fileCount: number
    }[]
  >
  rkMarkKnownGood(id: string): Promise<void>
  rkDiff(id: string): Promise<
    {
      relativePath: string
      risk: string
      status: string
      currentContent?: string
      snapshotContent?: string
    }[]
  >
  rkRestore(
    id: string
  ): Promise<{ quarantinePath: string; restoredFiles: string[]; errors: string[] }>

  daGenerate(symptom: string): Promise<string>
  daSave(content: string, outputDir: string): Promise<string>
  daDefaultOutputDir(): Promise<string>

  healthCheck(): Promise<{ name: string; status: string; detail: string }[]>
  healthDenyList(): Promise<string[]>
  healthCcCli(): Promise<boolean>

  configGet(): Promise<{
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
  }>
  configSet(
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
  }>

  modelCatalogGet(): Promise<{
    fetchedAt: string
    source: 'official' | 'env'
    stale: boolean
    models: {
      id: string
      displayName?: string
      tier: 'current' | 'legacy' | 'deprecated' | 'limited'
    }[]
  } | null>
  modelCatalogRefresh(): Promise<{
    fetchedAt: string
    source: 'official' | 'env'
    stale: boolean
    models: {
      id: string
      displayName?: string
      tier: 'current' | 'legacy' | 'deprecated' | 'limited'
    }[]
  } | null>
  modelCatalogClear(): Promise<{ ok: boolean; existed: boolean; error?: string }>

  onBgccActivity(cb: (ev: BgccActivityEventDto) => void): () => void
  bgccActivityRecent(): Promise<BgccActivityEventDto[]>
  bgccLogCopy(): Promise<{ ok: boolean; path?: string; bytes?: number; error?: string }>
  bgccLogOpenFolder(): Promise<{ ok: boolean; error?: string; path?: string }>

  profileGetState(): Promise<{
    currentProfile: 'manx' | 'legacy'
    lastBackupAt?: string
    backupDir: string
    claudeDir: string
    legacyMasterPath?: string
  }>
  profileSwitchToLegacy(): Promise<{ backupPath: string; legacyClaudeMdPath: string }>
  profileSwitchToManx(): Promise<{ restoredPaths: string[] }>

  ccLaunch(args: {
    projectPath: string
    flags: string[]
    pxpipe?: 'auto' | 'force' | 'off'
    /** 042: `-r` の所有 PJ 証明。主プロセスが証明の無い `-r` を strip する（多層防御の第2層）。 */
    resumeBinding?: { value: string; projectPath: string }
    tabColor?: string
  }): Promise<{ shell: string; spawned: boolean; error?: string }>

  // CC 検出 + DELEGATE generation 再起動
  ccListSessions(): Promise<CcDetectResultDto>
  ccRestartAll(): Promise<CcRestartAllResultDto>

  protocolRead(projectPath: string): Promise<unknown>
  protocolWrite(projectPath: string, marker: unknown, force?: boolean): Promise<void>
  protocolDetect(projectPath: string): Promise<unknown>
  protocolAutoMark(projectPath: string): Promise<{ written: boolean; marker: unknown }>
  protocolEditMarker(
    projectPath: string,
    edits: {
      protocol: string
      revision: string
      stage: 'stable' | 'beta' | 'alpha' | 'experimental'
      variant: string | null
      variant_alias: string | null
    }
  ): Promise<unknown>
  protocolRescanMarker(projectPath: string): Promise<unknown>
  // 034-B: Full Re-scan 根治版 — append-only history、changed/unchanged 件数も返却。
  protocolFullRescan(): Promise<{
    processed: number
    skipped: number
    failed: number
    changed: number
    unchanged: number
  }>
  // 034-B (UX 課題 1): 履歴閲覧用。
  protocolReadHistory(projectPath: string): Promise<unknown[] | null>
  // 034-B (UX 課題 3): 軽量「手動編集済み」判定。
  protocolHasManualEntry(
    projectPath: string
  ): Promise<{ hasManual: boolean; lastManualAt: string | null; historyCount: number }>
  // 034-B: Full Re-scan 対象件数（履歴ベース）。
  protocolCountFullRescanTargets(): Promise<number>
  protocolProfiles(): Promise<
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
  >

  settingsRead(): Promise<string>
  settingsHasPassword(): Promise<boolean>
  settingsReadRequest(filePath: string): Promise<
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
        /** そもそも skill 提案ではないファイル（裁定メモ・引き継ぎメモ等）。直す対象ではない */
        notAProposal: boolean
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
  >
  settingsApplyChange(
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
    renamedTo?: string
  }>
  settingsListLogs(): Promise<
    {
      timestamp: string
      request_id: string
      purpose: string
      result: 'applied' | 'rolled_back' | 'failed'
      backup_path: string
      error?: string
    }[]
  >
  settingsListBackups(): Promise<{ id: string; path: string; sizeBytes: number }[]>
  settingsRollback(backupId: string): Promise<{ success: boolean; error?: string }>

  skillProposalsDefaultFolder(): Promise<string>
  skillProposalsList(folder: string): Promise<
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
      /** そもそも skill 提案ではないファイル（裁定メモ・引き継ぎメモ等）。直す対象ではない */
      notAProposal: boolean
      state: 'candidate' | 'adopted' | 'rejected' | 'held'
      alreadyAdopted: boolean
      goldenCollision: boolean
      goldenCollisionResolved: boolean
      /** 同名衝突時の、提案の中身と golden の関係（衝突なしは 'none'） */
      goldenCollisionStatus: 'none' | 'applied' | 'unapplied' | 'stale'
      needsReview: boolean
      /** 採用ゲートの状態可視化（B-2）。main 側で採用ゲートと同一判定から導出した値 */
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
        /** この画面では判定できず、採用操作時に初めて検査される項目 */
        adoptTimeChecks: string[]
      }
      /**
       * 刈り取り状況。**古い main からは来ない**ことがあるので optional。
       * 型で「来ないことがある」を表明し、renderer 側の存在前提アクセスを型で防ぐ。
       */
      harvest?: {
        ok: boolean
        code: string
        reason: string | null
        findingCount: number
        /** 的外れとして棄却した finding の id */
        rejected: string[]
        /** 妥当と認めたうえで未修正のまま据え置いた finding の id */
        deferred: string[]
      }
      /** finding 単位の裁定（理由の全文込み）。古い main からは来ないことがあるので optional */
      adjudications?: { id: string; decision: string; reason: string; at?: string }[]
      /** ack を送り返すときの束縛値。古い main からは来ないことがあるので optional */
      ackBinding?: { proposalHash: string; findingsHash: string; adjudicationsKey: string }
    }[]
  >
  /** レビュアー（codex companion）の可用性。不在時は UI がボタンを不能化して理由を出す */
  skillProposalsReviewerStatus(): Promise<{
    available: boolean
    version?: string
    reason?: 'reviewer-unavailable'
    detail?: string
  }>
  /** B-3: レビュー依頼プロンプト（B-1 が内部で使う文字列と同一関数の戻り値） */
  skillProposalsReviewRequestText(filePath: string): Promise<string>
  /** 解析エラーの修復依頼文（アプリは提案 MD を書き換えない。直すのは CC） */
  /** 方針つきで改稿+再レビューへ差し戻す依頼文 */
  skillProposalsRevisionDirectiveText(
    filePath: string,
    title: string,
    findings: string,
    direction: string
  ): Promise<string>
  skillProposalsRepairRequestText(
    filePath: string,
    folderPath?: string
  ): Promise<string>
  /** 解析エラー提案の修復用 Claude Code を起動する（D1, AC1） */
  skillProposalsLaunchRepair(
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
  }>
  /** 祖先プロジェクト設定検査（AC16） */
  skillProposalsCheckRepairEnvironment(filePath: string): Promise<{
    ok: boolean
    error?: string
    detectedSettings: string[]
  }>
  // --- ユーザーコメント → CC 対話（`user_comment_dialogue_plan.md`）---
  /** コメントスレッドとゲート状態（表示と採用判定が同じ読み取り結果に基づくようにする） */
  skillProposalsCommentThread(requestId: string, filePath: string): Promise<CommentThreadView>
  /** コメント追加。`expectedProposalHash` 不一致なら保存されず retryable が返る（入力は捨てない） */
  skillProposalsAddComment(
    requestId: string,
    filePath: string,
    body: string,
    expectedProposalHash: string
  ): Promise<{ ok: boolean; reason?: string; retryable?: boolean; commentId?: string }>
  /** 取り下げ（`open` のときだけ。応答済みを無かったことにしない） */
  skillProposalsWithdrawComment(
    requestId: string,
    filePath: string,
    commentId: string
  ): Promise<{ ok: boolean; reason?: string }>
  /** 壊れたレコード 1 件の隔離（**UI 専用**。CC は隔離できない） */
  skillProposalsQuarantineComment(
    requestId: string,
    commentId: string,
    reasonCode: string,
    observedProblem: string
  ): Promise<{ ok: boolean; reason?: string }>
  /** 応答の supersede（stale ack を拒みたいときの出口。`resolved` のときだけ） */
  skillProposalsSupersedeComment(
    requestId: string,
    filePath: string,
    commentId: string
  ): Promise<{ ok: boolean; reason?: string }>
  /** CC への対話依頼文（クリップボードへ渡す） */
  skillProposalsCommentDialogueText(requestId: string, filePath: string): Promise<string>
  /**
   * 導線①: アプリが CC を起動して応答させる（設定が効くのはこちらだけ）。
   * 依頼文は temp ファイル＋env で渡され、起動引数には長文も temp パスも載らない。
   */
  skillProposalsLaunchDialogue(
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
  }>

  /** B-1: 独立レビュー実行（read-only sandbox）。成功時のみ台帳へ upsert される */
  skillProposalsReview(filePath: string): Promise<
    | { status: 'ok'; requestId: string; verdict: string; findings: string; proposalHash: string }
    | {
        status: 'reviewer-unavailable' | 'proposal-id-missing' | 'launch-failed' | 'output-unusable'
        message: string
      }
  >
  skillProposalsSetState(
    requestId: string,
    state: 'candidate' | 'adopted' | 'rejected' | 'held',
    /** acknowledgeNoApply: 中身が golden に入っていない同名衝突の提案を、何も適用されないと承知で採用済みにする */
    opts?: { acknowledgeNoApply?: boolean; folder?: string }
  ): Promise<void>
  /** 提案の合成: 主ボタン（合成して golden へ入れる）。作業場を作って合成 CC を起動する（開発版のリポジトリでのみ） */
  skillProposalsComposeStart(input: { skillName: string; sourceIds?: string[] }): Promise<ComposeStartResultDto>
  /** 合成の元にできる提案と、選べない同じ skill の提案の理由（選択ダイアログの一覧） */
  skillProposalsComposeSelectable(input: { skillName: string }): Promise<ComposeSelectableResultDto>
  /** 合成を破棄する（異常で通常の却下が届かない合成提案の状態を rejected にし、握っている提案を元に戻す） */
  skillProposalsComposeDiscard(input: { compositeId: string }): Promise<{ ok: boolean; error?: string }>
  skillProposalsComposeRevise(input: { compositeId: string }): Promise<ComposeStartResultDto>
  skillProposalsComposeStatus(): Promise<ComposeStatusDto[]>
  skillProposalsComposeCancel(workspaceDir: string): Promise<{ ok: boolean; error?: string }>
  onComposeStatus(cb: (s: ComposeStatusDto) => void): () => void
  skillProposalsComposeAnswer(input: {
    caseId: string
    option: ComposeAnswerOption
    origins?: Array<{ gateId: string; origin: 'diff' | 'base' }>
  }): Promise<{ ok: boolean; error?: string }>
  skillProposalsComposeAdjudicate(input: {
    caseId: string
    compositeId: string
    gateId: string
    reason: string
  }): Promise<{ ok: boolean; error?: string; remaining?: number }>
  composeRendered(seq: number): void
  skillProposalsReceptacles(input?: { skillName?: string }): Promise<ReceptacleSummary[]>
  skillProposalsReceptacleClose(input: { path: string; how: ReceptacleClosedHow }): Promise<{ ok: boolean; error?: string }>
  skillProposalsAdopt(
    filePath: string,
    password: string,
    override: boolean,
    /**
     * 指摘を承知したうえで採用することを示すペイロード。main が現在の提案・レビュー内容から
     * 3 値を再計算して照合するため、画面に出ていた内容と一致しない ack は拒否される。
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
     * 混ぜると、コメントが stale 化しただけで既存の `deferred` ack まで巻き添え失効する。
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
  }>
  skillFiringStatsCompute(): Promise<{
    stats: {
      skill: string
      count: number
      lastFiredAt: string | null
      byProject: { project: string; count: number }[]
    }[]
    totalFirings: number
    filesScanned: number
    scopeNote: string
  }>
  enforcementStatsCompute(): Promise<{
    hooksStop: EnforcementTypeStat
    rulesB: EnforcementTypeStat
    deny: { settingsJson: EnforcementTypeStat; rulePolicy: EnforcementTypeStat; scopeNote: string }
    marshal: EnforcementTypeStat
    rulesLayerA: { note: string }
    filesScanned: number
  }>
  skillMdOpen(
    skillName: string
  ): Promise<{ ok: boolean; reason?: 'not-found'; error?: string; path: string }>
  emergencyOverrideCreate(input: {
    name: string
    reason: string
    drDecisionId: string
    expiresAt?: string
  }): Promise<void>
  emergencyOverrideListObsolete(): Promise<
    {
      name: string
      goldenVersion: string
      reason: string
      drDecisionId: string
      createdAt: string
      expiresAt?: string
    }[]
  >
  emergencyOverrideRemove(name: string): Promise<void>

  // Skill Lifecycle（採用済み skill の棚卸し・撤去・衝突解決。CCPIT_058）
  skillLifecycleList(): Promise<
    { ok: true; result: SkillInventoryResult } | { ok: false; error: string }
  >
  skillLifecycleRemove(args: { name: string; stateToken: string }): Promise<RemoveSkillResult>
  skillLifecycleRestoreRemoved(removalId: string): Promise<RestoreRemovedResult>
  skillLifecycleResolveCollision(args: {
    originalName: string
    tempName: string
    keep: 'original' | 'temp'
    stateToken: string
  }): Promise<ResolveCollisionResult>
  skillLifecycleRestoreArchive(args: { name: string; archivePath: string }): Promise<RestoreArchiveResult>

  devGetCcpitDir(): Promise<string>
  devGetClaudeDir(): Promise<string>
  devToggleDevTools(): Promise<void>
  devRelaunchApp(): Promise<void>

  getAppVersion(): Promise<string>

  selectFolder(): Promise<string | null>
  selectFile(): Promise<string | null>
  selectPitFile(): Promise<string | null>
  openExternal(url: string): Promise<void>
  openPath(folderPath: string): Promise<string>
  clipboardWrite(text: string): Promise<void>
  // 036: CCES Ver.1.0
  ccesGenerate(args: { projectPath: string }): Promise<
    | {
        ok: true
        markdown: string
        bytes: number
        oversized: boolean
        summary: { metadata: { projectName: string } } & Record<string, unknown>
      }
    | { ok: false; error: string }
  >

  // MCP (Model Context Protocol) — Phase A
  mcpListServers(args: { scope: 'global' | 'project'; projectPath?: string }): Promise<
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
  >
  mcpAddServer(args: {
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
  }): Promise<{ ok: boolean; error?: string; cliStdout?: string; cliStderr?: string }>
  mcpRemoveServer(args: {
    scope: 'global' | 'project'
    name: string
    projectPath?: string
  }): Promise<{ ok: boolean; error?: string; cliStdout?: string; cliStderr?: string }>
  mcpUpdateDisabledTools(args: {
    scope: 'global' | 'project'
    name: string
    disabledTools: string[]
    projectPath?: string
  }): Promise<{ ok: boolean; error?: string }>
  mcpCheckCli(): Promise<boolean>

  // pxpipe 内蔵ダッシュボード（R1/R2/R3）
  pxpipeViewStatus(): Promise<PxpipeViewStatus>
  pxpipeViewStart(): Promise<{ ok: boolean; reason?: string; status?: PxpipeViewStatus }>
  pxpipeViewStopJa(): Promise<{ ok: boolean; reason?: string; status?: PxpipeViewStatus }>
  /** serve-ja.mjs をファイル選択で登録する（個人パスをソースへ焼き込まないための経路）。 */
  pxpipeViewPickJaScript(): Promise<{
    ok: boolean
    canceled: boolean
    reason?: string
    status?: PxpipeViewStatus
  }>

  // pxpipe 画像化スコープと版（070 M4）
  pxpipe: {
    getScopeStatus(): Promise<PxpipeScopeStatusDTO>
    setScopeModel(model: string, on: boolean): Promise<SetScopeModelResultDTO>
    getVersionStatus(): Promise<PxpipeVersionStatusDTO>
  }
}

export interface ModelScopeResolution {
  concreteId: string
  displayName: string
  matchedBase: string | null
  isInScope: boolean
  isImplicitByPrefix: boolean
  reason: string
}

export interface PxpipeScopeStatusDTO {
  scopeBases: string[]
  effectiveScopeBases: string[]
  isScopeConsistent: boolean
  runningPort: number | null
  ambiguousPort?: boolean
  resolutions: ModelScopeResolution[]
  fableModel: string
}

export interface SetScopeModelResultDTO {
  ok: boolean
  error?: string
  status: PxpipeScopeStatusDTO
}

export interface PxpipeVersionStatusDTO {
  pinnedVersion: string
  runningVersion: string | null
  isVersionConsistent: boolean
}

/**
 * pxpipe 内蔵ダッシュボードの状態（R3 の状態モデル）。
 * - `ok`: 表示可能
 * - `ja-down`: 上流は生存・日本語ダッシュボードのみ不在
 * - `proxy-down`: 上流が死んでいる（proxy から起動する必要がある）
 * - `upstream-down`: 日本語ダッシュボードは生存だが上流が死亡（画面は 502 になる）
 * - `ja-foreign`: 別プロセスがポートを占有（触らない・起動ボタンを出さない）
 * - `ja-stale`: 表示はできるが、配信中の辞書が現行の上流 pin から取り残されている（失敗ではない）
 * - `ja-disabled`: 日本語ダッシュボードの実体が無い（同梱物の破損・欠落。英語版を表示）
 */
export interface PxpipeViewStatus {
  state:
    | 'proxy-down'
    | 'ja-down'
    | 'upstream-down'
    | 'ja-foreign'
    | 'ok'
    | 'ja-stale'
    | 'ja-disabled'
  /** locale 解決前の推奨表示先。renderer は locale に応じて jaUrl/enUrl を選ぶ。 */
  viewUrl: string
  jaUrl: string
  enUrl: string
  jaPort: number
  upstreamPort: number
  /** 上流 proxy が本アプリの所有下か。false かつ生存なら孤児（情報バッジを出す）。 */
  proxyOwned: boolean
  jaOwned: boolean
  /**
   * 日本語ダッシュボードを**自動起動してよい環境か**（アプリ言語が日本語か）。
   * main の app-config が真実源。renderer はプロセスを増やす判断にこれを使い、
   * 自前の i18n 状態で判断しない（二重管理の食い違いで spawn が揺れないようにする）。
   */
  jaAutoStartEligible: boolean
  /** 使っている実体の出どころ（`bundled`＝配布同梱／`manual`＝ユーザーが明示登録）。 */
  jaScriptSource?: 'manual' | 'bundled'
  /** 配信中の辞書が対象と宣言している上流版（読めた場合のみ）。 */
  jaDictTarget?: string
  reason?: string
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: ParcFermeAPI
  }
}
