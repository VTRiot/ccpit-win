import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Check, X } from 'lucide-react'
import { Button } from './ui/button'
import { useBgccActivity, closeBgccPanel } from '../hooks/useBgccActivity'
import {
  indicatorStatus,
  buildCopyText,
  formatEventTime,
  type BgccActivityEvent,
  type BgccIndicatorStatus
} from '../lib/bgccActivity'

/**
 * FB02 F5: BG-CC アクティビティパネル（読み取り専用）。
 * - 入力要素ゼロ（ボタンは Copy/Close のみ）。イベント text は JSX テキストノードとしてのみ描画
 *   （React が自動エスケープ。markdown/HTML 解釈禁止 — Codex 設計レビュー finding 3 の信頼境界）。
 * - 非モーダル固定パネル（backdrop なし）。z-[65] = Settings(z-50)/Maintenance(z-[60]) の上・
 *   ConfirmDialog(z-[70]) の下（手動更新は Settings から発火するためパネルはその上に出る必要がある）。
 * - 自動スクロールは「最下部にいる時だけ」追従（読み返し中のジャンプを防ぐ）。
 */

/** 「最下部にいる」判定の許容ずれ（px）。スクロール端の丸め誤差吸収。 */
const AUTOSCROLL_THRESHOLD_PX = 8
/** Copy 完了表示の残置時間。DebugPage の copiedTimer と同じ体感値。 */
const COPIED_FEEDBACK_MS = 1500

function statusDotClass(status: BgccIndicatorStatus): string {
  switch (status) {
    case 'running':
      return 'bg-amber-400 animate-pulse'
    case 'succeeded':
      return 'bg-green-500'
    case 'failed':
      return 'bg-red-500'
    default:
      return 'bg-muted-foreground/40'
  }
}

function kindClass(ev: BgccActivityEvent): string {
  if (ev.kind === 'error' || ev.kind === 'stderr') return 'text-red-400'
  if (ev.kind === 'result') return ev.meta?.ok === true ? 'text-green-500' : 'text-red-400'
  if (ev.kind === 'tool' || ev.kind === 'raw_stdout') return 'text-muted-foreground'
  return 'text-foreground'
}

export function BgccActivityPanel(): React.JSX.Element | null {
  const { panelOpen } = useBgccActivity()
  // 閉→開のたびに Body を再マウントし、atBottom 等の内部状態を初期値へ戻す
  //（effect 内 setState によるリセットを構造で不要化 — open 直後は必ず最下部追従）。
  if (!panelOpen) return null
  return <BgccActivityPanelBody />
}

function BgccActivityPanelBody(): React.JSX.Element {
  const { t } = useTranslation()
  const { runs } = useBgccActivity()
  const listRef = useRef<HTMLDivElement | null>(null)
  // ref = effect 内の追従判定用 / state = 「最新へ」ピルの表示切替（ref だけでは再描画されない）
  const atBottomRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const [copied, setCopied] = useState(false)

  const latestRun = runs.length > 0 ? runs[runs.length - 1] : undefined
  const eventCount = latestRun?.events.length ?? 0
  const status = indicatorStatus(runs)

  // 最下部追従（読み返し中はジャンプしない）。マウント直後（=パネルを開いた直後）も必ず最下部へ。
  useEffect(() => {
    const el = listRef.current
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [eventCount])

  const terminal = latestRun?.events.find((e) => e.kind === 'result' || e.kind === 'error')
  const durationSec =
    terminal?.meta?.durationMs !== undefined ? (terminal.meta.durationMs / 1000).toFixed(1) : null

  const handleScroll = (): void => {
    const el = listRef.current
    if (!el) return
    const next = el.scrollHeight - el.scrollTop - el.clientHeight < AUTOSCROLL_THRESHOLD_PX
    atBottomRef.current = next
    setAtBottom(next)
  }

  const handleCopy = async (): Promise<void> => {
    try {
      await window.api.clipboardWrite(buildCopyText(latestRun))
      setCopied(true)
      setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)
    } catch {
      /* fail-quiet */
    }
  }

  const jumpToLatest = (): void => {
    const el = listRef.current
    if (el) {
      atBottomRef.current = true
      setAtBottom(true)
      el.scrollTop = el.scrollHeight
    }
  }

  return (
    <div
      className="fixed bottom-9 right-3 z-[65] w-[440px] max-w-[calc(100vw-24px)] max-h-[45vh] flex flex-col rounded-lg border border-border bg-card shadow-xl"
      style={{ pointerEvents: 'auto' }}
      role="log"
      aria-live="polite"
    >
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border">
        <span className={`h-2 w-2 rounded-full shrink-0 ${statusDotClass(status)}`} />
        <span className="text-sm font-semibold">{t('bgcc.panel.title')}</span>
        {latestRun && (
          <span className="text-[11px] text-muted-foreground truncate">{latestRun.source}</span>
        )}
        <span className="text-xs text-muted-foreground">{t(`bgcc.status.${status}`)}</span>
        {durationSec !== null && (
          <span className="text-[11px] text-muted-foreground/70">
            {terminal?.meta?.costUsd !== undefined
              ? t('bgcc.panel.durationCost', {
                  seconds: durationSec,
                  cost: terminal.meta.costUsd.toFixed(3)
                })
              : t('bgcc.panel.duration', { seconds: durationSec })}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 gap-1 text-xs"
            onClick={() => void handleCopy()}
            title={t('common.copy')}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? t('common.copied') : t('common.copy')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={closeBgccPanel}
            title={t('bgcc.panel.close')}
          >
            <X size={13} />
          </Button>
        </div>
      </div>
      <div
        ref={listRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-3 py-2 select-text cursor-text relative"
      >
        {!latestRun || latestRun.events.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('bgcc.panel.empty')}</p>
        ) : (
          latestRun.events.map((e) => (
            <div
              key={`${e.runId}:${e.seq}`}
              className="text-xs font-mono whitespace-pre-wrap break-words leading-5"
            >
              <span className="text-muted-foreground/60">{formatEventTime(e.ts)}</span>{' '}
              <span className={kindClass(e)}>{e.kind}</span>{' '}
              <span className="text-foreground/90">{e.text}</span>
            </div>
          ))
        )}
      </div>
      {!atBottom && eventCount > 0 && (
        <button
          onClick={jumpToLatest}
          className="absolute bottom-2 right-3 text-[11px] px-2 py-0.5 rounded-full bg-primary text-primary-foreground shadow"
        >
          {t('bgcc.panel.jumpLatest')}
        </button>
      )}
    </div>
  )
}
