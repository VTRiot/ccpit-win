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
  status: 'ok' | 'warn' | 'error' | 'info'
  detail: string
}

/**
 * .pit ベースライン (rules/skills 名前リスト) との方向別差分判定。
 * - 完全一致: ok
 * - 追加のみ (host が superset): info（ユーザー追加は正常運用）
 * - 削除のみ / 削除＋追加混在: warn（.pit 由来機能が壊れる可能性）
 */
function diffAgainstPit(
  expected: string[],
  actual: string[],
  label: 'rules' | 'skills'
): { status: 'ok' | 'warn' | 'info'; detail: string } {
  const expectedSet = new Set(expected)
  const actualSet = new Set(actual)
  const added = actual.filter((x) => !expectedSet.has(x))
  const removed = expected.filter((x) => !actualSet.has(x))

  if (added.length === 0 && removed.length === 0) {
    return { status: 'ok', detail: `${actual.length} ${label}` }
  }
  if (removed.length === 0) {
    return { status: 'info', detail: `+${added.length} ${label} added since import` }
  }
  if (added.length === 0) {
    return {
      status: 'warn',
      detail: `-${removed.length} ${label} removed (could break .pit-based features)`,
    }
  }
  return {
    status: 'warn',
    detail: `${added.length} added, ${removed.length} removed`,
  }
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

/**
 * skills/ 配下で SKILL.md を持つサブディレクトリ名一覧（sorted）
 *
 * Flat: skills/<name>/SKILL.md → "<name>"
 * Grouping subdir (1 段ネスト): skills/<group>/<name>/SKILL.md → "<name>"
 *   例: skills/catalysts/dual-axis-translation/SKILL.md → "dual-axis-translation"
 *   グルーピング名 (catalysts 等) 自体は skill 名として返さない
 */
async function listSkillNames(dirPath: string): Promise<string[]> {
  if (!existsSync(dirPath)) return []
  const entries = await readdir(dirPath, { withFileTypes: true })
  const out: string[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const childPath = join(dirPath, e.name)
    if (existsSync(join(childPath, 'SKILL.md'))) {
      out.push(e.name)
      continue
    }
    const grandchildren = await readdir(childPath, { withFileTypes: true })
    for (const gc of grandchildren) {
      if (gc.isDirectory() && existsSync(join(childPath, gc.name, 'SKILL.md'))) {
        out.push(gc.name)
      }
    }
  }
  return out.sort()
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
      // ユーザー追記は正常運用 (CCPIT は設定 GUI、CLAUDE.md カスタマイズが目的)
      results.push({
        name: 'CLAUDE.md',
        status: 'info',
        detail: 'Modified from imported .pit (user-edited)',
      })
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
      const diff = diffAgainstPit(expected, actualRules, 'rules')
      results.push({ name: 'rules/', status: diff.status, detail: diff.detail })
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
      const diff = diffAgainstPit(expected, actualSkills, 'skills')
      results.push({ name: 'skills/', status: diff.status, detail: diff.detail })
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
