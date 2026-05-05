export type Stage = 'stable' | 'beta' | 'alpha' | 'experimental'
export type DetectionConfidence = 'explicit' | 'high' | 'low' | 'unknown'

export interface ProtocolMarker {
  protocol: string
  revision: string
  stage: Stage
  stage_inferred: boolean
  variant: string | null
  variant_alias: string | null
  applied_at: string | null
  applied_by: string
  detection_evidence: string | null
  detection_confidence: DetectionConfidence
}

export interface ProtocolProfile {
  id: string
  label: string
  protocol: string
  revision: string
  stage: Stage
  stage_inferred: false
  variant: string | null
  variant_alias: string | null
}

/**
 * FSA r7 §5: CLAUDE.md 冒頭 YAML フロントマター自己宣言。
 * MANX_Protocol r8 §9-5/§9-6 で憲法レベル成文化される仕様。
 *
 * - manxVersion: 必須 (e.g. "r7", "r8")
 * - manxRole   : オプション (default: "managed")
 *   - "managed": グローバル ~/.claude/ MANX を継承運用 (Raiko/MdriveSetup)
 *   - "host"   : MANX を提供・管理する側、レガシー保護を内蔵 (CCDG2)
 *   - "local"  : PJ ローカルに完全 MANX 構造あり (R1/R2 該当)
 */
export interface ManxFrontmatter {
  manxVersion: string
  manxRole: 'managed' | 'host' | 'local'
}

// 034-B: 履歴形式 (protocol.json v2)
//
// 「明示意思」の出所証跡を単一の `source` フィールドで表現する union 型。
// 新しい出所証跡を追加する場合は必ずこの union を拡張すること（型 5 違反防止）。
// CONTRIBUTING で同規約を明示。
export type ProtocolEntrySource = 'auto' | 'manual'

// 034-B: 各履歴エントリ。append-only event log の単位。
// timestamp は ISO 8601 ミリ秒精度で順序保証。marker は既存 ProtocolMarker を再利用。
export interface ProtocolHistoryEntry {
  timestamp: string             // ISO 8601 UTC ミリ秒
  source: ProtocolEntrySource   // 単一の出所証跡（型 5 違反防止）
  app_version: string           // 'ccpit-1.0.0' 等
  marker: ProtocolMarker
}

// 034-B: protocol.json v2 形式。
// version 1 (旧フラット形式) と区別するための version field。
// history は append-only、timestamp 昇順。物理的に上書きが起きない構造。
export interface ProtocolHistoryFile {
  version: 2
  history: ProtocolHistoryEntry[]
}
