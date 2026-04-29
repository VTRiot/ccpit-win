import { readFile, stat } from 'fs/promises'
import { join } from 'path'
import { readProtocol } from './protocolReader'
import type { ProtocolMarker, DetectionConfidence } from './types'

export const APP_VERSION = 'ccpit-1.0.0'
export const LEGACY_LINE_THRESHOLD = 200
export const REVISION_UNKNOWN = '?'

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

export interface DetectInputs {
  hasClaudeMd: boolean
  hasHooks: boolean
  hasSkills: boolean
  hasRules: boolean
  hasSettings: boolean
  claudeMdLines: number
}

export async function gatherInputs(projectPath: string): Promise<DetectInputs> {
  const claudeMdPath = join(projectPath, 'CLAUDE.md')
  const hasClaudeMd = await fileExistsAsync(claudeMdPath)
  const claudeMdLines = hasClaudeMd ? await countLines(claudeMdPath) : 0
  return {
    hasClaudeMd,
    hasHooks: await dirExistsAsync(join(projectPath, 'hooks')),
    hasSkills: await dirExistsAsync(join(projectPath, 'skills')),
    hasRules: await dirExistsAsync(join(projectPath, 'rules')),
    hasSettings: await fileExistsAsync(join(projectPath, '.claude', 'settings.json')),
    claudeMdLines,
  }
}

/**
 * Pure judgment function: derive ProtocolMarker from inputs.
 * Exposed for vitest unit testing without filesystem I/O.
 *
 * Rules:
 *   R1  hooks + skills + rules + settings.json + CLAUDE.md → manx, confidence=high
 *   R2  CLAUDE.md + (hooks OR skills) (not full)            → manx, confidence=low
 *   R3a CLAUDE.md > 200 lines + no hooks + no skills        → legacy, confidence=high
 *   R3b CLAUDE.md ≤ 200 lines + no hooks + no skills        → unknown, confidence=low
 *   R4  no CLAUDE.md                                         → unknown, confidence=unknown
 */
export function deriveMarker(inputs: DetectInputs): ProtocolMarker {
  const { hasClaudeMd, hasHooks, hasSkills, hasRules, hasSettings, claudeMdLines } = inputs

  const evidence: string[] = []
  evidence.push(`CLAUDE.md=${hasClaudeMd}(${claudeMdLines}行)`)
  evidence.push(
    `hooks=${hasHooks}, skills=${hasSkills}, rules=${hasRules}, settings.json=${hasSettings}`
  )

  let confidence: DetectionConfidence
  let protocol: string

  if (hasHooks && hasSkills && hasRules && hasSettings && hasClaudeMd) {
    confidence = 'high'
    protocol = 'manx'
  } else if (hasClaudeMd && (hasHooks || hasSkills)) {
    confidence = 'low'
    protocol = 'manx'
  } else if (
    hasClaudeMd &&
    claudeMdLines > LEGACY_LINE_THRESHOLD &&
    !hasHooks &&
    !hasSkills
  ) {
    confidence = 'high'
    protocol = 'legacy'
  } else if (
    hasClaudeMd &&
    claudeMdLines <= LEGACY_LINE_THRESHOLD &&
    !hasHooks &&
    !hasSkills
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
    detection_evidence: evidence.join('; '),
    detection_confidence: confidence,
  }
}

/**
 * Auto-mark a project. Returns the existing marker if present (never overwrites).
 * Otherwise returns a derived marker (caller decides whether to write).
 */
export async function detectProtocol(projectPath: string): Promise<ProtocolMarker> {
  const existing = await readProtocol(projectPath)
  if (existing) return existing

  const inputs = await gatherInputs(projectPath)
  return deriveMarker(inputs)
}
