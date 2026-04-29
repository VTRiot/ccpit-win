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
