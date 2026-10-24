/**
 * composePreApply — 昇格の適用前の保存（pre-apply）と適用直後の記録（post）、戻しの復元前確認（葉モジュール）。
 *
 * Plan r10 §8（原子単位と戻す順序）:
 * - 適用の直前に、昇格が動かす対象（golden の対象 skill 一式・手元の写し・各種の記録）の写しと sha256 一覧を
 *   `~/.ccpit/compose/<request_id>/pre-apply/` へ保存する。保存に失敗したら、適用を始めない
 * - 適用が済んだ直後に、同じ対象の sha256 を `post.json` へ記録する
 * - 戻すときは、**現在の sha256 が `post.json` の値と一致する対象だけ**を戻す。1 つでも違えば何も上書きしない（CAS）
 * - golden の対象は、このモジュールでは書かない（契約の手順の逆パッチで流す。goldenPromotion.rollbackPromotion）
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'

export type PreApplyKind = 'golden' | 'local' | 'record'

export const ABSENT = 'ABSENT'
/** 通常ファイルでない（ディレクトリなど）。写しを取らず、戻しでも触らない */
export const NONFILE = 'NONFILE'

export interface PreApplyEntry {
  kind: PreApplyKind
  /** 絶対パス */
  path: string
  /** golden のときは、リポジトリルートからの相対パス（`/` 区切り） */
  rel?: string
  /** 保存時の生バイトの sha256。無ければ ABSENT */
  sha256: string
  /** pre-apply ディレクトリ内の写しのファイル名。ABSENT のときは無い */
  copy?: string
}

export interface PreApplyDoc {
  version: 1
  requestId: string
  skillName: string
  createdAt: string
  baseCommit: string
  entries: PreApplyEntry[]
}

export interface PostApplyDoc {
  version: 1
  recordedAt: string
  commit?: string
  entries: Array<{ path: string; sha256: string }>
}

export interface PreApplyTarget {
  kind: PreApplyKind
  path: string
  rel?: string
}

export function sha256Raw(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/** ファイルの生バイトの sha256。無ければ ABSENT */
export function sha256OfFile(path: string): string {
  try {
    return existsSync(path) ? sha256Raw(readFileSync(path)) : ABSENT
  } catch {
    return ABSENT
  }
}

export function safeRequestDirName(requestId: string): string {
  return requestId.replace(/[^A-Za-z0-9._-]/g, '_')
}

export function preApplyDirOf(ccpitDir: string, requestId: string): string {
  return join(ccpitDir, 'compose', safeRequestDirName(requestId), 'pre-apply')
}

/** ディレクトリ配下の通常ファイルを再帰で列挙する（リンクは辿らない）。無ければ空 */
export function listFilesRecursive(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    let names: import('node:fs').Dirent[]
    try {
      names = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const n of names) {
      const p = join(d, n.name)
      if (n.isDirectory()) walk(p)
      else if (n.isFile()) out.push(p)
    }
  }
  if (existsSync(dir)) walk(dir)
  return out.sort()
}

/** 同じ絶対パスの重複を除く（先に来た方を残す） */
export function dedupeTargets(targets: PreApplyTarget[]): PreApplyTarget[] {
  const seen = new Set<string>()
  const out: PreApplyTarget[] = []
  for (const t of targets) {
    const key = process.platform === 'win32' ? t.path.toLowerCase() : t.path
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
  }
  return out
}

/**
 * 適用前の保存。写しと `pre-apply.json` を書く。途中で失敗したら、書きかけを消して例外を投げる（呼び出し側は適用を始めない）。
 */
export function savePreApply(
  dir: string,
  meta: { requestId: string; skillName: string; baseCommit: string; now?: () => string },
  targets: PreApplyTarget[]
): PreApplyDoc {
  try {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(join(dir, 'files'), { recursive: true })
    const entries: PreApplyEntry[] = []
    let n = 0
    for (const t of dedupeTargets(targets)) {
      if (!existsSync(t.path)) {
        entries.push({ kind: t.kind, path: t.path, rel: t.rel, sha256: ABSENT })
        continue
      }
      if (!statSync(t.path).isFile()) {
        // 通常ファイルでないもの（ディレクトリなど）は写しを取れず、戻しでも触らない（NONFILE）。保存の失敗にはしない
        entries.push({ kind: t.kind, path: t.path, rel: t.rel, sha256: NONFILE })
        continue
      }
      const buf = readFileSync(t.path)
      const copy = `files/${String(++n).padStart(4, '0')}`
      writeFileSync(join(dir, copy), buf)
      entries.push({ kind: t.kind, path: t.path, rel: t.rel, sha256: sha256Raw(buf), copy })
    }
    const doc: PreApplyDoc = {
      version: 1,
      requestId: meta.requestId,
      skillName: meta.skillName,
      createdAt: (meta.now ?? ((): string => new Date().toISOString()))(),
      baseCommit: meta.baseCommit,
      entries
    }
    writeJsonAtomic(join(dir, 'pre-apply.json'), doc)
    // 写しの書込みを読み戻して確かめる（保存に失敗したまま適用を始めない）
    for (const e of entries) {
      if (e.copy && sha256OfFile(join(dir, e.copy)) !== e.sha256) {
        throw new Error(`写しの照合に失敗しました: ${e.path}`)
      }
    }
    return doc
  } catch (err) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    throw err
  }
}

export function readPreApply(dir: string): PreApplyDoc | null {
  try {
    const p = join(dir, 'pre-apply.json')
    if (!existsSync(p)) return null
    const d = JSON.parse(readFileSync(p, 'utf-8')) as PreApplyDoc
    return d && d.version === 1 && Array.isArray(d.entries) ? d : null
  } catch {
    return null
  }
}

export function readPostApply(dir: string): PostApplyDoc | null {
  try {
    const p = join(dir, 'post.json')
    if (!existsSync(p)) return null
    const d = JSON.parse(readFileSync(p, 'utf-8')) as PostApplyDoc
    return d && d.version === 1 && Array.isArray(d.entries) ? d : null
  } catch {
    return null
  }
}

/** 適用が済んだ直後に、pre-apply と同じ対象の sha256 を post.json へ記録する */
export function recordPostApply(dir: string, commit: string | undefined, now?: () => string): PostApplyDoc {
  const pre = readPreApply(dir)
  if (!pre) throw new Error(`pre-apply.json が読めません: ${dir}`)
  const doc: PostApplyDoc = {
    version: 1,
    recordedAt: (now ?? ((): string => new Date().toISOString()))(),
    commit,
    entries: pre.entries.map((e) => ({
      path: e.path,
      sha256: e.sha256 === NONFILE ? NONFILE : sha256OfFile(e.path)
    }))
  }
  writeJsonAtomic(join(dir, 'post.json'), doc)
  return doc
}

export interface PostMismatch {
  path: string
  expected: string
  actual: string
}

/** 戻す前の確認: 全対象の現在値が post.json の値と一致するか。1 つでも違えば戻さない（NONFILE は対象外） */
export function checkMatchesPost(post: PostApplyDoc): { ok: boolean; mismatches: PostMismatch[] } {
  const mismatches: PostMismatch[] = []
  for (const e of post.entries) {
    if (e.sha256 === NONFILE) continue
    const actual = sha256OfFile(e.path)
    if (actual !== e.sha256) mismatches.push({ path: e.path, expected: e.sha256, actual })
  }
  return { ok: mismatches.length === 0, mismatches }
}

/** 1 つの対象を、保存した写しの状態へ戻す（保存時に無かったものは削除）。呼び出し側が復元前確認を済ませていること */
export function restoreEntry(dir: string, e: PreApplyEntry): void {
  if (e.sha256 === ABSENT) {
    if (existsSync(e.path)) unlinkSync(e.path)
    return
  }
  if (!e.copy) throw new Error(`写しが記録されていません: ${e.path}`)
  const buf = readFileSync(join(dir, e.copy))
  if (sha256Raw(buf) !== e.sha256) throw new Error(`保存した写しが壊れています: ${e.path}`)
  mkdirSync(dirname(e.path), { recursive: true })
  const tmp = `${e.path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  writeFileSync(tmp, buf)
  renameSync(tmp, e.path)
}

/** 保存した写しの本文（golden の逆パッチの作成に使う）。ABSENT なら null */
export function readCopy(dir: string, e: PreApplyEntry): Buffer | null {
  if (e.sha256 === ABSENT || !e.copy) return null
  return readFileSync(join(dir, e.copy))
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8')
  renameSync(tmp, path)
}
