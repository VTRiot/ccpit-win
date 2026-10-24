import { lookup as dnsLookup } from 'node:dns'
import { isIP } from 'node:net'
import { basename } from 'node:path'

/**
 * 隔離起動の実行時の境界。全部、依存（モジュール・session）を注入して試験できる。
 *
 * - 子プロセス: 全呼び出しを記録し、Claude Code・端末・npx の起動を拒否する
 * - 接続: 全接続を記録し、loopback 宛（自プロセスが listen したポート以外）を拒否する
 * - renderer の通信: loopback 宛の要求を遮断する
 *
 * 拒否は「本物の常駐・本物の Claude Code のセッションに触れない」ための守りで、
 * 許可リスト方式ではない（git・tasklist・powershell 等の補助実行体が UI 経路に多数あり、許可リストは脆い）。
 * 代わりに全呼び出しを記録し、報告で全件読む。
 */

export type GuardLog = (ev: Record<string, unknown>) => void

export const GUARD_ERROR_CODE = 'EISOLATED'

function guardError(message: string): Error {
  const e = new Error(`[隔離起動] ${message}`) as Error & { code: string }
  e.code = GUARD_ERROR_CODE
  return e
}

const DENY_BASENAMES = new Set(['claude', 'wt', 'npx', 'codex'])
const SHELL_BASENAMES = new Set(['cmd', 'powershell', 'pwsh', 'bash', 'sh'])
const VERSION_ONLY = new Set(['--version', '-v'])

function baseName(cmd: string): string {
  return basename(cmd.replace(/^"+|"+$/g, ''))
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|ps1)$/, '')
}

/**
 * シェル経由（cmd /c …・powershell -Command …）の引数のうち、拒否対象の実行体が**コマンド位置**
 * （先頭・`;`/`&`/`|`/`(` の直後・`-Command`／`/c`／`start` の直後）に現れるか。
 * 引数の文字列の中（例: CIM のフィルタ `Name='claude.exe'`）に現れるだけの読取専用の列挙は拒否しない。
 */
const DENY_WORD =
  /(^|[;&|(]|-Command\s+|-c\s+|\/c\s+|\bstart(?:-process)?\s+(?:-FilePath\s+)?(?:""\s+)?(?:\/D\s+\S+\s+)?)\s*(?:"(?:[^"]*[\\/])?|'(?:[^']*[\\/])?|(?:[^\s"';&|()]*[\\/])?)(claude|wt|npx|codex)(\.exe|\.cmd)?(?=[\s"';&|)]|$)/i

function scanShellText(text: string): { deny: boolean; reason?: string } {
  const m = DENY_WORD.exec(text)
  if (
    m &&
    !(m[2].toLowerCase() === 'claude' && /--version\s*$/.test(text) && !/[;&|]/.test(text))
  ) {
    return { deny: true, reason: `シェル経由の ${m[2]} の起動` }
  }
  return { deny: false }
}

/** PowerShell の -EncodedCommand（UTF-16LE の base64）を復号する。復号できなければ null。 */
function decodeEncodedCommand(args: readonly string[]): string | null {
  const i = args.findIndex((a) => /^-(e|ec|enc|encodedcommand)$/i.test(a))
  if (i < 0 || i + 1 >= args.length) return null
  try {
    return Buffer.from(args[i + 1], 'base64').toString('utf16le')
  } catch {
    return null
  }
}

export function classifySpawn(
  command: string,
  args: readonly string[]
): { deny: boolean; reason?: string } {
  const base = baseName(command)
  if (base === 'claude') {
    const versionOnly = args.length > 0 && args.every((a) => VERSION_ONLY.has(a))
    return versionOnly ? { deny: false } : { deny: true, reason: 'claude の起動（--version 以外）' }
  }
  if (DENY_BASENAMES.has(base)) return { deny: true, reason: `${base} の起動` }
  if (SHELL_BASENAMES.has(base)) {
    const direct = scanShellText(args.join(' '))
    if (direct.deny) return direct
    const decoded = decodeEncodedCommand(args)
    if (decoded !== null) return scanShellText(decoded)
  }
  return { deny: false }
}

/** 引用符を解釈して、コマンドライン文字列を先頭の実行体と残りの引数に分ける。 */
export function splitCommandLine(line: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line.trim())) !== null) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

type AnyFn = (...a: unknown[]) => unknown
export interface ChildProcessLike {
  [k: string]: unknown
}

const SPAWN_LIKE = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork'] as const
const STRING_COMMAND = ['exec', 'execSync'] as const

/** child_process の 7 関数を包む。戻り値は元に戻す関数（試験用）。 */
export function installChildProcessGuard(cp: ChildProcessLike, log: GuardLog): () => void {
  const restores: (() => void)[] = []
  const wrap = (name: string, kind: 'spawn' | 'string'): void => {
    const orig = cp[name] as AnyFn | undefined
    if (typeof orig !== 'function') return
    const wrapper = function (this: unknown, ...a: unknown[]): unknown {
      const first = typeof a[0] === 'string' ? a[0] : ''
      const args = kind === 'spawn' && Array.isArray(a[1]) ? (a[1] as unknown[]).map(String) : []
      const verdict =
        name === 'fork'
          ? { deny: false as boolean, reason: undefined as string | undefined }
          : kind === 'string'
            ? classifySpawn(splitCommandLine(first)[0] ?? '', splitCommandLine(first).slice(1))
            : classifySpawn(first, args)
      log({
        t: new Date().toISOString(),
        kind: 'spawn',
        fn: name,
        cmd: first.slice(0, 300),
        args: args.slice(0, 12),
        denied: verdict.deny
      })
      if (verdict.deny) throw guardError(`${verdict.reason ?? '実行'}を拒否しました`)
      return orig.apply(this, a)
    }
    cp[name] = wrapper
    restores.push(() => {
      cp[name] = orig
    })
  }
  for (const n of SPAWN_LIKE) wrap(n, 'spawn')
  for (const n of STRING_COMMAND) wrap(n, 'string')
  return () => restores.forEach((r) => r())
}

/** IPv6 リテラルを 16 バイトへ展開する（`::` 圧縮・埋め込み IPv4 の尾を処理）。解釈できなければ null。 */
function ipv6Bytes(addr: string): number[] | null {
  let s = addr
  if (s.includes('.')) {
    const colon = s.lastIndexOf(':')
    const v4 = s
      .slice(colon + 1)
      .split('.')
      .map(Number)
    if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
    s = `${s.slice(0, colon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const groups = (p: string): string[] => (p === '' ? [] : p.split(':'))
  const head = groups(halves[0])
  const tail = halves.length === 2 ? groups(halves[1]) : []
  const fill = 8 - head.length - tail.length
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null
  const all = [...head, ...Array<string>(fill).fill('0'), ...tail]
  const bytes: number[] = []
  for (const g of all) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null
    const n = parseInt(g, 16)
    bytes.push(n >> 8, n & 0xff)
  }
  return bytes
}

/** 127.0.0.0/8 と 0.0.0.0（Windows では 0.0.0.0 への接続も自機に届く）。 */
function isLoopbackV4(o: readonly number[]): boolean {
  return o[0] === 127 || o.every((n) => n === 0)
}

function isLoopbackV6(b: readonly number[]): boolean {
  const zeros = (n: number): boolean => b.slice(0, n).every((x) => x === 0)
  if (zeros(10) && b[10] === 0xff && b[11] === 0xff) return isLoopbackV4(b.slice(12)) // IPv4 射影
  if (!zeros(12)) return false
  // `::`・`::1`、および廃止された IPv4 互換形（::127.x.x.x）
  return (b[12] === 0 && b[13] === 0 && b[14] === 0 && b[15] <= 1) || b[12] === 127
}

/**
 * 宛先の文字列が loopback を指すか。字面の一致ではなく、末尾ドット・ゾーン ID を除いたうえで
 * IP リテラルは数値として（IPv6 の別表記・IPv4 射影を含む）、名前は `localhost`／`*.localhost`（RFC 6761）だけを真にする。
 * 任意の名前が loopback に解決されるかは、ここでは分からない（接続時の解決結果を installNetGuard が見る）。
 */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false
  let h = host.toLowerCase().replace(/^\[|\]$/g, '')
  const zone = h.indexOf('%')
  if (zone >= 0) h = h.slice(0, zone)
  h = h.replace(/\.+$/, '')
  if (h === '') return false
  const family = isIP(h)
  if (family === 4) return isLoopbackV4(h.split('.').map(Number))
  if (family === 6) {
    const b = ipv6Bytes(h)
    return b !== null && isLoopbackV6(b)
  }
  return h === 'localhost' || h.endsWith('.localhost')
}

export function isLoopbackUrl(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname)
  } catch {
    return false
  }
}

export interface NetLike {
  Socket: { prototype: { connect: AnyFn } }
  Server: { prototype: { listen: AnyFn } }
}

function normalizeConnectArgs(a: unknown[]): { host?: string; port?: number; path?: string } {
  const a0 = a[0]
  // net.connect / net.createConnection / http は、正規化済みの配列 [options, cb] を渡してくる（実測）
  if (Array.isArray(a0)) return normalizeConnectArgs(a0 as unknown[])
  if (a0 !== null && typeof a0 === 'object') {
    const o = a0 as { host?: string; port?: number | string; path?: string }
    if (typeof o.path === 'string') return { path: o.path }
    const port = o.port === undefined ? undefined : Number(o.port)
    return { host: o.host ?? 'localhost', port }
  }
  if (typeof a0 === 'number' || (typeof a0 === 'string' && /^\d+$/.test(a0))) {
    return { host: typeof a[1] === 'string' ? a[1] : 'localhost', port: Number(a0) }
  }
  if (typeof a0 === 'string') return { path: a0 }
  return {}
}

type LookupCb = (err: Error | null, address?: unknown, family?: number) => void
type LookupFn = (hostname: string, options: unknown, cb: LookupCb) => void

function resolvedAddresses(address: unknown): string[] {
  const items = Array.isArray(address) ? address : [address]
  return items
    .map((x) => (typeof x === 'string' ? x : (x as { address?: unknown } | null)?.address))
    .filter((x): x is string => typeof x === 'string')
}

/** 接続オプションの複製に `lookup` を差し替える（呼び出し元のオブジェクトは書き換えない）。 */
function withLookup(
  o: object,
  wrap: (orig: LookupFn | undefined) => LookupFn
): Record<string, unknown> {
  const opts = o as { lookup?: LookupFn }
  return Object.assign(Object.create(Object.getPrototypeOf(o)), o, { lookup: wrap(opts.lookup) })
}

/**
 * connect の引数の**構造を保ったまま**、接続オプションの `lookup` だけを差し替える。
 * - `[options, cb]`（net.connect・http が渡す正規化済み配列。Node が内部の印を付けるので配列は作り直さず要素 0 だけ置く）
 * - `(options, cb)`
 * - `(port[, host][, cb])`: Node 自身の normalizeArgs と同じ変換で options 形にする
 * パス形（pipe）は対象外。
 */
function injectLookup(a: unknown[], wrap: (orig: LookupFn | undefined) => LookupFn): unknown[] {
  const a0 = a[0]
  if (Array.isArray(a0)) {
    if (a0[0] !== null && typeof a0[0] === 'object') a0[0] = withLookup(a0[0] as object, wrap)
    return a
  }
  if (a0 !== null && typeof a0 === 'object') return [withLookup(a0, wrap), ...a.slice(1)]
  if (typeof a0 === 'number' || (typeof a0 === 'string' && /^\d+$/.test(a0))) {
    const host = typeof a[1] === 'string' ? a[1] : undefined
    const rest = a.slice(host === undefined ? 1 : 2)
    return [{ port: a0, ...(host === undefined ? {} : { host }), lookup: wrap(undefined) }, ...rest]
  }
  return a
}

/**
 * 接続を全件記録し、loopback 宛を拒否する（自分が listen したポート・exempt は除く）。
 * 宛先が IP リテラルまたは `localhost` 系ならその場で判定し、それ以外の名前（数値形の `2130706433`・
 * hosts や DNS で 127.0.0.1 に解決される名前）は、接続時に使う `lookup` を包んで**解決後のアドレス**で判定する。
 */
export function installNetGuard(
  net: NetLike,
  log: GuardLog,
  exemptPorts: ReadonlySet<number> = new Set(),
  defaultLookup: LookupFn = dnsLookup as unknown as LookupFn
): { ownPorts: Set<number>; restore: () => void } {
  const ownPorts = new Set<number>()
  const origConnect = net.Socket.prototype.connect
  const origListen = net.Server.prototype.listen
  const allowedPort = (p: number): boolean => ownPorts.has(p) || exemptPorts.has(p)

  net.Socket.prototype.connect = function (
    this: { destroy(e?: Error): void },
    ...a: unknown[]
  ): unknown {
    const t = normalizeConnectArgs(a)
    const denied = t.port !== undefined && isLoopbackHost(t.host) && !allowedPort(t.port)
    log({
      t: new Date().toISOString(),
      kind: 'connect',
      host: t.host,
      port: t.port,
      path: t.path,
      denied
    })
    if (denied) {
      const err = guardError(`loopback 宛の接続を拒否しました（${t.host}:${t.port}）`)
      process.nextTick(() => this.destroy(err))
      return this
    }
    let args = a
    const { host, port } = t
    if (port !== undefined && host !== undefined && isIP(host.replace(/^\[|\]$/g, '')) === 0) {
      args = injectLookup(a, (orig) => {
        const base = orig ?? defaultLookup
        return function (this: unknown, hostname, options, cb): void {
          const [opts, done] =
            typeof options === 'function' ? [{}, options as LookupCb] : [options, cb]
          base.call(this, hostname, opts, (err, address, family) => {
            const hit = err ? undefined : resolvedAddresses(address).find((x) => isLoopbackHost(x))
            if (hit !== undefined && !allowedPort(port)) {
              log({
                t: new Date().toISOString(),
                kind: 'connect',
                host,
                port,
                resolved: hit,
                denied: true
              })
              done(
                guardError(
                  `loopback に解決される宛先への接続を拒否しました（${host}:${port} → ${hit}）`
                )
              )
              return
            }
            done(err, address, family)
          })
        }
      })
    }
    return origConnect.apply(this, args)
  }

  net.Server.prototype.listen = function (
    this: { once(ev: string, fn: () => void): void; address(): unknown },
    ...a: unknown[]
  ): unknown {
    log({
      t: new Date().toISOString(),
      kind: 'listen',
      args: a.filter((x) => typeof x !== 'function').slice(0, 2)
    })
    this.once('listening', () => {
      const addr = this.address()
      if (addr && typeof addr === 'object' && 'port' in addr) {
        const p = Number((addr as { port: number }).port)
        ownPorts.add(p)
        log({ t: new Date().toISOString(), kind: 'listening', port: p })
      }
    })
    return origListen.apply(this, a)
  }

  return {
    ownPorts,
    restore: () => {
      net.Socket.prototype.connect = origConnect
      net.Server.prototype.listen = origListen
    }
  }
}

export interface SessionLike {
  webRequest: {
    onBeforeRequest(
      listener: (details: { url: string }, cb: (r: { cancel: boolean }) => void) => void
    ): void
  }
}

/** renderer からの loopback 宛の要求を遮断する。exemptOrigins（dev サーバの配信元など）は通す。 */
export function installWebRequestGuard(
  sess: SessionLike,
  log: GuardLog,
  exemptOrigins: readonly string[] = []
): void {
  sess.webRequest.onBeforeRequest((details, cb) => {
    let origin = ''
    try {
      origin = new URL(details.url).origin
    } catch {
      /* URL でないものは通す */
    }
    const deny = isLoopbackUrl(details.url) && !exemptOrigins.includes(origin)
    if (deny)
      log({
        t: new Date().toISOString(),
        kind: 'renderer-request',
        url: details.url.slice(0, 200),
        denied: true
      })
    cb({ cancel: deny })
  })
}
