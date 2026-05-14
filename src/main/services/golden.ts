import { readdir, readFile, copyFile, mkdir, writeFile, chmod } from 'fs/promises'
import { join, relative } from 'path'
import { existsSync } from 'fs'
import { app } from 'electron'
import { getConfig, setConfig } from './appConfig'

const GOLDEN_DIR = app.isPackaged
  ? join(process.resourcesPath, 'golden')
  : join(__dirname, '../../golden')

// PIKES r1 §4-3 + 提案 3 (CCPIT v1.1 Phase E-4): deny マージ用 SSoT ファイル名
const DENY_BASE_FILENAME = 'settings.deny-base.json'
const DENY_EXTRA_FILENAME = 'settings.deny-extra.json'

/** common/ 配下の言語依存ディレクトリを返す（app-config.language に従う） */
function getCommonLangDir(): string {
  const lang = getConfig().language
  return join(GOLDEN_DIR, 'common', lang)
}

/** common/hooks（言語非依存） */
function getCommonHooksDir(): string {
  return join(GOLDEN_DIR, 'common', 'hooks')
}

/**
 * PIKES r1 §4-3 + 提案 3 (CCPIT v1.1 Phase E-4):
 * common/settings.deny-base.json (PIKES 共通 21 件) + {template}/settings.deny-extra.json (OS 固有) を読込し、
 * union (重複除去 + 順序保持) で 1 つの deny 配列を返す。
 * ファイル不在時は空配列にフォールバック (壊さない設計)。
 */
async function readMergedDenyList(templateDir: string): Promise<string[]> {
  const denySet = new Set<string>()
  const baseDenyPath = join(GOLDEN_DIR, 'common', DENY_BASE_FILENAME)
  if (existsSync(baseDenyPath)) {
    try {
      const base = JSON.parse(await readFile(baseDenyPath, 'utf-8')) as string[]
      for (const item of base) denySet.add(item)
    } catch {
      // パース失敗時は基底スキップ (起動信頼性優先、警告は呼び出し側で記録)
    }
  }
  const extraDenyPath = join(templateDir, DENY_EXTRA_FILENAME)
  if (existsSync(extraDenyPath)) {
    try {
      const extra = JSON.parse(await readFile(extraDenyPath, 'utf-8')) as string[]
      for (const item of extra) denySet.add(item)
    } catch {
      // 同上
    }
  }
  return [...denySet]
}

/**
 * PIKES r1 (Phase E-4): settings.deny-base.json / settings.deny-extra.json は
 * deploy 時に deny 配列にマージされる「素材ファイル」であり、~/.claude/ 直配置は不要。
 * mergedFiles / previewDeploy の対象から除外する。
 */
function isDenySourceFile(relPath: string): boolean {
  const basename = relPath.split(/[\\/]/).pop() ?? ''
  return basename === DENY_BASE_FILENAME || basename === DENY_EXTRA_FILENAME
}

/** 再帰的にディレクトリ内の全ファイルパスを取得 */
async function walkDir(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const paths: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      paths.push(...(await walkDir(full)))
    } else {
      paths.push(full)
    }
  }
  return paths
}

/** 再帰的にサブディレクトリの相対パスを収集 */
async function walkDirs(dir: string, base: string): Promise<string[]> {
  if (!existsSync(dir)) return []
  const entries = await readdir(dir, { withFileTypes: true })
  const dirs: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const full = join(dir, entry.name)
      const rel = relative(base, full)
      dirs.push(rel)
      dirs.push(...(await walkDirs(full, base)))
    }
  }
  return dirs
}

/** 利用可能なテンプレート一覧を返す */
export async function listTemplates(): Promise<string[]> {
  const entries = await readdir(GOLDEN_DIR, { withFileTypes: true })
  return entries
    .filter((e) => e.isDirectory() && e.name !== 'common')
    .map((e) => e.name)
}

/** common/{lang} + common/hooks + 指定テンプレートをマージした展開プレビューを返す */
export async function previewDeploy(
  templateName: string
): Promise<{ relativePath: string; source: 'common' | string }[]> {
  const commonLangDir = getCommonLangDir()
  const commonHooksDir = getCommonHooksDir()
  const templateDir = join(GOLDEN_DIR, templateName)
  const result: { relativePath: string; source: 'common' | string }[] = []
  const seen = new Set<string>()

  // テンプレート優先（同名ファイルは common を上書き）
  if (existsSync(templateDir)) {
    const files = await walkDir(templateDir)
    for (const f of files) {
      const rel = relative(templateDir, f)
      if (rel.endsWith('.gitkeep')) continue
      if (isDenySourceFile(rel)) continue // Phase E-4: deny マージ素材は配置対象外
      seen.add(rel)
      result.push({ relativePath: rel, source: templateName })
    }
  }

  // 言語依存ファイル（common/{lang}/ 配下を common 相対として扱う）
  if (existsSync(commonLangDir)) {
    const files = await walkDir(commonLangDir)
    for (const f of files) {
      const rel = relative(commonLangDir, f)
      if (rel.endsWith('.gitkeep')) continue
      if (isDenySourceFile(rel)) continue // Phase E-4
      if (seen.has(rel)) continue
      seen.add(rel)
      result.push({ relativePath: rel, source: 'common' })
    }
  }

  // 言語非依存の hooks（common/hooks/*.sh → hooks/*.sh）
  if (existsSync(commonHooksDir)) {
    const files = await walkDir(commonHooksDir)
    for (const f of files) {
      const rel = join('hooks', relative(commonHooksDir, f))
      if (rel.endsWith('.gitkeep')) continue
      if (seen.has(rel)) continue
      seen.add(rel)
      result.push({ relativePath: rel, source: 'common' })
    }
  }

  // .gitkeep のみのディレクトリ（rules/, skills/ 等）もプレビューに含める
  const dirsSeen = new Set<string>()
  const dirSources: [string, 'common' | string][] = [
    [templateDir, templateName],
    [commonLangDir, 'common'],
  ]
  for (const [src, label] of dirSources) {
    if (!existsSync(src)) continue
    for (const rel of await walkDirs(src, src)) {
      if (dirsSeen.has(rel)) continue
      dirsSeen.add(rel)
      result.push({ relativePath: rel + '/', source: label })
    }
  }
  // hooks ディレクトリ自体
  if (existsSync(commonHooksDir) && !dirsSeen.has('hooks')) {
    dirsSeen.add('hooks')
    result.push({ relativePath: 'hooks/', source: 'common' })
  }

  return result
}

export interface DeployResult {
  deployed: string[]
  backedUp: string[]
  errors: string[]
}

/** Golden テンプレートを ~/.claude/ に展開する */
export async function deploy(
  templateName: string,
  password: string
): Promise<DeployResult> {
  const userHome = app.getPath('home')
  const targetDir = join(userHome, '.claude')
  const commonLangDir = getCommonLangDir()
  const commonHooksDir = getCommonHooksDir()
  const templateDir = join(GOLDEN_DIR, templateName)

  const result: DeployResult = { deployed: [], backedUp: [], errors: [] }

  // マージ順: common/{lang} → common/hooks → template（template が上書き）
  const mergedFiles = new Map<string, string>() // relativePath → sourceAbsPath

  if (existsSync(commonLangDir)) {
    for (const f of await walkDir(commonLangDir)) {
      const rel = relative(commonLangDir, f)
      if (rel.endsWith('.gitkeep')) continue
      if (isDenySourceFile(rel)) continue // Phase E-4: deny マージ素材は配置対象外
      mergedFiles.set(rel, f)
    }
  }

  if (existsSync(commonHooksDir)) {
    for (const f of await walkDir(commonHooksDir)) {
      const rel = join('hooks', relative(commonHooksDir, f))
      if (rel.endsWith('.gitkeep')) continue
      mergedFiles.set(rel, f)
    }
  }

  if (existsSync(templateDir)) {
    for (const f of await walkDir(templateDir)) {
      const rel = relative(templateDir, f)
      if (rel.endsWith('.gitkeep')) continue
      if (isDenySourceFile(rel)) continue // Phase E-4
      mergedFiles.set(rel, f)
    }
  }

  for (const [rel, srcPath] of mergedFiles) {
    const destPath = join(targetDir, rel)
    const destDir = join(destPath, '..')

    try {
      await mkdir(destDir, { recursive: true })

      // 既存ファイルのバックアップ
      if (existsSync(destPath)) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
        const bakPath = `${destPath}.bak.${timestamp}`
        await copyFile(destPath, bakPath)
        result.backedUp.push(bakPath)
      }

      // settings.json は password 注入 + PIKES r1 §4-3 deny マージ (CCPIT v1.1 Phase E-4)
      if (rel === 'settings.json') {
        const content = await readFile(srcPath, 'utf-8')
        const json = JSON.parse(content)
        if (json.auth) {
          json.auth.password = password
        }
        // PIKES 共通 21 件 + {template} 固有 extra を deny にマージ (union)
        const mergedDeny = await readMergedDenyList(templateDir)
        const existingDeny = Array.isArray(json.permissions?.deny)
          ? (json.permissions.deny as string[])
          : []
        const denyUnion = new Set<string>([...mergedDeny, ...existingDeny])
        json.permissions = { ...(json.permissions ?? {}), deny: [...denyUnion] }
        await writeFile(destPath, JSON.stringify(json, null, 2), 'utf-8')
      } else {
        await copyFile(srcPath, destPath)
      }

      // hooks/*.sh は実行権限を付与（MANX hooks Phase 1）
      const relNorm = rel.replace(/\\/g, '/')
      if (relNorm.startsWith('hooks/') && relNorm.endsWith('.sh')) {
        await chmod(destPath, 0o755)
      }

      result.deployed.push(rel)
    } catch (err) {
      result.errors.push(`${rel}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // .gitkeep のみのディレクトリ（rules/, skills/ 等）も作成
  const dirsToCreate = new Set<string>()
  for (const src of [commonLangDir, templateDir]) {
    if (existsSync(src)) {
      for (const rel of await walkDirs(src, src)) {
        dirsToCreate.add(rel)
      }
    }
  }
  if (existsSync(commonHooksDir)) {
    dirsToCreate.add('hooks')
  }
  for (const rel of dirsToCreate) {
    const destDir = join(targetDir, rel)
    if (!existsSync(destDir)) {
      await mkdir(destDir, { recursive: true })
      result.deployed.push(rel + '/')
    }
  }

  // Fresh Start 完了 — deploySource を 'golden' に固定し pitReference をクリア
  setConfig({ deploySource: 'golden', pitReference: undefined })

  return result
}

/** ~/.claude/settings.json の存在確認 */
export async function checkExisting(): Promise<{
  exists: boolean
  hasSettings: boolean
  hasClaude: boolean
}> {
  const userHome = app.getPath('home')
  const claudeDir = join(userHome, '.claude')
  const settingsPath = join(claudeDir, 'settings.json')
  const claudeMdPath = join(claudeDir, 'CLAUDE.md')

  return {
    exists: existsSync(claudeDir),
    hasSettings: existsSync(settingsPath),
    hasClaude: existsSync(claudeMdPath),
  }
}
