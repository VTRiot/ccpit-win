/**
 * procEnum — live な claude.exe プロセスを CIM で全列挙する。
 *
 * 検出ギャップ根治の「全数検出（fail-silent 根絶）」の情報源。sessions/<pid>.json は
 * fresh 端末 CC に書かれないため、live プロセスを一次情報にする。
 *
 * Codex 反映:
 *  #5 enum 失敗は判別共用体 {ok:false,error} で返す（[] に潰して "0=green" にしない＝fail-closed）。
 *  #6 claude.exe 名前依存は脆い → 観測した name は記録し、--resume parse は strict（advisory）。
 */

import { spawn } from 'child_process'

export interface LiveProc {
  pid: number
  ppid: number
  createdAt: string | null
  commandLine: string | null
}

export type ProcEnumResult = { ok: true; procs: LiveProc[] } | { ok: false; error: string }

export type SpawnEnumFn = () => Promise<{ status: number | null; stdout: string; stderr: string }>

const PS_SCRIPT =
  "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | " +
  "Select-Object ProcessId,ParentProcessId,@{n='Created';e={$_.CreationDate.ToString('o')}},CommandLine | " +
  'ConvertTo-Json -Compress'

function defaultSpawnEnum(): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    try {
      const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT], {
        windowsHide: true
      })
      let stdout = ''
      let stderr = ''
      ps.stdout?.on('data', (d) => (stdout += d))
      ps.stderr?.on('data', (d) => (stderr += d))
      ps.on('error', (e) => resolve({ status: null, stdout: '', stderr: e.message }))
      ps.on('close', (code) => resolve({ status: code, stdout, stderr }))
    } catch (e) {
      resolve({ status: null, stdout: '', stderr: e instanceof Error ? e.message : String(e) })
    }
  })
}

/** ConvertTo-Json は 1 件だとオブジェクト、複数だと配列、0 件だと空文字を返す。全て正規化。 */
export function parseCimJson(stdout: string): LiveProc[] {
  const trimmed = stdout.trim()
  if (!trimmed) return []
  const parsed = JSON.parse(trimmed) as unknown
  const arr = Array.isArray(parsed) ? parsed : [parsed]
  const out: LiveProc[] = []
  for (const item of arr) {
    if (item === null || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const pid = typeof r.ProcessId === 'number' ? r.ProcessId : Number(r.ProcessId)
    if (!Number.isInteger(pid)) continue
    out.push({
      pid,
      ppid:
        typeof r.ParentProcessId === 'number' ? r.ParentProcessId : Number(r.ParentProcessId) || 0,
      createdAt: typeof r.Created === 'string' ? r.Created : null,
      commandLine: typeof r.CommandLine === 'string' ? r.CommandLine : null
    })
  }
  return out
}

/**
 * live claude.exe を列挙する。spawn/parse 失敗は fail-closed（{ok:false}）。
 */
export async function enumClaudeProcs(opts?: { spawnFn?: SpawnEnumFn }): Promise<ProcEnumResult> {
  if (process.platform !== 'win32' && !opts?.spawnFn) {
    // 非 win32 は本機能の対象外（当面 MANX）。明示的に未対応を返す。
    return { ok: false, error: 'CIM 列挙は win32 のみ対応（当面 MANX）' }
  }
  const spawnFn = opts?.spawnFn ?? defaultSpawnEnum
  let res: { status: number | null; stdout: string; stderr: string }
  try {
    res = await spawnFn()
  } catch (e) {
    return { ok: false, error: `CIM spawn 失敗: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (res.status !== 0 && res.stdout.trim() === '') {
    return { ok: false, error: `CIM 列挙失敗（status=${res.status}）: ${res.stderr.slice(0, 200)}` }
  }
  try {
    return { ok: true, procs: parseCimJson(res.stdout) }
  } catch (e) {
    return { ok: false, error: `CIM 出力 parse 失敗: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/**
 * CommandLine から --resume の sessionId を strict 抽出（Codex #6: advisory）。
 * `--resume <sid>` / `--resume=<sid>` のみ。`--continue` 等は対象外（null）。
 */
export function parseResumeSessionId(commandLine: string | null): string | null {
  if (!commandLine) return null
  const m = commandLine.match(/--resume[=\s]+([0-9a-fA-F]{8}-[0-9a-fA-F-]{20,})/)
  return m ? m[1] : null
}
