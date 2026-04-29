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
    return {
      text: 'MANX ?' + (m.stage_inferred ? ' *' : ''),
      className: 'bg-emerald-300/20 text-emerald-500 border-emerald-500/30',
      isInferred: m.stage_inferred,
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
