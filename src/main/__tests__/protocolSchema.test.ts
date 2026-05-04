import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * 034-B Phase 2-G: 型 5 違反の制度的防止（schema check）。
 *
 * 「明示意思」の出所証跡が複数フィールドに散らばらないことを property-based に検証する。
 * 失敗時は CONTRIBUTING.md のチェックリストを参照する。
 */

const PARC_FERME_ROOT = join(__dirname, '..', '..', '..')

function readSrc(relPath: string): string {
  return readFileSync(join(PARC_FERME_ROOT, relPath), 'utf-8')
}

describe('034-B Phase 2-G: schema check', () => {
  it('TC-SCM-1: src/main/ipc.ts 内に旧 writeProtocol が呼ばれていない（appendProtocolEntry に移行済み）', () => {
    const src = readSrc('src/main/ipc.ts')
    // import 文の writeProtocol も含めて検出（コメント以外）
    const lines = src.split('\n')
    const violations: { line: number; text: string }[] = []
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      // コメント行は無視
      if (/^\s*\/[/*]/.test(line)) continue
      // 文字列内の言及も無視するため、識別子としての出現のみ検出
      if (/\bwriteProtocol\b/.test(line)) {
        violations.push({ line: i + 1, text: line.trim() })
      }
    }
    if (violations.length > 0) {
      const msg = violations.map((v) => `  L${v.line}: ${v.text}`).join('\n')
      throw new Error(
        `ipc.ts must not call legacy writeProtocol (use appendProtocolEntry instead).\n` +
          `Violations:\n${msg}\n` +
          `See ccpit/CONTRIBUTING.md for invariants.`
      )
    }
    expect(violations.length).toBe(0)
  })

  it('TC-SCM-2: ProjectEntry に「明示意思」を示すフィールド (confirmed, isManual, userExplicit 等) が再追加されていない', () => {
    const src = readSrc('src/main/services/projects.ts')
    // ProjectEntry interface ブロックを抽出
    const m = src.match(/export interface ProjectEntry\s*\{([\s\S]*?)\n\}/)
    expect(m).not.toBeNull()
    const block = m![1]
    const forbidden = ['confirmed', 'isManual', 'userExplicit', 'manualEdited', 'isExplicit']
    const violations = forbidden.filter((f) => new RegExp(`\\b${f}\\b\\s*\\??\\s*:`).test(block))
    if (violations.length > 0) {
      throw new Error(
        `ProjectEntry must not add explicit-intent fields (use protocol.json history instead): ${violations.join(', ')}\n` +
          `See ccpit/CONTRIBUTING.md schema invariants.`
      )
    }
    expect(violations.length).toBe(0)
  })

  it('TC-SCM-3: ProtocolEntrySource union が "auto" | "manual" のみ（拡張時は意識的レビュー必要）', () => {
    const src = readSrc('src/main/services/protocol/types.ts')
    const m = src.match(/export type ProtocolEntrySource\s*=\s*([^\n]+)/)
    expect(m).not.toBeNull()
    const def = m![1].trim().replace(/\s+/g, ' ').replace(/[,;].*$/, '')
    // 'auto' | 'manual' (順序問わず)
    const tokens = def
      .split('|')
      .map((s) => s.trim().replace(/['"]/g, ''))
      .sort()
    expect(tokens).toEqual(['auto', 'manual'])
  })
})
