import { describe, it, expect } from 'vitest'
import {
  formatBadgeView,
  localizeBadgeText,
  PROTOCOL_COLOR,
  UNKNOWN_COLOR,
  type ProtocolMarkerView,
} from '../protocolBadge'

function makeMarker(overrides: Partial<ProtocolMarkerView> = {}): ProtocolMarkerView {
  return {
    protocol: 'manx',
    revision: 'r5',
    stage: 'stable',
    stage_inferred: false,
    variant: null,
    variant_alias: null,
    applied_at: null,
    applied_by: 'auto',
    detection_evidence: null,
    detection_confidence: 'high',
    ...overrides,
  }
}

describe('formatBadgeView', () => {
  describe('034: unknown protocol → Untagged 表示 (r6 不変)', () => {
    it('TC1: unknown / low confidence → text="Untagged"', () => {
      const view = formatBadgeView(
        makeMarker({ protocol: 'unknown', detection_confidence: 'low', stage_inferred: true })
      )
      expect(view).not.toBeNull()
      expect(view!.text).toBe('Untagged')
      expect(view!.isInferred).toBe(false)
    })

    it('TC2: unknown / high confidence → text="Untagged"', () => {
      const view = formatBadgeView(
        makeMarker({ protocol: 'unknown', detection_confidence: 'high' })
      )
      expect(view).not.toBeNull()
      expect(view!.text).toBe('Untagged')
    })

    it('TC3: unknown / unknown confidence → null (バッジ非表示、不変仕様)', () => {
      const view = formatBadgeView(
        makeMarker({ protocol: 'unknown', detection_confidence: 'unknown' })
      )
      expect(view).toBeNull()
    })

    it('TC4: unknown / stage_inferred=true でも Untagged は "*" を出さない', () => {
      const view = formatBadgeView(
        makeMarker({
          protocol: 'unknown',
          detection_confidence: 'low',
          stage_inferred: true,
        })
      )
      expect(view!.text).toBe('Untagged')
      expect(view!.text).not.toContain('*')
      expect(view!.isInferred).toBe(false)
    })

    it('TC5: unknown 分岐の className が中立 (muted) になる', () => {
      const view = formatBadgeView(
        makeMarker({ protocol: 'unknown', detection_confidence: 'low' })
      )
      expect(view!.className).toContain('muted')
      expect(view!.className).not.toContain('emerald')
      expect(view!.className).not.toContain('amber')
      expect(view!.className).toBe(UNKNOWN_COLOR)
    })
  })

  describe('FSA r6 §4: legacy 分岐 (amber 色系、stage="*" 廃止)', () => {
    it('TC6 (r6 更新): legacy / high → text="Legacy", className=amber high (filled)', () => {
      const view = formatBadgeView(
        makeMarker({ protocol: 'legacy', stage_inferred: false, detection_confidence: 'high' })
      )
      expect(view!.text).toBe('Legacy')
      expect(view!.className).toBe(PROTOCOL_COLOR.legacy.high)
    })

    it('TC7 (r6 仕様変更): legacy + stage_inferred=true → text="Legacy" (★ "*" 削除)', () => {
      const view = formatBadgeView(
        makeMarker({ protocol: 'legacy', stage_inferred: true, detection_confidence: 'low' })
      )
      expect(view!.text).toBe('Legacy')
      expect(view!.text).not.toContain('*')
      expect(view!.isInferred).toBe(true)
      expect(view!.className).toBe(PROTOCOL_COLOR.legacy.low)
    })
  })

  describe('FSA r6 §4: manx 分岐 (emerald 色系、auto は文言シンプル化)', () => {
    it('TC8 (r6 仕様変更): manx + high (R1) → text="MANX" (★ revision 削除)', () => {
      const view = formatBadgeView(
        makeMarker({
          protocol: 'manx',
          revision: 'r5',
          stage: 'stable',
          detection_confidence: 'high',
        })
      )
      expect(view!.text).toBe('MANX')
      expect(view!.className).toBe(PROTOCOL_COLOR.manx.high)
    })

    it('TC9 (r6 仕様変更): manx + low + variant → text="MANX" (auto では variant 表示しない)', () => {
      const view = formatBadgeView(
        makeMarker({
          protocol: 'manx',
          revision: 'r5',
          variant: 'wild',
          variant_alias: 'my-alias',
          detection_confidence: 'low',
        })
      )
      expect(view!.text).toBe('MANX')
      expect(view!.className).toBe(PROTOCOL_COLOR.manx.low)
    })

    it('TC10 (r6 仕様変更): manx + stage=beta + auto → text="MANX" (★ stage suffix 削除)', () => {
      const view = formatBadgeView(
        makeMarker({
          protocol: 'manx',
          revision: 'r5',
          stage: 'beta',
          detection_confidence: 'low',
        })
      )
      expect(view!.text).toBe('MANX')
      expect(view!.text).not.toContain('β')
      expect(view!.text).not.toContain('exp')
    })

    it('TC11: 入力 null → null', () => {
      expect(formatBadgeView(null)).toBeNull()
    })
  })
})

describe('localizeBadgeText (034: i18n マッピング、案 B、r6 不変)', () => {
  it('TC12: text="Untagged" → t("pages.projects.protocolBadge.untagged") を返す', () => {
    const mockT = (key: string): string =>
      key === 'pages.projects.protocolBadge.untagged' ? '未分類' : `[MISS:${key}]`
    expect(localizeBadgeText('Untagged', mockT)).toBe('未分類')
  })

  it('TC13: text="Legacy" は将来 i18n 候補としてリテラル維持（マッピング辞書の空席）', () => {
    const mockT = (key: string): string => `[CALLED:${key}]`
    expect(localizeBadgeText('Legacy', mockT)).toBe('Legacy')
  })

  it('TC14: text="MANX" / "MANX r5" 等の動的組立はリテラル維持', () => {
    const mockT = (key: string): string => `[CALLED:${key}]`
    expect(localizeBadgeText('MANX', mockT)).toBe('MANX')
    expect(localizeBadgeText('MANX r5', mockT)).toBe('MANX r5')
  })

  it('TC15: 翻訳関数が返した文字列をそのまま返却', () => {
    const mockT = (): string => 'translated-text'
    expect(localizeBadgeText('Untagged', mockT)).toBe('translated-text')
  })
})

// ────────────────────────────────────────────────────────────────────
// FSA r6 §4 — ProtocolBadge ColorSystem (NEW r6 ルール)
// Case 16〜25: protocol × confidence マトリクス検証
// Case 26〜29: 大文字小文字バリアント正規化（ZT_Test 検体由来 §3-3）
// ────────────────────────────────────────────────────────────────────

describe('FSA r6 §4: protocol × confidence マトリクス (NEW)', () => {
  it('TC16 ★核心: R5 状態 (manx + high + stage=experimental + inferred) → "MANX" + emerald high', () => {
    // R5 投入後、Full Re-scan で生成される自動判定マーカーの典型
    const view = formatBadgeView(
      makeMarker({
        protocol: 'manx',
        revision: '?',
        stage: 'experimental',
        stage_inferred: true,
        detection_confidence: 'high',
      })
    )
    expect(view!.text).toBe('MANX')
    expect(view!.className).toBe(PROTOCOL_COLOR.manx.high)
    expect(view!.className).not.toContain('red') // ★ 旧 STAGE_COLOR['experimental'] が消えていること
  })

  it('TC17: manx + low (R2/R5 等) → "MANX" + emerald low (outlined)', () => {
    const view = formatBadgeView(
      makeMarker({
        protocol: 'manx',
        revision: '?',
        stage: 'experimental',
        detection_confidence: 'low',
      })
    )
    expect(view!.text).toBe('MANX')
    expect(view!.className).toBe(PROTOCOL_COLOR.manx.low)
  })

  it('TC18: manx + explicit + revision="r5" + stage=stable → "MANX r5" + emerald explicit', () => {
    const view = formatBadgeView(
      makeMarker({
        protocol: 'manx',
        revision: 'r5',
        stage: 'stable',
        detection_confidence: 'explicit',
      })
    )
    expect(view!.text).toBe('MANX r5')
    expect(view!.className).toBe(PROTOCOL_COLOR.manx.explicit)
  })

  it('TC19: manx + explicit + variant="wild" → "MANX r5 (wild)"', () => {
    const view = formatBadgeView(
      makeMarker({
        protocol: 'manx',
        revision: 'r5',
        variant: 'wild',
        variant_alias: null,
        detection_confidence: 'explicit',
      })
    )
    expect(view!.text).toBe('MANX r5 (wild)')
  })

  it('TC20: manx + explicit + variant + alias → "MANX r5 [alias]" (alias 優先)', () => {
    const view = formatBadgeView(
      makeMarker({
        protocol: 'manx',
        revision: 'r5',
        variant: 'wild',
        variant_alias: 'alias',
        detection_confidence: 'explicit',
      })
    )
    expect(view!.text).toBe('MANX r5 [alias]')
  })

  it('TC21: legacy + high + inferred=false → "Legacy" + amber high (filled)', () => {
    const view = formatBadgeView(
      makeMarker({
        protocol: 'legacy',
        stage_inferred: false,
        detection_confidence: 'high',
      })
    )
    expect(view!.text).toBe('Legacy')
    expect(view!.className).toBe(PROTOCOL_COLOR.legacy.high)
  })

  it('TC22: legacy + low + inferred=true (R3a auto) → "Legacy" (★ "*" なし) + amber low', () => {
    const view = formatBadgeView(
      makeMarker({
        protocol: 'legacy',
        stage_inferred: true,
        detection_confidence: 'low',
      })
    )
    expect(view!.text).toBe('Legacy')
    expect(view!.text).not.toContain('*')
    expect(view!.className).toBe(PROTOCOL_COLOR.legacy.low)
  })

  it('TC23: legacy + explicit → "Legacy" + amber explicit', () => {
    const view = formatBadgeView(
      makeMarker({
        protocol: 'legacy',
        detection_confidence: 'explicit',
      })
    )
    expect(view!.text).toBe('Legacy')
    expect(view!.className).toBe(PROTOCOL_COLOR.legacy.explicit)
  })

  it('TC24: unknown + low → "Untagged" + muted (既存維持)', () => {
    const view = formatBadgeView(
      makeMarker({
        protocol: 'unknown',
        detection_confidence: 'low',
      })
    )
    expect(view!.text).toBe('Untagged')
    expect(view!.className).toBe(UNKNOWN_COLOR)
  })

  it('TC25 色覚配慮: manx と legacy の className に共通色が含まれない', () => {
    const manxView = formatBadgeView(
      makeMarker({ protocol: 'manx', detection_confidence: 'high' })
    )
    const legacyView = formatBadgeView(
      makeMarker({ protocol: 'legacy', detection_confidence: 'high' })
    )
    // manx は emerald のみ、legacy は amber のみ
    expect(manxView!.className).toContain('emerald')
    expect(manxView!.className).not.toContain('amber')
    expect(legacyView!.className).toContain('amber')
    expect(legacyView!.className).not.toContain('emerald')
  })
})

describe('FSA r6 §3-3: 大文字小文字バリアント正規化 (ZT_Test 検体由来)', () => {
  it('TC26 ★ZT_Test 検体: protocol="Legacy" (Pascal) + explicit → "Legacy" + amber explicit', () => {
    // ZT_Test/.ccpit/protocol.json の manual entry に保存されていた値の再現
    const view = formatBadgeView(
      makeMarker({
        protocol: 'Legacy',
        revision: '?',
        stage: 'experimental',
        stage_inferred: false,
        detection_confidence: 'explicit',
      })
    )
    expect(view!.text).toBe('Legacy')
    expect(view!.text).not.toBe('LEGACY ? exp') // ★ 旧 RED 表示が消えていること
    expect(view!.className).toBe(PROTOCOL_COLOR.legacy.explicit)
    expect(view!.className).not.toContain('red')
  })

  it('TC27: protocol="LEGACY" (大文字) + high → "Legacy" + amber high (legacy 分岐に正規化)', () => {
    const view = formatBadgeView(
      makeMarker({ protocol: 'LEGACY', detection_confidence: 'high' })
    )
    expect(view!.text).toBe('Legacy')
    expect(view!.className).toBe(PROTOCOL_COLOR.legacy.high)
  })

  it('TC28: protocol="MANX" (大文字) + low → "MANX" + emerald low (manx 分岐の正常動作)', () => {
    const view = formatBadgeView(
      makeMarker({
        protocol: 'MANX',
        revision: '?',
        stage: 'experimental',
        detection_confidence: 'low',
      })
    )
    expect(view!.text).toBe('MANX')
    expect(view!.className).toBe(PROTOCOL_COLOR.manx.low)
  })

  it('TC29: protocol="Unknown" (Pascal) + low → "Untagged" (大文字小文字に関係なく unknown 分岐)', () => {
    const view = formatBadgeView(
      makeMarker({
        protocol: 'Unknown',
        detection_confidence: 'low',
      })
    )
    expect(view!.text).toBe('Untagged')
    expect(view!.className).toBe(UNKNOWN_COLOR)
  })
})

describe('FSA r7 §6: manx-host (violet 中間色) NEW r7', () => {
  it('TC30 (manx-host high): protocol=manx-host, conf=high → "MANX-Host" + violet high (filled)', () => {
    const view = formatBadgeView(
      makeMarker({
        protocol: 'manx-host',
        revision: '?',
        detection_confidence: 'high',
      })
    )
    expect(view!.text).toBe('MANX-Host')
    expect(view!.className).toBe(PROTOCOL_COLOR['manx-host'].high)
    expect(view!.className).toContain('violet')
  })

  it('TC31 (manx-host low): protocol=manx-host, conf=low → "MANX-Host" + violet low (outlined)', () => {
    const view = formatBadgeView(
      makeMarker({
        protocol: 'manx-host',
        revision: '?',
        detection_confidence: 'low',
      })
    )
    expect(view!.text).toBe('MANX-Host')
    expect(view!.className).toBe(PROTOCOL_COLOR['manx-host'].low)
  })

  it('TC32 (manx-host explicit): protocol=manx-host, conf=explicit, revision=r5 → "MANX-Host r5" + violet explicit', () => {
    const view = formatBadgeView(
      makeMarker({
        protocol: 'manx-host',
        revision: 'r5',
        detection_confidence: 'explicit',
      })
    )
    expect(view!.text).toBe('MANX-Host r5')
    expect(view!.className).toBe(PROTOCOL_COLOR['manx-host'].explicit)
  })

  it('TC33 色覚配慮: manx / legacy / manx-host が独立色軸 (emerald / amber / violet)', () => {
    const manxView = formatBadgeView(makeMarker({ protocol: 'manx', detection_confidence: 'high' }))
    const legacyView = formatBadgeView(makeMarker({ protocol: 'legacy', detection_confidence: 'high' }))
    const hostView = formatBadgeView(
      makeMarker({ protocol: 'manx-host', revision: '?', detection_confidence: 'high' })
    )
    expect(manxView!.className).toContain('emerald')
    expect(manxView!.className).not.toContain('amber')
    expect(manxView!.className).not.toContain('violet')
    expect(legacyView!.className).toContain('amber')
    expect(legacyView!.className).not.toContain('emerald')
    expect(legacyView!.className).not.toContain('violet')
    expect(hostView!.className).toContain('violet')
    expect(hostView!.className).not.toContain('emerald')
    expect(hostView!.className).not.toContain('amber')
  })
})
