import { spawn, type ChildProcess } from 'child_process'
import { get as httpGet } from 'http'
import { connect as netConnect } from 'net'
import { ISOLATION_BLOCK_REASON, isIsolatedLaunch, noteBlocked } from '../isolation'
import { resolveNpxBin } from './cliResolver'
import {
  writeOwnershipLease,
  clearOwnershipLease,
  validateAndAdoptLease,
  withProxyLock,
  buildProxyConfigFingerprint,
  type OwnershipLease,
  type OwnershipContext
} from './pxpipeOwnership'
import { PXPIPE_PACKAGE } from './pxpipeVersion'

/**
 * pxpipe proxy（teamchong/pxpipe = トークン削減ローカルプロキシ）の常駐管理。
 * 候補ポートを順に走査する（038 Feature C: claude-px.ps1 のポートフェイルオーバー輸入）。
 * 「我々が起動した子」だけを保持し、app 終了時に kill する（kill は PID ベースでポート非依存）。
 * 外部起動 / 別セッション起動の健全な proxy は reuse するが kill 対象にしない。
 * PXPIPE_MODELS 等は proxy 側 env として渡す（CC には渡さない。CC は ANTHROPIC_BASE_URL のみ）。
 */

export const PXPIPE_HOST = '127.0.0.1'
/**
 * 候補ポート（優先順）。claude-px.ps1（07-10 squatter 根治）と同一系列を輸入し、
 * 「CLI は生き残るが CCPIT 経由だけ死ぬ」非対称（038 F7）を解消する。
 */
export const PXPIPE_PORT_CANDIDATES = [47821, 47831, 47841] as const
/** TCP probe の timeout。応答しない listen（filtered 等）は squatter 扱いで次候補へ。 */
const TCP_PROBE_TIMEOUT_MS = 1000
/** 版 pin（resources/pxpipe-version.json 正本導出値）。 */
export { PXPIPE_PACKAGE, PXPIPE_TARGET_VERSION } from './pxpipeVersion'
/**
 * proxy へ継承させない env キー（**case-insensitive** で照合）。
 *
 * 画像化スコープの正本は appConfig（`ipc.ts` の `pxpipeProxyEnv`）で、未設定時は pxpipe 本体の
 * 組込み既定（`applicability.js` の `DEFAULT_MODEL_BASES`）へ委譲する。ここで CCPIT 側の既定値を
 * 持つと上流と二重管理になり、上流が対象families を更新しても永久に追従できん
 * （2026-08-21 実害: `claude-opus-5` へ切替→ base 照合が外れ削減ゼロ。一方 contextWindow は
 * 範囲判定で `[1m]` を付けるため「窓だけ 1M・削減ゼロ」の片肺になっとった）。
 *
 * 継承分を落とすのは、GUI を起動したシェルの残留値で挙動が変わらんようにするため
 * （config を唯一の正本とする）。Windows の `process.env` は列挙時に元の casing を保つため、
 * `PxPipe_Models` 等の異表記が漏れんよう小文字化して照合する。
 */
const SUPPRESSED_INHERITED_ENV = ['PXPIPE_MODELS']

/** 候補ポート → URL（旧 PXPIPE_URL 定数の動的化。消費者は EnsureProxyResult.url を使うこと）。 */
export function pxpipeUrl(port: number): string {
  return `http://${PXPIPE_HOST}:${port}`
}

let ownedChild: ChildProcess | null = null
/** ownedChild を起動したポート。フェイルオーバーで第 1 候補以外へ起動した場合も実際の値を返すため保持する。 */
let ownedPort: number | null = null
/** ownedChild の起動成功時に記録した lease（getActiveProxyLease が合成でなくこれを返す）。 */
let ownedLease: OwnershipLease | null = null

/**
 * dashboard の日本語化中継（serve-ja）が配信ページへ注入する辞書の変数名。
 * CCPIT 同梱の `resources/dashboard-ja/serve-ja.mjs` と、同じ系譜の GemPIT 版 serve-ja が共に注入する。
 * pxpipe 由来の語ではなく CCPIT が定めた名前。
 */
export const PXPIPE_JA_OVERLAY_MARKER = '__PXPIPE_JA_DICT'
/**
 * serve-ja が注入する `<script>` 要素の書き出し。両版とも `<script>window.__PXPIPE_JA_` で始まる
 * （CCPIT 版は `__PXPIPE_JA_OPTS=`、GemPIT 版は `__PXPIPE_JA_DICT=` が続く）。
 * 変数名だけでなく `<script>` の開きタグまで含めて照合するのは、dashboard が表示データ
 * （要求の本文など）にこの変数名を含んでも誤判定しないため。表示データは HTML エスケープされ、
 * 生の `<script>` 開きタグにはならない。
 */
const PXPIPE_JA_INJECTION_SIGNATURE = '<script>window.__PXPIPE_JA_'
/** identity probe で読む本文の上限（これを超える本文は読まずに「本体でない」とする）。
 *  pxpipe の dashboard は 150KB 前後（2026-10-05 実測）。保持するのは最大でこの量＋連結時の写し 1 回分。 */
const HEALTH_BODY_LIMIT_BYTES = 1_048_576

/**
 * dashboard(/) の本文が **pxpipe proxy 本体**のものとして受け入れてよいか（純関数）。
 *
 * `pxpipe` 署名があり、かつ serve-ja の注入が無いこと。serve-ja は dashboard の表示中継で
 * proxy ではない（GemPIT 版は GET/HEAD 以外を 405 で拒否するため、CC の POST /v1/messages は
 * 全て失敗する）。ところが中継は上流のページをそのまま流すので `pxpipe` 署名だけでは区別できず、
 * 2026-10-05 に GemPIT の serve-ja（47831）を本体と誤認して reuse し、PXP 経由の起動が全滅した。
 *
 * **これは認証ではない**。既知の serve-ja（CCPIT 版・GemPIT 版）を除外する互換の規則であり、
 * 注入をしない透過中継や、pxpipe を装う別サービスは HTTP 応答だけからは区別できない。
 */
export function isPxpipeProxyBody(body: string): boolean {
  return /pxpipe/i.test(body) && !body.includes(PXPIPE_JA_INJECTION_SIGNATURE)
}

/**
 * proxy dashboard(/) へ GET し、pxpipe 本体として受け入れてよいかを返す（判定は `isPxpipeProxyBody`）。
 * 単なる「ポートで何かが応答した」では reuse しない。ただし上のとおり認証ではなく、
 * 偶発的な取り違え（無関係なサービス・既知の serve-ja）を防ぐ最善努力の判定である。
 * serve-ja の注入は `</body>` 直前に入るため、署名を見つけても途中で打ち切らず最後まで読む。
 * `timeoutMs` は全体の期限（`req.setTimeout` は無通信時間しか測らず、少しずつ送り続ける相手で
 * 探索が止まるため、別にタイマーで打ち切る）。
 */
export function healthCheck(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let req: ReturnType<typeof httpGet> | null = null
    const deadline = setTimeout(() => {
      req?.destroy()
      done(false)
    }, timeoutMs)
    const done = (v: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      resolve(v)
    }
    req = httpGet(`${pxpipeUrl(port)}/`, (res) => {
      // dashboard の HTML 以外（エラー頁・text/plain 等）は本文に pxpipe があっても受け入れない。
      const mediaType = (res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
      if (res.statusCode !== 200 || mediaType !== 'text/html') {
        done(false)
        res.destroy()
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer) => {
        if (size + chunk.length > HEALTH_BODY_LIMIT_BYTES) {
          done(false) // 上限超過は判定不能→保守側（本体と認めない）。超過分は保持しない
          res.destroy()
          return
        }
        chunks.push(chunk)
        size += chunk.length
      })
      res.on('end', () => done(isPxpipeProxyBody(Buffer.concat(chunks).toString('utf8'))))
      res.on('error', () => done(false))
    })
    req.on('error', () => done(false))
  })
}

async function waitHealthy(port: number, totalMs: number, intervalMs = 700): Promise<boolean> {
  const deadline = Date.now() + totalMs
  // 初回 npx は package download を伴うため余裕を持って polling する。
  while (Date.now() < deadline) {
    if (await healthCheck(port, 1200)) return true
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return healthCheck(port, 1200)
}

/**
 * TCP 接続 probe。connect 成功 = 何かが listen 中（healthCheck 済みなら非 pxpipe の squatter）。
 * error（ECONNREFUSED 等）= 空きポート。timeout = 応答しない listen とみなし squatter 扱い
 * （空きと誤判定して spawn すると 45 秒の health 待ちを空費するため保守側に倒す）。
 */
export function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const socket = netConnect({ host: PXPIPE_HOST, port })
    const done = (v: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(v)
    }
    socket.setTimeout(TCP_PROBE_TIMEOUT_MS)
    socket.on('connect', () => done(true))
    socket.on('timeout', () => done(true))
    socket.on('error', () => done(false))
  })
}

export interface PortProbes {
  /** identity gate 込みの pxpipe 健全性判定（healthCheck 相当）。 */
  isPxpipe(port: number): Promise<boolean>
  /** TCP listen 判定（isPortListening 相当）。 */
  isListening(port: number): Promise<boolean>
}

export type PortSelection =
  | { action: 'reuse'; port: number }
  | { action: 'spawn'; port: number }
  | { action: 'all-squatted' }

/**
 * 候補ポート歩行の判定核（probe 注入の純関数＝socket/npx なしでテスト可能）。
 * - Phase 0: **全候補**を順に走査し、既存の健全 pxpipe があれば reuse。先頭だけ見て spawn すると
 *   過去のフェイルオーバーで後方ポートに居る proxy を見逃し二重起動（orphan）になる。
 * - Phase 1: squatter（listen 中だが非 pxpipe）はスキップし、最初の空きポートを spawn 先に選ぶ。
 *   空きポートでの spawn 後 health 失敗はポート非依存（npx 不在等）のため次候補へカスケード
 *   しない（呼び出し側で fail-closed。claude-px.ps1 と同意味論）。
 */
export async function selectPort(
  candidates: readonly number[],
  probes: PortProbes
): Promise<PortSelection> {
  for (const port of candidates) {
    if (await probes.isPxpipe(port)) return { action: 'reuse', port }
  }
  for (const port of candidates) {
    if (!(await probes.isListening(port))) return { action: 'spawn', port }
  }
  return { action: 'all-squatted' }
}

/**
 * proxy spawn 時の env を組む純関数（`selectPort` と同流儀＝spawn / npx なしでテスト可能）。
 *
 * 優先順は「継承 env（抑制キーを除く） < config 由来の proxyEnv < PORT」。
 * PORT を最後に置くのは probe 済みポートへ決定論 bind させるため（外部 env の残留値に
 * 上書きされると health が偽 fail して fail-closed degrade になる）。
 * `PATH` 等 npx の動作に要る継承分は落とさん（抑制は `SUPPRESSED_INHERITED_ENV` のみ）。
 */
export function buildProxyEnv(
  parentEnv: NodeJS.ProcessEnv,
  proxyEnv: Record<string, string> | undefined,
  port: number
): NodeJS.ProcessEnv {
  const suppressed = new Set(SUPPRESSED_INHERITED_ENV.map((k) => k.toLowerCase()))
  const inherited: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(parentEnv)) {
    if (!suppressed.has(key.toLowerCase())) inherited[key] = value
  }
  const cleanProxyEnv: Record<string, string> = {}
  if (proxyEnv) {
    for (const [key, value] of Object.entries(proxyEnv)) {
      if (!suppressed.has(key.toLowerCase())) cleanProxyEnv[key] = value
    }
  }
  const out = { ...inherited, ...cleanProxyEnv, PORT: String(port) }
  for (const key of Object.keys(out)) {
    if (suppressed.has(key.toLowerCase())) {
      delete out[key]
    }
  }
  return out
}

/** プロセスツリーを kill（marshalLauncher と同流儀。win32=taskkill /T、POSIX=グループ SIGKILL）。 */
function killTree(child: ChildProcess): Promise<void> {
  const pid = child.pid
  if (pid == null) return Promise.resolve()
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      try {
        const tk = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
        tk.on('close', () => resolve())
        tk.on('error', () => {
          try {
            child.kill('SIGKILL')
          } catch {
            /* gone */
          }
          resolve()
        })
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          /* gone */
        }
        resolve()
      }
    })
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      /* gone */
    }
  }
  return Promise.resolve()
}

export interface EnsureProxyResult {
  ok: boolean
  reused: boolean
  url: string
  reason?: string
}

// ensureProxy の in-flight 直列化用（並行 cc:launch による二重 spawn・所有権競合を防ぐ）。
let pendingEnsure: Promise<EnsureProxyResult> | null = null
let adoptedLease: OwnershipLease | null = null

/**
 * 起動時に前回の proxy-owner.json を検証し、一致すれば所有権を adopt（引き継ぎ）する (F1)。
 */
export async function adoptExistingProxy(opts?: {
  proxyEnv?: Record<string, string>
  isProcessAlive?: (pid: number) => Promise<boolean>
  isPxpipeHealth?: (port: number) => Promise<boolean>
  ctx?: OwnershipContext
}): Promise<OwnershipLease | null> {
  const adopted = await validateAndAdoptLease({
    ctx: opts?.ctx,
    expectedFingerprint: opts?.proxyEnv ? buildProxyConfigFingerprint(opts.proxyEnv) : undefined,
    isProcessAlive: opts?.isProcessAlive,
    isPxpipeHealth: opts?.isPxpipeHealth ?? ((p) => healthCheck(p, 1200))
  })
  if (adopted) {
    adoptedLease = adopted
  }
  return adopted
}

/**
 * 現在保持している OwnershipLease（自走 child または adopted）を返す。
 * 自走 child を優先する: adopt した proxy が死んで別ポートへ起動し直した場合、health 待ちの間も
 * adoptedLease が残る（成功時に消える）ため、先に見ると死んだ側のポートを返してしまう。
 */
export function getActiveProxyLease(): OwnershipLease | null {
  if (!ownedChild || ownedChild.pid == null) return adoptedLease
  if (ownedLease && ownedLease.pid === ownedChild.pid) return ownedLease
  // 起動直後で health 待ちの間だけここへ来る。ポートは実際に起動したもの（第 1 候補とは限らない）。
  const port = ownedPort ?? PXPIPE_PORT_CANDIDATES[0]
  return {
    instanceToken: `ccpit-${ownedChild.pid}`,
    pid: ownedChild.pid,
    startTime: new Date().toISOString(),
    port,
    url: pxpipeUrl(port),
    configFingerprint: 'live',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
}

/**
 * proxy が健全なら reuse、なければ npx で起動して health を待つ（初回 npx DL 考慮）。
 * **並行呼び出しは単一の in-flight に直列化**し、OS ファイルロックで複数プロセス間も排他する (F2)。
 * 失敗（npx 不在・別サービス占有・health タイムアウト等）は ok:false + reason を返す
 * （呼び出し側で graceful degrade）。
 */
export function ensureProxy(opts?: {
  proxyEnv?: Record<string, string>
  startTimeoutMs?: number
  /** 診断・統合テスト用の候補ポート注入。本番呼び出しでは指定しない（既定 PXPIPE_PORT_CANDIDATES）。 */
  candidates?: readonly number[]
}): Promise<EnsureProxyResult> {
  if (isIsolatedLaunch()) {
    noteBlocked('pxpipeProxy.ensureProxy')
    return Promise.resolve({
      ok: false,
      reused: false,
      url: pxpipeUrl(opts?.candidates?.[0] ?? PXPIPE_PORT_CANDIDATES[0]),
      reason: ISOLATION_BLOCK_REASON
    })
  }
  if (pendingEnsure) return pendingEnsure
  pendingEnsure = withProxyLock(() => doEnsureProxy(opts), undefined, 10000).catch((e) => ({
    ok: false as const,
    reused: false,
    url: pxpipeUrl(opts?.candidates?.[0] ?? PXPIPE_PORT_CANDIDATES[0]),
    reason: e instanceof Error ? e.message : String(e)
  }))
  const p = pendingEnsure
  void p.finally(() => {
    if (pendingEnsure === p) pendingEnsure = null
  })
  return p
}

async function doEnsureProxy(opts?: {
  proxyEnv?: Record<string, string>
  startTimeoutMs?: number
  candidates?: readonly number[]
}): Promise<EnsureProxyResult> {
  // 038 Feature C: 候補ポートを歩行。既存の健全 pxpipe（我々起動 or 外部起動・identity gate 済）
  // は reuse、squatter はスキップして最初の空きポートへ spawn する。
  const candidates = opts?.candidates ?? PXPIPE_PORT_CANDIDATES
  const selected = await selectPort(candidates, {
    isPxpipe: (p) => healthCheck(p, 1200),
    isListening: (p) => isPortListening(p)
  })
  if (selected.action === 'reuse') {
    return { ok: true, reused: true, url: pxpipeUrl(selected.port) }
  }
  if (selected.action === 'all-squatted') {
    return {
      ok: false,
      reused: false,
      url: pxpipeUrl(candidates[0]),
      reason: `候補ポート（${candidates.join(', ')}）が全て別サービスに占有されています`
    }
  }
  const port = selected.port

  const npx = resolveNpxBin()
  let child: ChildProcess
  try {
    child = spawn(npx.command, ['-y', PXPIPE_PACKAGE], {
      // env の組み立ては buildProxyEnv（純関数）に集約。PORT を最後に置く理由・抑制キーの
      // 意図はそちらのコメントを参照。
      // pxpipe-proxy@0.8.0 本体が読むのは PORT（src/node.ts: PORT ?? 47821）。PXPIPE_PORT は
      // claude-px.ps1 wrapper 層の変数で、start-pxpipe.ps1:6 が PORT へ翻訳している（統合実測で確認）。
      env: buildProxyEnv(process.env, opts?.proxyEnv, port),
      windowsHide: true,
      stdio: 'ignore',
      shell: npx.useShell,
      // POSIX: 自前プロセスグループにして tree kill 可能に。win32 は taskkill /T を使う。
      detached: process.platform !== 'win32'
    })
  } catch (e) {
    return {
      ok: false,
      reused: false,
      url: pxpipeUrl(port),
      reason: `proxy spawn 失敗: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  let spawnError: string | null = null
  child.on('error', (e) => {
    spawnError = e.message
  })
  // 子が終了したら所有権をクリア（死んだ子を kill 対象に残さない・orphan 誤認防止）。
  child.on('exit', () => {
    if (ownedChild === child) {
      ownedChild = null
      ownedPort = null
      ownedLease = null
      clearOwnershipLease()
    }
  })
  ownedChild = child
  ownedPort = port
  ownedLease = null

  const healthy = await waitHealthy(port, opts?.startTimeoutMs ?? 45000)
  if (spawnError) {
    await stopProxy()
    return {
      ok: false,
      reused: false,
      url: pxpipeUrl(port),
      reason: `proxy 起動失敗（npx 不在の可能性）: ${spawnError}`
    }
  }
  if (!healthy) {
    // 空きポートへの spawn 後の health 失敗はポート非依存要因（npx / proxy 自体の起動不全）の
    // ため次候補へカスケードせず fail-closed で degrade させる（claude-px.ps1 と同意味論）。
    await stopProxy()
    return {
      ok: false,
      reused: false,
      url: pxpipeUrl(port),
      reason: 'proxy 起動後 health-check タイムアウト'
    }
  }

  // health が通った直後に子が終了していたら、exit ハンドラが消した所有権を書き戻さない。
  if (ownedChild !== child || child.exitCode !== null) {
    return {
      ok: false,
      reused: false,
      url: pxpipeUrl(port),
      reason: 'proxy が起動直後に終了しました'
    }
  }

  // 起動成功時、Ownership Lease を記録 (F1)
  if (child.pid != null) {
    const lease: OwnershipLease = {
      instanceToken: `ccpit-${Date.now()}-${child.pid}`,
      pid: child.pid,
      startTime: new Date().toISOString(),
      port,
      url: pxpipeUrl(port),
      configFingerprint: buildProxyConfigFingerprint(opts?.proxyEnv),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    writeOwnershipLease(lease)
    ownedLease = lease
    adoptedLease = null // 自身の子が立ち上がったので adoptedLease は不要
  }

  return { ok: true, reused: false, url: pxpipeUrl(port) }
}

/** 我々が起動・adopt した proxy を停止（外部起動 proxy は対象外）。app 終了時（before-quit）に呼ぶ。 */
export async function stopProxy(): Promise<void> {
  const child = ownedChild
  const adopted = adoptedLease
  ownedChild = null
  ownedPort = null
  ownedLease = null
  adoptedLease = null
  clearOwnershipLease()
  if (child) await killTree(child)
  if (adopted && (!child || adopted.pid !== child.pid)) {
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/pid', String(adopted.pid), '/T', '/F'], { windowsHide: true })
      } catch {
        /* gone */
      }
    } else {
      try {
        process.kill(adopted.pid, 'SIGKILL')
      } catch {
        /* gone */
      }
    }
  }
}

/** 診断用: 我々が proxy を起動・保持（または adopt）しているか。 */
export function isProxyOwned(): boolean {
  return ownedChild != null || adoptedLease != null
}
