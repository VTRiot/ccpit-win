import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  detectProtocol,
  deriveMarker,
  gatherInputs,
  buildExplicitMarker,
  formatAppliedAt,
  LEGACY_LINE_THRESHOLD,
  APP_VERSION,
  REVISION_UNKNOWN,
  type DetectInputs,
} from '../autoMarker'
import { writeProtocol } from '../protocolWriter'
import { readProtocol } from '../protocolReader'

let workdir: string
let emptyGlobal: string

beforeEach(async () => {
  workdir = join(
    tmpdir(),
    `ccpit-automarker-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  await mkdir(workdir, { recursive: true })
  // 既存ホームディレクトリを巻き込まないよう、空のグローバル擬似ディレクトリを作成
  emptyGlobal = join(workdir, '__empty_global__')
  await mkdir(emptyGlobal, { recursive: true })
})

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true })
})

function emptyInputs(): DetectInputs {
  return {
    hasClaudeMd: false,
    claudeMdLines: 0,
    hasHooksLocal: false,
    hasSkillsLocal: false,
    hasRulesLocal: false,
    hasHooksDotClaudeLocal: false,
    hasSkillsDotClaudeLocal: false,
    hasRulesDotClaudeLocal: false,
    hasSettingsDotClaudeLocal: false,
    hasHooksGlobal: false,
    hasSkillsGlobal: false,
    hasRulesGlobal: false,
    mergedHasHooks: false,
    mergedHasSkills: false,
    mergedHasRules: false,
    mergedHasSettings: false,
  }
}

/**
 * テストヘルパ: フラグから merged を再計算する。
 * `mergedHas*` を手で書き忘れないようにするためのもの。
 *
 * FSA r4: グローバル `~/.claude/` は judgment 材料外。merged の OR には含めない。
 */
function withMerged(partial: Partial<DetectInputs>): DetectInputs {
  const base = { ...emptyInputs(), ...partial }
  return {
    ...base,
    mergedHasHooks: base.hasHooksLocal || base.hasHooksDotClaudeLocal,
    mergedHasSkills: base.hasSkillsLocal || base.hasSkillsDotClaudeLocal,
    mergedHasRules: base.hasRulesLocal || base.hasRulesDotClaudeLocal,
    mergedHasSettings: base.hasSettingsDotClaudeLocal,
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
    const result = await detectProtocol(workdir, { globalClaudeDir: emptyGlobal })
    expect(result).toEqual(existing)
  })

  // Case 2: R1 完備
  it('Case 2 (R1): full MANX setup → confidence=high, protocol=manx', () => {
    const inputs = withMerged({
      hasClaudeMd: true,
      hasHooksLocal: true,
      hasSkillsLocal: true,
      hasRulesLocal: true,
      hasSettingsDotClaudeLocal: true,
      claudeMdLines: 50,
    })
    const result = deriveMarker(inputs)
    expect(result.protocol).toBe('manx')
    expect(result.detection_confidence).toBe('high')
  })

  // Case 3: R2 部分一致
  it('Case 3 (R2): CLAUDE.md + hooks only → confidence=low, protocol=manx', () => {
    const inputs = withMerged({
      hasClaudeMd: true,
      hasHooksLocal: true,
      claudeMdLines: 30,
    })
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
      withMerged({ hasClaudeMd: true, claudeMdLines: 20 }),
      withMerged({
        hasClaudeMd: true,
        hasHooksLocal: true,
        hasSkillsLocal: true,
        hasRulesLocal: true,
        hasSettingsDotClaudeLocal: true,
        claudeMdLines: 50,
      }),
    ]
    for (const v of variants) {
      expect(deriveMarker(v).applied_at).toBeNull()
    }
  })

  // Case 6: detection_evidence に判定根拠が含まれる
  it('Case 6: detection_evidence contains rule inputs', () => {
    const inputs = withMerged({
      hasClaudeMd: true,
      hasHooksLocal: true,
      claudeMdLines: 42,
    })
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
      withMerged({ hasClaudeMd: true, claudeMdLines: 250 }),
      withMerged({ hasClaudeMd: true, hasHooksLocal: true, claudeMdLines: 30 }),
      withMerged({
        hasClaudeMd: true,
        hasHooksLocal: true,
        hasSkillsLocal: true,
        hasRulesLocal: true,
        hasSettingsDotClaudeLocal: true,
        claudeMdLines: 50,
      }),
    ]
    for (const v of variants) {
      expect(deriveMarker(v).stage_inferred).toBe(true)
    }
  })

  // Case 9 ★r2: R3a Legacy 判定（CLAUDE.md 250 行 + hooks/skills なし）
  it('Case 9 (R3a): CLAUDE.md 250 lines, no hooks/skills → protocol=legacy, confidence=high', () => {
    const inputs = withMerged({
      hasClaudeMd: true,
      claudeMdLines: 250,
    })
    const result = deriveMarker(inputs)
    expect(result.protocol).toBe('legacy')
    expect(result.detection_confidence).toBe('high')
  })

  // Case 10 ★r2: R3b 不明判定（CLAUDE.md 100 行 + hooks/skills なし）
  it('Case 10 (R3b): CLAUDE.md 100 lines, no hooks/skills → protocol=unknown, confidence=low', () => {
    const inputs = withMerged({
      hasClaudeMd: true,
      claudeMdLines: 100,
    })
    const result = deriveMarker(inputs)
    expect(result.protocol).toBe('unknown')
    expect(result.detection_confidence).toBe('low')
  })
})

describe('autoMarker — boundary tests around LEGACY_LINE_THRESHOLD', () => {
  it('199 lines → R3b (unknown)', () => {
    const result = deriveMarker(
      withMerged({ hasClaudeMd: true, claudeMdLines: LEGACY_LINE_THRESHOLD - 1 })
    )
    expect(result.protocol).toBe('unknown')
  })

  it('200 lines (exact boundary) → R3b (not legacy, condition is > 200)', () => {
    const result = deriveMarker(
      withMerged({ hasClaudeMd: true, claudeMdLines: LEGACY_LINE_THRESHOLD })
    )
    expect(result.protocol).toBe('unknown')
  })

  it('201 lines → R3a (legacy)', () => {
    const result = deriveMarker(
      withMerged({ hasClaudeMd: true, claudeMdLines: LEGACY_LINE_THRESHOLD + 1 })
    )
    expect(result.protocol).toBe('legacy')
  })
})

describe('autoMarker — gatherInputs (filesystem)', () => {
  it('detects CLAUDE.md presence and counts lines', async () => {
    const claudeMd = ['# Title', 'line2', 'line3'].join('\n')
    await writeFile(join(workdir, 'CLAUDE.md'), claudeMd, 'utf-8')
    const inputs = await gatherInputs(workdir, { globalClaudeDir: emptyGlobal })
    expect(inputs.hasClaudeMd).toBe(true)
    expect(inputs.claudeMdLines).toBe(3)
  })

  it('returns 0 lines and false flags for empty project', async () => {
    const inputs = await gatherInputs(workdir, { globalClaudeDir: emptyGlobal })
    expect(inputs.hasClaudeMd).toBe(false)
    expect(inputs.claudeMdLines).toBe(0)
    expect(inputs.hasHooksLocal).toBe(false)
  })

  it('detects local subdirectories', async () => {
    await mkdir(join(workdir, 'hooks'), { recursive: true })
    await mkdir(join(workdir, 'skills'), { recursive: true })
    const inputs = await gatherInputs(workdir, { globalClaudeDir: emptyGlobal })
    expect(inputs.hasHooksLocal).toBe(true)
    expect(inputs.hasSkillsLocal).toBe(true)
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

// ────────────────────────────────────────────────────────────────────
// FSA r4 §2-7 — 2 ソース統合スキャン（グローバル除外）追加ケース
// r3 で global を judgment 材料に含めていた Case 20/21/23/24 は r4 仕様に更新済み
// ────────────────────────────────────────────────────────────────────

describe('autoMarker — FSA r4 §2-7 (2-source merged scan, global excluded)', () => {
  // Case 20 (r4 更新): グローバルのみ MANX 構成 + PJ 内 .claude/settings → r4 では judgment に使われない
  // CCDG2 検体パターンと等価。r3 では manx/high だったが r4 では unknown/low。
  it('Case 20 (r4 spec change): global hooks/skills/rules + local .claude/settings → unknown, low (NOT manx)', () => {
    const inputs = withMerged({
      hasClaudeMd: true,
      claudeMdLines: 44,
      hasHooksGlobal: true,
      hasSkillsGlobal: true,
      hasRulesGlobal: true,
      hasSettingsDotClaudeLocal: true,
    })
    expect(inputs.mergedHasHooks).toBe(false)
    expect(inputs.mergedHasSkills).toBe(false)
    expect(inputs.mergedHasRules).toBe(false)
    const result = deriveMarker(inputs)
    expect(result.protocol).toBe('unknown')
    expect(result.detection_confidence).toBe('low')
  })

  // Case 21 (r4 更新): グローバル hooks のみ + CLAUDE.md → r4 では judgment に使われない → R3b
  it('Case 21 (r4 spec change): global hooks only + CLAUDE.md → unknown, low (NOT manx)', () => {
    const inputs = withMerged({
      hasClaudeMd: true,
      claudeMdLines: 30,
      hasHooksGlobal: true,
    })
    expect(inputs.mergedHasHooks).toBe(false)
    const result = deriveMarker(inputs)
    expect(result.protocol).toBe('unknown')
    expect(result.detection_confidence).toBe('low')
  })

  // Case 22: PJ 内 .claude/ 由来判定 R1（不変、グローバル除外の影響を受けない）
  it('Case 22 (R1 from PJ .claude/): hooks/skills/rules under .claude/ + settings + CLAUDE.md → manx, high', () => {
    const inputs = withMerged({
      hasClaudeMd: true,
      claudeMdLines: 60,
      hasHooksDotClaudeLocal: true,
      hasSkillsDotClaudeLocal: true,
      hasRulesDotClaudeLocal: true,
      hasSettingsDotClaudeLocal: true,
    })
    const result = deriveMarker(inputs)
    expect(result.protocol).toBe('manx')
    expect(result.detection_confidence).toBe('high')
  })

  // Case 23 (r4 更新): evidence 4 セクション記録 + global 注記 + merged が global 除外であること
  it('Case 23 (r4): evidence records 4 sections with global "informational only" note and merged "excludes global"', () => {
    const inputs = withMerged({
      hasClaudeMd: true,
      claudeMdLines: 425,
      hasHooksGlobal: true,
      hasSkillsGlobal: true,
      hasRulesGlobal: true,
      hasSettingsDotClaudeLocal: true,
    })
    const result = deriveMarker(inputs)
    const ev = result.detection_evidence ?? ''
    expect(ev).toContain('local: CLAUDE.md=true(425行)')
    expect(ev).toContain('local.claude:')
    expect(ev).toContain('global.claude (informational only, not used for judgment):')
    expect(ev).toContain('merged (excludes global): hooks=false, skills=false, rules=false, settings.json=true')
  })

  // Case 24 (r4 更新): グローバル hooks/skills/rules は judgment 材料外
  it('Case 24 (r4 spec change): global hooks/skills/rules are NOT counted (merged excludes global)', () => {
    const inputs = withMerged({
      hasClaudeMd: true,
      claudeMdLines: 50,
      hasHooksGlobal: true,
      hasSkillsGlobal: true,
      hasRulesGlobal: true,
      hasSettingsDotClaudeLocal: false,
    })
    expect(inputs.mergedHasHooks).toBe(false)
    expect(inputs.mergedHasSkills).toBe(false)
    expect(inputs.mergedHasRules).toBe(false)
    expect(inputs.mergedHasSettings).toBe(false)
    const result = deriveMarker(inputs)
    expect(result.protocol).toBe('unknown')
    expect(result.detection_confidence).toBe('low')
  })

  // Case 28: CanAna 検体（CLAUDE.md のみ + グローバル MANX 構成）→ R3b
  it('Case 28 (CanAna specimen): CLAUDE.md only + global MANX setup → R3b unknown, low', () => {
    const inputs = withMerged({
      hasClaudeMd: true,
      claudeMdLines: 80,
      hasHooksGlobal: true,
      hasSkillsGlobal: true,
      hasRulesGlobal: true,
    })
    expect(inputs.mergedHasHooks).toBe(false)
    expect(inputs.mergedHasSkills).toBe(false)
    expect(inputs.mergedHasRules).toBe(false)
    const result = deriveMarker(inputs)
    expect(result.protocol).toBe('unknown')
    expect(result.detection_confidence).toBe('low')
  })

  // Case 29: グローバル除外検証（hasHooksGlobal=true 単独 → mergedHasHooks=false）
  it('Case 29 (global exclusion): hasHooksGlobal=true alone → mergedHasHooks=false', () => {
    const inputs = withMerged({ hasHooksGlobal: true })
    expect(inputs.hasHooksGlobal).toBe(true)
    expect(inputs.mergedHasHooks).toBe(false)
  })

  // Case 30: detection_evidence の global セクションに informational 注記が含まれる
  it('Case 30: evidence global section contains "informational only, not used for judgment"', () => {
    const inputs = withMerged({
      hasHooksGlobal: true,
      hasSkillsGlobal: true,
      hasRulesGlobal: true,
    })
    const result = deriveMarker(inputs)
    const ev = result.detection_evidence ?? ''
    expect(ev).toContain('informational only, not used for judgment')
    expect(ev).toContain('merged (excludes global)')
  })
})

// ────────────────────────────────────────────────────────────────────
// CCDG2 検体: 実機パスを直接指定する単体テスト
// FSA r3 §2-3 末尾 / 指示書 §5 Step 1-6 (b) — 改修後アルゴリズムで R1 達成を確認
// ────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────
// FSA r3 §3-8 — Edit Marker / Re-scan Marker（Case 25-27）
// ────────────────────────────────────────────────────────────────────

describe('autoMarker — FSA r3 §3-8 (Edit Marker / Re-scan Marker)', () => {
  // Case 25: Edit Marker 保存後の値検証
  it('Case 25: Edit Marker payload has stage_inferred=false, confidence=explicit, evidence=null', async () => {
    const marker = buildExplicitMarker(
      {
        protocol: 'manx',
        revision: 'r5',
        stage: 'stable',
        variant: null,
        variant_alias: null,
      },
      new Date('2026-04-30T06:43:00')
    )
    expect(marker.stage_inferred).toBe(false)
    expect(marker.detection_confidence).toBe('explicit')
    expect(marker.detection_evidence).toBeNull()
    expect(marker.applied_by).toBe(APP_VERSION)

    // 書き込み→読み込みで永続化された値も同一であること
    await writeProtocol(workdir, marker, { force: true })
    const reread = await readProtocol(workdir)
    expect(reread).toEqual(marker)
  })

  // Case 26: applied_at が YYMMDDHHMM 形式で記録される
  it('Case 26: applied_at is YYMMDDHHMM (10 digits) for the given Date', () => {
    const fixed = new Date('2026-04-30T06:43:00')
    expect(formatAppliedAt(fixed)).toBe('2604300643')

    const marker = buildExplicitMarker(
      { protocol: 'manx', revision: 'r5', stage: 'stable', variant: null, variant_alias: null },
      fixed
    )
    expect(marker.applied_at).toMatch(/^\d{10}$/)
    expect(marker.applied_at).toBe('2604300643')
  })

  // Case 27: Re-scan Marker (force:true) で既存マーカー上書き
  it('Case 27: detectProtocol(force:true) bypasses existing marker', async () => {
    const existing = {
      protocol: 'legacy' as const,
      revision: '?',
      stage: 'experimental' as const,
      stage_inferred: true,
      variant: null,
      variant_alias: null,
      applied_at: null,
      applied_by: 'ccpit-1.0.0',
      detection_evidence: 'old-evidence',
      detection_confidence: 'high' as const,
    }
    await writeProtocol(workdir, existing)
    // CLAUDE.md を置く（短い行数で R3b 該当）
    await writeFile(join(workdir, 'CLAUDE.md'), '# short', 'utf-8')

    // force なし → 既存マーカーを返す
    const guarded = await detectProtocol(workdir, { globalClaudeDir: emptyGlobal })
    expect(guarded.protocol).toBe('legacy')
    expect(guarded.detection_evidence).toBe('old-evidence')

    // force:true → 既存マーカー無視で再判定（CLAUDE.md 1 行 + その他なし → R3b unknown）
    const rescanned = await detectProtocol(workdir, {
      force: true,
      globalClaudeDir: emptyGlobal,
    })
    expect(rescanned.protocol).toBe('unknown')
    expect(rescanned.detection_confidence).toBe('low')
    expect(rescanned.detection_evidence).toContain('local: CLAUDE.md=true')
  })
})

describe('autoMarker — CCDG2 specimen verification', () => {
  it('Case 20-CCDG2 (r4 spec change): real CCDG2 repo → unknown, low (PJ has no MANX setup; global is informational only)', async () => {
    // 注意: 本ケースは検証マシンの実態に依存する E2E 的テスト。
    // FSA r4: CCDG2 は PJ 直下にも .claude/ にも hooks/skills/rules を持たない。
    //   グローバル ~/.claude/ に MANX 構成があっても judgment 材料外なので unknown/low が正解。
    const ccdg2 = 'C:\\_Prog\\_WinSoftDev\\CCDG2'
    const { stat } = await import('fs/promises')
    let exists = false
    try {
      const s = await stat(ccdg2)
      exists = s.isDirectory()
    } catch {
      exists = false
    }
    if (!exists) return

    const inputs = await gatherInputs(ccdg2)
    expect(inputs.hasClaudeMd).toBe(true)
    expect(inputs.hasSettingsDotClaudeLocal).toBe(true) // .claude/settings.local.json
    // グローバルには MANX 構成あり（情報として記録される）
    expect(inputs.hasHooksGlobal).toBe(true)
    expect(inputs.hasSkillsGlobal).toBe(true)
    expect(inputs.hasRulesGlobal).toBe(true)
    // しかし merged は PJ 直下 + .claude/ のみ → false（グローバル除外）
    expect(inputs.mergedHasHooks).toBe(false)
    expect(inputs.mergedHasSkills).toBe(false)
    expect(inputs.mergedHasRules).toBe(false)
    expect(inputs.mergedHasSettings).toBe(true) // settings.local.json があるので true

    const marker = deriveMarker(inputs)
    // R3b: CLAUDE.md ≤ 200 行 + no merged hooks/skills → unknown, low
    expect(marker.protocol).toBe('unknown')
    expect(marker.detection_confidence).toBe('low')
  })
})
