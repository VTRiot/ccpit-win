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

/** ディレクトリ内のファイル数を取得（任意で拡張子フィルタ） */
async function countFiles(dirPath: string, extFilter?: string): Promise<number> {
  if (!existsSync(dirPath)) return 0
  const entries = await readdir(dirPath, { withFileTypes: true })
  let n = 0
  for (const e of entries) {
    if (!e.isFile()) continue
    if (extFilter && !e.name.endsWith(extFilter)) continue
    n++
  }
  return n
}

/** ディレクトリ内の .md ファイル名一覧（sorted） */
async function listMdFiles(dirPath: string): Promise<string[]> {
  if (!existsSync(dirPath)) return []
  const entries = await readdir(dirPath, { withFileTypes: true })
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name)
    .sort()
}

/** skills/ 配下で SKILL.md を持つサブディレクトリ名一覧（sorted） */
async function listSkillNames(dirPath: string): Promise<string[]> {
  if (!existsSync(dirPath)) return []
  const entries = await readdir(dirPath, { withFileTypes: true })
  const out: string[] = []
  for (const e of entries) {
    if (e.isDirectory() && existsSync(join(dirPath, e.name, 'SKILL.md'))) out.push(e.name)
  }
  return out.sort()
}

/** ソート済み文字列配列の同値判定 */
function sameSortedList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/** ヘルスチェック実行 */
export async function runHealthCheck(): Promise<HealthCheckItem[]> {
  const userHome = app.getPath('home')
  const claudeDir = join(userHome, '.claude')
  const results: HealthCheckItem[] = []

  // deploySource 未定義時は 'golden' として扱う（後方互換）
  const cfg = getConfig()
  const deploySource = cfg.deploySource ?? 'golden'
  const usePitReference = deploySource === 'pit' && cfg.pitReference !== undefined

  // 1. settings.json — 常に Golden と比較（.pit デプロイは settings を触らないため）
  const settingsPath = join(claudeDir, 'settings.json')
  if (!existsSync(settingsPath)) {
    results.push({ name: 'settings.json', status: 'error', detail: 'Not found' })
  } else {
    try {
      const content = await readFile(settingsPath, 'utf-8')
      const json = JSON.parse(content)
      const denyCount = json.permissions?.deny?.length || 0

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

  // 2. CLAUDE.md — deploySource に応じて比較対象を切替
  const claudeMdPath = join(claudeDir, 'CLAUDE.md')
  if (!existsSync(claudeMdPath)) {
    results.push({ name: 'CLAUDE.md', status: 'error', detail: 'Not found' })
  } else if (usePitReference) {
    const currentHash = await fileHash(claudeMdPath)
    if (currentHash === cfg.pitReference!.claudeMdHash) {
      results.push({ name: 'CLAUDE.md', status: 'ok', detail: 'Matches imported .pit' })
    } else {
      results.push({ name: 'CLAUDE.md', status: 'warn', detail: 'Modified from imported .pit' })
    }
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

  // 3. rules/ — .bak を除外、deploySource に応じて一覧比較
  const rulesDir = join(claudeDir, 'rules')
  if (!existsSync(rulesDir)) {
    results.push({ name: 'rules/', status: 'warn', detail: 'Directory not found' })
  } else {
    const actualRules = await listMdFiles(rulesDir)
    if (usePitReference) {
      const expected = cfg.pitReference!.rulesList
      if (sameSortedList(expected, actualRules)) {
        results.push({ name: 'rules/', status: 'ok', detail: `${actualRules.length} rules` })
      } else {
        results.push({
          name: 'rules/',
          status: 'warn',
          detail: `Rules differ from imported .pit (${actualRules.length} present, ${expected.length} expected)`,
        })
      }
    } else {
      results.push({ name: 'rules/', status: 'ok', detail: `${actualRules.length} rules` })
    }
  }

  // 4. skills/ — {name}/SKILL.md パターン、deploySource に応じて比較
  const skillsDir = join(claudeDir, 'skills')
  const goldenSkillsDir = join(getCommonLangDir(), 'skills')
  if (!existsSync(skillsDir)) {
    results.push({ name: 'skills/', status: 'warn', detail: 'Directory not found' })
  } else {
    const actualSkills = await listSkillNames(skillsDir)
    if (usePitReference) {
      const expected = cfg.pitReference!.skillsList
      if (sameSortedList(expected, actualSkills)) {
        results.push({ name: 'skills/', status: 'ok', detail: `${actualSkills.length} skills` })
      } else {
        results.push({
          name: 'skills/',
          status: 'warn',
          detail: `Skills differ from imported .pit (${actualSkills.length} present, ${expected.length} expected)`,
        })
      }
    } else if (existsSync(goldenSkillsDir)) {
      const goldenCount = (await listSkillNames(goldenSkillsDir)).length
      if (actualSkills.length >= goldenCount) {
        results.push({ name: 'skills/', status: 'ok', detail: `${actualSkills.length} skills` })
      } else {
        results.push({
          name: 'skills/',
          status: 'warn',
          detail: `${actualSkills.length} skills (Golden has ${goldenCount})`,
        })
      }
    } else {
      results.push({ name: 'skills/', status: 'ok', detail: `${actualSkills.length} skills` })
    }
  }

  // 5. hooks/ — Golden と比較（.pit デプロイは hooks を触らないため常に Golden 基準）
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
