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
  consumePendingMigrationNotice,
  consumePendingProtocolHistoryMigrationNotice
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
  readProtocolHistory,
  getLatestManualEntry,
  appendProtocolEntry,
  detectProtocol,
  loadProfiles,
  getAvailableProfiles,
  buildExplicitMarker,
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
import { generateExtensionsSummary, formatAsMarkdown } from './services/cces/summaryGenerator'
import { validateProjectPath } from './services/cces/extensionScanner'
import {
  type CcesGenerateResult,
  OVERSIZED_THRESHOLD_BYTES
} from './services/cces/types'

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
  // 034-B: protocol-history-v2 マイグレーション通知（別 slot）。
  ipcMain.handle('projects:consumeProtocolHistoryMigrationNotice', () =>
    consumePendingProtocolHistoryMigrationNotice()
  )

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

  // --- CCES (036, ClaudeCode-ExtensionsSummary Ver.1.0) ---
  ipcMain.handle(
    'cces:generate',
    async (_e, args: { projectPath: string }): Promise<CcesGenerateResult> => {
      try {
        const validationError = validateProjectPath(args.projectPath)
        if (validationError) {
          return { ok: false, error: validationError }
        }
        const claudeDir = join(app.getPath('home'), '.claude')
        const cfg = getConfig()
        const opening = cfg.cces?.openingText ?? ''
        const summary = await generateExtensionsSummary({
          claudeDir,
          projectPath: args.projectPath,
          opening
        })
        const markdown = formatAsMarkdown(summary)
        const bytes = Buffer.byteLength(markdown, 'utf8')
        clipboard.writeText(markdown)
        return {
          ok: true,
          summary,
          markdown,
          bytes,
          oversized: bytes > OVERSIZED_THRESHOLD_BYTES
        }
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e)
        return { ok: false, error: reason }
      }
    }
  )

  // --- Profile Switch ---
  ipcMain.handle('profile:getState', () => profileGetState())
  ipcMain.handle('profile:switchToLegacy', () => switchToLegacy())
  ipcMain.handle('profile:switchToManx', () => switchToManx())

  // --- CC Launch ---
  ipcMain.handle('cc:launch', (_e, args: LaunchArgs) => launchCc(args))

  // --- Protocol Marker (034-B: append-only event log) ---
  ipcMain.handle('protocol:read', (_e, projectPath: string) => readProtocol(projectPath))
  ipcMain.handle('protocol:detect', (_e, projectPath: string) => detectProtocol(projectPath))

  // 034-B: 自動マーキング。auto エントリを履歴に append。
  // 旧仕様の「既存マーカー保護」は append-only で不要化（過去エントリは物理的に消えない）。
  ipcMain.handle('protocol:autoMark', async (_e, projectPath: string) => {
    const existing = await readProtocol(projectPath)
    if (existing) return { written: false, marker: existing }
    const marker = await detectProtocol(projectPath)
    await appendProtocolEntry(projectPath, 'auto', marker)
    return { written: true, marker }
  })

  // 034-B: Edit Marker 保存。manual エントリを履歴に append。
  // 設計: 履歴の存在自体が「明示意思」の正典証跡。setConfirmed は廃止。
  ipcMain.handle('protocol:editMarker', async (_e, projectPath: string, edits: EditMarkerInput) => {
    const marker = buildExplicitMarker(edits, new Date())
    await appendProtocolEntry(projectPath, 'manual', marker)
    return marker
  })

  // 034-B: per-PJ Re-scan。auto エントリを履歴に append。
  // 過去の manual エントリは履歴に残るため、readProtocol は最新 manual を優先（NR-4）。
  ipcMain.handle('protocol:rescanMarker', async (_e, projectPath: string) => {
    const marker = await detectProtocol(projectPath, { force: true })
    await appendProtocolEntry(projectPath, 'auto', marker)
    return marker
  })

  // 034-B: Full Re-scan 根治版。
  // - skip 判定: 履歴に manual エントリが 1 件でもあれば skip（過去の手動意思を保護）
  // - append-only: 過去エントリは物理的に消えない、追加のみ
  // - 戻り値拡張: changed/unchanged を計算して UX 改善（r3 §3-5）
  ipcMain.handle('protocol:fullRescan', async () => {
    const projects = await listProjects()
    let processed = 0
    let skipped = 0
    let failed = 0
    let changed = 0
    let unchanged = 0
    for (const p of projects) {
      const latestManual = await getLatestManualEntry(p.path)
      if (latestManual !== null) {
        skipped++
        continue
      }
      try {
        // append 前に旧 marker を読み diff 判定（changed/unchanged）
        const previousCurrent = await readProtocol(p.path)
        const newMarker = await detectProtocol(p.path, { force: true })
        await appendProtocolEntry(p.path, 'auto', newMarker)
        processed++
        if (
          previousCurrent &&
          previousCurrent.protocol === newMarker.protocol &&
          previousCurrent.revision === newMarker.revision
        ) {
          unchanged++
        } else {
          changed++
        }
      } catch (e) {
        failed++
        console.error(`[protocol:fullRescan] failed for ${p.path}:`, e)
      }
    }
    return { processed, skipped, failed, changed, unchanged }
  })

  // 034-B (UX 課題 1): 履歴閲覧 UI 用 IPC。Edit Marker Dialog 内の履歴セクションで使用。
  ipcMain.handle('protocol:readHistory', (_e, projectPath: string) =>
    readProtocolHistory(projectPath)
  )

  // 034-B (UX 課題 3): 軽量「手動編集済み」判定 IPC。ProtocolBadge アイコン表示判定で使用。
  ipcMain.handle('protocol:hasManualEntry', async (_e, projectPath: string) => {
    const history = await readProtocolHistory(projectPath)
    if (!history) return { hasManual: false, lastManualAt: null, historyCount: 0 }
    const manuals = history.filter((e) => e.source === 'manual')
    const lastManualAt = manuals.length > 0 ? manuals[manuals.length - 1].timestamp : null
    return {
      hasManual: manuals.length > 0,
      lastManualAt,
      historyCount: history.length,
    }
  })

  // 034-B: Full Re-scan 対象件数（confirmed 廃止後、履歴ベースで判定）。
  // 確認ダイアログの動的件数表示で使用。
  ipcMain.handle('protocol:countFullRescanTargets', async () => {
    const projects = await listProjects()
    let target = 0
    for (const p of projects) {
      const latestManual = await getLatestManualEntry(p.path)
      if (latestManual === null) target++
    }
    return target
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
