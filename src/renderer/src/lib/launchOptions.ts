import { normalizePathKey } from './pathKey'
// 053 W-3: モデル ID 構文解析は shared 単一ソース（main contextWindow.ts と同一実装を import
// ＝同型正規表現の二重化を構造で禁止）。
import { parseModelId, type ParsedModelId } from '../../../shared/modelId'
// 054 AC7: 起動オプション変更をマウント済み UI へ伝える。書き手（本ファイル）から通知しないと
// 同一 renderer 内では 'storage' イベントが飛ばず、表示が remount まで陳腐化する。
import { announceLaunchOptionsChanged } from './launchOptionsEvent'

/**
 * 043: **旧**の全 PJ 共通キー。production からは二度と読まない。
 *
 * maintainer裁定 (c)「旧グローバル保存値は自動移行しない」を**構造で**満たすための改名である
 * （移行すると全 PJ が旧 BypassMode を継承し、裁定の趣旨に正面から反する）。
 * 値そのものは**削除しない**——不可逆操作を避け、手動復旧の余地を残すため。
 * export しているのは回帰テスト（旧キーに値があっても実効値へ流入しないことの検査）から
 * 参照するためだけで、production コードでの再利用は禁止。
 */
export const LEGACY_LAUNCH_OPTIONS_STORAGE_KEY = 'ccpit-launch-options'

/** 043: PJ 単位ストアのキー。 */
export const LAUNCH_OPTIONS_BY_PROJECT_STORAGE_KEY = 'ccpit-launch-options-by-project'

/** 043: ストア形式のバージョン。未知の値は「読めない」＝空ストア扱い（全 PJ 既定値＝fail-safe）。 */
export const LAUNCH_OPTIONS_STORE_VERSION = 1

export const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'dontAsk',
  'bypassPermissions'
] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

/** Fable 起動ボタン（038 Feature A）が `--model` に渡すモデル ID の既定値。
 * CLI 2.1.185 で受理実測済み（invalid 値エラー法 + セッション JSONL 物理証拠）。
 * 039 FB⑥: appConfig `pxpipe.fableModel` 未設定時のフォールバックへ降格
 * （正規の解決点は getFableModelId）。 */
export const FABLE_MODEL_ID = 'claude-fable-5'

/**
 * 039 FB⑥: Fable モデル ID の動的解決（040 モデル更新機構の受け口）。
 * appConfig `pxpipe.fableModel` が設定されていればそれを、無ければ FABLE_MODEL_ID を返す。
 * 040 側は proxy 横取り対象（pxpipe.models）と本フィールドを併せて更新すること
 * （片方だけ変えると「--model は新 ID / proxy は旧 ID のみ横取り」のミスマッチで pxp 素通しになる）。
 */
export function getFableModelId(cfg?: FableScopeInput): string {
  if (!cfg || Array.isArray(cfg)) return FABLE_MODEL_ID
  const candidate = (cfg as FableScopeContext)?.fableModel
  const configured = candidate?.trim()
  return configured ? configured : FABLE_MODEL_ID
}

/** 039 Feature A: Model select のプリセット候補（網羅ではなく日常操作の利便目的）。
 * モデル ID は経年で変わり得るため、UI 側に custom 自由入力の逃げ道を併設する。
 * 出典: 実行環境が提示する現行 Claude モデル ID（2026-09 時点）+ FABLE_MODEL_ID。
 *
 * mergeModelPresets は本リストと動的カタログの**和集合**を返す（本リストは catalog 取得
 * 失敗時だけ使われるフォールバックではない）。よって catalog が正常でも本リストは常に
 * 選択肢に残り、古いまま放置すると catalog 失敗時に「現行世代を一つも選べない」状態が
 * 露出する。更新は**追記のみ**とし削除はしない — 削除は catalog 失敗時に選べるモデルを
 * 減らす後退であり、旧世代も current として catalog に載り続けている間は実害がない。 */
export const MODEL_PRESETS: readonly string[] = [
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
  FABLE_MODEL_ID
]

export interface LaunchOptions {
  skipPermissions: boolean
  permissionMode: PermissionMode
  continueLast: boolean
  /**
   * 042: セッション ID は **PJ 固有の識別子**（CLI は `~/.claude/projects/<cwd 由来 slug>/<uuid>.jsonl`
   * を cwd 単位で解決する）。本 store は全 PJ 共通の単一 localStorage キーに住むため、`projectPath`
   * で「どの PJ 向けに入れた値か」を束縛し、別 PJ の起動へ載らないようにする（shouldEmitResume）。
   * 未定義（042 以前の保存値）は所有者不明＝fail-closed で `-r` を出さない。
   */
  resume: { enabled: boolean; value: string; projectPath?: string }
  verbose: boolean
  addDir: { enabled: boolean; value: string }
  ideAutoConnect: boolean
  effort: EffortLevel
  /** Fable 起動ボタン専用の effort（038 承認P③(a): 既定 max・変更可）。通常起動の effort とは独立。 */
  fableEffort: EffortLevel
  /** 039 Feature A: 通常起動の明示 Model ID。'' = CLI 委譲（--model 不付与＝従来挙動）。 */
  model: string
  /**
   * 053 W-4: Fable 起動ボタンのバージョン選択（PJ 単位）。'' = 既定（現行解決＝getFableModelId）。
   * 値は detectFableVersions の label（例 '5.1'）。ID でなくバージョン文字列で保存するのは、
   * catalog 更新で同一バージョンの正準 ID（日付 suffix 付与等）が変わっても選択が追従するため。
   * 解決は resolveFableModelId（未解決時は現行解決へフォールバック＝起動を壊さない向き）。
   */
  fableVersion: string
}

export const DEFAULT_OPTIONS: LaunchOptions = {
  skipPermissions: false,
  permissionMode: 'default',
  continueLast: false,
  resume: { enabled: false, value: '' },
  verbose: false,
  addDir: { enabled: false, value: '' },
  ideAutoConnect: false,
  effort: 'medium',
  // 既存 localStorage 保存値には fableEffort が無いが、loadLaunchOptions の
  // {...DEFAULT_OPTIONS, ...parsed} マージで自動バックフィルされる（migration 不要）。
  fableEffort: 'max',
  // 039: model も同じバックフィルで補完される。'' = CLI 委譲＝未設定ユーザーの挙動は完全に現状維持。
  model: '',
  // 053: fableVersion も同じバックフィルで補完される（migration 不要・STORE_VERSION 据置）。
  // '' = 既定（現行解決）＝未設定ユーザーの Fable 起動は完全に現状維持。
  fableVersion: ''
}

/* ────────────────────────────────────────────────────────────────────────────
 * 043: 起動オプションの PJ 単位ストア
 *
 * 背景（maintainer裁定 2026-08-18）: 旧実装は全オプションを**全 PJ 共通の単一キー**に保存していた。
 * 042 で `resume` だけは PJ 束縛したが、`skipPermissions`（BypassMode）・`continueLast`・`addDir`・
 * `model` は依然として全 PJ へ黙って継承されていた。CCPIT の命題「AI の暴走を防ぎ、かつ PJ の
 * 貫通率を最大化する」に対し、**意図しない Bypass 継承はコンセプト違反**。
 *
 * 設計判断（実装内で覆さない）:
 *   (a) 全フィールドを PJ 単位。危険フィールドだけの例外化はしない
 *       ——本件の真因が「1 フィールドだけ中和し忘れた例外の穴」だったため。
 *   (b) 未登録 PJ は DEFAULT_OPTIONS から開始（継承ゼロ・skipPermissions 既定 false）。
 *   (c) 旧グローバル値は自動移行しない（LEGACY_… の doc 参照）。
 *   (d) 042 の resume 束縛（renderer 判定 + main backstop の二層防御）は撤去・緩和しない。
 * ──────────────────────────────────────────────────────────────────────────── */

export interface LaunchOptionsStore {
  version: number
  /** キーは `projectKey()` で正規化した PJ パス。値は保存時点のオプション。 */
  byProject: Record<string, Partial<LaunchOptions>>
}

function emptyStore(): LaunchOptionsStore {
  return { version: LAUNCH_OPTIONS_STORE_VERSION, byProject: {} }
}

/**
 * ストアのマップキー。**`samePath` と同一の正規化器**を使う（`pathKey.ts`）。
 *
 * キーと比較器がズレると、「popover は別 PJ と判定するのにバケツは同一（またはその逆）」という
 * 判定不一致が起き、042 の resume 束縛と食い違う。同一性の定義は 1 箇所に閉じること。
 */
export function projectKey(projectPath: string): string {
  return normalizePathKey(projectPath)
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function coerceBool(v: unknown, fallback: boolean): boolean {
  // 文字列 "true" 等の truthy を通さない。危険フラグを素朴な truthy 判定で立てないため。
  return typeof v === 'boolean' ? v : fallback
}

function coerceEnum<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
}

function coerceStr(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback
}

/**
 * 保存値 → `LaunchOptions` の**深さ対応**の型強制（欠損は DEFAULT_OPTIONS でバックフィル）。
 *
 * なぜ浅い spread では駄目か: 旧実装は `{...DEFAULT_OPTIONS, ...parsed}` の浅いマージだったため、
 * 壊れた入れ子（例 `addDir` が文字列）がそのまま生き残り、`buildFlags` の
 * `opts.addDir.value.split(',')` が throw する。その throw は起動ハンドラで握り潰され
 * **沈黙して起動しない**（何も起きない）という最悪の失敗になる。
 *
 * 不変条件: `resume.projectPath`（所有 PJ）を**バケツのキーから導出しない**。導出すると
 * 誤配置された値まで「証明済み」に洗浄され、042 の二層防御が中身だけ空洞化する。
 * ここでは「文字列であるときだけ持ち越す」に留める。
 */
export function coerceOptions(partial: unknown): LaunchOptions {
  const p = isPlainObject(partial) ? partial : {}
  const resumeRaw = isPlainObject(p.resume) ? p.resume : {}
  const addDirRaw = isPlainObject(p.addDir) ? p.addDir : {}
  const owner = resumeRaw.projectPath
  return {
    skipPermissions: coerceBool(p.skipPermissions, DEFAULT_OPTIONS.skipPermissions),
    permissionMode: coerceEnum(p.permissionMode, PERMISSION_MODES, DEFAULT_OPTIONS.permissionMode),
    continueLast: coerceBool(p.continueLast, DEFAULT_OPTIONS.continueLast),
    resume: {
      enabled: coerceBool(resumeRaw.enabled, DEFAULT_OPTIONS.resume.enabled),
      value: coerceStr(resumeRaw.value, DEFAULT_OPTIONS.resume.value),
      ...(typeof owner === 'string' ? { projectPath: owner } : {})
    },
    verbose: coerceBool(p.verbose, DEFAULT_OPTIONS.verbose),
    addDir: {
      enabled: coerceBool(addDirRaw.enabled, DEFAULT_OPTIONS.addDir.enabled),
      value: coerceStr(addDirRaw.value, DEFAULT_OPTIONS.addDir.value)
    },
    ideAutoConnect: coerceBool(p.ideAutoConnect, DEFAULT_OPTIONS.ideAutoConnect),
    effort: coerceEnum(p.effort, EFFORT_LEVELS, DEFAULT_OPTIONS.effort),
    fableEffort: coerceEnum(p.fableEffort, EFFORT_LEVELS, DEFAULT_OPTIONS.fableEffort),
    model: coerceStr(p.model, DEFAULT_OPTIONS.model),
    fableVersion: coerceStr(p.fableVersion, DEFAULT_OPTIONS.fableVersion)
  }
}

/** 生文字列 → ストア。読めない／未知 version は**空ストア**（＝全 PJ 既定値・fail-safe）。 */
export function parseStore(raw: string | null | undefined): LaunchOptionsStore {
  if (typeof raw !== 'string' || raw === '') return emptyStore()
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isPlainObject(parsed)) return emptyStore()
    if (parsed.version !== LAUNCH_OPTIONS_STORE_VERSION) return emptyStore()
    if (!isPlainObject(parsed.byProject)) return emptyStore()
    const byProject: Record<string, Partial<LaunchOptions>> = {}
    // Object.entries は own enumerable のみ＝prototype 経由の混入を拾わない。
    for (const [key, value] of Object.entries(parsed.byProject)) {
      if (isPlainObject(value)) byProject[key] = value as Partial<LaunchOptions>
    }
    return { version: LAUNCH_OPTIONS_STORE_VERSION, byProject }
  } catch {
    return emptyStore()
  }
}

/** 未登録 PJ は `DEFAULT_OPTIONS`（裁定 (b)＝継承ゼロ）。空・空白のみのパスも既定へ倒す。 */
export function selectProjectOptions(
  store: LaunchOptionsStore,
  projectPath: string
): LaunchOptions {
  const key = projectKey(projectPath)
  if (key === '') return DEFAULT_OPTIONS
  if (!Object.prototype.hasOwnProperty.call(store.byProject, key)) return DEFAULT_OPTIONS
  return coerceOptions(store.byProject[key])
}

/**
 * 043: 書き込みは**現在値から導出する updater** でしか行えない。
 *
 * なぜ「オプションの塊」を受け取らないか（計画レビュー指摘 [1]）: 塊を渡す API だと、
 * 呼び出し側が持つ**読んだ時点のスナップショット**が、書く時点の PJ のバケツへ丸ごと着地する。
 * 同一パスが 2 行に描画され得る本アプリでは、古い popover の塊が他方の編集（BypassMode の
 * 解除を含む）を黙って巻き戻す——本件で潰したい事象と同型。`resume` / `addDir` のような
 * 入れ子も同じ罠を持つため、**遷移は必ず `current` から導出**させる。
 */
export type LaunchOptionsUpdater = (current: LaunchOptions) => Partial<LaunchOptions>

export function withProjectPatch(
  store: LaunchOptionsStore,
  projectPath: string,
  update: LaunchOptionsUpdater
): LaunchOptionsStore {
  const key = projectKey(projectPath)
  // 空・空白のみのパスでは書かない。書くと全 PJ 共通の「共有バケツ」が復活する（本件の再来）。
  if (key === '') return store
  const current = selectProjectOptions(store, projectPath)
  const next = coerceOptions({ ...current, ...update(current) })
  return {
    version: LAUNCH_OPTIONS_STORE_VERSION,
    byProject: { ...store.byProject, [key]: next }
  }
}

/**
 * 043: PJ を一覧から削除したときにそのバケツを捨てる。
 *
 * 「未登録 PJ は DEFAULT_OPTIONS」(b) は、削除→再登録でも成立していなければ意味がない
 * （さもないと BypassMode:true が黙って蘇る）。
 * 引数は**削除された 1 パスのみ**。「残す一覧」を受け取る形にしないのは、一覧が一時的に空の
 * 瞬間（読み込み中・取得失敗）に全消しできてしまう形を**そもそも表現させない**ため。
 */
export function pruneRemovedProject(
  store: LaunchOptionsStore,
  removedPath: string
): LaunchOptionsStore {
  const key = projectKey(removedPath)
  if (key === '' || !Object.prototype.hasOwnProperty.call(store.byProject, key)) return store
  const byProject = { ...store.byProject }
  delete byProject[key]
  return { version: LAUNCH_OPTIONS_STORE_VERSION, byProject }
}

/* ── localStorage 薄ラッパ ──────────────────────────────────────────────────
 * 前提: `window.api` を持つ renderer は同時に 1 つだけ（起動時に main window 1 枚、splash は
 * preload 無し、`createWindow()` は窓ゼロ時の activate のみ）。単一 renderer 内で JS は
 * 単一スレッドゆえ、read-modify-write は他ハンドラに対し不可分に見える。
 * **preload 付きの窓を 2 枚以上同時に開く変更を入れるときは、この前提が崩れる**
 * （main 集約 IPC か revision 付き compare/retry へ格上げが要る）。
 * ────────────────────────────────────────────────────────────────────────── */

function readStore(): LaunchOptionsStore {
  try {
    return parseStore(localStorage.getItem(LAUNCH_OPTIONS_BY_PROJECT_STORAGE_KEY))
  } catch {
    return emptyStore()
  }
}

function writeStore(store: LaunchOptionsStore): void {
  try {
    localStorage.setItem(LAUNCH_OPTIONS_BY_PROJECT_STORAGE_KEY, JSON.stringify(store))
  } catch {
    // localStorage 不可環境（プライベートモード等）・容量超過では永続化を諦める
    // （projectsView.saveProjectsViewState と同じ流儀。ここで throw すると
    //  チェックボックスの onChange から ErrorBoundary へ飛んで画面が落ちる）。
  }
}

/** 指定 PJ の実効オプション。未登録なら DEFAULT_OPTIONS。 */
export function loadLaunchOptionsFor(projectPath: string): LaunchOptions {
  return selectProjectOptions(readStore(), projectPath)
}

/**
 * 指定 PJ のオプションを read-modify-write で更新し、**実際に永続化されている値**を返す。
 *
 * 043 実装レビュー指摘 [4]: 計算結果（`next`）をそのまま返してはならない。`writeStore` は
 * 容量超過・プライベートモード等の失敗を握り潰す（そこで throw すると checkbox の onChange から
 * ErrorBoundary へ飛んで画面が落ちるため）。一方、起動経路は**ストアを読み直して**flags を組む。
 * よって計算結果を返すと、書込失敗時に
 *   「popover は BypassMode 解除済みと表示 / 実際の起動は `--dangerously-skip-permissions` 付き」
 * という**最も危険な向きの乖離**が起きる。
 *
 * 書込後に読み直して返せば、失敗時はチェックが元の値へ戻る＝ユーザーに「反映されていない」ことが
 * 見え、かつ表示値と起動値が常に一致する。
 *
 * 054 AC7: 実際に値が変わったときだけ書込＋通知する。判定に `next !== store` は**使えない**——
 * `withProjectPatch` は空パス以外では常に新しい store オブジェクトを生成する（:253-256）ので、
 * 参照比較は「パスが空でないか」しか見ておらず、同値 patch でも真になる。よって
 * `selectProjectOptions` の before / after を値比較する。`after` は永続値でなく in-memory の `next`
 * から導出するため、比較・通知は writeStore の成否と無関係（fail-quiet な writeStore の後で無条件に announce）。
 * 購読側は永続値を読み直すので、書込が失敗していれば表示は元の値へ戻る＝上記「表示値と
 * 起動値が常に一致」の向きが AC7 の伝搬経路でも保たれる。
 */
export function patchLaunchOptionsFor(
  projectPath: string,
  update: LaunchOptionsUpdater
): LaunchOptions {
  const store = readStore()
  const before = selectProjectOptions(store, projectPath)
  const next = withProjectPatch(store, projectPath, update)
  const after = selectProjectOptions(next, projectPath)
  if (next !== store && !deepEqual(before, after)) {
    writeStore(next)
    announceLaunchOptionsChanged(projectPath)
  }
  return loadLaunchOptionsFor(projectPath)
}

/** 一覧から削除された PJ のバケツを捨てる。 */
export function pruneLaunchOptionsFor(removedPath: string): void {
  const store = readStore()
  const next = pruneRemovedProject(store, removedPath)
  if (next !== store) writeStore(next)
}

/**
 * 043 実装レビュー指摘 [1]: 同一パスが特別行と通常行の双方に描画されうる（両リストは相互
 * dedupe していない）。両行は同じバケツを共有するため、片方の行を消しただけでバケツを捨てると、
 * **残っている行の設定まで初期化される**（BypassMode の意図的な設定も消える）。
 *
 * よって削除は「同一パスを指す行が 1 つも残っていない（＝孤児になった）」ときに限る。
 * 判定を純関数に切り出してあるのは、UI 経路をテストできない（jsdom 無し）環境で、
 * 判定そのものは単体で固定するため。
 *
 * ⚠ 044 で**描画は一本化された**（`specialEntries.planProjectRows` が特別行を唯一の描画サイトに
 * する）。だが本判定を「もう 2 行にはならないから不要」と読んで撤去してはならない。044 が断ったのは
 * *描画*であって*データ*ではなく、同一バケツを指す経路は今も複数ある:
 *   - `app-config.json` の手編集で同一パスの特別枠が複数並ぶ（UI 追加経路の重複判定は通らない）
 *   - 特別枠と通常行に同一パスが**登録されたまま**（044 はデータを消さない＝可逆であることが要件）
 *   - `projects.json` 側の重複（`importProjects` の既存判定は生文字列の `toLowerCase()` 比較）
 * つまり「片方を消したら他方が巻き添え」の条件は健在で、本関数は保険として必要である。
 * 044 の回帰テストも `launchOptions.test.ts` の「044:」系で本判定に依存している。
 */
export function isOrphanProjectPath(
  removedPath: string,
  remainingPaths: readonly string[]
): boolean {
  const key = projectKey(removedPath)
  if (key === '') return false
  return !remainingPaths.some((p) => projectKey(p) === key)
}

/**
 * 043: 主プロセスの「どのパスを消したか」の照合規則。**主プロセスの実装の写し**である。
 *
 * `projects.ts` は削除経路ごとに規則が違う（実測）:
 *   - `removeProject`（単体削除）        : `p.path !== projectPath` ＝ **完全一致**
 *   - `removeProjectsFromList`（一括削除）: `toLowerCase()` の集合比較 ＝ **大小非依存**
 */
export type RemovalMatch = 'exact' | 'caseInsensitive'

/**
 * 043 実装レビュー指摘 [2][3]: 削除後に残る行のパス一覧を、**主プロセスと同じ規則で**算出する。
 *
 * ここがズレると、どちらの向きにも実害が出る:
 *   - renderer が厳しすぎる（主は消したのに残っていると誤認）
 *     → 孤児バケツが残り、再登録時に BypassMode 等が黙って蘇る（裁定 (b) 違反）。
 *   - renderer が緩すぎる（主は残したのに消えたと誤認）
 *     → **生きている行のバケツを削除**し、その行の設定が黙って初期値へ戻る。
 *       バケツは残存行と共有されているので「孤児」ではなく、fail-safe とは呼べない。
 *
 * よって「正規化を強めれば安全」ではない。**主の規則をそのまま写す**のが唯一の正解。
 * ⚠ `projects.ts` の削除実装を変えるときは本関数と呼び出し側の `match` も同時に直すこと。
 */
export function remainingAfterRemoval(
  allPaths: readonly string[],
  removedPaths: readonly string[],
  match: RemovalMatch
): string[] {
  if (match === 'exact') {
    const removed = new Set(removedPaths)
    return allPaths.filter((p) => !removed.has(p))
  }
  const removed = new Set(removedPaths.map((p) => p.toLowerCase()))
  return allPaths.filter((p) => !removed.has(p.toLowerCase()))
}

/** 孤児になったときだけバケツを捨てる（`isOrphanProjectPath` の doc 参照）。 */
export function pruneLaunchOptionsIfOrphan(
  removedPath: string,
  remainingPaths: readonly string[]
): void {
  if (isOrphanProjectPath(removedPath, remainingPaths)) pruneLaunchOptionsFor(removedPath)
}

/**
 * 042: Windows パスの同一判定。区切り（`/`→`\`）・末尾区切り・大文字小文字を正規化して比較する。
 *
 * 比較対象は**いずれも本アプリが保存している PJ パス文字列**（projects.json の `project.path` /
 * appConfig の `entry.path`）で、束縛時と起動時で同一の prop を読む。よって realpath 解決
 * （junction / 8.3 / UNC / ネットワークドライブの同一視）は**意図的に行わない**:
 *   - 純関数へ同期 FS I/O を持ち込み、不在・権限拒否で throw する経路を作る
 *   - 「同じ文字列が両側に来る」唯一の実シナリオを助けない（差が出るのは区切りと大小のみ）
 * 主プロセス側は `normalize()` 済みパスで検証するため、区切り・末尾差の吸収は必要。
 */
export function samePath(a: string, b: string): boolean {
  // 043: 正規化は `projectKey`（= pathKey.normalizePathKey）へ集約した。PJ 単位ストアの
  // マップキーと**同一の規則**であることが要件（片方だけ変えると判定が食い違う）。
  // 正準形は `/` 区切りへ変わったが、同値関係としては従来と完全に同一（区切り・末尾・大小のみを吸収）。
  const na = projectKey(a)
  const nb = projectKey(b)
  return na !== '' && na === nb
}

/**
 * 042: `-r <sessionId>` を出してよいかの単一判定点。
 *
 * 真因（2026-08-17 実測）: セッション ID は PJ 固有だが store は全 PJ 共通のため、PJ A で入れた
 * UUID が PJ B の起動コマンドへ黙って載り、CLI が
 * `No conversation found with session ID: <uuid>` で起動失敗した（別 cwd から resume すると
 * セッションが live でなくとも必ず失敗することを隔離ディレクトリ実験で確定済み）。
 *
 * 全条件を満たすときのみ true。1 つでも欠けたら fail-closed（出さない）:
 *   - チェック ON かつ値が非空
 *   - 値に所有 PJ（`projectPath`）が束縛されている（042 以前の保存値は所有者不明＝出さない）
 *   - 起動先 PJ が渡されている
 *   - 所有 PJ と起動先 PJ が同一
 */
export function shouldEmitResume(opts: LaunchOptions, launchProjectPath: string): boolean {
  if (!opts.resume.enabled) return false
  const value = opts.resume.value.trim()
  if (value === '') return false
  // 042 実装レビュア指摘 [2]: 先頭 `-` の値は却下する。理由 2 点——
  // (a) 主プロセス側 backstop は「次要素が flag 形なら値ではない」と見るため、ここで通すと
  //     第1層と第2層の判定が食い違う（発行したのに strip される）。
  // (b) セッション ID として不正であり、resume 欄経由で任意の CLI flag を注入する経路になる。
  if (value.startsWith('-')) return false
  const owner = opts.resume.projectPath
  if (typeof owner !== 'string' || owner.trim() === '') return false
  if (typeof launchProjectPath !== 'string' || launchProjectPath.trim() === '') return false
  return samePath(owner, launchProjectPath)
}

/**
 * 042: `launchProjectPath` は **必須**。省略可にすると「渡し忘れた新経路が黙って resume を落とす／
 * 素通しする」バイパスが型で許されてしまう（本件の原因が、まさに buildFableFlags が `model` だけ
 * 中和して `resume` を中和し忘れた見落としだった）。全呼び出し元に PJ の明示を型で強制する。
 */
export function buildFlags(opts: LaunchOptions, launchProjectPath: string): string[] {
  const flags: string[] = []
  if (opts.skipPermissions) flags.push('--dangerously-skip-permissions')
  if (opts.permissionMode !== 'default') flags.push('--permission-mode', opts.permissionMode)
  if (opts.continueLast) flags.push('-c')
  if (shouldEmitResume(opts, launchProjectPath)) flags.push('-r', opts.resume.value.trim())
  if (opts.verbose) flags.push('--verbose')
  if (opts.addDir.enabled) {
    opts.addDir.value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((dir) => flags.push('--add-dir', dir))
  }
  if (opts.ideAutoConnect) flags.push('--ide')
  if (opts.effort !== 'medium') flags.push('--effort', opts.effort)
  // 039 Feature A: 明示選択時のみ --model を付与。'' / 空白のみは CLI 委譲（従来挙動を厳守）。
  const model = opts.model.trim()
  if (model) flags.push('--model', model)
  return flags
}

/**
 * Fable 起動ボタン（038 Feature A）用の flag 合成。通常の buildFlags を土台に
 * effort を fableEffort で上書きし、`--model` を付与する。
 * fableEffort='medium' のときは buildFlags の既定省略に従い --effort を出さない（CC 側既定に委ねる）。
 * 039 FB⑥: モデル ID は引数注入（既定 FABLE_MODEL_ID）— appConfig 差し替えの受け口。
 */
/**
 * 042 実装レビュア指摘 [1]: 引数順は `(opts, launchProjectPath, fableModelId?)`。
 * 当初 `(opts, fableModelId = 既定, launchProjectPath)` としたが、末尾 2 つが共に string で
 * **順序を取り違えても型で捕まらない**（PJ パスを model ID として渡す事故が起こりうる）。
 * 必須引数を前に出し、既定値つきを最後に置くことで、自然形 `buildFableFlags(opts, projectPath)`
 * が「既定モデル＋正しい PJ」になる。
 */
export function buildFableFlags(
  opts: LaunchOptions,
  launchProjectPath: string,
  fableModelId: string = FABLE_MODEL_ID
): string[] {
  // 039: model を '' で潰してから fableModelId を付与 = Fable ボタンは常に Fable で起動する。
  // 通常起動の明示 Model 選択（opts.model）とは独立で、--model が重複付与されることもない。
  // 042: resume は「潰す」のでなく **起動先 PJ と一致するときだけ通す**（shouldEmitResume）。
  // ここで `resume: {...}` を無条件に潰すと、同一 PJ の正当な resume まで殺してしまう。
  // 070 M4 / Codex 指摘: fableModelId が空（スコープ内に Fable 不在時）は --model を付与しない。
  const flags = buildFlags({ ...opts, effort: opts.fableEffort, model: '' }, launchProjectPath)
  const trimmed = fableModelId.trim()
  if (trimmed) {
    flags.push('--model', trimmed)
  }
  return flags
}

/**
 * 042 実装レビュア指摘 [2]/[3]: resume の状態遷移を**純関数として外に出す**。
 *
 * なぜ関数に切り出すか: 当初この遷移は LaunchMenu の JSX の中（onCheckedChange / onChange の
 * インライン式）に埋まっており、テストは「遷移後の状態を手で組んで」判定していた。それでは
 * **「チェック操作で所有者を書き換えない」という肝心の性質を守れていない**——ハンドラ側に
 * projectPath を書き戻す実装へ戻しても、手組みテストは通ってしまう。
 * 実際の UI ハンドラがこの 2 関数だけを呼ぶ形にして、テストと本番で同じ遷移を通す。
 *
 * 不変条件: **所有者（projectPath）が変わるのは `resumeAfterValueInput` だけ**。
 */
export function resumeAfterToggle(
  resume: LaunchOptions['resume'],
  enabled: boolean
): LaunchOptions['resume'] {
  // 所有者は触らない。チェックの ON/OFF は「値を入れ直した」ことを意味しないため、
  // ここで所有者を今の行へ書き換えると別 PJ の UUID に偽の証明が立つ（本件の再現経路）。
  return { ...resume, enabled }
}

export function resumeAfterValueInput(
  resume: LaunchOptions['resume'],
  value: string,
  launchProjectPath: string
): LaunchOptions['resume'] {
  // 所有者を刻む唯一の点＝「この行で値を入力した」瞬間。
  return { ...resume, value, projectPath: launchProjectPath }
}

/**
 * 042: 主プロセスへ添える resume 束縛証明。**発行する意図があるときだけ**返す
 * （`shouldEmitResume` と同一条件＝第1層と第2層で判定が食い違わない）。
 */
export function resumeBindingFor(
  opts: LaunchOptions,
  launchProjectPath: string
): { value: string; projectPath: string } | undefined {
  if (!shouldEmitResume(opts, launchProjectPath)) return undefined
  return { value: opts.resume.value.trim(), projectPath: opts.resume.projectPath as string }
}

/** 039 FB⑤: Fable 起動要求（cc:launch 引数）の型。pxpipe はリテラル 'force' 固定。 */
export interface FableLaunchRequest {
  projectPath: string
  flags: string[]
  pxpipe: 'force'
  /**
   * 042: 主プロセス側 backstop 用の resume 束縛証明。renderer が `-r` を出したなら、その値と
   * 所有 PJ を併せて渡す。主プロセスは「証明の無い `-r`」を strip する（多層防御）。
   */
  resumeBinding?: { value: string; projectPath: string }
  tabColor?: string
}

/**
 * 039 FB⑤/⑥: Fable 起動要求の一括合成。経路（pxpipe='force' 固定）とモデル（fableModelId 注入）を
 * 1 箇所に集約し、「Fable は常に Fable モデルで・必ず pxp 経由で起動する」独立性を構造で保証する。
 * per-project Plug トグル等の呼び出し側状態を一切受け取らない（受け取れない）ことが回帰防止の本体
 * （038 実装時に per-project トグルへ誤連動しかけた反省点の恒久化）。
 */
export function buildFableLaunchRequest(
  projectPath: string,
  opts: LaunchOptions,
  fableModelId: string = FABLE_MODEL_ID,
  tabColor?: string
): FableLaunchRequest {
  return {
    projectPath,
    // 042: 起動先 PJ を flag 合成へ渡す。resume の所有 PJ と一致しなければ `-r` は出ない。
    flags: buildFableFlags(opts, projectPath, fableModelId),
    pxpipe: 'force',
    // 042 実装レビュア指摘 [3]: 証明は「renderer が実際に -r を出すとき」だけ添える。
    // 無効・空・別 PJ 束縛のときまで送ると、古い他 PJ の所有情報が IPC を流れ、
    // 「binding が在る ⇔ 発行する意図が在る」という不変条件が緩む。
    resumeBinding: resumeBindingFor(opts, projectPath),
    tabColor
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (!isPlainObject(a) || !isPlainObject(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]))
}

/**
 * 043: 起動時 override（特別行の `optionOverrides`）によって**実効値が変わる**フィールドを返す。
 *
 * popover は保存値（PJ 単位）を表示し、起動は `{...保存値, ...override}` で行うため、
 * 何もしないと「表示と実際に起動される内容の乖離」が沈黙する。UI はこの結果を注記として出す。
 *
 * 「指定されたキー」でなく「**値が実際に変わるキー**」を返すのは、override が現在値と同じ場合に
 * 「上書きされます」と出すのが嘘になるため（計画レビュー指摘 [5]）。
 */
export function overriddenKeys(
  saved: LaunchOptions,
  overrides?: Partial<LaunchOptions>
): (keyof LaunchOptions)[] {
  if (!overrides) return []
  return (Object.keys(overrides) as (keyof LaunchOptions)[]).filter((k) => {
    const value = overrides[k]
    if (value === undefined) return false
    return !deepEqual(value, saved[k])
  })
}

/**
 * 043: CC CLI のユーザー設定（`~/.claude/settings.json`）の生文字列から `model` を取り出す。
 *
 * 用途は **UI の出所表示のみ**。`model` 未指定（`''`＝`--model` 不付与）のとき、CC は自分の保存既定で
 * 起動するため「▷ を押したのに別モデルで上がった」という驚きが起きる（実際に起きた）。
 *
 * ⚠ これを「実効モデル」として断定してはならない: 解決チェーンには環境変数・PJ 別 settings・
 * 起動時の `--model` など上位層があり、CCPIT はそれらを解決していない。UI では必ず
 * **出所（どのファイルの何というキーか）を明示**して表示すること。
 */
export function parseCliDefaultModel(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isPlainObject(parsed)) return null
    const model = parsed.model
    return typeof model === 'string' && model.trim() !== '' ? model.trim() : null
  } catch {
    return null
  }
}

/** 040: main側 modelCatalog.ts の ModelCatalog を IPC 経由で受け取る側の軽量型（手動複製、
 * preload の型複製と同じ流儀）。 */
export type ModelCatalogTier = 'current' | 'legacy' | 'deprecated' | 'limited'
export interface ModelCatalogEntryLite {
  id: string
  displayName?: string
  tier: ModelCatalogTier
}
export interface ModelCatalogLite {
  fetchedAt: string
  source: 'official' | 'env'
  /** R-4: main側で計算済みのTTL判定（renderer側でTTL定数を二重管理しない）。 */
  stale: boolean
  models: ModelCatalogEntryLite[]
}

/**
 * 040 R-2: 静的 MODEL_PRESETS ∪ 動的キャッシュ（tier='current'のみ、deprecated/limitedは
 * プリセットに出さない）。catalog が null（未取得/取得失敗）の場合は static のみ＝
 * 039までと完全同一挙動になる（AC「キャッシュ無し状態で039と完全同一」）。
 */
export function mergeModelPresets(
  staticList: readonly string[],
  catalog: ModelCatalogLite | null
): string[] {
  if (!catalog) return [...staticList]
  const dynamic = catalog.models.filter((m) => m.tier === 'current').map((m) => m.id)
  return Array.from(new Set([...staticList, ...dynamic]))
}

/* ────────────────────────────────────────────────────────────────────────────
 * 053: Fable バージョン検出と解決（W-3/W-4）
 *
 * 方針: 5/5.1 等のバージョン文字列を UI・コードへ**直書きしない**。選択肢は
 * catalog（モデル一覧取得のたびに更新される）から parseModelId で毎回導出する。
 * これにより次 minor（5.2…）が catalog に載れば無改修で選択肢に現れる。
 * ──────────────────────────────────────────────────────────────────────── */

/** Fable バージョン選択肢。label がユーザー可視・保存値、id が --model へ渡す実 ID。 */
export interface FableVersionOption {
  label: string
  id: string
}

/**
 * W1-2（053 Codex 計画レビュー should-fix）: minor が 8 桁日付形（YYYYMMDD）なら date suffix と
 * みなし、バージョンは major のみとする決定的規則。`claude-fable-5-20260902` を「5.20260902」と
 * 誤読して選択肢に出さないための検出層規則（parseModelId の構文解析・1M 判定の意味論は不変）。
 */
const DATE_SUFFIX_MINOR_RE = /^\d{8}$/

function fableVersionLabelOf(p: ParsedModelId): { label: string; major: number; minor: number } {
  const isDateSuffix = p.minorText !== null && DATE_SUFFIX_MINOR_RE.test(p.minorText)
  const minor = isDateSuffix ? 0 : p.minor
  return { label: minor > 0 ? `${p.major}.${minor}` : `${p.major}`, major: p.major, minor }
}

/** resolveFableModelId / detectFableVersions が参照するスコープ入力型。
 * 正本スコープ配列 (string[])、getScopeStatus DTO ({ scopeBases: string[], fableModel?: string })、
 * configModels DTO ({ configModels: string[] }) を受理する。
 * 070 M4 / 差し戻し重大2: 旧 app-config の pxpipe 断面は削除し、正本 DTO のみを受理する。 */
export interface FableScopeContext {
  scopeBases?: readonly string[]
  configModels?: readonly string[]
  fableModel?: string
}

/** 旧型名（互換用エイリアス） */
export type FableResolveCfg = FableScopeContext

export type FableScopeInput =
  | readonly string[]
  | FableScopeContext
  | null
  | undefined

/**
 * 053 marshal-review high [1] 対応: pxpipe 実効スコープの cover 判定。
 * 上流 pxpipe-proxy の matcher（`base === b || base.startsWith(b + '-')`）と同型に揃える。
 * 070 M4 / 差し戻し重大2: 画像化の範囲（スコープ基底）は正本（scopeBases / configModels）のみから決定する。
 * 保存値の pxpipe.models / pxpipe.fableModel は、範囲の元にしない（正本一本化の徹底）。
 * 正本未指定時（undefined / null / 空オブジェクト）は既定スコープ [FABLE_MODEL_ID] に縮退。
 * 明示的に空配列が指定された場合は空スコープ [] を維持する。
 */
export function pxpipeScopeBases(input?: FableScopeInput): string[] {
  if (Array.isArray(input)) {
    return input.map((s) => s.trim()).filter(Boolean)
  }
  if (input && typeof input === 'object') {
    const raw =
      'scopeBases' in input && Array.isArray(input.scopeBases)
        ? input.scopeBases
        : 'configModels' in input && Array.isArray(input.configModels)
          ? input.configModels
          : null
    if (raw !== null) {
      return raw.map((s) => s.trim()).filter(Boolean)
    }
  }
  return [FABLE_MODEL_ID]
}

function coveredByScope(id: string, bases: readonly string[]): boolean {
  return bases.some((b) => id === b || id.startsWith(b + '-'))
}

/**
 * catalog から Fable バージョン選択肢を導出する純関数（バージョン昇順）。
 *
 * - W3-1/W4-1（must-fix）: `tier==='current'` 限定にしない。5.1 登場で Fable 5 が legacy 化しても
 *   「5 を選べる」を落とさないため、除外は deprecated / limited のみ。
 *   さらに静的側（実効 base = `getFableModelId(cfg)`）を常に ∪（mergeModelPresets と同型の
 *   静的∪動的）＝catalog が null / 空 / fable 非収載でも「既定」は構造的に必ず選べる。
 * - 053 marshal-review high [1]: catalog 由来の候補は **pxpipe 実効スコープに覆われる ID のみ**。
 *   スコープ外の将来 Fable（例: base が 5 のまま catalog に 6 が載る）を選択肢に出すと、
 *   `--model` は新 ID / proxy は旧 base のみ横取り＝**沈黙の削減ゼロ**になる（039 FB⑥ 違反）。
 *   6 へ移行する時は fableModel と models を「一緒に更新」すれば（039 FB⑥ の既存規律）選択肢も追従する。
 * - 070 M4 差し戻し重大2: 選択肢の候補は正本スコープに覆われているものに限定する。
 *   seedId が正本スコープに覆われていれば採用、覆われていなければスコープ内の既定へフォールバック。
 *   正本スコープ内に Fable 基底が 1 件も存在しない場合は空選択肢 [] を返す。
 * - 同一バージョンに複数 ID（素形と日付 suffix 形等）は**最短 ID** を採用（素形優先）。
 *   同長は辞書順＝入力順に依存しない決定的規則としてテストで束縛する。
 * - family は実効 base から導出（'fable' の直書きすらしない）。
 */
export function detectFableVersions(
  catalog: ModelCatalogLite | null,
  cfg?: FableScopeInput
): FableVersionOption[] {
  const bases = pxpipeScopeBases(cfg)
  const fableBase = bases.find((b) => b.startsWith('claude-fable'))
  if (!fableBase) return []

  const seedId = getFableModelId(cfg)
  const effectiveSeedId = coveredByScope(seedId, bases) ? seedId : fableBase
  const base = parseModelId(effectiveSeedId)
  const candidates: { id: string; parsed: ParsedModelId }[] = base
    ? [{ id: effectiveSeedId, parsed: base }]
    : []
  if (catalog && base) {
    for (const m of catalog.models) {
      if (m.tier === 'deprecated' || m.tier === 'limited') continue
      if (!coveredByScope(m.id, bases)) continue
      const parsed = parseModelId(m.id)
      if (!parsed || parsed.family !== base.family) continue
      candidates.push({ id: m.id, parsed })
    }
  }
  const byVersion = new Map<string, { major: number; minor: number; id: string }>()
  for (const c of candidates) {
    const v = fableVersionLabelOf(c.parsed)
    const prev = byVersion.get(v.label)
    if (
      !prev ||
      c.id.length < prev.id.length ||
      (c.id.length === prev.id.length && c.id < prev.id)
    ) {
      byVersion.set(v.label, { major: v.major, minor: v.minor, id: c.id })
    }
  }
  return Array.from(byVersion.entries())
    .sort(([, a], [, b]) => a.major - b.major || a.minor - b.minor)
    .map(([label, v]) => ({ label, id: v.id }))
}

/**
 * fableVersion（'' = 既定）→ 実 --model ID の解決。Fable 起動ボタンの click 時に呼ぶ。
 *
 * fail-safe の向き（W4-2）: 選択バージョンが catalog から消えていても**起動を壊さない**——
 * 現行解決へフォールバックする。落とすのは「選択どおりのバージョン」で
 * あって起動そのものではない（resume の fail-closed とは逆向きだが、こちらは危険側が「起動不能」）。
 *
 * 053 marshal-review high [1] / 070 M4 差し戻し重大2: 解決も選択肢と同じスコープ束縛。
 * wanted === '' の既定時およびフォールバック時も、正本スコープ bases に覆われた effectiveSeedId を返し、
 * スコープ外のモデルへ解決されるのを防ぐ。
 * 070 M4 / Codex 指摘: スコープ内に Fable 基底が一切存在しない場合は、スコープ外の FABLE_MODEL_ID へ
 * フォールバックせず空文字 '' を返し、正本外モデルの注入を構造的に防止する。
 */
export function resolveFableModelId(
  fableVersion: string,
  catalog: ModelCatalogLite | null,
  cfg?: FableScopeInput
): string {
  const bases = pxpipeScopeBases(cfg)
  const fableBase = bases.find((b) => b.startsWith('claude-fable'))
  if (!fableBase) return ''

  const seedId = getFableModelId(cfg)
  const effectiveSeedId = coveredByScope(seedId, bases) ? seedId : fableBase

  const wanted = fableVersion.trim()
  if (wanted === '') return effectiveSeedId
  const hit = detectFableVersions(catalog, cfg).find((o) => o.label === wanted)
  return hit ? hit.id : effectiveSeedId
}
