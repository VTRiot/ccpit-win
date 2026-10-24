/**
 * skillLifecycle — 採用済み skill の棚卸し・撤去・衝突解決（CCPIT_058）。
 *
 * 採用（settingsChange.ts の applyChange）は「採用する」ことしか扱わない。本モジュールは
 * その**後**のライフサイクル — 実体とレジストリの乖離を可視化し（4 区分）、不要な skill を
 * 可逆な形で外し（撤去/復元）、同名衝突を画面内操作だけで解決する（注入警告コメントの除去含む）。
 *
 * golden 配布系（goldenManifest.ts / golden.ts）には一切新規結合しない。golden 名一覧の取得
 * （既に採用時の同名禁止ガードで使われている listGoldenSkillNames）だけを read-only で再利用する。
 */

import { readFile, mkdir, rename, rm, cp, lstat, realpath, readdir } from 'fs/promises'
import { existsSync } from 'fs'
import { createHash } from 'crypto'
import { join, dirname, basename, relative, isAbsolute, normalize } from 'path'
import { homedir } from 'os'
import { scanSkills } from './cces/extensionScanner'
import { listGoldenSkillNames } from './golden'
import {
  hashSkillBody,
  readAdoptedRegistry,
  upsertAdoptedSkill,
  removeAdoptedSkillEntry,
  getDefaultProvenancePaths,
  type AdoptedSkillEntry,
  type ProvenancePaths
} from './skillProvenance'
import { parseSkillDetail, type SkillDetailInfo } from './goldenPromotion'
import {
  getDefaultSettingsPaths,
  withApplyLock,
  normalizeForCompare,
  type SettingsPaths
} from './settingsChange'
import { writeFileAtomic, writeJsonArrayAtomic } from './atomicFile'

// =============================================================================
//   パス
// =============================================================================

export interface SkillLifecyclePaths {
  /** ~/.claude/tmp/skill-lifecycle-removed — 撤去の隔離先。裸の ~/.claude/tmp/ 直下にしない
   *  （他ツールが緩く消費しうる場所と混ぜない。CCPIT_058 Codex #9）。 */
  quarantineRoot: string
  /** ~/.ccpit/removed-skills.json — 撤去台帳 */
  removalLedgerPath: string
}

export function getDefaultSkillLifecyclePaths(): SkillLifecyclePaths {
  const home = homedir()
  return {
    quarantineRoot: join(home, '.claude', 'tmp', 'skill-lifecycle-removed'),
    removalLedgerPath: join(home, '.ccpit', 'removed-skills.json')
  }
}

// =============================================================================
//   一覧（4 区分の照合）
// =============================================================================

export type SkillBucket = 'bypass' | 'missing' | 'drift' | 'clean'

export interface SkillInventoryEntry {
  name: string
  bucket: SkillBucket
  filePath: string | null
  registryEntry: AdoptedSkillEntry | null
  onDiskHash: string | null
  /** SKILL.md の読取自体が失敗した場合のエラーメッセージ（bucket は変えず 'drift' のまま。
   *  「採用後に内容が変更された」のか「単に読めなかった」のかを UI 側で区別するため。
   *  読めた場合は null（CCPIT_058 addendum-01 [5]）。 */
  readError: string | null
  adoptedAt: string | null
  /** entry.target の親ディレクトリ名が name と一致しない、または skillsRoot 配下に解決しない場合 true。
   *  管理操作は常に name から導出した正規パスを使い、target を直接信用しない（Codex #29）。 */
  targetMismatch: boolean
  /** アーカイブからのロールバックが現時点で成立するか（bucket==='clean' かつ archivePath 設定済み）。
   *  settingsChange.ts::restoreSkillArchive の CAS と等価な条件を読み取り専用で先読みする（Codex #21）。 */
  canRestoreArchive: boolean
  /** list() 時点のスナップショットに対する不透明トークン。mutation はこれを渡し、
   *  ロック内で再計算した値と一致しなければ 'state-changed' で拒否する（Codex #13）。 */
  stateToken: string
  /** G-3: スキルの構造化メタデータ（Title, Description, What, Why, How, RawContent） */
  skillDetail?: SkillDetailInfo
}

export interface CollisionPair {
  originalName: string
  tempName: string // '<originalName>-adopted-<timestamp>'
  originalPath: string
  tempPath: string
  tempRegistryEntry: AdoptedSkillEntry
  stateToken: string
}

/**
 * 衝突解決（keep:'temp'）の複数ステップ横断で中断した可能性の検出（書込なし・検出のみ。
 * CCPIT_058 addendum-01 [7]）。データは失われないが、中断すると collisionPairs から該当ペアが
 * 消え画面内で解決を再開する導線が失われるため、撤去台帳の committed 記録を手掛かりに拾い上げる。
 */
export interface InterruptedCollisionHint {
  originalName: string
  detail: string
}

export interface RemovalRecord {
  id: string
  name: string
  reason: 'manual' | 'collision-resolution'
  status: 'pending' | 'committed'
  removedAt: string
  /** 動かすファイルが無い撤去（missing バケット＝孤立レジストリレコードの破棄）は null。 */
  movedTo: string | null
  /** 復元時に丸ごと再書込（hash/adoptedAt を再生成しない）。bypass 由来（元々未登録）は null。 */
  priorRegistryEntry: AdoptedSkillEntry | null
  /** 復元後もレコードは残す（監査証跡）。 */
  restoredAt?: string
}

/**
 * 画面へ出す復元候補（撤去台帳の committed かつ未復元）。CCPIT_058 addendum-02 W-1。
 *
 * 撤去直後のトーストは 8 秒で消えるため、それだけでは親発注 AC-3「撤去は取り消せる」が
 * トーストの寿命でしか成立していなかった。台帳には復元に要る情報が全部残っているので、
 * 棚卸し結果へ載せて後からでも画面から辿り着けるようにする。
 */
export interface RestorableRemoval {
  record: RemovalRecord
  /** 隔離先が実在するか。movedTo が null（実体欠落区分の撤去＝動かすものが無い）は true 扱い。
   *  **表示補助であり権限判定には使わない** — 棚卸し後に隔離先が消えうるため、実行時の
   *  再検査は restoreRemovedSkill 側が行う（addendum-02 Codex #3）。 */
  movedToExists: boolean
  /** 復元がレジストリへの書き戻しを伴うか（priorRegistryEntry が非 null）。 */
  writesRegistry: boolean
}

export interface SkillInventoryResult {
  entries: SkillInventoryEntry[] // flat レイアウトのみ（catalysts は下記の理由で除外）
  /** 4 区分の件数。合計が entries.length と一致する必要はない
   *  （bypass は on-disk 起点・missing は registry 起点で母集団が異なる。Codex #3）。 */
  counts: Record<SkillBucket, number>
  collisionPairs: CollisionPair[]
  /** 検出のみ・全面トランザクション化はしない（addendum-01 [7]）。 */
  possibleInterruptedCollisions: InterruptedCollisionHint[]
  catalystInfo: {
    count: number
    names: string[]
    /** flat 管理集合と terminal name が衝突する catalyst 名（情報表示のみ、操作不可。Codex #18） */
    collidesWithManaged: string[]
  }
  goldenExcludedCount: number
  goldenExcludedNames: string[]
  /** レジストリ内で name が重複しているエントリ群。手動整理されるまで該当 name への
   *  mutation は拒否する（Codex #28）。 */
  duplicateNames: string[]
  /** 撤去台帳に status:'pending' のまま残るレコード（中断の形跡）。list() 側で検出し、
   *  黙って無視しない（Codex #10/#11）。 */
  pendingRemovals: RemovalRecord[]
  /** 撤去台帳の committed かつ未復元＝**後からでも画面から復元できる候補**（addendum-02 W-1）。
   *  レジストリ読取失敗時も候補自体は出す — 隠しても危険な書込み経路（トーストの undo）は
   *  塞がらず、可用性だけ落ちるため（addendum-02 Codex #1）。書き戻しを伴うものの抑止は
   *  writesRegistry を見て画面側で行い、最終的な拒否は restoreRemovedSkill が行う。 */
  restorableRemovals: RestorableRemoval[]
  registryReadError: string | null
  ledgerReadError: string | null
  registryPath: string
  ledgerPath: string
  scannedAt: string
}

const COLLISION_NAME_RE = /^(.+)-adopted-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)$/
export const COLLISION_MARKER_TEXT = '[CCPIT name-collision'
const COLLISION_MARKER_RE_WITH_FRONTMATTER =
  /^(---\r?\n[\s\S]*?\r?\n---\r?\n)(<!--\r?\n\[CCPIT name-collision[\s\S]*?\r?\n-->\r?\n)([\s\S]*)$/
/**
 * settingsChange.ts::injectCollisionWarning の「frontmatter が見つからない場合、先頭へ直接
 * warning を差し込む」第 2 分岐（`return warning + body`）の逆演算（CCPIT_058 addendum-01 [4]）。
 * `applyChange` の kind:skill 内容検証（Step 2）は proposedSkillBody に frontmatter を要求しない
 * ため、この形は理論上でなく実際に到達可能と確認した — 「到達不能」と明記して逃げず、逆演算を用意する。
 */
const COLLISION_MARKER_RE_NO_FRONTMATTER =
  /^(<!--\r?\n\[CCPIT name-collision[\s\S]*?\r?\n-->\r?\n)([\s\S]*)$/

/**
 * settingsChange.ts::injectCollisionWarning の構造的逆演算（純関数、単体テスト用に export）。
 * frontmatter 直後（または frontmatter が無い場合は先頭）の該当 HTML コメントブロックだけを
 * 剥がし、他の本文は一切変更しない。どちらの構造にも一致しない場合（コメント形が壊れている等）
 * は null を返し、呼び出し側は無言で成功させず明示的に中止する（CCPIT_058 Codex #19）。
 */
export function stripCollisionWarning(body: string): string | null {
  const withFm = body.match(COLLISION_MARKER_RE_WITH_FRONTMATTER)
  if (withFm) return withFm[1] + withFm[3]
  const noFm = body.match(COLLISION_MARKER_RE_NO_FRONTMATTER)
  if (noFm) return noFm[2]
  return null
}

function computeStateToken(parts: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16)
}

function skillsRootOf(settingsPaths: SettingsPaths): string {
  return settingsPaths.skillsRoot ?? join(settingsPaths.claudeDir, 'skills')
}

/** child が parent 配下に解決するか（トラバーサル防御。Codex #14）。 */
function isPathUnder(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && rel !== '.' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** dir 配下の全ファイルを相対パス（forward slash・ソート済み）で列挙する（EXDEV 検証用）。
 *  Node の readdir({recursive:true}) フラグには頼らず自前で再帰する（withFileTypes との
 *  組合せ挙動がバージョンで揺れた既往があるため。CCPIT_058 addendum-01 [3]）。 */
async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = []
  async function walk(sub: string): Promise<void> {
    const items = await readdir(sub, { withFileTypes: true })
    for (const it of items) {
      const full = join(sub, it.name)
      if (it.isDirectory()) {
        await walk(full)
      } else if (it.isFile()) {
        out.push(relative(dir, full).replace(/\\/g, '/'))
      }
    }
  }
  await walk(dir)
  return out.sort()
}

/** 1 ファイルの sha256（バイト列。SKILL.md 本文の hashSkillBody とは別軸 — こちらはコピー
 *  検証用でテキスト前提ではない。CCPIT_058 addendum-01 [3]）。 */
async function hashFileBytes(path: string): Promise<string> {
  const buf = await readFile(path)
  return createHash('sha256').update(buf).digest('hex')
}

async function readRemovalLedgerSoft(
  ledgerPath: string
): Promise<{ list: RemovalRecord[]; error: string | null }> {
  if (!existsSync(ledgerPath)) return { list: [], error: null }
  try {
    const raw = await readFile(ledgerPath, 'utf-8')
    if (raw.trim() === '') return { list: [], error: null }
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return { list: [], error: 'removed-skills.json is not an array' }
    return { list: parsed as RemovalRecord[], error: null }
  } catch (err) {
    return { list: [], error: err instanceof Error ? err.message : String(err) }
  }
}

/** 撤去台帳を読む。破損時は throw（呼び出し側がフェイルクローズできるように）。 */
async function readRemovalLedgerStrict(ledgerPath: string): Promise<RemovalRecord[]> {
  if (!existsSync(ledgerPath)) return []
  const raw = await readFile(ledgerPath, 'utf-8')
  if (raw.trim() === '') return []
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) throw new Error('removed-skills.json is not an array')
  return parsed as RemovalRecord[]
}

/** 撤去台帳へ 1 件 upsert（id キーで置換）。破損ファイルは退避して新規開始する。 */
async function upsertRemovalRecord(record: RemovalRecord, ledgerPath: string): Promise<void> {
  let list: RemovalRecord[] = []
  try {
    list = await readRemovalLedgerStrict(ledgerPath)
  } catch {
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    try {
      await rename(ledgerPath, `${ledgerPath}.corrupt-${ts}`)
    } catch {
      // 退避失敗時もブロックしない
    }
    list = []
  }
  const next = list.filter((r) => r.id !== record.id)
  next.push(record)
  await mkdir(dirname(ledgerPath), { recursive: true })
  await writeJsonArrayAtomic(ledgerPath, next)
}

/**
 * 採用済み skill の棚卸し（読み取り専用）。extensionScanner の filesystem 走査 +
 * skillProvenance の registry 読取 + golden.ts の同名一覧を合成し、4 区分へ分類する。
 */
export async function computeSkillInventory(
  settingsPaths: SettingsPaths = getDefaultSettingsPaths(),
  provPaths: ProvenancePaths = getDefaultProvenancePaths(),
  lcPaths: SkillLifecyclePaths = getDefaultSkillLifecyclePaths()
): Promise<SkillInventoryResult> {
  return computeSkillInventoryInner(settingsPaths, provPaths, lcPaths)
}

async function computeSkillInventoryInner(
  settingsPaths: SettingsPaths,
  provPaths: ProvenancePaths,
  lcPaths: SkillLifecyclePaths
): Promise<SkillInventoryResult> {
  const skillsRoot = skillsRootOf(settingsPaths)
  const scanned = await scanSkills(skillsRoot, 'global')
  const goldenNames = new Set(await listGoldenSkillNames())

  const { list: ledgerList, error: ledgerReadError } = await readRemovalLedgerSoft(
    lcPaths.removalLedgerPath
  )
  const pendingRemovals = ledgerList.filter((r) => r.status === 'pending')
  // 復元候補: committed かつ未復元。restoredAt 付きは監査証跡として台帳に残り続ける仕様なので
  // 除外しないと復元済みが再び候補へ並ぶ。pending は移動が完了しておらず API 側も拒否する。
  const restorableRemovals: RestorableRemoval[] = ledgerList
    .filter((r) => r.status === 'committed' && !r.restoredAt)
    .map((r) => ({
      record: r,
      movedToExists: r.movedTo === null ? true : existsSync(r.movedTo),
      writesRegistry: r.priorRegistryEntry != null
    }))

  // flat レイアウトの実際のディレクトリ名（frontmatter name: ではなく、path から導出した
  // 実ディレクトリ名を join key にする — Skill.name は frontmatter 由来で乖離しうるため）。
  const onDiskFlat = new Map<string, { path: string }>()
  for (const s of scanned.regular) {
    const dirName = basename(dirname(s.path))
    onDiskFlat.set(dirName, { path: s.path })
  }

  const catalystNames: string[] = []
  const collidesWithManaged: string[] = []
  for (const s of scanned.catalyst) {
    const dirName = basename(dirname(s.path))
    catalystNames.push(dirName)
    if (onDiskFlat.has(dirName)) collidesWithManaged.push(dirName)
  }

  let registry: AdoptedSkillEntry[] = []
  let registryReadError: string | null = null
  try {
    registry = await readAdoptedRegistry(provPaths)
  } catch (err) {
    registryReadError = err instanceof Error ? err.message : String(err)
    // フェイルクローズ: 全区分 0 件で返す（IPC 境界へ生の例外を渡さない・全部を bypass と誤判定しない）
    return {
      entries: [],
      counts: { bypass: 0, missing: 0, drift: 0, clean: 0 },
      collisionPairs: [],
      possibleInterruptedCollisions: [],
      catalystInfo: { count: catalystNames.length, names: catalystNames, collidesWithManaged },
      goldenExcludedCount: 0,
      goldenExcludedNames: [],
      duplicateNames: [],
      pendingRemovals,
      // レジストリが読めなくても台帳は独立に読めている。復元候補は隠さない（Codex #1）。
      restorableRemovals,
      registryReadError,
      ledgerReadError,
      registryPath: provPaths.adoptedRegistryPath,
      ledgerPath: lcPaths.removalLedgerPath,
      scannedAt: new Date().toISOString()
    }
  }

  // 重複 name 検出（Codex #28） — 手編集でしか起こらないが検出したら該当 name を分類から除外する
  const byName = new Map<string, AdoptedSkillEntry[]>()
  for (const e of registry) {
    const arr = byName.get(e.name) ?? []
    arr.push(e)
    byName.set(e.name, arr)
  }
  const duplicateNames: string[] = []
  for (const [name, arr] of byName) {
    if (arr.length > 1) duplicateNames.push(name)
  }
  const duplicateSet = new Set(duplicateNames)

  const entries: SkillInventoryEntry[] = []
  const counts: Record<SkillBucket, number> = { bypass: 0, missing: 0, drift: 0, clean: 0 }
  const goldenExcludedNames: string[] = []

  // registry 起点: missing / drift / clean
  for (const [name, arr] of byName) {
    if (duplicateSet.has(name)) continue
    const entry = arr[0]
    const disk = onDiskFlat.get(name)
    const skillsRootNorm = normalize(skillsRoot)
    const targetDirName = basename(dirname(normalize(entry.target)))
    const targetUnderRoot = isPathUnder(normalize(entry.target), skillsRootNorm)
    const targetMismatch = targetDirName !== name || !targetUnderRoot

    if (!disk) {
      const stateToken = computeStateToken({ name, bucket: 'missing', registryHash: entry.hash })
      entries.push({
        name,
        bucket: 'missing',
        filePath: null,
        registryEntry: entry,
        onDiskHash: null,
        readError: null,
        adoptedAt: entry.adoptedAt,
        targetMismatch,
        canRestoreArchive: false,
        stateToken,
        skillDetail: {
          name,
          title: name,
          description: 'ディスク上に実体ファイルが存在しません（missing）',
          rawContent: ''
        }
      })
      counts.missing++
      continue
    }

    let onDiskHash: string | null = null
    let readError: string | null = null
    let skillDetail: SkillDetailInfo | undefined
    try {
      const raw = await readFile(disk.path, 'utf-8')
      onDiskHash = hashSkillBody(raw)
      skillDetail = parseSkillDetail(raw, name)
    } catch (err) {
      onDiskHash = null
      readError = err instanceof Error ? err.message : String(err)
      skillDetail = {
        name,
        title: name,
        description: `ファイル読み取りエラー: ${readError}`,
        rawContent: ''
      }
    }
    const bucket: SkillBucket = onDiskHash !== null && onDiskHash === entry.hash ? 'clean' : 'drift'
    const canRestoreArchive = bucket === 'clean' && !!entry.archivePath
    const stateToken = computeStateToken({
      name,
      bucket,
      onDiskHash,
      registryHash: entry.hash,
      target: entry.target
    })
    entries.push({
      name,
      bucket,
      filePath: disk.path,
      registryEntry: entry,
      onDiskHash,
      readError,
      adoptedAt: entry.adoptedAt,
      targetMismatch,
      canRestoreArchive,
      stateToken,
      skillDetail
    })
    counts[bucket]++
  }

  // on-disk 起点: bypass（registry 未登録の flat skill。golden 名・重複名は除外）
  for (const [name, disk] of onDiskFlat) {
    if (byName.has(name)) continue // registry 側で既に処理済み（missing/drift/clean）
    if (duplicateSet.has(name)) continue
    if (goldenNames.has(name)) {
      goldenExcludedNames.push(name)
      continue
    }
    const stateToken = computeStateToken({ name, bucket: 'bypass', path: disk.path })
    let bypassDetail: SkillDetailInfo | undefined
    try {
      const raw = await readFile(disk.path, 'utf-8')
      bypassDetail = parseSkillDetail(raw, name)
    } catch {
      bypassDetail = {
        name,
        title: name,
        description: '未登録スキル（bypass）',
        rawContent: ''
      }
    }
    entries.push({
      name,
      bucket: 'bypass',
      filePath: disk.path,
      registryEntry: null,
      onDiskHash: null,
      readError: null,
      adoptedAt: null,
      targetMismatch: false,
      canRestoreArchive: false,
      stateToken,
      skillDetail: bypassDetail
    })
    counts.bypass++
  }

  // 衝突ペア検出（Codex #4: 名前パターン一致だけでは誤検出しうるため 3 条件の AND）
  const collisionPairs: CollisionPair[] = []
  for (const [tempName, arr] of byName) {
    if (duplicateSet.has(tempName)) continue
    const m = tempName.match(COLLISION_NAME_RE)
    if (!m) continue
    const originalName = m[1]
    const tempEntry = arr[0]
    const tempDisk = onDiskFlat.get(tempName)
    const origDisk = onDiskFlat.get(originalName)
    if (!tempDisk || !origDisk) continue
    if (byName.has(originalName)) continue // originalName が既に登録済みなら衝突ではない
    let tempBody = ''
    try {
      tempBody = await readFile(tempDisk.path, 'utf-8')
    } catch {
      continue
    }
    if (!tempBody.includes(COLLISION_MARKER_TEXT)) continue
    const stateToken = computeStateToken({
      originalName,
      tempName,
      tempHash: tempEntry.hash,
      tempTarget: tempEntry.target
    })
    collisionPairs.push({
      originalName,
      tempName,
      originalPath: origDisk.path,
      tempPath: tempDisk.path,
      tempRegistryEntry: tempEntry,
      stateToken
    })
  }

  // 衝突解決 (keep:'temp') の中断検出（Codex addendum-01 [7]、検出のみ・書込なし）。
  // removeSkillCore は撤去台帳へ reason:'collision-resolution' で記録している。keep:'temp' の
  // 手順 1（先行実体の撤去）が committed になった記録のうち、後続の手順（マーカー剥がし →
  // rename → レジストリ再構成）が正常に終わっていれば originalName は clean/drift として
  // 登録済みになる。そうなっていない場合だけを「中断の疑い」として拾う（false-positive を
  // 避けるため、記録が無い名前や正常完了済みの名前には触れない）。
  const possibleInterruptedCollisions: InterruptedCollisionHint[] = []
  for (const rec of ledgerList) {
    if (rec.status !== 'committed' || rec.reason !== 'collision-resolution' || rec.restoredAt) continue
    // rec.name が temp パターンなら keep:'original' の単発撤去（それ自体で完結し中断し得ない）
    if (COLLISION_NAME_RE.test(rec.name)) continue
    const originalName = rec.name

    const staleTempStillPresent =
      [...onDiskFlat.keys()].some((n) => COLLISION_NAME_RE.exec(n)?.[1] === originalName) ||
      [...byName.keys()].some((n) => COLLISION_NAME_RE.exec(n)?.[1] === originalName)
    if (staleTempStillPresent) {
      possibleInterruptedCollisions.push({
        originalName,
        detail:
          'collision-resolution recorded as committed for the original entity, but a temp-named entity for it still exists (marker removal or rename likely incomplete)'
      })
      continue
    }
    const stillBypass = entries.some((e) => e.name === originalName && e.bucket === 'bypass')
    if (stillBypass) {
      possibleInterruptedCollisions.push({
        originalName,
        detail:
          'collision-resolution recorded as committed and no temp entity remains, but the canonical name is still unregistered (bypass) — registry update likely incomplete'
      })
    }
  }

  return {
    entries,
    counts,
    collisionPairs,
    possibleInterruptedCollisions,
    catalystInfo: { count: catalystNames.length, names: catalystNames, collidesWithManaged },
    goldenExcludedCount: goldenExcludedNames.length,
    goldenExcludedNames,
    duplicateNames,
    pendingRemovals,
    restorableRemovals,
    registryReadError: null,
    ledgerReadError,
    registryPath: provPaths.adoptedRegistryPath,
    ledgerPath: lcPaths.removalLedgerPath,
    scannedAt: new Date().toISOString()
  }
}

// =============================================================================
//   撤去 / 復元（W-2）
// =============================================================================

export type RemoveReason = 'manual' | 'collision-resolution'

export type RemoveSkillReason =
  | 'not-found'
  | 'state-changed'
  | 'duplicate-registry-name'
  | 'symlink-unsupported'
  | 'path-containment-violation'
  | 'move-failed'

export interface RemoveSkillResult {
  success: boolean
  reason?: RemoveSkillReason
  error?: string
  removalId?: string
}

/** 撤去（隔離）。全ロジックは export withApplyLock で直列化される。 */
export function removeSkill(
  name: string,
  stateToken: string,
  reason: RemoveReason = 'manual',
  settingsPaths: SettingsPaths = getDefaultSettingsPaths(),
  provPaths: ProvenancePaths = getDefaultProvenancePaths(),
  lcPaths: SkillLifecyclePaths = getDefaultSkillLifecyclePaths()
): Promise<RemoveSkillResult> {
  return withApplyLock(() => removeSkillCore(name, stateToken, reason, settingsPaths, provPaths, lcPaths))
}

/**
 * ロック非依存の core 実装。resolveCollision がロック内から直接呼ぶために分離してある
 * （export の removeSkill を呼ぶと二重にロックを取ろうとしてデッドロックする）。
 */
async function removeSkillCore(
  name: string,
  stateToken: string,
  reason: RemoveReason,
  settingsPaths: SettingsPaths,
  provPaths: ProvenancePaths,
  lcPaths: SkillLifecyclePaths
): Promise<RemoveSkillResult> {
  const inv = await computeSkillInventoryInner(settingsPaths, provPaths, lcPaths)
  if (inv.duplicateNames.includes(name)) {
    return {
      success: false,
      reason: 'duplicate-registry-name',
      error: `'${name}' has duplicate registry entries; resolve manually before removing`
    }
  }
  const entry = inv.entries.find((e) => e.name === name)
  if (!entry) {
    return {
      success: false,
      reason: 'not-found',
      error: `'${name}' is not a managed skill (golden-owned, catalyst-layout, or absent)`
    }
  }
  if (entry.stateToken !== stateToken) {
    return {
      success: false,
      reason: 'state-changed',
      error: `state for '${name}' changed since it was listed; re-list and retry`
    }
  }

  const skillsRoot = skillsRootOf(settingsPaths)
  const canonicalDir = join(skillsRoot, name)
  const nowIso = new Date().toISOString()
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  let movedTo: string | null = null

  if (entry.bucket !== 'missing') {
    let st
    try {
      st = await lstat(canonicalDir)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, reason: 'move-failed', error: `cannot stat '${canonicalDir}': ${msg}` }
    }
    if (st.isSymbolicLink()) {
      return {
        success: false,
        reason: 'symlink-unsupported',
        error: `'${name}' is a symlink/junction; not supported by this feature (Codex #15)`
      }
    }
    let realCanonical: string
    let realRoot: string
    try {
      realCanonical = await realpath(canonicalDir)
      realRoot = await realpath(skillsRoot)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, reason: 'move-failed', error: `realpath failed: ${msg}` }
    }
    if (!isPathUnder(realCanonical, realRoot)) {
      return {
        success: false,
        reason: 'path-containment-violation',
        error: `'${name}' does not resolve under the skills root; refused`
      }
    }
    movedTo = join(lcPaths.quarantineRoot, `${name}-${nowIso.replace(/[:.]/g, '-')}`)
  }

  const pendingRecord: RemovalRecord = {
    id,
    name,
    reason,
    status: 'pending',
    removedAt: nowIso,
    movedTo,
    priorRegistryEntry: entry.registryEntry
  }
  // Step 1: 撤去台帳へ pending 記録（ここで初めて「撤去が始まった」事実が確定する）
  await upsertRemovalRecord(pendingRecord, lcPaths.removalLedgerPath)

  // Step 2: 実体移動（ディレクトリ全体。同梱リソースも道連れ）
  if (movedTo) {
    try {
      await mkdir(dirname(movedTo), { recursive: true })
      try {
        await rename(canonicalDir, movedTo)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code
        if (code === 'EXDEV') {
          // クロスボリューム: copy+verify+rm へフォールバック。
          // SKILL.md 単体でなく同梱リソース全ファイルを検証する（addendum-01 [3]）:
          // ディレクトリ丸ごと移動する設計理由は同梱リソースを道連れにすることであり、
          // 検証がその範囲を覆っていなければ原本削除で静かな欠落が起きうる。
          const beforeFiles = await listFilesRecursive(canonicalDir)
          await cp(canonicalDir, movedTo, { recursive: true })
          const afterFiles = await listFilesRecursive(movedTo)
          if (
            beforeFiles.length !== afterFiles.length ||
            beforeFiles.some((f, i) => f !== afterFiles[i])
          ) {
            throw new Error(
              `EXDEV fallback copy verification failed (file list mismatch): before=${beforeFiles.length} [${beforeFiles.join(', ')}] after=${afterFiles.length} [${afterFiles.join(', ')}]`
            )
          }
          for (const rel of beforeFiles) {
            const beforeHash = await hashFileBytes(join(canonicalDir, rel))
            const afterHash = await hashFileBytes(join(movedTo, rel))
            if (beforeHash !== afterHash) {
              throw new Error(`EXDEV fallback copy verification failed (byte mismatch): ${rel}`)
            }
          }
          await rm(canonicalDir, { recursive: true, force: true })
        } else {
          throw err
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // 台帳は pending のまま残る → 次回 list() が「撤去未完了」として検出・可視化する
      return { success: false, reason: 'move-failed', error: `move failed: ${msg}` }
    }
  }

  // Step 3: レジストリから削除
  if (entry.registryEntry) {
    await removeAdoptedSkillEntry(name, provPaths)
  }

  // Step 4: 台帳を committed へ
  await upsertRemovalRecord({ ...pendingRecord, status: 'committed' }, lcPaths.removalLedgerPath)

  return { success: true, removalId: id }
}

export type RestoreRemovedReason =
  | 'not-found'
  | 'already-restored'
  | 'restore-target-exists'
  /** 同名が現在レジストリに登録済み。古い記録で上書きしない（addendum-02 Codex #2）。 */
  | 'registry-entry-exists'
  /** レジストリが読めず、書き戻しの安全性を確認できない（addendum-02 Codex #1）。 */
  | 'registry-unreadable'
  | 'move-failed'

export interface RestoreRemovedResult {
  success: boolean
  reason?: RestoreRemovedReason
  error?: string
}

/** 撤去の取り消し（W-2 の undo）。 */
export function restoreRemovedSkill(
  removalId: string,
  settingsPaths: SettingsPaths = getDefaultSettingsPaths(),
  provPaths: ProvenancePaths = getDefaultProvenancePaths(),
  lcPaths: SkillLifecyclePaths = getDefaultSkillLifecyclePaths()
): Promise<RestoreRemovedResult> {
  return withApplyLock(() => restoreRemovedSkillCore(removalId, settingsPaths, provPaths, lcPaths))
}

async function restoreRemovedSkillCore(
  removalId: string,
  settingsPaths: SettingsPaths,
  provPaths: ProvenancePaths,
  lcPaths: SkillLifecyclePaths
): Promise<RestoreRemovedResult> {
  let list: RemovalRecord[]
  try {
    list = await readRemovalLedgerStrict(lcPaths.removalLedgerPath)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, reason: 'not-found', error: `removal ledger unreadable: ${msg}` }
  }
  const record = list.find((r) => r.id === removalId)
  if (!record) {
    return { success: false, reason: 'not-found', error: `no removal record '${removalId}'` }
  }
  if (record.restoredAt) {
    return {
      success: false,
      reason: 'already-restored',
      error: `removal '${removalId}' was already restored at ${record.restoredAt}`
    }
  }
  if (record.status === 'pending') {
    return {
      success: false,
      reason: 'move-failed',
      error: `removal '${removalId}' is incomplete (status=pending); it did not finish moving — resolve manually before restoring`
    }
  }

  const skillsRoot = skillsRootOf(settingsPaths)
  const canonicalDir = join(skillsRoot, record.name)

  // 書き戻しを伴う復元は、同名の現行登録を上書きしない（addendum-02 Codex #2）。
  // 既存のファイル側ガード restore-target-exists と対称の、レジストリ側ガード。
  //
  // なぜ要るか: movedTo が null（実体欠落区分の撤去）の経路は下の existsSync チェックを
  // 丸ごと飛ばすため、upsertAdoptedSkill が name キーで現行登録を無条件に置換していた。
  // 撤去後に同名が再採用されていると、認証済みの新しい記録が古い hash / adoptedAt へ
  // 巻き戻る。hash は drift 判定（fail-closed の対象判定）の根拠なので、改変済みの skill が
  // 「整合」と誤判定されうる ＝ 採用ゲートが実質的に緩む。
  //
  // 従来この穴は「復元導線が 8 秒で消えるトーストだけ」だったため事実上到達不能だったが、
  // addendum-02 で復元を恒久的に到達可能にするため、ここで塞ぐ。
  // 通常経路（撤去 → 復元）では撤去時に登録が消えているので発火しない。
  // 不変条件（復元は priorRegistryEntry をそのまま書き戻す）は侵さない — 拒否するだけで
  // hash / adoptedAt を再計算しない。
  if (record.priorRegistryEntry) {
    // 書き戻しの安全判定に readAdoptedRegistry は使えない: あれは「不在」も「空/空白」も
    // どちらも [] に丸めるため、失われたレジストリが「登録なし」と読めてしまう
    // （不在: priorRegistryEntry が非 null ＝ かつて登録されていた ＝ レジストリは存在したはず。
    //   空/空白: 正当に空なら '[]' が書かれるので、0 バイトや空白は書込み中断の痕跡）。
    // ここでは readFile 1 回だけで直接読み、ENOENT・空・空白・非配列・不正要素・パース不能を
    // すべて「現行状態を証明できない」として拒否する。事前の existsSync を挟まないため、
    // 「存在を確認した直後に消える」二重確認の窓は生じない（第 2 巡 [1][2]）。
    // なお本判定から下の書き戻しまでの間は withApplyLock（settingsChange.ts）が
    // 採用・撤去・衝突解決・アーカイブ復元と共通で直列化するので、プロセス内での割込みは無い。
    // プロセス外（別インスタンス・手編集）の窓は残るが、これは採用経路にも等しく在る既存の性質。
    let currentRegistry: AdoptedSkillEntry[]
    try {
      const raw = await readFile(provPaths.adoptedRegistryPath, 'utf-8')
      if (raw.trim() === '') throw new Error('adopted registry is empty (truncated write?)')
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) throw new Error('adopted registry is not an array')
      // 要素の形も見る。[null] は Array.isArray を通ってしまい、下の some() が
      // try の外で TypeError になって IPC 層が嘘の理由を返す（第 3 巡 [2]）。
      if (!parsed.every((e) => typeof (e as { name?: unknown })?.name === 'string')) {
        throw new Error('adopted registry contains a malformed entry')
      }
      currentRegistry = parsed as AdoptedSkillEntry[]
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        success: false,
        reason: 'registry-unreadable',
        error: `cannot verify current adopted registry; refusing to write back '${record.name}': ${msg}`
      }
    }
    if (currentRegistry.some((e) => e.name === record.name)) {
      return {
        success: false,
        reason: 'registry-entry-exists',
        error: `'${record.name}' is currently registered in the adopted registry; refusing to overwrite it with the pre-removal record`
      }
    }
  }

  if (record.movedTo) {
    if (existsSync(canonicalDir)) {
      return {
        success: false,
        reason: 'restore-target-exists',
        error: `'${record.name}' already exists at the restore target; refusing to overwrite`
      }
    }
    try {
      await mkdir(dirname(canonicalDir), { recursive: true })
      await rename(record.movedTo, canonicalDir)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, reason: 'move-failed', error: `restore move failed: ${msg}` }
    }
  }

  // bypass 由来（priorRegistryEntry === null）はレジストリへ一切書き込まない（Codex #7）。
  if (record.priorRegistryEntry) {
    await upsertAdoptedSkill(record.priorRegistryEntry, provPaths)
  }

  await upsertRemovalRecord(
    { ...record, restoredAt: new Date().toISOString() },
    lcPaths.removalLedgerPath
  )

  return { success: true }
}

// =============================================================================
//   衝突解決（W-3）
// =============================================================================

export type ResolveCollisionReason =
  | 'pair-not-found'
  | 'state-changed'
  | 'marker-not-found'
  | 'marker-strip-failed'
  | 'rename-failed'
  | 'write-failed'

export interface ResolveCollisionResult {
  success: boolean
  reason?: ResolveCollisionReason
  error?: string
}

/**
 * 衝突ペアの解決（マーカー除去含む）。keep:'temp' は先行実体を撤去してから一時ディレクトリを
 * 正式名へ rename し、注入コメントを構造的逆演算で剥がしてレジストリを正式名へ再構成する。
 * keep:'original' は一時側を撤去するのみ（先行実体を新規にレジストリへ登録することは絶対にしない
 * — Codex #5/#6: これをやるとパスワードゲート付き採用フローを迂回する抜け道になる）。
 */
export function resolveCollision(
  originalName: string,
  tempName: string,
  keep: 'original' | 'temp',
  stateToken: string,
  settingsPaths: SettingsPaths = getDefaultSettingsPaths(),
  provPaths: ProvenancePaths = getDefaultProvenancePaths(),
  lcPaths: SkillLifecyclePaths = getDefaultSkillLifecyclePaths()
): Promise<ResolveCollisionResult> {
  return withApplyLock(() =>
    resolveCollisionCore(originalName, tempName, keep, stateToken, settingsPaths, provPaths, lcPaths)
  )
}

async function resolveCollisionCore(
  originalName: string,
  tempName: string,
  keep: 'original' | 'temp',
  stateToken: string,
  settingsPaths: SettingsPaths,
  provPaths: ProvenancePaths,
  lcPaths: SkillLifecyclePaths
): Promise<ResolveCollisionResult> {
  const inv = await computeSkillInventoryInner(settingsPaths, provPaths, lcPaths)
  const pair = inv.collisionPairs.find(
    (p) => p.originalName === originalName && p.tempName === tempName
  )
  if (!pair) {
    return {
      success: false,
      reason: 'pair-not-found',
      error: `no actionable collision pair for '${originalName}' / '${tempName}'`
    }
  }
  if (pair.stateToken !== stateToken) {
    return {
      success: false,
      reason: 'state-changed',
      error: `state for the '${originalName}'/'${tempName}' pair changed since it was listed; re-list and retry`
    }
  }

  if (keep === 'original') {
    const rm2 = await removeSkillCore(
      tempName,
      inv.entries.find((e) => e.name === tempName)?.stateToken ?? '',
      'collision-resolution',
      settingsPaths,
      provPaths,
      lcPaths
    )
    if (!rm2.success) {
      return { success: false, reason: 'write-failed', error: rm2.error }
    }
    return { success: true }
  }

  // keep === 'temp'
  // 1. 先行実体を撤去（undo 可能。同じ機構を使う）
  const rmOrig = await removeSkillCore(
    originalName,
    inv.entries.find((e) => e.name === originalName)?.stateToken ?? '',
    'collision-resolution',
    settingsPaths,
    provPaths,
    lcPaths
  )
  if (!rmOrig.success) {
    return { success: false, reason: 'write-failed', error: rmOrig.error }
  }

  // 2. マーカー除去（rename の前に、まだ tempName のパスにある間に行う）
  let rawBody: string
  try {
    rawBody = await readFile(pair.tempPath, 'utf-8')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, reason: 'write-failed', error: `cannot read temp SKILL.md: ${msg}` }
  }
  if (!rawBody.includes(COLLISION_MARKER_TEXT)) {
    return { success: false, reason: 'marker-not-found', error: 'injected collision marker not present' }
  }
  const stripped = stripCollisionWarning(rawBody)
  if (stripped === null) {
    return {
      success: false,
      reason: 'marker-strip-failed',
      error:
        'marker text is present but does not match the expected structural pattern (frontmatter/comment shape); refusing to guess'
    }
  }
  try {
    await writeFileAtomic(pair.tempPath, stripped)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, reason: 'write-failed', error: `failed to write stripped body: ${msg}` }
  }

  // 3. 一時ディレクトリを正式名へ rename
  const skillsRoot = skillsRootOf(settingsPaths)
  const tempDir = dirname(pair.tempPath)
  const canonicalDir = join(skillsRoot, originalName)
  if (existsSync(canonicalDir)) {
    return {
      success: false,
      reason: 'rename-failed',
      error: `'${originalName}' unexpectedly exists after removing the pre-existing entity; refusing to overwrite`
    }
  }
  try {
    await mkdir(dirname(canonicalDir), { recursive: true })
    await rename(tempDir, canonicalDir)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, reason: 'rename-failed', error: `rename failed: ${msg}` }
  }

  // 4. hash 再計算 + レジストリ再構成（name フィールド自体を正式名へ書き換える。Codex #1）
  const newHash = hashSkillBody(stripped)
  // target は文字列 replace（非マッチ時に無言で旧値を残す）でなく、name から正規パスへ
  // 再構成する（restoreSkillArchiveInner 等と同じ normalizeForCompare を使用。addendum-01 [6]）。
  const canonicalTarget = normalizeForCompare(join(skillsRoot, originalName, 'SKILL.md'))
  const nowIso = new Date().toISOString()
  const resolvedEntry: AdoptedSkillEntry = {
    ...pair.tempRegistryEntry,
    name: originalName,
    target: canonicalTarget,
    hash: newHash,
    // settingsChange.ts::restoreSkillArchiveInner と同じ作法で provenance を残す
    // （addendum-01 [1]）: hash を書き換える以上、旧値と更新時刻を失わない。
    previousHash: pair.tempRegistryEntry.hash,
    updatedAt: nowIso
  }
  await upsertAdoptedSkill(resolvedEntry, provPaths)
  await removeAdoptedSkillEntry(tempName, provPaths)

  return { success: true }
}
