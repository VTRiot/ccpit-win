import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, ExternalLink, Play, Square, Info, AlertTriangle } from 'lucide-react'
import { Button } from '../components/ui/button'
import { cn } from '../lib/utils'
import type { PxpipeViewStatus, PxpipeScopeStatusDTO, PxpipeVersionStatusDTO } from '../../../preload/index.d'

type LoadState = 'loading' | 'ready' | 'error'

export function PxpipeDashboardPage(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const [status, setStatus] = useState<PxpipeViewStatus | null>(null)
  const [scopeStatus, setScopeStatus] = useState<PxpipeScopeStatusDTO | null>(null)
  const [versionStatus, setVersionStatus] = useState<PxpipeVersionStatusDTO | null>(null)
  const [scopeBusy, setScopeBusy] = useState(false)
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [busy, setBusy] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [scopeError, setScopeError] = useState<string | null>(null)

  // 競合状態対策（設計レビュー #13）: 発行順の番号を持ち、古い応答が新しい状態を
  // 上書きしないようにする。locale の高速トグルや連打で stale が勝つのを防ぐ。
  const reqSeq = useRef(0)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    const seq = ++reqSeq.current
    try {
      const [next, nextScope, nextVer] = await Promise.all([
        window.api.pxpipeViewStatus(),
        window.api.pxpipe.getScopeStatus().catch(() => null),
        window.api.pxpipe.getVersionStatus().catch(() => null)
      ])
      // 自分より新しい要求が既に走っている／アンマウント済みなら破棄する。
      if (!mounted.current || seq !== reqSeq.current) return
      setStatus(next)
      if (nextScope) setScopeStatus(nextScope)
      if (nextVer) setVersionStatus(nextVer)
      setLoadState('ready')
    } catch {
      if (!mounted.current || seq !== reqSeq.current) return
      setLoadState('error')
    }
  }, [])

  const handleToggleModel = async (model: string, on: boolean): Promise<void> => {
    setScopeBusy(true)
    setScopeError(null)
    try {
      const res = await window.api.pxpipe.setScopeModel(model, on)
      if (mounted.current) {
        if (res.status) {
          setScopeStatus(res.status)
        }
        if (!res.ok) {
          setScopeError(
            res.error ||
              '正本 config.json は更新されましたが、稼働中プロキシへの即時反映に失敗しました（再起動が必要です）'
          )
        }
      }
    } catch (e) {
      if (mounted.current) {
        setScopeError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      if (mounted.current) setScopeBusy(false)
    }
  }

  // 言語を切り替えたら状態も取り直す。表示先(ja/en URL)は再レンダーで切り替わるが、
  // 状態依存の導線（未検出ヒント等）が古いまま残るため。
  useEffect(() => {
    void refresh()
  }, [refresh, i18n.language])

  /**
   * 日本語環境なら「タブを開いただけ」でも自動で日本語へ切り替える。
   *
   * serve-ja は配布物へ同梱済みなので実体は常に在る。ここが無いと、CC を起動するまで
   * 英語版のままになり「日本語設定なら自動で日本語になる」という本機能の約束が
   * CC 起動経路だけの話になってしまう。
   *
   * - 判定は **main の app-config**（`jaAutoStartEligible`）に従う。renderer の i18n では
   *   判断しない（プロセスを増やす判断を二重管理の食い違いで揺らさない）
   * - `ja-down` は上流が生きていることを含意するので、ここから pxpipe 本体を起こすことはない
   * - **マウント時ではなく状態遷移で撃つ**。status は非同期取得で初期値 null のため、
   *   マウント時点では `ja-down` かどうか分からない
   * - 同じ状態が続く間は 1 回だけ（失敗しても撃ち続けない＝spawn ループ防止）。
   *   状態が変われば記録を捨て、再び `ja-down` へ戻ったときは撃ち直せる
   */
  const autoStartedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!status || status.state !== 'ja-down' || !status.jaAutoStartEligible) {
      autoStartedFor.current = null
      return
    }
    const key = `${status.state}:${status.jaPort}`
    if (autoStartedFor.current === key) return
    autoStartedFor.current = key
    void (async () => {
      setBusy(true)
      try {
        await window.api.pxpipeViewStart()
        await refresh()
      } catch {
        /* 自動起動は補助。失敗しても英語版は見えたままなので画面を赤くしない */
      } finally {
        if (mounted.current) setBusy(false)
      }
    })()
  }, [status?.state, status?.jaPort, status?.jaAutoStartEligible, refresh])

  const handleStart = async (): Promise<void> => {
    setBusy(true)
    setStartError(null)
    try {
      const res = await window.api.pxpipeViewStart()
      if (!mounted.current) return
      if (!res.ok) setStartError(res.reason ?? t('pages.pxpipeDashboard.error.loadFailed'))
      // 起動直後は状態が変わっているので必ず取り直す（結果に同梱された status も使えるが、
      // 「初回 ok の後に foreign へ変わる」ような遷移も拾えるよう再取得で統一する）。
      await refresh()
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const handleStopJa = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.api.pxpipeViewStopJa()
      await refresh()
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  /**
   * 日本語ダッシュボードの実体（serve-ja.mjs）をファイル選択で登録する。
   * 個人環境固有のパスをソースへ焼き込まないための方式（設定ファイルの手編集も不要にする）。
   */
  const handlePickJaScript = async (): Promise<void> => {
    setBusy(true)
    setStartError(null)
    try {
      const res = await window.api.pxpipeViewPickJaScript()
      if (!mounted.current) return
      if (res.canceled) return
      if (!res.ok) {
        setStartError(res.reason ?? t('pages.pxpipeDashboard.error.loadFailed'))
        return
      }
      // 登録できたらそのまま起動まで進める（ユーザーの手数を 1 回で終わらせる）。
      await window.api.pxpipeViewStart()
      await refresh()
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  if (loadState === 'loading') {
    return <div className="text-sm text-muted-foreground">…</div>
  }
  if (loadState === 'error' || !status) {
    return (
      <StateCard
        tone="error"
        title={t('pages.pxpipeDashboard.error.loadFailed')}
        body=""
        action={
          <Button onClick={() => void refresh()} disabled={busy}>
            <RefreshCw size={14} className="mr-1.5" />
            {t('pages.pxpipeDashboard.refresh')}
          </Button>
        }
      />
    )
  }

  // locale の真実源はアプリの言語設定（新設しない）。ja なら日本語ダッシュボード、
  // それ以外は英語版。日本語版が使えない状態では英語版へフォールバックする。
  const preferJa = i18n.language.startsWith('ja')
  // `ja-stale` は古い辞書だが日本語は出る＝表示可能。直せる不具合のために使える画面を捨てない。
  const canShowJa = status.state === 'ok' || status.state === 'ja-stale'
  const embedUrl = preferJa && canShowJa ? status.jaUrl : status.enUrl

  // 同梱後は `scriptPath` が常に解決するため、日本語ユーザーの既定の初期状態が
  // `ja-disabled`（英語版を埋め込み表示）から `ja-down` へ移る。ここを空状態カードにすると、
  // **同梱前は英語版が見えていたユーザーの体験が悪化する**（＝退行）。
  // 英語版を出したまま、上の自動起動が日本語へ切り替えるのを待たせる。
  const showEmbed =
    status.state === 'ok' ||
    status.state === 'ja-stale' ||
    status.state === 'ja-disabled' ||
    status.state === 'ja-down'

  // 実体が解決できないときだけ、手動指定への導線を出す。
  // 同梱により「未設定」という状態は消えたので、この導線の意味は
  // 「登録してください」から「壊れた同梱からの復旧」へ変わった（IPC は生かしたまま転用）。
  const showJaSetupHint = preferJa && status.state === 'ja-disabled'
  // 古い辞書で配信中。表示は生きているので操作を止めず、事実だけ常設の情報バーで伝える。
  const showStaleNotice = preferJa && status.state === 'ja-stale'
  // 埋め込みは出せているが日本語版が未起動。自動起動が失敗した場合の手動導線をオーバーレイに置く
  // （ヘッダーは復活させない＝実機 FB「情報として冗長」を尊重）。
  const showStartJaAction = preferJa && status.state === 'ja-down'

  return (
    // ヘッダー（タイトル・URL・孤児バー）は撤去した。ナビに名前が出ており、
    // URL と所有情報は常時見せる価値が薄く、その分ダッシュボードの表示領域を食っていたため
    // （実機 FB「情報として冗長、削除して表示領域を拡大」）。
    // 操作ボタンは iframe 右上へオーバーレイし、行を消費しない。
    <div className="relative flex flex-col h-full min-h-0 gap-2">
      <ScopeControlPanel
        status={scopeStatus}
        versionStatus={versionStatus}
        busy={scopeBusy}
        onToggle={(model, on) => void handleToggleModel(model, on)}
      />
      {scopeError && <InfoBar tone="error" text={scopeError} />}
      {showJaSetupHint && (
        <SetupHint
          busy={busy}
          onPick={() => void handlePickJaScript()}
          text={t('pages.pxpipeDashboard.jaSetupHint')}
          action={t('pages.pxpipeDashboard.jaSetupAction')}
        />
      )}
      {showStaleNotice && (
        <InfoBar
          tone="info"
          text={t('pages.pxpipeDashboard.jaStaleNotice', { dictTarget: status.jaDictTarget })}
        />
      )}
      {startError && <InfoBar tone="error" text={startError} />}

      {showEmbed ? (
        <div className="relative flex-1 min-h-0">
          <iframe
            // key に URL を入れて locale 切替時に確実に作り直す（内部状態の持ち越しを避ける）。
            key={embedUrl}
            src={embedUrl}
            title={t('pages.pxpipeDashboard.title')}
            className="absolute inset-0 h-full w-full border-0 bg-white"
            // 与える権限は 2 つだけ。allow-scripts は overlay の翻訳スクリプト、
            // allow-same-origin は上流 dashboard の htmx が自オリジンへ fetch するために必須。
            // top-navigation / popups / forms / modals / downloads は**与えない**。
            sandbox="allow-scripts allow-same-origin"
            referrerPolicy="no-referrer"
          />
          {/* 操作は最小のアイコン群としてオーバーレイ。既定は半透明で、
              ホバー時のみはっきり出す（ダッシュボードの数字を隠さないため）。 */}
          {/* ボタンは 28px（既定の icon サイズ 40px は大きすぎる）。
              [&_svg]:size-3.5 が要るのは、buttonVariants 基底の [&_svg]:size-4 が
              lucide の size={14} を CSS で上書きしてしまうため。 */}
          <div className="absolute top-2 right-4 z-10 flex items-center gap-0.5 rounded-md border border-border/60 bg-background/80 px-1 py-0.5 opacity-60 shadow-sm backdrop-blur-sm transition-opacity focus-within:opacity-100 hover:opacity-100">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 [&_svg]:size-3.5"
              disabled={busy}
              aria-label={t('pages.pxpipeDashboard.refresh')}
              title={t('pages.pxpipeDashboard.refresh')}
              onClick={() => void refresh()}
            >
              <RefreshCw className={cn(busy && 'animate-spin')} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 [&_svg]:size-3.5"
              aria-label={t('pages.pxpipeDashboard.openExternal')}
              title={t('pages.pxpipeDashboard.openExternal') + ' — ' + embedUrl}
              onClick={() => window.open(embedUrl, '_blank')}
            >
              <ExternalLink />
            </Button>
            {/* 英語版を出したまま日本語版だけ未起動のとき、自動起動が失敗しても手で起こせるようにする。 */}
            {showStartJaAction && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 [&_svg]:size-3.5"
                disabled={busy}
                aria-label={t('pages.pxpipeDashboard.startJa')}
                title={t('pages.pxpipeDashboard.startJa')}
                onClick={() => void handleStart()}
              >
                <Play />
              </Button>
            )}
            {status.jaOwned && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 [&_svg]:size-3.5"
                disabled={busy}
                aria-label={t('pages.pxpipeDashboard.stopJa')}
                title={t('pages.pxpipeDashboard.stopJa')}
                onClick={() => void handleStopJa()}
              >
                <Square />
              </Button>
            )}
            {/* 孤児表示は行を消費しないアイコンだけで残す。
                「本アプリ終了後も残る」は復元不能な運用情報なので捨てない。 */}
            {!status.proxyOwned && (
              <span
                className="flex h-7 w-7 items-center justify-center text-amber-600"
                aria-label={t('pages.pxpipeDashboard.badge.orphan')}
                title={t('pages.pxpipeDashboard.badge.orphan')}
              >
                <AlertTriangle size={14} />
              </span>
            )}
          </div>
        </div>
      ) : (
        <EmptyState status={status} busy={busy} onStart={() => void handleStart()} />
      )}
    </div>
  )
}

/** 日本語版が未設定のときだけ出す 1 行の導線（設定できたら消える）。 */
function SetupHint({
  busy,
  onPick,
  text,
  action
}: {
  busy: boolean
  onPick: () => void
  text: string
  action: string
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 shrink-0 rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
      <Info size={13} className="shrink-0" />
      <span className="truncate">{text}</span>
      <Button variant="ghost" size="sm" className="ml-auto h-6" disabled={busy} onClick={onPick}>
        {action}
      </Button>
    </div>
  )
}

/** R3: 状態ごとに文言とボタンを出し分ける（空白や無言のエラーにしない）。 */
function EmptyState({
  status,
  busy,
  onStart
}: {
  status: PxpipeViewStatus
  busy: boolean
  onStart: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const vars = { jaPort: status.jaPort, upstreamPort: status.upstreamPort }

  // ja-foreign は「触らない」状態なので起動ボタンを出さない（誤って別サービスを操作しない）。
  const canStart = status.state !== 'ja-foreign'
  const labelKey =
    status.state === 'ja-down' ? 'pages.pxpipeDashboard.startJa' : 'pages.pxpipeDashboard.start'

  const map: Record<string, { title: string; body: string; tone: 'info' | 'error' }> = {
    'proxy-down': {
      title: t('pages.pxpipeDashboard.state.proxyDownTitle'),
      body: t('pages.pxpipeDashboard.state.proxyDownBody', vars),
      tone: 'info'
    },
    'ja-down': {
      title: t('pages.pxpipeDashboard.state.jaDownTitle'),
      body: t('pages.pxpipeDashboard.state.jaDownBody', vars),
      tone: 'info'
    },
    'upstream-down': {
      title: t('pages.pxpipeDashboard.state.upstreamDownTitle'),
      body: t('pages.pxpipeDashboard.state.upstreamDownBody', vars),
      tone: 'error'
    },
    'ja-foreign': {
      title: t('pages.pxpipeDashboard.state.jaForeignTitle'),
      body: t('pages.pxpipeDashboard.state.jaForeignBody', vars),
      tone: 'error'
    }
  }
  const view = map[status.state] ?? map['proxy-down']

  return (
    <StateCard
      tone={view.tone}
      title={view.title}
      body={view.body}
      action={
        canStart ? (
          <Button onClick={onStart} disabled={busy}>
            <Play size={14} className="mr-1.5" />
            {busy ? t('pages.pxpipeDashboard.starting') : t(labelKey)}
          </Button>
        ) : null
      }
    />
  )
}

function StateCard({
  tone,
  title,
  body,
  action
}: {
  tone: 'info' | 'error'
  title: string
  body: string
  action: React.ReactNode
}): React.JSX.Element {
  const Icon = tone === 'error' ? AlertTriangle : Info
  return (
    <div className="flex-1 min-h-0 flex items-center justify-center">
      <div className="max-w-lg rounded-lg border border-border p-6 flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Icon
            size={18}
            className={tone === 'error' ? 'text-amber-600' : 'text-muted-foreground'}
          />
          <span className="font-medium">{title}</span>
        </div>
        {body && <p className="text-sm text-muted-foreground leading-relaxed">{body}</p>}
        {action && <div className="pt-1">{action}</div>}
      </div>
    </div>
  )
}

function InfoBar({
  text,
  tone = 'info'
}: {
  text: string
  tone?: 'info' | 'error'
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex items-start gap-2 text-xs rounded p-2 shrink-0',
        tone === 'error' ? 'bg-amber-500/10 text-amber-700' : 'bg-muted text-muted-foreground'
      )}
    >
      <Info size={14} className="mt-0.5 shrink-0" />
      <span>{text}</span>
    </div>
  )
}

/**
 * 070 M4: 画像化スコープ設定パネル（正本管理 + 稼働中 proxy 状態との突合）。
 * - Opus 5 / Opus 5.5 / Fable 5 / Fable 5.1 を人が読める名前で常設表示
 * - proxy 停止中でも正本を読み書き可能
 * - 前方一致巻き込み（Opus 5 ON による Opus 5.5 画像化など）を理由付きで連動ONバッジ表示
 * - 正本と稼働中 proxy の食い違い警告バッジ
 * - 版不一致警告バッジ
 */
function ScopeControlPanel({
  status,
  versionStatus,
  busy,
  onToggle
}: {
  status: PxpipeScopeStatusDTO | null
  versionStatus: PxpipeVersionStatusDTO | null
  busy: boolean
  onToggle: (model: string, on: boolean) => void
}): React.JSX.Element {
  if (!status) {
    return <div className="text-xs text-muted-foreground p-2">スコープ設定を読込中…</div>
  }

  return (
    <div className="rounded-lg border border-border bg-card p-3 shadow-sm flex flex-col gap-2 shrink-0">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            画像化スコープ設定 (正本管理)
          </span>
          {status.runningPort ? (
            <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600">
              Proxy 稼働中 (:{status.runningPort})
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              Proxy 停止中 (設定値は常時保持)
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* 正本と稼働中 proxy の食い違い警告 */}
          {!status.isScopeConsistent && (
            <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700">
              <AlertTriangle size={13} />
              正本と稼働中プロキシの設定が食い違っています（プロキシ再起動で反映）
            </span>
          )}
          {/* 版不一致警告 */}
          {versionStatus && !versionStatus.isVersionConsistent && (
            <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700">
              <AlertTriangle size={13} />
              稼働中の版 ({versionStatus.runningVersion ?? '不明'}) が指定 ({versionStatus.pinnedVersion}) と異なります
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
        {status.resolutions.map((r) => {
          const isEntangled = r.isImplicitByPrefix
          const isDisabled = busy || isEntangled

          return (
            <div
              key={r.concreteId}
              className={cn(
                'flex flex-col justify-between p-2 rounded-md border text-xs transition-colors',
                r.isInScope
                  ? 'border-primary/40 bg-primary/5'
                  : 'border-border/60 bg-muted/20'
              )}
            >
              <div className="flex items-center justify-between gap-1 mb-1">
                <span className="font-medium text-foreground truncate" title={r.concreteId}>
                  {r.displayName}
                </span>
                <input
                  type="checkbox"
                  checked={r.isInScope}
                  disabled={isDisabled}
                  onChange={(e) => onToggle(r.concreteId, e.target.checked)}
                  className="h-3.5 w-3.5 cursor-pointer disabled:cursor-not-allowed accent-primary"
                  title={isEntangled ? r.reason : undefined}
                />
              </div>

              <div className="flex items-center justify-between text-[11px] pt-1 border-t border-border/40">
                {isEntangled ? (
                  <span
                    className="inline-flex items-center gap-0.5 text-amber-600 font-medium truncate"
                    title={r.reason}
                  >
                    連動ON ({r.matchedBase})
                  </span>
                ) : r.isInScope ? (
                  <span className="text-emerald-600 font-medium">画像化中 (ON)</span>
                ) : (
                  <span className="text-muted-foreground">素通し (OFF)</span>
                )}
                <span className="text-[10px] text-muted-foreground/80 font-mono">
                  {r.concreteId.replace(/^claude-[a-z]+-/, '')}
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
