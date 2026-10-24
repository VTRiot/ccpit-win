import * as React from 'react'
import { useEffect, useState } from 'react'
import { Copy, Play } from 'lucide-react'
import { Button } from './ui/button'
import { ComposeActivityIndicator } from './ComposeActivityIndicator'
import { cn } from '../lib/utils'
import {
  RECEPTACLE_CLOSE_CHOICES,
  canSubmitRejection,
  composeCaseView,
  matrixLabels,
  openReceptacles,
  originsPayload,
  originsReady,
  receptacleBadgeLabel,
  receptacleStatusLabel,
  updateStaleness,
  type CaseButton,
  type CaseStatusInput
} from '../lib/composeCaseView'
import type { ReceptacleClosedHow, ReceptacleSummary } from '../../../shared/composeContract'

/**
 * 合成の案件（caseId を持つ作業場）のカード（CCPIT_L0_011 Plan r3 §2 W3・W4）。
 * 文面・行列・ボタンは lib/composeCaseView.ts の純関数が決め、ここは描画と操作の結線だけを持つ。
 * 旧形式（caseId 無し）の作業場は、ページ側が従来の表示のまま扱う。
 */

/** 経過時間を描き直す間隔（発注書 W3: 経過時間は 1 秒ごとに描き直す。mm:ss の最小単位に合わせる） */
const ELAPSED_REDRAW_MS = 1000

/** 1 秒ごとに更新する現在時刻（renderer の時計）。この部品の中だけで再描画し、ページ全体は巻き込まない */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const id = window.setInterval(() => setNow(Date.now()), ELAPSED_REDRAW_MS)
    return () => window.clearInterval(id)
  }, [active])
  return now
}

/**
 * 更新待ちの知らせ。進行中（watching）で、最後に状態を取れてから閾値を超えたときだけ出す。
 * 旧形式のカードにも使う（案件のカードは中で同じ判定をする）。
 */
export function ComposeStaleNotice({
  lastFetchedMs,
  watching,
  ja
}: {
  lastFetchedMs: number | null
  watching: boolean
  ja: boolean
}): React.JSX.Element | null {
  const now = useNow(watching)
  const st = watching ? updateStaleness(lastFetchedMs, now, ja) : { stale: false, label: null }
  if (!st.label) return null
  return (
    <p className="text-xs text-amber-600 font-semibold" data-testid="compose-stale">
      {st.label}
    </p>
  )
}

/** パスをコピーできる形で出す（コピーに失敗してもパス自体は選択して写せる） */
function CopyablePath({ path, ja }: { path: string; ja: boolean }): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1 max-w-full">
      <code className="text-[11px] break-all select-all bg-muted/60 rounded px-1">{path}</code>
      <button
        type="button"
        className="shrink-0 text-muted-foreground hover:text-foreground"
        title={ja ? 'パスをコピー' : 'Copy the path'}
        aria-label={ja ? 'パスをコピー' : 'Copy the path'}
        onClick={() => {
          void navigator.clipboard?.writeText(path).catch(() => undefined)
        }}
      >
        <Copy size={12} />
      </button>
    </span>
  )
}

export function ComposeCaseCard({
  status,
  ja,
  lastFetchedMs,
  watching,
  onOpenPromotion,
  onConsult,
  onCancel,
  onChanged
}: {
  status: CaseStatusInput
  ja: boolean
  /** 状態を最後に取れた時刻（renderer の時計）。更新待ちの判定に使う */
  lastFetchedMs: number | null
  /** 進行中の案件があり、取り直しが走っているか（更新待ちを出す対象か） */
  watching: boolean
  onOpenPromotion: (compositeId: string) => void
  /** 「相談を開く」: ページの既存の相談の操作 */
  onConsult: () => void
  onCancel: (workspaceDir: string) => void
  /** 回答・棄却の記録のあとに、状態を取り直す */
  onChanged: () => void
}): React.JSX.Element {
  const L = (j: string, e: string): string => (ja ? j : e)
  const nowMs = useNow(true)
  const view = composeCaseView(status, ja, nowMs)
  const stale = watching ? updateStaleness(lastFetchedMs, nowMs, ja) : { stale: false, label: null }
  const labels = matrixLabels(ja)
  const caseId = status.caseId ?? ''
  const [reasons, setReasons] = useState<Record<string, string>>({})
  const [rowError, setRowError] = useState<Record<string, string>>({})
  const [chosen, setChosen] = useState<Record<string, 'diff' | 'base'>>({})
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>): Promise<boolean> => {
    if (busy) return false
    setBusy(true)
    setActionError(null)
    try {
      const r = await fn()
      if (!r.ok) setActionError(r.error ?? L('操作を受け付けられませんでした', 'The operation was not accepted'))
      onChanged()
      return r.ok
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      setBusy(false)
    }
  }

  const pressButton = (btn: CaseButton): void => {
    switch (btn.action) {
      case 'cancel':
        if (status.workspaceDir) onCancel(status.workspaceDir)
        return
      case 'openPromotion':
        onOpenPromotion(view.compositeId)
        return
      case 'consult':
        onConsult()
        return
      case 'answer': {
        if (!btn.option) return
        const origins =
          btn.option === 'choose-origins-and-revise' ? originsPayload(view.unclearGateIds, chosen) : undefined
        void run(() =>
          window.api.skillProposalsComposeAnswer({ caseId, option: btn.option!, ...(origins ? { origins } : {}) })
        )
        return
      }
      case 'adjudicate':
        // 棄却の記録は指摘ごとの行のボタンから行う
        return
    }
  }

  const recordRejection = async (gateId: string): Promise<void> => {
    const reason = reasons[gateId] ?? ''
    if (!canSubmitRejection(reason)) {
      setRowError((e) => ({ ...e, [gateId]: L('棄却の理由を記入してください', 'Enter the rejection reason') }))
      return
    }
    setRowError((e) => ({ ...e, [gateId]: '' }))
    if (busy) return
    setBusy(true)
    try {
      const r = await window.api.skillProposalsComposeAdjudicate({
        caseId,
        compositeId: view.compositeId,
        gateId,
        reason
      })
      // main の拒否の文面（理由が短い・対象外など）はそのまま出す
      if (!r.ok) setRowError((e) => ({ ...e, [gateId]: r.error ?? L('記録できませんでした', 'Could not record it') }))
      onChanged()
    } catch (err) {
      setRowError((e) => ({ ...e, [gateId]: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusy(false)
    }
  }

  const barButtons = view.buttons.filter((b) => b.action !== 'adjudicate')
  const needsOrigins = view.unclearGateIds.length > 0

  return (
    <div className="space-y-2" data-testid="compose-case-card" data-case-view={view.caseView}>
      <div className="text-xs space-y-1">
        <p className="font-semibold flex items-start gap-1.5" data-testid="compose-headline">
          {view.activity && (
            <span className="mt-0.5 inline-flex">
              <ComposeActivityIndicator kind={view.activity} />
            </span>
          )}
          <span>{view.headline}</span>
        </p>
        {view.detail.map((d, i) => (
          <p key={i} className="text-muted-foreground whitespace-pre-wrap">
            {d}
          </p>
        ))}
        {stale.label && (
          <p className="text-amber-600 font-semibold" data-testid="compose-stale">
            {stale.label}
          </p>
        )}
      </div>

      <dl
        className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-xs rounded border border-border p-2"
        data-testid="compose-matrix"
      >
        {(Object.keys(labels) as Array<keyof typeof labels>).map((k) => (
          <React.Fragment key={k}>
            <dt className="text-muted-foreground">{labels[k]}</dt>
            <dd>{view.matrix[k]}</dd>
          </React.Fragment>
        ))}
      </dl>

      {view.receptacles.length > 0 && (
        <div className="text-xs space-y-0.5">
          <p className="text-muted-foreground">{L('受け皿', 'Holding files')}</p>
          {view.receptacles.map((p) => (
            <CopyablePath key={p} path={p} ja={ja} />
          ))}
        </div>
      )}

      {view.findings.length > 0 && (
        <ul className="space-y-1.5 text-xs" data-testid="compose-findings">
          {view.findings.map((f, i) => (
            <li key={`${f.number}-${i}`} className="rounded border border-border p-2 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono">{f.number}</span>
                <span
                  className={cn(
                    'rounded px-1.5 py-0.5',
                    f.origin === 'diff' && 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
                    f.origin === 'base' && 'bg-muted text-muted-foreground',
                    f.origin === 'unclear' && 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
                  )}
                  data-testid="finding-origin"
                >
                  {f.originLabel}
                </span>
                <span className="text-muted-foreground">{f.severity}</span>
                <span className="font-semibold">{f.summary}</span>
              </div>
              <p className="text-muted-foreground">{f.basis}</p>
              {f.adjudication && <p>{f.adjudication}</p>}
              {/* 停止 (e) の由来の選択は、棄却の入力欄（回答待ちだけ）とは別に、停止中に出す */}
              {view.caseView === 'stopped' && f.origin === 'unclear' && needsOrigins && f.gateId && (
                <div className="flex items-center gap-3" role="radiogroup">
                  {(['diff', 'base'] as const).map((o) => (
                    <label key={o} className="inline-flex items-center gap-1 cursor-pointer">
                      <input
                        type="radio"
                        name={`origin-${f.gateId}`}
                        checked={chosen[f.gateId!] === o}
                        onChange={() => setChosen((c) => ({ ...c, [f.gateId!]: o }))}
                      />
                      {o === 'diff' ? L('差分として扱う', 'Treat as changes') : L('原文として扱う', 'Treat as existing text')}
                    </label>
                  ))}
                </div>
              )}
              {view.showAdjudicationInputs && f.canReject && f.gateId && (
                <div className="space-y-1">
                  <textarea
                    className="w-full rounded border border-input bg-background p-1 text-xs"
                    rows={2}
                    placeholder={L('棄却の理由', 'Rejection reason')}
                    value={reasons[f.gateId] ?? ''}
                    onChange={(e) => setReasons((r) => ({ ...r, [f.gateId!]: e.target.value }))}
                  />
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => void recordRejection(f.gateId!)}>
                      {L('棄却を記録', 'Record rejection')}
                    </Button>
                    {rowError[f.gateId] && <span className="text-red-600">{rowError[f.gateId]}</span>}
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {barButtons.map((btn) => (
          <Button
            key={`${btn.action}-${btn.option ?? ''}`}
            size="sm"
            variant={btn.primary ? 'default' : 'outline'}
            disabled={
              busy ||
              (btn.option === 'choose-origins-and-revise' && !originsReady(view.unclearGateIds, chosen))
            }
            onClick={() => pressButton(btn)}
          >
            {btn.primary && <Play size={13} className="mr-1" />}
            {btn.label}
          </Button>
        ))}
        {actionError && <span className="text-xs text-red-600">{actionError}</span>}
      </div>
    </div>
  )
}

/**
 * 受け皿（原文への指摘の置き場）の一覧。open の件数の札と、題名・持ち主・作成日時・状態・パス、閉じる 3 択。
 * 閉じた後は onClosed で一覧を取り直す（呼び出し側）。
 */
export function ReceptaclePanel({
  skillName,
  ja,
  list,
  onClose
}: {
  skillName: string
  ja: boolean
  list: readonly ReceptacleSummary[]
  onClose: (path: string, how: ReceptacleClosedHow) => Promise<{ ok: boolean; error?: string }>
}): React.JSX.Element | null {
  const L = (j: string, e: string): string => (ja ? j : e)
  const mine = list.filter((r) => r.skill === skillName)
  const open = openReceptacles(mine)
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (mine.length === 0) return null
  return (
    <div className="rounded border border-border bg-background/60 p-2 text-xs space-y-1" data-testid="receptacle-panel">
      <button
        type="button"
        className="inline-flex items-center gap-2"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span
          className={cn(
            'rounded px-1.5 py-0.5',
            open.length > 0 ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400' : 'bg-muted text-muted-foreground'
          )}
          data-testid="receptacle-badge"
        >
          {receptacleBadgeLabel(open.length, ja)}
        </span>
        <span className="text-muted-foreground">
          {expanded ? L('一覧を閉じる', 'Hide the list') : L('一覧を見る', 'Show the list')}
        </span>
      </button>
      {expanded && (
        <ul className="space-y-1.5">
          {mine.map((r) => (
            <li key={r.path} className="rounded border border-border p-2 space-y-1">
              <p className="font-semibold">{r.title}</p>
              <p className="text-muted-foreground">
                {L('持ち主', 'Owner')}: {r.owner} / {L('作成', 'Created')}: {r.createdAt} / {L('状態', 'Status')}:{' '}
                {receptacleStatusLabel(r, ja)} / {L('指摘', 'Entries')}: {r.entryCount}
              </p>
              <CopyablePath path={r.path} ja={ja} />
              {r.status === 'open' && (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <span className="text-muted-foreground">{L('閉じる:', 'Close as:')}</span>
                  {RECEPTACLE_CLOSE_CHOICES.map((c) => (
                    <Button
                      key={c.how}
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setError(null)
                        void onClose(r.path, c.how).then((res) => {
                          if (!res.ok) setError(res.error ?? L('閉じられませんでした', 'Could not close it'))
                        })
                      }}
                    >
                      {ja ? c.ja : c.en}
                    </Button>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-red-600">{error}</p>}
    </div>
  )
}
