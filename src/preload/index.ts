import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  // Golden
  goldenList: (): Promise<string[]> => ipcRenderer.invoke('golden:list'),
  goldenPreview: (templateName: string): Promise<{ relativePath: string; source: string }[]> =>
    ipcRenderer.invoke('golden:preview', templateName),
  goldenDeploy: (
    templateName: string,
    password: string
  ): Promise<{ deployed: string[]; backedUp: string[]; errors: string[] }> =>
    ipcRenderer.invoke('golden:deploy', templateName, password),
  goldenCheckExisting: (): Promise<{
    exists: boolean
    hasSettings: boolean
    hasClaude: boolean
  }> => ipcRenderer.invoke('golden:checkExisting'),

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
  projectsRemoveFromList: (paths: string[]): Promise<{ removed: string[] }> =>
    ipcRenderer.invoke('projects:removeFromList', paths),
  projectsSetFavorite: (projectPath: string, favorite: boolean): Promise<void> =>
    ipcRenderer.invoke('projects:setFavorite', projectPath, favorite),
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
  }> => ipcRenderer.invoke('config:get'),
  configSet: (
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
  }> => ipcRenderer.invoke('config:set', partial),

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
  ccLaunch: (args: {
    projectPath: string
    flags: string[]
  }): Promise<{ shell: string; spawned: boolean; error?: string }> =>
    ipcRenderer.invoke('cc:launch', args),

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
  ): Promise<{
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
  }> => ipcRenderer.invoke('settings:readRequest', filePath),
  settingsApplyChange: (
    request: unknown,
    password: string
  ): Promise<{
    success: boolean
    backupPath?: string
    appliedAt?: string
    error?: string
    rolledBack?: boolean
  }> => ipcRenderer.invoke('settings:applyChange', request, password),
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

  // Developer Tools
  devGetCcpitDir: (): Promise<string> => ipcRenderer.invoke('dev:getCcpitDir'),
  devGetClaudeDir: (): Promise<string> => ipcRenderer.invoke('dev:getClaudeDir'),
  devToggleDevTools: (): Promise<void> => ipcRenderer.invoke('dev:toggleDevTools'),
  devRelaunchApp: (): Promise<void> => ipcRenderer.invoke('dev:relaunchApp'),

  // System
  selectFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:selectFolder'),
  selectFile: (): Promise<string | null> => ipcRenderer.invoke('dialog:selectFile'),
  selectPitFile: (): Promise<string | null> => ipcRenderer.invoke('dialog:selectPitFile'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),
  openPath: (folderPath: string): Promise<string> =>
    ipcRenderer.invoke('shell:openPath', folderPath),
  clipboardWrite: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:write', text),
  // 036: CCES (ClaudeCode-ExtensionsSummary) Ver.1.0
  ccesGenerate: (
    args: { projectPath: string }
  ): Promise<
    | {
        ok: true
        markdown: string
        bytes: number
        oversized: boolean
        summary: { metadata: { projectName: string } } & Record<string, unknown>
      }
    | { ok: false; error: string }
  > => ipcRenderer.invoke('cces:generate', args)
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
