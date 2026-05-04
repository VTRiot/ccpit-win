import { describe, it, expect } from 'vitest'
import {
  formatBadgeView,
  localizeBadgeText,
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
  describe('034: unknown protocol → Untagged 表示', () => {
    it('TC1: unknown / low confidence → text="Untagged" (リテラル、suffix なし)', () => {
      const view = formatBadgeView(
        makeMarker({ protocol: 'unknown', detection_confidence: 'low', stage_inferred: true })
      )
      expect(view).not.toBeNull()
      expect(view!.text).toBe('Untagged')
      expect(view!.isInferred).toBe(false)
    })

    it('TC2: unknown / high confidence → text="Untagged" (low 以外でも同じ表示)', () => {
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

    it('TC4: unknown / stage_inferred=true でも Untagged は "*" を出さない (意味矛盾の解消)', () => {
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
    })
  })

  describe('既存分岐の不変動作（Untagged 化による副作用なしを確認）', () => {
    it('TC6: legacy → "Legacy" (suffix 無)', () => {
      const view = formatBadgeView(makeMarker({ protocol: 'legacy', stage_inferred: false }))
      expect(view!.text).toBe('Legacy')
    })

    it('TC7: legacy + stage_inferred=true → "Legacy *"', () => {
      const view = formatBadgeView(makeMarker({ protocol: 'legacy', stage_inferred: true }))
      expect(view!.text).toBe('Legacy *')
      expect(view!.isInferred).toBe(true)
    })

    it('TC8: 通常 protocol "manx r5" / stable → "MANX r5"', () => {
      const view = formatBadgeView(makeMarker({ protocol: 'manx', revision: 'r5', stage: 'stable' }))
      expect(view!.text).toBe('MANX r5')
    })

    it('TC9: variant + alias 付き protocol → "MANX r5 [my-alias]"', () => {
      const view = formatBadgeView(
        makeMarker({ protocol: 'manx', revision: 'r5', variant: 'wild', variant_alias: 'my-alias' })
      )
      expect(view!.text).toBe('MANX r5 [my-alias]')
    })

    it('TC10: stage=beta → " β" suffix が付く', () => {
      const view = formatBadgeView(makeMarker({ protocol: 'manx', revision: 'r5', stage: 'beta' }))
      expect(view!.text).toBe('MANX r5 β')
    })

    it('TC11: 入力 null → null', () => {
      expect(formatBadgeView(null)).toBeNull()
    })
  })
})

describe('localizeBadgeText (034: i18n マッピング、案 B)', () => {
  it('TC12: text="Untagged" → t("pages.projects.protocolBadge.untagged") を返す', () => {
    const mockT = (key: string): string =>
      key === 'pages.projects.protocolBadge.untagged' ? '未分類' : `[MISS:${key}]`
    expect(localizeBadgeText('Untagged', mockT)).toBe('未分類')
  })

  it('TC13: text="Legacy" は将来 i18n 候補としてリテラル維持（マッピング辞書の空席）', () => {
    const mockT = (key: string): string => `[CALLED:${key}]`
    expect(localizeBadgeText('Legacy', mockT)).toBe('Legacy')
  })

  it('TC14: text="MANX r5" 等の動的組立はリテラル維持', () => {
    const mockT = (key: string): string => `[CALLED:${key}]`
    expect(localizeBadgeText('MANX r5', mockT)).toBe('MANX r5')
    expect(localizeBadgeText('MANX r5 β', mockT)).toBe('MANX r5 β')
  })

  it('TC15: 翻訳関数が返した文字列をそのまま返却', () => {
    const mockT = (): string => 'translated-text'
    expect(localizeBadgeText('Untagged', mockT)).toBe('translated-text')
  })
})
