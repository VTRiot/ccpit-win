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
import {
  hashSkillBody,
  isEmergencyOverrideValid,
  readAdoptedRegistry,
  readEmergencyOverrides,
  upsertAdoptedSkill,
  type ProvenancePaths
} from './skillProvenance'
import { evaluateProposalCodexGate, extractAdoptionLabel } from './proposalCodexGate'
import type { ProposalStorePaths } from './skillProposals'

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
  /** 判断H: 採用 skill 名が golden 配布 skill と同名（恒久シャドウ防止のため基本禁止） */
  | 'golden-name-collision'
  /** WS2 (maintainer裁定 2026-07-13): 推奨バッジ提案は Codex 検出環境では独立レビュー記録なしに採用不可 */
  | 'codex-review-missing'

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
  /** ケース2（先行衝突）で一時名に退避して採用した場合の実際の skill 名（判断H） */
  renamedTo?: string
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
 * "## 3." 見出し（行頭一致）以降のテキストを返す。見出しが無ければ null。
 * settings 用 lookahead regex と違い、本文に `## N.` 見出しを含む SKILL.md でも
 * 後段のフェンス境界で本文を画定できるよう、ここでは見出し以降を丸ごと返す。
 */
function sliceAfterSection3(body: string): string | null {
  const m = /(?:^|\n)##\s*3\.[^\n]*\r?\n/.exec(body)
  if (!m) return null
  return body.slice(m.index + m[0].length)
}

/**
 * CommonMark 風の可変長フェンス抽出（kind:skill 用）。
 * 開きフェンス = 行頭 N>=3 個のバックティック + 任意の info string（バックティック以外）。
 * 閉じフェンス = 行頭 M>=N 個のバックティックのみ（後続は空白のみ）。
 * 最初の開きフェンスと、最初に現れる「N 個以上の閉じフェンス」の間を raw のまま返す。
 * これにより内側に N-1 個以下のフェンスを含む SKILL.md 本文を切らない（emitter は
 * 「外側 = 内側の最長連 +1 以上」で出力するため、内側フェンスが閉じ判定に誤マッチしない）。
 * CRLF/LF はそのまま保持。開き/閉じが見つからなければ null。
 */
function extractFencedBody(section: string): string | null {
  const openM = /(?:^|\n)(`{3,})[^\n`]*\r?\n/.exec(section)
  if (!openM) return null
  const fenceLen = openM[1].length
  const bodyStart = openM.index + openM[0].length
  const rest = section.slice(bodyStart)
  const closeRe = new RegExp(`(?:^|\\r?\\n)\`{${fenceLen},}[ \\t]*(?:\\r?\\n|$)`)
  const closeM = closeRe.exec(rest)
  if (!closeM) return null
  return rest.slice(0, closeM.index)
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
  if (kind === 'settings') {
    // 既存挙動: lookahead で section 3 を切り出し、```json fenced block を取得 → JSON.parse。
    // settings(JSON) は本文に `## N.` 見出しや ``` を含まないため lookahead で安全。
    const sect3 = body.match(/##\s*3\.[^\n]*\n([\s\S]*?)(?=\n##\s\d+\.|$)/)
    if (!sect3) {
      throw new Error('section "## 3." not found (expected the proposed content section)')
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
      kind: 'settings',
      rawMarkdown: raw,
      proposedSettingsJson,
      proposedSettingsParsed,
      parseError
    }
  }

  // kind === 'skill': SKILL.md 本文は内側に ``` フェンスや `## N.` 見出しを含みうるため、
  // settings 用 lookahead では切れる。"## 3." 見出し以降を取り、可変長フェンス境界で raw body を画定する。
  const sect3Body = sliceAfterSection3(body)
  if (sect3Body === null) {
    throw new Error('section "## 3." not found (expected the proposed content section)')
  }
  const proposedSkillBody = extractFencedBody(sect3Body)
  if (proposedSkillBody === null) {
    throw new Error('skill code block not found in section 3 (expected ``` ... ``` fence)')
  }
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
    // 対象ファイル不在: 存在する最近接の祖先を realpath し、不在のサフィックスを再付与する。
    // Part B 採用 FB: 新規 skill 採用では target の親 (~/.claude/skills/<name>/) も未作成が常態。
    // 親不在で弾くと採用が成立しないため、存在する祖先 (skills/) まで遡って realpath し、
    // 不在セグメント (<name>/SKILL.md) を再付与する。不在セグメントは symlink になり得ないので、
    // 祖先の realpath でトラバーサル防御は保たれる。許容範囲は後段 allowlist (深さ1 glob
    // skills/*/SKILL.md) が画定し、write 時に mkdir -p で親を作成する。
    let existingAncestor = dirname(absolute)
    const missingSegments: string[] = [basename(absolute)]
    while (!existsSync(existingAncestor)) {
      missingSegments.unshift(basename(existingAncestor))
      const up = dirname(existingAncestor)
      if (up === existingAncestor) {
        // ルートまで遡っても存在する祖先が無い（実 FS では通常あり得ない）
        return { ok: false, reason: 'parent-not-found' }
      }
      existingAncestor = up
    }
    try {
      const realAncestor = await realpath(existingAncestor)
      realAbs = join(realAncestor, ...missingSegments)
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
/** applyChange の追加オプション（判断H: 同名禁止 + provenance）。 */
export interface ApplyOptions {
  /**
   * kind:skill の同名禁止判定に使う golden 配布 skill 名集合。
   * 未指定または空なら同名チェックをスキップ（既存テスト/後方互換）。本番 IPC は常に指定する。
   */
  goldenSkillNames?: string[]
  /** provenance/emergency override の保存先（テスト上書き用、既定 ~/.ccpit）。 */
  provenancePaths?: ProvenancePaths
  /** 現在の golden バージョン（緊急 override の版前進失効判定 + 採用記録用）。 */
  currentGoldenVersion?: string
  /**
   * WS2: 推奨バッジ提案の Codex レビューゲートのパス上書き（テスト用）。
   * 未指定なら実環境（~/.claude/plugins/cache/openai-codex/codex + ~/.ccpit/proposal-reviews.json）。
   */
  codexGate?: { codexCacheDir?: string; proposalStorePaths?: ProposalStorePaths }
}

// --- ロック (Codex#6: competing writes 対策) ---
// 単一 Electron Main プロセス内で applyChange を直列化する in-process async mutex。
// 同時採用（連打）でレジストリ/provenance の read-modify-write が競合するのを防ぐ。
// 注: cross-instance（複数 CCPIT 同時起動）は単一インスタンス前提のため範囲外。
let applyChain: Promise<unknown> = Promise.resolve()
function withApplyLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = applyChain.then(fn, fn)
  applyChain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

/**
 * ケース2 警告ヘッダを SKILL.md 本文の frontmatter 直後に HTML コメントで挿入する。
 * frontmatter（name/description）を壊さない位置に入れる（先頭挿入は frontmatter を無効化するため不可）。
 */
function injectCollisionWarning(body: string, originalName: string, tempName: string): string {
  const warning = `<!--\n[CCPIT name-collision / 同名衝突 警告]\n採用時に既存の非 golden 先行 skill '${originalName}' と同名衝突を検出したため、本 skill は一時名 '${tempName}' で採用された。\n解決: 先行 '${originalName}' と採用版 '${tempName}' のどちらを残すか決め、不要な方を ~/.claude/skills/ から削除/リネームせよ。詳細レポート: ~/.ccpit/reports/。\n-->\n`
  const m = body.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n)([\s\S]*)$/)
  if (m) return m[1] + warning + m[2]
  return warning + body
}

/** ケース2 解決レポートを ~/.ccpit/reports/ に書く（正当性パス外。失敗は採用成功を覆さない）。 */
async function writeCase2Report(
  paths: SettingsPaths,
  info: { originalName: string; tempName: string; tempTarget: string }
): Promise<string | null> {
  try {
    const reportsDir = join(paths.parcFermeDir, 'reports')
    await mkdir(reportsDir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const fp = join(reportsDir, `${ts}-name-collision-${info.originalName}.md`)
    const content = `# 同名衝突レポート (ケース2 先行衝突)

- 検出時刻: ${new Date().toISOString()}
- 提案 skill 名: ${info.originalName}
- 状況: 既存の **非 golden 先行 skill**（ユーザーが手で置いた等、採用レジストリ未登録）と同名衝突
- 採用した一時名: ${info.tempName}
- 一時 target: ${info.tempTarget}

## 解決手順
1. 先行 skill (\`${info.originalName}\`) と採用版 (\`${info.tempName}\`) のどちらを残すか決める。
2. 不要な方を \`~/.claude/skills/\` から削除 or リネームする。
3. 判断に迷えば CCPIT 標準 WebAI 動線（claude.ai）で相談してよい。
`
    await writeFile(fp, content, 'utf-8')
    return fp
  } catch {
    return null // レポート失敗は採用を覆さない（Codex nit: 正当性パス外）
  }
}

/**
 * provenance/emergency override の保存先を解決する。
 * opts 明示が無ければ **paths.parcFermeDir 由来**（本番 = ~/.ccpit、テスト = temp）。
 * これにより no-opts テストが実 ~/.ccpit を汚染しない（test 分離）。
 */
function resolveProvenancePaths(opts: ApplyOptions, paths: SettingsPaths): ProvenancePaths {
  return (
    opts.provenancePaths ?? {
      adoptedRegistryPath: join(paths.parcFermeDir, 'adopted-skills.json'),
      emergencyOverridesPath: join(paths.parcFermeDir, 'emergency-overrides.json')
    }
  )
}

/** 公開 API: ロックで直列化してから実体を実行する。 */
export function applyChange(
  request: ChangeRequest,
  password: string,
  paths: SettingsPaths = getDefaultSettingsPaths(),
  opts: ApplyOptions = {}
): Promise<ApplyResult> {
  return withApplyLock(() => applyChangeInner(request, password, paths, opts))
}

async function applyChangeInner(
  request: ChangeRequest,
  password: string,
  paths: SettingsPaths = getDefaultSettingsPaths(),
  opts: ApplyOptions = {}
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

  // Step 3.5: 同名衝突ガード (kind:skill, 判断H) — golden 配布 skill と同名の採用は基本禁止。
  //           恒久シャドウ（公式更新が黙って届かない地雷）を構造的に消す。
  //           有効な緊急 override (Dr 動線・スコープ付き) がある場合のみ許可（フェイルセーフ）。
  if (request.kind === 'skill' && opts.goldenSkillNames && opts.goldenSkillNames.length > 0) {
    const collidingName = basename(dirname(toFsPath(norm.absolute)))
    if (opts.goldenSkillNames.includes(collidingName)) {
      const provPaths = resolveProvenancePaths(opts, paths)
      const overrides = await readEmergencyOverrides(provPaths)
      const emergencyOk = isEmergencyOverrideValid(collidingName, overrides, {
        currentGoldenVersion: opts.currentGoldenVersion
      })
      if (!emergencyOk) {
        await appendChangeLog(
          {
            timestamp: new Date().toISOString(),
            request_id: request.frontmatter.request_id,
            purpose: request.frontmatter.purpose,
            result: 'failed',
            backup_path: '',
            kind: 'skill',
            error: `golden-name-collision: '${collidingName}'`,
            reason: 'golden-name-collision'
          },
          paths
        )
        return {
          success: false,
          error: `adoption refused: '${collidingName}' は golden 配布 skill と同名です（恒久シャドウ防止のため基本禁止）。提案 skill 名を変えるか、Doctor Analysis の緊急避難動線を使ってください。`,
          reason: 'golden-name-collision'
        }
      }
    }
  }

  // Step 3.6: ケース2 — 先行衝突ハンドリング (kind:skill, 判断H)。
  //   target が既に存在し、golden 名でなく、採用レジストリにも無い = ユーザーが手で置いた等の
  //   「先行 skill」。問答無用で上書きすると気づけない clobber になるため、一時名で退避採用し、
  //   警告ヘッダ + ~/.ccpit/reports/ レポートで解決動線に乗せる。
  //   （新規 skill = target 不在は非該当 / 自採用 skill の更新 = レジストリ登録済は非該当
  //    / golden 同名 = Step 3.5 で処理済（緊急 override 許可時は意図的上書きゆえ非該当））。
  let effectiveCanonical = norm.absolute
  let effectiveSkillBody = request.kind === 'skill' ? request.proposedSkillBody : ''
  let case2RenamedFrom: string | null = null
  let case2TempName: string | null = null
  // Part B 採用文脈（opts.goldenSkillNames 指定時）でのみ作動。opts 無しの素の applyChange
  // （既存 v1.4 経路 / CC Request Inbox settings）は従来どおり上書き（後方互換）。
  if (request.kind === 'skill' && opts.goldenSkillNames !== undefined) {
    const origName = basename(dirname(toFsPath(norm.absolute)))
    const isGolden = opts.goldenSkillNames.includes(origName)
    if (!isGolden && existsSync(toFsPath(norm.absolute))) {
      const provPaths = resolveProvenancePaths(opts, paths)
      let inRegistry = false
      try {
        const reg = await readAdoptedRegistry(provPaths)
        inRegistry = reg.some((e) => e.name === origName)
      } catch {
        inRegistry = false // フェイルクローズ: 不明なら先行扱い（temp 名で安全側、clobber しない）
      }
      if (!inRegistry) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-')
        const tempName = `${origName}-adopted-${ts}`
        const skillsRootFs = dirname(dirname(toFsPath(norm.absolute)))
        const tempFsTarget = join(skillsRootFs, tempName, 'SKILL.md')
        effectiveCanonical = normalizeForCompare(tempFsTarget)
        effectiveSkillBody = injectCollisionWarning(request.proposedSkillBody, origName, tempName)
        case2RenamedFrom = origName
        case2TempName = tempName
      }
    }
  }

  // Step 3.7: Codex レビューゲート (kind:skill, maintainer裁定 2026-07-13 / v1.6.0 WS2)。
  //   推奨バッジ（adoption_label: recommend）付き提案は、Codex プラグイン検出環境では
  //   独立 Codex レビュー記録（~/.ccpit/proposal-reviews.json・契約 C1）なしに採用できない。
  //   adoption_label は request.rawMarkdown の frontmatter から Main 側で導出（renderer 非信頼）。
  //   Codex 未導入環境・非推奨提案では required が立たず素通し（従来どおり・強制失敗にしない）。
  if (request.kind === 'skill') {
    const adoptionLabel = extractAdoptionLabel(request.rawMarkdown)
    if (adoptionLabel === 'recommend') {
      const gate = await evaluateProposalCodexGate({
        adoptionLabel,
        requestId: request.frontmatter.request_id,
        codexCacheDir: opts.codexGate?.codexCacheDir,
        storePaths: opts.codexGate?.proposalStorePaths
      })
      if (!gate.satisfied) {
        const detail =
          gate.blockReason === 'reviewer-not-codex'
            ? `レビュー記録の reviewer が codex ではありません（reviewerId: '${gate.reviewerId ?? ''}'）。`
            : gate.blockReason === 'request-id-missing'
              ? 'request_id が空のためレビュー記録を照合できません。'
              : 'Codex レビュー記録が見つかりません。'
        await appendChangeLog(
          {
            timestamp: new Date().toISOString(),
            request_id: request.frontmatter.request_id,
            purpose: request.frontmatter.purpose,
            result: 'failed',
            backup_path: '',
            kind: 'skill',
            error: `codex-review-missing: ${gate.blockReason ?? 'unknown'}`,
            reason: 'codex-review-missing'
          },
          paths
        )
        return {
          success: false,
          error: `adoption refused: 推奨バッジ付き提案は Codex レビュー必須です（maintainer裁定 2026-07-13）。${detail}候補ブラウザの「レビュー依頼プロンプトをコピー」から Codex レビューを実施してください。`,
          reason: 'codex-review-missing'
        }
      }
    }
  }

  // Step 4: backup (kind 別)
  const backupPath =
    request.kind === 'settings'
      ? await takeSettingsBackup(paths)
      : await takeSkillBackup(effectiveCanonical, paths)

  // Step 5: write (kind 別)。kind:skill は effective（ケース2 で一時名/警告ヘッダ込みになりうる）を使う。
  const fsTargetPath = toFsPath(effectiveCanonical)
  try {
    if (request.kind === 'settings') {
      const proposedFormatted = JSON.stringify(request.proposedSettingsParsed, null, 2)
      await mkdir(dirname(fsTargetPath), { recursive: true })
      await writeFile(fsTargetPath, proposedFormatted, 'utf-8')
    } else {
      // kind: 'skill' — raw body 全文置換 (LF/BOM はそのまま、tester が opts で制御)
      await mkdir(dirname(fsTargetPath), { recursive: true })
      await writeFile(fsTargetPath, effectiveSkillBody, 'utf-8')
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
      // skill: バイト列等価チェック（effective ＝ ケース2 で警告ヘッダ込みになりうる）
      if (postRaw !== effectiveSkillBody) {
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

  // Step 8.5: kind:skill 採用を出自レジストリに記録（ケース2 検出・緊急ライフサイクル用）。
  //           best-effort。記録失敗は apply 成功を覆さない（採用は既に完了している）。
  if (request.kind === 'skill') {
    try {
      const provPaths = resolveProvenancePaths(opts, paths)
      // ケース2 では effective（一時名）が実採用先。出自記録もその名で行う。
      const skillName = basename(dirname(toFsPath(effectiveCanonical)))
      let isEmergency = false
      if (opts.goldenSkillNames?.includes(skillName)) {
        const overrides = await readEmergencyOverrides(provPaths)
        isEmergency = isEmergencyOverrideValid(skillName, overrides, {
          currentGoldenVersion: opts.currentGoldenVersion
        })
      }
      await upsertAdoptedSkill(
        {
          name: skillName,
          target: effectiveCanonical,
          hash: hashSkillBody(effectiveSkillBody),
          adoptedAt: appliedAt,
          source: isEmergency ? 'emergency' : 'adopted',
          goldenVersionAtAdoption: opts.currentGoldenVersion
        },
        provPaths
      )
    } catch {
      // provenance 記録失敗は apply 成功を覆さない（best-effort）
    }
  }

  // ケース2: 解決レポートを ~/.ccpit/reports/ に書く（正当性パス外。失敗は採用を覆さない）。
  if (case2RenamedFrom && case2TempName) {
    await writeCase2Report(paths, {
      originalName: case2RenamedFrom,
      tempName: case2TempName,
      tempTarget: effectiveCanonical
    })
    return { success: true, backupPath, appliedAt, renamedTo: case2TempName }
  }

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
