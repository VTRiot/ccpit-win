import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Play, MoreHorizontal, Pencil, RotateCw } from 'lucide-react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator
} from './ui/dropdown-menu'
import { Checkbox } from './ui/checkbox'
import {
  PERMISSION_MODES,
  EFFORT_LEVELS,
  MODEL_PRESETS,
  DEFAULT_OPTIONS,
  loadLaunchOptionsFor,
  patchLaunchOptionsFor,
  buildFlags,
  shouldEmitResume,
  resumeBindingFor,
  resumeAfterToggle,
  resumeAfterValueInput,
  mergeModelPresets,
  detectFableVersions,
  overriddenKeys,
  parseCliDefaultModel,
  type LaunchOptions,
  type PermissionMode,
  type EffortLevel,
  type ModelCatalogLite,
  type FableScopeContext
} from '../lib/launchOptions'
import { formatCatalogTimestamp } from '../lib/catalogFormat'
import { CCES_CONFIG_CHANGED_EVENT } from '../lib/ccesEnabled'
import { MODEL_CATALOG_CHANGED_EVENT } from '../lib/modelCatalogEvent'

/** 039 Feature A: Model select の「custom…」選択を表す UI 専用 sentinel。
 * LaunchOptions.model には保存されない（custom 時は Input の自由入力値が model になる）。 */
const MODEL_CUSTOM_SENTINEL = '__custom__'

interface LaunchMenuProps {
  projectPath: string
  onLaunched?: (result: { shell: string; spawned: boolean; error?: string }) => void
  /** FSA r3 §3-1: Edit Marker メニュー項目を表示するか（Feature Flag editMarkerUI）。 */
  showEditMarker?: boolean
  /** Edit Marker クリック時のハンドラ。showEditMarker が true のとき必須。 */
  onEditMarker?: () => void
  /** Re-scan Marker クリック時のハンドラ。showEditMarker が true のとき必須。 */
  onRescanMarker?: () => void
  /** 038 Feature A: オプション popover に Fable effort select を表示するか（pxpipeToggle 配下）。 */
  showFable?: boolean
  /** 038 Feature B: 起動時のみ適用する override（特別行の add-dir / effort 既定）。保存しない。 */
  optionOverrides?: Partial<LaunchOptions>
  /** 038: pxpipe 経路指定。省略時 'auto'（per-project トグル＝従来挙動）。 */
  pxpipe?: 'auto' | 'force' | 'off'
  /** 038: wt.exe 経路のタブ色。ps フォールバックでは無視される。 */
  tabColor?: string
}

export function LaunchMenu({
  projectPath,
  onLaunched,
  showEditMarker = false,
  onEditMarker,
  onRescanMarker,
  showFable = false,
  optionOverrides,
  pxpipe,
  tabColor
}: LaunchMenuProps): React.JSX.Element {
  const { t } = useTranslation()
  const [opts, setOpts] = useState<LaunchOptions>(DEFAULT_OPTIONS)
  const [launching, setLaunching] = useState(false)
  // 039: Model select で「custom…」を選んでいるか（UI 状態のみ。保存値は opts.model）。
  const [modelCustom, setModelCustom] = useState(false)
  // 040: 動的モデルカタログ（未取得/取得失敗時は null のまま＝静的プリセットのみで従来通り動く）。
  const [catalog, setCatalog] = useState<ModelCatalogLite | null>(null)
  const modelPresets = mergeModelPresets(MODEL_PRESETS, catalog)
  // 070 M4 / 差し戻し重大2: fableVersion 選択肢は正本（getScopeStatus）から画像化範囲を読む。
  // 保存値（appConfig）の pxpipe.models / fableModel を変えても選択肢は変わらない（正本一本化）。
  const [scopeContext, setScopeContext] = useState<FableScopeContext | null>(null)
  // 053 W-4: Fable バージョン選択肢は catalog + 正本スコープから毎レンダ導出（5/5.1 等の直書き禁止。
  // catalog null でも静的既定 1 件は必ず返る＝detectFableVersions の構造保証）。
  const fableVersions = detectFableVersions(catalog, scopeContext)
  // 043: 起動時 override で**実効値が変わる**フィールド（描画時に導出。useMemo/useEffect を
  // 噛ませない＝optionOverrides の参照同一性が毎レンダ変わっても再実行ループを作らない）。
  const overriddenFields = overriddenKeys(opts, optionOverrides)
  // 043: CC 側の既定モデル（`~/.claude/settings.json` の model）。model 未指定時の出所表示にのみ使う。
  const [cliDefaultModel, setCliDefaultModel] = useState<string | null>(null)

  /**
   * 043: 読込結果を UI へ反映する単一点。
   * `modelCustom` を**読込のたびに再計算**するのが要点——ここを怠ると、PJ ごとに model が変わった
   * ときに「select にも該当 option が無く、custom 入力欄も出ない」＝保存値が UI から消える。
   * （逆に patch のたびに再計算はしない。custom 入力中の 1 文字ごとに入力欄が閉じてしまうため。）
   */
  const applyLoaded = (loaded: LaunchOptions): void => {
    setOpts(loaded)
    // 039: 保存値がプリセット外（かつ非空）なら custom 入力モードで復元する。
    setModelCustom(loaded.model !== '' && !MODEL_PRESETS.includes(loaded.model))
  }

  // 043: 起動オプションは PJ 単位。行（PJ）が変われば読み直す。
  useEffect(() => {
    applyLoaded(loadLaunchOptionsFor(projectPath))
  }, [projectPath])

  useEffect(() => {
    let cancelled = false
    const refetchCatalog = (): void => {
      void window.api
        .modelCatalogGet()
        .then((c) => {
          if (!cancelled) setCatalog(c)
        })
        .catch(() => {
          /* fail-open: 取得失敗時は静的プリセットのみ（UIエラー通知なし、R-4） */
        })
    }
    refetchCatalog()
    // 053 実装レビュー2巡目 medium [1]: Settings 系「モデル一覧を取得」の成功に追従する
    // （mount 限りだとマウント済みメニューの Fable 選択肢が陳腐化する＝AC5 違反）。
    window.addEventListener(MODEL_CATALOG_CHANGED_EVENT, refetchCatalog)
    return () => {
      cancelled = true
      window.removeEventListener(MODEL_CATALOG_CHANGED_EVENT, refetchCatalog)
    }
  }, [])

  // 070 M4 / 差し戻し重大2: 正本スコープ（getScopeStatus）に追従する。
  // 旧 app-config は参照せず、正本 DTO のみを保持する。
  useEffect(() => {
    let cancelled = false
    const refetch = (): void => {
      void window.api.pxpipe
        .getScopeStatus()
        .then((status) => {
          if (!cancelled) setScopeContext(status)
        })
        .catch(() => null)
    }
    refetch()
    window.addEventListener(CCES_CONFIG_CHANGED_EVENT, refetch)
    return () => {
      cancelled = true
      window.removeEventListener(CCES_CONFIG_CHANGED_EVENT, refetch)
    }
  }, [])

  /**
   * 043: 保存は「現在のストア値から導出する updater」でのみ行う。
   *
   * 旧実装は `{...opts, [key]: value}` の**全体スナップショット**を書いていた。PJ 単位化すると
   * これは「読んだ時点の PJ の全設定を、書く時点の PJ のバケツへ丸ごと置く」形になり、
   * 同一パスが 2 行に描画され得る本アプリでは、古い popover の塊が他方の編集（BypassMode の
   * 解除を含む）を黙って巻き戻す。updater 形は「塊を運ぶ」ことがそもそも表現できない。
   */
  const update = <K extends keyof LaunchOptions>(key: K, value: LaunchOptions[K]): void => {
    setOpts(patchLaunchOptionsFor(projectPath, () => ({ [key]: value }) as Partial<LaunchOptions>))
  }

  /**
   * 043: 入れ子フィールド（resume / addDir）の更新。**現在のストア値から遷移を導出する**
   * （`opts` の陳腐化した入れ子オブジェクトを丸ごと書き戻さないため。計画レビュー指摘 [1]）。
   */
  const updateFrom = <K extends keyof LaunchOptions>(
    key: K,
    derive: (current: LaunchOptions) => LaunchOptions[K]
  ): void => {
    setOpts(
      patchLaunchOptionsFor(
        projectPath,
        (current) => ({ [key]: derive(current) }) as Partial<LaunchOptions>
      )
    )
  }

  const handleLaunch = async (): Promise<void> => {
    setLaunching(true)
    try {
      // 043: 起動値は component state でなく**ストアから読み直す**（FableLaunchButton と流儀を統一）。
      // 同一 PJ が 2 行に描画されている場合、state は他方の編集を知らないため。
      // optionOverrides は起動時 merge のみで保存しない（特別行の既定が保存値を汚染しない）。
      // 042: 起動先 PJ を渡す。resume の所有 PJ と一致しなければ `-r` は出ない（別 PJ へのセッション
      // ID 漏出＝「No conversation found with session ID」起動失敗の再発防止）。
      const merged = { ...loadLaunchOptionsFor(projectPath), ...optionOverrides }
      const flags = buildFlags(merged, projectPath)
      const result = await window.api.ccLaunch({
        projectPath,
        flags,
        pxpipe,
        // 042: 証明は「実際に -r を出すとき」だけ添える（resumeBindingFor が同一条件で判定）。
        resumeBinding: resumeBindingFor(merged, projectPath),
        tabColor
      })
      onLaunched?.(result)
    } catch (e) {
      // 043: 旧実装は try/finally のみで、throw が握り潰され**沈黙して起動しない**（何も起きない）
      // 最悪の失敗になっていた。失敗は必ず呼び出し元へ可視化する。
      onLaunched?.({
        shell: '',
        spawned: false,
        error: e instanceof Error ? e.message : String(e)
      })
    } finally {
      setLaunching(false)
    }
  }

  return (
    <div className="flex items-center gap-1">
      <Button
        variant="default"
        size="sm"
        className="gap-1.5"
        onClick={handleLaunch}
        disabled={launching}
        title={t('pages.projects.launch.launchTitle')}
      >
        <Play size={14} />
        {t('pages.projects.launch.launch')}
      </Button>
      <DropdownMenu
        onOpenChange={(open) => {
          if (!open) return
          // 043: 開いた時点のストア値で描き直す（同一 PJ が 2 行に描画されている場合の陳腐化対策）。
          // 閉じるときは何もしない（冪等・入力中の状態を触らない）。
          applyLoaded(loadLaunchOptionsFor(projectPath))
          // 043: model 未指定時の「出所表示」用。読めなければ非表示（fail-open）。
          void window.api
            .settingsRead()
            .then((raw) => setCliDefaultModel(parseCliDefaultModel(raw)))
            .catch(() => setCliDefaultModel(null))
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            title={t('pages.projects.launch.optionsTitle')}
          >
            <MoreHorizontal size={14} />
          </Button>
        </DropdownMenuTrigger>
        {/* 039 FB①: 非フルスクリーン等の低背面高で下端が画面外に見切れる対策。Radix が算出する
            可用高さ CSS 変数で max-height を張り、あふれた分は縦スクロール（ホイール操作可）にする。 */}
        <DropdownMenuContent
          align="end"
          className="w-80 p-3 max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto"
        >
          <DropdownMenuLabel className="text-sm font-semibold">
            {t('pages.projects.launch.optionsTitle')}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />

          {/* 043: 起動オプションは **PJ 単位**（旧: 全 PJ 共通の単一キー）。行ごとに popover が開く
              以上、どの PJ を編集しているのかを誤認させないことが要件。パスを明示する。 */}
          <p className="px-1 pb-1 text-[11px] text-muted-foreground/80 break-all">
            {t('pages.projects.launch.opts.projectScopeNote', { project: projectPath })}
          </p>

          {/* 043: 特別行は起動時に override が載る（保存値は変えない）。表示値と実際に起動される
              内容の乖離を沈黙させないため、実効値が変わるフィールドだけを名指しで出す。 */}
          {overriddenFields.length > 0 && (
            <p className="px-1 pb-1 text-[11px] text-amber-500/90 break-all">
              {t('pages.projects.launch.opts.overrideNote', {
                fields: overriddenFields
                  .map((k) => t(`pages.projects.launch.opts.${k}`))
                  .join(' / ')
              })}
            </p>
          )}

          <div className="space-y-3 p-1">
            <label className="flex items-center gap-2 cursor-pointer">
              <Checkbox
                checked={opts.skipPermissions}
                onCheckedChange={(v) => update('skipPermissions', v === true)}
              />
              <span className="text-sm">{t('pages.projects.launch.opts.skipPermissions')}</span>
            </label>

            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">
                {t('pages.projects.launch.opts.permissionMode')}
              </span>
              <select
                value={opts.permissionMode}
                onChange={(e) => update('permissionMode', e.target.value as PermissionMode)}
                className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
              >
                {PERMISSION_MODES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>

            <label className="flex items-center gap-2 cursor-pointer">
              <Checkbox
                checked={opts.continueLast}
                onCheckedChange={(v) => update('continueLast', v === true)}
              />
              <span className="text-sm">{t('pages.projects.launch.opts.continueLast')}</span>
            </label>

            <div className="space-y-1">
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={opts.resume.enabled}
                  onCheckedChange={(v) =>
                    // 042: 遷移は純関数へ委譲（テストと本番で同じ経路を通す）。
                    // resumeAfterToggle は**所有者を書き換えない**——チェックの ON/OFF は
                    // 「値を入れ直した」ことを意味せず、ここで所有者を今の行へ移すと別 PJ の
                    // UUID に偽の証明が立ち、本件の失敗経路がそのまま再現する。
                    //
                    // 043: 遷移の入力を `opts.resume`（陳腐化しうる state）でなく **current**
                    // （ストアの現在値）にした。旧形だと、同一 PJ の別行が値・所有者を更新した後に
                    // こちらでチェックだけ触ると、古い resume オブジェクトごと巻き戻せてしまう。
                    //
                    // ⚠ 前提条件（候補レビュア指摘）: 本ハンドラと下の onChange は
                    // 「純関数を呼び戻り値をそのまま update へ渡す」**薄い委譲**でなければならない。
                    // 純関数のテストが守るのは遷移ロジックだけで、ハンドラが正しい入力・時機で
                    // 呼ぶことは別命題ゆえ。ここに分岐・再代入・フィールドの書き足しを入れると
                    // 単体テストの保証が黙って失効する。足すならハンドラ経路自体をテストで覆え。
                    updateFrom('resume', (current) => resumeAfterToggle(current.resume, v === true))
                  }
                />
                <span className="text-sm">{t('pages.projects.launch.opts.resume')}</span>
              </label>
              {opts.resume.enabled && (
                <>
                  <Input
                    value={opts.resume.value}
                    onChange={(e) => {
                      // 042: 所有者を刻む唯一の点＝「この行で値を入力した」瞬間。
                      const value = e.target.value
                      updateFrom('resume', (current) =>
                        resumeAfterValueInput(current.resume, value, projectPath)
                      )
                    }}
                    placeholder={t('pages.projects.launch.opts.resumePlaceholder')}
                    className="text-sm"
                  />
                  {/* 042: 落とすときは必ず理由を出す（沈黙 drop の禁止）。レビュア指摘 [4]: 値が空の
                      ときは「別 PJ の ID がある」わけではないので出さない。[5]: 所有者不明（042 前の
                      保存値）と別 PJ 束縛を別文言で出し分ける。 */}
                  {opts.resume.value.trim() !== '' &&
                    !shouldEmitResume(opts, projectPath) &&
                    (opts.resume.projectPath ? (
                      <p className="text-[11px] text-amber-500/90">
                        {t('pages.projects.launch.opts.resumeForeignProject', {
                          owner: opts.resume.projectPath
                        })}
                      </p>
                    ) : (
                      <p className="text-[11px] text-amber-500/90">
                        {t('pages.projects.launch.opts.resumeUnbound')}
                      </p>
                    ))}
                </>
              )}
            </div>

            <label className="flex items-center gap-2 cursor-pointer">
              <Checkbox
                checked={opts.verbose}
                onCheckedChange={(v) => update('verbose', v === true)}
              />
              <span className="text-sm">{t('pages.projects.launch.opts.verbose')}</span>
            </label>

            <div className="space-y-1">
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={opts.addDir.enabled}
                  onCheckedChange={(v) =>
                    // 043: 入れ子は current から導出（陳腐化した addDir を丸ごと書き戻さない）。
                    updateFrom('addDir', (current) => ({ ...current.addDir, enabled: v === true }))
                  }
                />
                <span className="text-sm">{t('pages.projects.launch.opts.addDir')}</span>
              </label>
              {opts.addDir.enabled && (
                <Input
                  value={opts.addDir.value}
                  onChange={(e) => {
                    const value = e.target.value
                    updateFrom('addDir', (current) => ({ ...current.addDir, value }))
                  }}
                  placeholder={t('pages.projects.launch.opts.addDirPlaceholder')}
                  className="text-sm font-mono"
                />
              )}
            </div>

            <label className="flex items-center gap-2 cursor-pointer">
              <Checkbox
                checked={opts.ideAutoConnect}
                onCheckedChange={(v) => update('ideAutoConnect', v === true)}
              />
              <span className="text-sm">{t('pages.projects.launch.opts.ideAutoConnect')}</span>
            </label>

            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">
                {t('pages.projects.launch.opts.effort')}
              </span>
              <select
                value={opts.effort}
                onChange={(e) => update('effort', e.target.value as EffortLevel)}
                className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
              >
                {EFFORT_LEVELS.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
            </div>

            {/* 039 Feature A: 通常起動の Model 明示指定。'' = CLI 委譲（--model 不付与＝従来挙動）。
                プリセット + custom 自由入力の併用。pxpipe と無関係の一般オプションのため showFable 非依存。 */}
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">
                {t('pages.projects.launch.opts.model')}
              </span>
              <select
                value={modelCustom ? MODEL_CUSTOM_SENTINEL : opts.model}
                onChange={(e) => {
                  const v = e.target.value
                  if (v === MODEL_CUSTOM_SENTINEL) {
                    setModelCustom(true)
                  } else {
                    setModelCustom(false)
                    update('model', v)
                  }
                }}
                className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
              >
                <option value="">{t('pages.projects.launch.opts.modelCliDefault')}</option>
                {modelPresets.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                <option value={MODEL_CUSTOM_SENTINEL}>
                  {t('pages.projects.launch.opts.modelCustom')}
                </option>
              </select>
              {modelCustom && (
                <Input
                  value={opts.model}
                  onChange={(e) => update('model', e.target.value)}
                  placeholder={t('pages.projects.launch.opts.modelCustomPlaceholder')}
                  className="text-sm font-mono"
                />
              )}
              {/* 043: model 未指定（`--model` 不付与）のとき、CC は自分の保存既定で起動する。
                  「▷ で起動したのに別モデルで上がった」という驚きの出所がここ。
                  ⚠ 断定を避け**出所（どのファイルの何というキーか）だけ**を示す——環境変数・
                  PJ 別 settings 等の上位層を CCPIT は解決していないため、「実効モデルは X」とは言えない。 */}
              {opts.model.trim() === '' && cliDefaultModel && (
                <p className="text-[11px] text-muted-foreground/70 break-all">
                  {t('pages.projects.launch.opts.modelCliDefaultHint', { model: cliDefaultModel })}
                </p>
              )}
              {/* 040 R-4: 取得日時を控えめに表示。stale時は理由も付記する（軽微指摘#4）。 */}
              {catalog && (
                <p className="text-[11px] text-muted-foreground/70">
                  {catalog.stale
                    ? t('pages.projects.launch.opts.modelCatalogStale', {
                        date: formatCatalogTimestamp(catalog.fetchedAt)
                      })
                    : t('pages.projects.launch.opts.modelCatalogFetched', {
                        date: formatCatalogTimestamp(catalog.fetchedAt)
                      })}
                </p>
              )}
            </div>

            {/* 038 承認P③(a): Fable 起動の effort（既定 max・変更可）。Fable ボタンと同じ
                pxpipeToggle 配下でのみ表示する。 */}
            {showFable && (
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">
                  {t('pages.projects.launch.opts.fableEffort')}
                </span>
                <select
                  value={opts.fableEffort}
                  onChange={(e) => update('fableEffort', e.target.value as EffortLevel)}
                  className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
                >
                  {EFFORT_LEVELS.map((e) => (
                    <option key={e} value={e}>
                      {e}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* 053 W-4: Fable 起動バージョン（PJ 単位・'' = 既定）。選択肢は catalog 由来＝
                次 minor が catalog に載れば無改修で現れる。保存はバージョン文字列（ID でなく）
                ＝catalog 更新で正準 ID が変わっても選択が追従する。 */}
            {showFable && (
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">
                  {t('pages.projects.launch.opts.fableVersion')}
                </span>
                <select
                  value={opts.fableVersion}
                  onChange={(e) => update('fableVersion', e.target.value)}
                  className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
                >
                  <option value="">{t('pages.projects.launch.opts.fableVersionDefault')}</option>
                  {fableVersions.map((o) => (
                    <option key={o.label} value={o.label} title={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
                {/* 選択が現 catalog で解決できない（保存後に catalog から消えた）場合の注意書き。
                    起動自体は現行解決へフォールバックする（resolveFableModelId の fail-safe）。 */}
                {opts.fableVersion !== '' &&
                  !fableVersions.some((o) => o.label === opts.fableVersion) && (
                    <p className="text-[11px] text-muted-foreground/70">
                      {t('pages.projects.launch.opts.fableVersionMissing', {
                        version: opts.fableVersion
                      })}
                    </p>
                  )}
              </div>
            )}
          </div>

          {showEditMarker && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => onEditMarker?.()} className="cursor-pointer gap-2">
                <Pencil size={14} />
                {t('launchMenu.editMarker')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => onRescanMarker?.()}
                className="cursor-pointer gap-2"
              >
                <RotateCw size={14} />
                {t('launchMenu.rescanMarker')}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
