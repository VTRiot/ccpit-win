/**
 * proposalTargetUtils — 提案 target の安全な相対パス解決純関数。
 *
 * CCPIT_066: skillProposals と goldenMergeConsult の双方が共有する
 * 循環依存ゼロ・副作用ゼロ・Electron 非依存の軽量ユーティリティ。
 */

import { isAbsolute } from 'node:path'
import { normalizeRelPath } from './goldenManifest'

/**
 * 提案 frontmatter の `target` を配置先ルート相対へ写す。
 *
 * 受け付ける形: `~/.claude/<rel>` / `<targetDir>/<rel>`（絶対・区切り不問・大小文字非区別）/
 * `skills/<name>/SKILL.md` のような素の相対。それ以外（別ホーム・`..` 遡り・空・区切りを含まない
 * 語 = `なし` のような非パス）は null。配布物は必ず `<kind>/<name>/…` の階層下にあるため、
 * 区切りの無い値がパスであることはない。
 *
 * targetDir は絶対パスのみを受理し、相対パス・空値・未指定は安全側（fail-safe）に null を返す。
 */
export function proposalTargetToRel(target: string, targetDir: string): string | null {
  if (!target || !targetDir || !isAbsolute(targetDir)) return null

  const t = String(target)
    .trim()
    .replace(/\\/g, '/')
  if (t === '') return null

  const home = targetDir.replace(/\\/g, '/').replace(/\/+$/, '')
  let rel: string | null = null
  if (t.startsWith('~/.claude/')) rel = t.slice('~/.claude/'.length)
  else if (t.toLowerCase().startsWith(`${home.toLowerCase()}/`)) rel = t.slice(home.length + 1)
  else if (!/^([a-z]:\/|\/|~)/i.test(t)) rel = t
  if (rel === null) return null

  const norm = normalizeRelPath(rel)
  if (norm === '' || norm === '..' || norm.startsWith('../') || norm.includes('/../')) return null
  // 配布物は `<kind>/<name>/…` の階層下にしか無い。区切りの無い語（`なし` など）はパスではない。
  if (!norm.includes('/')) return null
  return norm
}
