import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { getConfig } from './appConfig'
import { healthCheck as pxpipeHealthCheck } from './pxpipeProxy'
import {
  DEFAULT_JA_PORT,
  DEFAULT_UPSTREAM_PORT,
  START_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
  BUNDLED_DASHBOARD_JA_DIR,
  BUNDLED_SERVE_JA_FILENAME,
  jaDashboardUrl,
  probeJaDashboard,
  probeJaDashboardDetailed,
  pickJaScriptPath,
  shouldAutoStartJa,
  isDictStale,
  waitJaHealthy,
  buildAllowedEmbedOrigins,
  isAllowedEmbedUrl,
  isSameOriginNavigation,
  coerceEmbeddablePort,
  type JaDashboardState
} from './pxpipeJaProbe'

/**
 * pxpipe 日本語ダッシュボード（serve-ja）の常駐管理。
 *
 * serve-ja は上流 pxpipe（既定 47821）を別ポート（既定 47822）へ全メソッド透過プロキシし、
 * フルページ HTML にだけ日本語 overlay を注入する**別プロセス**。pxpipe 本体は無改変。
 *
 * 本モジュールが解く問題:
 *   起動導線がどこにも無く、PC 再起動のたびに日本語ダッシュボードが死ぬ。
 *   proxy 起動フローへ liveness check-then-start を掛けて自動復帰させる。
 *
 * 設計上の約束（設計レビュー findings 由来。緩めるな）:
 *   - **fail-open**: ここでの失敗が CC 起動や proxy 起動をブロックしてはならない。
 *     呼び出し側は `void ensureJaDashboard().catch(...)` で fire-and-forget する。
 *   - **hung 禁止**: probe も起動待ちも必ず有限時間で諦める。hang は clean failure より悪い。
 *   - **identity gate**: ポートが LISTEN しているだけで alive としない（判定核は pxpipeJaProbe）。
 *   - **冪等性は二段**: (1) プロセス内は in-flight 直列化。(2) プロセス間は serve-ja 自身の
 *     EADDRINUSE 即死（bind が排他制御）に乗り、spawn 後の失敗時に identity を取り直して
 *     「他が先に上げていた」なら成功として扱う。OS ロックファイルは使わない
 *     （stale lock 回収という新しい故障モードを持ち込まないため）。
 */

export {
  DEFAULT_JA_PORT,
  DEFAULT_UPSTREAM_PORT,
  jaDashboardUrl,
  probeJaDashboard,
  JA_OVERLAY_MARKER
} from './pxpipeJaProbe'

export type { JaDashboardState } from './pxpipeJaProbe'

export interface JaDashboardStatus {
  state: JaDashboardState
  port: number
  upstreamPort: number
  url: string
  /** CCPIT がこのプロセスを起動し保持しているか（非所有＝孤児の可能性を UI へ伝える）。 */
  owned: boolean
  /** 使っている実体の出どころ（診断表示用）。実体が無い場合は undefined。 */
  scriptSource?: 'manual' | 'bundled'
  /** 配信中の辞書が対象と宣言している上流版（読めた場合のみ）。 */
  dictTarget?: string
  /** 診断表示用の理由。 */
  reason?: string
}

export interface JaDashboardConfig {
  scriptPath: string
  /** 実体の出どころ。`manual`＝ユーザーが明示登録／`bundled`＝配布同梱。 */
  scriptSource: 'manual' | 'bundled'
  port: number
  upstreamPort: number
  /** 設定ポートが埋め込み可能範囲外で既定へ丸められたか（UI の診断表示用）。 */
  portFellBack: boolean
  /** 円併記（外部為替 API への接続）を有効にするか。**既定 false**＝配布状態では通信しない。 */
  yenRate: boolean
}

let ownedChild: ChildProcess | null = null

/**
 * 同梱した serve-ja 一式の置き場。
 * `golden.ts` / `health.ts` / `ipc.ts` と同じ packaged/dev 解決イディオム。
 *
 * `golden/` には置いていない。golden は `deploy()` が `~/.claude/` へ配る正本であり、
 * 「配らないペイロード」を混ぜると *deploy が 3 ルートしか走査しない* という否定的性質への
 * 依存になるため（一括配備の改修が入れば全ユーザーへ撒かれる）。
 * `extraResources` で asar の外へ出しているので、実ファイルパスとして spawn できる。
 */
function bundledDashboardJaDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, BUNDLED_DASHBOARD_JA_DIR)
    : join(__dirname, '../../resources', BUNDLED_DASHBOARD_JA_DIR)
}

/** 同梱 serve-ja の実体パス（存在するとは限らない）。 */
export function bundledServeJaPath(): string {
  return join(bundledDashboardJaDir(), BUNDLED_SERVE_JA_FILENAME)
}

/** ポートだけを解決する（実体が無い＝disabled のときも設定値を尊重するため分離）。 */
function resolvePorts(): { port: number; upstreamPort: number; portFellBack: boolean } {
  const ja = getConfig().pxpipe?.jaDashboard
  // CSP frame-src は静的なため、埋め込めないポートを受け付けると「main は ok と言うのに
  // iframe が真っ白」になる（実装レビュー #4）。受理した値が必ず表示できるよう範囲へ丸める。
  const { port, fellBack } = coerceEmbeddablePort(ja?.port)
  return { port, upstreamPort: ja?.upstreamPort ?? DEFAULT_UPSTREAM_PORT, portFellBack: fellBack }
}

/**
 * 設定を解決する。実体を解決できなければ null＝機能無効（no-op）。
 *
 * 優先順位は **手動設定 > 同梱**（判定核は `pickJaScriptPath`）。
 * 手動設定は「ユーザーの明示的な意思表示」なので同梱に横取りさせない＝既存ユーザーの挙動は不変。
 * 同梱により「未設定」という状態は消えたので、null＝**実体が無い**（同梱物の破損・欠落）を意味する。
 *
 * **locale はここで見ない。** 本関数は `allowedEmbedOrigins()` からも呼ばれており、
 * locale で null にすると CSP／ナビ許可オリジンが既定ポートへ落ちて、
 * カスタムポート利用者が日本語へ戻した直後に iframe が無言で真っ白になる。
 * 自動起動の可否は `shouldAutoStartJaDashboard()` が別に判定する。
 */
export function resolveJaDashboardConfig(): JaDashboardConfig | null {
  const ja = getConfig().pxpipe?.jaDashboard
  const bundled = bundledServeJaPath()
  const picked = pickJaScriptPath(ja?.scriptPath, { path: bundled, exists: existsSync(bundled) })
  if (!picked) return null
  return {
    scriptPath: picked.path,
    scriptSource: picked.source,
    // 明示的に true のときだけ有効。未設定・null・文字列など不正値は全て無効へ倒す
    // （配布物が黙って外部へ通信しないことを型の緩さに依存させない）。
    yenRate: ja?.yenRate === true,
    ...resolvePorts()
  }
}

/**
 * 自動起動してよいか（**明示操作は対象外**）。判定核は `shouldAutoStartJa`（純関数）。
 *
 * 要求は「アプリの言語が日本語のとき、PXP 起動に合わせて自動で立ち上がること」。
 * 英語ユーザーに不要なプロセスを増やさないための門であって、機能そのものの無効化ではない。
 * よってユーザーが自分で押す Start ボタンはこの門を通さない。
 *
 * **手動登録済みのユーザーは言語に関わらず従来どおり**起動する。同梱前は起動フローが
 * 無条件に ensure していたため、言語だけで絞ると既存ユーザーの挙動を壊す（実装レビュー #1）。
 *
 * 真実源は **main の app-config**（renderer の i18n ではない）。プロセスを増やす判断が
 * 二重管理の食い違いで揺れないようにする。
 */
export function shouldAutoStartJaDashboard(): boolean {
  const cfg = getConfig()
  return shouldAutoStartJa(cfg.pxpipe?.jaDashboard?.scriptPath, cfg.language)
}

/** 現在の状態を返す（副作用なし・UI の状態取得用）。 */
export async function getJaDashboardStatus(): Promise<JaDashboardStatus> {
  const cfg = resolveJaDashboardConfig()
  if (!cfg) {
    // 実体が無い。ポートは設定値を尊重する（既定へ潰すと診断表示が実際の設定と食い違う）。
    const ports = resolvePorts()
    return {
      state: 'disabled',
      port: ports.port,
      upstreamPort: ports.upstreamPort,
      url: jaDashboardUrl(ports.port),
      owned: false,
      reason: `日本語ダッシュボードの実体が見つかりません（同梱: ${bundledServeJaPath()}）`
    }
  }
  // 版まで見る（辞書が現行 pin から取り残されていないか）。ここは常時ポーリングされる経路では
  // ないため全文読みで問題ない（起動待ちの高頻度ポーリングは軽量版 probe のまま）。
  const probed = await probeJaDashboardDetailed(cfg.port)
  const stale = probed.result === 'ok' && isDictStale(probed.dictTarget)
  const state: JaDashboardState = stale ? 'stale' : probed.result
  return {
    state,
    port: cfg.port,
    upstreamPort: cfg.upstreamPort,
    url: jaDashboardUrl(cfg.port),
    owned: isChildAlive(ownedChild),
    scriptSource: cfg.scriptSource,
    dictTarget: probed.dictTarget,
    reason:
      probed.result === 'foreign'
        ? `ポート ${cfg.port} を serve-ja 以外のプロセスが使用しています`
        : stale
          ? `動作中の日本語ダッシュボードは古い辞書（対象: ${probed.dictTarget}）を配信しています`
          : undefined
  }
}

export interface EnsureJaResult {
  ok: boolean
  reused: boolean
  url: string
  reason?: string
}

// in-flight 直列化（同一プロセス内の連打・起動時＋ボタン・多重ウィンドウ対策）。
let pendingEnsure: Promise<EnsureJaResult> | null = null

/**
 * serve-ja が生きていなければ起動する（冪等）。
 * **この関数は投げない**。すべての失敗を `{ ok:false, reason }` で返す（fail-open の担保）。
 */
export function ensureJaDashboard(): Promise<EnsureJaResult> {
  if (pendingEnsure) return pendingEnsure
  pendingEnsure = doEnsure().catch((e) => ({
    // 想定外の例外もここで握り、外へ throw させない。
    ok: false,
    reused: false,
    url: jaDashboardUrl(DEFAULT_JA_PORT),
    reason: e instanceof Error ? e.message : String(e)
  }))
  const p = pendingEnsure
  void p.finally(() => {
    if (pendingEnsure === p) pendingEnsure = null
  })
  return p
}

async function doEnsure(): Promise<EnsureJaResult> {
  const cfg = resolveJaDashboardConfig()
  if (!cfg) {
    // 実体が無い＝この環境では機能を使えない。成功でも失敗でもなく「対象外」。
    // 同梱により「未設定」は消えたので、ここに来るのは同梱物の破損・欠落だけ。
    return {
      ok: false,
      reused: false,
      url: jaDashboardUrl(DEFAULT_JA_PORT),
      reason: `日本語ダッシュボードの実体が見つかりません（同梱: ${bundledServeJaPath()}）`
    }
  }
  const url = jaDashboardUrl(cfg.port)

  const before = await probeJaDashboardDetailed(cfg.port)
  if (before.result === 'ok') {
    if (!isDictStale(before.dictTarget)) return { ok: true, reused: true, url }
    // **版ずれ**。アプリを更新しても旧 serve-ja がポートを掴んだまま生き残り、
    // 消えたパスの旧辞書を配り続けている状態（同梱化が新たに作る故障モード）。
    if (isChildAlive(ownedChild)) {
      // 自分の子なら止めて張り直す（所有物なので無償・安全）。以降の spawn 経路へ落とす。
      await stopJaDashboard()
      await waitPortFree(cfg.port)
    } else {
      // **他プロセスの持ち物は殺さない**（前案件で確立した方針: 共有資産への kill 経路を設けない）。
      // 表示自体は生きている（古い辞書でも日本語は出る＝fail-open）ので、事実だけ伝えて戻る。
      return {
        ok: false,
        reused: true,
        url,
        reason:
          `古い辞書（対象: ${before.dictTarget}）の日本語ダッシュボードがポート ${cfg.port} で` +
          `動作中です。CCPIT の管理外プロセスのため自動では入れ替えません。` +
          `手動で停止すると次回起動時に現行版へ入れ替わります。`
      }
    }
  } else if (before.result === 'foreign') {
    return {
      ok: false,
      reused: false,
      url,
      reason: `ポート ${cfg.port} が別サービスに占有されています`
    }
  }

  if (!existsSync(cfg.scriptPath)) {
    return { ok: false, reused: false, url, reason: `serve-ja が見つかりません: ${cfg.scriptPath}` }
  }

  let child: ChildProcess
  try {
    // PowerShell を経由せず node を直に起動する（.ps1 経由は BOM 由来のパース事故と
    // hook ガードを持ち込む）。Electron 実行体を素の node として使うため
    // ELECTRON_RUN_AS_NODE を立てる。stdio を捨てるのは親の起動パスを塞がないため。
    child = spawn(process.execPath, [cfg.scriptPath], {
      env: {
        ...process.env,
        PXPIPE_JA_PORT: String(cfg.port),
        PXPIPE_UPSTREAM_PORT: String(cfg.upstreamPort),
        // 円併記は外部の為替 API へ接続する。**明示的に有効化された時だけ**渡す
        // （既定 '0' を必ず書くことで、親プロセスに残留した同名 env の影響も断つ）。
        PXPIPE_JA_YEN_RATE: cfg.yenRate ? '1' : '0',
        ELECTRON_RUN_AS_NODE: '1'
      },
      windowsHide: true,
      stdio: 'ignore',
      detached: process.platform !== 'win32'
    })
  } catch (e) {
    return {
      ok: false,
      reused: false,
      url,
      reason: `serve-ja spawn 失敗: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  let spawnError: string | null = null
  child.on('error', (e) => {
    spawnError = e.message
  })
  child.on('exit', () => {
    if (ownedChild === child) ownedChild = null
  })
  ownedChild = child

  if (await waitJaHealthy(cfg.port, START_TIMEOUT_MS)) {
    return { ok: true, reused: false, url }
  }

  // 起動を確認できなかった。まず「他プロセスが先に上げていた」可能性を潰す（プロセス間の冪等性）。
  // serve-ja は EADDRINUSE で即 exit するため、我々の子が死んでいてもポートが
  // serve-ja として応答していれば目的は達成されている。
  if ((await probeJaDashboard(cfg.port)) === 'ok') {
    // ただし「待ちが切れた直後に**自分の子**が healthy になった」場合がある。
    // ここで無条件に停止すると、唯一動いているダッシュボードを殺したうえで
    // 成功を返し、画面だけが死ぬ（実装レビュー round2 #2）。子の生存で分岐する。
    if (isChildAlive(child)) return { ok: true, reused: false, url }
    // 子は既に終了している＝配信しているのは他インスタンス。所有権を手放すだけでよい。
    ownedChild = null
    return { ok: true, reused: true, url }
  }

  // **孤児を作らない**（実装レビュー round1 #2）: health を確認できないまま所有権だけ手放すと、
  // 遅延起動・ハング・マーカー無しの serve-ja が「誰の所有でもないプロセス」として残り、
  // 停止手段が UI から消える。本件が問題視した孤児をこちらが量産することになるため、
  // 所有権を保持したまま確実に停止させてから失敗を返す。
  await stopJaDashboard()

  return {
    ok: false,
    reused: false,
    url,
    reason: spawnError
      ? `serve-ja 起動失敗: ${spawnError}`
      : `serve-ja 起動後 ${START_TIMEOUT_MS}ms 以内に overlay 配信を確認できませんでした`
  }
}

/**
 * CCPIT が起動した serve-ja を停止する。
 * app 終了時には**呼ばない**（ブラウザで開き続ける運用と独立させるため意図的に残す。
 * 代償として孤児化しうるので、UI で状態を可視化し手動停止を提供する）。
 */
export function stopJaDashboard(): Promise<void> {
  const child = ownedChild
  ownedChild = null
  if (!child) return Promise.resolve()
  const pid = child.pid
  if (pid == null) return Promise.resolve()
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      try {
        const tk = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
        tk.on('close', () => resolve())
        tk.on('error', () => resolve())
      } catch {
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

/** 診断用: 我々が serve-ja を起動・保持しているか。 */
export function isJaDashboardOwned(): boolean {
  return isChildAlive(ownedChild)
}

/**
 * 子プロセスが実際に生きているか。
 * `exit` ハンドラでの `ownedChild = null` は非同期に走るため、参照の有無だけでは
 * 「もう死んでいる子」を生存と誤認しうる。終了コード／シグナルを直接見る。
 */
function isChildAlive(child: ChildProcess | null): boolean {
  return child != null && child.exitCode === null && child.signalCode === null
}

/** 停止後にポート解放を待つ上限。 */
const PORT_FREE_TIMEOUT_MS = 2000
/** ポート解放待ちのポーリング間隔。 */
const PORT_FREE_POLL_INTERVAL_MS = 150

/**
 * ポートが解放されるまで待つ（上限つき）。
 *
 * 停止直後に spawn すると、まだ旧プロセスが bind を握っていて EADDRINUSE で即死しうる。
 * **hung 禁止**: 解放を確認できなくても待ち続けず進む（その場合は spawn 側が失敗し、
 * 既存の失敗経路がきちんと理由を返す）。
 */
async function waitPortFree(port: number, totalMs = PORT_FREE_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + totalMs
  while (Date.now() < deadline) {
    if ((await probeJaDashboard(port)) === 'down') return
    await new Promise((r) => setTimeout(r, PORT_FREE_POLL_INTERVAL_MS))
  }
}

/** 上流 pxpipe が生きているか（部分故障の切り分け用。serve-ja 生存でも上流死なら 502）。 */
export function probeUpstream(port: number): Promise<boolean> {
  return pxpipeHealthCheck(port, PROBE_TIMEOUT_MS)
}

/** 埋め込みビューが表示してよいオリジン集合（設定の実ポートを反映する）。 */
export function allowedEmbedOrigins(): string[] {
  return buildAllowedEmbedOrigins(resolveJaDashboardConfig()?.port ?? DEFAULT_JA_PORT)
}

/**
 * 埋め込みコンテンツを「攻撃者影響下のローカル Web コンテンツ」として扱い、
 * ナビゲーションを deny-by-default で封じる。
 *
 * 透過プロキシである serve-ja の内容は上流 pxpipe に由来し、上流の内容は中継された
 * API トラフィックの影響を受ける。したがって「自分で立てた localhost だから安全」とは扱わない。
 *
 * main/index.ts を編集せずここで完結させている（並走する別レーンの大規模改変と衝突させない
 * ための意図的な配置。通常なら window 生成箇所に置く類のコードである）。
 * `registerIpcHandlers()` は BrowserWindow 生成より前に呼ばれるため、購読は間に合う。
 */
export function installEmbedNavigationGuards(): void {
  app.on('browser-window-created', (_e, win) => {
    const wc = win.webContents

    // 以下 3 つは Electron の公式シグネチャ（第 1 引数の details オブジェクト）で受ける。
    // `will-navigate` / `will-redirect` には deprecated な第 2 引数 url もあるが、
    // `will-frame-navigate` には**存在しない**（details のみ）。位置引数に頼ると
    // url が undefined になり、全フレーム遷移を誤ってブロックして
    // ダッシュボード iframe 自体が表示できなくなる（実装レビュー round2 #1 high）。

    // トップフレームの遷移は同一オリジン内に限る（埋め込みからのアプリ乗っ取りを防ぐ）。
    wc.on('will-navigate', (details) => {
      if (!isSameOriginNavigation(wc.getURL(), details.url)) details.preventDefault()
    })

    // リダイレクトによる迂回も塞ぐ。**トップフレームのイベント**なので埋め込み許可オリジンを
    // 通してはならない（round1 #1 high）。ここを通すと preload を持つ特権ウィンドウ自体が
    // 攻撃者影響下の内容をトップページとして読み込め、iframe sandbox の隔離が丸ごと迂回される。
    wc.on('will-redirect', (details) => {
      if (!isSameOriginNavigation(wc.getURL(), details.url)) details.preventDefault()
    })

    // フレーム遷移はメイン/サブで基準を分ける。サブフレーム（＝ダッシュボード iframe）のみ
    // 許可オリジンの完全一致を許す。
    wc.on('will-frame-navigate', (details) => {
      const ok = details.isMainFrame
        ? isSameOriginNavigation(wc.getURL(), details.url)
        : isAllowedEmbedUrl(details.url, allowedEmbedOrigins())
      if (!ok) details.preventDefault()
    })

    // 埋め込み由来のファイル取得を断つ。
    wc.session.on('will-download', (e) => e.preventDefault())

    // 権限要求（通知・位置情報・メディア等）は全拒否。
    wc.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  })
}
