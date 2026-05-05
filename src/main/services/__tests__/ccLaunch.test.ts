import { describe, it, expect } from 'vitest'
import { normalize } from 'path'
import { buildLaunchSpec, type LaunchArgs } from '../ccLaunch'

const PROJECT = 'C:\\_Prog\\my-pj'
const EXPECTED_PATH = normalize(PROJECT)
const WT = 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe'
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

function args(overrides: Partial<LaunchArgs> = {}): LaunchArgs {
  return { projectPath: PROJECT, flags: [], ...overrides }
}

describe('buildLaunchSpec — 037 Phase 2-C: wt 直接 spawn (前面起動) + ps cmd /c start フォールバック', () => {
  describe('wt.exe あり: Windows Terminal 直接 spawn (cmd 経由なし、最前面表示用)', () => {
    it('TC1: 空 flags で claude が単体起動コマンドになる', () => {
      const spec = buildLaunchSpec(args(), { wt: WT, ps: null })
      expect(spec).toEqual({
        shell: 'wt.exe',
        command: WT,
        args: [
          '-d',
          EXPECTED_PATH,
          'powershell.exe',
          '-NoExit',
          '-Command',
          'claude',
        ],
      })
    })

    it('TC2: flags が claudeCmd に空白区切りで結合される', () => {
      const spec = buildLaunchSpec(
        args({ flags: ['--verbose', '--ide', '--effort', 'high'] }),
        { wt: WT, ps: null }
      )
      expect('args' in spec).toBe(true)
      if ('args' in spec) {
        expect(spec.args[spec.args.length - 1]).toBe(
          'claude --verbose --ide --effort high'
        )
      }
    })

    it('TC3: 空文字 flag は除外される', () => {
      const spec = buildLaunchSpec(args({ flags: ['', '--verbose', ''] }), {
        wt: WT,
        ps: null,
      })
      if ('args' in spec) {
        expect(spec.args[spec.args.length - 1]).toBe('claude --verbose')
      }
    })

    it('TC4: ps の値があっても wt.exe が優先される (command が WT 直接、PS 不在)', () => {
      const spec = buildLaunchSpec(args(), { wt: WT, ps: PS })
      if ('args' in spec) {
        expect(spec.shell).toBe('wt.exe')
        expect(spec.command).toBe(WT)
        expect(spec.args).not.toContain(PS)
      }
    })

    it('TC5: wt 経路は cmd を経由せず wt が直接 command になる (037 Phase 2-C 追加)', () => {
      const spec = buildLaunchSpec(args(), { wt: WT, ps: null })
      if ('args' in spec) {
        expect(spec.command).toBe(WT)
        expect(spec.args[0]).toBe('-d')
        expect(spec.args).not.toContain('/c')
        expect(spec.args).not.toContain('start')
        expect(spec.args).not.toContain('""')
      }
    })
  })

  describe('wt.exe なし、powershell.exe のみ: PowerShell コンソール経由', () => {
    it('TC6: ps 経路で /D <path> オプションが cwd 指定として入る', () => {
      const spec = buildLaunchSpec(args(), { wt: null, ps: PS })
      expect(spec).toEqual({
        shell: 'powershell.exe',
        command: 'cmd.exe',
        args: [
          '/c',
          'start',
          '""',
          '/D',
          EXPECTED_PATH,
          PS,
          '-NoExit',
          '-Command',
          'claude',
        ],
      })
    })

    it('TC7: ps 経路でも flags が claudeCmd に結合される', () => {
      const spec = buildLaunchSpec(
        args({ flags: ['--dangerously-skip-permissions', '-c'] }),
        { wt: null, ps: PS }
      )
      if ('args' in spec) {
        expect(spec.shell).toBe('powershell.exe')
        expect(spec.args[spec.args.length - 1]).toBe(
          'claude --dangerously-skip-permissions -c'
        )
      }
    })
  })

  describe('両方なし: error 返却', () => {
    it('TC8: wt も ps も null → error', () => {
      const spec = buildLaunchSpec(args(), { wt: null, ps: null })
      expect(spec).toEqual({
        error: 'No shell found (wt.exe or powershell.exe)',
      })
    })
  })

  describe('projectPath の正規化', () => {
    it('TC9: スラッシュ混在パスが path.normalize で揃えられる', () => {
      const mixed = 'C:/_Prog\\my-pj'
      const spec = buildLaunchSpec(
        { projectPath: mixed, flags: [] },
        { wt: WT, ps: null }
      )
      if ('args' in spec) {
        const dIdx = spec.args.indexOf('-d')
        expect(spec.args[dIdx + 1]).toBe(normalize(mixed))
      }
    })
  })
})
