import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
  type Server
} from 'http'
import { URL } from 'url'
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { app } from 'electron'
import { sanitizeEnvironmentBlock } from './pxpipeEnvSanitizer'

/**
 * CC → 本リレー → pxpipe-proxy → Anthropic の順に挟む薄い中継サーバ（13_pxp Phase 1）。
 * pxpipe 自身はフォーク・パッチせず無改変のまま使う（非侵襲 overlay。dashboard-ja と対称）。
 *
 * リクエストのみをバッファしてサニタイズし、pxpipe の実 URL へ転送する。レスポンスは
 * 一切変換せずストリーミングのままパススルーする（SSE を壊さない。pxpipe 自身の
 * "requests only" 方針と対称）。pxpipe-proxy と異なり外部プロセスではなく CCPIT 自身の
 * プロセス内に閉じるため、他プロセスからの reuse を想定した identity-gate は不要
 * （プロセスの生存＝このリレーの生存）。
 */

export const ENV_SANITIZE_RELAY_HOST = '127.0.0.1'

/**
 * 生ボディの上限（bytes）。Codex adversarial-review 指摘（severity: medium）: 本リレーは
 * CCPIT の Electron メインプロセス内で動くため、上限もタイムアウトもないバッファリングは
 * 巨大リクエスト・低速クライアントによるメモリ圧迫/ハングの新規リスクになる。
 * 200MiB は、本プロダクトが対象とする 1M コンテキスト＋pxpipe の画像化された長い履歴を
 * 十分に許容しつつ、無制限バッファだけは物理的に防ぐための余裕値（Anthropic 側の実際の
 * 上限より緩め＝正当な大きいリクエストを誤って弾かないことを優先）。
 */
export const MAX_BODY_BYTES = 200 * 1024 * 1024

/**
 * 1 リクエストの受信完了を待つ上限（ms）。127.0.0.1 ループバックのため、正常系なら
 * 巨大なボディでも数秒〜十数秒で完了するはず。60 秒を超えて送信が終わらない接続は
 * ハング/低速攻撃とみなし切断する。
 */
export const BODY_READ_TIMEOUT_MS = 60_000

/** ボディが上限を超えた場合に投げる（呼び出し側で 413 に変換）。 */
export class BodyTooLargeError extends Error {}
/** ボディ受信が時間内に完了しなかった場合に投げる（呼び出し側で 408 に変換）。 */
export class BodyReadTimeoutError extends Error {}

/**
 * pxpipe-proxy への転送リクエストが応答を返すまで待つ上限（ms）。
 * サブエージェントによる考古学的検証（round3後のadversarial re-verification）で実証: この
 * アウトバウンド httpRequest にはタイムアウトが一切無く、pxpipe-proxy 自身がエラーも返さず
 * ハングした場合、本リレーの呼び出し元（CC）を無期限に待たせてしまう既存の穴だった
 * （Codex round1/2 いずれの指摘とも別方向＝下流待ちの無制限化）。pxpipe は大きな画像化
 * （1M コンテキスト・長い履歴）を行うため、正常系でも数十秒かかり得る余裕を見て 120 秒とする。
 */
export const UPSTREAM_REQUEST_TIMEOUT_MS = 120_000

/**
 * 前回の待受ポートを覚えておくファイル。
 *
 * これが無いと、CCPIT を再起動するたびに `listen(0)` が別のエフェメラルポートを引き、
 * **起動済みの CC セッションが全滅する**（CC は起動時に焼かれた ANTHROPIC_BASE_URL を
 * 再解決できないため、消えた旧ポートを叩き続けて ECONNREFUSED になる）。
 * 実際に 2026-08-06 と 08-07 に発生し、後者は「CCPIT を再起動してくれ」という
 * 何気ない指示が引き金になった。
 *
 * そこで前回ポートを記録し、次回起動時にまず同じポートを試す。取れれば URL が不変になり、
 * 既存セッションはそのまま生き延びる。取れなければ従来どおり `listen(0)` へ落ちるだけで、
 * 挙動は今までと同じ（劣化しない）。
 *
 * パス解決は**呼び出し時**に行う（トップレベルで `app.getPath` を呼ぶと、この
 * モジュールが electron 必須になり、既存の統合テストが import しただけで落ちる）。
 */
function relayStateFile(): string {
  return join(app.getPath('home'), '.ccpit', 'relay-port.json')
}

let server: Server | null = null
let serverUrl: string | null = null
let upstreamUrl: string | null = null

/**
 * 上流の遅延解決器。起動時復活で「待受だけ先に立てる」場合、上流はまだ存在しないことがある。
 * その状態でリクエストが来たらここで解決を試みる（実装レビュー #1: 上流が数秒遅れて
 * 立ち上がるだけで救済が空振りする問題への対処）。
 */
let upstreamResolver: (() => Promise<string | null>) | null = null

/** 上流の遅延解決器を登録する（proxy への依存方向を持ち込まないため関数注入）。 */
export function setUpstreamResolver(fn: (() => Promise<string | null>) | null): void {
  upstreamResolver = fn
}

/** 前回ポートを読む。壊れていれば黙って null（起動を妨げない）。 */
function readLastPort(): number | null {
  try {
    const raw = JSON.parse(readFileSync(relayStateFile(), 'utf8')) as { port?: unknown }
    const p = typeof raw.port === 'number' ? raw.port : NaN
    // エフェメラル域の妥当値のみ受理（0 や特権ポートを引き継がない）。
    return Number.isInteger(p) && p > 1024 && p < 65536 ? p : null
  } catch {
    return null
  }
}

/** 待受ポートを記録する。失敗しても起動は続ける（記録は best-effort）。 */
function writeLastPort(port: number): void {
  try {
    const file = relayStateFile()
    mkdirSync(dirname(file), { recursive: true })
    // 診断用に pid と時刻も残す（古い値を「生きている」と誤読させないため）。
    const body = JSON.stringify({ port, pid: process.pid, updatedAt: new Date().toISOString() })
    const tmp = file + '.tmp'
    writeFileSync(tmp, body + '\n', 'utf8')
    renameSync(tmp, file)
  } catch {
    /* 記録できなくても中継は動く */
  }
}

/**
 * 指定ポートで listen を試す。失敗したら null を返す（例外にしない）。
 * port=0 は OS 任せ＝必ず成功する想定の最終手段。
 */
function tryListen(
  s: Server,
  port: number
): Promise<{ ok: true; port: number } | { ok: false; error: Error }> {
  return new Promise((resolve) => {
    let settled = false
    const onError = (e: Error): void => {
      if (settled) return
      settled = true
      s.removeListener('listening', onListening)
      resolve({ ok: false, error: e })
    }
    const onListening = (): void => {
      if (settled) return
      settled = true
      s.removeListener('error', onError)
      const addr = s.address()
      if (addr === null || typeof addr === 'string') {
        resolve({ ok: false, error: new Error('listen address を特定できません') })
        return
      }
      resolve({ ok: true, port: addr.port })
    }
    s.once('error', onError)
    s.once('listening', onListening)
    s.listen(port, ENV_SANITIZE_RELAY_HOST)
  })
}

export interface BodyLimits {
  maxBodyBytes: number
  bodyReadTimeoutMs: number
}

const DEFAULT_BODY_LIMITS: BodyLimits = {
  maxBodyBytes: MAX_BODY_BYTES,
  bodyReadTimeoutMs: BODY_READ_TIMEOUT_MS
}

/**
 * limits は既定でプロダクション値を使う。テストが小さい値を注入して実際に 200MiB/60秒を
 * 待たずに上限・タイムアウト経路を検証できるようにするため引数化している。
 *
 * Codex adversarial-review round 2 指摘（severity: medium）: 上限・タイムアウト超過時に
 * ここで `req.destroy()` すると、Node の http では request と response が同じソケットを
 * 共有するため、呼び出し側（handleRequest）が 413/408 を書く前にソケットが壊れてしまい、
 * クライアントには制御されたステータスではなく ECONNRESET が見える。そのためソケットは
 * ここでは破壊せず、型付きエラーで reject するだけに留める（実ソケットのクローズは、
 * レスポンス送出後に handleRequest 側の `Connection: close` に委ねる）。
 */
export function collectBody(
  req: IncomingMessage,
  limits: BodyLimits = DEFAULT_BODY_LIMITS
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new BodyReadTimeoutError('request body read timed out'))
    }, limits.bodyReadTimeoutMs)

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    req.on('data', (chunk: Buffer) => {
      if (settled) return
      total += chunk.length
      if (total > limits.maxBodyBytes) {
        finish(() =>
          reject(new BodyTooLargeError(`request body exceeds ${limits.maxBodyBytes} bytes`))
        )
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish(() => resolve(Buffer.concat(chunks))))
    req.on('error', (e) => finish(() => reject(e)))
  })
}

const warnedIdentityModels = new Set<string>()

function sanitizeOrPassthrough(rawBody: Buffer, context: string): Buffer {
  if (rawBody.length === 0) return rawBody
  try {
    const { body, info } = sanitizeEnvironmentBlock(rawBody)
    if (info.skippedReason && info.skippedReason !== 'no_environment_section_found') {
      console.warn(`[pxpipeEnvSanitizeRelay] fail-open (${info.skippedReason}): ${context}`)
    } else if (info.identityRemoved) {
      const model = context.match(/claude-[a-z0-9-]+/i)?.[0] || 'unknown'
      if (!warnedIdentityModels.has(model)) {
        warnedIdentityModels.add(model)
        console.warn(`[pxpipeEnvSanitizeRelay] identity line removed (model ID mismatch: ${model}): ${context}`)
      }
    }
    return body
  } catch (e) {
    // サニタイズ自体が例外を投げても、リクエストは原文のまま通す（fail-open）。
    console.warn(
      `[pxpipeEnvSanitizeRelay] sanitize threw, forwarding unmodified (${context}): ${e instanceof Error ? e.message : String(e)}`
    )
    return rawBody
  }
}

function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  bodyLimits: BodyLimits,
  upstreamTimeoutMs: number
): void {
  // 上流が未確定なら、その場で解決を試みる（実装レビュー #1）。
  // 起動時復活では「まず待受だけ立てて、上流は後から現れてもよい」形にしているため、
  // ここで遅延解決できないと、上流が立ち上がった後も 502 を返し続けてしまう。
  if (!upstreamUrl && upstreamResolver) {
    void upstreamResolver()
      .then((resolved) => {
        if (resolved) upstreamUrl = resolved
        forwardRequest(req, res, bodyLimits, upstreamTimeoutMs)
      })
      .catch(() => forwardRequest(req, res, bodyLimits, upstreamTimeoutMs))
    return
  }
  forwardRequest(req, res, bodyLimits, upstreamTimeoutMs)
}

/** 上流確定後の実転送。 */
function forwardRequest(
  req: IncomingMessage,
  res: ServerResponse,
  bodyLimits: BodyLimits,
  upstreamTimeoutMs: number
): void {
  const target = upstreamUrl
  if (!target) {
    res.writeHead(502, { 'content-type': 'text/plain' })
    res.end('pxpipeEnvSanitizeRelay: no upstream configured')
    return
  }

  collectBody(req, bodyLimits)
    .then((rawBody) => {
      const outBody = sanitizeOrPassthrough(rawBody, `${req.method ?? '?'} ${req.url ?? '?'}`)

      const targetUrl = new URL(req.url ?? '/', target)
      const headers = { ...req.headers }
      delete headers['content-length']
      headers['content-length'] = String(outBody.length)
      // 一部サーバは Host 不一致を拒否するため、転送先の host に合わせる。
      headers.host = targetUrl.host

      const upstreamReq = httpRequest(
        {
          hostname: targetUrl.hostname,
          port: targetUrl.port,
          path: targetUrl.pathname + targetUrl.search,
          method: req.method,
          headers
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
          // レスポンスは変換せずそのままストリーミングで転送する（SSE を壊さない）。
          upstreamRes.pipe(res)
        }
      )
      // upstreamReq は本リレーが自ら起こしたアウトバウンド接続（CC↔本リレーの req/res とは
      // 別のソケット）なので、ここで destroy しても呼び出し元への応答経路は壊れない
      // （round2 の穴とは別物）。タイムアウト発火は 'error' を発生させ、下の on('error') で
      // 502 応答へつながる。
      upstreamReq.setTimeout(upstreamTimeoutMs, () => {
        upstreamReq.destroy(new Error(`upstream request timed out after ${upstreamTimeoutMs}ms`))
      })
      upstreamReq.on('error', (e) => {
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'text/plain' })
          res.end(`pxpipeEnvSanitizeRelay: upstream request failed: ${e.message}`)
          return
        }
        // Codex round4 指摘（severity: medium）: upstream がヘッダ送出後（ストリーミング
        // 開始後）にハング/失敗すると、一度コミットしたステータスは変更できない。中途半端に
        // 「正常終了」したふりをして res.end() するとステータスだけ成功のまま呼び出し元を
        // 誤解させるため、接続ごと打ち切る（標準的なリバースプロキシの挙動＝送信済み
        // ヘッダを撤回できない場合は接続を切る、と同じ。無期限ハングにはしない）。
        res.destroy(e)
      })
      upstreamReq.end(outBody)
    })
    .catch((e) => {
      // ソケットはまだ生きている（collectBody はもう破壊しない）。ここで先にステータスを
      // 書いてから、`Connection: close` で送出後にソケットを閉じる（req.destroy() を手動の
      // タイミングで呼ぶと res.end() のフラッシュと競合しうるため、Node 標準の keep-alive
      // 制御に委ねる）。オーバーサイズ/ハング状態の接続を keep-alive で使い回させない。
      if (!res.headersSent) {
        const status =
          e instanceof BodyTooLargeError ? 413 : e instanceof BodyReadTimeoutError ? 408 : 400
        res.writeHead(status, { 'content-type': 'text/plain', connection: 'close' })
      }
      res.end(
        `pxpipeEnvSanitizeRelay: failed to read request body: ${e instanceof Error ? e.message : String(e)}`
      )
    })
}

export interface EnsureRelayResult {
  ok: boolean
  url: string
}

let pendingEnsure: Promise<EnsureRelayResult> | null = null

/**
 * リレーを起動（未起動時）または既存インスタンスを再利用し、転送先（pxpipe の実 URL）を
 * 更新する。pxpipe がポートフェイルオーバーした場合でも、次回呼び出しでここが追従する。
 * 単一プロセス内シングルトンのため、pxpipe-proxy のような外部プロセス向け identity-gate は
 * 不要（cf. `ensureProxy`）。
 *
 * `bodyLimits` は既定でプロダクション値（200MiB/60秒）。テストが小さい値を注入し、実際の
 * loopback HTTP 経由で 413/408 応答を検証できるようにするため引数化している
 * （`collectBody` 単体テストではソケットを介さないため、実クライアントが受け取る HTTP
 * ステータスまでは検証できない。Codex adversarial-review round 2 指摘）。
 * `upstreamTimeoutMs` は既定でプロダクション値（120秒）。同じ理由でテストが小さい値を
 * 注入できるようにしている（サブエージェントの考古学的検証で発見した、下流無応答時の
 * 無期限ハングに対する回帰テスト用）。
 */
export function ensureEnvSanitizeRelay(
  targetUpstreamUrl: string,
  bodyLimits: BodyLimits = DEFAULT_BODY_LIMITS,
  upstreamTimeoutMs: number = UPSTREAM_REQUEST_TIMEOUT_MS
): Promise<EnsureRelayResult> {
  upstreamUrl = targetUpstreamUrl
  if (server && serverUrl) {
    return Promise.resolve({ ok: true, url: serverUrl })
  }
  if (pendingEnsure) return pendingEnsure

  pendingEnsure = (async (): Promise<EnsureRelayResult> => {
    const s = createServer((req, res) => handleRequest(req, res, bodyLimits, upstreamTimeoutMs))

    // まず前回と同じポートを試す。取れれば CCPIT を再起動しても中継 URL が変わらず、
    // 起動済み CC セッションは ANTHROPIC_BASE_URL を再解決できないまま生き延びられる。
    const last = readLastPort()
    const hadRecord = last != null
    const bound = hadRecord ? await tryListen(s, last) : null

    // 取れなければ（他プロセスが使用中・TIME_WAIT 等）従来どおり OS 任せに落とす。
    // ここで劣化するのは「既存セッションが復帰できない」という**従来と同じ**状態までで、
    // 新規セッションは正常に動く。
    const reclaimed = bound != null && bound.ok
    if (!reclaimed) {
      // 失敗した Server は再利用しない（bind 失敗後の再 listen は状態が読みにくい）。
      s.close()
      const fresh = createServer((req, res) =>
        handleRequest(req, res, bodyLimits, upstreamTimeoutMs)
      )
      const fallback = await tryListen(fresh, 0)
      if (!fallback.ok) {
        pendingEnsure = null
        throw fallback.error
      }
      fresh.on('close', () => {
        if (server === fresh) {
          server = null
          serverUrl = null
        }
      })
      server = fresh
      serverUrl = `http://${ENV_SANITIZE_RELAY_HOST}:${fallback.port}`
      if (!hadRecord) writeLastPort(fallback.port)
      pendingEnsure = null
      return { ok: true, url: serverUrl }
    }

    s.on('close', () => {
      if (server === s) {
        server = null
        serverUrl = null
      }
    })
    server = s
    serverUrl = `http://${ENV_SANITIZE_RELAY_HOST}:${bound.port}`
    writeLastPort(bound.port)
    pendingEnsure = null
    return { ok: true, url: serverUrl }
  })()

  // 失敗時は in-flight を確実に解除する（次回呼び出しで再挑戦できるように）。
  void pendingEnsure.catch(() => {
    pendingEnsure = null
  })
  return pendingEnsure
}

/**
 * **アプリ起動時に、前回の中継を同じアドレスで復活させる**（既存 CC セッションの救済）。
 *
 * これが無いと前回ポートの記録だけでは足りない: `ensureEnvSanitizeRelay` は `cc:launch` /
 * `cc:restartAll` からしか呼ばれないため、アプリを再起動しただけでは中継が立たず、
 * 起動済み CC は「誰かが新しいセッションを起動する」まで ECONNREFUSED を受け続ける。
 * 待っていれば直る状態にするには、起動直後に自分から中継を立て直す必要がある。
 *
 * **上流の生死を復活の条件にしない**（実装レビュー #1）。上流 proxy がアプリ起動より
 * 数秒遅れて立ち上がるだけで救済が空振りし、既存 CC が取り残されるため。
 * 待受だけ先に確保しておけば、CC の接続自体は成立し（上流未確定の間は 502）、
 * 上流が現れた時点で `upstreamResolver` が解決して正常化する。
 * 失敗しても投げない＝起動を妨げない。
 *
 * @param resolveUpstream 生きている上流 proxy の URL を返す（無ければ null）。
 *   proxy への依存方向を持ち込まないために関数で注入する。
 *   遅延解決器としても登録され、リクエスト時に上流を引き直す。
 */
/** 上流 URL を直接更新する（自律復旧や Watchdog からの即時反映用）。 */
export function setUpstreamUrl(url: string | null): void {
  upstreamUrl = url
}

/** 現在の転送先上流 URL を返す。 */
export function getUpstreamUrl(): string | null {
  return upstreamUrl
}

/** 現在のリレー待受 URL を返す。 */
export function getRelayServerUrl(): string | null {
  return serverUrl
}

/**
 * **アプリ起動時に、前回の中継を同じアドレスで復活させる**（既存 CC セッションの救済）。
 *
 * Codex F3 / AC-8: 上流 proxy の生死や解決時間を待たずに、まず前回の待受ポートを
 * 最優先・非ブロッキングで先行確保する。CC からのリクエストが来ても、上流が立ち上がった
 * 時点で遅延解決またはバックグラウンド解決結果が反映されて疎通する。
 */
export async function restoreEnvSanitizeRelay(
  resolveUpstream: () => Promise<string | null>
): Promise<{ restored: boolean; url?: string; reason?: string }> {
  try {
    // 上流が後から現れても追随できるよう、まず解決器を登録する。
    setUpstreamResolver(resolveUpstream)

    if (server && serverUrl) return { restored: false, reason: '既に起動済み' }
    const lastPort = readLastPort()
    if (lastPort == null) return { restored: false, reason: '前回ポートの記録なし' }

    // Codex F3 / AC-8: 上流の解決を await せず、まず待受だけ先行して確実に確保する。
    const result = await ensureEnvSanitizeRelay('')
    upstreamUrl = null

    // 前回と同じポートを取れたかを申告する。
    const sameAddress = result.url === `http://${ENV_SANITIZE_RELAY_HOST}:${lastPort}`

    // 上流の解決は非同期で追随させる（非ブロッキング）
    void resolveUpstream()
      .then((upstream) => {
        if (upstream) upstreamUrl = upstream
      })
      .catch(() => {
        /* best-effort */
      })

    return sameAddress
      ? { restored: true, url: result.url }
      : {
          restored: false,
          url: result.url,
          reason: `前回ポート ${lastPort} を確保できず別ポートで起動`
        }
  } catch (e) {
    return { restored: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/** リレーを停止する（app 終了時に呼ぶ）。長時間 SSE 接続が残っていても app 終了を妨げないよう、
 *  close() 待ちに加えて既存ソケットを強制終了する。 */
export function stopEnvSanitizeRelay(): Promise<void> {
  const s = server
  server = null
  serverUrl = null
  upstreamUrl = null
  if (!s) return Promise.resolve()
  return new Promise((resolve) => {
    s.close(() => resolve())
    s.closeAllConnections?.()
  })
}

/** 診断用: リレーが現在起動しているか。 */
export function isRelayRunning(): boolean {
  return server != null
}
