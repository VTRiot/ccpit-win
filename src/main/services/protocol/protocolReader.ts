import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import type { ProtocolMarker } from './types'

export const PROTOCOL_DIR = '.ccpit'
export const PROTOCOL_FILE = 'protocol.json'

export function getProtocolFilePath(projectPath: string): string {
  return join(projectPath, PROTOCOL_DIR, PROTOCOL_FILE)
}

export async function readProtocol(projectPath: string): Promise<ProtocolMarker | null> {
  const file = getProtocolFilePath(projectPath)
  if (!existsSync(file)) return null
  try {
    const content = await readFile(file, 'utf-8')
    return JSON.parse(content) as ProtocolMarker
  } catch {
    return null
  }
}
