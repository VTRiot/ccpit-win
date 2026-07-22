import { ipcMain, dialog, shell, clipboard, app, BrowserWindow } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import {
  listTemplates,
  previewDeploy,
  deploy,
  checkExisting,
  listGoldenSkillNames
} from './services/golden'
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
import { runMarshalReview } from './services/marshalLauncher'
import { getConfig, setConfig, getParcFermeDir } from './services/appConfig'
import { getState as profileGetState, switchToLegacy, switchToManx } from './services/profileSwitch'
import { launchCc, type LaunchArgs } from './services/ccLaunch'
import { detectLiveSessions } from './services/sessionRegistry'
import { bumpRestartGeneration } from './services/restartAllFlag'
import { ccIdentitiesForCwd } from './services/ccRegistry'
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
import {
  listProposals,
  setProposalState,
  getDefaultProposalsFolder,
  type ProposalState
} from './services/skillProposals'
import { evaluateProposalCodexGate, buildCodexReviewPrompt } from './services/proposalCodexGate'
import { computeFiringStats } from './services/skillFiringStats'
import { computeEnforcementStats } from './services/enforcementStats'
import {
  createEmergencyOverride,
  removeEmergencyOverride,
  listObsoleteOverrides
} from './services/skillProvenance'
import { generateExtensionsSummary, formatAsMarkdown } from './services/cces/summaryGenerator'
import { validateProjectPath } from './services/cces/extensionScanner'
import {
  type CcesGenerateResult,
  OVERSIZED_THRESHOLD_BYTES
} from './services/cces/types'
import {
  listMcpServers,
  addMcpServer,
  removeMcpServer,
  updateDisabledTools,
  checkClaudeCodeAvailable,
  type McpScope,
  type McpServer
} from './services/mcpService'

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

  // App version (package.json を単一真実源とするため app.getVersion() を IPC 公開)
  ipcMain.handle('app:getVersion', () => app.getVersion())

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
        // CC固有ID（戸籍係 台帳）を本 project の cwd で引き、CCES に併記する（Juiz の紐付け追跡）。
        const ccIds = ccIdentitiesForCwd(args.projectPath).map((c) => c.ccId)
        const summary = await generateExtensionsSummary({
          claudeDir,
          projectPath: args.projectPath,
          opening,
          ccIds
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
  ipcMain.handle('cc:launch', (e, args: LaunchArgs) => {
    // 037 Phase 2-C 追加: 起動した子ウィンドウを最前面に出すため、spawn 前に
    // 親 CCPIT を blur してアクティブ状態を解除する。新規 wt 等が起動した時点で
    // フォアグラウンドを取りやすくなる。CCPIT 自体はクリックで再アクティブ化可能。
    BrowserWindow.fromWebContents(e.sender)?.blur()
    return launchCc(args)
  })

  // --- CC Sessions（検出 + DELEGATE generation 再起動） ---
  // 検出は CIM 全列挙（fresh 端末 CC も取りこぼさない / 列挙失敗は fail-closed ok:false）。
  // 再起動は DIRECT kill を使わず settings generation を +1 するのみ。各 CC の Stop hook が
  // 「loaded-gen < flag-gen」で自己 exit→resume する（窓は同窓内入替＝位置自動保持）。
  // DIRECT 親 kill（bulkRestartSessions/killProcessTree）は Codex critical ゲート中ゆえ本経路から外す。
  ipcMain.handle('cc:listSessions', () => detectLiveSessions())

  // async + in-flight gate で多重起動防止（marshal:run と同流儀）。
  // 戻り: bump 失敗のみ ok:false。bump 成功後の detect 失敗は partial-success
  // （ok:true + summary:null + detectError）で返す（generation は既に上がっているため
  //  「失敗」と潰すと再クリックで二重 bump を誘発する。Codex レビュー High）。
  let bulkRestartInFlight = false
  ipcMain.handle('cc:restartAll', async () => {
    if (bulkRestartInFlight) {
      return { ok: false as const, error: 'CC 一括再起動が既に実行中です（多重起動防止）。' }
    }
    bulkRestartInFlight = true
    try {
      const bumped = await bumpRestartGeneration()
      if (!bumped.ok) return { ok: false as const, error: bumped.error }
      const detected = await detectLiveSessions()
      if (!detected.ok) {
        return {
          ok: true as const,
          generation: bumped.generation,
          summary: null,
          detectError: detected.error
        }
      }
      return { ok: true as const, generation: bumped.generation, summary: detected.summary }
    } finally {
      bulkRestartInFlight = false
    }
  })

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
  ipcMain.handle('settings:applyChange', async (_e, request: ChangeRequest, password: string) => {
    // 判断H: kind:skill の同名採用ガード用に golden 配布 skill 名を渡す。
    // currentGoldenVersion は app バージョン（golden は app に同梱されるため版が一致）。
    const goldenSkillNames = await listGoldenSkillNames()
    return applyChange(request, password, undefined, {
      goldenSkillNames,
      currentGoldenVersion: app.getVersion()
    })
  })
  ipcMain.handle('settings:listLogs', () => listChangeLogs())
  ipcMain.handle('settings:listBackups', () => listSettingsBackups())
  ipcMain.handle('settings:rollback', (_e, backupId: string) => rollbackToBackup(backupId))

  // --- Skill Proposals (Part B 候補ブラウザ, 構想3) ---
  ipcMain.handle('skillProposals:defaultFolder', () => getDefaultProposalsFolder())
  ipcMain.handle('skillProposals:list', (_e, folder: string) => listProposals(folder))
  ipcMain.handle('skillProposals:setState', (_e, requestId: string, state: ProposalState) =>
    setProposalState(requestId, state)
  )
  // WS2 (maintainer裁定 2026-07-13): 推奨バッジ提案の Codex レビューゲート判定 + レビュー依頼プロンプト生成
  ipcMain.handle('skillProposals:codexGate', (_e, adoptionLabel: string, requestId: string) =>
    evaluateProposalCodexGate({ adoptionLabel, requestId })
  )
  ipcMain.handle(
    'skillProposals:codexReviewPrompt',
    (_e, input: { filePath: string; requestId: string; skillName: string; title: string }) =>
      buildCodexReviewPrompt(input)
  )

  // --- Skill Firing Stats (Part B 発火統計, 構想4-A, 読み取り専用) ---
  ipcMain.handle('skillFiringStats:compute', () => computeFiringStats())
  // --- Enforcement Stats (Part B Phase 2a, countable 5型 発火可視化, 読み取り専用) ---
  ipcMain.handle('enforcementStats:compute', () => computeEnforcementStats())
  // 発火統計の行 右クリック → 当該 Skill の ~/.claude/skills/<name>/SKILL.md を OS 既定で開く
  ipcMain.handle('skillMd:open', async (_e, skillName: string) => {
    const p = join(app.getPath('home'), '.claude', 'skills', skillName, 'SKILL.md')
    if (!existsSync(p)) return { ok: false, reason: 'not-found' as const, path: p }
    const err = await shell.openPath(p)
    return { ok: err === '', error: err || undefined, path: p }
  })

  // --- 緊急避難 override (判断H, Doctor Analysis 経由でのみ。golden バグ時の同名一時許可) ---
  ipcMain.handle(
    'emergencyOverride:create',
    (_e, input: { name: string; reason: string; drDecisionId: string; expiresAt?: string }) =>
      createEmergencyOverride({
        name: input.name,
        goldenVersion: app.getVersion(),
        reason: input.reason,
        drDecisionId: input.drDecisionId,
        expiresAt: input.expiresAt,
        createdAt: new Date().toISOString()
      })
  )
  ipcMain.handle('emergencyOverride:listObsolete', () =>
    listObsoleteOverrides({ currentGoldenVersion: app.getVersion() })
  )
  ipcMain.handle('emergencyOverride:remove', (_e, name: string) => removeEmergencyOverride(name))

  // --- MCP (Model Context Protocol) servers ---
  ipcMain.handle(
    'mcp:listServers',
    async (_e, args: { scope: McpScope; projectPath?: string }) => {
      try {
        const servers = await listMcpServers(args.scope, args.projectPath)
        return { ok: true, servers }
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e)
        return { ok: false, error: reason }
      }
    }
  )
  ipcMain.handle(
    'mcp:addServer',
    async (
      _e,
      args: { scope: McpScope; server: McpServer; projectPath?: string }
    ) => {
      try {
        return await addMcpServer(args.scope, args.server, args.projectPath)
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e)
        return { ok: false, error: reason }
      }
    }
  )
  ipcMain.handle(
    'mcp:removeServer',
    async (_e, args: { scope: McpScope; name: string; projectPath?: string }) => {
      try {
        return await removeMcpServer(args.scope, args.name, args.projectPath)
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e)
        return { ok: false, error: reason }
      }
    }
  )
  ipcMain.handle(
    'mcp:updateDisabledTools',
    async (
      _e,
      args: {
        scope: McpScope
        name: string
        disabledTools: string[]
        projectPath?: string
      }
    ) => {
      try {
        return await updateDisabledTools(
          args.scope,
          args.name,
          args.disabledTools,
          args.projectPath
        )
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e)
        return { ok: false, error: reason }
      }
    }
  )
  ipcMain.handle('mcp:checkCli', () => checkClaudeCodeAvailable())

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

  // --- Marshal Tier（外部 Codex adversarial-review）起動 + integrity（PIKES §5-15-9） ---
  // outDir は renderer から受け取らず main 固定の app-owned ディレクトリに限定する
  // （Marshal 成果物3-F2: renderer 制御パスでの任意ファイル書込を防ぐ）。
  // async spawn + in-flight gating で main event loop を塞がず多重起動も防ぐ（成果物3-F2 round2）。
  let marshalInFlight = false
  ipcMain.handle('marshal:run', async (_e, params: { scope?: string; focus: string }) => {
    if (marshalInFlight) {
      return { status: 'spawn_failure', reason: 'Marshal レビューが既に実行中です（多重起動防止）。' }
    }
    marshalInFlight = true
    try {
      return await runMarshalReview({
        scope: params.scope ?? 'auto',
        focus: params.focus,
        outDir: join(getParcFermeDir(), 'marshal-reviews'),
        timestamp: new Date().toISOString()
      })
    } finally {
      marshalInFlight = false
    }
  })
}
