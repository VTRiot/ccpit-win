import { ElectronAPI } from '@electron-toolkit/preload'

interface ParcFermeAPI {
  goldenList(): Promise<string[]>
  goldenPreview(
    templateName: string
  ): Promise<{ relativePath: string; source: string }[]>
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
  ): Promise<
    { path: string; name: string; lines: number; sizeBytes: number; category: string }[]
  >
  migrationGeneratePack(
    scannedFiles: { path: string; name: string; lines: number; sizeBytes: number; category: string }[]
  ): Promise<string>
  migrationParseImport(
    mdContent: string
  ): Promise<{ filename: string; targetPath: string; content: string }[]>
  migrationImportToGolden(
    blocks: { filename: string; targetPath: string; content: string }[],
    templateName: string
  ): Promise<{ placed: string[]; errors: string[] }>
  migrationImportPit(
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
  }>
  migrationDeployPit(
    entries: { path: string; content: string; lines: number }[]
  ): Promise<{ deployed: string[]; backedUp: string[]; errors: string[] }>

  projectsList(): Promise<
    { name: string; path: string; status: string; createdAt: string }[]
  >
  projectsCreate(
    projectPath: string,
    projectName: string
  ): Promise<{ success: boolean; created: string[]; errors: string[] }>
  projectsRemove(projectPath: string): Promise<void>

  rkSnapshot(): Promise<{ id: string; timestamp: string; knownGood: boolean; label: 'manual' | 'pre-restore' | 'post-restore'; fileCount: number }>
  rkList(): Promise<{ id: string; timestamp: string; knownGood: boolean; label: 'manual' | 'pre-restore' | 'post-restore'; fileCount: number }[]>
  rkMarkKnownGood(id: string): Promise<void>
  rkDiff(id: string): Promise<
    { relativePath: string; risk: string; status: string; currentContent?: string; snapshotContent?: string }[]
  >
  rkRestore(id: string): Promise<{ quarantinePath: string; restoredFiles: string[]; errors: string[] }>

  daGenerate(symptom: string): Promise<string>
  daSave(content: string, outputDir: string): Promise<string>
  daDefaultOutputDir(): Promise<string>

  healthCheck(): Promise<
    { name: string; status: string; detail: string }[]
  >
  healthDenyList(): Promise<string[]>
  healthCcCli(): Promise<boolean>

  configGet(): Promise<{ splashDurationMs: number; splashRareChance: number; debugMode: boolean; setupCompleted: boolean; language: 'ja' | 'en' }>
  configSet(partial: Partial<{ splashDurationMs: number; splashRareChance: number; debugMode: boolean; setupCompleted: boolean; language: 'ja' | 'en' }>): Promise<{ splashDurationMs: number; splashRareChance: number; debugMode: boolean; setupCompleted: boolean; language: 'ja' | 'en' }>

  selectFolder(): Promise<string | null>
  selectFile(): Promise<string | null>
  selectPitFile(): Promise<string | null>
  openExternal(url: string): Promise<void>
  openPath(folderPath: string): Promise<string>
  clipboardWrite(text: string): Promise<void>
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: ParcFermeAPI
  }
}
