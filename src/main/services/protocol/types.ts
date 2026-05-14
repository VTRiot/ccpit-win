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
  // PIKES r1.3 §9-5 階層化必須化 (提案 2 案 1 確定、CCPIT v1.3 Refactor)
  // - pikesVersion: ランタイム必須 (新規 PJ は strictPikesValidation で必須適用、既存 PJ は warning fallback)
  // - os: PIKES r1.3 で必須化、osProtocolType 派生属性の起点
  // - osProtocolType: 派生属性 (PIKES r1.3 §9-6-2、os + {os}_version から autoMarker で計算)
  // TS 型は後方互換のため optional 据置、ランタイム検証は autoMarker 側で実施。
  pikesVersion?: string
  os?: 'manx' | 'macau' | 'asama'
  osProtocolType?: { type: 'manx' | 'macau' | 'asama'; version: string }
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
 * FSA r7 §5 / PIKES r1.3 §9-5: CLAUDE.md 冒頭 YAML フロントマター自己宣言。
 * MANX_Protocol r8 §9-5/§9-6 で憲法レベル成文化、CCPIT v1.3 で pikes_version + os + {os}_version 必須化。
 *
 * - manxVersion: 後方互換 (e.g. "r7", "r8", "r10")。`os: manx` の {os}_version フィールドとしても再利用。
 *   既存 21 PJ の `manx_version` 単独 PJ は warning fallback で従来動作維持。
 * - manxRole   : オプション (default: "managed")。pikes_role 命名移行は CCPIT v1.4 へ繰越。
 *   - "managed": グローバル ~/.claude/ MANX を継承運用 (Raiko/MdriveSetup)
 *   - "host"   : MANX を提供・管理する側、レガシー保護を内蔵 (CCDG2)
 *   - "local"  : PJ ローカルに完全 MANX 構造あり (R1/R2 該当)
 * - pikesVersion: PIKES r1.3 で必須化 (CCPIT v1.3、新規 PJ から strictPikesValidation で適用)。
 *   PIKES Protocol revision (e.g. "r1.3")。既存 PJ は warning fallback で manxVersion 単独判定。
 *   TS 型は後方互換のため optional 据置、ランタイム検証は autoMarker 側で実施。
 * - os         : PIKES r1.3 で必須化。"manx" (Windows) / "macau" (macOS) / "asama" (Linux)。
 *   osProtocolType 派生属性の起点。階層表記「PIKES r1.3 + MANX r10」並列バッジ表示に利用。
 */
export interface ManxFrontmatter {
  manxVersion: string
  manxRole: 'managed' | 'host' | 'local'
  // PIKES r1.3 §9-5 階層化必須化 (提案 2 案 1 確定、TS 型は後方互換 optional 据置)
  pikesVersion?: string
  os?: 'manx' | 'macau' | 'asama'
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
