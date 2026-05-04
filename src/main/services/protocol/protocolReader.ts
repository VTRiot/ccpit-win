import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import type {
  ProtocolMarker,
  ProtocolHistoryFile,
  ProtocolHistoryEntry,
} from './types'

export const PROTOCOL_DIR = '.ccpit'
export const PROTOCOL_FILE = 'protocol.json'

export function getProtocolFilePath(projectPath: string): string {
  return join(projectPath, PROTOCOL_DIR, PROTOCOL_FILE)
}

/**
 * 034-B: protocol.json を読んで「現在表示すべき marker」を返す。
 *
 * - v1 (旧フラット形式): 旧マーカーをそのまま返す（後方互換、起動時マイグレーションが優先される設計）
 * - v2 (新履歴形式): getCurrentMarker(history) で「最新 manual > 最新 auto」を計算
 * - 不在 / 破損: null
 */
export async function readProtocol(projectPath: string): Promise<ProtocolMarker | null> {
  const file = getProtocolFilePath(projectPath)
  if (!existsSync(file)) return null
  try {
    const content = await readFile(file, 'utf-8')
    const parsed = JSON.parse(content) as unknown
    if (isHistoryFile(parsed)) {
      return getCurrentMarker(parsed.history)
    }
    if (isLegacyMarker(parsed)) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

/**
 * 034-B: protocol.json の履歴を全件返す。
 * Edit Marker Dialog 内の履歴セクション（UX 課題 1）で使用。
 * v1 形式の場合は単一エントリを synthetic に生成して返す。
 */
export async function readProtocolHistory(
  projectPath: string
): Promise<ProtocolHistoryEntry[] | null> {
  const file = getProtocolFilePath(projectPath)
  if (!existsSync(file)) return null
  try {
    const content = await readFile(file, 'utf-8')
    const parsed = JSON.parse(content) as unknown
    if (isHistoryFile(parsed)) {
      return parsed.history
    }
    if (isLegacyMarker(parsed)) {
      // v1: 単一マーカーを synthetic な単一エントリとして返す
      // source は confidence='explicit' なら manual、それ以外は auto
      const source = parsed.detection_confidence === 'explicit' ? 'manual' : 'auto'
      return [{
        timestamp: new Date(0).toISOString(),  // v1 は timestamp 不明、epoch を fallback
        source,
        app_version: parsed.applied_by || 'ccpit-pre-2.0.0',
        marker: parsed,
      }]
    }
    return null
  } catch {
    return null
  }
}

/**
 * 034-B: 最新の manual エントリを返す。Full Re-scan の skip 判定用（軽量 IPC）。
 * manual エントリが無ければ null。v1 でも consistent に動作する（synthetic 経由）。
 */
export async function getLatestManualEntry(
  projectPath: string
): Promise<ProtocolHistoryEntry | null> {
  const history = await readProtocolHistory(projectPath)
  if (!history) return null
  const manuals = history.filter((e) => e.source === 'manual')
  if (manuals.length === 0) return null
  return manuals[manuals.length - 1]
}

// ── pure 関数（vitest 容易、I/O なし） ──

/**
 * 034-B: 履歴から「現在表示すべき marker」を計算する。
 *
 * 優先順位:
 *   1. 最新の manual エントリの marker（明示意思の尊重）
 *   2. 最新の auto エントリの marker（自動判定の最新値）
 *   3. 履歴が空 → null
 *
 * これは「最新の手動 > 最新の自動」のロジックを物理的構造で表現。
 * 計画書 r3 §2-C の核心実装。
 */
export function getCurrentMarker(history: ProtocolHistoryEntry[]): ProtocolMarker | null {
  if (history.length === 0) return null
  const manuals = history.filter((e) => e.source === 'manual')
  if (manuals.length > 0) return manuals[manuals.length - 1].marker
  return history[history.length - 1].marker
}

// ── 内部型ガード ──

function isHistoryFile(value: unknown): value is ProtocolHistoryFile {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return v.version === 2 && Array.isArray(v.history)
}

function isLegacyMarker(value: unknown): value is ProtocolMarker {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.protocol === 'string' && typeof v.revision === 'string'
}
