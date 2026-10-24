import { useState, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Button } from '../ui/button'
import {
  MODEL_PRESETS,
  EFFORT_LEVELS,
  PERMISSION_MODES,
  mergeModelPresets,
  type ModelCatalogLite
} from '../../lib/launchOptions'
import { announceModelCatalogChanged } from '../../lib/modelCatalogEvent'

/**
 * SkillProposal の「CC と対話する」で起動する CC の設定（**全提案共通の 1 設定**）。
 *
 * 既存資産をそのまま使い、車輪を作り直さない:
 *   - `MODEL_PRESETS` / `EFFORT_LEVELS`（`lib/launchOptions.ts`）
 *   - `PxpipeMode = 'auto' | 'force' | 'off'`（真偽値を新造しない）
 * モデル ID は経年で変わるので、**プリセットに加えて自由入力の逃げ道も併設**する。
 *
 * 永続先は `app-config.json` の `skillProposals`。既存の汎用 `configGet` / `configSet`
 * （深マージ）へ相乗りし、**専用 IPC を作らない**（並行作業中の共有ファイル改変面を増やさないため）。
 */
export interface DialogueSettingsDialogProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  L: (j: string, e: string) => string
}

type Pxpipe = 'auto' | 'force' | 'off'

export function DialogueSettingsDialog({
  open,
  onOpenChange,
  L
}: DialogueSettingsDialogProps): React.JSX.Element {
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState<string>('medium')
  const [pxpipe, setPxpipe] = useState<Pxpipe>('auto')
  const [permissionMode, setPermissionMode] = useState<string>('default')
  const [skipPermissions, setSkipPermissions] = useState(false)
  /**
   * モデル候補は **Projects の起動メニューと同じ経路**で作る（maintainer指示 2026-08-08）。
   * 静的 `MODEL_PRESETS` ∪ 動的カタログ（`tier==='current'` のみ）＝ `mergeModelPresets`。
   * ここで独自の一覧を持つと、新モデルが出たとき Projects では選べるのに提案側では選べない、
   * という乖離が生まれる。**合成関数を再実装せず共有する**のが要点。
   * カタログ取得失敗は fail-open（静的のみ）で、LaunchMenu と同じ挙動にする。
   */
  const [catalog, setCatalog] = useState<ModelCatalogLite | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const modelPresets = mergeModelPresets(MODEL_PRESETS, catalog)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // 開くたびに現在値を読み直す（別レーンや直接編集で変わっている可能性がある）
  useEffect(() => {
    if (!open) return
    setErr(null)
    window.api
      .configGet()
      .then((cfg) => {
        const s = (
          cfg as {
            skillProposals?: {
              model?: string
              effort?: string
              pxpipe?: Pxpipe
              permissionMode?: string
              skipPermissions?: boolean
            }
          }
        ).skillProposals
        setModel(s?.model ?? '')
        setEffort(s?.effort ?? 'medium')
        setPxpipe(s?.pxpipe ?? 'auto')
        setPermissionMode(s?.permissionMode ?? 'default')
        // 厳密比較（finding#2）。手編集で "false" 等が入っても危険側を有効化しない
        setSkipPermissions(s?.skipPermissions === true)
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
    // モデルカタログも開くたびに取り直す（fail-open: 失敗しても静的プリセットで動く）。
    // **遅れて返った古い応答で新しい結果を上書きしない**（finding#5: 手動更新とレースする）。
    let cancelled = false
    window.api
      .modelCatalogGet()
      .then((c) => {
        if (!cancelled) setCatalog(c as ModelCatalogLite | null)
      })
      .catch(() => {
        /* fail-open（LaunchMenu と同じ扱い。UI エラーにしない） */
      })
    return () => {
      cancelled = true
    }
  }, [open])

  /** カタログを能動更新する（新モデルが出たとき「選べない」で詰まらせないための導線） */
  const refreshCatalog = async (): Promise<void> => {
    setRefreshing(true)
    try {
      const c = await window.api.modelCatalogRefresh()
      setCatalog(c as ModelCatalogLite | null)
      // 053 実装レビュー2巡目 medium [1]: 取得成功をマウント済み購読者へ伝搬（失敗時は通知しない）。
      // 054 以降は bus 経由（summary → useBgccActivity）とで二重発火になるが、再読は冪等で
      // bus 経路欠落時の保険として意図的に残す（SettingsDialog.tsx と同じ扱い）。
      if (c) announceModelCatalogChanged()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setRefreshing(false)
    }
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setErr(null)
    try {
      // 深マージなので skillProposals だけを渡せば他キーは保持される
      await window.api.configSet({
        skillProposals: { model, effort, pxpipe, permissionMode, skipPermissions }
      } as never)
      onOpenChange(false)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{L('提案の対話 CC 設定', 'Proposal dialogue CC settings')}</DialogTitle>
          <DialogDescription>
            {L(
              'SkillProposal 全件に共通の設定です。',
              'A single setting shared across all skill proposals.'
            )}
          </DialogDescription>
        </DialogHeader>

        {/* 設定だけあって何に効くか分からない状態を作らない（設計 §3-6, CCPIT_061 AC7） */}
        <div className="text-xs rounded p-2 bg-blue-500/10 text-blue-700 space-y-0.5">
          <div>
            {L('効く: ', 'Applies to: ')}
            <b>
              {L(
                '「CC を起動して応答させる」／「Claude Code に修復を依頼」',
                '"Launch CC to respond" / "Ask Claude Code to repair"'
              )}
            </b>
          </div>
          <div>
            {L('効かない: ', 'Does NOT apply to: ')}
            {L(
              '「依頼文をコピー」（起動しないので起動引数が無い）／ Codex レビュー実行（レビュアー側の設定）',
              '"Copy request" (no launch = no launch arguments) / Codex review (that is the reviewer\'s own setting)'
            )}
          </div>
        </div>

        <div className="space-y-3 text-sm">
          <div>
            <div className="mb-1 flex items-center gap-2">
              <span>{L('モデル', 'Model')}</span>
              <span className="text-[11px] text-muted-foreground">
                {catalog
                  ? catalog.stale
                    ? L('カタログ: 古い可能性', 'catalog: possibly stale')
                    : L(
                        `カタログ: ${catalog.models.length} 件`,
                        `catalog: ${catalog.models.length}`
                      )
                  : L('カタログ未取得（静的一覧のみ）', 'no catalog (static list only)')}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[11px] ml-auto"
                disabled={refreshing}
                title={L(
                  '最新モデル一覧を取り直す（Projects の起動メニューと同じカタログ）',
                  'Re-fetch the model catalog (the same one the Projects launch menu uses)'
                )}
                onClick={() => void refreshCatalog()}
              >
                {refreshing ? L('更新中…', 'refreshing…') : L('一覧を更新', 'Refresh list')}
              </Button>
            </div>
            <select
              className="w-full px-2 py-1 border border-border rounded bg-background text-sm"
              value={modelPresets.includes(model) || model === '' ? model : '__custom__'}
              onChange={(e) => setModel(e.target.value === '__custom__' ? model : e.target.value)}
            >
              <option value="">{L('（CLI に委ねる）', '(delegate to CLI)')}</option>
              {modelPresets.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              <option value="__custom__">{L('カスタム（下に入力）', 'Custom (type below)')}</option>
            </select>
            {/* モデル ID は経年で変わる。プリセットに無い ID を入れる逃げ道を常設する */}
            <input
              className="w-full mt-1 px-2 py-1 border border-border rounded bg-background text-sm font-mono"
              placeholder={L(
                'カスタムモデル ID（空ならプリセット/CLI 委譲）',
                'Custom model ID (empty = preset / delegate to CLI)'
              )}
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
          </div>

          <div>
            <div className="mb-1">{L('推論の深さ（effort）', 'Reasoning effort')}</div>
            <select
              className="w-full px-2 py-1 border border-border rounded bg-background text-sm"
              value={effort}
              onChange={(e) => setEffort(e.target.value)}
            >
              {EFFORT_LEVELS.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
            <div className="text-[11px] text-muted-foreground mt-0.5">
              {L(
                'medium は既定なので起動引数に付与されません（CC 側の既定に委ねます）。',
                'medium is the default and is not passed as a flag (delegated to CC).'
              )}
            </div>
          </div>

          <div>
            <div className="mb-1">{L('権限モード', 'Permission mode')}</div>
            <select
              className="w-full px-2 py-1 border border-border rounded bg-background text-sm"
              value={permissionMode}
              onChange={(e) => setPermissionMode(e.target.value)}
            >
              {PERMISSION_MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <div className="text-[11px] text-muted-foreground mt-0.5">
              {L(
                'plan = 計画モードで起動（まず調べて計画を出す）。default は CLI 既定に委ねます。',
                'plan = start in planning mode (investigate and propose first). default is delegated to the CLI.'
              )}
            </div>
          </div>

          {/* 危険側は既定 false・明示操作でのみ有効化し、何が起きるかを文言で明記する */}
          <div>
            <label className="flex items-start gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                className="mt-1"
                checked={skipPermissions}
                onChange={(e) => setSkipPermissions(e.target.checked)}
              />
              <span>
                <span className="text-red-600 font-medium">
                  {L(
                    'デンジャラスモード（--dangerously-skip-permissions）',
                    'Dangerous mode (--dangerously-skip-permissions)'
                  )}
                </span>
                <span className="block text-[11px] text-muted-foreground">
                  {L(
                    '対話 CC が確認を出さずにファイル変更・コマンド実行を行います。提案の改稿を止めずに回したいとき用。既定 OFF。',
                    'The dialogue CC edits files and runs commands without asking. For letting revisions run uninterrupted. Off by default.'
                  )}
                </span>
              </span>
            </label>
          </div>

          <div>
            <div className="mb-1">{L('PXP（pxpipe 中継）', 'PXP (pxpipe relay)')}</div>
            <select
              className="w-full px-2 py-1 border border-border rounded bg-background text-sm"
              value={pxpipe}
              onChange={(e) => setPxpipe(e.target.value as Pxpipe)}
            >
              <option value="auto">auto</option>
              <option value="force">force</option>
              <option value="off">off</option>
            </select>
          </div>
        </div>

        {err && <div className="text-xs rounded p-2 bg-red-500/15 text-red-700">{err}</div>}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
            {L('キャンセル', 'Cancel')}
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={saving}>
            {saving ? L('保存中…', 'saving…') : L('保存', 'Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
