import { writeFile, readFile, mkdir, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname } from 'path'
import { getProtocolFilePath } from './protocolReader'
import type {
  ProtocolMarker,
  ProtocolHistoryFile,
  ProtocolHistoryEntry,
  ProtocolEntrySource,
} from './types'

/**
 * @deprecated 034-B: 旧 API。append-only history 形式（appendProtocolEntry）に移行する。
 * Phase 2-D で全 caller 移行後に削除予定。それまでの typecheck 維持のため残置。
 */
export interface WriteOptions {
  force: boolean
}

/**
 * @deprecated 034-B: 旧 API。物理的上書きが破壊バグの原因だった。
 * 新 API: `appendProtocolEntry(projectPath, source, marker)` を使用。
 * Phase 2-D で削除予定。
 */
export async function writeProtocol(
  projectPath: string,
  marker: ProtocolMarker,
  opts: WriteOptions = { force: false }
): Promise<void> {
  const file = getProtocolFilePath(projectPath)
  if (!opts.force && existsSync(file)) {
    throw new Error(`protocol.json already exists at ${file}. Use force=true to overwrite.`)
  }
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(marker, null, 2), 'utf-8')
}

/**
 * 034-B: protocol.json v2 形式の append-only event log。
 *
 * 設計の核心（計画書 r3 §2-B）:
 *   - writeProtocol（旧 API）は「上書き」操作。これが破壊の原因だった。
 *   - 本 API は「履歴に追記」のみ行う。過去エントリは物理的に不変。
 *   - readProtocol は履歴から「最新 manual > 最新 auto」を計算（getCurrentMarker）。
 *
 * 既存 v1 (旧フラット形式) のファイルが存在する場合、in-place で v2 に変換してから append する。
 * v1 → v2 変換は protocolHistoryMigration.ts と同じロジック（confidence='explicit' なら manual）。
 *
 * @param projectPath PJ ルートパス（`.ccpit/protocol.json` の親ディレクトリ）
 * @param source     'auto' (自動判定) | 'manual' (手動編集)
 * @param marker     書き込む ProtocolMarker
 * @param now        テスト容易性のため上書き可能、デフォルトは現在時刻
 */
export async function appendProtocolEntry(
  projectPath: string,
  source: ProtocolEntrySource,
  marker: ProtocolMarker,
  now: Date = new Date()
): Promise<void> {
  const APP_VERSION = 'ccpit-1.0.0'
  const file = getProtocolFilePath(projectPath)
  await mkdir(dirname(file), { recursive: true })

  let history: ProtocolHistoryEntry[] = []

  if (existsSync(file)) {
    try {
      const content = await readFile(file, 'utf-8')
      const parsed = JSON.parse(content) as unknown
      if (isHistoryFile(parsed)) {
        // v2: 既存 history を引き継ぐ
        history = parsed.history.slice()
      } else if (isLegacyMarker(parsed)) {
        // v1: 旧マーカーを history の最初のエントリに変換（in-place migration）
        const legacyEntry = legacyToHistoryEntry(parsed, file)
        history = [await legacyEntry]
      }
      // それ以外（破損等）は空 history で初期化（NR-2）
    } catch {
      // JSON parse 不能 → 空 history で初期化、ログ警告
      console.warn(`[appendProtocolEntry] failed to parse existing protocol.json: ${file}, initializing empty history`)
    }
  }

  const newEntry: ProtocolHistoryEntry = {
    timestamp: now.toISOString(),
    source,
    app_version: APP_VERSION,
    marker,
  }
  history.push(newEntry)

  const out: ProtocolHistoryFile = {
    version: 2,
    history,
  }
  await writeFile(file, JSON.stringify(out, null, 2), 'utf-8')
}

// ── 内部ヘルパ（型ガードと変換） ──

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

async function legacyToHistoryEntry(
  legacy: ProtocolMarker,
  file: string
): Promise<ProtocolHistoryEntry> {
  // 旧 marker の confidence='explicit' なら manual、それ以外は auto
  // 計画書 r3 §5、NR-11 に基づく判定
  const source: ProtocolEntrySource = legacy.detection_confidence === 'explicit' ? 'manual' : 'auto'

  // applied_at が YYMMDDHHMM 形式ならそこから ISO 推定、無ければファイル mtime
  let timestamp: string
  if (legacy.applied_at && /^\d{10}$/.test(legacy.applied_at)) {
    timestamp = parseAppliedAtToIso(legacy.applied_at)
  } else {
    try {
      const s = await stat(file)
      timestamp = s.mtime.toISOString()
    } catch {
      timestamp = new Date().toISOString()
    }
  }

  return {
    timestamp,
    source,
    app_version: legacy.applied_by || 'ccpit-pre-2.0.0',
    marker: legacy,
  }
}

/**
 * 034-B: applied_at "YYMMDDHHMM" → ISO 8601。
 * 例: "2604300643" → "2026-04-30T06:43:00.000Z"
 * formatAppliedAt の逆関数（autoMarker.ts:251）。
 */
export function parseAppliedAtToIso(appliedAt: string): string {
  if (!/^\d{10}$/.test(appliedAt)) {
    return new Date().toISOString()
  }
  const yy = parseInt(appliedAt.slice(0, 2), 10)
  const mm = parseInt(appliedAt.slice(2, 4), 10)
  const dd = parseInt(appliedAt.slice(4, 6), 10)
  const hh = parseInt(appliedAt.slice(6, 8), 10)
  const min = parseInt(appliedAt.slice(8, 10), 10)
  // YY を 20YY と解釈（ccpit は 2026 開始のため、2000-2099 範囲）
  const fullYear = 2000 + yy
  // ローカルタイム解釈で Date 生成 → ISO 8601 (UTC) に変換
  const d = new Date(fullYear, mm - 1, dd, hh, min, 0, 0)
  return d.toISOString()
}
