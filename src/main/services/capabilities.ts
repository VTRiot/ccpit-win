import type { LocationType } from './projects'

export interface Capabilities {
  detect: boolean
  remove: boolean
  launch: boolean
  setup: boolean
  testDeny: boolean
}

export const CAPABILITY: Record<LocationType, Capabilities> = {
  local: { detect: true, remove: true, launch: true, setup: true, testDeny: true },
  'remote-readonly': {
    detect: true,
    remove: false,
    launch: false,
    setup: false,
    testDeny: false,
  },
  'remote-full': {
    detect: true,
    remove: true,
    launch: true,
    setup: true,
    testDeny: false,
  },
}

export function canPerform(
  meta: { location_type?: LocationType },
  op: keyof Capabilities
): boolean {
  const lt = meta.location_type ?? 'local'
  return CAPABILITY[lt][op]
}
