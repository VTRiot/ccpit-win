import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerIpcHandlers } from './ipc'
import { readConfigSync } from './services/appConfig'

function getSplashHtmlPath(): string {
  if (is.dev) {
    return join(__dirname, '../../resources/splash.html')
  }
  return join(process.resourcesPath, 'splash.html')
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
    title: 'CCPIT — Claude Code Configuration Manager',
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

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.electron')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpcHandlers()

  // Splash screen
  const appConfig = readConfigSync()
  const splashDurationMs = appConfig.splashDurationMs
  const splash = createSplashWindow()
  const splashStart = Date.now()

  // Main window (hidden)
  const mainWindow = new BrowserWindow({
    title: 'CCPIT — Claude Code Configuration Manager',
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

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('ready-to-show', () => {
    const elapsed = Date.now() - splashStart
    const remaining = Math.max(0, splashDurationMs - elapsed)
    setTimeout(() => {
      if (!splash.isDestroyed()) splash.destroy()
      mainWindow.show()
    }, remaining)
  })

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
