import { describe, it, expect } from 'vitest'
import { platformToTemplate } from './platformTemplate'

describe('platformToTemplate (Marshal F6: platform→golden template の一元化)', () => {
  it('win32 → manx', () => {
    expect(platformToTemplate('win32')).toBe('manx')
  })

  it('darwin → macau（macOS Keychain/security deny を適用・検証するため）', () => {
    expect(platformToTemplate('darwin')).toBe('macau')
  })

  it('linux → asama', () => {
    expect(platformToTemplate('linux')).toBe('asama')
  })

  it('未知 platform は manx 既定', () => {
    expect(platformToTemplate('freebsd')).toBe('manx')
    expect(platformToTemplate('')).toBe('manx')
  })
})
