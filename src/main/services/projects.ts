import { readFile, writeFile, mkdir, copyFile } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'
import { app } from 'electron'

const PARC_FERME_DIR = join(app.getPath('home'), '.ccpit')
const PROJECTS_FILE = join(PARC_FERME_DIR, 'projects.json')

export interface ProjectEntry {
  name: string
  path: string
  status: 'manx' | 'legacy' | 'uninitialized'
  createdAt: string
}

async function ensureDir(dir: string): Promise<void> {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }
}

/** projects.json を読み込む */
export async function loadProjects(): Promise<ProjectEntry[]> {
  await ensureDir(PARC_FERME_DIR)
  if (!existsSync(PROJECTS_FILE)) return []
  const content = await readFile(PROJECTS_FILE, 'utf-8')
  return JSON.parse(content)
}

/** projects.json に保存 */
async function saveProjects(projects: ProjectEntry[]): Promise<void> {
  await ensureDir(PARC_FERME_DIR)
  await writeFile(PROJECTS_FILE, JSON.stringify(projects, null, 2), 'utf-8')
}

/** プロジェクトのステータスを判定 */
async function detectStatus(projectPath: string): Promise<'manx' | 'legacy' | 'uninitialized'> {
  const claudeMdPath = join(projectPath, 'CLAUDE.md')
  if (!existsSync(claudeMdPath)) return 'uninitialized'

  const content = await readFile(claudeMdPath, 'utf-8')
  if (content.includes('CCPIT managed') || content.includes('Parc Fermé managed')) return 'manx'
  return 'legacy'
}

const P4_TEMPLATE = `# CLAUDE.md — {{PROJECT_NAME}}

> CCPIT managed. グローバル構成: ~/.claude/

## プロジェクト定義
\`_Prompt\\_Prj\\\` 配下の最新 rev を参照すること。

## 環境
| 項目 | 値 |
|------|-----|
| 言語 | （要記入） |
| フレームワーク | （要記入） |

## 最上位命題
（要記入）
`

/** 新規プロジェクト作成 */
export async function createProject(
  projectPath: string,
  projectName: string
): Promise<{ success: boolean; created: string[]; errors: string[] }> {
  const result = { success: true, created: [] as string[], errors: [] as string[] }

  const filesToCreate: { path: string; content: string }[] = [
    {
      path: join(projectPath, 'CLAUDE.md'),
      content: P4_TEMPLATE.replace('{{PROJECT_NAME}}', projectName),
    },
    {
      path: join(projectPath, 'CLAUDE.local.md'),
      content: `# CLAUDE.local.md — ${projectName}\n\n> ローカル固有設定。Git にコミットしない。\n`,
    },
  ]

  const dirsToCreate = [
    join(projectPath, '.claude', 'rules'),
    join(projectPath, '_Prompt', '_Prj'),
    join(projectPath, '_Prompt', '_fromdesignai'),
    join(projectPath, '_Prompt', '_frombuilderai'),
  ]

  // ディレクトリ作成
  for (const dir of dirsToCreate) {
    try {
      await mkdir(dir, { recursive: true })
      result.created.push(dir)
    } catch (err) {
      result.errors.push(`${dir}: ${err instanceof Error ? err.message : String(err)}`)
      result.success = false
    }
  }

  // ファイル作成
  for (const file of filesToCreate) {
    try {
      if (existsSync(file.path)) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
        await copyFile(file.path, `${file.path}.bak.${timestamp}`)
      }
      await writeFile(file.path, file.content, 'utf-8')
      result.created.push(file.path)
    } catch (err) {
      result.errors.push(`${file.path}: ${err instanceof Error ? err.message : String(err)}`)
      result.success = false
    }
  }

  // projects.json に登録
  if (result.success) {
    const projects = await loadProjects()
    const existing = projects.findIndex((p) => p.path === projectPath)
    const entry: ProjectEntry = {
      name: projectName,
      path: projectPath,
      status: 'manx',
      createdAt: new Date().toISOString(),
    }
    if (existing >= 0) {
      projects[existing] = entry
    } else {
      projects.push(entry)
    }
    await saveProjects(projects)
  }

  return result
}

/** プロジェクト一覧を取得（ステータス再判定付き） */
export async function listProjects(): Promise<ProjectEntry[]> {
  const projects = await loadProjects()

  // ステータスを最新に更新
  for (const project of projects) {
    if (existsSync(project.path)) {
      project.status = await detectStatus(project.path)
    }
  }

  await saveProjects(projects)
  return projects
}

/** プロジェクトを削除（レジストリからのみ。ファイルは消さない） */
export async function removeProject(projectPath: string): Promise<void> {
  const projects = await loadProjects()
  const filtered = projects.filter((p) => p.path !== projectPath)
  await saveProjects(filtered)
}
