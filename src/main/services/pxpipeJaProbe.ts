import { get as httpGet } from 'http'
import {
  pxpipeUrl,
  PXPIPE_PORT_CANDIDATES,
  PXPIPE_PACKAGE,
  PXPIPE_JA_OVERLAY_MARKER
} from './pxpipeProxy'

/**
 * pxpipe 日本語ダッシュボード（serve-ja）の**判定核**。
 *
 * electron / appConfig に依存しない純粋部分だけをここへ置き、単体テスト可能にしている
 * （ipc.ts のコメントにある既存作法と同じ: Electron 依存の import グラフは単体テストに向かない）。
 * プロセス起動・設定解決・ナビゲーション封じ込めは pxpipeJaDashboard.ts が持つ。
 */

/** 既定の待受ポート。serve-ja.mjs の `PXPIPE_JA_PORT` 既定と一致させる。 */
export const DEFAULT_JA_PORT = 47822
/** 既定の上流ポート。pxpipe 候補ポートの先頭から導出する（同じ番号を二重に持たない）。 */
export const DEFAULT_UPSTREAM_PORT = PXPIPE_PORT_CANDIDATES[0]
/**
 * serve-ja が全ページへ注入する固有マーカー（serve-ja.mjs の INJECT が定義）。identity gate の根拠。
 * 正本は pxpipeProxy 側（proxy の identity gate が「中継ではない」ことの判定にも使うため）。
 */
export const JA_OVERLAY_MARKER = PXPIPE_JA_OVERLAY_MARKER
/** HTTP probe の上限。loopback ゆえ短くてよいが、0 にはしない（hung 禁止）。 */
export const PROBE_TIMEOUT_MS = 1500
/** 起動後に overlay 配信が始まるまで待つ上限。node の listen のみで npx DL を伴わないため
 *  proxy 側（45 秒）より大幅に短い。ここが長いと fail-open の意味が薄れる。 */
export const START_TIMEOUT_MS = 8000
/** 起動待ちのポーリング間隔。 */
export const START_POLL_INTERVAL_MS = 300
/** probe 時に読み込む本文の上限（巨大応答でメモリを食わないための保険）。 */
const PROBE_BODY_LIMIT_BYTES = 1_048_576

/** 同梱 serve-ja 一式を置くディレクトリ名（extraResources の `to` と一致させる）。 */
export const BUNDLED_DASHBOARD_JA_DIR = 'dashboard-ja'
/** 同梱 serve-ja の実体ファイル名。 */
export const BUNDLED_SERVE_JA_FILENAME = 'serve-ja.mjs'

export type JaProbeResult =
  /** serve-ja が overlay を配信している。 */
  | 'ok'
  /** 何かが待ち受けているが serve-ja ではない（応答しない listen を含む）。**触らない**。 */
  | 'foreign'
  /** 到達不能＝空きポート。 */
  | 'down'

/** `http://127.0.0.1:<port>`。localhost 表記は使わない（IPv4/IPv6 の解決差で穴が開くため）。 */
export function jaDashboardUrl(port: number): string {
  return pxpipeUrl(port)
}

/**
 * 指定ポートが serve-ja かどうかを判定する（identity gate）。
 *
 * 応答本文に overlay マーカーが含まれることまで確認し、単に「何かが応答した」では真としない。
 * timeout は `foreign` に倒す: 空きと誤判定して spawn すると EADDRINUSE で無駄に死ぬため、
 * 保守側（触らない側）へ寄せる。
 */
export function probeJaDashboard(
  port: number,
  timeoutMs: number = PROBE_TIMEOUT_MS
): Promise<JaProbeResult> {
  return new Promise((resolve) => {
    let settled = false
    const done = (v: JaProbeResult): void => {
      if (settled) return
      settled = true
      resolve(v)
    }
    const req = httpGet(`${jaDashboardUrl(port)}/`, (res) => {
      let body = ''
      res.on('data', (chunk: Buffer) => {
        // マーカーは </body> 直前に注入されるため全文を読む必要がある。
        if (body.length < PROBE_BODY_LIMIT_BYTES) body += chunk.toString('utf8')
        if (body.includes(JA_OVERLAY_MARKER)) {
          done('ok')
          res.destroy()
        }
      })
      res.on('end', () => done(body.includes(JA_OVERLAY_MARKER) ? 'ok' : 'foreign'))
      res.on('error', () => done('down'))
    })
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      done('foreign')
    })
    req.on('error', () => done('down'))
  })
}

/**
 * serve-ja の実体パスを決める（**純関数**）。手動設定 > 同梱 の優先順位。
 *
 * - 手動設定は「ユーザーの明示的な意思表示」なので最優先。空文字・空白のみは**未設定として扱う**
 *   （`??` では空文字が通ってしまい、既存の空設定が同梱へフォールバックしない）。
 * - 手動設定が指すファイルの存在はここで検査しない。従来どおり ensure 側が
 *   「serve-ja が見つかりません: <path>」と**そのパスを名指しして**失敗させる（既存挙動の温存）。
 * - どちらも解決できないときだけ null＝機能無効。同梱後の `disabled` は
 *   「未設定」ではなく「**実体が無い**（同梱物の破損・欠落）」を意味する。
 */
export function pickJaScriptPath(
  manualRaw: string | undefined,
  bundled: { path: string; exists: boolean }
): { path: string; source: 'manual' | 'bundled' } | null {
  const manual = manualRaw?.trim()
  if (manual) return { path: manual, source: 'manual' }
  if (bundled.exists) return { path: bundled.path, source: 'bundled' }
  return null
}

/**
 * 自動起動してよいか（**純関数**・明示操作は対象外）。
 *
 * - **手動登録済みなら言語に関わらず起動する**。同梱前は起動フローが無条件に ensure していたので、
 *   言語 gate を無差別に掛けると「英語 UI で使っていた手動設定ユーザー」から自動起動を奪う
 *   （Codex 実装レビュー #1）。明示登録はユーザーの意思表示であって、言語設定で否定しない。
 * - 手動登録が無い場合＝同梱既定を使う場合だけ言語で絞る。同梱は暗黙の便宜なので、
 *   英語ユーザーに不要なプロセスを増やさない。
 */
export function shouldAutoStartJa(manualScriptPath: string | undefined, language: string): boolean {
  if (manualScriptPath?.trim()) return true
  return language === 'ja'
}

/**
 * 応答本文から辞書の対象上流版（`_meta.target`）を取り出す（**純関数**）。
 *
 * serve-ja は `window.__PXPIPE_JA_DICT=` の直後へ辞書 JSON を逐語で埋め込み、辞書の第 1 キーは
 * `_meta` なので、マーカー以降の最初の `"target"` が目的の値になる。
 * **読み取れなければ undefined を返す**（呼び出し側はこれを stale と解釈してはならない）。
 */
export function extractDictTarget(body: string): string | undefined {
  const at = body.indexOf(JA_OVERLAY_MARKER)
  if (at < 0) return undefined
  const m = /"target"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body.slice(at))
  return m ? m[1] : undefined
}

/**
 * 辞書が現行の上流 pin から取り残されているか（**純関数**）。
 *
 * **曖昧なら stale と断じない**（fail-safe）。target を読めなかった場合＝部分読み・切断・
 * 想定外の書式のいずれかであり、そこで stale を主張すると健全な serve-ja に誤って
 * 警告を出す。「分からない」は「古い」ではない。
 */
export function isDictStale(dictTarget: string | undefined): boolean {
  if (!dictTarget) return false
  return !dictTarget.includes(PXPIPE_PACKAGE)
}

/** identity gate に加えて辞書の対象版まで読む詳細 probe の結果。 */
export interface JaDetailedProbe {
  result: JaProbeResult
  /** 辞書の `_meta.target`。読めなかった場合は undefined（stale 判定に使ってはならない）。 */
  dictTarget?: string
}

/**
 * `probeJaDashboard` の詳細版。マーカーに加えて辞書の対象版まで読む。
 *
 * 軽量版はマーカーを見つけた時点で `res.destroy()` するため、直後にある `_meta.target` が
 * チャンク境界で切れて読めないことがある。版まで見たい場合はこちらを使う
 * （**版判定が要る経路だけ**。起動待ちのポーリングは軽量版のままにする）。
 *
 * - 本文は `end` まで読む（上限は軽量版と同じ）。チャンクは Buffer のまま貯めて最後に
 *   まとめて decode する（チャンク境界でマルチバイト文字が割れるのを避ける）
 * - `accept-encoding: identity` を明示する。serve-ja は上流へ identity を強制しており実測では
 *   非圧縮だが、圧縮された本文を掴んで「読めない＝不明」に倒れるのを未然に防ぐ
 * - 途中切断はマーカーの有無だけで判定し、target は undefined のままにする（＝stale と断じない）
 */
export function probeJaDashboardDetailed(
  port: number,
  timeoutMs: number = PROBE_TIMEOUT_MS
): Promise<JaDetailedProbe> {
  return new Promise((resolve) => {
    let settled = false
    const done = (v: JaDetailedProbe): void => {
      if (settled) return
      settled = true
      resolve(v)
    }
    const chunks: Buffer[] = []
    let size = 0
    const decode = (): string => Buffer.concat(chunks).toString('utf8')
    /** 途中終了時の判定: マーカーがあれば ok。target は読めた分だけ（読めなければ undefined）。 */
    const settleFromBody = (fallback: JaProbeResult): void => {
      const body = decode()
      if (body.includes(JA_OVERLAY_MARKER)) {
        done({ result: 'ok', dictTarget: extractDictTarget(body) })
        return
      }
      done({ result: fallback })
    }
    const req = httpGet(
      `${jaDashboardUrl(port)}/`,
      { headers: { 'accept-encoding': 'identity' } },
      (res) => {
        res.on('data', (chunk: Buffer) => {
          if (size >= PROBE_BODY_LIMIT_BYTES) return
          chunks.push(chunk)
          size += chunk.length
        })
        res.on('end', () => settleFromBody('foreign'))
        // 途中切断。掴めた分にマーカーがあれば ok 扱い（target は読めていなければ undefined）。
        res.on('error', () => settleFromBody('down'))
      }
    )
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      settleFromBody('foreign')
    })
    req.on('error', () => settleFromBody('down'))
  })
}

/** overlay 配信が始まるまで待つ（上限つき。hung 禁止）。 */
export async function waitJaHealthy(
  port: number,
  totalMs: number = START_TIMEOUT_MS,
  intervalMs: number = START_POLL_INTERVAL_MS
): Promise<boolean> {
  const deadline = Date.now() + totalMs
  while (Date.now() < deadline) {
    if ((await probeJaDashboard(port)) === 'ok') return true
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return (await probeJaDashboard(port)) === 'ok'
}

/**
 * **埋め込み可能ポートの正本**。
 *
 * renderer の CSP `frame-src` は静的テキストで、コードから生成できない。よってここを正本とし、
 * `index.html` 側は同じ集合を列挙する。両者のズレは
 * `__tests__/pxpipeJaDashboard.test.ts` の parity テストが検出する
 * （実装レビュー #4: 設定で別ポートを指定すると main は「使える」と言うのに
 *  CSP が iframe をブロックする、という不整合を構造的に防ぐ）。
 */
export const EMBEDDABLE_PORTS: readonly number[] = [
  DEFAULT_JA_PORT,
  ...PXPIPE_PORT_CANDIDATES
] as const

/**
 * 埋め込みビューが表示してよいオリジン集合を作る。
 * 完全一致比較のためワイルドカードも `localhost` 表記も使わない。
 * 上流はフェイルオーバーしうるので候補ポートを全て含める。
 */
export function buildAllowedEmbedOrigins(jaPort: number): string[] {
  const ports = new Set<number>([jaPort, ...PXPIPE_PORT_CANDIDATES])
  return [...ports].map((p) => jaDashboardUrl(p))
}

/**
 * 設定された ja ポートを**埋め込み可能な範囲へ丸める**。
 *
 * CSP は静的なので、範囲外のポートを設定されると「main は ok を返すのに iframe が
 * 真っ白」という説明不能な状態になる。受け入れた値がそのまま表示できることを保証するため、
 * 範囲外は既定へフォールバックする（黙って壊れるより、既定で動くほうが良い）。
 */
export function coerceEmbeddablePort(configured: number | undefined): {
  port: number
  fellBack: boolean
} {
  if (configured == null) return { port: DEFAULT_JA_PORT, fellBack: false }
  if (EMBEDDABLE_PORTS.includes(configured)) return { port: configured, fellBack: false }
  return { port: DEFAULT_JA_PORT, fellBack: true }
}

/** 埋め込みビューの遷移先として許可されるか（オリジン完全一致）。 */
export function isAllowedEmbedUrl(target: string, allowedOrigins: string[]): boolean {
  try {
    return allowedOrigins.includes(new URL(target).origin)
  } catch {
    return false
  }
}

/** 同一オリジン内の遷移か（アプリ本体の画面遷移・dev サーバの HMR を通すための判定）。 */
export function isSameOriginNavigation(currentUrl: string, targetUrl: string): boolean {
  try {
    if (!currentUrl) return false
    return new URL(currentUrl).origin === new URL(targetUrl).origin
  } catch {
    return false
  }
}

/** UI が分岐する統合状態（R3 の状態モデル）。 */
export type PxpipeViewState =
  /** 上流 proxy が死んでいる。proxy と serve-ja の両方が要る。 */
  | 'proxy-down'
  /** 上流は生きているが日本語ダッシュボードが不在。 */
  | 'ja-down'
  /** 日本語ダッシュボードは生きているが上流が死んでいる（serve-ja は 502 を返す）。 */
  | 'upstream-down'
  /** 日本語ダッシュボードのポートを別プロセスが占有している。触らない。 */
  | 'ja-foreign'
  /** 表示可能。 */
  | 'ok'
  /**
   * 表示はできるが、配信している serve-ja の辞書が現行の上流 pin から取り残されている。
   * **失敗ではない**（日本語は出る。未知の文字列が英語で出るだけ＝fail-open）。
   * アプリ更新後も旧 serve-ja がポートを掴んだままのときに起きる。
   */
  | 'ja-stale'
  /** 日本語ダッシュボードの実体が無い（同梱物の破損・欠落）。英語版のみ表示する。 */
  | 'ja-disabled'

/** UI/診断向けの ja 側状態（probe 結果＋設定不能＋版ずれ）。 */
export type JaDashboardState = JaProbeResult | 'disabled' | 'stale'

/**
 * 上流の生死と serve-ja の状態から UI 状態を決める純関数。
 * 「serve-ja だけ生きていて上流が死んでいる」を `ok` に潰さないことが要点
 * （その状態では画面が 502 になるため、空白でなく状態として見せる必要がある）。
 *
 * `stale` は `ok` の劣化版として扱う（表示はする）。`foreign`（＝別サービスなので触らない）とは
 * 取るべき行動が違うため、同じ状態に潰さない。
 */
export function resolveViewState(
  ja: JaDashboardState,
  upstreamAlive: boolean
): PxpipeViewState {
  if (ja === 'disabled') return upstreamAlive ? 'ja-disabled' : 'proxy-down'
  if (ja === 'foreign') return 'ja-foreign'
  // 上流が死んでいれば serve-ja は 502 しか返せない。版ずれより先にそちらを見せる。
  if (ja === 'stale') return upstreamAlive ? 'ja-stale' : 'upstream-down'
  if (ja === 'ok') return upstreamAlive ? 'ok' : 'upstream-down'
  return upstreamAlive ? 'ja-down' : 'proxy-down'
}
