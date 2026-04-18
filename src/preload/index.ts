import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  // Golden
  goldenList: (): Promise<string[]> => ipcRenderer.invoke('golden:list'),
  goldenPreview: (
    templateName: string
  ): Promise<{ relativePath: string; source: string }[]> =>
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
    scannedFiles: { path: string; name: string; lines: number; sizeBytes: number; category: string }[]
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

  // Projects
  projectsList: (): Promise<
    { name: string; path: string; status: string; createdAt: string }[]
  > => ipcRenderer.invoke('projects:list'),
  projectsCreate: (
    projectPath: string,
    projectName: string
  ): Promise<{ success: boolean; created: string[]; errors: string[] }> =>
    ipcRenderer.invoke('projects:create', projectPath, projectName),
  projectsRemove: (projectPath: string): Promise<void> =>
    ipcRenderer.invoke('projects:remove', projectPath),

  // Recovery Kit
  rkSnapshot: (): Promise<{ id: string; timestamp: string; knownGood: boolean; label: 'manual' | 'pre-restore' | 'post-restore'; fileCount: number }> =>
    ipcRenderer.invoke('rk:snapshot'),
  rkList: (): Promise<{ id: string; timestamp: string; knownGood: boolean; label: 'manual' | 'pre-restore' | 'post-restore'; fileCount: number }[]> =>
    ipcRenderer.invoke('rk:list'),
  rkMarkKnownGood: (id: string): Promise<void> => ipcRenderer.invoke('rk:markKnownGood', id),
  rkDiff: (id: string): Promise<
    { relativePath: string; risk: string; status: string; currentContent?: string; snapshotContent?: string }[]
  > => ipcRenderer.invoke('rk:diff', id),
  rkRestore: (id: string): Promise<{ quarantinePath: string; restoredFiles: string[]; errors: string[] }> =>
    ipcRenderer.invoke('rk:restore', id),

  // Doctor Analysis
  daGenerate: (symptom: string): Promise<string> => ipcRenderer.invoke('da:generate', symptom),
  daSave: (content: string, outputDir: string): Promise<string> =>
    ipcRenderer.invoke('da:save', content, outputDir),
  daDefaultOutputDir: (): Promise<string> => ipcRenderer.invoke('da:defaultOutputDir'),

  // Health
  healthCheck: (): Promise<
    { name: string; status: string; detail: string }[]
  > => ipcRenderer.invoke('health:check'),
  healthDenyList: (): Promise<string[]> => ipcRenderer.invoke('health:denyList'),
  healthCcCli: (): Promise<boolean> => ipcRenderer.invoke('health:ccCli'),

  // App Config
  configGet: (): Promise<{ splashDurationMs: number; splashRareChance: number; debugMode: boolean; setupCompleted: boolean; language: 'ja' | 'en' }> =>
    ipcRenderer.invoke('config:get'),
  configSet: (partial: Partial<{ splashDurationMs: number; splashRareChance: number; debugMode: boolean; setupCompleted: boolean; language: 'ja' | 'en' }>): Promise<{ splashDurationMs: number; splashRareChance: number; debugMode: boolean; setupCompleted: boolean; language: 'ja' | 'en' }> =>
    ipcRenderer.invoke('config:set', partial),

  // System
  selectFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:selectFolder'),
  selectFile: (): Promise<string | null> => ipcRenderer.invoke('dialog:selectFile'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),
  openPath: (folderPath: string): Promise<string> => ipcRenderer.invoke('shell:openPath', folderPath),
  clipboardWrite: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:write', text),
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
