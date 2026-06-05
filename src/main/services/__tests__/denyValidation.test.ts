import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  validateDenySymmetry,
  validateDenyCoverage,
  resolveExpectedDeny,
  platformToTemplate
} from '../denyValidation'

describe('validateDenySymmetry (双方向, Marshal F2)', () => {
  it('対称な deny は valid', () => {
    expect(validateDenySymmetry(['Read(~/.ssh/**)', 'Bash(cat ~/.ssh/**)']).valid).toBe(true)
  })

  it('Read のみ → cat 欠落を検出', () => {
    const r = validateDenySymmetry(['Read(~/.ssh/**)'])
    expect(r.valid).toBe(false)
    expect(r.mismatches[0]).toContain('Bash(cat ~/.ssh/**)')
  })

  it('cat のみ（保護パス）→ Read 欠落を検出（双方向）', () => {
    const r = validateDenySymmetry(['Bash(cat ~/.ssh/**)'])
    expect(r.valid).toBe(false)
    expect(r.mismatches[0]).toContain('Read(~/.ssh/**)')
  })

  it('settings.json の cat-only は例外で valid', () => {
    expect(validateDenySymmetry(['Bash(cat ~/.claude/settings.json)']).valid).toBe(true)
    expect(validateDenySymmetry(['Bash(cat ~/.claude/settings.local.json)']).valid).toBe(true)
  })

  it('Read/cat 以外（env, rm, security, Edit）は無視', () => {
    expect(
      validateDenySymmetry([
        'Bash(env)',
        'Bash(rm -rf /)',
        'Bash(security dump-keychain*)',
        'Edit(~/.claude/settings.json)'
      ]).valid
    ).toBe(true)
  })
})

describe('validateDenyCoverage (Marshal F1)', () => {
  it('期待が全部 installed にあれば valid', () => {
    expect(validateDenyCoverage(['A', 'B', 'C'], ['A', 'B']).valid).toBe(true)
  })

  it('空 installed は期待を全件 missing（deploy/破壊後の欠落検出）', () => {
    const r = validateDenyCoverage([], ['Read(~/.ssh/**)', 'Bash(cat ~/.ssh/**)'])
    expect(r.valid).toBe(false)
    expect(r.missing).toHaveLength(2)
  })

  it('一部欠落を検出', () => {
    const r = validateDenyCoverage(['A'], ['A', 'B', 'C'])
    expect(r.missing).toEqual(['B', 'C'])
  })
})

describe('resolveExpectedDeny (Marshal F1/F4 fail-closed)', () => {
  const goldenDir = join(__dirname, '../../../../golden')

  it('manx は ok + 期待リスト（common + manx extra）', () => {
    const r = resolveExpectedDeny(goldenDir, 'manx')
    expect(r.ok).toBe(true)
    expect(r.expected.length).toBeGreaterThan(0)
  })

  it('asama は ok（Linux 固有 deny 含む）', () => {
    const r = resolveExpectedDeny(goldenDir, 'asama')
    expect(r.ok).toBe(true)
    expect(r.expected).toContain('Read(/etc/shadow)')
  })

  it('未知 template は fail-closed (ok=false, expected=[])', () => {
    const r = resolveExpectedDeny(goldenDir, 'bogus')
    expect(r.ok).toBe(false)
    expect(r.expected).toEqual([])
    expect(r.error).toContain('bogus')
  })

  it('golden ディレクトリ不在は fail-closed', () => {
    const r = resolveExpectedDeny(join(goldenDir, '__nonexistent__'), 'manx')
    expect(r.ok).toBe(false)
  })
})

describe('golden deny の双方向対称 + 自己網羅（回帰: PIKES 確定 deny の完備を保証）', () => {
  const goldenDir = join(__dirname, '../../../../golden')
  function loadDeny(...rel: string[]): string[] {
    const out: string[] = []
    for (const p of rel) {
      out.push(...JSON.parse(readFileSync(join(goldenDir, p), 'utf-8')))
    }
    return out
  }

  it('common (deny-base) は双方向対称', () => {
    expect(validateDenySymmetry(loadDeny('common/settings.deny-base.json')).mismatches).toEqual([])
  })

  it('common + manx は双方向対称', () => {
    expect(
      validateDenySymmetry(
        loadDeny('common/settings.deny-base.json', 'manx/settings.deny-extra.json')
      ).mismatches
    ).toEqual([])
  })

  it('common + macau は双方向対称', () => {
    expect(
      validateDenySymmetry(
        loadDeny('common/settings.deny-base.json', 'macau/settings.deny-extra.json')
      ).mismatches
    ).toEqual([])
  })

  it('common + asama は双方向対称', () => {
    expect(
      validateDenySymmetry(
        loadDeny('common/settings.deny-base.json', 'asama/settings.deny-extra.json')
      ).mismatches
    ).toEqual([])
  })

  it('各 template は resolveExpectedDeny→coverage 自己網羅', () => {
    for (const t of ['manx', 'macau', 'asama']) {
      const exp = resolveExpectedDeny(goldenDir, t)
      expect(exp.ok).toBe(true)
      expect(validateDenyCoverage(exp.expected, exp.expected).valid).toBe(true)
    }
  })
})

describe('platformToTemplate (Marshal F7: main 側、renderer と同期)', () => {
  it('win32 → manx', () => {
    expect(platformToTemplate('win32')).toBe('manx')
  })
  it('darwin → macau（legacy macOS fallback も macau 検証）', () => {
    expect(platformToTemplate('darwin')).toBe('macau')
  })
  it('linux → asama', () => {
    expect(platformToTemplate('linux')).toBe('asama')
  })
  it('未知は manx 既定', () => {
    expect(platformToTemplate('freebsd')).toBe('manx')
  })
})

describe('MANX ドライブ破壊 deny の parity (Marshal F8: C:/D: 同等カバレッジ)', () => {
  const goldenDir = join(__dirname, '../../../../golden')
  const manxDeny = JSON.parse(
    readFileSync(join(goldenDir, 'manx/settings.deny-extra.json'), 'utf-8')
  ) as string[]

  // 保護対象の各 Windows ドライブは root + wildcard + rmdir + MSYS slash(/x, /x/*) を網羅する。
  // self-coverage では同じ不完全リスト同士の比較で見逃すため、形式を直接 assert する。
  for (const [up, low] of [
    ['C', 'c'],
    ['D', 'd']
  ]) {
    it(`${up}: は root+wildcard+rmdir+MSYS(/${low},/${low}/*) を網羅`, () => {
      expect(manxDeny).toContain(`Bash(rm -rf ${up}:\\\\)`)
      expect(manxDeny).toContain(`Bash(rm -rf ${up}:\\\\*)`)
      expect(manxDeny).toContain(`Bash(rmdir /s /q ${up}:\\\\)`)
      expect(manxDeny).toContain(`Bash(rm -rf /${low})`)
      expect(manxDeny).toContain(`Bash(rm -rf /${low}/*)`)
    })
  }
})
