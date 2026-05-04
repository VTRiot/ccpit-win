export interface ProtocolMarkerView {
  protocol: string
  revision: string
  stage: 'stable' | 'beta' | 'alpha' | 'experimental'
  stage_inferred: boolean
  variant: string | null
  variant_alias: string | null
  applied_at: string | null
  applied_by: string
  detection_evidence: string | null
  detection_confidence: 'explicit' | 'high' | 'low' | 'unknown'
}

export const STAGE_COLOR: Record<ProtocolMarkerView['stage'], string> = {
  stable: 'bg-green-500/15 text-green-500 border-green-500/30',
  beta: 'bg-yellow-500/15 text-yellow-500 border-yellow-500/30',
  alpha: 'bg-orange-500/15 text-orange-500 border-orange-500/30',
  experimental: 'bg-red-500/15 text-red-500 border-red-500/30',
}

export const STAGE_SUFFIX: Record<ProtocolMarkerView['stage'], string> = {
  stable: '',
  beta: ' β',
  alpha: ' α',
  experimental: ' exp',
}

export interface BadgeView {
  text: string
  className: string
  isInferred: boolean
}

/**
 * 034: BadgeView.text の i18n マッピング（計画書 r2 §2-2 案 B 採用）。
 * 純粋関数 formatBadgeView はリテラル文字列を返し、ここで i18n キー解決を行う。
 *
 * 将来 i18n 化候補（本タスクスコープ外、マッピングテーブルの空席）:
 *   - 'Legacy' / 'Legacy *'        → pages.projects.protocolBadge.legacy
 *   - 'GOLDEN 5.0 β' 等の動的組立  → 動的キー化を要設計（revision/stage を i18n に渡す）
 *
 * テスト容易性のため component から lib に移動して純粋関数として配置。
 */
export function localizeBadgeText(text: string, translate: (key: string) => string): string {
  if (text === 'Untagged') return translate('pages.projects.protocolBadge.untagged')
  return text
}

export function formatBadgeView(m: ProtocolMarkerView | null): BadgeView | null {
  if (!m) return null

  if (m.protocol === 'legacy') {
    return {
      text: 'Legacy' + (m.stage_inferred ? ' *' : ''),
      className: 'bg-muted text-muted-foreground border-border',
      isInferred: m.stage_inferred,
    }
  }

  if (m.protocol === 'unknown') {
    if (m.detection_confidence === 'unknown') return null
    // 034: R3b 等で protocol='unknown' になったマーカーは中立表現「Untagged」で表示する。
    // 「MANX ?」表示は MANX 推進バイアス（希望的観測）の誤誘導を生むため廃止。
    // unknown 状態に「stage 推定」マーカー（*）は意味矛盾なので isInferred:false 固定。
    return {
      text: 'Untagged',
      className: 'bg-muted/40 text-muted-foreground border-border',
      isInferred: false,
    }
  }

  let main = `${m.protocol.toUpperCase()} ${m.revision}`
  if (m.variant) {
    main += m.variant_alias ? ` [${m.variant_alias}]` : ` (${m.variant})`
  }
  const stageMark = STAGE_SUFFIX[m.stage]
  const inferredMark = m.stage_inferred ? ' *' : ''
  return {
    text: `${main}${stageMark}${inferredMark}`,
    className: STAGE_COLOR[m.stage],
    isInferred: m.stage_inferred,
  }
}
