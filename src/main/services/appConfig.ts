import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

const CCPIT_DIR = join(app.getPath('home'), '.ccpit')
const CONFIG_FILE = join(CCPIT_DIR, 'app-config.json')

const DEFAULT_SPLASH_DURATION_MS = 3000
const DEFAULT_SPLASH_RARE_CHANCE = 0.033

export type Language = 'ja' | 'en'
export type Profile = 'manx' | 'legacy'

interface AppConfig {
  splashDurationMs: number
  splashRareChance: number
  debugMode: boolean
  setupCompleted: boolean
  language: Language
  currentProfile: Profile
  legacyMasterPath?: string
  lastBackupAt?: string
}

function getDefaults(): AppConfig {
  return {
    splashDurationMs: DEFAULT_SPLASH_DURATION_MS,
    splashRareChance: DEFAULT_SPLASH_RARE_CHANCE,
    debugMode: false,
    setupCompleted: false,
    language: 'en',
    currentProfile: 'manx',
  }
}

export function getParcFermeDir(): string {
  return CCPIT_DIR
}

/** 同期読み込み（起動時用） */
export function readConfigSync(): AppConfig {
  const defaults = getDefaults()
  if (!existsSync(CONFIG_FILE)) return defaults
  try {
    const content = readFileSync(CONFIG_FILE, 'utf-8')
    const parsed = JSON.parse(content)
    return { ...defaults, ...parsed }
  } catch {
    return defaults
  }
}

/** 設定値を取得 */
export function getConfig(): AppConfig {
  return readConfigSync()
}

/** 設定値を更新 */
export function setConfig(partial: Partial<AppConfig>): AppConfig {
  const current = readConfigSync()
  const updated = { ...current, ...partial }
  if (!existsSync(CCPIT_DIR)) {
    mkdirSync(CCPIT_DIR, { recursive: true })
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(updated, null, 2), 'utf-8')
  return updated
}
