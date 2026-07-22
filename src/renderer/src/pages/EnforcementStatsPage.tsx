import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, Info, FileText } from 'lucide-react'
import { Button } from '../components/ui/button'
import { cn } from '../lib/utils'

type EnfResult = Awaited<ReturnType<typeof window.api.enforcementStatsCompute>>
type TypeStat = EnfResult['hooksStop']
type SkillResult = Awaited<ReturnType<typeof window.api.skillFiringStatsCompute>>
type SkillStat = SkillResult['stats'][number]

type TabId = 'skill' | 'hooksStop' | 'rulesB' | 'deny' | 'marshal'

/** 射程バナー（amber、測定できない発火の明示）。 */
function ScopeBanner({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="flex items-start gap-2 text-xs bg-amber-500/10 text-amber-700 rounded p-2 shrink-0">
      <Info size={14} className="mt-0.5 shrink-0" />
      <span>{text}</span>
    </div>
  )
}

/** 参考値バナー（slate、計数対象外の型を正直に表示）。 */
function RefBanner({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="flex items-start gap-2 text-xs bg-slate-500/10 text-slate-600 rounded p-2 shrink-0">
      <Info size={14} className="mt-0.5 shrink-0" />
      <span>{text}</span>
    </div>
  )
}

/** 1 系列の発火数 + 降順ランキング横棒。 */
function RankingBars({
  stat,
  emptyLabel,
  totalLabel,
  seriesTitle
}: {
  stat: TypeStat
  emptyLabel: string
  totalLabel: string
  seriesTitle?: string
}): React.JSX.Element {
  const max = useMemo(() => stat.ranking.reduce((m, r) => Math.max(m, r.count), 0), [stat])
  const keyColCh = useMemo(() => {
    const longest = stat.ranking.reduce((m, r) => Math.max(m, r.key.length), 0)
    return Math.min(32, Math.max(10, longest + 1))
  }, [stat])

  return (
    <div className="flex flex-col gap-1">
      <div className="text-xs text-muted-foreground shrink-0">
        {seriesTitle && <span className="font-medium text-foreground mr-2">{seriesTitle}</span>}
        {totalLabel}: <span className="font-mono">{stat.total}</span>
      </div>
      {stat.ranking.length === 0 ? (
        <div className="p-2 text-sm text-muted-foreground">{emptyLabel}</div>
      ) : (
        stat.ranking.map((r) => (
          <div
            key={r.key}
            className="flex items-center gap-2 px-1 py-0.5 rounded hover:bg-muted/50"
          >
            <span
              className="text-sm truncate shrink-0"
              style={{ width: `${keyColCh}ch` }}
              title={r.key}
            >
              {r.key}
            </span>
            <span className="text-xs font-mono text-right shrink-0 w-10">{r.count}</span>
            <div className="flex-1 h-4 bg-muted/30 rounded-sm overflow-hidden">
              <div
                className="h-full bg-primary/70 rounded-sm"
                style={{ width: max > 0 ? `${(r.count / max) * 100}%` : '0%' }}
              />
            </div>
          </div>
        ))
      )}
    </div>
  )
}

/**
 * skill タブ（B6 SkillFiringStatsPage を統合）。発火数 + 降順ランキングに加え、
 * 行ホバーで詳細（最終発火・PRJ 別）、右クリックで該当 SKILL.md を開く、Skill 種カウントを表示。
 * データは B6 リッチ IPC（skillFiringStatsCompute）を直接使う（skill の単一真実源）。
 */
function SkillTab({
  data,
  L
}: {
  data: SkillResult | null
  L: (j: string, e: string) => string
}): React.JSX.Element {
  const [hover, setHover] = useState<{ stat: SkillStat; x: number; y: number } | null>(null)
  const [menu, setMenu] = useState<{ skill: string; x: number; y: number } | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [menu])

  const maxCount = useMemo(
    () => (data ? data.stats.reduce((m, s) => Math.max(m, s.count), 0) : 0),
    [data]
  )
  const nameColCh = useMemo(() => {
    if (!data || data.stats.length === 0) return 8
    const longest = data.stats.reduce((m, s) => Math.max(m, s.skill.length), 0)
    return Math.min(28, Math.max(8, longest + 1))
  }, [data])

  const fmtDate = (iso: string | null): string => {
    if (!iso) return '-'
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
  }

  const openSkillMd = async (skill: string): Promise<void> => {
    setMenu(null)
    const r = await window.api.skillMdOpen(skill)
    if (!r.ok) {
      setToast(
        r.reason === 'not-found'
          ? L(
              `SKILL.md が見つかりません（${skill} は採用 skill ではない可能性）。`,
              `SKILL.md not found (${skill} may not be a locally adopted skill).`
            )
          : L(`開けませんでした: ${r.error ?? ''}`, `Failed to open: ${r.error ?? ''}`)
      )
      setTimeout(() => setToast(null), 4000)
    }
  }

  if (!data) {
    return <div className="p-2 text-sm text-muted-foreground">{L('読込中…', 'Loading…')}</div>
  }

  return (
    <div className="flex flex-col gap-2">
      <ScopeBanner text={data.scopeNote} />
      <div className="text-xs text-muted-foreground shrink-0">
        {L('総発火', 'total firings')}: {data.totalFirings} / {L('走査ファイル', 'files scanned')}:{' '}
        {data.filesScanned} / {L('Skill 種', 'distinct skills')}: {data.stats.length}
        <span className="ml-2 opacity-70">
          {L(
            '（行ホバーで詳細・右クリックで SKILL.md を開く）',
            '(hover for details, right-click to open SKILL.md)'
          )}
        </span>
      </div>

      {data.stats.length === 0 ? (
        <div className="p-2 text-sm text-muted-foreground">
          {L('発火記録がありません。', 'No firing records.')}
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {data.stats.map((s) => (
            <div
              key={s.skill}
              className="flex items-center gap-2 px-1 py-0.5 rounded hover:bg-muted/50 cursor-default"
              onMouseEnter={(e) => setHover({ stat: s, x: e.clientX, y: e.clientY })}
              onMouseMove={(e) => setHover((h) => (h ? { ...h, x: e.clientX, y: e.clientY } : h))}
              onMouseLeave={() => setHover(null)}
              onContextMenu={(e) => {
                e.preventDefault()
                setHover(null)
                setMenu({ skill: s.skill, x: e.clientX, y: e.clientY })
              }}
            >
              <span
                className="text-sm truncate shrink-0"
                style={{ width: `${nameColCh}ch` }}
                title={s.skill}
              >
                {s.skill}
              </span>
              <span className="text-xs font-mono text-right shrink-0 w-10">{s.count}</span>
              <div className="flex-1 h-4 bg-muted/30 rounded-sm overflow-hidden">
                <div
                  className="h-full bg-primary/70 rounded-sm"
                  style={{ width: maxCount > 0 ? `${(s.count / maxCount) * 100}%` : '0%' }}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ホバー tooltip: 最終発火 + PRJ 別 */}
      {hover && (
        <div
          className="fixed z-[80] pointer-events-none bg-popover text-popover-foreground border border-border rounded-md shadow-lg p-2 text-xs max-w-xs"
          style={{ left: Math.min(hover.x + 14, window.innerWidth - 280), top: hover.y + 14 }}
        >
          <div className="font-medium mb-1">{hover.stat.skill}</div>
          <div className="text-muted-foreground">
            {L('発火回数', 'count')}: <span className="font-mono">{hover.stat.count}</span>
          </div>
          <div className="text-muted-foreground">
            {L('最終発火', 'last fired')}: {fmtDate(hover.stat.lastFiredAt)}
          </div>
          {hover.stat.byProject.length > 0 && (
            <div className="mt-1">
              <div className="text-muted-foreground">{L('PRJ 別', 'by project')}:</div>
              {hover.stat.byProject.slice(0, 6).map((p) => (
                <div key={p.project} className="truncate">
                  {p.project} <span className="font-mono">({p.count})</span>
                </div>
              ))}
              {hover.stat.byProject.length > 6 && <div>… +{hover.stat.byProject.length - 6}</div>}
            </div>
          )}
        </div>
      )}

      {/* 右クリックメニュー */}
      {menu && (
        <div
          className="fixed z-[90] bg-popover text-popover-foreground border border-border rounded-md shadow-lg py-1 text-sm"
          style={{
            left: Math.min(menu.x, window.innerWidth - 220),
            top: Math.min(menu.y, window.innerHeight - 60)
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="flex items-center gap-2 w-full text-left px-3 py-1.5 hover:bg-muted"
            onClick={() => void openSkillMd(menu.skill)}
          >
            <FileText size={14} />
            {L('SKILL.md を開く', 'Open SKILL.md')}
          </button>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[100] bg-red-500/15 text-red-700 border border-red-300 rounded-md px-3 py-2 text-sm shadow">
          {toast}
        </div>
      )}
    </div>
  )
}

export function EnforcementStatsPage(): React.JSX.Element {
  const { i18n } = useTranslation()
  const ja = i18n.language.startsWith('ja')
  const L = (j: string, e: string): string => (ja ? j : e)

  const [data, setData] = useState<EnfResult | null>(null)
  const [skillData, setSkillData] = useState<SkillResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<TabId>('skill')

  const reload = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const [enf, sk] = await Promise.all([
        window.api.enforcementStatsCompute(),
        window.api.skillFiringStatsCompute()
      ])
      setData(enf)
      setSkillData(sk)
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const tabs: { id: TabId; label: string }[] = [
    { id: 'skill', label: L('skill', 'skill') },
    { id: 'hooksStop', label: L('hooks (Stop)', 'hooks (Stop)') },
    { id: 'rulesB', label: L('rules 層B', 'rules layer B') },
    { id: 'deny', label: L('deny', 'deny') },
    { id: 'marshal', label: L('marshal-review', 'marshal-review') }
  ]

  const emptyLabel = L('発火記録がありません。', 'No firing records.')
  const totalLabel = L('総発火', 'total firings')

  return (
    <div className="flex flex-col h-full gap-3 relative">
      <div className="flex items-center gap-2 shrink-0">
        <h2 className="text-base font-semibold">
          {L('強制発火統計', 'Enforcement firing stats')}
        </h2>
        <span className="text-xs text-muted-foreground">{L('読み取り専用', 'read-only')}</span>
        <div className="ml-auto">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void reload()}
            disabled={busy}
            className="h-8 w-8"
          >
            <RefreshCw size={14} className={cn(busy && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {/* 型タブ切替 */}
      <div className="flex items-center gap-1 shrink-0 border-b border-border">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              'px-3 py-1.5 text-sm rounded-t border-b-2 -mb-px',
              tab === t.id
                ? 'border-primary text-foreground font-medium'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {data && tab !== 'skill' && (
        <div className="text-xs text-muted-foreground shrink-0">
          {L('走査ファイル', 'files scanned')}: {data.filesScanned}
        </div>
      )}

      <div className="flex-1 overflow-auto border border-border rounded-md p-3 flex flex-col gap-3">
        {tab === 'skill' && <SkillTab data={skillData} L={L} />}

        {!data && tab !== 'skill' && (
          <div className="p-2 text-sm text-muted-foreground">{L('読込中…', 'Loading…')}</div>
        )}

        {data && tab === 'hooksStop' && (
          <>
            <ScopeBanner text={data.hooksStop.scopeNote} />
            <RankingBars stat={data.hooksStop} emptyLabel={emptyLabel} totalLabel={totalLabel} />
            {/* rules層A は独立タブ化せず、hooks タブ内に参考値バナーで表現 */}
            <RefBanner text={`rules ${L('層A', 'layer A')}: ${data.rulesLayerA.note}`} />
          </>
        )}

        {data && tab === 'rulesB' && (
          <>
            <ScopeBanner text={data.rulesB.scopeNote} />
            <RankingBars stat={data.rulesB} emptyLabel={emptyLabel} totalLabel={totalLabel} />
          </>
        )}

        {data && tab === 'deny' && (
          <>
            <ScopeBanner text={data.deny.scopeNote} />
            {/* 2 系列を区別表示。混ぜない。 */}
            <RankingBars
              stat={data.deny.settingsJson}
              emptyLabel={emptyLabel}
              totalLabel={totalLabel}
              seriesTitle={L('① settings.json deny 由来', '① from settings.json deny')}
            />
            <div className="border-t border-border" />
            <RankingBars
              stat={data.deny.rulePolicy}
              emptyLabel={emptyLabel}
              totalLabel={totalLabel}
              seriesTitle={L('② rule・policy 自己拒否', '② rule/policy self-deny')}
            />
          </>
        )}

        {data && tab === 'marshal' && (
          <>
            <ScopeBanner text={data.marshal.scopeNote} />
            <RankingBars stat={data.marshal} emptyLabel={emptyLabel} totalLabel={totalLabel} />
          </>
        )}
      </div>
    </div>
  )
}
