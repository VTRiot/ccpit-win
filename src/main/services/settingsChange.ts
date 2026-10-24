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
  lstat,
  realpath,
  rm
} from 'fs/promises'
import { existsSync } from 'fs'
import { gzipSync, gunzipSync } from 'zlib'
import { join, resolve, normalize as pathNormalize, dirname, basename, relative, isAbsolute } from 'path'
import { homedir } from 'os'
import {
  hashSkillBody,
  isEmergencyOverrideValid,
  readAdoptedRegistry,
  readEmergencyOverrides,
  upsertAdoptedSkill,
  type AdoptedSkillEntry,
  type ProvenancePaths
} from './skillProvenance'
import { getManifestPath, markAdopted } from './goldenManifest'
import { validateHookPrerequisites } from './hooksValidation'
import { writeFileAtomic } from './atomicFile'
import {
  type ProposalFile,
  parseProposedFilesFromSection3,
  maskFencedCodeBlocks,
  extractFencedCodeBlocks,
  type FencedCodeBlock
} from './skillProposals'

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
  /** 配線前提条件ゲート (Step 3.7): 提案 hooks が参照する実体（hook ファイル / 必須 skill）が不在 */
  | 'hook-prerequisite-missing'
  /** 更新採用 CAS (Step 3.65): 採用レジストリ記録時から skill 実体が外部変更されている */
  | 'base-changed'
  /** 更新採用 (Step 3.65): 旧版の圧縮アーカイブ作成に失敗（ロールバック実体を確保できないため fail-closed） */
  | 'archive-failed'
  /** 付随ファイル配置先パス検証 (Step 3.8): シンボリックリンク等による脱出を検知 */
  | 'path-validation-failed'

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
  /** 提案に含まれる全ファイル群（SKILL.md および付随ファイル） */
  files?: ProposalFile[]
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
  /** 更新採用時に確保した旧版圧縮アーカイブのディレクトリ（ロールバック導線） */
  archivePath?: string
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
  return parseChangeRequestFromRaw(raw, filePath)
}

/** parseChangeRequestMd の raw 受け版（1-read 統合で採用ゲートと同一 snapshot を共有するため）。 */
export function parseChangeRequestFromRaw(raw: string, filePath: string): ChangeRequest {
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
    // section 3 を切り出し、その中の最初の ```json のコードブロックを取得 → JSON.parse。
    // 見出しはコードブロックの外の行だけから探す（maskFencedCodeBlocks）。§1・§2 のコードブロックの中の
    // 「## 3.」を見出しに数えないため（2026-09-28 069 M2）。コードブロックの境界は CommonMark のフェンスの規則。
    // 見出しの行頭の空白は 0〜3 個まで（CommonMark。以前の正規表現は行頭に縛らず、字下げした見出しも読んでいた）。
    // 行の途中の「## 3.」（`説明 ## 3. …`）は Markdown の見出しではないので読まない（以前は読んでいた。§1・§2 の本文で
    // §3 に触れた行を §3 と取り違えるため。変更案を書く settings-change-request-emitter は「## 3.」を行頭に書く）
    const maskedLines = maskFencedCodeBlocks(body).split('\n')
    const isSectionHeading = (i: number, n?: number): boolean => {
      const num = n === undefined ? '\\d+' : String(n)
      return new RegExp(`^ {0,3}##\\s*${num}\\.`).test(maskedLines[i])
    }
    const sect3Line = maskedLines.findIndex((_l, i) => isSectionHeading(i, 3))
    if (sect3Line === -1) {
      throw new Error('section "## 3." not found (expected the proposed content section)')
    }
    let sect3End = maskedLines.findIndex((_l, i) => i > sect3Line && isSectionHeading(i))
    if (sect3End === -1) sect3End = maskedLines.length
    const isSection3Json = (b: FencedCodeBlock): boolean =>
      b.openLine > sect3Line && b.openLine < sect3End && b.closeLine !== null && b.info === 'json'
    const jsonBlock = extractFencedCodeBlocks(body).find(isSection3Json)
    if (!jsonBlock) {
      throw new Error('JSON code block not found in section 3 (expected ```json ... ``` fence)')
    }
    const proposedSettingsJson = jsonBlock.content.replace(/\r?\n$/, '')
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

  // kind === 'skill': SKILL.md 本文および付随ファイル群（Section 3）のパース
  const filesRes = parseProposedFilesFromSection3(body, filePath)
  if (filesRes.error) {
    throw new Error(filesRes.error)
  }

  // parseProposedFilesFromSection3 は「## 3.」（コードブロックの外の見出し）があれば、SKILL.md を返すか
  // エラーを返す（エラーは上で throw 済み）。SKILL.md が無いのは「## 3.」が無いときだけ。
  // 2026-09-28 069 M2: 以前はここで「## 3.」をコードブロックの中も含めて探し直し、別の規則で最初の
  // コードブロックを取り出していた（2 つ目の読み方）。§1・§2 のコードブロックの中の「## 3.」から
  // SKILL.md の本文を取りうるので、正規の読み取り 1 つにそろえた。
  // `en:` 見出しのファイルは golden の en 側へ運ぶためのもので、手元（~/.claude/skills）への採用では書かない
  const localFiles = filesRes.files.filter((f) => f.lang !== 'en')
  const skillFile = localFiles.find((f) => f.relPath === 'SKILL.md')
  if (!skillFile) {
    throw new Error('section "## 3." not found (expected the proposed content section)')
  }
  const proposedSkillBody = skillFile.content
  return {
    filePath,
    frontmatter,
    kind: 'skill',
    rawMarkdown: raw,
    proposedSkillBody,
    files: localFiles.length > 0 ? localFiles : undefined,
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

/** 比較用の正規化（Windows ドライブレター大文字化 + slash 統一）。
 *  CCPIT_058 addendum-01 [6]: skillLifecycle.ts::resolveCollisionCore が正式 target を
 *  文字列 replace でなくこの関数で再構成するため export する（挙動変更なし）。 */
export function normalizeForCompare(p: string): string {
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

/** child が parent 配下に解決するか（トラバーサル防御）。
 *  skillLifecycle.ts::isPathUnder と同ロジック。ここへ複製する理由: skillLifecycle.ts は
 *  本ファイルへ依存しており（getDefaultSettingsPaths/withApplyLock を import）、逆向きの
 *  import は循環依存になるため、3 行の純関数はあえて共有せずローカルに持つ（CCPIT_058 addendum-01 [2]）。 */
function isPathUnder(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && rel !== '.' && !rel.startsWith('..') && !isAbsolute(rel)
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
async function normalizeTargetPath(rawTarget: string): Promise<NormalizeOk | NormalizeErr> {
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

interface SkillBackupDetail {
  backupPath: string
  backupDir: string
  hadExistingSkillDir: boolean
}

async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true })
  const entries = await readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = join(src, entry.name)
    const destPath = join(dest, entry.name)
    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath)
    } else if (entry.isFile()) {
      await copyFile(srcPath, destPath)
    }
  }
}

function isSubPath(child: string, parent: string): boolean {
  const normChild = normalizeForCompare(child).toLowerCase()
  const normParent = normalizeForCompare(parent).toLowerCase()
  return normChild === normParent || normChild.startsWith(normParent + '/')
}

/**
 * 新規ネストディレクトリの安全作成手順（Codex 第 6 巡 指摘 2 反映）
 * - 対象スキルの正規ルート（rootDir）を realpath で解決
 * - 作成対象パスの各親階層について、すでに存在するディレクトリは lstat でシンボリックリンク等でないことを確認
 * - 未作成の親階層は一階層ずつ順次 mkdir して直後に lstat および realpath を確認
 */
async function ensureDirSafe(targetDir: string, rootDir: string): Promise<void> {
  const normRoot = resolve(rootDir)
  const normTarget = resolve(targetDir)
  if (normTarget === normRoot) {
    if (!existsSync(normRoot)) {
      await mkdir(normRoot, { recursive: true })
    }
    const st = await lstat(normRoot)
    if (st.isSymbolicLink()) {
      throw new Error(`Directory is a symbolic link: ${normRoot}`)
    }
    return
  }

  const rel = relative(normRoot, normTarget)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Target directory escapes root: ${normTarget}`)
  }

  if (!existsSync(normRoot)) {
    await mkdir(normRoot, { recursive: true })
  }
  const rootSt = await lstat(normRoot)
  if (rootSt.isSymbolicLink()) {
    throw new Error(`Root directory is a symbolic link: ${normRoot}`)
  }
  const realRoot = await realpath(normRoot)

  const segments = rel.replace(/\\/g, '/').split('/')
  let current = normRoot
  for (const seg of segments) {
    if (!seg || seg === '.') continue
    if (seg === '..') throw new Error(`Directory traversal detected: ${seg}`)
    current = join(current, seg)
    if (existsSync(current)) {
      const st = await lstat(current)
      if (st.isSymbolicLink()) {
        throw new Error(`Directory segment is a symbolic link: ${current}`)
      }
      if (!st.isDirectory()) {
        throw new Error(`Directory segment is not a directory: ${current}`)
      }
      const realCur = await realpath(current)
      if (!isSubPath(realCur, realRoot)) {
        throw new Error(`Directory segment escapes root via realpath: ${current} -> ${realCur}`)
      }
    } else {
      await mkdir(current)
      const st = await lstat(current)
      if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new Error(`Created directory segment is invalid: ${current}`)
      }
      const realCur = await realpath(current)
      if (!isSubPath(realCur, realRoot)) {
        throw new Error(`Created directory segment escapes root via realpath: ${current} -> ${realCur}`)
      }
    }
  }
}

/**
 * 新規ネストディレクトリの安全事前検証（Codex レビュー指摘 S-2 反映）
 * 書き込みやディレクトリ作成を行う前に、既存のディレクトリ階層にシンボリックリンクや境界脱出が存在しないか検証する。
 * 事前検証により、書き込み途中での失敗によるロールバック（既存ジャンクション消失等の副作用）を未然に防止する。
 */
async function verifyDirSafe(targetDir: string, rootDir: string): Promise<void> {
  const normRoot = resolve(rootDir)
  const normTarget = resolve(targetDir)
  if (normTarget === normRoot) {
    if (existsSync(normRoot)) {
      const st = await lstat(normRoot)
      if (st.isSymbolicLink()) {
        throw new Error(`Directory is a symbolic link: ${normRoot}`)
      }
    }
    return
  }

  const rel = relative(normRoot, normTarget)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Target directory escapes root: ${normTarget}`)
  }

  if (existsSync(normRoot)) {
    const rootSt = await lstat(normRoot)
    if (rootSt.isSymbolicLink()) {
      throw new Error(`Root directory is a symbolic link: ${normRoot}`)
    }
  }
  const realRoot = existsSync(normRoot) ? await realpath(normRoot) : normRoot

  const segments = rel.replace(/\\/g, '/').split('/')
  let current = normRoot
  for (const seg of segments) {
    if (!seg || seg === '.') continue
    if (seg === '..') throw new Error(`Directory traversal detected: ${seg}`)
    current = join(current, seg)
    if (existsSync(current)) {
      const st = await lstat(current)
      if (st.isSymbolicLink()) {
        throw new Error(`Directory segment is a symbolic link: ${current}`)
      }
      if (!st.isDirectory()) {
        throw new Error(`Directory segment is not a directory: ${current}`)
      }
      const realCur = await realpath(current)
      if (!isSubPath(realCur, realRoot)) {
        throw new Error(`Directory segment escapes root via realpath: ${current} -> ${realCur}`)
      }
    }
  }
}

/** kind:skill 用 backup。skill 単位のサブディレクトリに ts 付き .md として保存。 */
export async function takeSkillBackup(targetAbsCanonical: string, paths: SettingsPaths): Promise<string> {
  const detail = await takeSkillBackupDetail(targetAbsCanonical, paths)
  return detail.backupPath
}

async function takeSkillBackupDetail(
  targetAbsCanonical: string,
  paths: SettingsPaths
): Promise<SkillBackupDetail> {
  if (!paths.skillBackupRoot) {
    throw new Error('skillBackupRoot is not configured in SettingsPaths')
  }
  await mkdir(paths.skillBackupRoot, { recursive: true })
  const fsPath = toFsPath(targetAbsCanonical)
  const skillDir = dirname(fsPath)
  const skillName = basename(skillDir) || 'unknown'
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = join(paths.skillBackupRoot, skillName, ts)
  await mkdir(backupDir, { recursive: true })

  const hadExistingSkillDir = existsSync(skillDir)
  if (hadExistingSkillDir) {
    await copyDirRecursive(skillDir, backupDir)
  }

  const backupPath = join(backupDir, 'SKILL.md')
  if (!existsSync(backupPath)) {
    // 新規作成扱い。空 sentinel で「元は不在」を示す。
    await writeFile(backupPath, '', 'utf-8')
  }
  return { backupPath, backupDir, hadExistingSkillDir }
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
}

// --- ロック (Codex#6: competing writes 対策) ---
// 単一 Electron Main プロセス内で applyChange を直列化する in-process async mutex。
// 同時採用（連打）でレジストリ/provenance の read-modify-write が競合するのを防ぐ。
// 注: cross-instance（複数 CCPIT 同時起動）は単一インスタンス前提のため範囲外。
let applyChain: Promise<unknown> = Promise.resolve()
/**
 * CCPIT_058: skillLifecycle.ts の撤去/復元/衝突解決も同じロックを共有する（export 化）。
 * 理由: これらは applyChange と全く同じ資源（~/.claude/skills/* と adopted-skills.json）を
 * 変更するため、別ロックにすると in-flight 採用と撤去の競合窓が残る。
 */
export function withApplyLock<T>(fn: () => Promise<T>): Promise<T> {
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
  // Step 3.65 (更新採用) の追跡: レジストリ登録済み同名 skill の差し替え時、旧エントリと
  // 旧版アーカイブ先を保持し、Step 8.5 で updatedAt/previousHash/archivePath として記録する。
  let updateOfAdopted: AdoptedSkillEntry | null = null
  let updateArchivePath: string | null = null
  // Part B 採用文脈（opts.goldenSkillNames 指定時）でのみ作動。opts 無しの素の applyChange
  // （既存 v1.4 経路 / CC Request Inbox settings）は従来どおり上書き（後方互換）。
  if (request.kind === 'skill' && opts.goldenSkillNames !== undefined) {
    const origName = basename(dirname(toFsPath(norm.absolute)))
    const isGolden = opts.goldenSkillNames.includes(origName)
    if (!isGolden && existsSync(toFsPath(norm.absolute))) {
      // idempotency（marshal round6）: 既存 target が今から書く content と同一なら、これは
      // 自分の過去の採用の再実行（skill 本体は書けたが provenance/state 書込が失敗して registry
      // 未登録に見えるケースを含む）。rename せず idempotent に上書き成功させ、二重採用
      // （renamed duplicate skill）を塞ぐ。ディスク上の skill 本体が最終的な durable 真実。
      let existingRaw: string | null = null
      try {
        existingRaw = await readFile(toFsPath(norm.absolute), 'utf-8')
      } catch {
        existingRaw = null
      }
      const existingSame = existingRaw !== null && existingRaw === request.proposedSkillBody
      const provPaths = resolveProvenancePaths(opts, paths)
      let inRegistry = false
      let adoptedEntry: AdoptedSkillEntry | undefined
      try {
        const reg = await readAdoptedRegistry(provPaths)
        adoptedEntry = reg.find((e) => e.name === origName)
        inRegistry = adoptedEntry !== undefined
      } catch {
        inRegistry = false // フェイルクローズ: 不明なら先行扱い（temp 名で安全側、clobber しない）
        adoptedEntry = undefined
      }
      if (!inRegistry && !existingSame) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-')
        const tempName = `${origName}-adopted-${ts}`
        const skillsRootFs = dirname(dirname(toFsPath(norm.absolute)))
        const tempFsTarget = join(skillsRootFs, tempName, 'SKILL.md')
        effectiveCanonical = normalizeForCompare(tempFsTarget)
        effectiveSkillBody = injectCollisionWarning(request.proposedSkillBody, origName, tempName)
        case2RenamedFrom = origName
        case2TempName = tempName
      } else if (adoptedEntry !== undefined && !existingSame) {
        // Step 3.65: 更新採用 (update-adoption) — レジストリ登録済み同名 skill の差し替え。
        //   (a) CAS: ディスク実体の hash がレジストリ記録と一致することを確認。不一致 =
        //       採用後にユーザー/他ツールが手を入れている。黙って潰さず fail-closed。
        //       （existingSame = 冪等再実行は上の分岐条件で除外済み、ここには来ない）
        //   (b) 旧版を gzip アーカイブ（rollback 原則）。確保できなければ適用しない。
        const currentHash = existingRaw !== null ? hashSkillBody(existingRaw) : null
        if (currentHash === null || currentHash !== adoptedEntry.hash) {
          const detail =
            currentHash === null
              ? 'current SKILL.md unreadable'
              : `registry=${adoptedEntry.hash.slice(0, 12)} disk=${currentHash.slice(0, 12)}`
          await appendChangeLog(
            {
              timestamp: new Date().toISOString(),
              request_id: request.frontmatter.request_id,
              purpose: request.frontmatter.purpose,
              result: 'failed',
              backup_path: '',
              kind: 'skill',
              error: `base-changed: '${origName}' (${detail})`,
              reason: 'base-changed'
            },
            paths
          )
          return {
            success: false,
            error: `update refused: '${origName}' は採用記録時から実体が外部変更されています（${detail}）。手動編集を取り込むか破棄するかを確認し、整合させてから再実行してください。`,
            reason: 'base-changed'
          }
        }
        try {
          const ts = new Date().toISOString().replace(/[:.]/g, '-')
          const archiveDir = join(
            paths.parcFermeDir,
            'skill-archive',
            origName,
            `${ts}_${currentHash.slice(0, 8)}`
          )
          await mkdir(archiveDir, { recursive: true })
          await writeFile(
            join(archiveDir, 'SKILL.md.gz'),
            gzipSync(Buffer.from(existingRaw as string, 'utf-8'))
          )
          await writeFile(
            join(archiveDir, 'archive.json'),
            JSON.stringify(
              {
                name: origName,
                archivedAt: new Date().toISOString(),
                reason: 'update-adoption',
                request_id: request.frontmatter.request_id,
                priorHash: currentHash,
                priorAdoptedAt: adoptedEntry.adoptedAt,
                priorTarget: adoptedEntry.target,
                proposedHash: hashSkillBody(request.proposedSkillBody),
                restore:
                  'SKILL.md.gz を gunzip して target を置換し、adopted-skills.json の hash を priorHash に戻す'
              },
              null,
              2
            ),
            'utf-8'
          )
          updateOfAdopted = adoptedEntry
          updateArchivePath = archiveDir
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          await appendChangeLog(
            {
              timestamp: new Date().toISOString(),
              request_id: request.frontmatter.request_id,
              purpose: request.frontmatter.purpose,
              result: 'failed',
              backup_path: '',
              kind: 'skill',
              error: `archive failed: ${msg}`,
              reason: 'archive-failed'
            },
            paths
          )
          return {
            success: false,
            error: `update refused: 旧版アーカイブの作成に失敗しました（${msg}）。ロールバック実体を確保できないため適用しません。`,
            reason: 'archive-failed'
          }
        }
      }
    }
  }

  // Step 3.7: 配線前提条件ゲート (kind:settings, fail-closed) — 提案 hooks が参照する実体
  //           （~/.claude/hooks/ の hook ファイル + その hook が要求する runtime skill）が
  //           不在のまま登録だけ通ると、Stop 毎のコマンド不在エラー / block 空振りという
  //           壊れた実働状態に到達する（2026-06-13 WiringRecovery 事故 = Marshal R1 指摘の現実化）。
  //           Apply 時点で機械的に拒否し「先に実体を配置（または golden deploy）」へ誘導する。
  //           検証境界は validateHookPrerequisites 参照（管理対象パターン外コマンドは素通し）。
  if (request.kind === 'settings') {
    const prereq = validateHookPrerequisites(
      ((request.proposedSettingsParsed ?? {}) as { hooks?: unknown }).hooks,
      paths.claudeDir,
      paths.skillsRoot
    )
    if (!prereq.valid) {
      const parts: string[] = []
      if (prereq.missingHookFiles.length > 0) {
        parts.push(`hook 実体不在: ${prereq.missingHookFiles.join(', ')}`)
      }
      if (prereq.missingRequiredSkills.length > 0) {
        parts.push(`必須 skill 不在: ${prereq.missingRequiredSkills.join(', ')}`)
      }
      const detail = parts.join(' / ')
      await appendChangeLog(
        {
          timestamp: new Date().toISOString(),
          request_id: request.frontmatter.request_id,
          purpose: request.frontmatter.purpose,
          result: 'failed',
          backup_path: '',
          kind: 'settings',
          error: `hook-prerequisite: ${detail}`,
          reason: 'hook-prerequisite-missing'
        },
        paths
      )
      return {
        success: false,
        error: `apply refused: 提案 hooks が参照する実体が不在です（${detail}）。先に実体を配置（golden deploy または手動配置）してから Apply してください。`,
        reason: 'hook-prerequisite-missing'
      }
    }
  }

  // Step 3.8: 付随ファイル配置先パスの安全事前検証 (kind:skill, fail-closed)
  //           書き込みやバックアップを開始する前に、既存ディレクトリ階層にシンボリックリンク等がないかを事前検証。
  //           書き込み途中の失敗によるロールバック（既存ジャンクション消失等の副作用）を未然に防止する。
  if (request.kind === 'skill' && request.files && request.files.length > 0) {
    const fsTargetPath = toFsPath(effectiveCanonical)
    const skillDir = dirname(fsTargetPath)
    for (const f of request.files) {
      const destPath = join(skillDir, ...f.relPath.split('/'))
      try {
        await verifyDirSafe(dirname(destPath), skillDir)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        await appendChangeLog(
          {
            timestamp: new Date().toISOString(),
            request_id: request.frontmatter.request_id,
            purpose: request.frontmatter.purpose,
            result: 'failed',
            backup_path: '',
            kind: 'skill',
            error: `path-validation: ${msg}`,
            reason: 'path-validation-failed'
          },
          paths
        )
        return {
          success: false,
          error: `apply refused: 付随ファイルの配置先パスが不正です（${msg}）。`,
          reason: 'path-validation-failed'
        }
      }
    }
  }

  // Step 4: backup (kind 別)
  let backupPath = ''
  let skillBackupDetail: SkillBackupDetail | null = null
  if (request.kind === 'settings') {
    backupPath = await takeSettingsBackup(paths)
  } else {
    skillBackupDetail = await takeSkillBackupDetail(effectiveCanonical, paths)
    backupPath = skillBackupDetail.backupPath
  }

  // Step 5: write (kind 別)。kind:skill は effective（ケース2 で一時名/警告ヘッダ込みになりうる）を使う。
  const fsTargetPath = toFsPath(effectiveCanonical)
  try {
    if (request.kind === 'settings') {
      const proposedFormatted = JSON.stringify(request.proposedSettingsParsed, null, 2)
      await mkdir(dirname(fsTargetPath), { recursive: true })
      await writeFile(fsTargetPath, proposedFormatted, 'utf-8')
    } else {
      // kind: 'skill'
      const skillDir = dirname(fsTargetPath)
      if (request.files && request.files.length > 0) {
        // 複数ファイル配置（Section 3 由来）
        for (const f of request.files) {
          const contentToWrite = f.relPath === 'SKILL.md' ? effectiveSkillBody : f.content
          const destPath = join(skillDir, ...f.relPath.split('/'))
          await ensureDirSafe(dirname(destPath), skillDir)
          await writeFileAtomic(destPath, contentToWrite)
        }
      } else {
        // 従来型単一ファイル
        await mkdir(skillDir, { recursive: true })
        await writeFileAtomic(fsTargetPath, effectiveSkillBody)
      }
    }
  } catch (err) {
    if (request.kind === 'skill' && skillBackupDetail) {
      try {
        const skillDir = dirname(fsTargetPath)
        if (!skillBackupDetail.hadExistingSkillDir) {
          await rm(skillDir, { recursive: true, force: true })
        } else {
          await rm(skillDir, { recursive: true, force: true })
          await mkdir(skillDir, { recursive: true })
          await copyDirRecursive(skillBackupDetail.backupDir, skillDir)
          const restoredSkillMd = join(skillDir, 'SKILL.md')
          if (existsSync(restoredSkillMd)) {
            const content = await readFile(restoredSkillMd, 'utf-8')
            if (content.length === 0) {
              await rm(restoredSkillMd, { force: true })
            }
          }
        }
      } catch {
        // rollback failed
      }
    }
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
    if (request.kind === 'settings') {
      const postRaw = await readFile(fsTargetPath, 'utf-8')
      JSON.parse(postRaw)
    } else if (request.files && request.files.length > 0) {
      const skillDir = dirname(fsTargetPath)
      for (const f of request.files) {
        const expected = f.relPath === 'SKILL.md' ? effectiveSkillBody : f.content
        const destPath = join(skillDir, ...f.relPath.split('/'))
        if (!existsSync(destPath)) {
          verifyError = `post-write file missing: ${f.relPath}`
          break
        }
        const postRaw = await readFile(destPath, 'utf-8')
        if (postRaw !== expected) {
          verifyError = `post-write content mismatch for ${f.relPath} (byte-level inequality)`
          break
        }
      }
    } else {
      // skill: バイト列等価チェック（effective ＝ ケース2 で警告ヘッダ込みになりうる）
      const postRaw = await readFile(fsTargetPath, 'utf-8')
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
      if (request.kind === 'settings') {
        if (existsSync(backupPath)) {
          const backupContent = await readFile(backupPath, 'utf-8')
          if (backupContent.length > 0) {
            await copyFile(backupPath, fsTargetPath)
            rolledBack = true
          }
        }
      } else if (skillBackupDetail) {
        const skillDir = dirname(fsTargetPath)
        if (!skillBackupDetail.hadExistingSkillDir) {
          await rm(skillDir, { recursive: true, force: true })
          rolledBack = true
        } else {
          await rm(skillDir, { recursive: true, force: true })
          await mkdir(skillDir, { recursive: true })
          await copyDirRecursive(skillBackupDetail.backupDir, skillDir)
          const restoredSkillMd = join(skillDir, 'SKILL.md')
          if (existsSync(restoredSkillMd)) {
            const content = await readFile(restoredSkillMd, 'utf-8')
            if (content.length === 0) {
              await rm(restoredSkillMd, { force: true })
            }
          }
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
          // 更新採用では初回採用時刻を保持し、今回時刻は updatedAt に記録する
          adoptedAt: updateOfAdopted !== null ? updateOfAdopted.adoptedAt : appliedAt,
          source: isEmergency ? 'emergency' : 'adopted',
          goldenVersionAtAdoption: opts.currentGoldenVersion,
          ...(updateOfAdopted !== null
            ? {
                updatedAt: appliedAt,
                previousHash: updateOfAdopted.hash,
                archivePath: updateArchivePath ?? undefined
              }
            : {})
        },
        provPaths
      )
    } catch {
      // provenance 記録失敗は apply 成功を覆さない（best-effort）
    }

    // Step 8.6: manifest の該当エントリに adopted 印を付ける（§9.7）。
    //           8.5 の出自レジストリとは別系統の記録なので try も分ける
    //           — 片方が落ちてももう片方は残す。
    try {
      await markAdopted({
        manifestPath: getManifestPath(paths.parcFermeDir),
        targetDir: paths.claudeDir,
        absPath: toFsPath(effectiveCanonical)
      })
    } catch {
      // manifest 更新失敗も apply 成功を覆さない（best-effort）。
      // 印が付かなかった場合の劣化は「次回起動で確認ダイアログに載る」であって、
      // 採用内容の破壊ではない（fail-safe の向きが正しいことを確認済み）。
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

  return {
    success: true,
    backupPath,
    appliedAt,
    ...(updateArchivePath !== null ? { archivePath: updateArchivePath } : {})
  }
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

// =============================================================================
//   CCPIT_058: 更新採用アーカイブからのロールバック
//   （archive.json.restore フィールドが文章でだけ述べていた手順の実体化）
// =============================================================================

/** 更新採用（Step 3.65）が書く archive.json の形。 */
export interface SkillArchiveMetadata {
  name: string
  archivedAt: string
  reason: string
  request_id?: string
  priorHash: string
  priorAdoptedAt?: string
  priorTarget?: string
  proposedHash?: string
  restore?: string
}

export type RestoreArchiveReason =
  | 'archive-unreadable'
  | 'archive-metadata-mismatch'
  | 'no-current-registry-entry'
  | 'base-changed'
  | 'archive-corrupt'
  | 'write-failed'
  | 'archive-failed'
  | 'path-containment-violation'

export interface RestoreArchiveResult {
  success: boolean
  error?: string
  reason?: RestoreArchiveReason
  restoredHash?: string
  newArchivePath?: string
}

/**
 * 更新採用アーカイブからのロールバック（CCPIT_058 §5）。
 *
 * 名称と意味: これは「直前の更新採用より前の版へのロールバック」であり、汎用の drift 修復ではない。
 * CAS は現在のディスク実体がレジストリの**現在の** hash と一致するかを見る
 * （＝直近の更新採用がまだ手つかず・整合の行にのみ許可する、意図した設計）。
 * hash が一致しない行（drift）では意図的に `base-changed` で拒否する — これは不具合ではなく、
 * 「この更新採用より後にさらに何か別の変更が加わっている状態を無検証で上書きしない」という安全側の判断。
 * 呼び出し側（skillLifecycle.ts の一覧生成）は、この CAS が現時点で通るかを
 * `bucket==='clean' && registryEntry.archivePath が設定済み` から読み取り専用で先読みし、
 * 通らない行にはロールバックボタンを活性表示しない。
 */
export function restoreSkillArchive(
  name: string,
  archivePath: string,
  paths: SettingsPaths = getDefaultSettingsPaths(),
  opts: ApplyOptions = {}
): Promise<RestoreArchiveResult> {
  return withApplyLock(() => restoreSkillArchiveInner(name, archivePath, paths, opts))
}

async function restoreSkillArchiveInner(
  name: string,
  archivePath: string,
  paths: SettingsPaths,
  opts: ApplyOptions
): Promise<RestoreArchiveResult> {
  // 1. アーカイブメタデータの検証（Codex #20: メタデータの信頼性を無検証で信じない）
  let meta: SkillArchiveMetadata
  try {
    const metaRaw = await readFile(join(archivePath, 'archive.json'), 'utf-8')
    meta = JSON.parse(metaRaw) as SkillArchiveMetadata
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, reason: 'archive-unreadable', error: `archive.json unreadable: ${msg}` }
  }
  if (meta.name !== name || typeof meta.priorHash !== 'string' || meta.priorHash.length === 0) {
    return {
      success: false,
      reason: 'archive-metadata-mismatch',
      error: `archive.json does not match requested skill '${name}'`
    }
  }

  // 2. 現在のレジストリエントリを取得し、archivePath が一致するか確認
  const provPaths = resolveProvenancePaths(opts, paths)
  const registry = await readAdoptedRegistry(provPaths)
  const entry = registry.find((e) => e.name === name)
  if (!entry) {
    return {
      success: false,
      reason: 'no-current-registry-entry',
      error: `'${name}' is not currently adopted`
    }
  }
  if (entry.archivePath !== archivePath) {
    return {
      success: false,
      reason: 'archive-metadata-mismatch',
      error: `registry archivePath does not match the requested archive for '${name}'`
    }
  }

  // 2.5. パス封じ込め（CCPIT_058 addendum-01 [2]）: skillLifecycle.ts の管理操作は
  //      target を直接信用せず name から正規パスを導出するのが原則。ここは entry.target を
  //      書込先にするため、レジストリが手編集されていても skills ルート外へは書けないことを
  //      検査で担保する（CAS/archivePath 一致だけでは「ルート内か」までは守れない）。
  const targetFsPath = toFsPath(normalizeForCompare(entry.target))
  const skillsRootConfigured = paths.skillsRoot ?? join(paths.claudeDir, 'skills')
  let realTargetDir: string
  let realSkillsRoot: string
  try {
    realTargetDir = await realpath(dirname(targetFsPath))
    realSkillsRoot = await realpath(skillsRootConfigured)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, reason: 'base-changed', error: `cannot resolve target path: ${msg}` }
  }
  if (!isPathUnder(realTargetDir, realSkillsRoot)) {
    return {
      success: false,
      reason: 'path-containment-violation',
      error: `registry target for '${name}' does not resolve under the skills root; refused`
    }
  }

  // 3. CAS: 現在のディスク実体がレジストリの現在の hash と一致するか
  let currentRaw: string
  try {
    currentRaw = await readFile(targetFsPath, 'utf-8')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, reason: 'base-changed', error: `current SKILL.md unreadable: ${msg}` }
  }
  const currentHash = hashSkillBody(currentRaw)
  if (currentHash !== entry.hash) {
    return {
      success: false,
      reason: 'base-changed',
      error: `'${name}' has changed since this archive's update (registry=${entry.hash.slice(0, 12)} disk=${currentHash.slice(0, 12)}); rollback refused to avoid discarding an unrelated change`
    }
  }

  // 4. gzip 展開 + 自己検証
  let restoredBody: string
  try {
    const gz = await readFile(join(archivePath, 'SKILL.md.gz'))
    restoredBody = gunzipSync(gz).toString('utf-8')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, reason: 'archive-corrupt', error: `SKILL.md.gz unreadable: ${msg}` }
  }
  const restoredHash = hashSkillBody(restoredBody)
  if (restoredHash !== meta.priorHash) {
    return {
      success: false,
      reason: 'archive-corrupt',
      error: `gunzipped content hash does not match archive.json.priorHash for '${name}'`
    }
  }

  // 5. 書き戻し前に現在の内容を新規アーカイブとして退避（ロールバック自体がさらにロールバック可能に）
  let newArchivePath: string
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    newArchivePath = join(paths.parcFermeDir, 'skill-archive', name, `${ts}_${currentHash.slice(0, 8)}`)
    await mkdir(newArchivePath, { recursive: true })
    await writeFileAtomic(
      join(newArchivePath, 'SKILL.md.gz'),
      gzipSync(Buffer.from(currentRaw, 'utf-8'))
    )
    const newMeta: SkillArchiveMetadata = {
      name,
      archivedAt: new Date().toISOString(),
      reason: 'restore-archive',
      priorHash: currentHash,
      priorAdoptedAt: entry.adoptedAt,
      priorTarget: entry.target,
      proposedHash: meta.priorHash,
      restore:
        'SKILL.md.gz を gunzip して target を置換し、adopted-skills.json の hash を priorHash に戻す'
    }
    await writeFileAtomic(join(newArchivePath, 'archive.json'), JSON.stringify(newMeta, null, 2))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      success: false,
      reason: 'archive-failed',
      error: `failed to archive current content before rollback: ${msg}`
    }
  }

  // 6. 書き戻し（atomic）
  try {
    await writeFileAtomic(targetFsPath, restoredBody)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, reason: 'write-failed', error: `write failed: ${msg}` }
  }

  // 7. レジストリ更新。hash = priorHash は「任意の現在ディスク内容」ではなく、それが archive
  //    される瞬間に当時のレジストリ hash と一致することを CAS で確認した後にアーカイブされた
  //    実体（Step 3.65 が既にそう作っている）＝「かつて実際に成立していた採用状態への巻き戻し」。
  //    adoptedAt/updatedAt の意味は上書きしない。専用の restoredFromArchiveAt に記録する。
  const nowIso = new Date().toISOString()
  await upsertAdoptedSkill(
    {
      ...entry,
      hash: meta.priorHash,
      previousHash: currentHash,
      archivePath: newArchivePath,
      updatedAt: nowIso,
      restoredFromArchiveAt: nowIso
    },
    provPaths
  )

  return { success: true, restoredHash: meta.priorHash, newArchivePath }
}
