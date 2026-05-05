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
  isGlobalManxInherited,
  isCCDGV1Hardlink,
  parseManxFrontmatter,
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
    claudeMdNlink: 1, // FSA r7: 通常ファイル (nlink=1)
    manxFrontmatter: null, // FSA r7: YAML 自己宣言なし
  }
}

/**
 * テストヘルパ: フラグから merged を再計算する。
 * `mergedHas*` を手で書き忘れないようにするためのもの。
 *
 * FSA r5: グローバル `~/.claude/` は merged 計算に含めない (R1/R2/R3a/R3b の挙動は不変)。
 *   ただし R5 (グローバル MANX 継承判定) では参照される。本ヘルパは merged のみ扱う。
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
// FSA r5 §2-5/§2-7 — 2 ソース統合スキャン (グローバル merged 除外) + R5 グローバル MANX 継承判定
// r4 で「judgment 材料外」とされた global hooks/skills/rules は r5 で R5 のみ参照する
// 既存 Case 20/21/23/24/28/30 + CCDG2 specimen は r5 仕様に更新済み
// ────────────────────────────────────────────────────────────────────

describe('autoMarker — FSA r5 §2-5/§2-7 (2-source merged scan + R5 global manx-inheritance)', () => {
  // Case 20 (r7 再更新): R5 撤廃により global MANX 完備でも R3b にフォールバック。
  // CCDG2 検体パターン: 44 行 CLAUDE.md + .claude/settings + global MANX、YAML 自己宣言なし (実装時点)。
  // r5/r6 では manx/low → r7 では unknown/low。CCDG2 を MANX-Host として扱うには YAML 追加が必要。
  it('Case 20 (r7 spec change): global MANX + local settings + no YAML → R3b unknown, low', () => {
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

  // Case 21 (r5 不変): グローバル hooks のみ (skills/rules 欠) → R5 不発火 → R3b unknown/low
  it('Case 21 (r5): global hooks only + CLAUDE.md → R5 NOT fires (incomplete) → unknown, low', () => {
    const inputs = withMerged({
      hasClaudeMd: true,
      claudeMdLines: 30,
      hasHooksGlobal: true,
    })
    expect(inputs.mergedHasHooks).toBe(false)
    expect(isGlobalManxInherited(inputs)).toBe(false)
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

  // Case 23 (r7 再更新): evidence 5 セクション (local/local.claude/global/merged/manx_yaml) + R5 retired 注記 + nlink
  it('Case 23 (r7): evidence has "R5 retired in r7", nlink + manx_yaml sections', () => {
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
    expect(ev).toContain('local: CLAUDE.md=true(425行')
    expect(ev).toContain('nlink=1')
    expect(ev).toContain('local.claude:')
    expect(ev).toContain('global.claude (informational only, R5 retired in r7):')
    expect(ev).toContain('merged (excludes global): hooks=false, skills=false, rules=false, settings.json=true')
    expect(ev).toContain('manx_yaml: (none)')
  })

  // Case 24 (r7 再更新): R5 撤廃により global MANX 完備でも R3b にフォールバック (50 行)
  it('Case 24 (r7 spec change): global MANX + 50 lines + no YAML → R3b unknown, low', () => {
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
    // isGlobalManxInherited は @deprecated として動作維持 (互換性)
    expect(isGlobalManxInherited(inputs)).toBe(true)
    const result = deriveMarker(inputs)
    expect(result.protocol).toBe('unknown')
    expect(result.detection_confidence).toBe('low')
  })

  // Case 28 (r7 再更新, CanAna specimen): R5 撤廃により global MANX のみで MANX 化しない (R3b)
  // CanAna は最古二層 AI PJ、らいおが Edit Marker UI で 'legacy' 手動設定する運用
  it('Case 28 (r7 spec change, CanAna specimen): CLAUDE.md + global MANX → R3b unknown, low', () => {
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

  // Case 30 (r7 再更新): detection_evidence の global セクションに R5 retired 注記
  it('Case 30 (r7): evidence global section contains "informational only, R5 retired in r7"', () => {
    const inputs = withMerged({
      hasHooksGlobal: true,
      hasSkillsGlobal: true,
      hasRulesGlobal: true,
    })
    const result = deriveMarker(inputs)
    const ev = result.detection_evidence ?? ''
    expect(ev).toContain('informational only, R5 retired in r7')
    expect(ev).toContain('merged (excludes global)')
  })
})

// ────────────────────────────────────────────────────────────────────
// FSA r7 §3-5 — R5 撤廃 + R0a (ハードリンク) + R6/R7 (YAML 自己宣言) 新規
// Case 31〜38 を r7 仕様に更新 (旧 R5 → R3a/R3b にフォールバック、YAML 経路を追加)
// Case 39〜50 を新規追加 (R0a/R6/R7/R3a 強化の網羅)
// ────────────────────────────────────────────────────────────────────

describe('autoMarker — FSA r7 §3 R0a (CCDG-V1 hardlink detection)', () => {
  // Case 31 (旧 R5 基本完備 → r7 では R3a で legacy/high): CLAUDE.md 60行 + global MANX のみ
  // → 旧 R5 で manx/low → r7 撤廃により R3b にフォールバック (CLAUDE.md ≤200 行 + ローカル MANX なし)
  it('Case 31 (r7 R5 retired): CLAUDE.md 60 + global MANX only → R3b unknown, low', () => {
    const inputs = withMerged({
      hasClaudeMd: true,
      claudeMdLines: 60,
      hasHooksGlobal: true,
      hasSkillsGlobal: true,
      hasRulesGlobal: true,
    })
    // R5 deprecated 関数は維持 (互換性)
    expect(isGlobalManxInherited(inputs)).toBe(true)
    const result = deriveMarker(inputs)
    expect(result.protocol).toBe('unknown')
    expect(result.detection_confidence).toBe('low')
  })

  // Case 32 (旧 R5 短い CLAUDE.md → r7 R3b): 10行 + global MANX → unknown, low
  it('Case 32 (r7 R5 retired): CLAUDE.md 10 + global MANX → R3b unknown, low', () => {
    const inputs = withMerged({
      hasClaudeMd: true,
      claudeMdLines: 10,
      hasHooksGlobal: true,
      hasSkillsGlobal: true,
      hasRulesGlobal: true,
    })
    const result = deriveMarker(inputs)
    expect(result.protocol).toBe('unknown')
    expect(result.detection_confidence).toBe('low')
  })

  // Case 33 (旧 R5 長い CLAUDE.md → r7 R3a Legacy): 500行 + global MANX → legacy, high
  it('Case 33 (r7 R5 retired, R3a fires): CLAUDE.md 500 + global MANX → R3a legacy, high', () => {
    const inputs = withMerged({
      hasClaudeMd: true,
      claudeMdLines: 500,
      hasHooksGlobal: true,
      hasSkillsGlobal: true,
      hasRulesGlobal: true,
    })
    const result = deriveMarker(inputs)
    expect(result.protocol).toBe('legacy')
    expect(result.detection_confidence).toBe('high')
  })

  // Case 34-36 (R5 boundary 旧仕様): r7 でも R3b にフォールバックで unknown/low (挙動不変)
  it('Case 34 (r7): CLAUDE.md + global skills/rules only → R3b unknown, low', () => {
    const inputs = withMerged({
      hasClaudeMd: true,
      claudeMdLines: 30,
      hasSkillsGlobal: true,
      hasRulesGlobal: true,
    })
    const result = deriveMarker(inputs)
    expect(result.protocol).toBe('unknown')
    expect(result.detection_confidence).toBe('low')
  })

  it('Case 35 (r7): CLAUDE.md + global hooks/rules only → R3b unknown, low', () => {
    const inputs = withMerged({
      hasClaudeMd: true,
      claudeMdLines: 30,
      hasHooksGlobal: true,
      hasRulesGlobal: true,
    })
    const result = deriveMarker(inputs)
    expect(result.protocol).toBe('unknown')
    expect(result.detection_confidence).toBe('low')
  })

  it('Case 36 (r7): CLAUDE.md + global hooks/skills only → R3b unknown, low', () => {
    const inputs = withMerged({
      hasClaudeMd: true,
      claudeMdLines: 30,
      hasHooksGlobal: true,
      hasSkillsGlobal: true,
    })
    const result = deriveMarker(inputs)
    expect(result.protocol).toBe('unknown')
    expect(result.detection_confidence).toBe('low')
  })

  // Case 37 (優先順位 R1 > R0a でない場合): ローカル MANX 完備 + global MANX → R1 manx/high (不変)
  it('Case 37 (priority R1 fires when no hardlink): full local MANX + global MANX → R1 manx, high', () => {
    const inputs = withMerged({
      hasClaudeMd: true,
      claudeMdLines: 60,
      hasHooksLocal: true,
      hasSkillsLocal: true,
      hasRulesLocal: true,
      hasSettingsDotClaudeLocal: true,
      hasHooksGlobal: true,
      hasSkillsGlobal: true,
      hasRulesGlobal: true,
    })
    const result = deriveMarker(inputs)
    expect(result.protocol).toBe('manx')
    expect(result.detection_confidence).toBe('high')
  })

  // Case 38 (R4 維持): CLAUDE.md なし → unknown, unknown
  it('Case 38 (r7 R4): no CLAUDE.md → unknown, unknown', () => {
    const inputs = withMerged({
      hasHooksGlobal: true,
      hasSkillsGlobal: true,
      hasRulesGlobal: true,
    })
    const result = deriveMarker(inputs)
    expect(result.protocol).toBe('unknown')
    expect(result.detection_confidence).toBe('unknown')
  })

  // ========== r7 NEW: R0a CCDG-V1 ハードリンク検出 ==========

  // Case 39 (R0a 基本): nlink=13 + CLAUDE.md 632 行 → legacy/high
  it('Case 39 (R0a): nlink=13 + CLAUDE.md 632 lines → legacy, high (CCDG-V1 detected)', () => {
    const inputs = withMerged({
      hasClaudeMd: true,
      claudeMdLines: 632,
      claudeMdNlink: 13,
    })
    expect(isCCDGV1Hardlink(inputs.claudeMdNlink)).toBe(true)
    const result = deriveMarker(inputs)
    expect(result.protocol).toBe('legacy')
    expect(result.detection_confidence).toBe('high')
  })

  // Case 40 (R0a 短い): nlink=13 + CLAUDE.md 50 行 → legacy/high (nlink>1 のみで発火)
  it('Case 40 (R0a short CLAUDE.md): nlink=13 + 50 lines → legacy, high', () => {
    const inputs = withMerged({
      hasClaudeMd: true,
      claudeMdLines: 50,
      claudeMdNlink: 13,
    })
    const result = deriveMarker(inputs)
    expect(result.protocol).toBe('legacy')
    expect(result.detection_confidence).toBe('high')
  })

  // Case 41 (R0a > R1 優先): nlink=13 + ローカル MANX 完備 → R0a が R1 より優先 → legacy
  // ハードリンク検出は他の何にも勝る (Self-host を装っても物理構造で本物が分かる)
  it('Case 41 (priority R0a > R1): nlink=13 + R1 complete → legacy/high (R0a wins)', () => {
    const inputs = withMerged({
      hasClaudeMd: true,
      claudeMdLines: 60,
      claudeMdNlink: 13,
      hasHooksLocal: true,
      hasSkillsLocal: true,
      hasRulesLocal: true,
      hasSettingsDotClaudeLocal: true,
    })
    const result = deriveMarker(inputs)
    expect(result.protocol).toBe('legacy')
    expect(result.detection_confidence).toBe('high')
  })

  // Case 42 (R0a 不発火境界): nlink=1 (通常ファイル) → R0a スキップ
  it('Case 42 (R0a boundary): nlink=1 + CLAUDE.md 632 → R3a (not R0a)', () => {
    const inputs = withMerged({
      hasClaudeMd: true,
      claudeMdLines: 632,
      claudeMdNlink: 1,
    })
    expect(isCCDGV1Hardlink(inputs.claudeMdNlink)).toBe(false)
    const result = deriveMarker(inputs)
    expect(result.protocol).toBe('legacy') // R3a fires (lines > 200)
    expect(result.detection_confidence).toBe('high')
  })
})

// ========== r7 NEW: R6 / R7 YAML 自己宣言 ==========

describe('autoMarker — FSA r7 §5 R6/R7 (YAML self-declaration)', () => {
  // Case 43 (R6 default managed): YAML manx_version=r8, role 省略 → manx, low (default managed)
  it('Case 43 (R6 default): YAML manx_version=r8 only → manx, low (managed default)', () => {
    const inputs = withMerged({
      hasClaudeMd: true,
      claudeMdLines: 15,
      manxFrontmatter: { manxVersion: 'r8', manxRole: 'managed' },
    })
    const result = deriveMarker(inputs)
    expect(result.protocol).toBe('manx')
    expect(result.detection_confidence).toBe('low')
  })

  // Case 44 (R7 host): YAML manx_role=host → manx-host, low
  it('Case 44 (R7): YAML manx_role=host → manx-host, low', () => {
    const inputs = withMerged({
      hasClaudeMd: true,
      claudeMdLines: 44,
      manxFrontmatter: { manxVersion: 'r8', manxRole: 'host' },
    })
    const result = deriveMarker(inputs)
    expect(result.protocol).toBe('manx-host')
    expect(result.detection_confidence).toBe('low')
  })

  // Case 45 (R6 vs R3a 優先): YAML + 行数 500 → R6 が R3a より優先 (manx, low)
  it('Case 45 (priority R6 > R3a): YAML manx_role=managed + 500 lines → manx, low', () => {
    const inputs = withMerged({
      hasClaudeMd: true,
      claudeMdLines: 500,
      manxFrontmatter: { manxVersion: 'r8', manxRole: 'managed' },
    })
    const result = deriveMarker(inputs)
    expect(result.protocol).toBe('manx')
    expect(result.detection_confidence).toBe('low')
  })

  // Case 46 (YAML 無効): manxFrontmatter=null → R3b へフォールバック
  it('Case 46 (YAML missing): no manxFrontmatter + 30 lines → R3b unknown, low', () => {
    const inputs = withMerged({
      hasClaudeMd: true,
      claudeMdLines: 30,
      manxFrontmatter: null,
    })
    const result = deriveMarker(inputs)
    expect(result.protocol).toBe('unknown')
    expect(result.detection_confidence).toBe('low')
  })

  // Case 47 (R7 local role): YAML manx_role=local + ローカル MANX なし → R6 経路で manx, low
  // (local 役割は今は manx 表示、将来別扱いの余地)
  it('Case 47 (R7 local role): YAML manx_role=local → manx, low (R6 fallback)', () => {
    const inputs = withMerged({
      hasClaudeMd: true,
      claudeMdLines: 50,
      manxFrontmatter: { manxVersion: 'r8', manxRole: 'local' },
    })
    const result = deriveMarker(inputs)
    expect(result.protocol).toBe('manx')
    expect(result.detection_confidence).toBe('low')
  })

  // Case 48 (R0a vs R7 優先): nlink=13 + YAML manx_role=host → R0a が R7 より優先 → legacy
  it('Case 48 (priority R0a > R7): nlink=13 + YAML manx_role=host → legacy, high (R0a wins)', () => {
    const inputs = withMerged({
      hasClaudeMd: true,
      claudeMdLines: 632,
      claudeMdNlink: 13,
      manxFrontmatter: { manxVersion: 'r8', manxRole: 'host' },
    })
    const result = deriveMarker(inputs)
    expect(result.protocol).toBe('legacy')
    expect(result.detection_confidence).toBe('high')
  })

  // Case 49 (R7 vs R6 優先): YAML manx_role=host → R7 (manx-host) が R6 (manx) より優先
  it('Case 49 (priority R7 > R6): YAML manx_role=host wins over default managed', () => {
    const inputs = withMerged({
      hasClaudeMd: true,
      claudeMdLines: 44,
      manxFrontmatter: { manxVersion: 'r8', manxRole: 'host' },
    })
    const result = deriveMarker(inputs)
    expect(result.protocol).toBe('manx-host')
  })

  // Case 50 (R3a 不変): nlink=1 + 632 行 + YAML なし → R3a legacy, high (CCDG-V1 でない巨大 CLAUDE.md)
  it('Case 50 (R3a unchanged): nlink=1 + 632 lines + no YAML → R3a legacy, high', () => {
    const inputs = withMerged({
      hasClaudeMd: true,
      claudeMdLines: 632,
      claudeMdNlink: 1,
      manxFrontmatter: null,
    })
    const result = deriveMarker(inputs)
    expect(result.protocol).toBe('legacy')
    expect(result.detection_confidence).toBe('high')
  })
})

// ========== r7 NEW: parseManxFrontmatter 単体テスト ==========

describe('autoMarker — parseManxFrontmatter (FSA r7 §5)', () => {
  it('parses valid frontmatter with version + role', async () => {
    const path = join(workdir, 'CLAUDE.md')
    await writeFile(path, '---\nmanx_version: r8\nmanx_role: host\n---\n\n# Title\n', 'utf-8')
    const result = await parseManxFrontmatter(path)
    expect(result).toEqual({ manxVersion: 'r8', manxRole: 'host' })
  })

  it('defaults manx_role to "managed" when omitted', async () => {
    const path = join(workdir, 'CLAUDE.md')
    await writeFile(path, '---\nmanx_version: r8\n---\n\n# Title\n', 'utf-8')
    const result = await parseManxFrontmatter(path)
    expect(result).toEqual({ manxVersion: 'r8', manxRole: 'managed' })
  })

  it('returns null when manx_version missing (required)', async () => {
    const path = join(workdir, 'CLAUDE.md')
    await writeFile(path, '---\nmanx_role: host\n---\n\n# Title\n', 'utf-8')
    const result = await parseManxFrontmatter(path)
    expect(result).toBeNull()
  })

  it('returns null when no frontmatter at all', async () => {
    const path = join(workdir, 'CLAUDE.md')
    await writeFile(path, '# Title\nmanx_version: r8\n', 'utf-8')
    const result = await parseManxFrontmatter(path)
    expect(result).toBeNull()
  })

  it('treats invalid manx_role as default "managed"', async () => {
    const path = join(workdir, 'CLAUDE.md')
    await writeFile(path, '---\nmanx_version: r8\nmanx_role: invalid_role\n---\n', 'utf-8')
    const result = await parseManxFrontmatter(path)
    expect(result).toEqual({ manxVersion: 'r8', manxRole: 'managed' })
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
  it('Case 20-CCDG2 (r7 spec change): real CCDG2 repo → R3b unknown/low (YAML pending; manx-host after らいお adds YAML)', async () => {
    // 注意: 本ケースは検証マシンの実態に依存する E2E 的テスト。
    // FSA r7: R5 撤廃により global MANX のみでは MANX 化しない。
    //   CCDG2 を MANX-Host として表示するには CLAUDE.md 冒頭に YAML 追加 (らいお手動):
    //     ---
    //     manx_version: r8
    //     manx_role: host
    //     ---
    //   YAML 追加後は R7 経由で manx-host/low になる。実装時点 (YAML 未追加) では R3b → unknown/low。
    //   nlink=1 (CCDG2 ルート CLAUDE.md は独立ファイル、CCDG-V1 ハードリンクではない) → R0a 不発火。
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
    // グローバルには MANX 構成あり (r7 では informational only)
    expect(inputs.hasHooksGlobal).toBe(true)
    expect(inputs.hasSkillsGlobal).toBe(true)
    expect(inputs.hasRulesGlobal).toBe(true)
    // merged は PJ 直下 + .claude/ のみ → false (R1/R2 不発火)
    expect(inputs.mergedHasHooks).toBe(false)
    expect(inputs.mergedHasSkills).toBe(false)
    expect(inputs.mergedHasRules).toBe(false)
    expect(inputs.mergedHasSettings).toBe(true) // settings.local.json があるので true
    // CCDG2 は独立ファイル (CCDG-V1 ハードリンクではない)
    expect(inputs.claudeMdNlink).toBe(1)
    // YAML 自己宣言は らいお手動追加待ち (実装時点では未追加 → null)
    // ただし「らいおが既に YAML を追加済」なら manxFrontmatter は { r8, host } になり、R7 → manx-host
    // 本テストは「どちらでも矛盾しない」よう振り分け
    if (inputs.manxFrontmatter !== null) {
      const marker = deriveMarker(inputs)
      if (inputs.manxFrontmatter.manxRole === 'host') {
        expect(marker.protocol).toBe('manx-host')
      } else {
        expect(marker.protocol).toBe('manx')
      }
      expect(marker.detection_confidence).toBe('low')
    } else {
      // YAML 未追加: R3b → unknown/low (CCDG2 の現状 44 行 CLAUDE.md)
      const marker = deriveMarker(inputs)
      expect(marker.protocol).toBe('unknown')
      expect(marker.detection_confidence).toBe('low')
    }
  })
})
