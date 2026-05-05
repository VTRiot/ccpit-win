import { readFile, stat } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { readProtocol } from './protocolReader'
import type { ProtocolMarker, DetectionConfidence, ManxFrontmatter } from './types'

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
 * FSA r7 §3 R0a: ハードリンク数取得 (CCDG-V1 検出用)。
 * fs.statSync.nlink は POSIX 標準、Windows NTFS でも動作 (実機で nlink=13 取得確認済)。
 */
export async function getClaudeMdNlink(claudeMdPath: string): Promise<number> {
  try {
    const s = await stat(claudeMdPath)
    return s.nlink
  } catch {
    return 0
  }
}

/**
 * FSA r7 §3 R0a: 旧 CCDG (CCDG-V1) はマスター CLAUDE.md を複数 PJ にハードリンク配布する
 * ツールだった。nlink > 1 → 複数 PJ で同一物理ファイルが共有されている = CCDG-V1 系
 * 確定 Legacy。実機調査結果: 7 PJ (CCDirectoryGenerator/NZD/BridgironTorque/iFlyTeck/Blog4Anthropic/
 * WisperPc/OpenClawSetup) が inode=16607023626126215, nlink=13 を共有。
 */
export function isCCDGV1Hardlink(nlink: number): boolean {
  return nlink > 1
}

/**
 * FSA r7 §5 / MANX_Protocol r8 §9-5: CLAUDE.md 冒頭 YAML フロントマターを解析。
 * 仕様:
 *   ---
 *   manx_version: r8        # 必須
 *   manx_role: managed      # オプション (default: managed)
 *   ---
 * - manx_version 必須。なければ null を返す
 * - manx_role 不正値はデフォルト 'managed'
 * - js-yaml 等の外部依存なし (autoMarker の依存最小方針と整合)
 */
export async function parseManxFrontmatter(
  claudeMdPath: string
): Promise<ManxFrontmatter | null> {
  try {
    const content = await readFile(claudeMdPath, 'utf-8')
    // CRLF / LF 両対応で先頭マーカーを検出
    if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) return null
    const startSkip = content.startsWith('---\r\n') ? 5 : 4
    // 終了マーカー (\n---\n or \r\n---\r\n) を検索
    let endIdx = content.indexOf('\n---\n', startSkip)
    if (endIdx === -1) endIdx = content.indexOf('\r\n---\r\n', startSkip)
    if (endIdx === -1) return null
    const yamlBlock = content.slice(startSkip, endIdx)
    let manxVersion: string | null = null
    let manxRole: 'managed' | 'host' | 'local' = 'managed'
    for (const line of yamlBlock.split(/\r?\n/)) {
      // key: value (# コメント許容)
      const m = line.match(/^(\w+):\s*([^\s#]+)/)
      if (!m) continue
      if (m[1] === 'manx_version') manxVersion = m[2]
      else if (m[1] === 'manx_role') {
        if (m[2] === 'managed' || m[2] === 'host' || m[2] === 'local') {
          manxRole = m[2]
        }
        // 不正値はデフォルト 'managed' のまま
      }
    }
    if (!manxVersion) return null
    return { manxVersion, manxRole }
  } catch {
    return null
  }
}

/**
 * FSA r7 §2-3 + §3 + §5: 2 ソース統合スキャンの入力型 + ハードリンク検出 + YAML 自己宣言。
 *  - `*Local`           : PJ 直下
 *  - `*DotClaudeLocal`  : `<project>/.claude/`
 *  - `*Global`          : `~/.claude/`（FSA r7 で R5 撤廃、再び情報として記録のみ）
 *  - `merged*`          : PJ 直下 + PJ 内 .claude/ の OR 統合結果（グローバル除外、不変）
 *  - `claudeMdNlink`    : CLAUDE.md のハードリンク数 (R0a 検出、CCDG-V1 = nlink>1)
 *  - `manxFrontmatter`  : CLAUDE.md 冒頭 YAML 自己宣言 (R6/R7 判定、null = 未宣言)
 *
 * r6 → r7 差分:
 *   - R5 (グローバル MANX 完備 → manx/low) を**撤廃** (CCDG-V1 過剰判定の元凶)
 *   - R0a 新規: nlink > 1 で CCDG-V1 ハードリンク配布検出 → 確定 Legacy
 *   - R6 新規: YAML manx_role=managed (default) → manx/low (Raiko/MdriveSetup 救済)
 *   - R7 新規: YAML manx_role=host → manx-host/low (CCDG2 自動判定、新 protocol 値)
 *   - merged は依然 global 除外 (R1/R2/R3a/R3b 挙動は不変)
 *   - hasHooksGlobal/hasSkillsGlobal/hasRulesGlobal は r7 で再び informational only
 *   - isGlobalManxInherited は deprecated として export 維持 (互換性)
 *
 * r3 → r4 差分 (継続有効): hooks/skills/rules も settings.json と同様に merged から除外。
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

  // グローバル ~/.claude/（FSA r7: R5 撤廃により再び informational only）
  hasHooksGlobal: boolean
  hasSkillsGlobal: boolean
  hasRulesGlobal: boolean

  // 統合判定結果（グローバル除外）
  mergedHasHooks: boolean
  mergedHasSkills: boolean
  mergedHasRules: boolean
  mergedHasSettings: boolean

  // FSA r7 §3 R0a: CLAUDE.md のハードリンク数 (CCDG-V1 ハードリンク配布検出)
  claudeMdNlink: number

  // FSA r7 §5 / MANX_Protocol r8 §9-5: CLAUDE.md 冒頭 YAML 自己宣言 (R6/R7 判定)
  manxFrontmatter: ManxFrontmatter | null
}

export interface GatherOptions {
  /** グローバル `~/.claude/` を上書きしたい場合に指定（テスト用途）。 */
  globalClaudeDir?: string
}

/**
 * 2 ソース統合スキャン (FSA r7 §2-1)。
 *  - PJ 直下 / PJ/.claude/ をスキャン (R1/R2/R3a/R3b/R4 の判定材料、merged に統合)
 *  - グローバル ~/.claude/ をスキャン (informational only、R5 撤廃により judgment 材料外)
 *  - settings は PJ/.claude/ のみ判定材料 (settings.json または settings.local.json)
 *  - CLAUDE.md の nlink (ハードリンク数) を取得 (R0a CCDG-V1 検出用)
 *  - CLAUDE.md 冒頭 YAML フロントマターを解析 (R6/R7 自己宣言判定用)
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

  // グローバル ~/.claude/ (FSA r7: R5 撤廃により informational only。merged 除外)
  const globalClaudeDir = opts.globalClaudeDir ?? defaultGlobalClaudeDir()
  const hasHooksGlobal = await dirExistsAsync(join(globalClaudeDir, 'hooks'))
  const hasSkillsGlobal = await dirExistsAsync(join(globalClaudeDir, 'skills'))
  const hasRulesGlobal = await dirExistsAsync(join(globalClaudeDir, 'rules'))

  // FSA r7 §3 R0a: ハードリンク数 (CCDG-V1 検出)
  const claudeMdNlink = hasClaudeMd ? await getClaudeMdNlink(claudeMdPath) : 0
  // FSA r7 §5 R6/R7: YAML 自己宣言
  const manxFrontmatter = hasClaudeMd ? await parseManxFrontmatter(claudeMdPath) : null

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
    claudeMdNlink,
    manxFrontmatter,
  }
}

function buildEvidence(inputs: DetectInputs): string {
  const yamlPart = inputs.manxFrontmatter
    ? `manx_yaml: version=${inputs.manxFrontmatter.manxVersion}, role=${inputs.manxFrontmatter.manxRole}`
    : 'manx_yaml: (none)'
  const nlinkPart = inputs.claudeMdNlink > 1
    ? `nlink=${inputs.claudeMdNlink} (CCDG-V1 hardlink distribution detected)`
    : `nlink=${inputs.claudeMdNlink}`
  const sections = [
    `local: CLAUDE.md=${inputs.hasClaudeMd}(${inputs.claudeMdLines}行, ${nlinkPart}), hooks=${inputs.hasHooksLocal}, skills=${inputs.hasSkillsLocal}, rules=${inputs.hasRulesLocal}`,
    `local.claude: hooks=${inputs.hasHooksDotClaudeLocal}, skills=${inputs.hasSkillsDotClaudeLocal}, rules=${inputs.hasRulesDotClaudeLocal}, settings.json=${inputs.hasSettingsDotClaudeLocal}`,
    `global.claude (informational only, R5 retired in r7): hooks=${inputs.hasHooksGlobal}, skills=${inputs.hasSkillsGlobal}, rules=${inputs.hasRulesGlobal}`,
    `merged (excludes global): hooks=${inputs.mergedHasHooks}, skills=${inputs.mergedHasSkills}, rules=${inputs.mergedHasRules}, settings.json=${inputs.mergedHasSettings}`,
    yamlPart,
  ]
  return sections.join('; ')
}

/**
 * @deprecated FSA r7 で R5 を撤廃。本関数は互換性のため export 維持されているが、
 *   deriveMarker からは参照されない。CCDG-V1 系を MANX と誤判定する過剰判定の元凶。
 *   半年後レビュー時に未使用確認後の削除を検討 (037 計画書 r4 §6 scope 外 (iv))。
 *
 * 旧仕様 (FSA r5 §2-5 R5): グローバル `~/.claude/` の hooks/skills/rules 3 要素完備判定。
 */
export function isGlobalManxInherited(inputs: DetectInputs): boolean {
  return inputs.hasHooksGlobal && inputs.hasSkillsGlobal && inputs.hasRulesGlobal
}

/**
 * Pure judgment function: derive ProtocolMarker from inputs.
 * Exposed for vitest unit testing without filesystem I/O.
 *
 * Rules (FSA r7 §3-5):
 *   R0a CLAUDE.md + nlink > 1                                                  → legacy, high  (NEW r7)
 *   R1  mergedHooks + mergedSkills + mergedRules + mergedSettings + CLAUDE.md → manx, high
 *   R2  CLAUDE.md + (mergedHooks OR mergedSkills) (not full)                  → manx, low
 *   R7  CLAUDE.md + manxFrontmatter.manxRole === 'host'                       → manx-host, low (NEW r7)
 *   R6  CLAUDE.md + manxFrontmatter (default: managed)                        → manx, low      (NEW r7)
 *   R3a CLAUDE.md > 200 lines + no mergedHooks + no mergedSkills              → legacy, high
 *   R3b CLAUDE.md ≤ 200 lines + no mergedHooks + no mergedSkills              → unknown, low
 *   R4  no CLAUDE.md                                                          → unknown, unknown
 *
 * 優先順位: R0a > R1 > R2 > R7 > R6 > R3a > R3b > R4
 *   R0a (ハードリンク検出) を最優先 — CCDG-V1 マスター CLAUDE.md 配布構造の確定識別。
 *     R1 完備でも nlink > 1 なら CCDG-V1 として Legacy 判定 (Self-host 装っても本物は分かる)。
 *   R7 (manx-host) を R6 (manx-managed) より前 — host は明示的な役割宣言、優先扱い。
 *   R6 を R3a より前 — YAML 自己宣言があれば長い CLAUDE.md でも MANX 扱い。
 *
 * R5 (FSA r5/r6 で投入したグローバル MANX 完備判定) は r7 で撤廃。
 * isGlobalManxInherited は @deprecated として export 維持 (互換性、半年後削除候補)。
 */
export function deriveMarker(inputs: DetectInputs): ProtocolMarker {
  const {
    hasClaudeMd,
    claudeMdLines,
    claudeMdNlink,
    manxFrontmatter,
    mergedHasHooks,
    mergedHasSkills,
    mergedHasRules,
    mergedHasSettings,
  } = inputs

  let confidence: DetectionConfidence
  let protocol: string

  if (hasClaudeMd && isCCDGV1Hardlink(claudeMdNlink)) {
    // R0a: CCDG-V1 ハードリンク配布検出 (最優先、確定 Legacy)
    confidence = 'high'
    protocol = 'legacy'
  } else if (
    mergedHasHooks &&
    mergedHasSkills &&
    mergedHasRules &&
    mergedHasSettings &&
    hasClaudeMd
  ) {
    // R1: PJ ローカル MANX 完備
    confidence = 'high'
    protocol = 'manx'
  } else if (hasClaudeMd && (mergedHasHooks || mergedHasSkills)) {
    // R2: PJ ローカル部分一致
    confidence = 'low'
    protocol = 'manx'
  } else if (hasClaudeMd && manxFrontmatter?.manxRole === 'host') {
    // R7 (NEW r7): YAML 自己宣言で manx-host 役割
    confidence = 'low'
    protocol = 'manx-host'
  } else if (hasClaudeMd && manxFrontmatter !== null) {
    // R6 (NEW r7): YAML 自己宣言 (managed default or local)
    confidence = 'low'
    protocol = 'manx'
  } else if (
    hasClaudeMd &&
    claudeMdLines > LEGACY_LINE_THRESHOLD &&
    !mergedHasHooks &&
    !mergedHasSkills
  ) {
    // R3a: 巨大 CLAUDE.md → Legacy
    confidence = 'high'
    protocol = 'legacy'
  } else if (
    hasClaudeMd &&
    claudeMdLines <= LEGACY_LINE_THRESHOLD &&
    !mergedHasHooks &&
    !mergedHasSkills
  ) {
    // R3b: 短い CLAUDE.md + ローカル MANX なし + R6/R7 不発火 → unknown
    confidence = 'low'
    protocol = 'unknown'
  } else {
    // R4: CLAUDE.md なし
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
