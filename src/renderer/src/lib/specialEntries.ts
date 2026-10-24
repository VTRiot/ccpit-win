/**
 * 039 FB②/③: 特別行（appConfig specialEntries）の追加・削除・重複判定の純関数群。
 *
 * UI（SpecialEntryAddDialog / ProjectsPage）から分離してあるのは、vitest が node env
 * （jsdom なし）で、Dialog そのものはテストしづらいため。ここに判定ロジックを寄せて
 * node env の unit test で固定する（launchOptions.ts と同じ流儀）。
 *
 * SpecialProjectEntry の正本は main 側 appConfig.ts。ここでは preload configGet 戻りから
 * 導出した最小構造だけを型引数として受ける（renderer は id/name/path/pxpipeEnabled 等を触る）。
 */

import { normalizePathKey } from './pathKey'
// 044: 統合行の起動 override（`resolveRowOverrides`）が LaunchOptions の形へ写像するため。
// 依存は一方向（launchOptions.ts は pathKey のみ import）＝循環しない。
import { EFFORT_LEVELS, type EffortLevel, type LaunchOptions } from './launchOptions'

// 043: 正規化器の実体は `pathKey.ts` へ移設（起動オプションの PJ 単位ストアのキーと同一規則で
// なければならないため）。既存の import 元を壊さないよう、ここから再 export する。
export { normalizePathKey }

/** 本モジュールが扱う特別行エントリの最小形（appConfig SpecialProjectEntry のサブセット）。 */
export interface SpecialEntryLike {
  id: string
  name: string
  path: string
  addDirs?: string[]
  effort?: string
  tabColor?: string
  pxpipeEnabled?: boolean
}

/** 特別行 id の接頭辞（appConfig 手編集エントリと衝突しない可読プレフィックス）。 */
export const SPECIAL_ENTRY_ID_PREFIX = 'sp-'

/** 両区切り・末尾区切りに耐える basename（name 未指定時の自動補完に使う）。 */
export function pathBasename(p: string): string {
  const trimmed = p.trim().replace(/[\\/]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}

/** buildSpecialEntry の失敗理由（UI 側で i18n キーへ写像する）。 */
export type SpecialEntryError = 'emptyPath' | 'emptyName' | 'duplicate'

export type BuildSpecialEntryResult =
  | { ok: true; entry: SpecialEntryLike }
  | { ok: false; reason: SpecialEntryError }

/**
 * 追加用エントリを組み立てる（純粋・副作用なし）。
 * - path 空 → emptyPath
 * - name 空かつ basename も空 → emptyName
 * - 既存と正規化パス一致 → duplicate
 * - name 未指定 → basename で補完
 * - id は `sp-<epoch36>`。既存 id と衝突したら連番 suffix で回避（同時刻連打耐性）。
 *
 * @param nowMs テスト用の時刻注入（省略時は Date.now()）。id 生成の決定性のため。
 */
export function buildSpecialEntry(
  existing: readonly SpecialEntryLike[],
  rawPath: string,
  rawName: string,
  nowMs?: number
): BuildSpecialEntryResult {
  const path = rawPath.trim()
  if (path.length === 0) return { ok: false, reason: 'emptyPath' }

  const name = rawName.trim() || pathBasename(path)
  if (name.length === 0) return { ok: false, reason: 'emptyName' }

  const key = normalizePathKey(path)
  if (existing.some((e) => normalizePathKey(e.path) === key)) {
    return { ok: false, reason: 'duplicate' }
  }

  const id = allocateSpecialEntryId(existing, nowMs)
  return { ok: true, entry: { id, name, path } }
}

/** 既存 id と衝突しない `sp-` id を発番する（epoch36 基点、衝突時 `-<n>` を付与）。 */
export function allocateSpecialEntryId(
  existing: readonly SpecialEntryLike[],
  nowMs?: number
): string {
  const taken = new Set(existing.map((e) => e.id))
  const base = `${SPECIAL_ENTRY_ID_PREFIX}${(nowMs ?? Date.now()).toString(36)}`
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n++
  return `${base}-${n}`
}

/** id 一致エントリを除去した新配列を返す（非破壊）。FB②「削除」の本体。 */
export function removeSpecialEntry<T extends SpecialEntryLike>(entries: readonly T[], id: string): T[] {
  return entries.filter((e) => e.id !== id)
}

// ---------------------------------------------------------------------------
// 044: 特別行と通常行の描画一本化（同一パスの二重描画を断つ）
//
// 043 は「同じ PJ が 2 行ある」異常状態を**許したまま**辻褄を合わせた（孤児判定つき prune /
// updater 形 patch / popover 再読込）。044 は異常状態そのものを作らせない層で、043 の防御は
// 保険として残す（多層防御を薄くしない）。
//
// **データは一切消さない**。特別行固有（addDirs / effort / tabColor）と通常行固有
// （createdAt / favorite / documents / location_type / external / groupKey / parent_id）は
// 互いに素で、どちらを消しても情報が落ちる。よって解決は描画層に置く＝可逆。
// ---------------------------------------------------------------------------

/** 突合と実効値計算に要る通常行（projects.json の ProjectEntry）の最小形。 */
export interface NormalProjectLike {
  path: string
  favorite?: boolean
  pxpipeEnabled?: boolean
  external?: boolean
}

/** 描画 1 行分。`project` が非 null なら**統合行**（同一パスが両ストアに在る）。 */
export interface SpecialRow<S extends SpecialEntryLike, P extends NormalProjectLike> {
  entry: S
  project: P | null
}

export interface ProjectRowPlan<S extends SpecialEntryLike, P extends NormalProjectLike> {
  /** 最上部に固定描画する特別行。config の並びをそのまま保つ（applyProjectsView は通さない）。 */
  specialRows: SpecialRow<S, P>[]
  /** 特別行に吸収されなかった通常行。**これを applyProjectsView に渡す**（生の projects ではなく）。 */
  normalProjects: P[]
  /** 吸収された正規化キー（診断・テスト用。描画には使わない）。 */
  absorbedKeys: string[]
}

/**
 * 044: 「特別行を唯一の描画サイトにする」ための突合。
 *
 * 二重描画が実害である理由は見苦しさではない。両行は
 *   - 起動オプションの**同じバケツ**を共有する（`normalizePathKey` が同一キーを返すため）
 *   - marker を**別キー**（`entry.path` と `project.path`）で 2 本持つ
 *   - pxpipe の経路指定が行ごとに違う（`resolveRowPxpipeMode` の doc 参照）
 * ため、ユーザーから見て「どちらを触れば効くのか」が決定不能になる。行を 1 本にすると 3 つとも畳める。
 *
 * 突合キーは `normalizePathKey`（renderer 唯一の正本）。独自正規化を足すと起動オプションの
 * バケツキー・043 の孤児判定と食い違い、片方の削除で他方の設定が飛ぶ。
 *
 * 細目:
 * - 特別行の順序は入力（config）の順を保つ。
 * - 同一キーの通常行が**複数**ある場合は**全件**除外する。1 件だけ除外すると残りが二重描画として
 *   生き残る。projects.json の重複は現実に起こりうる: `importProjects` の既存判定は
 *   **生文字列の `toLowerCase()`**（`projects.ts:221`）なので、`C:/X` と `C:\X` は別物として通る。
 * - `project` に紐づくのは同一キーの**先頭**（projects.json の並び順で先勝ち）。これは主プロセスの
 *   `getPxpipeEnabled` が `cwdMatches` + `.find()`（`projects.ts:293`）で選ぶ 1 件と同じ選択であり、
 *   「UI が読む行」と「主プロセスが読む行」を一致させるための意図的な規則である。
 * - 空キー（空文字・空白のみ）は何も吸収しない。`isOrphanProjectPath`（`launchOptions.ts:337-341`）の
 *   「空パスは孤児と見なさない」と同じ fail-safe 方向。
 * - **特別行同士は dedupe しない**。UI 追加経路は `buildSpecialEntry` が弾くので、同一パスの特別行が
 *   並ぶのは `app-config.json` の手編集の結果だけ。手で書いたものを UI が黙って隠すのは不適切。
 *   044 が断つのは**ストア間**の二重描画であり、ストア内の重複は対象外（`buildRowPxpipeToggle` は
 *   その並存下でも整合するように全件を書き換える）。
 */
export function planProjectRows<S extends SpecialEntryLike, P extends NormalProjectLike>(
  specialEntries: readonly S[],
  projects: readonly P[]
): ProjectRowPlan<S, P> {
  const firstByKey = new Map<string, P>()
  for (const p of projects) {
    const key = normalizePathKey(p.path)
    if (key === '') continue
    if (!firstByKey.has(key)) firstByKey.set(key, p)
  }

  const absorbed = new Set<string>()
  const specialRows = specialEntries.map((entry) => {
    const key = normalizePathKey(entry.path)
    const project = key === '' ? undefined : firstByKey.get(key)
    if (project !== undefined) absorbed.add(key)
    return { entry, project: project ?? null }
  })

  const normalProjects = projects.filter((p) => !absorbed.has(normalizePathKey(p.path)))
  return { specialRows, normalProjects, absorbedKeys: [...absorbed] }
}

/**
 * その行を代表するパス文字列。**統合行は projects.json 側の生文字列**を返す。
 *
 * load-bearing な理由が 3 つある:
 * 1. `markers` / `historyMeta` は**取得時に渡した文字列そのもの**をキーにする `Record` である。
 *    書込側は 2 経路（通常行スキャン＝`project.path` / 特別行スキャン＝`entry.path`）で、
 *    本関数は「その行の marker を実際に書いた側の文字列」を返すので、両ストアの表記が違っても
 *    必ず充填済みキーを引く。`historyMeta` に至っては `entry.path` キーが一度も書かれない。
 * 2. 主プロセスの `setPxpipeEnabled` / `setFavorite` は `p.path === projectPath` の**完全一致**で、
 *    外すと**沈黙 no-op**（`projects.ts:270,279`）。表記の違う `entry.path` を渡すと書込が消える。
 * 3. `pxpipe:'auto'` は主プロセスに `projects.json` を読ませる経路（`ipc.ts:402-404`）なので、
 *    起動時 cwd も通常行側の文字列で渡す方が一貫する。
 *
 * 起動オプションのバケツは `normalizePathKey` 正規化後のキーなのでどちらの文字列でも同一バケツを
 * 指すが、行内で使う文字列を 1 本に揃えておく方が事故が少ない。
 */
export function rowPrimaryPath<S extends SpecialEntryLike, P extends NormalProjectLike>(
  row: SpecialRow<S, P>
): string {
  return row.project?.path ?? row.entry.path
}

/**
 * read-only 経路（`protocolRead`）で marker を読むべき特別行のパス一覧。
 *
 * 統合行を除くのは節約が目的ではない。統合行のパスは通常行スキャンが `protocolAutoMark`
 * （**書込あり**）で既に処理しており、同一パスへ書込と読取を同時に投げないため。read-only 経路は
 * 「projects.json 未登録パスへ暗黙に書かない」ための措置（`ProjectsPage.tsx:480-483`）であって、
 * 登録済み＝統合行には当たらない。
 */
export function unmergedSpecialPaths<S extends SpecialEntryLike, P extends NormalProjectLike>(
  rows: readonly SpecialRow<S, P>[]
): string[] {
  return rows.filter((r) => r.project === null).map((r) => r.entry.path)
}

/**
 * その行の pxpipe **表示用**実効値。主プロセスの OR 意味論の写し。
 *
 * 正本: `projects.ts:308-315` `resolveIsPxpipeEnabled`
 *   `normalProjectEnabled || specialEntries.some(e => cwdMatches(e.path,cwd) && e.pxpipeEnabled === true)`
 *
 * 未統合行では `project` が無いので特別枠の値だけで決まり、従来挙動と完全に一致する。
 *
 * ⚠ `projects.ts` の判定を変えるときは本関数も同時に直すこと。ズレると「UI は ON なのに
 * 一括再起動の中継未経由警告は OFF 扱い」等の乖離が出る。
 */
export function resolveRowPxpipeEnabled<S extends SpecialEntryLike, P extends NormalProjectLike>(
  row: SpecialRow<S, P>
): boolean {
  return (row.project?.pxpipeEnabled ?? false) || (row.entry.pxpipeEnabled ?? false)
}

/** `cc:launch` の pxpipe 経路指定（`ipc.ts:400-405` の PxpipeMode）。 */
export type RowPxpipeMode = 'auto' | 'force' | 'off'

/**
 * その行の pxpipe **起動用**モード。**044 で直す既存バグの本体**。
 *
 * 主プロセスの分岐は OR ではない（`ipc.ts:400-405`）:
 *   `'off'`   → `projects.json` を**一切見ずに**素通し起動
 *   `'auto'`  → `getPxpipeEnabled()`（= `projects.json` を `cwdMatches` で引く）に従う
 *   `'force'` → 常に中継経由
 * OR を持つ `resolveIsPxpipeEnabled` は一括再起動の live 判定専用で、**起動経路には効いていない**。
 *
 * 旧実装は特別行に `entry.pxpipeEnabled ? 'force' : 'off'` を明示で渡していた。よって
 * 「`projects.json` で ON・特別枠側は未設定」の PJ を特別枠に載せると、特別行からの起動は
 * `'off'` になり**中継が黙って外れる**（トークン削減が消え、通知も出ない）。二重描画のうちは
 * 通常行（prop 省略＝`'auto'`）から起動すれば正しく載ったため露見しにくかったが、描画を
 * 一本化すると特別行が唯一の導線になるため実害が確定する。
 *
 * よって統合行では `'auto'` を返し、**主プロセスに `projects.json` を読ませる**。
 * 未統合行は参照先の通常行が存在しないので従来どおり `'off'`（`'auto'` にすると
 * `getPxpipeEnabled` が必ず false を返すだけで、意味は同じだが意図が読めなくなる）。
 */
export function resolveRowPxpipeMode<S extends SpecialEntryLike, P extends NormalProjectLike>(
  row: SpecialRow<S, P>
): RowPxpipeMode {
  if (row.entry.pxpipeEnabled === true) return 'force'
  return row.project !== null ? 'auto' : 'off'
}

export interface RowPxpipeToggle<S extends SpecialEntryLike> {
  /** トグル後の実効値。 */
  next: boolean
  /** 書換後の specialEntries。変更不要なら**入力参照をそのまま**返す（無用な configSet を撃たない）。 */
  nextEntries: readonly S[]
  /** specialEntries を書き換えたか（= `config:set` が要るか）。 */
  specialChanged: boolean
  /** projects.json 側へ書くパス（不要なら null）。**必ず通常行側の生文字列**（`rowPrimaryPath` の 2. 参照）。 */
  projectWritePath: string | null
}

/**
 * 行単位の pxpipe トグル計画。
 *
 * 表示が OR（`resolveRowPxpipeEnabled`）である以上、素朴に「片側だけ書く」と壊れる:
 *   - 通常行 true / 特別枠 false の行で特別枠だけ false に書いても OR が true のままで**消せない**。
 *   - 両方 false の行で特別枠だけ true に書くと、降格したとき通常行は false のままで
 *     ユーザーが見ていた ON が**黙って消える**。
 *
 * よって規則は 1 つ:「**next と食い違っている側を全部 next に揃える**」。結果として
 *   - 適用後は必ず両側が next に一致する（ストア間ドリフトが構造的に発生しない）
 *   - 計画は必ず 1 件以上の書込を含む（`next !== 実効値` なら差のある側が必ず存在する）
 * が成り立つ。
 *
 * 特別枠側は **id ではなく正規化パスで全件**書き換える。主プロセスの判定が `.some()`
 * （`projects.ts:314`）なので、手編集で同一パスの特別枠が 2 件あると 1 件でも true なら ON になり、
 * id 一本の書換では OFF にできない。パスが空キーの壊れたエントリだけは id 一致で救う。
 */
export function buildRowPxpipeToggle<S extends SpecialEntryLike, P extends NormalProjectLike>(
  entries: readonly S[],
  row: SpecialRow<S, P>
): RowPxpipeToggle<S> {
  const next = !resolveRowPxpipeEnabled(row)
  const key = normalizePathKey(row.entry.path)
  const matches = (e: S): boolean =>
    key === '' ? e.id === row.entry.id : normalizePathKey(e.path) === key

  let specialChanged = false
  const mapped = entries.map((e) => {
    if (!matches(e)) return e
    if ((e.pxpipeEnabled ?? false) === next) return e
    specialChanged = true
    return { ...e, pxpipeEnabled: next }
  })

  const projectWritePath =
    row.project !== null && (row.project.pxpipeEnabled ?? false) !== next ? row.project.path : null

  return { next, nextEntries: specialChanged ? mapped : entries, specialChanged, projectWritePath }
}

/**
 * 未統合行の effort 既定。038 で入った既存挙動をそのまま保存する定数であり、新しい方針ではない
 * （未登録パスには「保存済み起動オプションの出所」が無いため、特別枠側が唯一の供給元になる）。
 */
const UNMERGED_DEFAULT_EFFORT: EffortLevel = 'max'

/**
 * 特別行の起動 override（config エントリ → LaunchOptions への写像）。起動時 merge のみで、
 * localStorage のグローバル設定へは保存されない（LaunchMenu / FableLaunchButton 側で保証）。
 *
 * 044: **統合行では entry が明示したキーだけを出す**。旧実装は `effort` 未設定なら `'max'` を、
 * `addDir` は無条件に返していた。二重描画のうちは通常行から「保存済みの起動オプション」で
 * 起動できたが、描画を一本化すると特別行が唯一の導線になるため、ユーザーが popover で設定した
 * `--add-dir` と effort が**黙って上書きされる**（＝一本化が持ち込む回帰）。
 *
 * 判定は**キーの存在**で行い、truthy 判定にはしない。`addDirs: []` は「add-dir を使わない」という
 * 明示の意思なので `{enabled:false}` を出すのが正しく、`effort: ''` のような無効値は
 * `EFFORT_LEVELS` に無いので出さない（＝保存値が生きる）。
 */
export function resolveRowOverrides(
  entry: SpecialEntryLike,
  merged: boolean
): Partial<LaunchOptions> {
  const effortValid = (EFFORT_LEVELS as readonly string[]).includes(entry.effort ?? '')
  const effort: EffortLevel = effortValid ? (entry.effort as EffortLevel) : UNMERGED_DEFAULT_EFFORT

  if (!merged) {
    const addDirs = entry.addDirs ?? []
    return {
      addDir: { enabled: addDirs.length > 0, value: addDirs.join(',') },
      effort,
      fableEffort: effort
    }
  }

  const overrides: Partial<LaunchOptions> = {}
  if (entry.addDirs !== undefined) {
    overrides.addDir = { enabled: entry.addDirs.length > 0, value: entry.addDirs.join(',') }
  }
  if (effortValid) {
    overrides.effort = effort
    overrides.fableEffort = effort
  }
  return overrides
}

/** プロジェクト一覧の「空」表示の種別。 */
export type ProjectsEmptyState = 'none' | 'noProjects' | 'noFavorites'

/**
 * 044: 空状態の選択。
 *
 * 旧実装の 2 段分岐（`projects.length === 0` → noProjects / `visibleProjects.length === 0` →
 * noFavorites）は「visible が空 ⇔ favorites フィルタで空」という**現状でのみ成立する不変条件**に
 * 乗っている。dedupe を入れると `filterFavoritesOnly=false` でも visible が空になり得るため、
 * 「★お気に入りがありません」を誤表示する（フィルタは何も隠していない）。
 *
 * 優先順:
 *   1. 通常行が 1 つでも見えている     → none
 *   2. 通常行はあるが view で全部隠れた → noFavorites（従来どおり）
 *   3. 通常行は無いが特別行がある       → none（一覧は空ではない）
 *   4. どちらも無い                     → noProjects（従来どおり）
 *
 * 3 は**意図的な挙動変更**（従来は特別行の下に「プロジェクトがありません」が出た）。
 */
export function resolveProjectsEmptyState(input: {
  specialRowCount: number
  normalCount: number
  visibleNormalCount: number
}): ProjectsEmptyState {
  if (input.visibleNormalCount > 0) return 'none'
  if (input.normalCount > 0) return 'noFavorites'
  if (input.specialRowCount > 0) return 'none'
  return 'noProjects'
}
