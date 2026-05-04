import { ElectronAPI } from '@electron-toolkit/preload'

interface ParcFermeAPI {
  goldenList(): Promise<string[]>
  goldenPreview(templateName: string): Promise<{ relativePath: string; source: string }[]>
  goldenDeploy(
    templateName: string,
    password: string
  ): Promise<{ deployed: string[]; backedUp: string[]; errors: string[] }>
  goldenCheckExisting(): Promise<{
    exists: boolean
    hasSettings: boolean
    hasClaude: boolean
  }>

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
  projectsRemoveFromList(paths: string[]): Promise<{ removed: string[] }>
  projectsSetFavorite(projectPath: string, favorite: boolean): Promise<void>
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
    language: 'ja' | 'en'
    currentProfile: 'manx' | 'legacy'
    features: Record<
      | 'ccLaunchButton'
      | 'detectLinkRemove'
      | 'protocolBadge'
      | 'favoriteToggle'
      | 'autoMarking'
      | 'editMarkerUI',
      { enabled: boolean }
    >
    legacyMasterPath?: string
    lastBackupAt?: string
    cces?: { openingText?: string; allowAllProjects?: boolean }
  }>
  configSet(
    partial: Partial<{
      splashDurationMs: number
      splashRareChance: number
      debugMode: boolean
      setupCompleted: boolean
      language: 'ja' | 'en'
      currentProfile: 'manx' | 'legacy'
      features: Partial<
        Record<
          | 'ccLaunchButton'
          | 'detectLinkRemove'
          | 'protocolBadge'
          | 'favoriteToggle'
          | 'autoMarking'
          | 'editMarkerUI',
          { enabled: boolean }
        >
      >
      legacyMasterPath?: string
      lastBackupAt?: string
      cces?: { openingText?: string; allowAllProjects?: boolean }
    }>
  ): Promise<{
    splashDurationMs: number
    splashRareChance: number
    debugMode: boolean
    setupCompleted: boolean
    language: 'ja' | 'en'
    currentProfile: 'manx' | 'legacy'
    features: Record<
      | 'ccLaunchButton'
      | 'detectLinkRemove'
      | 'protocolBadge'
      | 'favoriteToggle'
      | 'autoMarking'
      | 'editMarkerUI',
      { enabled: boolean }
    >
    legacyMasterPath?: string
    lastBackupAt?: string
    cces?: { openingText?: string; allowAllProjects?: boolean }
  }>

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
  }): Promise<{ shell: string; spawned: boolean; error?: string }>

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
  settingsReadRequest(filePath: string): Promise<{
    filePath: string
    frontmatter: {
      request_id: string
      created_at: string
      purpose: string
      target: string
      status: 'pending' | 'applied' | 'rolled_back' | 'rejected'
    }
    rawMarkdown: string
    proposedSettingsJson: string
    proposedSettingsParsed: unknown | null
    parseError: string | null
  }>
  settingsApplyChange(
    request: unknown,
    password: string
  ): Promise<{
    success: boolean
    backupPath?: string
    appliedAt?: string
    error?: string
    rolledBack?: boolean
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

  devGetCcpitDir(): Promise<string>
  devGetClaudeDir(): Promise<string>
  devToggleDevTools(): Promise<void>
  devRelaunchApp(): Promise<void>

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
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: ParcFermeAPI
  }
}
