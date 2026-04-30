import { readFile, stat } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { readProtocol } from './protocolReader'
import type { ProtocolMarker, DetectionConfidence } from './types'

export const APP_VERSION = 'ccpit-1.0.0'
export const LEGACY_LINE_THRESHOLD = 200
export const REVISION_UNKNOWN = '?'

/**
 * グローバル `~/.claude/` のパス（Windows: %USERPROFILE%\.claude\）。
 * テスト容易性のため上書き可能。本番では `os.homedir()` 由来の固定値。
 */
export function defaultGlobalClaudeDir(): string {
  return join(homedir(), '.claude')
}

async function fileExistsAsync(filePath: string): Promise<boolean> {
  try {
    const s = await stat(filePath)
    return s.isFile()
  } catch {
    return false
  }
}

async function dirExistsAsync(dirPath: string): Promise<boolean> {
  try {
    const s = await stat(dirPath)
    return s.isDirectory()
  } catch {
    return false
  }
}

async function countLines(filePath: string): Promise<number> {
  try {
    const content = await readFile(filePath, 'utf-8')
    if (content.length === 0) return 0
    return content.split('\n').length
  } catch {
    return 0
  }
}

/**
 * FSA r4 §2-1〜§2-3: 2 ソース統合スキャンの入力型。
 *  - `*Local`           : PJ 直下
 *  - `*DotClaudeLocal`  : `<project>/.claude/`
 *  - `*Global`          : `~/.claude/`（情報として記録するのみ。判定計算には使わない）
 *  - `merged*`          : PJ 直下 + PJ 内 .claude/ の OR 統合結果（グローバル除外）
 *
 * r3 → r4 差分: グローバル `~/.claude/` は **特定 PJ の MANX 化判定の根拠として論理的に不適切**
 * （全 PJ 共通のため）。hooks/skills/rules も settings.json と同様に judgment 材料外とする。
 */
export interface DetectInputs {
  // PJ 直下
  hasClaudeMd: boolean
  claudeMdLines: number
  hasHooksLocal: boolean
  hasSkillsLocal: boolean
  hasRulesLocal: boolean

  // PJ 内 .claude/
  hasHooksDotClaudeLocal: boolean
  hasSkillsDotClaudeLocal: boolean
  hasRulesDotClaudeLocal: boolean
  hasSettingsDotClaudeLocal: boolean

  // グローバル ~/.claude/（FSA r4: judgment 材料外。情報として記録のみ）
  hasHooksGlobal: boolean
  hasSkillsGlobal: boolean
  hasRulesGlobal: boolean

  // 統合判定結果（グローバル除外）
  mergedHasHooks: boolean
  mergedHasSkills: boolean
  mergedHasRules: boolean
  mergedHasSettings: boolean
}

export interface GatherOptions {
  /** グローバル `~/.claude/` を上書きしたい場合に指定（テスト用途）。 */
  globalClaudeDir?: string
}

/**
 * 2 ソース統合スキャン（FSA r4 §2-1）。
 *  - PJ 直下 / PJ/.claude/ をスキャン（judgment 材料）
 *  - グローバル ~/.claude/ は情報として記録するのみ（judgment 材料外。FSA r4 §2-2）
 *  - settings は PJ/.claude/ のみ判定材料（settings.json または settings.local.json）
 */
export async function gatherInputs(
  projectPath: string,
  opts: GatherOptions = {}
): Promise<DetectInputs> {
  const claudeMdPath = join(projectPath, 'CLAUDE.md')
  const hasClaudeMd = await fileExistsAsync(claudeMdPath)
  const claudeMdLines = hasClaudeMd ? await countLines(claudeMdPath) : 0

  // PJ 直下
  const hasHooksLocal = await dirExistsAsync(join(projectPath, 'hooks'))
  const hasSkillsLocal = await dirExistsAsync(join(projectPath, 'skills'))
  const hasRulesLocal = await dirExistsAsync(join(projectPath, 'rules'))

  // PJ 内 .claude/
  const dotClaude = join(projectPath, '.claude')
  const hasHooksDotClaudeLocal = await dirExistsAsync(join(dotClaude, 'hooks'))
  const hasSkillsDotClaudeLocal = await dirExistsAsync(join(dotClaude, 'skills'))
  const hasRulesDotClaudeLocal = await dirExistsAsync(join(dotClaude, 'rules'))
  // settings.json または settings.local.json のいずれかで「PJ がカスタマイズされている」と判定。
  // FSA r3 §2-1 は settings.json のみ列挙だが、Claude Code は両者を有効な設定として扱う。
  const hasSettingsDotClaudeLocal =
    (await fileExistsAsync(join(dotClaude, 'settings.json'))) ||
    (await fileExistsAsync(join(dotClaude, 'settings.local.json')))

  // グローバル ~/.claude/（情報として記録のみ。judgment には使わない。FSA r4 §2-2）
  const globalClaudeDir = opts.globalClaudeDir ?? defaultGlobalClaudeDir()
  const hasHooksGlobal = await dirExistsAsync(join(globalClaudeDir, 'hooks'))
  const hasSkillsGlobal = await dirExistsAsync(join(globalClaudeDir, 'skills'))
  const hasRulesGlobal = await dirExistsAsync(join(globalClaudeDir, 'rules'))

  // 統合判定（PJ 直下 + PJ 内 .claude/ のみ。グローバルは除外）
  const mergedHasHooks = hasHooksLocal || hasHooksDotClaudeLocal
  const mergedHasSkills = hasSkillsLocal || hasSkillsDotClaudeLocal
  const mergedHasRules = hasRulesLocal || hasRulesDotClaudeLocal
  const mergedHasSettings = hasSettingsDotClaudeLocal

  return {
    hasClaudeMd,
    claudeMdLines,
    hasHooksLocal,
    hasSkillsLocal,
    hasRulesLocal,
    hasHooksDotClaudeLocal,
    hasSkillsDotClaudeLocal,
    hasRulesDotClaudeLocal,
    hasSettingsDotClaudeLocal,
    hasHooksGlobal,
    hasSkillsGlobal,
    hasRulesGlobal,
    mergedHasHooks,
    mergedHasSkills,
    mergedHasRules,
    mergedHasSettings,
  }
}

function buildEvidence(inputs: DetectInputs): string {
  const sections = [
    `local: CLAUDE.md=${inputs.hasClaudeMd}(${inputs.claudeMdLines}行), hooks=${inputs.hasHooksLocal}, skills=${inputs.hasSkillsLocal}, rules=${inputs.hasRulesLocal}`,
    `local.claude: hooks=${inputs.hasHooksDotClaudeLocal}, skills=${inputs.hasSkillsDotClaudeLocal}, rules=${inputs.hasRulesDotClaudeLocal}, settings.json=${inputs.hasSettingsDotClaudeLocal}`,
    `global.claude (informational only, not used for judgment): hooks=${inputs.hasHooksGlobal}, skills=${inputs.hasSkillsGlobal}, rules=${inputs.hasRulesGlobal}`,
    `merged (excludes global): hooks=${inputs.mergedHasHooks}, skills=${inputs.mergedHasSkills}, rules=${inputs.mergedHasRules}, settings.json=${inputs.mergedHasSettings}`,
  ]
  return sections.join('; ')
}

/**
 * Pure judgment function: derive ProtocolMarker from inputs.
 * Exposed for vitest unit testing without filesystem I/O.
 *
 * Rules (FSA r4 §2-5 — merged 入力（グローバル除外）に対して評価):
 *   R1  mergedHooks + mergedSkills + mergedRules + mergedSettings + CLAUDE.md → manx, high
 *   R2  CLAUDE.md + (mergedHooks OR mergedSkills) (not full)                  → manx, low
 *   R3a CLAUDE.md > 200 lines + no mergedHooks + no mergedSkills              → legacy, high
 *   R3b CLAUDE.md ≤ 200 lines + no mergedHooks + no mergedSkills              → unknown, low
 *   R4  no CLAUDE.md                                                          → unknown, unknown
 */
export function deriveMarker(inputs: DetectInputs): ProtocolMarker {
  const {
    hasClaudeMd,
    claudeMdLines,
    mergedHasHooks,
    mergedHasSkills,
    mergedHasRules,
    mergedHasSettings,
  } = inputs

  let confidence: DetectionConfidence
  let protocol: string

  if (
    mergedHasHooks &&
    mergedHasSkills &&
    mergedHasRules &&
    mergedHasSettings &&
    hasClaudeMd
  ) {
    confidence = 'high'
    protocol = 'manx'
  } else if (hasClaudeMd && (mergedHasHooks || mergedHasSkills)) {
    confidence = 'low'
    protocol = 'manx'
  } else if (
    hasClaudeMd &&
    claudeMdLines > LEGACY_LINE_THRESHOLD &&
    !mergedHasHooks &&
    !mergedHasSkills
  ) {
    confidence = 'high'
    protocol = 'legacy'
  } else if (
    hasClaudeMd &&
    claudeMdLines <= LEGACY_LINE_THRESHOLD &&
    !mergedHasHooks &&
    !mergedHasSkills
  ) {
    confidence = 'low'
    protocol = 'unknown'
  } else {
    confidence = 'unknown'
    protocol = 'unknown'
  }

  return {
    protocol,
    revision: REVISION_UNKNOWN,
    stage: 'experimental',
    stage_inferred: true,
    variant: null,
    variant_alias: null,
    applied_at: null,
    applied_by: APP_VERSION,
    detection_evidence: buildEvidence(inputs),
    detection_confidence: confidence,
  }
}

export interface DetectOptions {
  /** true: 既存マーカーを無視して再判定する（Re-scan Marker 経路）。 */
  force?: boolean
  /** グローバル `~/.claude/` を上書きしたい場合に指定（テスト用途）。 */
  globalClaudeDir?: string
}

export interface EditMarkerInput {
  protocol: string
  revision: string
  stage: ProtocolMarker['stage']
  variant: string | null
  variant_alias: string | null
}

/**
 * FSA r3 §3-3: Edit Marker 保存時の applied_at は YYMMDDHHMM 形式（10 桁）。
 * 例: 2026-04-30 06:43 → "2604300643"
 */
export function formatAppliedAt(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const yy = String(d.getFullYear()).slice(-2)
  return `${yy}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}`
}

/**
 * FSA r3 §3-3: Edit Marker 保存値の生成。明示設定値として書き換える。
 * pure 関数なので vitest で直接検証可能。
 */
export function buildExplicitMarker(
  edits: EditMarkerInput,
  now: Date,
  appVersion: string = APP_VERSION
): ProtocolMarker {
  return {
    protocol: edits.protocol,
    revision: edits.revision,
    stage: edits.stage,
    stage_inferred: false,
    variant: edits.variant,
    variant_alias: edits.variant_alias,
    applied_at: formatAppliedAt(now),
    applied_by: appVersion,
    detection_evidence: null,
    detection_confidence: 'explicit',
  }
}

/**
 * Auto-mark a project. Returns the existing marker if present (never overwrites).
 * Otherwise returns a derived marker (caller decides whether to write).
 *
 * - `opts.force=true` のときは既存マーカーを無視して再判定する。
 *   Re-scan Marker 経路で使う（FSA r3 §3-5）。
 */
export async function detectProtocol(
  projectPath: string,
  opts: DetectOptions = {}
): Promise<ProtocolMarker> {
  if (!opts.force) {
    const existing = await readProtocol(projectPath)
    if (existing) return existing
  }
  const inputs = await gatherInputs(projectPath, {
    globalClaudeDir: opts.globalClaudeDir,
  })
  return deriveMarker(inputs)
}
