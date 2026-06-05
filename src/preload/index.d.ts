import { ElectronAPI } from '@electron-toolkit/preload'

// Enforcement 発火統計の型別集計（Part B Phase 2a）。main/services/enforcementStats.ts と同型を inline 複製。
interface EnforcementTypeStat {
  total: number
  ranking: { key: string; count: number }[]
  scopeNote: string
}

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
    showSetupNav: boolean
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
    showSetupNav: boolean
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
      }
  >
  settingsApplyChange(
    request: unknown,
    password: string
  ): Promise<{
    success: boolean
    backupPath?: string
    appliedAt?: string
    error?: string
    /** PIKES r1.4 §7-3-A: UI で 3 種エラー区別表示するための reason code */
    reason?:
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
    }[]
  >
  skillProposalsSetState(
    requestId: string,
    state: 'candidate' | 'adopted' | 'rejected' | 'held'
  ): Promise<void>
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
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: ParcFermeAPI
  }
}
