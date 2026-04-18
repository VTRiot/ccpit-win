import { ipcMain, dialog, shell, clipboard, app } from 'electron'
import { join } from 'path'
import { listTemplates, previewDeploy, deploy, checkExisting } from './services/golden'
import {
  scanProject,
  generateConversionPack,
  parseImportMd,
  importToGolden,
} from './services/migration'
import { listProjects, createProject, removeProject } from './services/projects'
import { runHealthCheck, getDenyList, checkCcCli } from './services/health'
import { takeSnapshot, listSnapshots, markKnownGood, diffSnapshot, softRestore } from './services/recovery'
import { generateDoctorPack, saveDoctorPack, getDefaultOutputDir } from './services/doctor'
import { getConfig, setConfig } from './services/appConfig'

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

  // --- Projects ---
  ipcMain.handle('projects:list', () => listProjects())
  ipcMain.handle('projects:create', (_e, projectPath: string, projectName: string) =>
    createProject(projectPath, projectName)
  )
  ipcMain.handle('projects:remove', (_e, projectPath: string) => removeProject(projectPath))

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
      filters: [{ name: 'Markdown', extensions: ['md', 'txt'] }],
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('shell:openExternal', (_e, url: string) => shell.openExternal(url))

  ipcMain.handle('shell:openPath', (_e, folderPath: string) => shell.openPath(folderPath))

  ipcMain.handle('clipboard:write', (_e, text: string) => {
    clipboard.writeText(text)
  })
}
