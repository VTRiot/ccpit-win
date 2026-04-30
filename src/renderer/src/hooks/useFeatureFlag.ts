import { useState, useEffect } from 'react'

export type FeatureKey =
  | 'ccLaunchButton'
  | 'detectLinkRemove'
  | 'protocolBadge'
  | 'favoriteToggle'
  | 'autoMarking'
  | 'editMarkerUI'

export type FeatureFlags = Record<FeatureKey, { enabled: boolean }>

export const FEATURE_KEYS: readonly FeatureKey[] = [
  'ccLaunchButton',
  'detectLinkRemove',
  'protocolBadge',
  'favoriteToggle',
  'autoMarking',
  'editMarkerUI',
] as const

export const DEFAULT_FEATURES: FeatureFlags = {
  ccLaunchButton: { enabled: true },
  detectLinkRemove: { enabled: true },
  protocolBadge: { enabled: true },
  favoriteToggle: { enabled: true },
  autoMarking: { enabled: true },
  editMarkerUI: { enabled: true },
}

let cached: FeatureFlags = { ...DEFAULT_FEATURES }
let initialized = false
const listeners = new Set<() => void>()

async function fetchFeatures(): Promise<void> {
  const cfg = await window.api.configGet()
  cached = cfg.features
  initialized = true
  listeners.forEach((l) => l())
}

export function useFeatureFlags(): FeatureFlags {
  const [, force] = useState(0)
  useEffect(() => {
    const cb = (): void => force((n) => n + 1)
    listeners.add(cb)
    if (!initialized) void fetchFeatures()
    return (): void => {
      listeners.delete(cb)
    }
  }, [])
  return cached
}

export function useFeatureFlag(key: FeatureKey): boolean {
  const flags = useFeatureFlags()
  return flags[key]?.enabled ?? false
}

export async function setFeatureFlag(key: FeatureKey, enabled: boolean): Promise<void> {
  const partial: Partial<FeatureFlags> = { [key]: { enabled } } as Partial<FeatureFlags>
  await window.api.configSet({ features: partial })
  await fetchFeatures()
}

export async function resetFeatureFlags(): Promise<void> {
  await window.api.configSet({ features: { ...DEFAULT_FEATURES } })
  await fetchFeatures()
}
