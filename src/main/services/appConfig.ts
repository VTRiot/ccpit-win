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
  | 'pxpipeToggle'

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
  'pxpipeToggle'
] as const

export const DEFAULT_FEATURES: FeatureFlags = {
  ccLaunchButton: { enabled: true },
  detectLinkRemove: { enabled: true },
  protocolBadge: { enabled: true },
  favoriteToggle: { enabled: true },
  autoMarking: { enabled: true },
  editMarkerUI: { enabled: true },
  // 配布地雷 #5: pxpipe 未導入ユーザーに「謎の Plug アイコン」を出さないため既定 OFF(opt-in)。
  // pxpipe 導入者だけ Settings で ON にする。既存で ON 済みの値は {...defaults,...parsed} で保持。
  pxpipeToggle: { enabled: false }
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

/**
 * 特別 PJ エントリ（038 Feature B）。auto-discovery root 外の固定 PJ（例: 設計 AI ノード）を
 * Projects 一覧の最上部にピン留め特別行として表示するための config 駆動エントリ。
 * 既定は空配列＝行なし（配布ユーザーへの影響ゼロ）。個人パスをソースへハードコードしないため、
 * 実エントリはユーザーの ~/.ccpit/app-config.json へ直接記述する（round-trip 保持）。
 */
export interface SpecialProjectEntry {
  id: string
  name: string
  path: string
  /** 起動時 --add-dir に渡すパス群（空白を含むパスは不可: 起動コマンドが space join のため）。 */
  addDirs?: string[]
  /** 起動時 effort 既定（EFFORT_LEVELS 外の値は renderer 側で 'max' へフォールバック）。 */
  effort?: string
  /** wt.exe 経路のタブ色（例 '#160b2e'）。ps フォールバックでは無視される。 */
  tabColor?: string
  /** 特別行の Plug トグル状態（projects.json 未登録パスのため per-project トグルの代替）。 */
  pxpipeEnabled?: boolean
}

/**
 * 提案 Stop hook (skill-proposal-gate.sh) の発火モード（Part B Phase2b / B1, FSA §5-b）。
 * - soft  (既定): セッションにつき一度だけ block して emitter 発火を促す（stop_hook_active で継続 stop は素通し）
 * - strict: 提案/該当なしが出るまで新 stop 毎に block（report-gate 同型・ノイズ大）
 * - off   : 提案 Stop hook を無効化（opt-in 運用）
 * 実際に読むのは hook スクリプト（~/.ccpit/app-config.json を grep/sed）。本フィールドは正本・round-trip 保持用。
 */
export type EmissionMode = 'soft' | 'strict' | 'off'

/**
 * CCPIT 055: コンテキスト使用量警告（Stop hook: context-usage-gate.sh → context-usage-detect.cjs）の閾値。
 * warn1 = 🟣 マゼンタ段階 / warn2 = 🔴 赤段階（単位: トークン）。既定 800K / 900K。
 * hook 側も同じ既定・同じ検証（正整数・warn1 < warn2、違反時は既定へ fail-open）を自前で持つ
 * （プロセス境界を跨ぐ import はできんため、値の正本はここ・検証は各読者で二重化する設計）。
 */
export interface ContextUsageConfig {
  warn1?: number
  warn2?: number
}

export const CONTEXT_USAGE_DEFAULTS: Required<ContextUsageConfig> = {
  warn1: 800000,
  warn2: 900000
}

export interface AppConfig {
  splashDurationMs: number
  splashRareChance: number
  debugMode: boolean
  setupCompleted: boolean
  showSetupNav: boolean
  language: Language
  currentProfile: Profile
  features: FeatureFlags
  legacyMasterPath?: string
  lastBackupAt?: string
  deploySource?: DeploySource
  deployedTemplate?: string // deploy() が記録する実デプロイ template (manx/macau/asama)。health coverage の検証基準
  pitReference?: PitReference
  cces?: CcesConfig
  /** 提案 Stop hook の発火モード（既定 soft）。切替は本 JSON の直接編集。hook が読む。 */
  emissionMode?: EmissionMode
  /** pxpipe統合の設定（proxy へ渡す）。配布地雷 #4: models 未設定時は **pxpipe 本体の組込み既定**
   * （`applicability.js` の `DEFAULT_MODEL_BASES`）へ委譲する＝CCPIT 側に既定値を持たん
   * （2026-08-21: 二重管理していた `DEFAULT_PXPIPE_MODELS` を撤去。上流の対象更新へ追従するため）。
   * 非 Fable ユーザーが対象モデルを変えられるよう外出し（切替は本 JSON 直編集）。round-trip 保持。
   * 039 FB⑥: fableModel = Fable 起動ボタンが `--model` に渡す ID の正本（未設定時は FABLE_MODEL_ID）。
   * 040 R-7注記: 040 のモデルカタログ動的取得機構（services/modelCatalog.ts）は本フィールドに
   * 一切書き込まない（LaunchMenu通常起動のプリセット候補追加に留め、Fableボタンの経路とは独立を
   * 維持——R-2「静的側は常に維持・置換ではない」）。将来、動的カタログでFableモデルを差し替える
   * 拡張を行う場合は、`mergeConfigPartial` の深マージ特性を使い
   * `setConfig({ pxpipe: { fableModel, models } })` を**単一呼び出しで両フィールド同時更新**する
   * こと。片方だけの更新は「--model は新ID / proxy は旧IDのみ横取り」という pxp 素通しバグ
   * （039 FB⑥ が特定）を再発させる。 */
  pxpipe?: {
    models?: string
    fableModel?: string
    /** 日本語ダッシュボード（serve-ja）の起動設定。
     * serve-ja は上流 pxpipe を別ポートへ透過プロキシし日本語 overlay を注入する別プロセス。
     * **実体はアプリに同梱済み**（resources/dashboard-ja/）なので、通常は何も設定しなくてよい。
     * - `scriptPath`: 同梱物より優先する手動指定。開発中の serve-ja を使う等の逃げ道であり、
     *   設定されている場合はアプリ言語に関わらず自動起動する（既存ユーザーの挙動温存）。
     * - `port` / `upstreamPort`: 未設定時は pxpipeJaDashboard.ts の既定値へフォールバック。
     * - `yenRate`: 推定削減額に円換算を併記する。**既定 false**。有効にすると overlay が
     *   外部の為替 API へ接続するため、配布状態では通信しないよう opt-in にしてある。 */
    jaDashboard?: {
      scriptPath?: string
      port?: number
      upstreamPort?: number
      yenRate?: boolean
    }
  }
  /**
   * SkillProposal のユーザーコメント → CC 対話で起動する CC の設定（**全提案共通の 1 設定**）。
   *
   * 効くのは「CC を起動して応答させる」導線だけで、依頼文コピーと Codex レビュー実行には効かない
   * （コピーは起動しないので起動引数が存在しない）。UI にもその旨を明記する。
   * Projects 起動用の launchOptions（localStorage）とは**意味が違うので相乗りさせない**。
   */
  skillProposals?: {
    model?: string
    effort?: string
    pxpipe?: 'auto' | 'force' | 'off'
    /** `--permission-mode`。`plan` で計画モード起動（既定 `default` は付与しない） */
    permissionMode?: string
    /** `--dangerously-skip-permissions`。**既定 false**（危険側は明示操作でのみ有効化） */
    skipPermissions?: boolean
  }
  /** 038 Feature B: ピン留め特別行のエントリ群（既定 []）。実エントリは本 JSON 直編集で追加。 */
  specialEntries?: SpecialProjectEntry[]
  /** 040: BG-CC（裏CC定石）共通設定。モデルリスト取得専用にしない（R-5）。
   * FB02 意味変化: spawn は常時 hidden（可視ターミナル窓経路は削除済み）。本キーは renderer の
   * アクティビティパネル「自動オープン抑止」としてのみ生きる — true = 自動で開かない
   * （手動更新・失敗時とも。ステータスバーのインジケータ/バッジは常に更新される）。
   * 既定（未設定/false）= 自動オープン許可（従来の「可視既定」に対応する驚き最小の継承）。
   * キー名は既存ユーザーの設定値互換のため改名しない（Codex 設計レビュー finding 5:
   * 意味変化は UI 文言側で明示 — SettingsDialog のチェックボックス文言参照）。 */
  backstageCc?: { hidden?: boolean }
  /** CCPIT 055 W-2/W-4: コンテキスト使用量警告の閾値。読者は 2 者 —
   * (1) ~/.claude/hooks/context-usage-detect.cjs が毎ターン終了時（Stop hook）に直接 JSON.parse で読む、
   * (2) GeneralPage.tsx（Maintenance > General タブ）が編集する。round-trip 保持。 */
  contextUsage?: ContextUsageConfig
}

function getDefaults(): AppConfig {
  return {
    splashDurationMs: DEFAULT_SPLASH_DURATION_MS,
    splashRareChance: DEFAULT_SPLASH_RARE_CHANCE,
    debugMode: false,
    setupCompleted: false,
    // 初回起動時 ON: setupCompleted=false かつ config 未生成のユーザーで Setup ナビを表示。
    // 既存ユーザーは readConfigSync の {...defaults, ...parsed} マージで保存値が優先される。
    // Setup 完了時に App.tsx の handleSetupCompleted が false へ自動切替する。
    showSetupNav: true,
    language: 'en',
    currentProfile: 'manx',
    features: { ...DEFAULT_FEATURES },
    cces: { allowAllProjects: false },
    emissionMode: 'soft',
    specialEntries: [],
    contextUsage: { ...CONTEXT_USAGE_DEFAULTS }
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

/** contextUsage の防御的マージ（mergeCces と同流儀）。正整数のみ採用・warn1 >= warn2 なら既定へ。 */
export function mergeContextUsage(parsed: unknown): Required<ContextUsageConfig> {
  const merged: Required<ContextUsageConfig> = { ...CONTEXT_USAGE_DEFAULTS }
  if (parsed && typeof parsed === 'object') {
    const p = parsed as Record<string, unknown>
    if (typeof p.warn1 === 'number' && Number.isInteger(p.warn1) && p.warn1 > 0) {
      merged.warn1 = p.warn1
    }
    if (typeof p.warn2 === 'number' && Number.isInteger(p.warn2) && p.warn2 > 0) {
      merged.warn2 = p.warn2
    }
  }
  if (merged.warn1 >= merged.warn2) {
    return { ...CONTEXT_USAGE_DEFAULTS }
  }
  return merged
}

/** specialEntries の防御的マージ（mergeCces と同流儀）。id/name/path が string でない項目は捨てる。 */
export function mergeSpecialEntries(parsed: unknown): SpecialProjectEntry[] {
  if (!Array.isArray(parsed)) return []
  const merged: SpecialProjectEntry[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const p = item as Record<string, unknown>
    if (typeof p.id !== 'string' || typeof p.name !== 'string' || typeof p.path !== 'string') {
      continue
    }
    const entry: SpecialProjectEntry = { id: p.id, name: p.name, path: p.path }
    if (Array.isArray(p.addDirs)) {
      entry.addDirs = p.addDirs.filter((d): d is string => typeof d === 'string')
    }
    if (typeof p.effort === 'string') entry.effort = p.effort
    if (typeof p.tabColor === 'string') entry.tabColor = p.tabColor
    if (typeof p.pxpipeEnabled === 'boolean') entry.pxpipeEnabled = p.pxpipeEnabled
    merged.push(entry)
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
      specialEntries?: unknown
      contextUsage?: unknown
    }
    const features = mergeFeatures(parsed.features)
    const cces = mergeCces(parsed.cces)
    const specialEntries = mergeSpecialEntries(parsed.specialEntries)
    const contextUsage = mergeContextUsage(parsed.contextUsage)
    return { ...defaults, ...parsed, features, cces, specialEntries, contextUsage }
  } catch {
    return defaults
  }
}

/** 設定値を取得 */
export function getConfig(): AppConfig {
  return readConfigSync()
}

/**
 * setConfig / mergeConfigPartial が受ける部分更新パッチ。features は部分指定を許す
 * （IPC config:set は `{ features: { pxpipeToggle: {...} } }` のように 1 キーだけ送る）。
 * この型を明示することで「features は完全 FeatureFlags」という Partial<AppConfig> の過大要求を外す。
 */
export type AppConfigPatch = Partial<Omit<AppConfig, 'features'>> & {
  features?: Partial<FeatureFlags>
}

/**
 * partial を現在値へマージする純関数（副作用なし・テスト対象）。
 * features と pxpipe は 1 段深マージ（部分更新で既存サブキーを消さない）。
 * 039 FB⑥: 040 のモデル更新機構が pxpipe.fableModel だけを書いても、既存 pxpipe.models が
 * 落ちないようにする（features と同じ部分更新セマンティクス）。逆に fableModel だけ更新しても
 * models が保持される。それ以外のトップレベルキーは shallow 置換（specialEntries は配列ごと
 * 全置換＝FB② 削除／FB③ 追加がこの仕様に依存）。
 */
export function mergeConfigPartial(current: AppConfig, partial: AppConfigPatch): AppConfig {
  return {
    ...current,
    ...partial,
    features: partial.features ? { ...current.features, ...partial.features } : current.features,
    pxpipe: partial.pxpipe ? { ...current.pxpipe, ...partial.pxpipe } : current.pxpipe,
    contextUsage: partial.contextUsage
      ? { ...current.contextUsage, ...partial.contextUsage }
      : current.contextUsage
  }
}

/** 設定値を更新 */
export function setConfig(partial: AppConfigPatch): AppConfig {
  const current = readConfigSync()
  const updated = mergeConfigPartial(current, partial)
  if (!existsSync(CCPIT_DIR)) {
    mkdirSync(CCPIT_DIR, { recursive: true })
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(updated, null, 2), 'utf-8')
  return updated
}
