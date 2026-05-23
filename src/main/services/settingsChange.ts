/**
 * settingsChange — `~/.claude/settings.json` および `~/.claude/skills/<name>/SKILL.md` への
 * 変更案を CC Request Inbox で受理 / 適用 / ロールバックするサービス。
 *
 * 設計原則 (031 + PIKES r1.4 §7-3-A):
 * - CC は対象資産を Read のみ。編集は Electron Main プロセスのみ。
 * - 認証なし・バックアップなしの apply を構造的に存在させない。
 * - kind:settings は JSON 構文を適用前後で検証、kind:skill はバイト列等価で検証。
 *   いずれも書込後検証 fail 時に自動ロールバック。
 * - path 正規化 (§7-3-A 第 3 項): glob 拒否 / UNC 拒否 / realpath / 完全一致判定。
 * - 認証要件 (§7-3-A 第 4 項): kind:skill では auth.password 未設定環境では apply 許可しない。
 * - パスは引数で上書き可能（テスト容易性のため、`os.homedir()` 由来の既定値）。
 */

import {
  readFile,
  writeFile,
  mkdir,
  copyFile,
  appendFile,
  readdir,
  stat,
  realpath,
  rm
} from 'fs/promises'
import { existsSync } from 'fs'
import { join, resolve, normalize as pathNormalize, dirname, basename } from 'path'
import { homedir } from 'os'

const REQUIRED_FRONTMATTER_KEYS = [
  'request_id',
  'created_at',
  'purpose',
  'target',
  'status'
] as const

const VALID_STATUSES = ['pending', 'applied', 'rolled_back', 'rejected'] as const
const VALID_KINDS = ['settings', 'skill'] as const

export type ChangeRequestStatus = (typeof VALID_STATUSES)[number]
export type ChangeRequestKind = (typeof VALID_KINDS)[number]

/** ApplyResult.reason の正規化された列挙（UI と log で区別表示するため） */
export type ApplyResultReason =
  | 'authentication-failed'
  | 'auth-missing-for-skill'
  | 'json-syntax-error'
  | 'allowlist-violation'
  | 'kind-target-mismatch'
  | 'glob-not-allowed'
  | 'unc-not-allowed'
  | 'parent-not-found'
  | 'realpath-failed'
  | 'write-failed'
  | 'post-verify-failed'

export interface ChangeRequestFrontmatter {
  request_id: string
  created_at: string
  purpose: string
  target: string
  status: ChangeRequestStatus
  /** PIKES r1.4 §7-3-A 第 5 項: 既定値 'settings'（後方互換） */
  kind: ChangeRequestKind
}

interface ChangeRequestBase {
  filePath: string
  frontmatter: ChangeRequestFrontmatter
  rawMarkdown: string
  parseError: string | null
}

export interface SettingsChangeRequest extends ChangeRequestBase {
  kind: 'settings'
  proposedSettingsJson: string
  proposedSettingsParsed: unknown | null
}

export interface SkillChangeRequest extends ChangeRequestBase {
  kind: 'skill'
  /** SKILL.md content の raw blob（JSON.parse なし） */
  proposedSkillBody: string
}

/** 判別 union。`request.kind` で discriminate する。 */
export type ChangeRequest = SettingsChangeRequest | SkillChangeRequest

export interface ApplyResult {
  success: boolean
  backupPath?: string
  appliedAt?: string
  error?: string
  /** PIKES r1.4 §7-3-A 第 3-4 項に対応した失敗事由コード（UI/log で区別表示） */
  reason?: ApplyResultReason
  rolledBack?: boolean
}

export interface ChangeLogEntry {
  timestamp: string
  request_id: string
  purpose: string
  result: 'applied' | 'rolled_back' | 'failed'
  backup_path: string
  /** kind を log に記録（既存ログは未指定で互換維持） */
  kind?: ChangeRequestKind
  error?: string
  reason?: ApplyResultReason
}

export interface SettingsBackup {
  id: string // timestamp portion of filename
  path: string
  sizeBytes: number
}

export interface SettingsPaths {
  claudeDir: string
  settingsJsonPath: string
  /** PIKES r1.4 §7-3-A 第 2 項 a: settings.local.json も allowlist 対象 */
  settingsLocalJsonPath?: string
  parcFermeDir: string
  backupsDir: string
  changeLogPath: string
  /** §7-3-A 第 2 項 a: skill allowlist root (~/.claude/skills) */
  skillsRoot?: string
  /** kind:skill apply 時の backup root (~/.ccpit/skill-backups) */
  skillBackupRoot?: string
}

/** 既定パス（本番）。テストでは引数で上書きする。 */
export function getDefaultSettingsPaths(): SettingsPaths {
  const home = homedir()
  const claudeDir = join(home, '.claude')
  const parcFermeDir = join(home, '.ccpit')
  return {
    claudeDir,
    settingsJsonPath: join(claudeDir, 'settings.json'),
    settingsLocalJsonPath: join(claudeDir, 'settings.local.json'),
    parcFermeDir,
    backupsDir: join(parcFermeDir, 'settings-backups'),
    changeLogPath: join(parcFermeDir, 'settings-change-log.jsonl'),
    skillsRoot: join(claudeDir, 'skills'),
    skillBackupRoot: join(parcFermeDir, 'skill-backups')
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
 *
 * PIKES r1.4 §7-3-A 第 5 項: kind 未指定なら 'settings' 既定（後方互換）
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

  // kind は optional、既定 'settings'。許容値以外は parseError。
  const kindRaw = fmResult.data.kind ?? 'settings'
  if (!VALID_KINDS.includes(kindRaw as ChangeRequestKind)) {
    throw new Error(`invalid kind: ${kindRaw}`)
  }
  const kind = kindRaw as ChangeRequestKind

  const frontmatter: ChangeRequestFrontmatter = {
    request_id: fmResult.data.request_id,
    created_at: fmResult.data.created_at,
    purpose: fmResult.data.purpose,
    target: fmResult.data.target,
    status,
    kind
  }

  const body = fmMatch[2]

  // Section 3 = 「変更後の完成版」（kind 共通の section name）。
  // 終端は「次の番号付き見出し (## 4. 等)」または body 末尾。
  // body 内の markdown 見出し (## Section 等) を section 区切りと誤認しないため、数字 + ピリオドを必須化。
  const sect3 = body.match(/##\s*3\.[^\n]*\n([\s\S]*?)(?=\n##\s\d+\.|$)/)
  if (!sect3) {
    throw new Error('section "## 3." not found (expected the proposed content section)')
  }

  if (kind === 'settings') {
    // 既存挙動: ```json fenced block を取得 → JSON.parse
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
      kind: 'settings',
      rawMarkdown: raw,
      proposedSettingsJson,
      proposedSettingsParsed,
      parseError
    }
  }

  // kind === 'skill': 言語タグ問わず最初の fenced block の raw body 抽出（JSON.parse なし）。
  const skillBlock = sect3[1].match(/```[A-Za-z0-9_+-]*\r?\n([\s\S]*?)\r?\n```/)
  if (!skillBlock) {
    throw new Error('skill code block not found in section 3 (expected ``` ... ``` fence)')
  }
  const proposedSkillBody = skillBlock[1]
  return {
    filePath,
    frontmatter,
    kind: 'skill',
    rawMarkdown: raw,
    proposedSkillBody,
    parseError: null
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
 * - kind:settings (既定): settings.json 不在 / auth.password 未設定 → true (初回 setup, 後方互換)
 * - kind:skill         : settings.json 不在 / auth.password 未設定 → **false** (apply 拒否)
 *   理由: PIKES r1.4 §7-3-A 第 4 項。skill 対象資産は行動指針であり、
 *   未設定環境での無認証 apply は本条の保護目的を無効化する。
 * - パスワードが設定されている場合のみ厳密一致を要求（kind 共通）。
 */
export async function verifyPassword(
  input: string,
  paths: SettingsPaths = getDefaultSettingsPaths(),
  kind: ChangeRequestKind = 'settings'
): Promise<boolean> {
  const raw = await readSettingsJson(paths)
  if (!raw) {
    return kind === 'settings'
  }
  try {
    const json = JSON.parse(raw) as { auth?: { password?: unknown } }
    const stored = json.auth?.password
    if (typeof stored !== 'string' || stored.length === 0) {
      return kind === 'settings'
    }
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

// =============================================================================
//   PIKES r1.4 §7-3-A 第 2-3 項: path 正規化 + allowlist 完全一致判定
// =============================================================================

/** 比較用の正規化（Windows ドライブレター大文字化 + slash 統一）。 */
function normalizeForCompare(p: string): string {
  let r = p.replace(/\\/g, '/')
  if (/^[a-z]:/.test(r)) {
    r = r.charAt(0).toUpperCase() + r.slice(1)
  }
  return r
}

/** canonical 形（forward slash）を OS native path（Windows なら backslash）へ戻す。 */
function toFsPath(canonical: string): string {
  return pathNormalize(canonical)
}

type NormalizeOk = { ok: true; absolute: string }
type NormalizeErr = {
  ok: false
  reason: 'glob-not-allowed' | 'unc-not-allowed' | 'parent-not-found' | 'realpath-failed'
}

/**
 * §7-3-A 第 3 項: 実装必須のトラバーサル防御。
 *   1. glob メタ文字検出 → reject
 *   2. UNC パス拒否
 *   3. ~ → homedir() 展開
 *   4. path.resolve で絶対化
 *   5. fs.realpath で symlink 解決（ファイル不在時は親で吸収、親も不在なら parent-not-found）
 *   6. Windows 正規化 (drive letter / slash)
 * 返却 absolute は完全一致比較用の canonical 形（forward slash）。
 */
async function normalizeTargetPath(
  rawTarget: string
): Promise<NormalizeOk | NormalizeErr> {
  // 1. glob メタ文字検出
  if (/[*?[\]]/.test(rawTarget)) {
    return { ok: false, reason: 'glob-not-allowed' }
  }

  // 2. UNC 拒否 (Windows `\\server\share` または POSIX `//server/share`)
  if (/^\\\\/.test(rawTarget) || /^\/\/[^/]/.test(rawTarget)) {
    return { ok: false, reason: 'unc-not-allowed' }
  }

  // 3. ~ → homedir() 展開
  let expanded = rawTarget
  if (expanded === '~') {
    expanded = homedir()
  } else if (expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    expanded = join(homedir(), expanded.slice(2))
  }

  // 4. 絶対化
  const absolute = resolve(expanded)

  // 5. realpath 解決
  let realAbs: string
  if (existsSync(absolute)) {
    try {
      realAbs = await realpath(absolute)
    } catch {
      return { ok: false, reason: 'realpath-failed' }
    }
  } else {
    // 対象ファイル不在: 親ディレクトリの realpath + basename で吸収
    const parent = dirname(absolute)
    if (!existsSync(parent)) {
      // MN-3: 親も不在 → 新規 skill ディレクトリ自動作成は v1 では不許可
      return { ok: false, reason: 'parent-not-found' }
    }
    try {
      const realParent = await realpath(parent)
      realAbs = join(realParent, basename(absolute))
    } catch {
      return { ok: false, reason: 'realpath-failed' }
    }
  }

  // 6. Windows 正規化 → canonical (forward slash)
  return { ok: true, absolute: normalizeForCompare(realAbs) }
}

type AllowlistEntry =
  | { kind: ChangeRequestKind; form: 'literal'; path: string }
  | { kind: ChangeRequestKind; form: 'glob'; pattern: string }

/** v1 allowlist (§7-3-A 第 2 項)。paths から実行時に構築。 */
function buildAllowlist(paths: SettingsPaths): AllowlistEntry[] {
  const entries: AllowlistEntry[] = [
    {
      kind: 'settings',
      form: 'literal',
      path: normalizeForCompare(paths.settingsJsonPath)
    }
  ]
  if (paths.settingsLocalJsonPath) {
    entries.push({
      kind: 'settings',
      form: 'literal',
      path: normalizeForCompare(paths.settingsLocalJsonPath)
    })
  }
  if (paths.skillsRoot) {
    // MN-2: §7-3-A 第 2 項 `**` 表記は Claude Code skill 慣例として深さ 1 (`<name>/SKILL.md`) に具体化
    entries.push({
      kind: 'skill',
      form: 'glob',
      pattern: normalizeForCompare(join(paths.skillsRoot, '*', 'SKILL.md'))
    })
  }
  return entries
}

/** 深さ 1 の `*` を単一セグメント（`/` を跨がない、非空）として match。 */
function matchGlobDepth1(target: string, pattern: string): boolean {
  const parts = pattern.split('*')
  if (parts.length !== 2) return false // single wildcard only
  const [prefix, suffix] = parts
  if (!target.startsWith(prefix) || !target.endsWith(suffix)) return false
  const middle = target.slice(prefix.length, target.length - suffix.length)
  if (middle.length === 0) return false
  if (middle.includes('/')) return false
  return true
}

type AllowOk = { ok: true; matchedKind: ChangeRequestKind }
type AllowErr = { ok: false; reason: 'allowlist-violation' | 'kind-target-mismatch' }

/**
 * §7-3-A 第 2-3 項: allowlist 完全一致判定 + kind/target 整合性検査。
 * normalizedTarget は normalizeTargetPath() の結果（canonical 形）を渡すこと。
 */
function assertTargetAllowed(
  normalizedTarget: string,
  requestKind: ChangeRequestKind,
  paths: SettingsPaths
): AllowOk | AllowErr {
  const allowlist = buildAllowlist(paths)
  for (const entry of allowlist) {
    const matched =
      entry.form === 'literal'
        ? entry.path === normalizedTarget
        : matchGlobDepth1(normalizedTarget, entry.pattern)
    if (matched) {
      if (entry.kind !== requestKind) {
        return { ok: false, reason: 'kind-target-mismatch' }
      }
      return { ok: true, matchedKind: entry.kind }
    }
  }
  return { ok: false, reason: 'allowlist-violation' }
}

/** kind:skill 用 backup。skill 単位のサブディレクトリに ts 付き .md として保存。 */
async function takeSkillBackup(
  targetAbsCanonical: string,
  paths: SettingsPaths
): Promise<string> {
  if (!paths.skillBackupRoot) {
    throw new Error('skillBackupRoot is not configured in SettingsPaths')
  }
  await mkdir(paths.skillBackupRoot, { recursive: true })
  const fsPath = toFsPath(targetAbsCanonical)
  const skillName = basename(dirname(fsPath)) || 'unknown'
  const skillBackupDir = join(paths.skillBackupRoot, skillName)
  await mkdir(skillBackupDir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = join(skillBackupDir, `${ts}-SKILL.md`)
  if (existsSync(fsPath)) {
    await copyFile(fsPath, backupPath)
  } else {
    // 新規作成扱い。空 sentinel で「元は不在」を示す。
    await writeFile(backupPath, '', 'utf-8')
  }
  return backupPath
}

// =============================================================================
//   applyChange (本機能の心臓部、kind 別に分岐)
// =============================================================================

/**
 * 変更案を適用する。手順は厳密に以下の順序:
 *
 *   Step 1. 認証チェック (kind 別)    — fail なら早期 return（バックアップも取らない）
 *   Step 2. 提案 content 構文検証     — kind:settings は JSON.parse 結果を check、kind:skill は parseError なし
 *   Step 3. target 正規化 + allowlist — §7-3-A 第 3-4 項のトラバーサル防御 + kind/target 整合
 *   Step 4. backup (kind 別)
 *   Step 5. write (kind 別、settings は JSON.stringify、skill は raw body)
 *   Step 6. post-verify (kind 別、settings は JSON.parse 再検証、skill はバイト列等価)
 *   Step 7. 検証 fail 時は backup から自動ロールバック
 *   Step 8. 結果をログ追記
 *
 * `paths` は test では明示指定、本番では `getDefaultSettingsPaths()` 由来の `~/.claude/`。
 */
export async function applyChange(
  request: ChangeRequest,
  password: string,
  paths: SettingsPaths = getDefaultSettingsPaths()
): Promise<ApplyResult> {
  // Step 1: Authentication (kind 別)
  const authOk = await verifyPassword(password, paths, request.kind)
  if (!authOk) {
    // skill 経路で auth.password 未設定が原因か、それ以外（不一致）かを区別
    const hasPwd = await hasPasswordRegistered(paths)
    const reason: ApplyResultReason =
      request.kind === 'skill' && !hasPwd ? 'auth-missing-for-skill' : 'authentication-failed'
    return {
      success: false,
      error:
        reason === 'auth-missing-for-skill'
          ? 'auth.password is not configured; kind:skill apply is not permitted (PIKES r1.4 §7-3-A 第 4 項)'
          : 'authentication failed',
      reason
    }
  }

  // Step 2: Validate proposed content (kind 別)
  if (request.kind === 'settings') {
    if (request.parseError !== null || request.proposedSettingsParsed === null) {
      const err = request.parseError ?? 'proposed JSON not parsed'
      await appendChangeLog(
        {
          timestamp: new Date().toISOString(),
          request_id: request.frontmatter.request_id,
          purpose: request.frontmatter.purpose,
          result: 'failed',
          backup_path: '',
          kind: 'settings',
          error: err,
          reason: 'json-syntax-error'
        },
        paths
      )
      return { success: false, error: `JSON syntax error: ${err}`, reason: 'json-syntax-error' }
    }
  }
  // kind:skill は raw text のため parseError は常に null（A-3 で保証）

  // Step 3: target 正規化 + allowlist
  const norm = await normalizeTargetPath(request.frontmatter.target)
  if (!norm.ok) {
    await appendChangeLog(
      {
        timestamp: new Date().toISOString(),
        request_id: request.frontmatter.request_id,
        purpose: request.frontmatter.purpose,
        result: 'failed',
        backup_path: '',
        kind: request.kind,
        error: `target normalize: ${norm.reason}`,
        reason: norm.reason
      },
      paths
    )
    return { success: false, error: `target rejected: ${norm.reason}`, reason: norm.reason }
  }
  const allowed = assertTargetAllowed(norm.absolute, request.kind, paths)
  if (!allowed.ok) {
    await appendChangeLog(
      {
        timestamp: new Date().toISOString(),
        request_id: request.frontmatter.request_id,
        purpose: request.frontmatter.purpose,
        result: 'failed',
        backup_path: '',
        kind: request.kind,
        error: `allowlist: ${allowed.reason}`,
        reason: allowed.reason
      },
      paths
    )
    return { success: false, error: `target rejected: ${allowed.reason}`, reason: allowed.reason }
  }

  // Step 4: backup (kind 別)
  const backupPath =
    request.kind === 'settings'
      ? await takeSettingsBackup(paths)
      : await takeSkillBackup(norm.absolute, paths)

  // Step 5: write (kind 別)
  const fsTargetPath = toFsPath(norm.absolute)
  try {
    if (request.kind === 'settings') {
      const proposedFormatted = JSON.stringify(request.proposedSettingsParsed, null, 2)
      await mkdir(dirname(fsTargetPath), { recursive: true })
      await writeFile(fsTargetPath, proposedFormatted, 'utf-8')
    } else {
      // kind: 'skill' — raw body 全文置換 (LF/BOM はそのまま、tester が opts で制御)
      await mkdir(dirname(fsTargetPath), { recursive: true })
      await writeFile(fsTargetPath, request.proposedSkillBody, 'utf-8')
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await appendChangeLog(
      {
        timestamp: new Date().toISOString(),
        request_id: request.frontmatter.request_id,
        purpose: request.frontmatter.purpose,
        result: 'failed',
        backup_path: backupPath,
        kind: request.kind,
        error: `write failed: ${msg}`,
        reason: 'write-failed'
      },
      paths
    )
    return {
      success: false,
      backupPath,
      error: `write failed: ${msg}`,
      reason: 'write-failed'
    }
  }

  // Step 6: post-verify (kind 別)
  let verifyError: string | null = null
  try {
    const postRaw = await readFile(fsTargetPath, 'utf-8')
    if (request.kind === 'settings') {
      JSON.parse(postRaw)
    } else {
      // skill: バイト列等価チェック
      if (postRaw !== request.proposedSkillBody) {
        verifyError = 'post-write content mismatch (byte-level inequality)'
      }
    }
  } catch (err) {
    verifyError = err instanceof Error ? err.message : String(err)
  }

  if (verifyError !== null) {
    // Step 7: Auto-rollback (kind 別)
    let rolledBack = false
    try {
      if (existsSync(backupPath)) {
        const backupContent = await readFile(backupPath, 'utf-8')
        if (backupContent.length > 0) {
          await copyFile(backupPath, fsTargetPath)
          rolledBack = true
        } else if (request.kind === 'skill') {
          // 元は不在だった skill ファイル → 新規作成された target を削除して状態を戻す
          try {
            await rm(fsTargetPath, { force: true })
            rolledBack = true
          } catch {
            // 削除失敗、ユーザー手動対応必要
          }
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
        kind: request.kind,
        error: `post-write verification failed: ${verifyError}`,
        reason: 'post-verify-failed'
      },
      paths
    )
    return {
      success: false,
      backupPath,
      error: `post-write verification failed: ${verifyError}`,
      reason: 'post-verify-failed',
      rolledBack
    }
  }

  // Step 8: log + success
  const appliedAt = new Date().toISOString()
  await appendChangeLog(
    {
      timestamp: appliedAt,
      request_id: request.frontmatter.request_id,
      purpose: request.frontmatter.purpose,
      result: 'applied',
      backup_path: backupPath,
      kind: request.kind
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
        backup_path: backupPath,
        kind: 'settings'
      },
      paths
    )
    return { success: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, error: msg }
  }
}
