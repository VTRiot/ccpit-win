import { join } from 'path'
import { existsSync, mkdirSync, appendFileSync, statSync, renameSync } from 'fs'
import { homedir } from 'os'
import { format } from 'util'

/**
 * Robust Logger — 標準出力消失（EPIPE）耐性ロガー (CCPIT_066 / Codex F6)。
 *
 * 目的:
 * - 親ターミナル強制終了に伴う process.stdout/stderr パイプ切断時に、
 *   console 出力が EPIPE 未捕捉例外になってアプリが落ちたり Electron ダイアログが出るのを阻止。
 * - 全ログを `~/.ccpit/logs/main.log` へ確実に退避追記し、障害調査の証拠を残す。
 * - 循環呼出防止とサイズ上限ローテーション（10MB）。
 */

export interface RobustLoggerOptions {
  logDir?: string
  maxBytes?: number
  stdout?: NodeJS.WriteStream
  stderr?: NodeJS.WriteStream
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024 // 10MB

let installed = false
let currentLogFile = ''
let currentLogDir = ''
let maxLogBytes = DEFAULT_MAX_BYTES
let stdoutBroken = false
let stderrBroken = false

let origConsoleLog: typeof console.log | null = null
let origConsoleWarn: typeof console.warn | null = null
let origConsoleError: typeof console.error | null = null
let origConsoleInfo: typeof console.info | null = null
let origConsoleDebug: typeof console.debug | null = null

let registeredStdout: NodeJS.WriteStream | null = null
let registeredStderr: NodeJS.WriteStream | null = null
let stdoutErrorHandler: ((err: unknown) => void) | null = null
let stderrErrorHandler: ((err: unknown) => void) | null = null

function isPipeError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const code = (err as { code?: string }).code
  const msg = (err as Error).message ?? ''
  return code === 'EPIPE' || code === 'EOF' || code === 'ERR_STREAM_DESTROYED' || /EPIPE/i.test(msg)
}

function rotateIfNeeded(filePath: string, maxBytes: number): void {
  try {
    if (!existsSync(filePath)) return
    const stat = statSync(filePath)
    if (stat.size >= maxBytes) {
      const backupPath = `${filePath}.1`
      renameSync(filePath, backupPath)
    }
  } catch {
    /* ロギングのローテーション失敗はアプリ動作を阻害しない */
  }
}

function writeToLogFile(level: string, message: string): void {
  if (!currentLogFile) return
  try {
    rotateIfNeeded(currentLogFile, maxLogBytes)
    const timestamp = new Date().toISOString()
    const line = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`
    appendFileSync(currentLogFile, line, 'utf8')
  } catch {
    /* 退避ファイルへの書き込み失敗時もアプリ本体は落とさない */
  }
}

export function installRobustLogger(opts: RobustLoggerOptions = {}): void {
  if (installed) return
  installed = true

  currentLogDir = opts.logDir ?? join(homedir(), '.ccpit', 'logs')
  currentLogFile = join(currentLogDir, 'main.log')
  maxLogBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  stdoutBroken = false
  stderrBroken = false

  try {
    mkdirSync(currentLogDir, { recursive: true })
  } catch {
    /* best-effort */
  }

  const stdoutStream = opts.stdout ?? process.stdout
  const stderrStream = opts.stderr ?? process.stderr

  stdoutErrorHandler = (err: unknown): void => {
    if (isPipeError(err)) {
      stdoutBroken = true
      writeToLogFile('WARN', `[robustLogger] stdout broken pipe detected (${String(err)})`)
      return
    }
    writeToLogFile('ERROR', `[robustLogger] stdout error: ${String(err)}`)
  }

  stderrErrorHandler = (err: unknown): void => {
    if (isPipeError(err)) {
      stderrBroken = true
      writeToLogFile('WARN', `[robustLogger] stderr broken pipe detected (${String(err)})`)
      return
    }
    writeToLogFile('ERROR', `[robustLogger] stderr error: ${String(err)}`)
  }

  stdoutStream?.on?.('error', stdoutErrorHandler)
  stderrStream?.on?.('error', stderrErrorHandler)
  registeredStdout = stdoutStream
  registeredStderr = stderrStream

  origConsoleLog = console.log
  origConsoleWarn = console.warn
  origConsoleError = console.error
  origConsoleInfo = console.info
  origConsoleDebug = console.debug

  console.log = (...args: unknown[]): void => {
    const formatted = format(...args)
    writeToLogFile('INFO', formatted)
    if (!stdoutBroken && origConsoleLog) {
      try {
        origConsoleLog(...args)
      } catch (e) {
        if (isPipeError(e)) stdoutBroken = true
      }
    }
  }

  console.info = (...args: unknown[]): void => {
    const formatted = format(...args)
    writeToLogFile('INFO', formatted)
    if (!stdoutBroken && origConsoleInfo) {
      try {
        origConsoleInfo(...args)
      } catch (e) {
        if (isPipeError(e)) stdoutBroken = true
      }
    }
  }

  console.debug = (...args: unknown[]): void => {
    const formatted = format(...args)
    writeToLogFile('DEBUG', formatted)
    if (!stdoutBroken && origConsoleDebug) {
      try {
        origConsoleDebug(...args)
      } catch (e) {
        if (isPipeError(e)) stdoutBroken = true
      }
    }
  }

  console.warn = (...args: unknown[]): void => {
    const formatted = format(...args)
    writeToLogFile('WARN', formatted)
    if (!stderrBroken && origConsoleWarn) {
      try {
        origConsoleWarn(...args)
      } catch (e) {
        if (isPipeError(e)) stderrBroken = true
      }
    }
  }

  console.error = (...args: unknown[]): void => {
    const formatted = format(...args)
    writeToLogFile('ERROR', formatted)
    if (!stderrBroken && origConsoleError) {
      try {
        origConsoleError(...args)
      } catch (e) {
        if (isPipeError(e)) stderrBroken = true
      }
    }
  }
}

export function uninstallRobustLogger(): void {
  if (!installed) return
  installed = false

  if (origConsoleLog) console.log = origConsoleLog
  if (origConsoleWarn) console.warn = origConsoleWarn
  if (origConsoleError) console.error = origConsoleError
  if (origConsoleInfo) console.info = origConsoleInfo
  if (origConsoleDebug) console.debug = origConsoleDebug

  origConsoleLog = null
  origConsoleWarn = null
  origConsoleError = null
  origConsoleInfo = null
  origConsoleDebug = null

  if (registeredStdout && stdoutErrorHandler) {
    registeredStdout.removeListener?.('error', stdoutErrorHandler)
  }
  if (registeredStderr && stderrErrorHandler) {
    registeredStderr.removeListener?.('error', stderrErrorHandler)
  }
  registeredStdout = null
  registeredStderr = null
  stdoutErrorHandler = null
  stderrErrorHandler = null
  stdoutBroken = false
  stderrBroken = false
}

export function getRobustLogPath(): string {
  return currentLogFile
}
