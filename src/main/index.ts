// 必ず最初の import（読込時に `.ccpit` の場所を定数で確定する製品モジュールより先に隔離を効かせる）
import './isolateHome'
import { app, shell, BrowserWindow, Menu, MenuItem, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerIpcHandlers } from './ipc'
import { getParcFermeDir, readConfigSync } from './services/appConfig'
import {
  getIsolationStatus,
  isIsolatedLaunch,
  noteSkipped,
  shouldRunResidentStartup
} from './isolation'
import { installIsolationBanner } from './isolationBanner'
import { stopProxy } from './services/pxpipeProxy'
import { stopEnvSanitizeRelay } from './services/pxpipeEnvSanitizeRelay'
import { maybeRefreshOnStartup } from './services/modelCatalog'
import {
  runStartupReconcileForApp,
  formatStartupReconcileLog
} from './services/goldenStartup'
import { installRobustLogger } from './services/robustLogger'
import { stopPxpipeWatchdog } from './services/pxpipeResilience'

// 最上流で標準出力消失（EPIPE）耐性ロガーを取り付ける (CCPIT_066 / Codex F6)
installRobustLogger()

// 隔離起動のとき: 切り替え先と、読込時に確定した製品の定数が隔離 root 配下であることをログに残し、画面に帯を出す
if (isIsolatedLaunch()) {
  const st = getIsolationStatus()
  console.log(
    `[CCPIT-Isolation] ready root=${st.root} parcFermeDir=${getParcFermeDir()} is.dev=${is.dev} appPath=${app.getAppPath()}`
  )
  installIsolationBanner()
}
import {
  buildFatalErrorPageUrl,
  formatGuardLog,
  isFatalLoadFailure,
  isRetriableCrash,
  MAX_CRASH_RELOADS,
  READY_TO_SHOW_TIMEOUT_MS,
  RENDERER_READY_TIMEOUT_MS
} from './services/windowFailureGuard'

/**
 * ウィンドウが**無言のブランクになる**のを防ぐ番人を取り付ける。
 *
 * 守るのは「空のまま放置されない」の一点。renderer が自力でエラーを可視化できているなら
 * （ErrorBoundary の fallback 等）main が上書きする理由は無いので、`app:renderer-ready` を
 * 受けたら watchdog を解除する。
 *
 * `isShowingFatalErrorPage` が立っている間は「倒す」系の処理を**全部止める**
 * （エラーページ自身は ready を送らず、preload 破損時は data: への遷移でも preload-error が
 * 再発するため。止めないと 8 秒ごとに再ロードし続ける）。
 */
function installWindowFailureGuard(win: BrowserWindow): void {
  let isShowingFatalErrorPage = false
  let crashReloads = 0
  let readyTimer: NodeJS.Timeout | null = null

  const log = (kind: string, detail: Record<string, unknown>): void => {
    console.error(formatGuardLog(kind, detail))
  }

  const clearReadyTimer = (): void => {
    if (readyTimer) {
      clearTimeout(readyTimer)
      readyTimer = null
    }
  }

  const showFatal = (title: string, detail: string): void => {
    if (isShowingFatalErrorPage) return // 再入防止（ロード失敗ループを作らない）
    isShowingFatalErrorPage = true
    clearReadyTimer()
    const url = buildFatalErrorPageUrl({
      title,
      detail,
      hint: 'ウィンドウを閉じてアプリを再起動してください。詳細はアプリのログに記録されています。'
    })
    // loadURL は Promise を返す。付けないと失敗が unhandled rejection として消える
    win.loadURL(url).catch((e) => log('fatal-page-load-failed', { message: String(e) }))
  }

  win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isFatalLoadFailure(errorCode, isMainFrame)) {
      log('load-failed-nonfatal', { errorCode, errorDescription, isMainFrame })
      return
    }
    log('load-failed', { errorCode, errorDescription, validatedURL })
    showFatal('画面の読み込みに失敗しました', `${errorDescription}（コード ${errorCode}）`)
  })

  win.webContents.on('render-process-gone', (_e, details) => {
    log('render-process-gone', { reason: details.reason, exitCode: details.exitCode })
    if (isShowingFatalErrorPage) return
    if (!isRetriableCrash(details.reason)) return // clean-exit 等は放置（意図された終了）
    if (crashReloads >= MAX_CRASH_RELOADS) {
      showFatal(
        '画面の表示プロセスが繰り返し停止しました',
        `理由: ${details.reason}（自動再読み込みは ${MAX_CRASH_RELOADS} 回で打ち切りました）`
      )
      return
    }
    crashReloads += 1
    win.webContents.reload()
  })

  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    log('preload-error', { preloadPath, message: String(error?.message ?? error) })
    // preload が死ぬと window.api が全滅し、renderer 側の ErrorBoundary では原因を特定できない。
    // ログだけでは根本原因がユーザーにも再検証者にも見えないので、明示する。
    showFatal(
      'アプリの初期化に失敗しました',
      'preload スクリプトの読み込みに失敗しました。アプリの再インストールが必要な可能性があります。'
    )
  })

  // 「ロードは完了したが中身が動いていない」を**外から**検出する唯一の経路。
  // renderer 側の防御（ErrorBoundary / window.onerror）は bundle が実行されて初めて設置されるので、
  // bundle 404・構文エラー・mount 前の例外はここでしか拾えない。
  win.webContents.on('did-finish-load', () => {
    clearReadyTimer()
    if (isShowingFatalErrorPage) return
    if (win.webContents.getURL().startsWith('data:')) return // 内部エラーページは ready を送らない
    readyTimer = setTimeout(() => {
      showFatal(
        '画面を表示できませんでした',
        '読み込みは完了しましたが、画面の内容が表示されませんでした。'
      )
    }, RENDERER_READY_TIMEOUT_MS)
  })

  ipcMain.on('app:renderer-ready', (e, kind: unknown) => {
    if (e.sender !== win.webContents) return
    clearReadyTimer()
    crashReloads = 0 // 「描画できた」ことの証明を受けて初めてリセットする
    if (kind === 'page-error' || kind === 'root-error') {
      // renderer が自力で可視化できている状態。ログには残すが致命扱いはしない
      log('renderer-ready-with-error', { kind })
    }
  })

  win.on('closed', clearReadyTimer)
}

/** renderer 側で捕捉したエラーをログへ落とす（1 回だけ登録する）。 */
function registerRendererErrorLogging(): void {
  ipcMain.on('app:renderer-error', (_e, payload: unknown) => {
    const p = (payload ?? {}) as Record<string, unknown>
    console.error(
      formatGuardLog('renderer-error', {
        scope: p.scope,
        errorId: p.errorId,
        message: p.message,
        stack: p.stack,
        componentStack: p.componentStack
      })
    )
  })
}

function getSplashHtmlPath(): string {
  // Pending #6: splashRareChance に基づく rare 演出抽選 (config 確率で rare splash 表示)
  // readConfigSync が初回起動時に config 不在で例外を投げる可能性に備え try/catch で通常 splash にフォールバック
  let filename = 'splash.html'
  try {
    const config = readConfigSync()
    if (config.splashRareChance > 0 && Math.random() < config.splashRareChance) {
      filename = 'splash-rare.html'
    }
  } catch {
    // config 不在等のエッジケース: 通常 splash にフォールバック
  }
  if (is.dev) {
    return join(__dirname, `../../resources/${filename}`)
  }
  return join(process.resourcesPath, filename)
}

function createSplashWindow(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 360,
    height: 320,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    resizable: false,
    center: true,
    icon,
    webPreferences: {
      sandbox: true
    }
  })

  splash.loadFile(getSplashHtmlPath())

  return splash
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    title: 'CCPIT — Claude Code Protocol Interlock Tower',
    width: 1100,
    height: 750,
    show: false,
    autoHideMenuBar: true,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  installWindowFailureGuard(mainWindow)
  loadAppInto(mainWindow)
}

/**
 * renderer をロードする（dev / 本番の分岐を 1 箇所に集約）。
 * `loadURL` / `loadFile` は Promise を返すので **必ず `.catch()` を付ける**
 * — 付けないと初回ロードの失敗が unhandled rejection として消える。
 */
function loadAppInto(win: BrowserWindow): void {
  const p =
    is.dev && process.env['ELECTRON_RENDERER_URL']
      ? win.loadURL(process.env['ELECTRON_RENDERER_URL'])
      : win.loadFile(join(__dirname, '../renderer/index.html'))
  p.catch((e) => {
    console.error(formatGuardLog('initial-load-failed', { message: String(e) }))
    // did-fail-load も併せて飛ぶのが通常だが、飛ばない失敗形もあるのでここでも倒す
    win.loadURL(
      buildFatalErrorPageUrl({
        title: '画面の読み込みに失敗しました',
        detail: String(e),
        hint: 'ウィンドウを閉じてアプリを再起動してください。'
      })
    ).catch(() => {
      /* ここが最後。これ以上できることは無い */
    })
  })
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.electron')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
    window.webContents.on('context-menu', (_, params) => {
      if (!params.selectionText && !params.isEditable) return
      let ja = true
      try {
        ja = readConfigSync().language.startsWith('ja')
      } catch {
        /* フォールバック: ja */
      }
      const menu = new Menu()
      if (params.isEditable) {
        menu.append(new MenuItem({ role: 'cut', label: ja ? '切り取り' : 'Cut' }))
        menu.append(new MenuItem({ role: 'copy', label: ja ? 'コピー' : 'Copy' }))
        menu.append(new MenuItem({ role: 'paste', label: ja ? '貼り付け' : 'Paste' }))
      } else {
        menu.append(new MenuItem({ role: 'copy', label: ja ? 'コピー' : 'Copy' }))
      }
      menu.popup({ window })
    })
  })

  registerIpcHandlers()

  // 040 R-3: TTL切れ時のみBG起動でモデルカタログを取得する（fire-and-forget、UIブロックなし）。
  // 隔離起動中は、本物の Claude Code（裏 CC）を起こすこの取得を走らせない。
  if (shouldRunResidentStartup()) {
    maybeRefreshOnStartup()
  } else {
    noteSkipped('modelCatalog.maybeRefreshOnStartup')
    console.log('[CCPIT-Isolation] skipped: modelCatalog.maybeRefreshOnStartup（裏 CC の起動）')
  }

  // §9 配線 P4: golden / 配置先 / manifest の三方向照合。
  // ユーザー無改変の差分（ケース2/5）と欠損 restore だけを無確認で追従させる。
  // fire-and-forget — FS で詰まっても window 表示は止めない。結果は P5 が pull する。
  void runStartupReconcileForApp()
    .then((outcome) => console.log(formatStartupReconcileLog(outcome)))
    .catch((err: unknown) => {
      console.error(
        formatGuardLog('startup-reconcile-failed', {
          message: err instanceof Error ? err.message : String(err)
        })
      )
    })

  // Splash screen
  const appConfig = readConfigSync()
  const splashDurationMs = appConfig.splashDurationMs
  const splash = createSplashWindow()
  const splashStart = Date.now()

  // Main window (hidden)
  const mainWindow = new BrowserWindow({
    title: 'CCPIT — Claude Code Protocol Interlock Tower',
    width: 1100,
    height: 750,
    show: false,
    autoHideMenuBar: true,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  registerRendererErrorLogging()
  installWindowFailureGuard(mainWindow)
  loadAppInto(mainWindow)

  // splash を閉じて main を出す処理は 1 本にまとめる。
  // 現状は `ready-to-show` を待つ作りなので、**発火しないと splash が残ったまま main が出ない**。
  // タイムアウトで必ず前へ進める（そこで画面が空なら watchdog がエラーページへ倒す）。
  let shown = false
  const revealMainWindow = (viaTimeout: boolean): void => {
    if (shown || mainWindow.isDestroyed()) return
    shown = true
    if (viaTimeout) {
      console.error(
        formatGuardLog('ready-to-show-timeout', { waitedMs: READY_TO_SHOW_TIMEOUT_MS })
      )
    }
    const elapsed = Date.now() - splashStart
    const remaining = viaTimeout ? 0 : Math.max(0, splashDurationMs - elapsed)
    setTimeout(() => {
      if (!splash.isDestroyed()) splash.destroy()
      if (!mainWindow.isDestroyed()) mainWindow.show()
    }, remaining)
  }

  mainWindow.on('ready-to-show', () => revealMainWindow(false))
  setTimeout(() => revealMainWindow(true), READY_TO_SHOW_TIMEOUT_MS)

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// CCPIT が起動した pxpipe proxy を終了時に確実に停止する（プロセス leak 防止）。
// 外部起動 / 別セッション起動の proxy は対象外（pxpipeProxy 側で所有判定）。
// 13_pxp Phase 1: 同時に env サニタイズ中継（CCPIT プロセス内 HTTP サーバ）も停止する。
// こちらは別プロセスではないため leak の心配はないが、長時間 SSE 接続が残っていても
// app 終了を妨げないよう明示的に閉じる。
// before-quit を一度だけ preventDefault し、両方の停止完了を待ってから再度 quit する
// （async な taskkill が app 終了と race して子孫プロセスが残るのを防ぐ）。
let proxyCleanupDone = false
app.on('before-quit', (e) => {
  if (proxyCleanupDone) return
  stopPxpipeWatchdog()
  e.preventDefault()
  void Promise.all([stopProxy(), stopEnvSanitizeRelay()]).finally(() => {
    proxyCleanupDone = true
    app.quit()
  })
})
