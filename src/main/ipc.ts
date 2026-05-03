import { ipcMain, dialog, shell, clipboard, app, BrowserWindow } from 'electron'
import { join } from 'path'
import { listTemplates, previewDeploy, deploy, checkExisting } from './services/golden'
import {
  scanProject,
  generateConversionPack,
  parseImportMd,
  importToGolden,
  importPitFile,
  deployPitFile,
  type PitEntry
} from './services/migration'
import {
  listProjects,
  createProject,
  removeProject,
  importProjects,
  removeProjectsFromList,
  listManagedPaths,
  setFavorite,
  consumePendingMigrationNotice
} from './services/projects'
import { discoverClaudeProjects } from './services/projectDiscovery'
import { runHealthCheck, getDenyList, checkCcCli } from './services/health'
import {
  takeSnapshot,
  listSnapshots,
  markKnownGood,
  diffSnapshot,
  softRestore
} from './services/recovery'
import { generateDoctorPack, saveDoctorPack, getDefaultOutputDir } from './services/doctor'
import { getConfig, setConfig, getParcFermeDir } from './services/appConfig'
import { getState as profileGetState, switchToLegacy, switchToManx } from './services/profileSwitch'
import { launchCc, type LaunchArgs } from './services/ccLaunch'
import {
  readProtocol,
  writeProtocol,
  detectProtocol,
  loadProfiles,
  getAvailableProfiles,
  buildExplicitMarker,
  type ProtocolMarker,
  type EditMarkerInput
} from './services/protocol'
import {
  readSettingsJson,
  parseChangeRequestMd,
  applyChange,
  listChangeLogs,
  listSettingsBackups,
  rollbackToBackup,
  hasPasswordRegistered,
  type ChangeRequest
} from './services/settingsChange'

const GOLDEN_DIR = app.isPackaged
  ? join(process.resourcesPath, 'golden')
  : join(__dirname, '../../golden')

export function registerIpcHandlers(): void {
  // --- Golden ---
  ipcMain.handle('golden:list', () => listTemplates())
  ipcMain.handle('golden:preview', (_e, templateName: string) => previewDeploy(templateName))
  ipcMain.handle('golden:deploy', (_e, templateName: string, password: string) =>
    deploy(templateName, password)
  )
  ipcMain.handle('golden:checkExisting', () => checkExisting())

  // --- Migration ---
  ipcMain.handle('migration:scan', (_e, projectPath: string) => scanProject(projectPath))
  ipcMain.handle('migration:generatePack', (_e, scannedFiles) =>
    generateConversionPack(scannedFiles)
  )
  ipcMain.handle('migration:parseImport', (_e, mdContent: string) => parseImportMd(mdContent))
  ipcMain.handle('migration:importToGolden', (_e, blocks, templateName: string) =>
    importToGolden(blocks, GOLDEN_DIR, templateName)
  )
  ipcMain.handle('migration:importPit', (_e, filePath: string) => importPitFile(filePath))
  ipcMain.handle('migration:deployPit', (_e, entries: PitEntry[]) => deployPitFile(entries))

  // --- Projects ---
  ipcMain.handle('projects:list', () => listProjects())
  ipcMain.handle('projects:create', (_e, projectPath: string, projectName: string) =>
    createProject(projectPath, projectName)
  )
  ipcMain.handle('projects:remove', (_e, projectPath: string) => removeProject(projectPath))
  ipcMain.handle('projects:discover', async (_e, rootPath: string) => {
    const managed = await listManagedPaths()
    return discoverClaudeProjects(rootPath, managed)
  })
  ipcMain.handle('projects:import', (_e, paths: string[]) => importProjects(paths))
  ipcMain.handle('projects:removeFromList', (_e, paths: string[]) => removeProjectsFromList(paths))
  ipcMain.handle('projects:setFavorite', (_e, projectPath: string, favorite: boolean) =>
    setFavorite(projectPath, favorite)
  )
  ipcMain.handle('projects:consumeMigrationNotice', () => consumePendingMigrationNotice())

  // --- Health ---
  ipcMain.handle('health:check', () => runHealthCheck())
  ipcMain.handle('health:denyList', () => getDenyList())
  ipcMain.handle('health:ccCli', () => checkCcCli())

  // --- Recovery Kit ---
  ipcMain.handle('rk:snapshot', () => takeSnapshot())
  ipcMain.handle('rk:list', () => listSnapshots())
  ipcMain.handle('rk:markKnownGood', (_e, id: string) => markKnownGood(id))
  ipcMain.handle('rk:diff', (_e, id: string) => diffSnapshot(id))
  ipcMain.handle('rk:restore', (_e, id: string) => softRestore(id))

  // --- Doctor Analysis ---
  ipcMain.handle('da:generate', (_e, symptom: string) => generateDoctorPack(symptom))
  ipcMain.handle('da:save', (_e, content: string, outputDir: string) =>
    saveDoctorPack(content, outputDir)
  )
  ipcMain.handle('da:defaultOutputDir', () => getDefaultOutputDir())

  // --- App Config ---
  ipcMain.handle('config:get', () => getConfig())
  ipcMain.handle('config:set', (_e, partial) => setConfig(partial))

  // --- System ---
  ipcMain.handle('dialog:selectFolder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('dialog:selectFile', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Markdown', extensions: ['md', 'txt'] }]
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('dialog:selectPitFile', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'PIT File', extensions: ['pit'] }]
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('shell:openExternal', (_e, url: string) => shell.openExternal(url))

  ipcMain.handle('shell:openPath', (_e, folderPath: string) => shell.openPath(folderPath))

  ipcMain.handle('clipboard:write', (_e, text: string) => {
    clipboard.writeText(text)
  })

  // --- Profile Switch ---
  ipcMain.handle('profile:getState', () => profileGetState())
  ipcMain.handle('profile:switchToLegacy', () => switchToLegacy())
  ipcMain.handle('profile:switchToManx', () => switchToManx())

  // --- CC Launch ---
  ipcMain.handle('cc:launch', (_e, args: LaunchArgs) => launchCc(args))

  // --- Protocol Marker ---
  ipcMain.handle('protocol:read', (_e, projectPath: string) => readProtocol(projectPath))
  ipcMain.handle(
    'protocol:write',
    (_e, projectPath: string, marker: ProtocolMarker, force?: boolean) =>
      writeProtocol(projectPath, marker, { force: force === true })
  )
  ipcMain.handle('protocol:detect', (_e, projectPath: string) => detectProtocol(projectPath))
  ipcMain.handle('protocol:autoMark', async (_e, projectPath: string) => {
    const existing = await readProtocol(projectPath)
    if (existing) return { written: false, marker: existing }
    const marker = await detectProtocol(projectPath)
    await writeProtocol(projectPath, marker, { force: false })
    return { written: true, marker }
  })
  // FSA r3 §3-3 — Edit Marker 保存。明示設定値として書き換える。
  ipcMain.handle('protocol:editMarker', async (_e, projectPath: string, edits: EditMarkerInput) => {
    const marker = buildExplicitMarker(edits, new Date())
    await writeProtocol(projectPath, marker, { force: true })
    return marker
  })
  // FSA r3 §3-5 — Re-scan Marker。既存マーカーを上書きして再スキャン。
  ipcMain.handle('protocol:rescanMarker', async (_e, projectPath: string) => {
    const marker = await detectProtocol(projectPath, { force: true })
    await writeProtocol(projectPath, marker, { force: true })
    return marker
  })
  ipcMain.handle('protocol:profiles', async () => {
    const cfg = getConfig()
    const profiles = await loadProfiles()
    return getAvailableProfiles(profiles, cfg.debugMode)
  })

  // --- Settings Change (CC Request Inbox, 031) ---
  ipcMain.handle('settings:read', () => readSettingsJson())
  ipcMain.handle('settings:hasPassword', () => hasPasswordRegistered())
  ipcMain.handle('settings:readRequest', (_e, filePath: string) => parseChangeRequestMd(filePath))
  ipcMain.handle('settings:applyChange', (_e, request: ChangeRequest, password: string) =>
    applyChange(request, password)
  )
  ipcMain.handle('settings:listLogs', () => listChangeLogs())
  ipcMain.handle('settings:listBackups', () => listSettingsBackups())
  ipcMain.handle('settings:rollback', (_e, backupId: string) => rollbackToBackup(backupId))

  // --- Developer Tools (Tier S) ---
  ipcMain.handle('dev:getCcpitDir', () => getParcFermeDir())
  ipcMain.handle('dev:getClaudeDir', () => join(app.getPath('home'), '.claude'))
  ipcMain.handle('dev:toggleDevTools', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win) win.webContents.toggleDevTools()
  })
  ipcMain.handle('dev:relaunchApp', () => {
    app.relaunch()
    app.exit(0)
  })
}
