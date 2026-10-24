import { readdir } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'

/**
 * 配布スクリプト（golden/common/scripts/*.cjs → ~/.claude/scripts/）の存在検査。
 *
 * hooks/ が settings.json から自動発火するのに対し、scripts/ は skill 本文が
 * `node ~/.claude/scripts/<name>.cjs` で明示起動する道具（例: レビュー台帳への唯一の正規書込経路）。
 * 欠落すると、Stop hook が要求する記録手段を配布ユーザーが持てず、ゲートを解除できないまま止まる
 * （fail-closed の詰み）。health で「無い」を診断可能にするのが本検査の目的。
 *
 * hooks/ の検査と同型に**存在**だけを見る。内容の一致（旧版・改変）は起動時照合
 * （manifest 三方向照合）の担当であり、ここで二重化しない。
 * golden 側に scripts/ が無い（旧版 golden）なら検査対象なし＝null（項目を出さない）。
 */
export interface DistributedScriptsItem {
  name: 'scripts/'
  status: 'ok' | 'error'
  detail: string
}

export async function distributedScriptsStatus(
  claudeDir: string,
  goldenScriptsDir: string
): Promise<DistributedScriptsItem | null> {
  if (!existsSync(goldenScriptsDir)) return null
  const goldenScripts = (await readdir(goldenScriptsDir)).filter((n) => n.endsWith('.cjs')).sort()
  if (goldenScripts.length === 0) return null

  const scriptsDir = join(claudeDir, 'scripts')
  if (!existsSync(scriptsDir)) {
    return { name: 'scripts/', status: 'error', detail: 'Directory not found' }
  }
  const missing = goldenScripts.filter((name) => !existsSync(join(scriptsDir, name)))
  if (missing.length > 0) {
    return { name: 'scripts/', status: 'error', detail: `Missing: ${missing.join(', ')}` }
  }
  return { name: 'scripts/', status: 'ok', detail: `${goldenScripts.length} scripts` }
}
