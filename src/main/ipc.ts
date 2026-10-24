import { ipcMain, dialog, shell, clipboard, app, BrowserWindow } from 'electron'
import { join, dirname } from 'path'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { registerGoldenDeployIpc } from './goldenDeployIpc'
import {
  listTemplates,
  checkExisting,
  listGoldenSkillNames,
  collectGoldenFiles,
  getGoldenEnPath
} from './services/golden'
import { KNOWN_TEMPLATES } from './services/denyValidation'
import {
  getPendingReconcileEntries,
  applyPendingReconcileForApp,
  deferPendingReconcileForApp,
  resolvePendingReconcileForApp,
  getFollowUpStateForApp,
  remanageForApp,
  discardOverlayForApp,
  prepareMergeConsultForApp,
  listUndoGenerationsForApp,
  restoreUndoBackupsForApp,
  type ResolveReconcileForAppResult
} from './services/goldenStartup'
import { createMergeConsultLock, launchMergeConsult } from './services/goldenMergeConsult'
import {
  scanProject,
  generateConversionPack,
  parseImportMd,
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
  setPxpipeEnabled,
  getPxpipeEnabled,
  resolveIsPxpipeEnabled,
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
import { resolveGoldenFiles } from './services/golden'
import { isHashExcluded, isSkippedFile, normalizeRelPath } from './services/goldenManifest'
import {
  listPromotionCandidates,
  getPromotionScanDiagnostics,
  getPromotionDiffDetail,
  rejectConflictedProposal,
  markPromotionItemViewed,
  setPromotionItemsState,
  applyPromotionItems,
  listGoldenDeployedSkills,
  withdrawGoldenSkill,
  rollbackPromotion,
  restoreGoldenSkill,
  getGoldenLeaseStatus,
  releaseExpiredGoldenLease,
  cleanupPromotionArtifacts,
  verifyEarlyReleaseEntitlement,
  createEarlyReleaseChallenge,
  releaseEarlyGoldenLease,
  onPromotionProgress,
  detectContractCliLedgerDrift,
  applyLedgerCatchup,
  scanProposalCandidates,
  runComposeCatchUp,
  findRepoRootDir,
  type PromotionState,
  type GoldenTemplateName
} from './services/goldenPromotion'
import {
  registerComposeHandlers,
  registerComposeCaseHandlers,
  composeRenderedHandler,
  startComposePoller,
  type ComposeIpcDeps
} from './services/composeIpc'
import { reviewComposite } from './services/composeReview'
import { startComposeRevisionHeadless } from './services/composeHeadlessLaunch'
import { loadComposeFakeDriver } from './services/composeFakeDriver'
import { upsertBaseFindings, listReceptacles, closeReceptacle } from './services/composeReceptacle'
import { COMPOSE_IPC, type ReceptacleClosedHow } from '../shared/composeContract'
import { getState as profileGetState, switchToLegacy, switchToManx } from './services/profileSwitch'
import { launchCc, type LaunchArgs, type PxpipeMode } from './services/ccLaunch'
import { applyOneMContextToFlags } from './services/contextWindow'
import { ensureProxy, stopProxy, pxpipeUrl, PXPIPE_PORT_CANDIDATES } from './services/pxpipeProxy'
import { ensureEnvSanitizeRelay, restoreEnvSanitizeRelay } from './services/pxpipeEnvSanitizeRelay'
import { autoEnsureUpstream, startPxpipeWatchdog } from './services/pxpipeResilience'
import { noteSkipped, shouldRunResidentStartup } from './isolation'
import { registerPxpipeJaHandlers } from './pxpipeJaIpc'
import {
  getScopeStatus,
  setScopeModel,
  getVersionStatus,
  getPxpipeProxyEnv
} from './services/pxpipeConfigService'
import { ensureJaDashboard, shouldAutoStartJaDashboard } from './services/pxpipeJaDashboard'
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
  parseChangeRequestFromRaw,
  listChangeLogs,
  listSettingsBackups,
  rollbackToBackup,
  hasPasswordRegistered,
  restoreSkillArchive
} from './services/settingsChange'
import { checkGoldenWriteAuth, goldenWriteAuthRejection } from './services/goldenWriteAuth'
import { buildEarlyReleaseDialogMessage } from './services/goldenLeaseDialog'
import { perfSpan } from './services/perfTrace'
import {
  gatedApplyFromFile,
  adoptProposalFromFile,
  type GatedApplyResult
} from './services/adoptApply'
import {
  listProposals,
  setProposalState,
  getDefaultProposalsFolder,
  getDefaultProposalStorePaths,
  computeProposalHash,
  evaluateMarkAdoptedGuard,
  setProposalReview,
  type FindingsAckPayload,
  type ProposalState
} from './services/skillProposals'
import {
  prepareProposalReviewRequest,
  buildRevisionDirectivePrompt,
  prepareProposalRepairRequest,
  assertWithinProposalsFolder
} from './services/proposalReviewRequest'
import {
  getCommentThread,
  addComment,
  withdrawComment,
  quarantineComment,
  supersedeComment,
  buildCommentDialogueRequest,
  readProposalContent
} from './services/commentOps'
import {
  launchProposalDialogue,
  launchProposalRepair,
  detectProjectSettingsInAncestors
} from './services/proposalDialogueLaunch'
import {
  runProposalReview,
  runReviewerWithPrompt,
  getReviewerAvailability
} from './services/proposalReviewRunner'
import { computeFiringStats } from './services/skillFiringStats'
import { computeEnforcementStats } from './services/enforcementStats'
import {
  createEmergencyOverride,
  removeEmergencyOverride,
  listObsoleteOverrides
} from './services/skillProvenance'
import {
  computeSkillInventory,
  removeSkill,
  restoreRemovedSkill,
  resolveCollision
} from './services/skillLifecycle'
import { generateExtensionsSummary, formatAsMarkdown } from './services/cces/summaryGenerator'
import { validateProjectPath } from './services/cces/extensionScanner'
import { type CcesGenerateResult, OVERSIZED_THRESHOLD_BYTES } from './services/cces/types'
import {
  listMcpServers,
  addMcpServer,
  removeMcpServer,
  updateDisabledTools,
  checkClaudeCodeAvailable,
  type McpScope,
  type McpServer
} from './services/mcpService'
import {
  readCatalogSync,
  fetchModelCatalog,
  clearCatalogCache,
  isStale,
  type ModelCatalog
} from './services/modelCatalog'
import { onBgccActivity, getRecentActivity } from './services/bgccActivityBus'
import { getBgccLogDir, readLatestRunLogForClipboard } from './services/bgccRawLog'
import { mkdirSync } from 'fs'


/**
 * 対話 CC を起動する cwd。
 *
 * 依頼文（`buildCommentDialogueRequest`）が応答保存を
 * `node ccpit/scripts/proposal-comment-respond.cjs ...` という**リポ相対**で指示するため、
 * cwd は「`ccpit/` を子に持つディレクトリ」＝ 開発リポ root でなければならない。
 * dev の `__dirname` は `ccpit/out/main` なので 3 つ上がリポ root（GOLDEN_DIR と同じ導出流儀）。
 *
 * **既知の制約**: パッケージ済みアプリにはリポが無いため、この経路は開発環境向けである
 * （対話 CC が応答保存スクリプトへ到達できない）。恒久対応は依頼文側を絶対パス化する必要があり、
 * 既存のテスト済み契約（commentOps のパリティテスト）に触れるため本作業のスコープ外とした。
 */
const DIALOGUE_CWD = app.isPackaged ? process.resourcesPath : join(__dirname, '../../..')

/**
 * pxpipe proxy へ渡す env を作る（070 M4: 正本 config.json および専用ログ events.jsonl の注入）。
 * PXPIPE_MODELS による旧環境変数渡しは完全廃止し、PXPIPE_CONFIG（正本）および PXPIPE_LOG（専用ログ）を渡す。
 */
function pxpipeProxyEnv(): Record<string, string> {
  return getPxpipeProxyEnv()
}

/** pxpipeWarning に複数の注意文を積み増す（既存文言を上書きしない）。13_pxp Phase 1: port drift
 *  警告と中継未経由警告は独立した原因のため、片方だけで上書きせず両方見せる必要がある。 */
function appendWarning(existing: string | undefined, addition: string): string {
  return existing ? `${existing}\n${addition}` : addition
}

/**
 * 13_pxp Phase 1（Codex 総合クローズ判定 round2 指摘・severity high）: live セッションが
 * pxpipe 経由かどうかの判定を `getPxpipeEnabled`（通常 projects 一覧のみ参照）だけに頼ると、
 * 038 Feature B の特別枠（`appConfig.specialEntries`。projects.json 未登録パスのため
 * `force` モードで起動され、`getPxpipeEnabled` は常に false を返す＝ccLaunch.ts の
 * PxpipeMode ドキュメント参照）から起動されたセッションを見落とす。判定ロジック本体
 * （`resolveIsPxpipeEnabled`）は projects.ts 側で純関数として提供・テストする
 * （ipc.ts は Electron 依存の import グラフが重く単体テストに向かないため）。
 */
async function isLiveSessionPxpipeEnabled(cwd: string): Promise<boolean> {
  const normalEnabled = await getPxpipeEnabled(cwd)
  const specialEntries = getConfig().specialEntries ?? []
  return resolveIsPxpipeEnabled(cwd, normalEnabled, specialEntries)
}

/**
 * CCPIT_064 / ADR 0003: 確認ダイアログの「Claude Code に相談」。**書込経路ではない**。
 * 依頼パケット（対象の配置先・配布元・台帳の基準・overlay・関連提案）を temp へ書き、
 * 061（提案修復）と同じ起動機構・同じ起動設定（skillProposals.*）で Claude Code を起動する。
 * 相談行の台帳記録（defer）は renderer が resolveReconcile 経由で別途行う（起動 → 記録の順）。
 */
export function registerGoldenMergeConsultHandler(
  ipc: Pick<typeof ipcMain, 'handle'> = ipcMain,
  lock = createMergeConsultLock()
): void {
  ipc.handle(
    'golden:launchMergeConsult',
    async (_e, input: { paths?: string[]; proposalPaths?: string[] }) => {
      // ハンドラ最先頭の同期コンテキストで即座に取得（Codex Finding 2 / Finding 4 / AC10 是正）
      if (!lock.acquire()) {
        return { ok: false, error: '相談の起動が既に進行中です（多重起動抑止）。' }
      }
      try {
        const paths = Array.isArray(input?.paths) ? input.paths.map(String) : []
        const proposalPaths = Array.isArray(input?.proposalPaths)
          ? input.proposalPaths.map(String)
          : []
        const prep = await prepareMergeConsultForApp({ paths, proposalPaths })
        if (!prep.ok) return { ok: false, error: prep.error }

        const cfg = getConfig()
        const mode: PxpipeMode = cfg.skillProposals?.pxpipe ?? 'auto'
        let extraEnv: Record<string, string> | undefined
        if (mode !== 'off') {
          const enabled = mode === 'force' || (await getPxpipeEnabled(getParcFermeDir()))
          if (enabled) {
            const ensured = await ensureProxy({ proxyEnv: pxpipeProxyEnv() }).catch(() => ({
              ok: false as const
            }))
            if ('url' in ensured && ensured.ok) {
              const relay = await ensureEnvSanitizeRelay(ensured.url).catch(() => ({
                ok: false as const
              }))
              if ('url' in relay) extraEnv = { ANTHROPIC_BASE_URL: relay.url }
            }
          }
        }

        const r = launchMergeConsult(prep.packet, {
          repoRoot: getParcFermeDir(),
          options: {
            model: cfg.skillProposals?.model,
            effort: cfg.skillProposals?.effort,
            permissionMode: cfg.skillProposals?.permissionMode,
            skipPermissions: cfg.skillProposals?.skipPermissions
          },
          ...(extraEnv ? { extraEnv } : {})
        })
        return { ...r, subjects: prep.subjects, proposals: prep.proposals }
      } finally {
        lock.release()
      }
    }
  )
}

export function registerIpcHandlers(): void {
  // --- pxpipe ダッシュボード統合（R1/R2/R3。handler 実体は pxpipeJaIpc.ts） ---
  registerPxpipeJaHandlers()

  // --- pxpipe 画像化スコープと版（070 M4） ---
  ipcMain.handle('pxpipe:getScopeStatus', () => getScopeStatus())
  ipcMain.handle('pxpipe:setScopeModel', (_e, { model, on }: { model: string; on: boolean }) =>
    setScopeModel(model, on)
  )
  ipcMain.handle('pxpipe:getVersionStatus', () => getVersionStatus())

  // 前回のサニタイズ中継を同じアドレスで復活させ、上流 proxy も自律確保する（CCPIT_066 / 2026-09-13 事故根治）。
  // 中継は app プロセス内に住み、CC は起動時に焼かれた ANTHROPIC_BASE_URL を再解決できない。
  // restoreEnvSanitizeRelay は上流解決を待たずに待受先行確保を実行し（AC-8 堅持）、
  // autoEnsureUpstream は稼働中 live セッションの要否判定に基づき自律的に upstream proxy を確保・反映する（AC-1, AC-2）。
  // 隔離起動中は、本物の常駐（中継のポート・本物の proxy への死活確認）に触れないため走らせない。
  if (!shouldRunResidentStartup()) {
    noteSkipped('pxpipe.restoreEnvSanitizeRelay')
    noteSkipped('pxpipe.startPxpipeWatchdog')
    console.log('[CCPIT-Isolation] skipped: 中継の復活・中継 Watchdog（本物の常駐に触れないため）')
  }
  if (shouldRunResidentStartup()) void restoreEnvSanitizeRelay(async () => {
    return autoEnsureUpstream({
      proxyEnv: pxpipeProxyEnv(),
      isPxpipeEnabledForCwd: (cwd) => isLiveSessionPxpipeEnabled(cwd),
      ensureProxyFn: () => ensureProxy({ proxyEnv: pxpipeProxyEnv() })
    })
  }).catch(() => {
    /* 中継の復活は best-effort。失敗しても通常の cc:launch 経路で立ち上がる */
  })

  // 中継経路の死活・自己診断 Watchdog を開始 (CCPIT_066 / F4, F5, F9)
  if (shouldRunResidentStartup()) startPxpipeWatchdog({
    proxyEnv: pxpipeProxyEnv(),
    isPxpipeEnabledForCwd: (cwd) => isLiveSessionPxpipeEnabled(cwd),
    ensureProxyFn: () => ensureProxy({ proxyEnv: pxpipeProxyEnv() })
  })

  // --- Golden ---
  ipcMain.handle('golden:list', () => listTemplates())
  registerGoldenDeployIpc(ipcMain)
  ipcMain.handle('golden:checkExisting', () => checkExisting())

  // 起動時照合の確認待ち（§9.4）。renderer が pull で取りに来る（D3）ため、
  // main からの push（webContents.send）は行わない — 受信側の生存に依存しないで済む。
  ipcMain.handle('golden:pendingReconcile', () => getPendingReconcileEntries())
  ipcMain.handle('golden:applyReconcile', (_e, paths: string[]) =>
    applyPendingReconcileForApp(paths)
  )
  ipcMain.handle('golden:deferReconcile', (_e, paths: string[]) =>
    deferPendingReconcileForApp(paths)
  )

  // ADR 0002: 確認ダイアログの唯一の書込経路。行ごとの出口（上書き / 反映 / 問わない / 後で）を
  // 1 回の呼び出しで受ける。行ごとに別 IPC を叩かせると部分成功が UI と main に散らばる。
  ipcMain.handle(
    'golden:resolveReconcile',
    (
      _e,
      decisions: { path: string; action: 'apply' | 'promote' | 'unmanage' | 'defer' }[],
      options?: { proposePaths?: string[] }
    ) =>
      resolvePendingReconcileForApp(decisions, options) as Promise<ResolveReconcileForAppResult>
  )
  // 未追従の可視化と取り消し（ADR 0001 D3 が前提にした「可視化」の実体）。
  ipcMain.handle('golden:followUpState', () => getFollowUpStateForApp())
  ipcMain.handle('golden:remanage', (_e, paths: string[]) => remanageForApp(paths))
  ipcMain.handle('golden:discardOverlay', (_e, paths: string[]) => discardOverlayForApp(paths))
  ipcMain.handle('golden:listUndoGenerations', () => listUndoGenerationsForApp())
  ipcMain.handle(
    'golden:restoreUndoBackups',
    (_e, requests: { rel: string; generationStamp: string }[]) =>
      restoreUndoBackupsForApp(requests)
  )
  registerGoldenMergeConsultHandler()

  // --- Migration ---
  ipcMain.handle('migration:scan', (_e, projectPath: string) => scanProject(projectPath))
  ipcMain.handle('migration:generatePack', (_e, scannedFiles) =>
    generateConversionPack(scannedFiles)
  )
  ipcMain.handle('migration:parseImport', (_e, mdContent: string) => parseImportMd(mdContent))
  ipcMain.handle('migration:importToGolden', (_e, _blocks, _templateName: string) => {
    throw new Error(
      '契約違反: golden への直接書込みは禁止されています。契約実行ツール（_Tools/golden-apply）を経由してください。'
    )
  })
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
  // 格納フォルダ外の任意フォルダを手動フルパス登録（自動探索は通さない）。external:true で視覚区別。
  ipcMain.handle('projects:addExternal', (_e, projectPath: string) =>
    importProjects([projectPath], { external: true })
  )
  ipcMain.handle('projects:removeFromList', (_e, paths: string[]) => removeProjectsFromList(paths))
  ipcMain.handle('projects:setFavorite', (_e, projectPath: string, favorite: boolean) =>
    setFavorite(projectPath, favorite)
  )
  ipcMain.handle('projects:setPxpipeEnabled', (_e, projectPath: string, enabled: boolean) =>
    setPxpipeEnabled(projectPath, enabled)
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

  // --- Model Catalog (040 裏CC定石 第一利用者) ---
  // R-4: stale判定はここで一度だけ計算しrendererへ渡す（renderer側でTTL定数を二重管理しない）。
  const withStale = (catalog: ModelCatalog | null): (ModelCatalog & { stale: boolean }) | null =>
    catalog ? { ...catalog, stale: isStale(catalog) } : null
  ipcMain.handle('modelCatalog:get', () => withStale(readCatalogSync()))
  ipcMain.handle('modelCatalog:refresh', async () =>
    // FB02: spawn は常時 hidden 化（backstageCc.hidden はパネル自動オープン抑止として renderer が読む）
    withStale(await fetchModelCatalog({ trigger: 'manual' }))
  )
  // FB02 F9: キャッシュ削除（デバッグ・検収用。次回起動時に自動再取得）。
  ipcMain.handle('modelCatalog:clear', () => clearCatalogCache())

  // --- BG-CC Activity (FB02: 本コードベース初の main→renderer push チャネル) ---
  // bus → 全ウィンドウへ broadcast。registerIpcHandlers は起動時に1回だけ呼ばれる（index.ts）。
  onBgccActivity((ev) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed()) continue
      try {
        w.webContents.send('bgcc:activity', ev)
      } catch {
        /* best-effort（描画側消滅レース等） */
      }
    }
  })
  // 遅延マウント補完: 起動時 TTL 更新はレンダラ表示前に走るため、直近イベントを後読みできるようにする。
  ipcMain.handle('bgcc:activityRecent', () => getRecentActivity())
  // FB02 F7: 生ログ（コピーは main 側で clipboard 書込 — 大きなログの二重転送を避ける）。
  ipcMain.handle('bgccLog:copy', () => {
    const r = readLatestRunLogForClipboard()
    if (!r) return { ok: false as const, error: 'BG-CC 実行ログがまだありません' }
    clipboard.writeText(r.text)
    return { ok: true as const, path: r.path, bytes: Buffer.byteLength(r.text, 'utf8') }
  })
  ipcMain.handle('bgccLog:openFolder', async () => {
    const dir = getBgccLogDir()
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      /* openPath 側のエラーで返す */
    }
    const err = await shell.openPath(dir)
    return { ok: err === '', error: err || undefined, path: dir }
  })

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
  ipcMain.handle('cc:launch', async (e, args: LaunchArgs & { pxpipe?: PxpipeMode }) => {
    // 037 Phase 2-C 追加: 起動した子ウィンドウを最前面に出すため、spawn 前に
    // 親 CCPIT を blur してアクティブ状態を解除する。新規 wt 等が起動した時点で
    // フォアグラウンドを取りやすくなる。CCPIT 自体はクリックで再アクティブ化可能。
    BrowserWindow.fromWebContents(e.sender)?.blur()
    // 038: pxpipe 経路は 3 モード（PxpipeMode の doc 参照）。既定 auto = 従来挙動。
    const { pxpipe: mode = 'auto', ...launchArgs } = args
    if (mode === 'off') return launchCc(launchArgs)
    if (mode === 'auto') {
      const pxpipeEnabled = await getPxpipeEnabled(launchArgs.projectPath)
      if (!pxpipeEnabled) return launchCc(launchArgs)
    }
    // pxpipe 経由（auto で ON / force）: proxy を確保してから CC に ANTHROPIC_BASE_URL を注入。
    // URL は ensureProxy の実測値を使う（ポートフェイルオーバー時に定数と乖離するため）。
    // proxy 起動失敗時は graceful degrade（pxpipe なしで起動し、理由をダイアログで通知）。
    // force（Fable ボタン）の degrade でも flags は renderer 合成のため --model は保持される。
    // 実装レビュー #3: ensureProxy は ok:false で degrade する契約だが、想定外の例外で
    // reject した場合はこの handler ごと落ち、**launchCc に到達せず CC 起動が失敗する**。
    // 「proxy 側の失敗は CC 起動をブロックしない」という既存の不変条件を例外経路でも守るため、
    // reject を ok:false へ正規化してから既存の degrade 分岐へ合流させる。
    const ensured = await ensureProxy({ proxyEnv: pxpipeProxyEnv() }).catch((e) => ({
      ok: false as const,
      reused: false,
      url: '',
      reason: e instanceof Error ? e.message : String(e)
    }))
    if (ensured.ok) {
      // R1: 上流が確保できた時だけ日本語ダッシュボード(serve-ja)の liveness を確認し、
      // 落ちていれば起動する。**fail-open 厳守** — await せず、例外も握り潰す。
      // ここをブロッキングにすると serve-ja の不調が CC 起動そのものを止める（設計レビュー #8）。
      //
      // serve-ja は配布物へ同梱済みなので、以前のように「未設定環境では即 no-op」にはならない。
      // 代わりに **アプリの言語が日本語のときだけ**自動起動する（英語ユーザーに不要なプロセスを
      // 増やさない）。判定は main の app-config を真実源とし、ユーザーが自分で押す Start ボタンは
      // この門を通さない（明示操作を言語設定で否定しないため）。
      if (shouldAutoStartJaDashboard()) {
        void ensureJaDashboard().catch(() => {
          /* ja ダッシュは補助機能。失敗しても CC 起動を妨げない */
        })
      }
      // 13_pxp Phase 1: CC には pxpipe を直接向けず、本 CCPIT 所有のサニタイズ中継を経由させる
      // （中継 → pxpipe → Anthropic）。中継は `# Environment` 節の陳腐化推奨カタログ行・
      // モデル同一性不一致行を除去してから転送する（中継の起動自体が失敗した場合は pxpipe 自体の
      // 起動失敗と同様に graceful degrade する）。
      const relay = await ensureEnvSanitizeRelay(ensured.url).catch((e) => ({
        ok: false as const,
        reason: e instanceof Error ? e.message : String(e)
      }))
      if ('url' in relay) {
        // 041: gateway 確定（ANTHROPIC_BASE_URL 注入）時のみ、1M 対応モデルの --model へ [1m] を
        // 付与し既定 200K 落ちを回避する。config（pxpipe.fableModel/models）は非改変＝PXPIPE_MODELS は
        // base のままで、pxpipe 側の [1m] strip 後 base 一致で横取りが継続する（040 R-7 結合を温存）。
        // 非 px（off / auto で無効）・proxy 失敗 degrade の各分岐は付与しない（direct API は 1M 不要）。
        return launchCc(
          { ...launchArgs, flags: applyOneMContextToFlags(launchArgs.flags) },
          { ANTHROPIC_BASE_URL: relay.url }
        )
      }
      await dialog.showMessageBox({
        type: 'warning',
        title: 'pxpipe',
        message: 'サニタイズ中継を起動できませんでした。pxpipe なしで CC を起動します。',
        detail: relay.reason ?? ''
      })
      return launchCc(launchArgs)
    }
    await dialog.showMessageBox({
      type: 'warning',
      title: 'pxpipe',
      message: 'pxpipe proxy を起動できませんでした。pxpipe なしで CC を起動します。',
      detail: ensured.reason ?? ''
    })
    return launchCc(launchArgs)
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
    // pxpipe ensure の失敗を quiet に握り潰さず可視化する（007 調整#2 / Juiz 検収追補①）。
    let pxpipeWarning: string | undefined
    try {
      // bump を最優先で実行する（旧不変条件: bump 成功後の detect 失敗は partial-success で返す。
      // pxpipe lookup の失敗が bump を妨げてはならない = 二重 bump/設定 stale を防ぐ。Codex HIGH 対応）。
      const bumped = await bumpRestartGeneration()
      if (!bumped.ok) return { ok: false as const, error: bumped.error }
      const detected = await detectLiveSessions()
      // pxpipe（配布地雷 #6）: ON の live CC があれば proxy を確保する（bump 後・自己 resume 前）。
      // ensure 失敗は restart を妨げない（best-effort）が、静かな no-op にはせず pxpipeWarning に載せて
      //   呼び出し側で可視化する（安全装置の見かけ倒し排除）。
      // self-resume は同窓 env を継承するため、proxy が生きていれば pxpipe 経由が透過維持される。
      if (detected.ok) {
        try {
          const flags = await Promise.all(
            detected.summary.sessions.map((s) =>
              s.cwd ? isLiveSessionPxpipeEnabled(s.cwd) : Promise.resolve(false)
            )
          )
          if (flags.some(Boolean)) {
            const ensured = await ensureProxy({ proxyEnv: pxpipeProxyEnv() }).catch((e) => ({
              ok: false as const,
              reason: e instanceof Error ? e.message : String(e)
            }))
            if (!ensured.ok) {
              pxpipeWarning = ensured.reason ?? 'pxpipe proxy を確保できませんでした。'
            } else {
              // 13_pxp Phase 1: 中継の転送先を最新の pxpipe URL に追従させる。中継自体の
              // アドレスは（app 再起動を挟まない限り）不変なので、self-resume が継承した
              // 旧 env（中継の URL）は pxpipe 側のポートドリフトに関係なく生き続ける。
              await ensureEnvSanitizeRelay(ensured.url).catch(() => {
                /* best-effort: 中継が起動できなくても bulk restart 自体は妨げない */
              })
            }
            if (ensured.ok && ensured.url !== pxpipeUrl(PXPIPE_PORT_CANDIDATES[0])) {
              // 038 Feature C: フェイルオーバー後のポートドリフト可視化。self-resume は同窓 env の
              // ANTHROPIC_BASE_URL（旧ポート）を継承するため、proxy が代替ポートへ移った場合は
              // 旧ポート向きの CC が pxpipe を失う。quiet no-op にせず警告する（007 調整#2 同系）。
              pxpipeWarning = appendWarning(
                pxpipeWarning,
                `pxpipe proxy が代替ポート（${ensured.url}）で稼働中です。既存 CC ウィンドウは旧ポートを向いている可能性があるため、pxpipe 利用 PJ は新規起動し直してください。`
              )
            }
            // 13_pxp Phase 1 指摘（Codex 総合クローズ判定・severity high）: self-resume は
            // 起動済みシェルの env をそのまま引き継ぐため、本修正（サニタイズ中継）を経由しない
            // 旧起動の CC ウィンドウ（中継実装より前に起動されたもの・または中継確保失敗で
            // degrade 起動されたもの）は、restartAll をかけても中継を経由するようにはならない
            // （self-resume の構造的な限界であり、port drift 対応と同様に quiet no-op にしない）。
            // ensureProxy/ensureEnvSanitizeRelay の成否に関係なく、pxpipe 有効な live セッションが
            // 1 件でもある限り常に案内する。
            pxpipeWarning = appendWarning(
              pxpipeWarning,
              '既存の対話セッションは、pxpipe 経由であっても今回のサニタイズ中継を経由しません（self-resume は起動時の env をそのまま引き継ぐため）。環境ブロックの追従修正を反映するには、対象プロジェクトを新規に起動し直してください。'
            )
          }
        } catch (e) {
          pxpipeWarning = `pxpipe proxy 確保中に例外が発生しました: ${e instanceof Error ? e.message : String(e)}`
        }
      }
      if (!detected.ok) {
        return {
          ok: true as const,
          generation: bumped.generation,
          summary: null,
          detectError: detected.error,
          ...(pxpipeWarning ? { pxpipeWarning } : {})
        }
      }
      return {
        ok: true as const,
        generation: bumped.generation,
        summary: detected.summary,
        ...(pxpipeWarning ? { pxpipeWarning } : {})
      }
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
      historyCount: history.length
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

  // 採用適用の単一ゲートは services/adoptApply.gatedApplyFromFile に集約（proposal 採用・cc-request 適用
  // の共通経路。high#1 の 1-parse 共有 / medium#2 の preview→apply 照合 / low#4 fail-closed を内包）。
  // ここでは golden skill 名 + 版だけ供給する薄いラッパにする。
  const gatedApply = (
    filePath: string,
    password: string,
    override: boolean,
    expectedHash: string | undefined,
    requirePreview: boolean
  ): Promise<GatedApplyResult> =>
    listGoldenSkillNames().then((goldenSkillNames) =>
      gatedApplyFromFile(filePath, password, override, expectedHash, requirePreview, {
        applyOpts: { goldenSkillNames, currentGoldenVersion: app.getVersion() }
      })
    )

  // --- Settings Change (CC Request Inbox, 031) ---
  ipcMain.handle('settings:read', () => readSettingsJson())
  ipcMain.handle('settings:hasPassword', () => hasPasswordRegistered())
  ipcMain.handle('settings:readRequest', async (_e, filePath: string) => {
    // previewHash: main が読んだ content の hash を UI に返す。apply 時に照合し preview→apply TOCTOU を塞ぐ。
    const raw = await readFile(filePath, 'utf-8')
    const req = parseChangeRequestFromRaw(raw, filePath)
    return { ...req, previewHash: computeProposalHash(raw) }
  })
  // file-path 化 + kind:skill 経路不問ゲート集約。renderer の object 捏造・任意ファイル選択で
  // 採用ゲート（hash 照合/重複 fail-closed/terminal-state）をバイパスさせない（marshal 実装 finding 根治）。
  ipcMain.handle(
    'settings:applyChange',
    (_e, filePath: string, previewHash: string, password: string) =>
      // requirePreview=true: Inbox 経路は previewHash 必須（実行時 undefined/空も fail-closed）
      gatedApply(filePath, password, false, previewHash, true)
  )
  ipcMain.handle('settings:listLogs', () => listChangeLogs())
  ipcMain.handle('settings:listBackups', () => listSettingsBackups())
  ipcMain.handle('settings:rollback', (_e, backupId: string) => rollbackToBackup(backupId))

  // --- Skill Proposals (Part B 候補ブラウザ, 構想3) ---
  /** 提案レビューの多重起動ガード（marshal:run と同型）。 */
  let proposalReviewInFlight = false
  /**
   * renderer から届いた ack ペイロードの**形だけ**を検証する（値の照合は採用ゲートの責務）。
   * 3 値が揃った非空文字列でなければ ack 無しとして扱う（fail-closed）。
   */
  /**
   * コメント側 ack の形だけを検証する。**`coerceFindingsAck` とは別関数のまま置く**
   * （次元を混ぜると、片方が stale なだけで両方失効する巻き添えが復活する・r39#1）。
   * 2 値が揃った非空文字列でなければ ack 無しとして扱う（fail-closed）。
   */
  const coerceCommentsAck = (
    v: unknown
  ): { proposalHashAtAck: string; commentsKey: string } | null => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
    const o = v as Record<string, unknown>
    const s = (k: string): string => (typeof o[k] === 'string' ? (o[k] as string) : '')
    const p = { proposalHashAtAck: s('proposalHashAtAck'), commentsKey: s('commentsKey') }
    return p.proposalHashAtAck && p.commentsKey ? p : null
  }

  const coerceFindingsAck = (v: unknown): FindingsAckPayload | null => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
    const o = v as Record<string, unknown>
    const s = (k: string): string => (typeof o[k] === 'string' ? (o[k] as string) : '')
    // 承知の明示操作（r9#1）。厳密に true 以外は ack として扱わない。
    if (o.accepted !== true) return null
    const p = {
      accepted: true,
      labelShown: s('labelShown'),
      proposalHash: s('proposalHash'),
      findingsHash: s('findingsHash'),
      adjudicationsKey: s('adjudicationsKey')
    }
    return p.proposalHash && p.findingsHash && p.adjudicationsKey ? p : null
  }
  ipcMain.handle('skillProposals:defaultFolder', () => getDefaultProposalsFolder())
  const listProposalsWithGolden = async (folder: string): ReturnType<typeof listProposals> => {
    const goldenSkillNames = await listGoldenSkillNames().catch(() => [])

    let goldenSourceMap: Map<string, string> | undefined
    const deployed = getConfig().deployedTemplate
    if (deployed && (KNOWN_TEMPLATES as readonly string[]).includes(deployed)) {
      try {
        goldenSourceMap = await collectGoldenFiles(deployed)
      } catch {
        goldenSourceMap = undefined
      }
    }

    const targetDir = join(app.getPath('home'), '.claude')

    return listProposals(folder, {
      goldenSkillNames,
      goldenSourceMap,
      goldenEnPathOf: getGoldenEnPath,
      targetDir
    })
  }
  ipcMain.handle('skillProposals:list', async (_e, folder: string) => {
    // 昇格の後に状態の更新が途中で止まった合成提案を、golden の実測で検証してから追い付かせる（無ければ何もしない）
    await runComposeCatchUp().catch(() => undefined)
    return listProposalsWithGolden(folder)
  })

  // --- 提案の合成（golden 同名 skill の提案を、今の golden に重ねて 1 本にして golden まで入れる）---
  // 合成 CC は作業場の中だけに書く。検査・登録・独立レビューは CCPIT が行い、昇格は既存の Golden 昇格画面の承認で行う。
  // L0_011: 案件（巡）の作業場のレビューは由来で分け（composeReview）、改訂は窓を出さない AI で回す（composeHeadlessLaunch）。
  // 隔離起動で台本の環境変数があるときだけ、合成 CC・改訂 AI・レビュアーを偽に差し替える（画面の確認用。本物は呼ばない）
  const composeFake = loadComposeFakeDriver()
  const baseFindingsDir = (): string => join(app.getPath('home'), '.ccpit', 'base-findings')
  const composeDeps: ComposeIpcDeps = {
    getRepoDir: () => findRepoRootDir(),
    getClaudeDir: () => join(app.getPath('home'), '.claude'),
    getCcpitDir: () => join(app.getPath('home'), '.ccpit'),
    getProposalsDir: () => getDefaultProposalsFolder(),
    getStorePaths: () => getDefaultProposalStorePaths(),
    getLanguage: () => (getConfig().language === 'en' ? 'en' : 'ja'),
    getOptions: () => {
      const cfg = getConfig()
      // 合成は許可モードを acceptEdits に固定し Bypass を使わないので、設定の permissionMode・skipPermissions は渡さない
      return { model: cfg.skillProposals?.model, effort: cfg.skillProposals?.effort }
    },
    resolveExtraEnv: async () => {
      const cfg = getConfig()
      const mode: PxpipeMode = cfg.skillProposals?.pxpipe ?? 'auto'
      if (mode === 'off') return undefined
      const enabled = mode === 'force' || (await getPxpipeEnabled(getParcFermeDir()))
      if (!enabled) return undefined
      const ensured = await ensureProxy({ proxyEnv: pxpipeProxyEnv() }).catch(() => ({ ok: false as const }))
      if ('url' in ensured && ensured.ok) {
        const relay = await ensureEnvSanitizeRelay(ensured.url).catch(() => ({ ok: false as const }))
        if ('url' in relay) return { ANTHROPIC_BASE_URL: relay.url }
      }
      return undefined
    },
    listCandidates: (repoDir, proposalsDir, stores) => scanProposalCandidates(repoDir, proposalsDir, stores),
    runReview: async (filePath, ctx) => {
      if (ctx) {
        // 案件の作業場: golden との差分を主対象にし、指摘を由来で分ける。台帳の findings は差分と不明だけ、原文由来は受け皿へ
        const stores = getDefaultProposalStorePaths()
        return reviewComposite(filePath, ctx, {
          runReviewer: composeFake ? composeFake.runReviewer : (prompt) => runReviewerWithPrompt(prompt),
          writeReview: (requestId, review, extra) =>
            setProposalReview(requestId, review, stores, { extra: { ...extra } }),
          upsertReceptacles: async (base, meta) =>
            upsertBaseFindings(baseFindingsDir(), {
              skillName: meta.skillName,
              owner: meta.owner,
              proposalId: meta.proposalId,
              caseId: meta.caseId,
              round: meta.round,
              findings: base
            })
        })
      }
      const r = await runProposalReview(filePath)
      return r.status === 'ok'
        ? { status: 'ok', verdict: r.verdict }
        : { status: r.status, message: r.message }
    },
    // 窓なしの実行は --setting-sources= で既定の読込を止めるので、作業場の権限規則は --settings で明示して渡す。
    // 巡の実行側（composeLaunch）が、窓なしで起動する作業場に settings.local.json と同じ規則の .claude/settings.json を書く
    launchHeadless: composeFake ? composeFake.launchHeadless : (a) => startComposeRevisionHeadless(a),
    ...(composeFake ? { launch: composeFake.launch } : {}),
    // L0_012: 偽ドライバの台本が合成開始の IPC の遅れを持つときだけ（隔離起動の画面で「準備中」を撮るため）
    ...(composeFake?.scenario.firstCompose.startIpcDelayMs
      ? {
          beforeComposeStart: () =>
            new Promise<void>((r) => setTimeout(r, composeFake.scenario.firstCompose.startIpcDelayMs))
        }
      : {}),
    notify: (status) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send(COMPOSE_IPC.statusPush, status)
      }
    },
    notifyStage: (status) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send(COMPOSE_IPC.statusPush, status)
      }
    }
  }
  registerComposeHandlers(ipcMain, composeDeps)
  registerComposeCaseHandlers(ipcMain, composeDeps)
  // 描画の報告（ipc.ts の他の口と同じく handle で受ける。戻り値は使わない）
  ipcMain.handle(COMPOSE_IPC.rendered, (_e, seq: unknown) => {
    if (typeof seq === 'number') composeRenderedHandler(composeDeps, seq)
    return null
  })
  ipcMain.handle(COMPOSE_IPC.receptacles, (_e, input: { skillName?: unknown } | undefined) => {
    const skill = typeof input?.skillName === 'string' && input.skillName !== '' ? input.skillName : undefined
    return listReceptacles(baseFindingsDir(), skill)
  })
  ipcMain.handle(COMPOSE_IPC.receptacleClose, (_e, input: { path?: unknown; how?: unknown } | undefined) => {
    const how = input?.how
    if (typeof input?.path !== 'string' || (how !== 'fixed' && how !== 'accepted' && how !== 'merged'))
      return { ok: false, error: '受け皿のパスか閉じ方が不正です' }
    return closeReceptacle(baseFindingsDir(), input.path, how as ReceptacleClosedHow)
  })
  startComposePoller(composeDeps)
  // renderer 起点の状態変更。golden 同名衝突で中身が golden に入っていない提案を adopted にする操作は、
  // 「何も適用されない」と承知したフラグが無ければ拒否する（renderer の無効化を迂回しても通らない）。
  // 正規の昇格が内部から setProposalState を直接呼ぶ経路には、この守りは掛からない。
  ipcMain.handle(
    'skillProposals:setState',
    async (
      _e,
      requestId: string,
      state: ProposalState,
      opts?: { acknowledgeNoApply?: boolean; folder?: string }
    ) => {
      if (state === 'adopted') {
        const folders = Array.from(
          new Set([getDefaultProposalsFolder(), opts?.folder].filter((f): f is string => !!f))
        )
        for (const folder of folders) {
          const hit = (await listProposalsWithGolden(folder)).find((p) => p.requestId === requestId)
          if (!hit) continue
          const guard = evaluateMarkAdoptedGuard(hit, state, opts?.acknowledgeNoApply === true)
          if (!guard.ok) throw new Error(guard.reason)
          break
        }
      }
      return setProposalState(requestId, state)
    }
  )
  // 採用は main 集約で atomic に評価する: adopt の瞬間に現ファイル + 現レビューストアを読み直して
  // レビューゲート判定 → 通過時のみ applyChange。renderer の list スナップショット（needsReview）に
  // 依存しないため、list 取得後のレビュー取消・ファイル差替による未承認採用（marshal round2）を塞ぐ。
  // settings:applyChange と同一 gatedApplyFromFile に集約（override 可・expectedHash 無し＝
  // 承認 content 照合が守る）。両経路が単一ゲートを共有し、将来の分岐でも穴が生じない。
  ipcMain.handle(
    'skillProposals:adopt',
    async (
      _e,
      filePath: string,
      password: string,
      override: boolean,
      findingsAck?: unknown,
      commentsAck?: unknown,
      expectedHash?: string
    ) => {
      // adopt は承認 content 照合が守る（requirePreview=false）。成功時は「適用した request_id」で
      // 採用状態を main が atomic 確定する（renderer の stale requestId による state ずれを根治・round4）。
      const goldenSkillNames = await listGoldenSkillNames()
      // 指摘承知の ack。IPC 引数は実行時値（renderer は任意の object を送れる）ため、
      // **3 値が全て非空文字列で揃っている場合のみ**受け取る。値そのものの正しさは採用ゲートが
      // 現在の raw と台帳から再計算して照合するので、ここは形の検証だけ（fail-closed）。
      const ack = coerceFindingsAck(findingsAck)
      // コメント側 ack は**別次元**として独立に受け取る（findingsAck の 3 値束縛には触らない）。
      const cAck = coerceCommentsAck(commentsAck)
      return adoptProposalFromFile(
        filePath,
        password,
        override,
        {
          applyOpts: { goldenSkillNames, currentGoldenVersion: app.getVersion() },
          ...(ack ? { findingsAck: ack } : {}),
          ...(cAck ? { commentsAck: cAck } : {})
        },
        typeof expectedHash === 'string' && expectedHash.trim() !== '' ? expectedHash.trim() : undefined
      )
    }
  )

  // --- 提案の独立レビュー導線（発注 20260805_1631 §B-1 / §B-3）---
  // レビュアーの可用性。UI はこれでボタンを活性/不能化する（不在時は素通しでなく理由表示）。
  ipcMain.handle('skillProposals:reviewerStatus', () => getReviewerAvailability())
  // B-3: 依頼文をそのまま返す。B-1 が内部で使う文字列と**同一関数の戻り値**（二重定義禁止）。
  ipcMain.handle('skillProposals:reviewRequestText', async (_e, filePath: string) => {
    const prepared = await prepareProposalReviewRequest(filePath)
    return prepared.prompt
  })
  // 解析エラーの修復依頼文（単一ソース・N2, AC2, AC5）。
  // **アプリは提案 MD を書き換えない**（採用ゲートの hash 束縛を壊さない）。
  // 何がどう壊れているかを CC へ正確に渡すところまでが役目。
  ipcMain.handle(
    'skillProposals:repairRequestText',
    async (_e, filePath: string, folderPath?: string) => {
      const allowed =
        typeof folderPath === 'string' && folderPath.trim()
          ? folderPath.trim()
          : getDefaultProposalsFolder()
      const prep = await prepareProposalRepairRequest(String(filePath ?? ''), allowed)
      if (!prep.ok) {
        throw new Error(prep.error)
      }
      return prep.prompt
    }
  )

  // 修復起動の同時実行排他ロック（Codex finding#5）
  const activeRepairLaunches = new Set<string>()

  /**
   * 解析エラー提案の修復用 Claude Code を起動する（D1, AC1, AC5, AC6, AC13, AC14）。
   *
   * 重要不変条件 N1: **app.isPackaged ガードを設けてはならない**。
   * 修復依頼はリポジトリ相対スクリプトに依存せず、1 本の Markdown 書式修復のみを指示するため、
   * 配布版（パッケージ版）でも完結して動作する。
   */
  ipcMain.handle(
    'skillProposals:launchRepair',
    async (_e, filePath: string, folderPath?: string) => {
      const rawPath = String(filePath ?? '')
      const allowed =
        typeof folderPath === 'string' && folderPath.trim()
          ? folderPath.trim()
          : getDefaultProposalsFolder()
      let resolvedPath: string
      try {
        resolvedPath = assertWithinProposalsFolder(rawPath, allowed)
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }

      if (activeRepairLaunches.has(resolvedPath)) {
        return { ok: false, error: 'この提案に対する修復起動が既に進行中です（多重起動抑止）。' }
      }
      activeRepairLaunches.add(resolvedPath)

      try {
        // 押下瞬間にファイルを再読込して最新状態・ハッシュを確認（D4, AC5, finding#4）
        const prep = await prepareProposalRepairRequest(resolvedPath, allowed)
        if (!prep.ok) {
          return { ok: false, error: prep.error }
        }

        const cfg = getConfig()
        const mode: PxpipeMode = cfg.skillProposals?.pxpipe ?? 'auto'
        const cwd = dirname(resolvedPath)

        let extraEnv: Record<string, string> | undefined
        if (mode !== 'off') {
          const enabled = mode === 'force' || (await getPxpipeEnabled(cwd))
          if (enabled) {
            const ensured = await ensureProxy({ proxyEnv: pxpipeProxyEnv() }).catch(() => ({
              ok: false as const
            }))
            if ('url' in ensured && ensured.ok) {
              const relay = await ensureEnvSanitizeRelay(ensured.url).catch(() => ({
                ok: false as const
              }))
              if ('url' in relay) extraEnv = { ANTHROPIC_BASE_URL: relay.url }
            }
          }
        }

        return launchProposalRepair(resolvedPath, prep.prompt, {
          cwd,
          options: {
            model: cfg.skillProposals?.model,
            effort: cfg.skillProposals?.effort,
            permissionMode: cfg.skillProposals?.permissionMode,
            skipPermissions: cfg.skillProposals?.skipPermissions
          },
          ...(extraEnv ? { extraEnv } : {})
        })
      } finally {
        activeRepairLaunches.delete(resolvedPath)
      }
    }
  )

  /**
   * 起動前の祖先設定検査（AC16）。
   * 対象作業ディレクトリ自身または祖先に .claude/settings.*.json が存在するか検査する。
   */
  ipcMain.handle('skillProposals:checkRepairEnvironment', async (_e, filePath: string) => {
    try {
      const resolvedPath = assertWithinProposalsFolder(String(filePath ?? ''))
      const detectedSettings = detectProjectSettingsInAncestors(dirname(resolvedPath))
      return { ok: true, detectedSettings }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        detectedSettings: []
      }
    }
  })
  // 方針つきで改稿+再レビューへ差し戻す依頼文。人間の一言をループへ投入する導線。
  ipcMain.handle(
    'skillProposals:revisionDirectiveText',
    (_e, filePath: string, title: string, findings: string, direction: string) =>
      buildRevisionDirectivePrompt({
        filePath: String(filePath ?? ''),
        title: String(title ?? ''),
        findings: String(findings ?? ''),
        direction: String(direction ?? '')
      })
  )
  // --- ユーザーコメント → CC 対話（`user_comment_dialogue_plan.md`）---
  // **アプリは提案 MD を書き換えない**。ここで書くのはコメントストアだけで、
  // 提案の改稿と応答の保存は CC（`scripts/proposal-comment-respond.cjs`）が担う。
  ipcMain.handle('skillProposals:commentThread', (_e, requestId: string, filePath: string) => {
    const content = readProposalContent(String(filePath ?? ''))
    return getCommentThread(String(requestId ?? ''), content)
  })
  ipcMain.handle(
    'skillProposals:addComment',
    (_e, requestId: string, filePath: string, body: string, expectedProposalHash: string) => {
      const content = readProposalContent(String(filePath ?? ''))
      return addComment(
        String(requestId ?? ''),
        String(body ?? ''),
        content,
        String(expectedProposalHash ?? '')
      )
    }
  )
  ipcMain.handle(
    'skillProposals:withdrawComment',
    (_e, requestId: string, filePath: string, commentId: string) => {
      const content = readProposalContent(String(filePath ?? ''))
      return withdrawComment(String(requestId ?? ''), String(commentId ?? ''), content)
    }
  )
  ipcMain.handle(
    'skillProposals:quarantineComment',
    (_e, requestId: string, commentId: string, reasonCode: string, observedProblem: string) =>
      quarantineComment(
        String(requestId ?? ''),
        String(commentId ?? ''),
        String(reasonCode ?? 'malformed_record'),
        String(observedProblem ?? '')
      )
  )
  ipcMain.handle(
    'skillProposals:supersedeComment',
    (_e, requestId: string, filePath: string, commentId: string) => {
      const content = readProposalContent(String(filePath ?? ''))
      return supersedeComment(String(requestId ?? ''), String(commentId ?? ''), content)
    }
  )
  ipcMain.handle(
    'skillProposals:commentDialogueText',
    (_e, requestId: string, filePath: string) => {
      const p = String(filePath ?? '')
      return buildCommentDialogueRequest(String(requestId ?? ''), p, readProposalContent(p))
    }
  )
  /**
   * 導線①: アプリが CC を起動して応答させる（設計 §3-4）。
   *
   * 依頼文は temp ファイルへ書き、**起動引数には長文も temp パスも載せない**
   * （`flags` は空白連結されるため。実測: `ccLaunch.ts:101`）。パスは env で渡す。
   * cwd はリポ root — 依頼文が `ccpit/scripts/proposal-comment-respond.cjs` という
   * **リポ相対**の実行を指示するため、ここがずれると CC が応答を保存できない。
   */
  ipcMain.handle(
    'skillProposals:launchDialogue',
    async (_e, requestId: string, filePath: string) => {
      // 実装レビュー finding#5: パッケージ済みではリポが無く、依頼文が指示する
      // リポ相対の応答保存スクリプトへ CC が到達できない。**黙って「起動しました」と
      // 成功表示するのが最悪**（ユーザーは待ち続け、コメントは永久に未応答のまま残る）。
      // 到達不能と分かっているなら、起動せず理由を返す。
      if (app.isPackaged) {
        return {
          ok: false,
          error:
            'この経路は開発環境向けです（配布版にはリポジトリが無く、CC が応答保存スクリプトへ到達できません）。「依頼文をコピー」を使い、リポジトリを開いた CC セッションへ貼り付けてください。'
        }
      }
      const cfg = getConfig()
      const mode: PxpipeMode = cfg.skillProposals?.pxpipe ?? 'auto'

      // finding#3: PXP 設定を実際に効かせる。**判断は既存の cc:launch と同じ関数群に委ね**、
      // ここは確定した env を受け取って渡すだけにする（pxpipe の可否判定を二重実装しない）。
      // 失敗は graceful degrade（pxpipe なしで起動）— 既存経路と同じ不変条件を守る。
      let extraEnv: Record<string, string> | undefined
      if (mode !== 'off') {
        const enabled = mode === 'force' || (await getPxpipeEnabled(DIALOGUE_CWD))
        if (enabled) {
          const ensured = await ensureProxy({ proxyEnv: pxpipeProxyEnv() }).catch(() => ({
            ok: false as const
          }))
          if ('url' in ensured && ensured.ok) {
            const relay = await ensureEnvSanitizeRelay(ensured.url).catch(() => ({
              ok: false as const
            }))
            if ('url' in relay) extraEnv = { ANTHROPIC_BASE_URL: relay.url }
          }
        }
      }

      return launchProposalDialogue(String(requestId ?? ''), String(filePath ?? ''), {
        repoRoot: DIALOGUE_CWD,
        options: {
          model: cfg.skillProposals?.model,
          effort: cfg.skillProposals?.effort,
          permissionMode: cfg.skillProposals?.permissionMode,
          skipPermissions: cfg.skillProposals?.skipPermissions
        },
        ...(extraEnv ? { extraEnv } : {})
      })
    }
  )

  // B-1: レビュー実行。多重起動を防ぐ（marshal:run と同型のガード）。
  ipcMain.handle('skillProposals:review', async (_e, filePath: string) => {
    if (proposalReviewInFlight) {
      return {
        status: 'launch-failed' as const,
        message: '提案レビューが既に実行中です（多重起動防止）。'
      }
    }
    proposalReviewInFlight = true
    try {
      return await runProposalReview(filePath)
    } finally {
      proposalReviewInFlight = false
    }
  })

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

  // --- Skill Lifecycle（採用済み skill の棚卸し・撤去・衝突解決。CCPIT_058） ---
  ipcMain.handle('skillLifecycle:list', async () => {
    try {
      return { ok: true as const, result: await computeSkillInventory() }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle(
    'skillLifecycle:remove',
    async (_e, args: { name: string; stateToken: string }) => {
      try {
        return await removeSkill(args.name, args.stateToken, 'manual')
      } catch (e) {
        return {
          success: false,
          reason: 'move-failed' as const,
          error: e instanceof Error ? e.message : String(e)
        }
      }
    }
  )
  ipcMain.handle('skillLifecycle:restoreRemoved', async (_e, removalId: string) => {
    try {
      return await restoreRemovedSkill(removalId)
    } catch (e) {
      return {
        success: false,
        reason: 'not-found' as const,
        error: e instanceof Error ? e.message : String(e)
      }
    }
  })
  ipcMain.handle(
    'skillLifecycle:resolveCollision',
    async (
      _e,
      args: {
        originalName: string
        tempName: string
        keep: 'original' | 'temp'
        stateToken: string
      }
    ) => {
      try {
        return await resolveCollision(args.originalName, args.tempName, args.keep, args.stateToken)
      } catch (e) {
        return {
          success: false,
          reason: 'write-failed' as const,
          error: e instanceof Error ? e.message : String(e)
        }
      }
    }
  )
  ipcMain.handle(
    'skillLifecycle:restoreArchive',
    async (_e, args: { name: string; archivePath: string }) => {
      try {
        return await restoreSkillArchive(args.name, args.archivePath)
      } catch (e) {
        return {
          success: false,
          reason: 'archive-failed' as const,
          error: e instanceof Error ? e.message : String(e)
        }
      }
    }
  )

  // --- MCP (Model Context Protocol) servers ---
  ipcMain.handle('mcp:listServers', async (_e, args: { scope: McpScope; projectPath?: string }) => {
    try {
      const servers = await listMcpServers(args.scope, args.projectPath)
      return { ok: true, servers }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      return { ok: false, error: reason }
    }
  })
  ipcMain.handle(
    'mcp:addServer',
    async (_e, args: { scope: McpScope; server: McpServer; projectPath?: string }) => {
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
  ipcMain.handle('dev:relaunchApp', async () => {
    app.relaunch()
    // app.exit() は before-quit/will-quit を emit しないため、ここで proxy を明示停止する
    // （relaunch 経路での pxpipe orphan を防ぐ）。
    await stopProxy()
    app.exit(0)
  })

  // --- Marshal Tier（外部 Codex adversarial-review）起動 + integrity（PIKES §5-15-9） ---
  // outDir は renderer から受け取らず main 固定の app-owned ディレクトリに限定する
  // （Marshal 成果物3-F2: renderer 制御パスでの任意ファイル書込を防ぐ）。
  // async spawn + in-flight gating で main event loop を塞がず多重起動も防ぐ（成果物3-F2 round2）。
  let marshalInFlight = false
  ipcMain.handle('marshal:run', async (_e, params: { scope?: string; focus: string }) => {
    if (marshalInFlight) {
      return {
        status: 'spawn_failure',
        reason: 'Marshal レビューが既に実行中です（多重起動防止）。'
      }
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

  // --- Golden Promotion Browser (Golden 昇格ブラウザ) ---
  ipcMain.handle('goldenPromotion:list', async () => {
    // 差分の表示は一覧では作らない（詳細の欄を開いたときに goldenPromotion:diffDetail で作る。CCPIT_L0_004 W6）
    return await perfSpan('ipc.list', () => listPromotionCandidates({ withDiffDetail: false }))
  })
  // 一覧の検出が完了したかの診断（読み取りだけ。CCPIT_L0_010）。「救済候補 0 件」が「確かに無い」のか「読めなかった」のかを見分ける。
  // 結果はどこにも保存せず、呼ぶたびに履歴を読み直す
  ipcMain.handle('goldenPromotion:scanDiagnostics', async () => {
    return await perfSpan('ipc.scanDiagnostics', () => getPromotionScanDiagnostics())
  })
  // 選んだ候補 1 件の差分の表示（閲覧だけ。何も書き換えないので認証は要らない）
  ipcMain.handle(
    'goldenPromotion:diffDetail',
    async (_e, item: { source: string; skillName: string; capturedContent?: string }) => {
      return (await getPromotionDiffDetail(item)) ?? null
    }
  )
  ipcMain.handle('goldenPromotion:markViewed', (_e, id: string) => {
    markPromotionItemViewed(id)
    return { ok: true }
  })
  ipcMain.handle(
    'goldenPromotion:setState',
    (_e, args: { ids: string[]; state: PromotionState }) => {
      setPromotionItemsState(args.ids, args.state)
      return { ok: true }
    }
  )
  ipcMain.handle('goldenPromotion:rejectConflicted', async (_e, args: { id: string }) => {
    return await rejectConflictedProposal(args.id)
  })
  // golden を書き換える操作（CCPIT_L0_003）は、各ハンドラの先頭でパスワードを検証する。
  // 何かを読む・書く前に拒否する（apply の候補の走査も一時ファイルを書くので、その前に置く）
  ipcMain.handle(
    'goldenPromotion:apply',
    async (_e, args: { ids: string[]; password?: string }) => {
      const auth = await checkGoldenWriteAuth(args?.password)
      if (!auth.ok) return { ...goldenWriteAuthRejection(auth.reason), appliedItems: [] }
      const allCandidates = await listPromotionCandidates()
      const targetItems = allCandidates.filter((item) => args.ids.includes(item.id))
      // 選んだ候補が再走査に無いときは、書き込む前に止める（CCPIT_L0_010）。救済候補の検出が git を読めずに失敗したとき、
      // 選んだ救済の id が黙って落ち、残りだけが反映される（全部が救済なら「承認対象のアイテムが選択されていません」という誤った理由で止まる）のを防ぐ
      const foundIds = new Set(allCandidates.map((item) => item.id))
      const missingIds = (args.ids ?? []).filter((id) => !foundIds.has(id))
      if (missingIds.length > 0) {
        return {
          success: false,
          appliedItems: [],
          error: `選択した候補が見つかりませんでした（${missingIds.join(', ')}）。何も反映していません。画面を更新しても出ないときは、golden の履歴を読めていない可能性があるので、golden のリポジトリの状態を確かめてください。`
        }
      }

      // 現配布 golden 集合を解決（writeLedger と同一スコープで goldenSetHash を算出）
      const cfg = getConfig()
      const rawTemplate = cfg.deployedTemplate
      if (!rawTemplate || !(KNOWN_TEMPLATES as readonly string[]).includes(rawTemplate)) {
        throw new Error(
          `実配布テンプレートが未設定または未知の値です: ${String(rawTemplate)}。fail-closed により昇格反映を中断します。`
        )
      }
      const templateName = rawTemplate as GoldenTemplateName
      let goldenRels: Set<string> | undefined
      try {
        const { merged } = await resolveGoldenFiles(templateName)
        goldenRels = new Set(
          [...merged.keys()]
            .map((k) => normalizeRelPath(k))
            .filter((p) => !isSkippedFile(p) && !isHashExcluded(p))
        )
      } catch {
        // applyPromotionItems 内部の repoDir スキャンへフォールバック
      }

      return await applyPromotionItems(targetItems, { goldenRels, templateName })
    }
  )
  ipcMain.handle('goldenPromotion:listDeployed', async () => {
    return await perfSpan('ipc.listDeployed', () => listGoldenDeployedSkills())
  })
  ipcMain.handle(
    'goldenPromotion:withdraw',
    async (_e, args: { skillName: string; password?: string }) => {
      const auth = await checkGoldenWriteAuth(args?.password)
      if (!auth.ok) return { ...goldenWriteAuthRejection(auth.reason), appliedItems: [] }
      return await withdrawGoldenSkill(args.skillName)
    }
  )
  // 提案の昇格を戻す（Plan r10 §8・T10）。golden は契約の手順の逆パッチで戻し、手元・記録は復元前 CAS で戻す
  ipcMain.handle('goldenPromotion:rollback', async (_e, args: { requestId: string; password?: string }) => {
    const auth = await checkGoldenWriteAuth(args?.password)
    if (!auth.ok) {
      return {
        ...goldenWriteAuthRejection(auth.reason),
        requestId: typeof args?.requestId === 'string' ? args.requestId : '',
        restoredGolden: [],
        restoredLocal: [],
        restoredRecords: [],
        skipped: []
      }
    }
    if (typeof args?.requestId !== 'string' || args.requestId.trim() === '') {
      return { success: false, requestId: '', restoredGolden: [], restoredLocal: [], restoredRecords: [], skipped: [], error: '提案の ID が指定されていません。' }
    }
    return await rollbackPromotion(args.requestId)
  })
  ipcMain.handle(
    'goldenPromotion:restore',
    async (_e, args: { skillName: string; password?: string }) => {
      const auth = await checkGoldenWriteAuth(args?.password)
      if (!auth.ok) return { ...goldenWriteAuthRejection(auth.reason), appliedItems: [] }
      return await restoreGoldenSkill(args.skillName)
    }
  )
  ipcMain.handle('goldenPromotion:detectLedgerDrift', async () => {
    return await perfSpan('ipc.detectLedgerDrift', () => detectContractCliLedgerDrift())
  })
  ipcMain.handle(
    'goldenPromotion:applyLedgerCatchup',
    async (
      _e,
      args: {
        unrecordedSha: string
        approvalContext: { approvedBy: string; approvedAt: string; confirmationHash: string }
        password?: string
      }
    ) => {
      const auth = await checkGoldenWriteAuth(args?.password)
      if (!auth.ok) return goldenWriteAuthRejection(auth.reason)
      if (
        !args ||
        typeof args.unrecordedSha !== 'string' ||
        !/^[0-9a-fA-F]{40}$/.test(args.unrecordedSha.trim())
      ) {
        return { success: false, error: '無効なコミット SHA が指定されました（40桁の16進数SHA-1が必要です）' }
      }
      if (
        !args.approvalContext ||
        typeof args.approvalContext.approvedBy !== 'string' ||
        !args.approvalContext.approvedBy.trim() ||
        typeof args.approvalContext.approvedAt !== 'string' ||
        isNaN(Date.parse(args.approvalContext.approvedAt)) ||
        typeof args.approvalContext.confirmationHash !== 'string' ||
        !/^[0-9a-fA-F]{64}$/.test(args.approvalContext.confirmationHash.trim())
      ) {
        return {
          success: false,
          error:
            '台帳追補には有効な GUI 承認証跡 (approvalContext: approvedBy, approvedAt, confirmationHash=64桁hex) が必須です (ADR 0002 準拠)'
        }
      }
      return await applyLedgerCatchup(args.unrecordedSha.trim(), {}, {
        approvedBy: args.approvalContext.approvedBy.trim(),
        approvedAt: args.approvalContext.approvedAt.trim(),
        confirmationHash: args.approvalContext.confirmationHash.trim()
      })
    }
  )

  // 契約 L リース回復・進捗通知 (What 1, 2, 3, 5, 7, R-1)
  ipcMain.handle('goldenPromotion:getLeaseStatus', async () => {
    return await perfSpan('ipc.getLeaseStatus', () => getGoldenLeaseStatus())
  })
  ipcMain.handle(
    'goldenPromotion:releaseExpiredLease',
    async (_e, args: { expectedLeaseId: string; password?: string }) => {
      const auth = await checkGoldenWriteAuth(args?.password)
      if (!auth.ok) return { ...goldenWriteAuthRejection(auth.reason), releasedLeaseId: '' }
      return await releaseExpiredGoldenLease(undefined, args.expectedLeaseId)
    }
  )
  ipcMain.handle('goldenPromotion:cleanupArtifacts', async (_e, args?: { password?: string }) => {
    const auth = await checkGoldenWriteAuth(args?.password)
    if (!auth.ok) {
      return {
        ...goldenWriteAuthRejection(auth.reason),
        cleanedWorktrees: [],
        cleanedBranches: [],
        cleanedTempDirs: [],
        keptUnknownOwner: []
      }
    }
    return await cleanupPromotionArtifacts()
  })
  ipcMain.handle('goldenPromotion:verifyEarlyRelease', async () => {
    return await verifyEarlyReleaseEntitlement()
  })
  ipcMain.handle(
    'goldenPromotion:releaseEarlyLease',
    async (e, args: { expectedLeaseId: string; password?: string }) => {
      // パスワードは確認ダイアログより前に検証する（誤り・未登録ならダイアログも出さない）
      const auth = await checkGoldenWriteAuth(args?.password)
      if (!auth.ok) return { ...goldenWriteAuthRejection(auth.reason), releasedLeaseId: '' }
      if (!args?.expectedLeaseId) {
        throw new Error('契約 L 早期解放拒否: expectedLeaseId の指定が必須です')
      }

      // 早期解放資格とリース状態を事前に確認 (fail-closed, W1 の回収も集約実行される)
      const status = await getGoldenLeaseStatus()
      // git から読めなかったものを「存在しません」「資格なし」の理由にせず、確認ダイアログも出さずに止める（CCPIT_L0_014 P1）
      if (status.readError) {
        throw new Error(
          `契約 L 早期解放拒否: リースの状態を git から読めませんでした（何も解放していません）。${status.readError}`
        )
      }
      const entitlement = status.earlyReleaseEntitlement || (await verifyEarlyReleaseEntitlement())
      if (!entitlement.entitled) {
        throw new Error(`契約 L 早期解放拒否: ${entitlement.reason || '早期解放資格を満たしていません'}`)
      }

      // W3 & Codex 指摘反映: Windows ダイアログに判断材料・根拠 4 項目を集約（本文の組み立ては純関数。CCPIT_L0_014 P1・U2）
      const dialogMessage = buildEarlyReleaseDialogMessage({
        expectedLeaseId: args.expectedLeaseId,
        status,
        entitlement
      })

      // Main 側で確認ダイアログを強制表示 (追補条項 L-b(iii): Main 側の承認強制)
      const parentWin = (e?.sender ? BrowserWindow.fromWebContents(e.sender) : null) ?? BrowserWindow.getFocusedWindow() ?? undefined
      const dialogOpts = {
        type: 'warning' as const,
        title: '契約 L リース早期解放 — maintainer個別明示承認 (追補条項 L-b)',
        message: dialogMessage,
        detail: '追補条項 L-b 拘束: 承認は本操作 1 回限り有効であり、永続化・自動化されません。',
        buttons: ['キャンセル', 'maintainerとして承認・早期解放を実行'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      }
      const choice = parentWin
        ? await dialog.showMessageBox(parentWin, dialogOpts)
        : await dialog.showMessageBox(dialogOpts)

      if (choice.response !== 1) {
        return { success: false, cancelled: true, releasedLeaseId: '' }
      }

      // Main が確認ダイアログの承認結果に紐づく 60 秒・一回限り・leaseId 固定のトークンを発行
      const challengeToken = createEarlyReleaseChallenge(args.expectedLeaseId)

      // Main 境界でトークンを消費して原子的 CAS 解放を実行
      return await releaseEarlyGoldenLease(
        undefined,
        args.expectedLeaseId,
        undefined,
        challengeToken
      )
    }
  )

  // 昇格進捗イベントの Renderer への push 転送 (R-1)
  onPromotionProgress((ev) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('goldenPromotion:progress', ev)
      }
    }
  })
}
