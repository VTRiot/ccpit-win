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
  | 'editMarkerUI'

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
  'editMarkerUI',
] as const

export const DEFAULT_FEATURES: FeatureFlags = {
  ccLaunchButton: { enabled: true },
  detectLinkRemove: { enabled: true },
  protocolBadge: { enabled: true },
  favoriteToggle: { enabled: true },
  autoMarking: { enabled: true },
  editMarkerUI: { enabled: true },
}

/**
 * CCES (036, ClaudeCode-ExtensionsSummary) settings.
 *
 * `openingText` is read each time `cces:generate` runs and prepended to the summary.
 *
 * `allowAllProjects` is the staged-rollout switch:
 * - 段階 1: UI に表示するが、ボタン enable 判定では使わない（default true）
 * - 段階 2 (037 Phase 2-B、本コード): デフォルト false。
 *   ProjectsPage の CCES Generate ボタンが marker.protocol を見て disable する判定に使われる。
 *   - false (default): manx / manx-host のみ有効、legacy / unknown は灰抜き
 *   - true: 全 PJ 有効（例外運用用）
 *
 * 既存ユーザーの設定値は readConfigSync の `{ ...defaults, ...parsed }` マージで保持される。
 * デフォルト値の変更はあくまで「新規ユーザー」「CONFIG_FILE に cces キー欠落」のケースに適用。
 */
export interface CcesConfig {
  openingText?: string
  allowAllProjects?: boolean // 段階 2 default: false
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
  cces?: CcesConfig
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
    cces: { allowAllProjects: false },
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

function mergeCces(parsed: unknown): CcesConfig {
  const merged: CcesConfig = { allowAllProjects: false }
  if (parsed && typeof parsed === 'object') {
    const p = parsed as Record<string, unknown>
    if (typeof p.openingText === 'string') merged.openingText = p.openingText
    if (typeof p.allowAllProjects === 'boolean') merged.allowAllProjects = p.allowAllProjects
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
    const parsed = JSON.parse(content) as Partial<AppConfig> & {
      features?: unknown
      cces?: unknown
    }
    const features = mergeFeatures(parsed.features)
    const cces = mergeCces(parsed.cces)
    return { ...defaults, ...parsed, features, cces }
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
