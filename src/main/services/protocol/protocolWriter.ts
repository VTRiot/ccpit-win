import { writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname } from 'path'
import { getProtocolFilePath } from './protocolReader'
import type { ProtocolMarker } from './types'

export interface WriteOptions {
  force: boolean
}

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
