/**
 * composeInventory — 合成 CC が「書いてはならない場所」へ書いていないかを、起動前後の目録で測る（Plan r10 §4-2 項 4）。
 *
 * 一次の防御は起動時の権限（作業場の権限規則・許可モード固定）。これは**監視範囲内の違反を確実に捕える二次の防御**で、
 * 監視範囲の外の任意の場所への書込みは列挙できない（限界は Plan §9 前提 3 で承認済み）。
 *
 * - 目録は再帰的に `lstat` で全エントリを列挙する。種別（通常ファイル・ディレクトリ・リンク）・通常ファイルの指紋・リンク先を持つ
 * - 差分は 5 種: 変更（modified）・新規作成（created）・削除（deleted）・種別の変更（type-changed）・リンク先の変更（link-changed）
 * - 原状回復はすべて CAS（Compare-And-Swap）:
 *   - 変更: 現在値が「観測した変更値」と一致するときだけ、起動前の写しで戻す
 *   - 新規作成（通常ファイル）: 現在値が観測値と一致し、監視範囲の内側にあるときだけ削除する
 *   - 削除: そのパスが今も存在しないときだけ、起動前の写しから再作成する
 *   - ディレクトリの新設・削除、リンクの作成・変更、種別の変更は**自動で戻さず**止める（誤削除の影響が読めない）
 *   - 一致しなければ何も触らず止める（CC の終了後に別の人・プロセスが正当に編集した可能性があるため）
 * - 監視範囲ごとに `mode`:
 *   - `restore`: 違反＝登録拒否、CAS で戻す（golden・手元の skills/hooks/rules 等。誰も正当には書かない場所）
 *   - `detect`: 違反＝登録拒否、戻さない（CCPIT・他の CC が正当に書き得る状態ファイル。戻すと正当な更新を消すため）
 *   - `ignore-created`: 新規作成は情報として記録するだけで違反にしない（他レーンが提案を新規作成する `proposals/`）。
 *     既存ファイルの変更・削除は `detect` と同じ
 */

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { sha256Hex } from './composeHash'

export type GuardMode = 'restore' | 'detect' | 'ignore-created' | 'info'

export interface InventoryRoot {
  /** 監視する絶対パス（ディレクトリまたはファイル。存在しなくてもよい） */
  path: string
  mode: GuardMode
  /** ディレクトリを再帰するか。false なら直下の通常ファイルだけ */
  recursive: boolean
  /** 直下の名前でこの条件に合うものだけ（recursive=false のとき）。省略は全部 */
  nameFilter?: (name: string) => boolean
  /** 除外する絶対パス（接頭辞一致。作業場自身など） */
  exclude?: string[]
}

export type InvEntry =
  | { kind: 'file'; fp: string; size: number }
  | { kind: 'dir' }
  | { kind: 'link'; target: string }

export interface InventoryItem {
  entry: InvEntry
  mode: GuardMode
  rootPath: string
}

export type Inventory = Map<string, InventoryItem>

/** これより大きいファイルは中身でなく大きさと更新時刻を指紋にする（目録の取得を重くしないため） */
export const BIG_FILE_BYTES = 8 * 1024 * 1024
/** 起動前の写しを取る上限（これを超える・写しを取らないファイルは「復元元なし」＝検出のみ） */
export const BACKUP_MAX_BYTES = 2 * 1024 * 1024

const norm = (p: string): string => resolve(p).replace(/\\/g, '/')

function fingerprint(abs: string, size: number, mtimeMs: number): string {
  if (size > BIG_FILE_BYTES) return `sig:${size}:${Math.trunc(mtimeMs)}`
  try {
    return sha256Hex(readFileSync(abs))
  } catch {
    return `unreadable:${size}`
  }
}

function isExcluded(abs: string, exclude: string[] | undefined): boolean {
  if (!exclude) return false
  const a = norm(abs).toLowerCase()
  return exclude.some((e) => {
    const x = norm(e).toLowerCase()
    return a === x || a.startsWith(`${x}/`)
  })
}

function addEntry(inv: Inventory, abs: string, root: InventoryRoot): boolean {
  let st
  try {
    st = lstatSync(abs)
  } catch {
    return false
  }
  const key = norm(abs)
  if (st.isSymbolicLink()) {
    let target = ''
    try {
      target = readlinkSync(abs)
    } catch {
      /* ignore */
    }
    inv.set(key, { entry: { kind: 'link', target }, mode: root.mode, rootPath: norm(root.path) })
    return false
  }
  if (st.isDirectory()) {
    inv.set(key, { entry: { kind: 'dir' }, mode: root.mode, rootPath: norm(root.path) })
    return true
  }
  if (st.isFile()) {
    inv.set(key, {
      entry: { kind: 'file', fp: fingerprint(abs, st.size, st.mtimeMs), size: st.size },
      mode: root.mode,
      rootPath: norm(root.path)
    })
  }
  return false
}

function walk(inv: Inventory, dir: string, root: InventoryRoot): void {
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    const abs = join(dir, name)
    if (isExcluded(abs, root.exclude)) continue
    const isDir = addEntry(inv, abs, root)
    if (isDir && root.recursive) walk(inv, abs, root)
  }
}

/** 監視範囲の目録を取る（`lstat` なのでリンクは辿らない） */
export function takeInventory(roots: InventoryRoot[]): Inventory {
  const inv: Inventory = new Map()
  for (const root of roots) {
    if (isExcluded(root.path, root.exclude)) continue
    let st
    try {
      st = lstatSync(root.path)
    } catch {
      continue // 存在しない範囲は空（作られたら created になる）
    }
    if (st.isDirectory()) {
      if (root.recursive) {
        addEntry(inv, root.path, root)
        walk(inv, root.path, root)
      } else {
        let names: string[] = []
        try {
          names = readdirSync(root.path)
        } catch {
          names = []
        }
        for (const name of names) {
          if (root.nameFilter && !root.nameFilter(name)) continue
          const abs = join(root.path, name)
          if (isExcluded(abs, root.exclude)) continue
          addEntry(inv, abs, root)
        }
      }
    } else {
      addEntry(inv, root.path, root)
    }
  }
  return inv
}

export type ChangeKind = 'modified' | 'created' | 'deleted' | 'type-changed' | 'link-changed'

export interface InventoryChange {
  path: string
  change: ChangeKind
  mode: GuardMode
  before?: InvEntry
  after?: InvEntry
}

function sameEntry(a: InvEntry, b: InvEntry): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'file' && b.kind === 'file') return a.fp === b.fp
  if (a.kind === 'link' && b.kind === 'link') return a.target === b.target
  return true
}

/** 起動前後の目録の差分（種別つき） */
export function diffInventory(before: Inventory, after: Inventory): InventoryChange[] {
  const out: InventoryChange[] = []
  for (const [path, b] of before) {
    const a = after.get(path)
    if (!a) {
      out.push({ path, change: 'deleted', mode: b.mode, before: b.entry })
      continue
    }
    if (sameEntry(b.entry, a.entry)) continue
    if (b.entry.kind !== a.entry.kind) {
      out.push({ path, change: 'type-changed', mode: b.mode, before: b.entry, after: a.entry })
    } else if (b.entry.kind === 'link') {
      out.push({ path, change: 'link-changed', mode: b.mode, before: b.entry, after: a.entry })
    } else {
      out.push({ path, change: 'modified', mode: b.mode, before: b.entry, after: a.entry })
    }
  }
  for (const [path, a] of after) {
    if (!before.has(path)) out.push({ path, change: 'created', mode: a.mode, after: a.entry })
  }
  return out.sort((x, y) => x.path.localeCompare(y.path))
}

/** 違反になる差分か（`ignore-created` の範囲の新規作成は情報だけ） */
export function isViolation(c: InventoryChange): boolean {
  if (c.mode === 'info') return false // 他のレーン・CCPIT 自身が正当に書き得る場所（記録のみ）
  return !(c.mode === 'ignore-created' && c.change === 'created')
}

// ---- 起動前の写し（復元元） ----

export interface Baseline {
  dir: string
  /** 監視範囲の絶対パス → 写しのファイル名 */
  files: Map<string, string>
}

/** `restore` の範囲の通常ファイルで、上限以下のものを写す。それ以外は復元元なし（検出のみ） */
export function makeBaseline(inv: Inventory, dir: string): Baseline {
  mkdirSync(dir, { recursive: true })
  const files = new Map<string, string>()
  let n = 0
  for (const [path, it] of inv) {
    if (it.mode !== 'restore') continue
    if (it.entry.kind !== 'file' || it.entry.size > BACKUP_MAX_BYTES) continue
    const name = `b${String(++n).padStart(6, '0')}`
    try {
      copyFileSync(path, join(dir, name))
      files.set(path, name)
    } catch {
      /* 写せなければ復元元なし */
    }
  }
  return { dir, files }
}

export interface RestoreReport {
  restored: string[]
  /** CAS が合わない・復元元が無い等で触らなかったもの */
  skipped: Array<{ path: string; reason: string }>
  /** ディレクトリ・リンク・種別の変更など、自動で戻さないもの */
  manual: Array<{ path: string; change: ChangeKind }>
}

function currentFingerprint(abs: string): string | null {
  try {
    const st = lstatSync(abs)
    if (!st.isFile()) return null
    return fingerprint(abs, st.size, st.mtimeMs)
  } catch {
    return null
  }
}

/** 違反の差分を CAS で戻す。`restore` の範囲だけが対象で、それ以外は触らない */
export function restoreViolations(changes: InventoryChange[], baseline: Baseline): RestoreReport {
  const rep: RestoreReport = { restored: [], skipped: [], manual: [] }
  for (const c of changes) {
    if (!isViolation(c)) continue
    if (c.mode !== 'restore') {
      rep.skipped.push({ path: c.path, reason: '戻さない範囲（検出のみ）' })
      continue
    }
    if (
      c.change === 'type-changed' ||
      c.change === 'link-changed' ||
      c.before?.kind === 'dir' ||
      c.after?.kind === 'dir' ||
      c.before?.kind === 'link' ||
      c.after?.kind === 'link'
    ) {
      rep.manual.push({ path: c.path, change: c.change })
      continue
    }
    const cur = currentFingerprint(c.path)
    if (c.change === 'modified') {
      const src = baseline.files.get(c.path)
      if (!src) {
        rep.skipped.push({ path: c.path, reason: '起動前の写しが無い' })
      } else if (c.after?.kind !== 'file' || cur !== c.after.fp) {
        rep.skipped.push({
          path: c.path,
          reason: '現在値が観測した変更値と違う（その後に別の編集が入った）'
        })
      } else {
        copyFileSync(join(baseline.dir, src), c.path)
        rep.restored.push(c.path)
      }
    } else if (c.change === 'created') {
      if (c.after?.kind !== 'file' || cur !== c.after.fp) {
        rep.skipped.push({ path: c.path, reason: '現在値が観測した作成値と違う（削除しない）' })
      } else {
        rmSync(c.path, { force: true })
        rep.restored.push(c.path)
      }
    } else if (c.change === 'deleted') {
      const src = baseline.files.get(c.path)
      if (!src) {
        rep.skipped.push({ path: c.path, reason: '起動前の写しが無い' })
      } else if (existsSync(c.path)) {
        rep.skipped.push({ path: c.path, reason: 'パスが今は存在する（再作成しない）' })
      } else {
        mkdirSync(dirname(c.path), { recursive: true })
        copyFileSync(join(baseline.dir, src), c.path)
        rep.restored.push(c.path)
      }
    }
  }
  return rep
}

// ---- 監視範囲の定義（Plan r10 §4-2 項 4） ----

export interface GuardRootsInput {
  /** golden を持つリポジトリのルート（`.git` のあるディレクトリ） */
  repoDir: string
  /** 手元の `~/.claude` */
  claudeDir: string
  /** `~/.ccpit` */
  ccpitDir: string
  /** この合成の作業場（監視から除く） */
  workspaceDir: string
}

/** 合成 CC が書いてはならない場所の監視範囲 */
export function buildGuardRoots(g: GuardRootsInput): InventoryRoot[] {
  const roots: InventoryRoot[] = []
  const exclude = [g.workspaceDir]
  // golden のリポジトリ: 配布正本（golden）と契約ツール。`.git` は他のレーンが正当に書くので対象にしない
  // 他のレーンが開発で正当に書き得る（合成 CC が長く動くほど窓が広がる）ので、検出のみ・自動では戻さない
  roots.push({
    path: join(g.repoDir, 'ccpit', 'golden'),
    mode: 'detect',
    recursive: true,
    exclude
  })
  roots.push({
    path: join(g.repoDir, '_Tools', 'golden-apply'),
    mode: 'restore',
    recursive: true,
    exclude
  })
  // 手元の ~/.claude: 利用者の設定・skills・hooks・rules など。他のセッションや CCPIT の採用が正当に書き得るので、
  // 検出のみ・自動では戻さない（戻すと他者の正当な編集を巻き戻す）
  for (const d of ['skills', 'hooks', 'rules', 'scripts', 'commands', 'agents']) {
    roots.push({ path: join(g.claudeDir, d), mode: 'detect', recursive: true, exclude })
  }
  for (const f of ['settings.json', 'settings.local.json', 'CLAUDE.md']) {
    roots.push({ path: join(g.claudeDir, f), mode: 'detect', recursive: false })
  }
  // ~/.ccpit: overlay・登録簿は CCPIT だけが書く
  roots.push({
    path: join(g.ccpitDir, 'golden-overlay'),
    mode: 'restore',
    recursive: true,
    exclude
  })
  roots.push({
    path: join(g.ccpitDir, 'compose-registry'),
    mode: 'restore',
    recursive: true,
    exclude
  })
  // 状態ファイル（CCPIT・他の CC が正当に書き得る）: 記録のみ。違反にも数えず、戻さない
  roots.push({
    path: g.ccpitDir,
    mode: 'info',
    recursive: false,
    nameFilter: (n) => /^(proposal-.*|golden-.*|adopt-.*|emergency-.*)\.json$/i.test(n)
  })
  // 提案プール: 他のレーンが新規作成するので、新規作成は情報だけ。既存の変更・削除は検出
  roots.push({ path: join(g.ccpitDir, 'proposals'), mode: 'ignore-created', recursive: false })
  return roots
}
