/**
 * deny リストの静的検証（electron 非依存）。fs は読むが app 等の electron API には依存しない。
 *
 * 注（Marshal F1）: 本モジュールが扱う「対称性」「網羅」は保護パス・インベントリの整合で
 * あって enforcement ではない。cat 以外の read プリミティブ（head/xxd/python -c 等）や
 * 実行時パス構築は塞げない。実際の秘匿読取阻止は settings-guard hook（shell-aware ガード）
 * が担う。
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

export interface DenySymmetryResult {
  valid: boolean
  mismatches: string[]
}

export interface DenyCoverageResult {
  valid: boolean
  missing: string[]
}

export interface ExpectedDenyResult {
  ok: boolean
  expected: string[]
  error?: string
}

/** golden の OS template ディレクトリ名（settings.deny-extra.json を持つ）。 */
export const KNOWN_TEMPLATES = ['manx', 'macau', 'asama'] as const

/**
 * cat-only が正当な保護パス（Read は許可・Edit/Write/cat を禁止する設定ファイル等）。
 * 双方向対称の例外として扱う。
 */
const CAT_ONLY_ALLOWED = new Set<string>([
  '~/.claude/settings.json',
  '~/.claude/settings.local.json'
])

/**
 * deny リストの Read↔Bash(cat) 双方向対称性を検証する（Marshal F2）。
 * Read(<path>) と Bash(cat <path>) は独立ツール（MANX §5-5 注意3）であり、
 * 保護パスは両経路で deny されていなければならない。CAT_ONLY_ALLOWED は例外。
 */
export function validateDenySymmetry(deny: string[]): DenySymmetryResult {
  const reads = new Set<string>()
  const cats = new Set<string>()
  for (const rule of deny) {
    const mRead = /^Read\((.+)\)$/.exec(rule)
    if (mRead) {
      reads.add(mRead[1])
      continue
    }
    const mCat = /^Bash\(cat (.+)\)$/.exec(rule)
    if (mCat) cats.add(mCat[1])
  }
  const mismatches: string[] = []
  for (const p of reads) {
    if (!cats.has(p)) mismatches.push(`Read(${p}) に対応する Bash(cat ${p}) が欠落`)
  }
  for (const p of cats) {
    if (!reads.has(p) && !CAT_ONLY_ALLOWED.has(p)) {
      mismatches.push(`Bash(cat ${p}) に対応する Read(${p}) が欠落`)
    }
  }
  return { valid: mismatches.length === 0, mismatches }
}

/**
 * 期待 deny（golden の common + active OS の和集合）が、実際の deny リストに
 * 網羅されているか検証する（Marshal F1）。
 * deploy / migration / 手動破壊で PIKES 確定 deny が欠落した状態を検出する。
 */
export function validateDenyCoverage(installed: string[], expected: string[]): DenyCoverageResult {
  const installedSet = new Set(installed)
  const missing = expected.filter((rule) => !installedSet.has(rule))
  return { valid: missing.length === 0, missing }
}

/**
 * golden の期待 deny（common deny-base + 指定 template の deny-extra）を解決する（Marshal F1/F4）。
 * template が未知 / golden ファイル欠落 / parse 不能 のいずれも fail-closed（ok=false）で返す。
 * これにより health は「検証不能」を緑にせず error にできる。
 */
export function resolveExpectedDeny(goldenDir: string, template: string): ExpectedDenyResult {
  if (!(KNOWN_TEMPLATES as readonly string[]).includes(template)) {
    return { ok: false, expected: [], error: `未知の template '${template}'（許可: ${KNOWN_TEMPLATES.join('/')}）` }
  }
  try {
    const basePath = join(goldenDir, 'common', 'settings.deny-base.json')
    if (!existsSync(basePath)) {
      return { ok: false, expected: [], error: 'common/settings.deny-base.json 欠落' }
    }
    const base = JSON.parse(readFileSync(basePath, 'utf-8')) as string[]
    const extraPath = join(goldenDir, template, 'settings.deny-extra.json')
    if (!existsSync(extraPath)) {
      return { ok: false, expected: [], error: `${template}/settings.deny-extra.json 欠落` }
    }
    const extra = JSON.parse(readFileSync(extraPath, 'utf-8')) as string[]
    return { ok: true, expected: [...base, ...extra] }
  } catch (e) {
    return { ok: false, expected: [], error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * platform (process.platform) → golden template マッピング（純関数、main 側）。
 *
 * ※ renderer 側 `src/renderer/src/lib/platformTemplate.ts` と**同一ロジック**。electron の
 *   main/renderer はビルド・tsconfig が分離され共有 import できないため、意図的に二重定義する。
 *   3 OS マッピングを変更する場合は両方を同期すること（両方に回帰テストあり）。
 *
 * win32→manx / darwin→macau / linux→asama / その他→manx。
 */
export function platformToTemplate(platform: string): string {
  if (platform === 'darwin') return 'macau'
  if (platform === 'linux') return 'asama'
  return 'manx'
}
