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
 * CCES (036, ClaudeCode-ExtensionsSummary Ver.1.0) settings.
 *
 * `openingText` is read each time `cces:generate` runs and prepended to the summary.
 *
 * `allowAllProjects` is the staged-rollout switch:
 * - 段階 1 (本タスク): UI に表示するが、ボタン enable 判定では使わない（実 enable は常に true）
 * - 段階 2 (037 完了後): デフォルト値を逆転 (true → false) し、Legacy PJ で disable する判定に使う
 *
 * Why this exists in Ver.1.0 (despite `allowAllProjects` not being checked yet):
 * - 段階 2 で R3b 修正後、信頼できる MANX 準拠判定が可能になる。
 *   そのとき、本フィールドのデフォルト値を逆転し、ProjectsPage で marker を見て
 *   ボタン enable/disable を切り替える実装を追加するだけで段階 2 が完成する。
 * - 段階 1 で永続化と UI を完成させておくことで、段階 2 の実装が
 *   「初期値変更 + 判定ロジック追加」のみで済む。
 *
 * DO NOT REMOVE without consulting 037 implementation plan.
 */
export interface CcesConfig {
  openingText?: string
  allowAllProjects?: boolean // 段階 1 default: true, 段階 2 default: false
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
