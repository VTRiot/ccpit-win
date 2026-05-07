/**
 * Renderer 側で使う write tool 判定。main 側の `services/mcp/writeKeywords.ts` と
 * 同じキーワード集を持つが、import 境界（main/renderer）を跨がないようコピー。
 * 両者の同期は `mcpService.test.ts` の整合確認テストで担保（将来課題）。
 */

const WRITE_PREFIXES: readonly string[] = [
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

const WRITE_SUFFIXES: readonly string[] = [
  '_create',
  '_update',
  '_delete',
  '_write',
  '_push',
  '_merge'
] as const

const AUTH_INDICATORS: readonly string[] = [
  'TOKEN',
  'PAT',
  'API_KEY',
  'SECRET',
  'PASSWORD',
  'OAUTH',
  'CREDENTIAL'
] as const

export function isWriteToolName(toolName: string): boolean {
  const lower = toolName.toLowerCase()
  if (WRITE_PREFIXES.some((p) => lower.startsWith(p))) return true
  if (WRITE_SUFFIXES.some((s) => lower.endsWith(s))) return true
  return false
}

export function hasAuthEnvKey(env: Record<string, string> | undefined): boolean {
  if (!env) return false
  const keys = Object.keys(env).map((k) => k.toUpperCase())
  return keys.some((k) => AUTH_INDICATORS.some((ind) => k.includes(ind)))
}

export type RiskTier = 'safe' | 'caution' | 'strict'

export function classifyRiskView(server: {
  env?: Record<string, string>
  disabledTools?: string[]
}): RiskTier {
  const auth = hasAuthEnvKey(server.env)
  const hasWriteCandidates = (server.disabledTools ?? []).some(isWriteToolName)
  if (auth || hasWriteCandidates) return 'strict'
  const envEntries = Object.keys(server.env ?? {}).length
  if (envEntries > 0) return 'caution'
  return 'safe'
}

const ENV_VAR_PATTERN = /^\s*\$\{[A-Z_][A-Z0-9_]*\}\s*$/

export function looksLikePlainSecretView(envValue: string): boolean {
  if (envValue.length === 0) return false
  if (ENV_VAR_PATTERN.test(envValue)) return false
  if (/^(ghp|github_pat|ghs|gho|ghu|ghr)[_a-zA-Z0-9]/.test(envValue)) return true
  if (/^[A-Za-z0-9_-]{32,}$/.test(envValue)) return true
  return false
}
