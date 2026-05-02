/**
 * settingsChange — `~/.claude/settings.json` への変更案を CC Request Inbox で受理 / 適用 / ロールバックするサービス。
 *
 * 設計原則 (031):
 * - CC は settings.json を Read のみ。編集は Electron Main プロセスのみ。
 * - 認証なし・バックアップなしの apply を構造的に存在させない。
 * - JSON 構文エラーは適用前 / 適用後の双方で検証。書込後検証 fail 時に自動ロールバック。
 * - パスは引数で上書き可能（テスト容易性のため、`os.homedir()` 由来の既定値）。
 */

import { readFile, writeFile, mkdir, copyFile, appendFile, readdir, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const REQUIRED_FRONTMATTER_KEYS = [
  'request_id',
  'created_at',
  'purpose',
  'target',
  'status'
] as const

const VALID_STATUSES = ['pending', 'applied', 'rolled_back', 'rejected'] as const

export type ChangeRequestStatus = (typeof VALID_STATUSES)[number]

export interface ChangeRequestFrontmatter {
  request_id: string
  created_at: string
  purpose: string
  target: string
  status: ChangeRequestStatus
}

export interface ChangeRequest {
  filePath: string
  frontmatter: ChangeRequestFrontmatter
  rawMarkdown: string
  proposedSettingsJson: string
  proposedSettingsParsed: unknown | null
  parseError: string | null
}

export interface ApplyResult {
  success: boolean
  backupPath?: string
  appliedAt?: string
  error?: string
  rolledBack?: boolean
}

export interface ChangeLogEntry {
  timestamp: string
  request_id: string
  purpose: string
  result: 'applied' | 'rolled_back' | 'failed'
  backup_path: string
  error?: string
}

export interface SettingsBackup {
  id: string // timestamp portion of filename
  path: string
  sizeBytes: number
}

export interface SettingsPaths {
  claudeDir: string
  settingsJsonPath: string
  parcFermeDir: string
  backupsDir: string
  changeLogPath: string
}

/** 既定パス（本番）。テストでは引数で上書きする。 */
export function getDefaultSettingsPaths(): SettingsPaths {
  const home = homedir()
  const claudeDir = join(home, '.claude')
  const parcFermeDir = join(home, '.ccpit')
  return {
    claudeDir,
    settingsJsonPath: join(claudeDir, 'settings.json'),
    parcFermeDir,
    backupsDir: join(parcFermeDir, 'settings-backups'),
    changeLogPath: join(parcFermeDir, 'settings-change-log.jsonl')
  }
}

// --- Frontmatter parser (YAML-ish, key: value lines, no nesting) ---

interface ParseFrontmatterOk {
  ok: true
  data: Record<string, string>
}
interface ParseFrontmatterErr {
  ok: false
  error: string
}

function parseFrontmatter(yaml: string): ParseFrontmatterOk | ParseFrontmatterErr {
  const data: Record<string, string> = {}
  const lines = yaml.split(/\r?\n/)
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/)
    if (!m) return { ok: false, error: `invalid frontmatter line: ${line}` }
    let value = m[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    data[m[1]] = value
  }
  return { ok: true, data }
}

/**
 * settings-change-request.md を読み込んでパースする。
 * 失敗ケースは throw でクライアントに返す（Renderer 側で error 表示）。
 */
export async function parseChangeRequestMd(filePath: string): Promise<ChangeRequest> {
  const raw = await readFile(filePath, 'utf-8')

  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!fmMatch) {
    throw new Error('frontmatter not found (expected --- delimited block at file head)')
  }

  const fmResult = parseFrontmatter(fmMatch[1])
  if (!fmResult.ok) throw new Error(fmResult.error)

  for (const key of REQUIRED_FRONTMATTER_KEYS) {
    if (!(key in fmResult.data)) {
      throw new Error(`required frontmatter key missing: ${key}`)
    }
  }

  const status = fmResult.data.status as ChangeRequestStatus
  if (!VALID_STATUSES.includes(status)) {
    throw new Error(`invalid status: ${fmResult.data.status}`)
  }

  const frontmatter: ChangeRequestFrontmatter = {
    request_id: fmResult.data.request_id,
    created_at: fmResult.data.created_at,
    purpose: fmResult.data.purpose,
    target: fmResult.data.target,
    status
  }

  const body = fmMatch[2]

  // Section 3 = 「変更後の完成版」。最初の ```json fenced block を取得。
  const sect3 = body.match(/##\s*3\.[^\n]*\n([\s\S]*?)(?=\n##\s|$)/)
  if (!sect3) {
    throw new Error('section "## 3." not found (expected the proposed JSON section)')
  }

  const jsonBlock = sect3[1].match(/```json\r?\n([\s\S]*?)\r?\n```/)
  if (!jsonBlock) {
    throw new Error('JSON code block not found in section 3 (expected ```json ... ``` fence)')
  }

  const proposedSettingsJson = jsonBlock[1]
  let proposedSettingsParsed: unknown | null = null
  let parseError: string | null = null
  try {
    proposedSettingsParsed = JSON.parse(proposedSettingsJson)
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err)
  }

  return {
    filePath,
    frontmatter,
    rawMarkdown: raw,
    proposedSettingsJson,
    proposedSettingsParsed,
    parseError
  }
}

/** 現在の settings.json を文字列として返す。存在しなければ空文字列。 */
export async function readSettingsJson(
  paths: SettingsPaths = getDefaultSettingsPaths()
): Promise<string> {
  if (!existsSync(paths.settingsJsonPath)) return ''
  return readFile(paths.settingsJsonPath, 'utf-8')
}

/** auth.password が登録されているか。 */
export async function hasPasswordRegistered(
  paths: SettingsPaths = getDefaultSettingsPaths()
): Promise<boolean> {
  const raw = await readSettingsJson(paths)
  if (!raw) return false
  try {
    const json = JSON.parse(raw) as { auth?: { password?: unknown } }
    return typeof json.auth?.password === 'string' && (json.auth.password as string).length > 0
  } catch {
    return false
  }
}

/**
 * パスワード検証。
 * - settings.json が存在しない場合は true（初回 setup 想定）
 * - auth.password が未設定の場合は true（認証スキップ）
 * - パスワードが設定されている場合のみ厳密一致を要求
 */
export async function verifyPassword(
  input: string,
  paths: SettingsPaths = getDefaultSettingsPaths()
): Promise<boolean> {
  const raw = await readSettingsJson(paths)
  if (!raw) return true
  try {
    const json = JSON.parse(raw) as { auth?: { password?: unknown } }
    const stored = json.auth?.password
    if (typeof stored !== 'string' || stored.length === 0) return true
    return input === stored
  } catch {
    return false
  }
}

/** settings.json をタイムスタンプ付きで単一ファイル backup する。 */
export async function takeSettingsBackup(
  paths: SettingsPaths = getDefaultSettingsPaths()
): Promise<string> {
  await mkdir(paths.backupsDir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = join(paths.backupsDir, `${ts}-settings.json`)
  if (existsSync(paths.settingsJsonPath)) {
    await copyFile(paths.settingsJsonPath, backupPath)
  } else {
    // 新規作成扱い。空ファイルを sentinel として残す。
    await writeFile(backupPath, '', 'utf-8')
  }
  return backupPath
}

export async function listSettingsBackups(
  paths: SettingsPaths = getDefaultSettingsPaths()
): Promise<SettingsBackup[]> {
  if (!existsSync(paths.backupsDir)) return []
  const files = await readdir(paths.backupsDir)
  const out: SettingsBackup[] = []
  for (const name of files) {
    if (!name.endsWith('-settings.json')) continue
    const full = join(paths.backupsDir, name)
    const st = await stat(full)
    out.push({
      id: name.replace(/-settings\.json$/, ''),
      path: full,
      sizeBytes: st.size
    })
  }
  return out.sort((a, b) => b.id.localeCompare(a.id))
}

async function appendChangeLog(entry: ChangeLogEntry, paths: SettingsPaths): Promise<void> {
  await mkdir(paths.parcFermeDir, { recursive: true })
  await appendFile(paths.changeLogPath, JSON.stringify(entry) + '\n', 'utf-8')
}

export async function listChangeLogs(
  paths: SettingsPaths = getDefaultSettingsPaths()
): Promise<ChangeLogEntry[]> {
  if (!existsSync(paths.changeLogPath)) return []
  const raw = await readFile(paths.changeLogPath, 'utf-8')
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== '')
  const out: ChangeLogEntry[] = []
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as ChangeLogEntry)
    } catch {
      // skip malformed line
    }
  }
  return out.reverse() // newest first
}

/**
 * 変更案を適用する（本機能の心臓部）。手順は厳密に以下の順序:
 *
 *   Step 1. 認証チェック         — fail なら早期 return（バックアップも取らない）
 *   Step 2. 提案 JSON 構文検証   — fail なら failure ログのみ追記して return
 *   Step 3. settings.json バックアップ取得（書込前）
 *   Step 4. settings.json 書込
 *   Step 5. 書込後 JSON 構文再検証
 *   Step 6. 検証 fail 時は backup から自動ロールバック
 *   Step 7. 結果をログ追記
 *
 * `paths` は test では明示指定、本番では `getDefaultSettingsPaths()` 由来の `~/.claude/`。
 */
export async function applyChange(
  request: ChangeRequest,
  password: string,
  paths: SettingsPaths = getDefaultSettingsPaths()
): Promise<ApplyResult> {
  // Step 1: Authentication
  const authOk = await verifyPassword(password, paths)
  if (!authOk) {
    return { success: false, error: 'authentication failed' }
  }

  // Step 2: Validate proposed JSON
  if (request.parseError !== null || request.proposedSettingsParsed === null) {
    const err = request.parseError ?? 'proposed JSON not parsed'
    await appendChangeLog(
      {
        timestamp: new Date().toISOString(),
        request_id: request.frontmatter.request_id,
        purpose: request.frontmatter.purpose,
        result: 'failed',
        backup_path: '',
        error: err
      },
      paths
    )
    return { success: false, error: `JSON syntax error: ${err}` }
  }

  // Step 3: Take backup BEFORE writing
  const backupPath = await takeSettingsBackup(paths)

  // Step 4: Write
  const proposedFormatted = JSON.stringify(request.proposedSettingsParsed, null, 2)
  try {
    await mkdir(paths.claudeDir, { recursive: true })
    await writeFile(paths.settingsJsonPath, proposedFormatted, 'utf-8')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await appendChangeLog(
      {
        timestamp: new Date().toISOString(),
        request_id: request.frontmatter.request_id,
        purpose: request.frontmatter.purpose,
        result: 'failed',
        backup_path: backupPath,
        error: `write failed: ${msg}`
      },
      paths
    )
    return { success: false, backupPath, error: `write failed: ${msg}` }
  }

  // Step 5: Post-write verification
  let verifyError: string | null = null
  try {
    const postRaw = await readFile(paths.settingsJsonPath, 'utf-8')
    JSON.parse(postRaw)
  } catch (err) {
    verifyError = err instanceof Error ? err.message : String(err)
  }

  if (verifyError !== null) {
    // Auto-rollback
    let rolledBack = false
    try {
      if (existsSync(backupPath)) {
        const backupContent = await readFile(backupPath, 'utf-8')
        if (backupContent.length > 0) {
          await copyFile(backupPath, paths.settingsJsonPath)
          rolledBack = true
        }
      }
    } catch {
      // rollback failed; user must restore manually from backupPath
    }
    await appendChangeLog(
      {
        timestamp: new Date().toISOString(),
        request_id: request.frontmatter.request_id,
        purpose: request.frontmatter.purpose,
        result: rolledBack ? 'rolled_back' : 'failed',
        backup_path: backupPath,
        error: `post-write verification failed: ${verifyError}`
      },
      paths
    )
    return {
      success: false,
      backupPath,
      error: `post-write verification failed: ${verifyError}`,
      rolledBack
    }
  }

  const appliedAt = new Date().toISOString()
  await appendChangeLog(
    {
      timestamp: appliedAt,
      request_id: request.frontmatter.request_id,
      purpose: request.frontmatter.purpose,
      result: 'applied',
      backup_path: backupPath
    },
    paths
  )

  return { success: true, backupPath, appliedAt }
}

/** 指定 backup から settings.json を復元する。 */
export async function rollbackToBackup(
  backupId: string,
  paths: SettingsPaths = getDefaultSettingsPaths()
): Promise<{ success: boolean; error?: string }> {
  const backupPath = join(paths.backupsDir, `${backupId}-settings.json`)
  if (!existsSync(backupPath)) {
    return { success: false, error: 'backup not found' }
  }
  try {
    await copyFile(backupPath, paths.settingsJsonPath)
    await appendChangeLog(
      {
        timestamp: new Date().toISOString(),
        request_id: `rollback:${backupId}`,
        purpose: 'manual rollback',
        result: 'rolled_back',
        backup_path: backupPath
      },
      paths
    )
    return { success: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, error: msg }
  }
}
