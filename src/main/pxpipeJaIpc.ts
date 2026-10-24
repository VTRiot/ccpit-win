import { ipcMain, dialog } from 'electron'
import { existsSync } from 'fs'
import { getConfig, setConfig } from './services/appConfig'
import {
  ensureJaDashboard,
  getJaDashboardStatus,
  stopJaDashboard,
  probeUpstream,
  installEmbedNavigationGuards,
  isJaDashboardOwned,
  shouldAutoStartJaDashboard
} from './services/pxpipeJaDashboard'
import { resolveViewState, type PxpipeViewState } from './services/pxpipeJaProbe'
import {
  ensureProxy,
  healthCheck,
  pxpipeUrl,
  PXPIPE_PORT_CANDIDATES,
  isProxyOwned
} from './services/pxpipeProxy'
import { getPxpipeProxyEnv } from './services/pxpipeConfigService'
import { ISOLATION_BLOCK_REASON, isIsolatedLaunch, noteBlocked } from './isolation'

/**
 * pxpipe ダッシュボード統合（R1/R2/R3）の IPC 登録。
 *
 * 本来この種の handler は ipc.ts に集約する慣習だが、並走する別レーンが ipc.ts を
 * 大規模改変中のため、衝突面を「import 1 行 + 呼び出し 1 行」に抑える目的で分離している。
 * 慣習からの意図的な逸脱であり、並走が解消したら ipc.ts へ畳んでよい。
 */

export type { PxpipeViewState } from './services/pxpipeJaProbe'

export interface PxpipeViewStatus {
  state: PxpipeViewState
  /** 表示に使う URL（locale 解決後）。 */
  viewUrl: string
  jaUrl: string
  enUrl: string
  jaPort: number
  upstreamPort: number
  /** 上流 proxy が CCPIT の所有下か。false かつ生存なら孤児（UI に情報バッジを出す）。 */
  proxyOwned: boolean
  jaOwned: boolean
  /**
   * 自動起動してよい環境か（アプリ言語が日本語か）。**main の app-config が真実源**。
   * renderer は「プロセスを増やす」判断にこれを使い、自前の i18n 状態では判断しない。
   */
  jaAutoStartEligible: boolean
  /** 使っている実体の出どころ（`bundled`＝配布同梱／`manual`＝ユーザーが明示登録）。 */
  jaScriptSource?: 'manual' | 'bundled'
  /** 配信中の辞書が対象と宣言している上流版（読めた場合のみ）。 */
  jaDictTarget?: string
  reason?: string
}

/** 上流 pxpipe が現在生きているポートを探す（フェイルオーバー済みでも追随する）。 */
export async function findLiveUpstreamPort(): Promise<number | null> {
  for (const port of PXPIPE_PORT_CANDIDATES) {
    if (await healthCheck(port)) return port
  }
  return null
}

/** 現在の統合状態を返す（副作用なし）。locale は renderer 側が持つため URL は両方返す。 */
export async function computePxpipeViewStatus(): Promise<PxpipeViewStatus> {
  const [ja, liveUpstream] = await Promise.all([getJaDashboardStatus(), findLiveUpstreamPort()])
  const upstreamAlive = liveUpstream != null
  const upstreamPort = liveUpstream ?? ja.upstreamPort
  const enUrl = pxpipeUrl(upstreamPort)
  // `stale` は「古い辞書だが日本語は出る」＝表示可能。英語へ落とすと、直せる不具合のために
  // 使える日本語画面を捨てることになるので ja 側を出したままにする（fail-open の一貫）。
  const jaDisplayable = ja.state === 'ok' || ja.state === 'stale'
  return {
    state: resolveViewState(ja.state, upstreamAlive),
    viewUrl: jaDisplayable ? ja.url : enUrl,
    jaUrl: ja.url,
    enUrl,
    jaPort: ja.port,
    upstreamPort,
    proxyOwned: isProxyOwned(),
    jaOwned: isJaDashboardOwned(),
    jaAutoStartEligible: shouldAutoStartJaDashboard(),
    jaScriptSource: ja.scriptSource,
    jaDictTarget: ja.dictTarget,
    reason: ja.reason
  }
}

export function registerPxpipeJaHandlers(): void {
  // 埋め込みビューのナビゲーション封じ込め（deny-by-default）。
  // BrowserWindow 生成より前に登録される必要があるため、IPC 登録と同じタイミングで仕掛ける。
  installEmbedNavigationGuards()

  ipcMain.handle('pxpipeView:status', () => computePxpipeViewStatus())

  /**
   * R3 のボタン。状態に応じて proxy と serve-ja を起動する。
   * ここは**ユーザーの明示操作**由来なので await してよい（起動パスではない）。
   */
  ipcMain.handle('pxpipeView:start', async () => {
    if (isIsolatedLaunch()) {
      noteBlocked('pxpipeView:start')
      return { ok: false, reason: ISOLATION_BLOCK_REASON }
    }
    const before = await computePxpipeViewStatus()
    if (before.state === 'ja-foreign') {
      return { ok: false, reason: before.reason ?? 'ポートが別サービスに占有されています' }
    }
    // 上流が死んでいれば先に確保する（serve-ja 単体で上げても 502 にしかならない）。
    if (before.state === 'proxy-down') {
      const ensured = await ensureProxy({ proxyEnv: getPxpipeProxyEnv() })
      if (!ensured.ok)
        return { ok: false, reason: ensured.reason ?? 'proxy を起動できませんでした' }
    }
    const ja = await ensureJaDashboard()
    // 「画面が出せたか」で成否を決める。
    // - `ja-disabled`（実体が無い）でも上流が生きていれば英語版は表示できる＝失敗にしない
    // - `ja-stale`（古い辞書だが日本語は出る）も表示できているので失敗にしない。
    //   古さ自体は status.reason を常設の情報バーで見せる（赤帯で操作を否定しない）
    const after = await computePxpipeViewStatus()
    const displayed =
      after.state === 'ok' || after.state === 'ja-disabled' || after.state === 'ja-stale'
    return {
      ok: displayed,
      reason: displayed ? undefined : ja.reason,
      status: after
    }
  })

  /**
   * 孤児 proxy の手動停止は**提供しない**（設計判断）。
   * 停止対象が他セッションの共有資産でありうるため、CCPIT からの kill 経路は設けず、
   * UI では PID などの情報提示に留める。ここに handler を足す場合は、
   * 影響範囲の提示と確認を UI 側で必須にすること。
   */

  /** CCPIT が起動した serve-ja のみを停止する（外部起動・孤児は対象外）。 */
  ipcMain.handle('pxpipeView:stopJa', async () => {
    if (!isJaDashboardOwned()) {
      return { ok: false, reason: 'CCPIT が起動した日本語ダッシュボードではないため停止しません' }
    }
    await stopJaDashboard()
    return { ok: true, status: await computePxpipeViewStatus() }
  })

  /** 上流の生存だけを個別に確認する（部分故障の切り分け用）。 */
  ipcMain.handle('pxpipeView:probeUpstream', (_e, port: number) => probeUpstream(port))

  /**
   * 日本語ダッシュボードの実体（serve-ja.mjs）をファイル選択で登録する。
   *
   * serve-ja は本リポの管理外にある個人環境固有物なので、パスをソースへ焼き込めない。
   * かといって設定ファイルの手編集を強いるのは手数が多く、実機 FB でも
   * 「設定しないと英語のまま」であることが画面から読み取れず詰まった。
   * よって**選ぶだけ**で登録できる経路を UI に用意する。
   */
  ipcMain.handle('pxpipeView:pickJaScript', async () => {
    const picked = await dialog.showOpenDialog({
      title: '日本語ダッシュボードの serve-ja.mjs を選択',
      properties: ['openFile'],
      filters: [{ name: 'serve-ja', extensions: ['mjs', 'js', 'cjs'] }]
    })
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true }

    const scriptPath = picked.filePaths[0]
    if (!existsSync(scriptPath)) {
      return { ok: false, canceled: false, reason: 'ファイルが見つかりません: ' + scriptPath }
    }

    // 既存の pxpipe 設定（models / fableModel）を壊さないよう、深マージで jaDashboard だけ足す。
    const prev = getConfig().pxpipe
    setConfig({ pxpipe: { ...prev, jaDashboard: { ...prev?.jaDashboard, scriptPath } } })
    return { ok: true, canceled: false, status: await computePxpipeViewStatus() }
  })
}
