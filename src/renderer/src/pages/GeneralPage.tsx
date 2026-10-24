import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Label } from '../components/ui/label'
import { Input } from '../components/ui/input'
import { Button } from '../components/ui/button'

/**
 * CCPIT 055 W-4: Maintenance > General タブ。
 * コンテキスト使用量警告（Stop hook: context-usage-gate.sh → context-usage-detect.cjs）の
 * 閾値 2 本（warn1 = 🟣 / warn2 = 🔴）を ~/.ccpit/app-config.json の contextUsage へ永続化する。
 *
 * 既定値の正本は src/main/services/appConfig.ts の CONTEXT_USAGE_DEFAULTS。
 * renderer はプロセス境界を跨いで main を import できんため数値を重複させとる（preload 型と同じ流儀）。
 * 変更時は appConfig.ts / 本ファイル / context-usage-detect.cjs の 3 箇所を揃えること。
 */
const DEFAULT_WARN1 = 800000
const DEFAULT_WARN2 = 900000

/** 正の整数（10 進・安全整数）のみ受理。それ以外は null。 */
function parsePositiveInt(raw: string): number | null {
  const s = raw.trim()
  if (!/^[0-9]+$/.test(s)) return null
  const n = Number(s)
  if (!Number.isSafeInteger(n) || n <= 0) return null
  return n
}

function toK(n: number): string {
  return `${Math.round(n / 1000)}K`
}

export function GeneralPage(): React.JSX.Element {
  const { t } = useTranslation()
  const [warn1, setWarn1] = useState(String(DEFAULT_WARN1))
  const [warn2, setWarn2] = useState(String(DEFAULT_WARN2))
  const [status, setStatus] = useState<'idle' | 'saved' | 'restored'>('idle')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const cfg = await window.api.configGet()
        if (cancelled) return
        setWarn1(String(cfg.contextUsage?.warn1 ?? DEFAULT_WARN1))
        setWarn2(String(cfg.contextUsage?.warn2 ?? DEFAULT_WARN2))
      } catch {
        /* ignore — 読めん場合は既定値のまま表示（hook 側も同じ既定で動く） */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const n1 = parsePositiveInt(warn1)
  const n2 = parsePositiveInt(warn2)
  // 検証: 正整数のみ・警告1 < 警告2（W-4 要件）。違反時は保存を通さず理由を表示する。
  const error: string | null =
    n1 === null || n2 === null
      ? t('pages.general.errPositiveInt')
      : n1 >= n2
        ? t('pages.general.errOrder')
        : null

  const save = async (): Promise<void> => {
    if (n1 === null || n2 === null || n1 >= n2) return
    try {
      // mergeConfigPartial が contextUsage を 1 段深マージするため部分更新でも安全やが、
      // UI からは常に両方の値を明示して書く（画面表示と保存値の乖離を作らんため）。
      await window.api.configSet({ contextUsage: { warn1: n1, warn2: n2 } })
      setStatus('saved')
    } catch {
      /* 保存失敗時は入力値を保持 — 次の保存で再試行できる */
    }
  }

  const restoreDefaults = (): void => {
    // 入力欄へ既定値を戻すだけ。永続化は明示の「保存」で行う（誤クリックで書き込まん二段構え）。
    setWarn1(String(DEFAULT_WARN1))
    setWarn2(String(DEFAULT_WARN2))
    setStatus('restored')
  }

  const rows: {
    id: string
    labelKey: string
    value: string
    parsed: number | null
    set: (v: string) => void
  }[] = [
    {
      id: 'cug-warn1',
      labelKey: 'pages.general.warn1Label',
      value: warn1,
      parsed: n1,
      set: setWarn1
    },
    {
      id: 'cug-warn2',
      labelKey: 'pages.general.warn2Label',
      value: warn2,
      parsed: n2,
      set: setWarn2
    }
  ]

  return (
    <div className="space-y-4 max-w-xl">
      <h2 className="text-lg font-semibold">{t('pages.general.title')}</h2>
      <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-line">
        {t('pages.general.description')}
      </p>

      {rows.map(({ id, labelKey, value, parsed, set }) => (
        <div key={id} className="space-y-2">
          <Label htmlFor={id}>{t(labelKey)}</Label>
          <div className="flex items-center gap-2">
            <Input
              id={id}
              inputMode="numeric"
              value={value}
              onChange={(e) => {
                set(e.target.value)
                setStatus('idle')
              }}
              className="w-40"
            />
            <span className="text-xs text-muted-foreground">
              {t('pages.general.tokensUnit')}
              {parsed !== null ? ` = ${toK(parsed)}` : ''}
            </span>
          </div>
        </div>
      ))}

      {error !== null && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex gap-2">
        <Button onClick={() => void save()} disabled={error !== null}>
          {t('pages.general.save')}
        </Button>
        <Button variant="outline" onClick={restoreDefaults}>
          {t('pages.general.restoreDefaults')}
        </Button>
      </div>

      {status === 'saved' && (
        <p className="text-xs text-muted-foreground">{t('pages.general.saved')}</p>
      )}
      {status === 'restored' && (
        <p className="text-xs text-muted-foreground">{t('pages.general.restoredNote')}</p>
      )}
    </div>
  )
}
