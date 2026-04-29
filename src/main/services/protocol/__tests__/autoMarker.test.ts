import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  detectProtocol,
  deriveMarker,
  gatherInputs,
  LEGACY_LINE_THRESHOLD,
  APP_VERSION,
  REVISION_UNKNOWN,
  type DetectInputs,
} from '../autoMarker'
import { writeProtocol } from '../protocolWriter'

let workdir: string

beforeEach(async () => {
  workdir = join(
    tmpdir(),
    `ccpit-automarker-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  await mkdir(workdir, { recursive: true })
})

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true })
})

function emptyInputs(): DetectInputs {
  return {
    hasClaudeMd: false,
    hasHooks: false,
    hasSkills: false,
    hasRules: false,
    hasSettings: false,
    claudeMdLines: 0,
  }
}

describe('autoMarker — receipt of FSA §3-7 acceptance criteria', () => {
  // Case 1: 既存マーカー保護（最重要）
  it('Case 1: existing marker is never overwritten', async () => {
    const existing = {
      protocol: 'manx',
      revision: 'r5',
      stage: 'stable' as const,
      stage_inferred: false,
      variant: null,
      variant_alias: null,
      applied_at: '2604291234',
      applied_by: 'ccpit-1.0.0',
      detection_evidence: null,
      detection_confidence: 'explicit' as const,
    }
    await writeProtocol(workdir, existing)
    const result = await detectProtocol(workdir)
    expect(result).toEqual(existing)
  })

  // Case 2: R1 完備
  it('Case 2 (R1): full MANX setup → confidence=high, protocol=manx', () => {
    const inputs: DetectInputs = {
      ...emptyInputs(),
      hasClaudeMd: true,
      hasHooks: true,
      hasSkills: true,
      hasRules: true,
      hasSettings: true,
      claudeMdLines: 50,
    }
    const result = deriveMarker(inputs)
    expect(result.protocol).toBe('manx')
    expect(result.detection_confidence).toBe('high')
  })

  // Case 3: R2 部分一致
  it('Case 3 (R2): CLAUDE.md + hooks only → confidence=low, protocol=manx', () => {
    const inputs: DetectInputs = {
      ...emptyInputs(),
      hasClaudeMd: true,
      hasHooks: true,
      claudeMdLines: 30,
    }
    const result = deriveMarker(inputs)
    expect(result.protocol).toBe('manx')
    expect(result.detection_confidence).toBe('low')
  })

  // Case 4 (R4): CLAUDE.md なし
  it('Case 4 (R4): no CLAUDE.md → confidence=unknown, protocol=unknown', () => {
    const result = deriveMarker(emptyInputs())
    expect(result.protocol).toBe('unknown')
    expect(result.detection_confidence).toBe('unknown')
  })

  // Case 5: applied_at が必ず null
  it('Case 5: applied_at is always null on auto-marking', () => {
    const variants: DetectInputs[] = [
      emptyInputs(),
      { ...emptyInputs(), hasClaudeMd: true, claudeMdLines: 20 },
      {
        ...emptyInputs(),
        hasClaudeMd: true,
        hasHooks: true,
        hasSkills: true,
        hasRules: true,
        hasSettings: true,
        claudeMdLines: 50,
      },
    ]
    for (const v of variants) {
      expect(deriveMarker(v).applied_at).toBeNull()
    }
  })

  // Case 6: detection_evidence に判定根拠が含まれる
  it('Case 6: detection_evidence contains rule inputs', () => {
    const inputs: DetectInputs = {
      ...emptyInputs(),
      hasClaudeMd: true,
      hasHooks: true,
      claudeMdLines: 42,
    }
    const result = deriveMarker(inputs)
    expect(result.detection_evidence).toContain('CLAUDE.md=true')
    expect(result.detection_evidence).toContain('42行')
    expect(result.detection_evidence).toContain('hooks=true')
  })

  // Case 7: applied_by が APP_VERSION
  it('Case 7: applied_by is APP_VERSION', () => {
    const result = deriveMarker(emptyInputs())
    expect(result.applied_by).toBe(APP_VERSION)
  })

  // Case 8 ★r2: stage_inferred は自動マーキング時必ず true
  it('Case 8 (r2): stage_inferred is always true on auto-marking', () => {
    const variants: DetectInputs[] = [
      emptyInputs(),
      { ...emptyInputs(), hasClaudeMd: true, claudeMdLines: 250 },
      { ...emptyInputs(), hasClaudeMd: true, hasHooks: true, claudeMdLines: 30 },
      {
        ...emptyInputs(),
        hasClaudeMd: true,
        hasHooks: true,
        hasSkills: true,
        hasRules: true,
        hasSettings: true,
        claudeMdLines: 50,
      },
    ]
    for (const v of variants) {
      expect(deriveMarker(v).stage_inferred).toBe(true)
    }
  })

  // Case 9 ★r2: R3a Legacy 判定（CLAUDE.md 250 行 + hooks/skills なし）
  it('Case 9 (R3a): CLAUDE.md 250 lines, no hooks/skills → protocol=legacy, confidence=high', () => {
    const inputs: DetectInputs = {
      ...emptyInputs(),
      hasClaudeMd: true,
      claudeMdLines: 250,
    }
    const result = deriveMarker(inputs)
    expect(result.protocol).toBe('legacy')
    expect(result.detection_confidence).toBe('high')
  })

  // Case 10 ★r2: R3b 不明判定（CLAUDE.md 100 行 + hooks/skills なし）
  it('Case 10 (R3b): CLAUDE.md 100 lines, no hooks/skills → protocol=unknown, confidence=low', () => {
    const inputs: DetectInputs = {
      ...emptyInputs(),
      hasClaudeMd: true,
      claudeMdLines: 100,
    }
    const result = deriveMarker(inputs)
    expect(result.protocol).toBe('unknown')
    expect(result.detection_confidence).toBe('low')
  })
})

describe('autoMarker — boundary tests around LEGACY_LINE_THRESHOLD', () => {
  it('199 lines → R3b (unknown)', () => {
    const result = deriveMarker({
      ...emptyInputs(),
      hasClaudeMd: true,
      claudeMdLines: LEGACY_LINE_THRESHOLD - 1,
    })
    expect(result.protocol).toBe('unknown')
  })

  it('200 lines (exact boundary) → R3b (not legacy, condition is > 200)', () => {
    const result = deriveMarker({
      ...emptyInputs(),
      hasClaudeMd: true,
      claudeMdLines: LEGACY_LINE_THRESHOLD,
    })
    expect(result.protocol).toBe('unknown')
  })

  it('201 lines → R3a (legacy)', () => {
    const result = deriveMarker({
      ...emptyInputs(),
      hasClaudeMd: true,
      claudeMdLines: LEGACY_LINE_THRESHOLD + 1,
    })
    expect(result.protocol).toBe('legacy')
  })
})

describe('autoMarker — gatherInputs (filesystem)', () => {
  it('detects CLAUDE.md presence and counts lines', async () => {
    const claudeMd = ['# Title', 'line2', 'line3'].join('\n')
    await writeFile(join(workdir, 'CLAUDE.md'), claudeMd, 'utf-8')
    const inputs = await gatherInputs(workdir)
    expect(inputs.hasClaudeMd).toBe(true)
    expect(inputs.claudeMdLines).toBe(3)
  })

  it('returns 0 lines and false flags for empty project', async () => {
    const inputs = await gatherInputs(workdir)
    expect(inputs.hasClaudeMd).toBe(false)
    expect(inputs.claudeMdLines).toBe(0)
    expect(inputs.hasHooks).toBe(false)
  })

  it('detects subdirectories', async () => {
    await mkdir(join(workdir, 'hooks'), { recursive: true })
    await mkdir(join(workdir, 'skills'), { recursive: true })
    const inputs = await gatherInputs(workdir)
    expect(inputs.hasHooks).toBe(true)
    expect(inputs.hasSkills).toBe(true)
  })
})

describe('autoMarker — derived marker shape', () => {
  it('revision is REVISION_UNKNOWN string', () => {
    const result = deriveMarker(emptyInputs())
    expect(result.revision).toBe(REVISION_UNKNOWN)
  })

  it('stage is experimental (safe default)', () => {
    const result = deriveMarker(emptyInputs())
    expect(result.stage).toBe('experimental')
  })

  it('variant and variant_alias are null', () => {
    const result = deriveMarker(emptyInputs())
    expect(result.variant).toBeNull()
    expect(result.variant_alias).toBeNull()
  })
})
