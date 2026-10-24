import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Feather } from 'lucide-react'
import { Button } from './ui/button'
import {
  buildFableLaunchRequest,
  loadLaunchOptionsFor,
  resolveFableModelId,
  samePath,
  FABLE_MODEL_ID,
  type LaunchOptions
} from '../lib/launchOptions'
import { CCES_CONFIG_CHANGED_EVENT } from '../lib/ccesEnabled'
import { MODEL_CATALOG_CHANGED_EVENT } from '../lib/modelCatalogEvent'
import {
  LAUNCH_OPTIONS_CHANGED_EVENT,
  type LaunchOptionsChangedDetail
} from '../lib/launchOptionsEvent'

interface FableLaunchButtonProps {
  projectPath: string
  onLaunched?: (result: { shell: string; spawned: boolean; error?: string }) => void
  /** 特別行（038 Feature B）用: 保存済みオプションへの起動時 override。localStorage へは保存しない。 */
  optionOverrides?: Partial<LaunchOptions>
  /** wt.exe 経路のタブ色（特別行用）。ps フォールバックでは無視される。 */
  tabColor?: string
}

/**
 * 038 Feature A: ワンクリックで pxpipe 経由の Fable を起動する専用ボタン。
 * proxy 未起動の検知→自動起動は main 側 ensureProxy が担う。
 * 039 FB⑤: pxpipe prop は撤去（常時 'force'）。経路は buildFableLaunchRequest が構造保証し、
 * per-project Plug トグルに依存しない（＝Plug OFF でも Fable は必ず pxp 経由）。
 * 039 FB⑥ / 070 M4: モデル ID は正本 getScopeStatus から動的解決（未設定時 claude-fable-5）。
 */
export function FableLaunchButton({
  projectPath,
  onLaunched,
  optionOverrides,
  tabColor
}: FableLaunchButtonProps): React.JSX.Element {
  const { t } = useTranslation()
  const [launching, setLaunching] = useState(false)
  // 039 FB⑥: tooltip 表示用の実モデル ID。mount 時 + config 変更イベントで追従する。
  // 起動値は click 時に都度再解決するため、この state の鮮度は表示にしか影響しない。
  const [fableModelId, setFableModelId] = useState<string>(FABLE_MODEL_ID)

  useEffect(() => {
    const refetch = (): void => {
      // 070 M4 / 差し戻し重大2: 正本スコープ（getScopeStatus）のみから画像化範囲と fableModel を読む。
      // 旧 app-config は一切参照しない（正本一本化）。
      void Promise.all([
        window.api.pxpipe.getScopeStatus().catch(() => null),
        window.api.modelCatalogGet().catch(() => null)
      ]).then(([scopeStatus, catalog]) => {
        const opts = { ...loadLaunchOptionsFor(projectPath), ...optionOverrides }
        setFableModelId(resolveFableModelId(opts.fableVersion, catalog, scopeStatus))
      })
    }
    refetch()
    // Settings 画面での config 変更に追従（ccesEnabled と同じアプリ内イベントに相乗り）。
    window.addEventListener(CCES_CONFIG_CHANGED_EVENT, refetch)
    // 053 実装レビュー2巡目 medium [1]: モデル一覧の再取得成功にも追従
    // （tooltip の実モデル ID 表示が旧 catalog のまま陳腐化するのを防ぐ）。
    window.addEventListener(MODEL_CATALOG_CHANGED_EVENT, refetch)
    // 054 AC7: 起動メニューでの fableVersion 変更に追従（remount も hover し直しも不要）。
    // **自 PJ のイベントだけ**を拾う: 全行が無条件に追従すると、1 PJ の変更で
    // 行数 × 2 IPC（getScopeStatus + modelCatalogGet）のファンアウトになる。
    // 判定は samePath＝ストアのバケツ同定 projectKey（= normalizePathKey）と同一規則なので、
    // 区切り・末尾・大小だけが違う同一 PJ は正しく追従し、別 PJ は素通しになる。
    const onLaunchOptionsChanged = (e: Event): void => {
      const detail = (e as CustomEvent<LaunchOptionsChangedDetail>).detail
      if (!detail || !samePath(detail.projectPath, projectPath)) return
      refetch()
    }
    window.addEventListener(LAUNCH_OPTIONS_CHANGED_EVENT, onLaunchOptionsChanged)
    return () => {
      window.removeEventListener(CCES_CONFIG_CHANGED_EVENT, refetch)
      window.removeEventListener(MODEL_CATALOG_CHANGED_EVENT, refetch)
      window.removeEventListener(LAUNCH_OPTIONS_CHANGED_EVENT, onLaunchOptionsChanged)
    }
  }, [projectPath, optionOverrides])

  const handleLaunch = async (): Promise<void> => {
    setLaunching(true)
    try {
      // click 時に都度 load して LaunchMenu で編集された最新値を拾う。
      // 043: 読むのは**この行の PJ のバケツ**（起動オプションは PJ 単位）。
      // optionOverrides は起動時 merge のみ（保存しない＝保存値を汚染しない）。
      const opts = { ...loadLaunchOptionsFor(projectPath), ...optionOverrides }
      // 039 FB⑥ + 053 W-4: モデル ID も click 時に scopeStatus + catalog + fableVersion から再解決
      // （表示 state に依存しない鮮度保証）。選択バージョンが catalog に無ければ現行解決へ
      // フォールバック＝起動は壊さない（resolveFableModelId 内 fail-safe）。
      let modelId = fableModelId
      try {
        const [scopeStatus, catalog] = await Promise.all([
          window.api.pxpipe.getScopeStatus().catch(() => null),
          window.api.modelCatalogGet().catch(() => null)
        ])
        modelId = resolveFableModelId(opts.fableVersion, catalog, scopeStatus)
        setFableModelId(modelId)
      } catch {
        /* getScopeStatus 失敗時は表示中の値で起動を継続する */
      }
      const result = await window.api.ccLaunch(
        buildFableLaunchRequest(projectPath, opts, modelId, tabColor)
      )
      onLaunched?.(result)
    } finally {
      setLaunching(false)
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      className="gap-1.5 border-purple-500/50 text-purple-400 hover:bg-purple-500/10 hover:text-purple-300"
      onClick={handleLaunch}
      disabled={launching}
      title={t('pages.projects.launch.fableTitle', { model: fableModelId })}
    >
      <Feather size={14} />
      {t('pages.projects.launch.fable')}
    </Button>
  )
}
