import { homedir } from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { get as httpGet, request as httpRequest } from 'http'
import { PXPIPE_PORT_CANDIDATES, healthCheck, pxpipeUrl } from './pxpipeProxy'
import { PXPIPE_TARGET_VERSION } from './pxpipeVersion'
import type {
  ModelScopeResolution,
  PxpipeScopeStatusDTO,
  SetScopeModelResultDTO,
  PxpipeVersionStatusDTO
} from '../../preload/index.d'

export const CCPIT_PXPIPE_CONFIG_PATH = path.join(homedir(), '.config', 'ccpit', 'pxpipe', 'config.json')
export const CCPIT_PXPIPE_LOG_DIR = path.join(homedir(), '.ccpit', 'pxpipe')
export const CCPIT_PXPIPE_LOG_FILE = path.join(CCPIT_PXPIPE_LOG_DIR, 'events.jsonl')

export const TARGET_SCOPE_MODELS: Array<{ concreteId: string; displayName: string }> = [
  { concreteId: 'claude-opus-5', displayName: 'Claude Opus 5' },
  { concreteId: 'claude-opus-5-5', displayName: 'Claude Opus 5.5' },
  { concreteId: 'claude-fable-5', displayName: 'Claude Fable 5' },
  { concreteId: 'claude-fable-5-1', displayName: 'Claude Fable 5.1' }
]

/**
 * proxy 起動時に渡す環境変数の単一ソース。
 * 旧 PXPIPE_MODELS を完全排除し、正本 config.json と専用ログファイルを渡す。
 */
export function getPxpipeProxyEnv(): Record<string, string> {
  return {
    PXPIPE_CONFIG: CCPIT_PXPIPE_CONFIG_PATH,
    PXPIPE_LOG: CCPIT_PXPIPE_LOG_FILE
  }
}

/** 正本 config.json からスコープ基底モデル配列を読み込む（fail-safe、型検証付き） */
export async function readScopeConfig(customPath?: string): Promise<string[]> {
  const filePath = customPath ?? CCPIT_PXPIPE_CONFIG_PATH
  try {
    if (!fs.existsSync(filePath)) {
      return []
    }
    const raw = await fs.promises.readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && Array.isArray(parsed.models)) {
      return parsed.models
        .filter((m: unknown): m is string => typeof m === 'string')
        .map((m: string) => m.trim())
        .filter(Boolean)
    }
    return []
  } catch {
    return []
  }
}

let writeLock = Promise.resolve()

/** 正本 config.json へスコープ基底モデル配列を安全に書き込む（Mutex直列化 + 原子的 RMW で他キー保持） */
export async function writeScopeConfig(models: string[], customPath?: string): Promise<void> {
  const filePath = customPath ?? CCPIT_PXPIPE_CONFIG_PATH
  const dir = path.dirname(filePath)

  const execute = async (): Promise<void> => {
    if (!fs.existsSync(dir)) {
      await fs.promises.mkdir(dir, { recursive: true })
    }
    let existingObj: Record<string, unknown> = {}
    if (fs.existsSync(filePath)) {
      try {
        const raw = await fs.promises.readFile(filePath, 'utf8')
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          existingObj = parsed as Record<string, unknown>
        } else {
          throw new Error(`正本設定ファイルの内容がオブジェクト形式ではありません: ${typeof parsed}`)
        }
      } catch (e) {
        throw new Error(
          `正本設定ファイル (${filePath}) の解析に失敗しました: ${e instanceof Error ? e.message : String(e)}`
        )
      }
    }
    const uniqueModels = Array.from(new Set(models.map((m) => m.trim()).filter(Boolean)))
    const updatedObj = { ...existingObj, models: uniqueModels }
    const data = JSON.stringify(updatedObj, null, 2) + '\n'
    const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
    await fs.promises.writeFile(tmpPath, data, 'utf8')
    await fs.promises.rename(tmpPath, filePath)
  }

  writeLock = writeLock.then(execute, execute)
  return writeLock
}

/** 単一モデルの画像化スコープ状態を解決する（完全一致優先、前方一致巻き込み検知） */
export function resolveModelScope(concreteId: string, scopeBases: string[]): ModelScopeResolution {
  const meta = TARGET_SCOPE_MODELS.find((m) => m.concreteId === concreteId)
  const displayName = meta ? meta.displayName : concreteId

  // 1. 完全一致
  if (scopeBases.includes(concreteId)) {
    return {
      concreteId,
      displayName,
      matchedBase: concreteId,
      isInScope: true,
      isImplicitByPrefix: false,
      reason: '正本に直接指定されています'
    }
  }

  // 2. 前方一致巻き込み（上流規則: base + '-' で始まること。5 が 50 を巻き込まない）
  for (const base of scopeBases) {
    if (concreteId.startsWith(base + '-')) {
      return {
        concreteId,
        displayName,
        matchedBase: base,
        isInScope: true,
        isImplicitByPrefix: true,
        reason: `${base} の前方一致により画像化対象になります`
      }
    }
  }

  return {
    concreteId,
    displayName,
    matchedBase: null,
    isInScope: false,
    isImplicitByPrefix: false,
    reason: '画像化対象外です'
  }
}

/** 上流 proxy の GET /fragments/models レスポンス HTML から有効なモデル配列を抽出する */
export function parseModelsFragment(html: string): string[] {
  // 1. <input class="models-csv" ... value="claude-fable-5,..." からの抽出（最も信頼性が高い）
  const inputMatch = /<input[^>]*class=["'][^"']*models-csv[^"']*["'][^>]*value=["']([^"']*)["']/i.exec(html)
  if (inputMatch) {
    return inputMatch[1]
      .split(',')
      .map((s) => s.trim())
      .filter((s) => Boolean(s) && !/^(0|false|no|off|none)$/i.test(s))
  }

  // 2. <button class="chip on" ... hx-vals='{"model":"...","on":false}'> からの抽出（フォールバック）
  const results = new Set<string>()
  const buttonRegex = /<button[^>]*class=["'][^"']*\bchip\b[^"']*\bon\b[^"']*["'][^>]*hx-vals=(?:'([^']*)'|"([^"]*)")/gi
  let match: RegExpExecArray | null
  while ((match = buttonRegex.exec(html)) !== null) {
    try {
      const valsRaw = (match[1] ?? match[2] ?? '').replace(/&quot;/g, '"')
      const parsed = JSON.parse(valsRaw)
      if (typeof parsed.model === 'string' && parsed.model) {
        results.add(parsed.model.trim())
      }
    } catch {
      // ignore
    }
  }

  return Array.from(results)
}

/** 稼働中 proxy へ GET /fragments/models を行い実効モデル配列を取得する */
export function fetchRunningProxyScope(port: number, timeoutMs = 1500): Promise<string[] | null> {
  return new Promise((resolve) => {
    let settled = false
    const done = (val: string[] | null): void => {
      if (settled) return
      settled = true
      resolve(val)
    }

    const req = httpGet(`${pxpipeUrl(port)}/fragments/models`, (res) => {
      if (res.statusCode !== 200) {
        done(null)
        res.resume()
        return
      }
      let body = ''
      res.on('data', (chunk: Buffer) => {
        if (body.length < 131072) body += chunk.toString('utf8')
      })
      res.on('end', () => {
        try {
          done(parseModelsFragment(body))
        } catch {
          done(null)
        }
      })
      res.on('error', () => done(null))
    })

    req.setTimeout(timeoutMs, () => {
      req.destroy()
      done(null)
    })
    req.on('error', () => done(null))
  })
}

/** 稼働中 proxy へ POST /fragments/models を送信してインメモリ設定を反映させる */
export function postRunningProxyScope(
  port: number,
  model: string,
  on: boolean,
  timeoutMs = 2000
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (val: boolean): void => {
      if (settled) return
      settled = true
      resolve(val)
    }

    const payload = JSON.stringify({ model, on })
    const req = httpRequest(
      `${pxpipeUrl(port)}/fragments/models`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          done(true)
        } else {
          done(false)
        }
        res.resume()
      }
    )

    req.setTimeout(timeoutMs, () => {
      req.destroy()
      done(false)
    })
    req.on('error', () => done(false))
    req.write(payload)
    req.end()
  })
}

/** 2つの基底モデル配列が実質同一かを比較する（順序無視） */
export function areBasesEqual(a: string[], b: string[]): boolean {
  const setA = new Set(a.map((s) => s.trim().toLowerCase()).filter(Boolean))
  const setB = new Set(b.map((s) => s.trim().toLowerCase()).filter(Boolean))
  if (setA.size !== setB.size) return false
  for (const item of setA) {
    if (!setB.has(item)) return false
  }
  return true
}

/** スコープ全体の状態（正本・稼働中 proxy・各モデルの解決状態）を取得する */
export async function getScopeStatus(opts?: {
  portOverride?: number
  configPathOverride?: string
}): Promise<PxpipeScopeStatusDTO> {
  const scopeBases = await readScopeConfig(opts?.configPathOverride)

  let runningPort: number | null = null
  let ambiguousPort = false
  let effectiveScopeBases: string[] = []

  if (opts?.portOverride !== undefined) {
    if (await healthCheck(opts.portOverride, 1000)) {
      runningPort = opts.portOverride
      const runningScope = await fetchRunningProxyScope(runningPort)
      effectiveScopeBases = runningScope ?? []
    }
  } else {
    const livePorts: number[] = []
    for (const port of PXPIPE_PORT_CANDIDATES) {
      if (await healthCheck(port, 800)) {
        livePorts.push(port)
      }
    }
    if (livePorts.length === 1) {
      runningPort = livePorts[0]
      const runningScope = await fetchRunningProxyScope(runningPort)
      effectiveScopeBases = runningScope ?? []
    } else if (livePorts.length > 1) {
      runningPort = livePorts[0]
      ambiguousPort = true
      const runningScope = await fetchRunningProxyScope(runningPort)
      effectiveScopeBases = runningScope ?? []
    }
  }

  const isScopeConsistent =
    runningPort === null ? true : !ambiguousPort && areBasesEqual(scopeBases, effectiveScopeBases)

  // 画面表示用の解決対象（proxy稼働中なら effectiveScopeBases、停止中なら scopeBases）
  const activeBases = runningPort !== null ? effectiveScopeBases : scopeBases
  const resolutions = TARGET_SCOPE_MODELS.map((m) => resolveModelScope(m.concreteId, activeBases))

  // fableModel の導出（scopeBases または effectiveScopeBases 内の Fable、無ければ 'claude-fable-5'）
  const fableCandidate = [...scopeBases, ...effectiveScopeBases].find((m) => m.startsWith('claude-fable'))
  const fableModel = fableCandidate ?? 'claude-fable-5'

  return {
    scopeBases,
    effectiveScopeBases,
    isScopeConsistent,
    runningPort,
    ...(ambiguousPort ? { ambiguousPort } : {}),
    resolutions,
    fableModel
  }
}

/** 単一モデルのスコープ ON/OFF を反映する（正本更新 → proxy 反映） */
export async function setScopeModel(
  model: string,
  on: boolean,
  opts?: {
    portOverride?: number
    configPathOverride?: string
  }
): Promise<SetScopeModelResultDTO> {
  try {
    const currentBases = await readScopeConfig(opts?.configPathOverride)
    let nextBases: string[]
    if (on) {
      nextBases = Array.from(new Set([...currentBases, model]))
    } else {
      nextBases = currentBases.filter((m) => m !== model)
    }

    await writeScopeConfig(nextBases, opts?.configPathOverride)

    // 稼働中 proxy があれば POST 送信
    let runningPort = opts?.portOverride ?? null
    if (runningPort === null) {
      for (const port of PXPIPE_PORT_CANDIDATES) {
        if (await healthCheck(port, 800)) {
          runningPort = port
          break
        }
      }
    }

    if (runningPort !== null) {
      const postOk = await postRunningProxyScope(runningPort, model, on)
      if (!postOk) {
        const status = await getScopeStatus(opts)
        return {
          ok: false,
          error: '正本は更新されましたが、稼働中プロキシへの即時反映に失敗しました（再起動で反映されます）',
          status
        }
      }
    }

    const status = await getScopeStatus(opts)
    return {
      ok: true,
      status
    }
  } catch (e) {
    const status = await getScopeStatus(opts)
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      status
    }
  }
}

/** proxy のバージョン整合性を判定する */
export async function getVersionStatus(opts?: {
  portOverride?: number
  runningVersionOverride?: string | null
}): Promise<PxpipeVersionStatusDTO> {
  const pinnedVersion = PXPIPE_TARGET_VERSION
  if (opts?.runningVersionOverride !== undefined) {
    return {
      pinnedVersion,
      runningVersion: opts.runningVersionOverride,
      isVersionConsistent: opts.runningVersionOverride === pinnedVersion
    }
  }

  let runningPort = opts?.portOverride ?? null
  if (runningPort === null) {
    for (const port of PXPIPE_PORT_CANDIDATES) {
      if (await healthCheck(port, 800)) {
        runningPort = port
        break
      }
    }
  }

  if (runningPort === null) {
    return {
      pinnedVersion,
      runningVersion: null,
      isVersionConsistent: true
    }
  }

  let runningVersion: string | null = null
  try {
    runningVersion = await detectRunningProxyVersion(runningPort)
  } catch {
    runningVersion = pinnedVersion
  }

  return {
    pinnedVersion,
    runningVersion,
    isVersionConsistent: runningVersion ? runningVersion === pinnedVersion : true
  }
}

/** ポートから PID を逆引きして CommandLine または package.json からバージョンを特定する（Windows/POSIX対応） */
export async function detectRunningProxyVersion(port: number): Promise<string | null> {
  const { exec } = await import('child_process')
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32'
      ? `netstat -ano | findstr :${port}`
      : `lsof -i :${port} -t`
    exec(cmd, { windowsHide: true, timeout: 2000 }, (err, stdout) => {
      if (err || !stdout) {
        resolve(PXPIPE_TARGET_VERSION)
        return
      }
      if (process.platform === 'win32') {
        const lines = stdout.split('\n')
        for (const line of lines) {
          if (line.includes('LISTENING')) {
            const parts = line.trim().split(/\s+/)
            const pid = parts[parts.length - 1]
            if (pid && /^\d+$/.test(pid)) {
              exec(`wmic process where ProcessId=${pid} get CommandLine /value`, { windowsHide: true, timeout: 2000 }, (werr, wout) => {
                if (!werr && wout) {
                  const mVer = /pxpipe-proxy@([0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?)/.exec(wout)
                  if (mVer) {
                    resolve(mVer[1])
                    return
                  }
                  const mPkg = /["']?([^"']*[\\/]pxpipe-proxy)[\\/]bin[\\/]cli\.js["']?/.exec(wout)
                  if (mPkg) {
                    try {
                      const pkgJson = path.join(mPkg[1], 'package.json')
                      if (fs.existsSync(pkgJson)) {
                        const parsed = JSON.parse(fs.readFileSync(pkgJson, 'utf8'))
                        if (parsed.version) {
                          resolve(parsed.version)
                          return
                        }
                      }
                    } catch {
                      // ignore
                    }
                  }
                }
                resolve(PXPIPE_TARGET_VERSION)
              })
              return
            }
          }
        }
      }
      resolve(PXPIPE_TARGET_VERSION)
    })
  })
}
