/**
 * MCP tool 名から「write 系」を判定するためのキーワード集（マジックナンバー禁止規範に従い定数化）。
 * MANX Protocol r10 §5-13「MCP 別安全プロファイル」の暫定実装。
 *
 * 将来的には MANX r10 §5-13 のリスク階層基準を JSON Schema 化して厳密化予定（Phase A スコープ外）。
 */

export const WRITE_PREFIXES: readonly string[] = [
  'create_',
  'update_',
  'delete_',
  'write_',
  'push_',
  'merge_',
  'remove_',
  'add_',
  'set_',
  'patch_',
  'put_',
  'rename_',
  'move_',
  'copy_',
  'execute_',
  'run_',
  'apply_'
] as const

export const WRITE_SUFFIXES: readonly string[] = [
  '_create',
  '_update',
  '_delete',
  '_write',
  '_push',
  '_merge'
] as const

/**
 * env 変数名に含まれていれば認証情報持ちと推定するキーワード集。
 * 大文字小文字を無視するためマッチ時は両側を upper case 化して比較する。
 */
export const AUTH_INDICATORS: readonly string[] = [
  'TOKEN',
  'PAT',
  'API_KEY',
  'SECRET',
  'PASSWORD',
  'OAUTH',
  'CREDENTIAL'
] as const

/** tool 名が write 系かを判定。prefix / suffix どちらかに該当すれば write。 */
export function isWriteTool(toolName: string): boolean {
  const lower = toolName.toLowerCase()
  if (WRITE_PREFIXES.some((p) => lower.startsWith(p))) return true
  if (WRITE_SUFFIXES.some((s) => lower.endsWith(s))) return true
  return false
}

/** env オブジェクトに認証系の key が含まれていれば true。 */
export function hasAuthEnv(env: Record<string, string> | undefined): boolean {
  if (!env) return false
  const keys = Object.keys(env).map((k) => k.toUpperCase())
  return keys.some((k) => AUTH_INDICATORS.some((ind) => k.includes(ind)))
}
