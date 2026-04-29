import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

const CCPIT_DIR = join(app.getPath('home'), '.ccpit')
const CONFIG_FILE = join(CCPIT_DIR, 'app-config.json')

const DEFAULT_SPLASH_DURATION_MS = 3000
const DEFAULT_SPLASH_RARE_CHANCE = 0.033

export type Language = 'ja' | 'en'
export type Profile = 'manx' | 'legacy'
export type DeploySource = 'golden' | 'pit'

export interface PitReference {
  importedAt: string
  claudeMdHash: string
  rulesCount: number
  skillsCount: number
  rulesList: string[]
  skillsList: string[]
}

export type FeatureKey =
  | 'ccLaunchButton'
  | 'detectLinkRemove'
  | 'protocolBadge'
  | 'favoriteToggle'
  | 'autoMarking'

export interface FeatureFlag {
  enabled: boolean
}

export type FeatureFlags = Record<FeatureKey, FeatureFlag>

export const FEATURE_KEYS: readonly FeatureKey[] = [
  'ccLaunchButton',
  'detectLinkRemove',
  'protocolBadge',
  'favoriteToggle',
  'autoMarking',
] as const

export const DEFAULT_FEATURES: FeatureFlags = {
  ccLaunchButton: { enabled: true },
  detectLinkRemove: { enabled: true },
  protocolBadge: { enabled: true },
  favoriteToggle: { enabled: true },
  autoMarking: { enabled: true },
}

export interface AppConfig {
  splashDurationMs: number
  splashRareChance: number
  debugMode: boolean
  setupCompleted: boolean
  language: Language
  currentProfile: Profile
  features: FeatureFlags
  legacyMasterPath?: string
  lastBackupAt?: string
  deploySource?: DeploySource
  pitReference?: PitReference
}

function getDefaults(): AppConfig {
  return {
    splashDurationMs: DEFAULT_SPLASH_DURATION_MS,
    splashRareChance: DEFAULT_SPLASH_RARE_CHANCE,
    debugMode: false,
    setupCompleted: false,
    language: 'en',
    currentProfile: 'manx',
    features: { ...DEFAULT_FEATURES },
  }
}

function mergeFeatures(parsed: unknown): FeatureFlags {
  const merged: FeatureFlags = { ...DEFAULT_FEATURES }
  if (parsed && typeof parsed === 'object') {
    for (const key of FEATURE_KEYS) {
      const entry = (parsed as Record<string, unknown>)[key]
      if (entry && typeof entry === 'object' && 'enabled' in entry) {
        const enabled = (entry as { enabled: unknown }).enabled
        if (typeof enabled === 'boolean') {
          merged[key] = { enabled }
        }
      }
    }
  }
  return merged
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
    const parsed = JSON.parse(content) as Partial<AppConfig> & { features?: unknown }
    const features = mergeFeatures(parsed.features)
    return { ...defaults, ...parsed, features }
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
  const updated: AppConfig = {
    ...current,
    ...partial,
    features: partial.features
      ? { ...current.features, ...partial.features }
      : current.features,
  }
  if (!existsSync(CCPIT_DIR)) {
    mkdirSync(CCPIT_DIR, { recursive: true })
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(updated, null, 2), 'utf-8')
  return updated
}
