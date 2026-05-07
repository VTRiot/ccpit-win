/**
 * mcpService — Model Context Protocol (MCP) server 管理サービス。
 *
 * 設計原則 (Phase A, MANX Protocol r10 §3-6 / §5-13 準拠):
 * - 読込: 直接 JSON 読込（高速、`~/.claude.json` の `mcpServers` セクション + `{project}/.mcp.json`）
 * - 書込（追加/削除）: `claude mcp add/remove` CLI を裏で実行（サイレントフェイル回避）
 * - `disabledTools` 編集: CLI 非対応のため `~/.claude.json` を直接書き戻す
 * - リスク階層は env と tools 名から自動判定。`Strict / Caution / Safe` の 3 段階。
 * - パスは引数で上書き可能（テスト容易性のため、`os.homedir()` 由来の既定値）。
 *
 * 注意 (P0 deny):
 * - `~/.claude/settings.json` には絶対に触らない。CCPIT が編集してよいのは `~/.claude.json`
 *   と `{project}/.mcp.json` のみ。
 */

import { readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { spawn } from 'child_process'
import { resolveClaudeBin } from './cliResolver'
import { hasAuthEnv, isWriteTool } from './mcp/writeKeywords'

export type McpScope = 'global' | 'project'
export type RiskTier = 'safe' | 'caution' | 'strict'
export type McpTransport = 'stdio' | 'sse' | 'http'

export interface McpServer {
  name: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  type?: McpTransport
  url?: string
  headers?: Record<string, string>
  /** ~/.claude.json 内の任意配列。ここに列挙された tool は MCP プロトコル層で物理遮断される。 */
  disabledTools?: string[]
}

export interface McpPaths {
  /** `~/.claude.json` の絶対パス */
  claudeJsonPath: string
}

export interface ClaudeJson {
  mcpServers?: Record<string, Omit<McpServer, 'name'>>
  [key: string]: unknown
}

export interface ProjectMcpJson {
  mcpServers?: Record<string, Omit<McpServer, 'name'>>
  [key: string]: unknown
}

export interface CliResult {
  ok: boolean
  stdout: string
  stderr: string
  exitCode: number | null
}

export interface AddResult {
  ok: boolean
  error?: string
  cliStdout?: string
  cliStderr?: string
}

/** 既定パス（本番）。テストでは引数で上書きする。 */
export function getDefaultMcpPaths(): McpPaths {
  return {
    claudeJsonPath: join(homedir(), '.claude.json')
  }
}

/**
 * project スコープの `.mcp.json` 絶対パス算出。
 * `claude mcp add --scope project` で当該 PJ ディレクトリに作られるファイル。
 */
export function getProjectMcpJsonPath(projectPath: string): string {
  return join(projectPath, '.mcp.json')
}

/**
 * グローバル `~/.claude.json` から `mcpServers` を読込。
 * ファイル不在 / parse 失敗時は空配列を返し、UI 側で「未設定」表示する。
 */
export async function listMcpServers(
  scope: McpScope,
  projectPath?: string,
  paths: McpPaths = getDefaultMcpPaths()
): Promise<McpServer[]> {
  const targetPath =
    scope === 'global' ? paths.claudeJsonPath : projectPath ? getProjectMcpJsonPath(projectPath) : null
  if (!targetPath) return []
  if (!existsSync(targetPath)) return []
  let content: string
  try {
    content = await readFile(targetPath, 'utf-8')
  } catch {
    return []
  }
  let parsed: ClaudeJson | ProjectMcpJson
  try {
    parsed = JSON.parse(content) as ClaudeJson | ProjectMcpJson
  } catch {
    return []
  }
  const servers = parsed.mcpServers ?? {}
  return Object.entries(servers).map(([name, def]) => ({ name, ...def }))
}

/** グローバル JSON 全体を返す（disabledTools 直接編集用）。 */
export async function readClaudeJson(
  paths: McpPaths = getDefaultMcpPaths()
): Promise<ClaudeJson> {
  if (!existsSync(paths.claudeJsonPath)) return {}
  try {
    const content = await readFile(paths.claudeJsonPath, 'utf-8')
    return JSON.parse(content) as ClaudeJson
  } catch {
    return {}
  }
}

/** project `.mcp.json` を読込。disabledTools 直接編集用。 */
export async function readProjectMcpJson(projectPath: string): Promise<ProjectMcpJson> {
  const target = getProjectMcpJsonPath(projectPath)
  if (!existsSync(target)) return {}
  try {
    const content = await readFile(target, 'utf-8')
    return JSON.parse(content) as ProjectMcpJson
  } catch {
    return {}
  }
}

/** Claude Code CLI が利用可能か確認。 */
export async function checkClaudeCodeAvailable(): Promise<boolean> {
  const { command, useShell } = resolveClaudeBin()
  const { execFile } = await import('child_process')
  return new Promise((resolve) => {
    execFile(command, ['--version'], { shell: useShell }, (err) => {
      resolve(!err)
    })
  })
}

/**
 * MCP server から「読み専用 tools / 書込系 tools」を分離。
 * tool 名は MCP server から動的取得する想定だが、Phase A では disabledTools の事前候補を
 * プリセット定義に含める形で運用する（GitHub MCP 等）。
 * この関数は与えられた候補 tool 名集合を分類するユーティリティ。
 */
export function classifyTools(tools: readonly string[]): {
  writeTools: string[]
  readTools: string[]
} {
  const writeTools: string[] = []
  const readTools: string[] = []
  for (const t of tools) {
    if (isWriteTool(t)) writeTools.push(t)
    else readTools.push(t)
  }
  return { writeTools, readTools }
}

/**
 * リスク階層自動判定（MANX r10 §5-13 暫定実装）:
 * - Strict: env に認証情報あり、もしくは disabledTools が登録されている (write tool 持ち)
 * - Caution: env に何かあるが認証情報ではない、かつ write 兆候なし
 * - Safe: env 空 + write 兆候なし
 */
export function classifyRisk(server: McpServer): RiskTier {
  const auth = hasAuthEnv(server.env)
  const hasWriteCandidates = (server.disabledTools ?? []).some(isWriteTool)
  if (auth || hasWriteCandidates) return 'strict'
  const envEntries = Object.keys(server.env ?? {}).length
  if (envEntries > 0) return 'caution'
  return 'safe'
}

/** spawn ラッパ: stdout/stderr 集約 + exit code 取得。 */
function runCli(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<CliResult> {
  let resolvedCommand = command
  let useShell = false
  if (command === 'claude') {
    const r = resolveClaudeBin()
    resolvedCommand = r.command
    useShell = r.useShell
  }
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    const child = spawn(resolvedCommand, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: useShell,
      windowsHide: true
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8')
    })
    child.on('error', (err) => {
      resolve({ ok: false, stdout, stderr: stderr || String(err), exitCode: null })
    })
    child.on('close', (code) => {
      resolve({ ok: code === 0, stdout, stderr, exitCode: code })
    })
  })
}

/**
 * `${env_var}` 形式バリデーション。生 token 直書きを検出する場合に true を返す。
 * 期待形式: 値全体が `${VAR_NAME}` であること、または値が完全な空文字。
 * 例: `${GITHUB_PERSONAL_ACCESS_TOKEN}` ✅、 `ghp_xxxxx` ❌
 */
export function looksLikePlainSecret(envValue: string): boolean {
  if (envValue.length === 0) return false
  // ${...} の正規形（前後空白許容）
  const envVarPattern = /^\s*\$\{[A-Z_][A-Z0-9_]*\}\s*$/
  if (envVarPattern.test(envValue)) return false
  // GitHub PAT の典型 prefix（v1: ghp_, fine-grained: github_pat_, classic: ghs_/gho_/ghu_/ghr_）
  if (/^(ghp|github_pat|ghs|gho|ghu|ghr)[_a-zA-Z0-9]/.test(envValue)) return true
  // 32文字以上の英数字文字列は秘密値の可能性
  if (/^[A-Za-z0-9_-]{32,}$/.test(envValue)) return true
  return false
}

/**
 * `claude mcp add` を実行して MCP server を追加する。
 * disabledTools が空でなければ、CLI 実行後に `~/.claude.json`（または `.mcp.json`）を
 * 直接読み書きして disabledTools 配列を merge する（CLI が disabledTools を非対応のため）。
 *
 * @param scope - 'global' は CLI の `--scope user` に、'project' は `--scope project` に対応
 */
export async function addMcpServer(
  scope: McpScope,
  server: McpServer,
  projectPath?: string,
  paths: McpPaths = getDefaultMcpPaths()
): Promise<AddResult> {
  if (!server.name || !server.command) {
    return { ok: false, error: 'name and command are required' }
  }
  // env 値の生 secret 検出
  for (const [key, value] of Object.entries(server.env ?? {})) {
    if (looksLikePlainSecret(value)) {
      return {
        ok: false,
        error: `env "${key}" appears to contain a plain secret. Use \${VAR_NAME} format instead.`
      }
    }
  }
  // CLI 引数組立。`-e KEY=VAL` を env 1件ごとに繰り返す。
  const cliScope = scope === 'global' ? 'user' : 'project'
  const args: string[] = ['mcp', 'add', '--scope', cliScope]
  for (const [k, v] of Object.entries(server.env ?? {})) {
    args.push('--env', `${k}=${v}`)
  }
  args.push(server.name, '--', server.command, ...(server.args ?? []))

  const cwd = scope === 'project' ? projectPath : undefined
  const cliResult = await runCli('claude', args, { cwd })
  if (!cliResult.ok) {
    return {
      ok: false,
      error: cliResult.stderr || cliResult.stdout || `claude mcp add exited with code ${cliResult.exitCode}`,
      cliStdout: cliResult.stdout,
      cliStderr: cliResult.stderr
    }
  }

  // disabledTools merge（CLI 非対応のため直接 JSON 編集）
  if (server.disabledTools && server.disabledTools.length > 0) {
    const mergeError = await mergeDisabledTools(scope, server.name, server.disabledTools, projectPath, paths)
    if (mergeError) {
      return { ok: false, error: mergeError, cliStdout: cliResult.stdout, cliStderr: cliResult.stderr }
    }
  }

  return { ok: true, cliStdout: cliResult.stdout, cliStderr: cliResult.stderr }
}

/** `claude mcp remove` を実行。 */
export async function removeMcpServer(
  scope: McpScope,
  name: string,
  projectPath?: string
): Promise<AddResult> {
  const cliScope = scope === 'global' ? 'user' : 'project'
  const args = ['mcp', 'remove', '--scope', cliScope, name]
  const cwd = scope === 'project' ? projectPath : undefined
  const cliResult = await runCli('claude', args, { cwd })
  if (!cliResult.ok) {
    return {
      ok: false,
      error: cliResult.stderr || cliResult.stdout || `claude mcp remove exited with code ${cliResult.exitCode}`,
      cliStdout: cliResult.stdout,
      cliStderr: cliResult.stderr
    }
  }
  return { ok: true, cliStdout: cliResult.stdout, cliStderr: cliResult.stderr }
}

/**
 * 既存 server の disabledTools 配列を上書き（merge ではなく置換）。
 * `~/.claude.json` または `{project}/.mcp.json` を直接読み書きする。
 */
export async function updateDisabledTools(
  scope: McpScope,
  name: string,
  disabledTools: string[],
  projectPath?: string,
  paths: McpPaths = getDefaultMcpPaths()
): Promise<AddResult> {
  return mergeDisabledTools(scope, name, disabledTools, projectPath, paths).then((err) =>
    err ? { ok: false, error: err } : { ok: true }
  )
}

async function mergeDisabledTools(
  scope: McpScope,
  name: string,
  disabledTools: string[],
  projectPath: string | undefined,
  paths: McpPaths
): Promise<string | null> {
  const targetPath =
    scope === 'global'
      ? paths.claudeJsonPath
      : projectPath
        ? getProjectMcpJsonPath(projectPath)
        : null
  if (!targetPath) return 'projectPath is required for project scope'
  if (!existsSync(targetPath)) {
    return `target file does not exist: ${targetPath} (claude mcp add should have created it)`
  }
  let parsed: ClaudeJson
  try {
    const content = await readFile(targetPath, 'utf-8')
    parsed = JSON.parse(content) as ClaudeJson
  } catch (e) {
    return `failed to read/parse ${targetPath}: ${e instanceof Error ? e.message : String(e)}`
  }
  if (!parsed.mcpServers || !parsed.mcpServers[name]) {
    return `server "${name}" not found in ${targetPath}`
  }
  parsed.mcpServers[name] = {
    ...parsed.mcpServers[name],
    disabledTools
  }
  try {
    await writeFile(targetPath, JSON.stringify(parsed, null, 2), 'utf-8')
    return null
  } catch (e) {
    return `failed to write ${targetPath}: ${e instanceof Error ? e.message : String(e)}`
  }
}
