import { describe, it, expect } from 'vitest'
import { isCcesEnabled, CCES_CONFIG_CHANGED_EVENT } from '../ccesEnabled'
import type { ProtocolMarkerView } from '../protocolBadge'

function makeMarker(overrides: Partial<ProtocolMarkerView> = {}): ProtocolMarkerView {
  return {
    protocol: 'manx',
    revision: 'r8',
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

describe('isCcesEnabled — 037 Phase 2-B: スイッチ × 自動判定 マトリクス', () => {
  describe('スイッチ ON (allowAllProjects = true): 全 PJ enable', () => {
    it('TC1: manx → enable', () => {
      expect(isCcesEnabled(makeMarker({ protocol: 'manx' }), true)).toBe(true)
    })
    it('TC2: manx-host → enable', () => {
      expect(isCcesEnabled(makeMarker({ protocol: 'manx-host' }), true)).toBe(true)
    })
    it('TC3: legacy → enable（例外運用）', () => {
      expect(isCcesEnabled(makeMarker({ protocol: 'legacy' }), true)).toBe(true)
    })
    it('TC4: unknown → enable（例外運用）', () => {
      expect(isCcesEnabled(makeMarker({ protocol: 'unknown' }), true)).toBe(true)
    })
    it('TC5: marker = null → enable', () => {
      expect(isCcesEnabled(null, true)).toBe(true)
    })
    it('TC6: marker = undefined → enable', () => {
      expect(isCcesEnabled(undefined, true)).toBe(true)
    })
  })

  describe('スイッチ OFF (allowAllProjects = false、既定): MANX のみ enable', () => {
    it('TC7: manx → enable', () => {
      expect(isCcesEnabled(makeMarker({ protocol: 'manx' }), false)).toBe(true)
    })
    it('TC8: manx-host → enable', () => {
      expect(isCcesEnabled(makeMarker({ protocol: 'manx-host' }), false)).toBe(true)
    })
    it('TC9: legacy → disable（灰抜き）', () => {
      expect(isCcesEnabled(makeMarker({ protocol: 'legacy' }), false)).toBe(false)
    })
    it('TC10: unknown → disable（灰抜き）', () => {
      expect(isCcesEnabled(makeMarker({ protocol: 'unknown' }), false)).toBe(false)
    })
  })

  describe('toLowerCase 正規化（Phase 2-A 申し送り §1-2 対策）', () => {
    it('TC11: protocol="Legacy"（Pascal Case）でも disable される', () => {
      expect(isCcesEnabled(makeMarker({ protocol: 'Legacy' }), false)).toBe(false)
    })
    it('TC12: protocol="MANX"（全大文字）でも enable される', () => {
      expect(isCcesEnabled(makeMarker({ protocol: 'MANX' }), false)).toBe(true)
    })
    it('TC13: protocol="Manx-Host"（混在大文字）でも enable される', () => {
      expect(isCcesEnabled(makeMarker({ protocol: 'Manx-Host' }), false)).toBe(true)
    })
    it('TC14: protocol="UNKNOWN" でも disable される', () => {
      expect(isCcesEnabled(makeMarker({ protocol: 'UNKNOWN' }), false)).toBe(false)
    })
  })

  describe('marker null/undefined fallback（ロード前は安全側で enable）', () => {
    it('TC15: スイッチ OFF + marker = null → enable（ロード前 fallback）', () => {
      expect(isCcesEnabled(null, false)).toBe(true)
    })
    it('TC16: スイッチ OFF + marker = undefined → enable', () => {
      expect(isCcesEnabled(undefined, false)).toBe(true)
    })
  })

  describe('未知の protocol 文字列', () => {
    it('TC17: スイッチ OFF + 未定義 protocol → disable', () => {
      expect(isCcesEnabled(makeMarker({ protocol: 'experimental-foo' }), false)).toBe(false)
    })
    it('TC18: スイッチ OFF + 空文字 protocol → disable', () => {
      expect(isCcesEnabled(makeMarker({ protocol: '' }), false)).toBe(false)
    })
  })
})

describe('CCES_CONFIG_CHANGED_EVENT 定数', () => {
  it('event name は cces-config-changed', () => {
    expect(CCES_CONFIG_CHANGED_EVENT).toBe('cces-config-changed')
  })
})
