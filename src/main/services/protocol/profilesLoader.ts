import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { app } from 'electron'
import type { ProtocolProfile } from './types'

const CCPIT_DIR = join(app.getPath('home'), '.ccpit')
const PROFILES_FILE = join(CCPIT_DIR, 'protocol-profiles.json')

export const DEFAULT_STABLE_PROFILE: ProtocolProfile = {
  id: 'manx-r5-stable',
  label: 'MANX r5 stable',
  protocol: 'manx',
  revision: 'r5',
  stage: 'stable',
  stage_inferred: false,
  variant: null,
  variant_alias: null,
}

const DEFAULT_PROFILES: ProtocolProfile[] = [
  DEFAULT_STABLE_PROFILE,
  {
    id: 'manx-r5-beta-hooks',
    label: 'MANX r5 beta (hooks-bundled)',
    protocol: 'manx',
    revision: 'r5',
    stage: 'beta',
    stage_inferred: false,
    variant: 'hooks-bundled',
    variant_alias: 'Hot Hooks',
  },
  {
    id: 'manx-r5-alpha',
    label: 'MANX r5 alpha',
    protocol: 'manx',
    revision: 'r5',
    stage: 'alpha',
    stage_inferred: false,
    variant: null,
    variant_alias: null,
  },
]

export async function loadProfiles(): Promise<ProtocolProfile[]> {
  if (!existsSync(PROFILES_FILE)) {
    await mkdir(dirname(PROFILES_FILE), { recursive: true })
    await writeFile(
      PROFILES_FILE,
      JSON.stringify({ profiles: DEFAULT_PROFILES }, null, 2),
      'utf-8'
    )
    return DEFAULT_PROFILES
  }
  try {
    const content = await readFile(PROFILES_FILE, 'utf-8')
    const parsed = JSON.parse(content) as { profiles?: ProtocolProfile[] }
    return parsed.profiles ?? DEFAULT_PROFILES
  } catch {
    return DEFAULT_PROFILES
  }
}

export function getAvailableProfiles(
  profiles: ProtocolProfile[],
  debugMode: boolean
): ProtocolProfile[] {
  if (!debugMode) {
    return [DEFAULT_STABLE_PROFILE]
  }
  return profiles
}
