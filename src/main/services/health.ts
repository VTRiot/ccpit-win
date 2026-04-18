import { readFile, readdir, stat } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'
import { createHash } from 'crypto'
import { app } from 'electron'
import { getConfig } from './appConfig'

const GOLDEN_DIR = app.isPackaged
  ? join(process.resourcesPath, 'golden')
  : join(__dirname, '../../golden')

function getCommonLangDir(): string {
  return join(GOLDEN_DIR, 'common', getConfig().language)
}

export interface HealthCheckItem {
  name: string
  status: 'ok' | 'warn' | 'error'
  detail: string
}

/** ファイルの SHA-256 ハッシュを計算 */
async function fileHash(filePath: string): Promise<string> {
  const content = await readFile(filePath)
  return createHash('sha256').update(content).digest('hex')
}

/** ディレクトリ内のファイル数を取得 */
async function countFiles(dirPath: string): Promise<number> {
  if (!existsSync(dirPath)) return 0
  const entries = await readdir(dirPath, { withFileTypes: true })
  return entries.filter((e) => e.isFile()).length
}

/** skills/ 配下の {name}/SKILL.md を持つサブディレクトリ数を取得 */
async function countSkills(dirPath: string): Promise<number> {
  if (!existsSync(dirPath)) return 0
  const entries = await readdir(dirPath, { withFileTypes: true })
  let n = 0
  for (const e of entries) {
    if (e.isDirectory() && existsSync(join(dirPath, e.name, 'SKILL.md'))) n++
  }
  return n
}

/** ヘルスチェック実行 */
export async function runHealthCheck(): Promise<HealthCheckItem[]> {
  const userHome = app.getPath('home')
  const claudeDir = join(userHome, '.claude')
  const results: HealthCheckItem[] = []

  // 1. settings.json
  const settingsPath = join(claudeDir, 'settings.json')
  if (!existsSync(settingsPath)) {
    results.push({ name: 'settings.json', status: 'error', detail: 'Not found' })
  } else {
    try {
      const content = await readFile(settingsPath, 'utf-8')
      const json = JSON.parse(content)
      const denyCount = json.permissions?.deny?.length || 0

      // Golden との比較
      const goldenSettingsPath = join(GOLDEN_DIR, 'manx', 'settings.json')
      if (existsSync(goldenSettingsPath)) {
        const goldenContent = await readFile(goldenSettingsPath, 'utf-8')
        const goldenJson = JSON.parse(goldenContent)
        const goldenDenyCount = goldenJson.permissions?.deny?.length || 0

        if (denyCount >= goldenDenyCount) {
          results.push({ name: 'settings.json', status: 'ok', detail: `${denyCount} deny rules` })
        } else {
          results.push({ name: 'settings.json', status: 'warn', detail: `${denyCount} deny rules (Golden has ${goldenDenyCount})` })
        }
      } else {
        results.push({ name: 'settings.json', status: 'ok', detail: `${denyCount} deny rules` })
      }
    } catch {
      results.push({ name: 'settings.json', status: 'error', detail: 'Invalid JSON' })
    }
  }

  // 2. CLAUDE.md
  const claudeMdPath = join(claudeDir, 'CLAUDE.md')
  if (!existsSync(claudeMdPath)) {
    results.push({ name: 'CLAUDE.md', status: 'error', detail: 'Not found' })
  } else {
    const info = await stat(claudeMdPath)
    const goldenClaude = join(getCommonLangDir(), 'CLAUDE.md')
    if (existsSync(goldenClaude)) {
      const currentHash = await fileHash(claudeMdPath)
      const goldenHash = await fileHash(goldenClaude)
      if (currentHash === goldenHash) {
        results.push({ name: 'CLAUDE.md', status: 'ok', detail: 'Matches Golden' })
      } else {
        results.push({ name: 'CLAUDE.md', status: 'warn', detail: 'Modified from Golden' })
      }
    } else {
      results.push({ name: 'CLAUDE.md', status: 'ok', detail: `${info.size} bytes` })
    }
  }

  // 3. rules/
  const rulesDir = join(claudeDir, 'rules')
  if (!existsSync(rulesDir)) {
    results.push({ name: 'rules/', status: 'warn', detail: 'Directory not found' })
  } else {
    const count = await countFiles(rulesDir)
    results.push({ name: 'rules/', status: 'ok', detail: `${count} files` })
  }

  // 4. skills/ — {name}/SKILL.md パターンで再帰カウント、Golden と件数比較
  const skillsDir = join(claudeDir, 'skills')
  const goldenSkillsDir = join(getCommonLangDir(), 'skills')
  if (!existsSync(skillsDir)) {
    results.push({ name: 'skills/', status: 'warn', detail: 'Directory not found' })
  } else {
    const count = await countSkills(skillsDir)
    if (existsSync(goldenSkillsDir)) {
      const goldenCount = await countSkills(goldenSkillsDir)
      if (count >= goldenCount) {
        results.push({ name: 'skills/', status: 'ok', detail: `${count} files` })
      } else {
        results.push({
          name: 'skills/',
          status: 'warn',
          detail: `${count} files (Golden has ${goldenCount})`,
        })
      }
    } else {
      results.push({ name: 'skills/', status: 'ok', detail: `${count} files` })
    }
  }

  // 5. hooks/ (MANX hooks Phase 1)
  const hooksDir = join(claudeDir, 'hooks')
  const goldenHooksDir = join(GOLDEN_DIR, 'common', 'hooks')
  if (!existsSync(hooksDir)) {
    results.push({ name: 'hooks/', status: 'error', detail: 'Directory not found' })
  } else if (existsSync(goldenHooksDir)) {
    const goldenScripts = (await readdir(goldenHooksDir)).filter((n) => n.endsWith('.sh'))
    const missing: string[] = []
    for (const name of goldenScripts) {
      if (!existsSync(join(hooksDir, name))) missing.push(name)
    }
    if (missing.length > 0) {
      results.push({ name: 'hooks/', status: 'error', detail: `Missing: ${missing.join(', ')}` })
    } else {
      results.push({ name: 'hooks/', status: 'ok', detail: `${goldenScripts.length} scripts` })
    }
  } else {
    const count = await countFiles(hooksDir)
    results.push({ name: 'hooks/', status: 'ok', detail: `${count} files` })
  }

  return results
}

/** deny リストを取得 */
export async function getDenyList(): Promise<string[]> {
  const userHome = app.getPath('home')
  const settingsPath = join(userHome, '.claude', 'settings.json')
  if (!existsSync(settingsPath)) return []

  try {
    const content = await readFile(settingsPath, 'utf-8')
    const json = JSON.parse(content)
    return json.permissions?.deny || []
  } catch {
    return []
  }
}

/** CC CLI の存在確認 */
export async function checkCcCli(): Promise<boolean> {
  const { execFile } = await import('child_process')
  return new Promise((resolve) => {
    execFile('claude', ['--version'], (err) => {
      resolve(!err)
    })
  })
}
