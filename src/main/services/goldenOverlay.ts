/**
 * goldenOverlay — 逆向き反映（ADR 0002）の保管庫と解決層。
 *
 * ## なぜ配布元ディレクトリへ直接書かないか
 * 同梱 golden は packaged で `resourcesPath/golden` に置かれ、**アプリの更新・再インストールで
 * 置き換わる**。そこへ書き戻しても次の更新で消える（「書けた」と「残る」は別問題）。
 * dev では逆に、書き込み先が配布正本そのものになり、1 環境の都合が全環境へ配られてしまう。
 *
 * よって反映先はユーザー領域（`~/.ccpit/golden-overlay/`）に置く。アプリ本体の外なので
 * 更新に耐え、かつ配布正本を汚さない。
 *
 * ## 何をするモジュールか
 * 「同梱 golden の集合」を入力に取り、overlay を**重ねた集合**を返す。重ねる条件は厳しい:
 *
 * - `orphan`   — 同梱に無い rel は重ねない（overlay は**置換専用**。配布集合を増やさない）
 * - `stale`    — 同梱側が反映当時（`baseGoldenHash`）から動いていたら重ねない
 *                （上流の更新を黙って覆い隠さない。三方向照合が自然に再提示へ回す）
 * - `unusable` — overlay 実体が読めない / `contentHash` と食い違う（途中書き・改変）なら重ねない
 *
 * ## 層の位置
 * 本モジュールは Electron に依存しない。`GOLDEN_DIR` の解決や `app` は呼び出し側（`golden.ts`）が持つ。
 */

import { readFile, chmod, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { writeFileAtomic } from './atomicFile'
import { hashFileAt, hashFileBuffer, normalizeRelPath, type ManifestEntry } from './goldenManifest'

/** `~/.ccpit/` 直下の overlay ディレクトリ名。 */
export const OVERLAY_DIRNAME = 'golden-overlay'

/** overlay の索引ファイル名（overlay ディレクトリ直下）。 */
export const OVERLAY_INDEX_FILENAME = '.overlay.json'

/** 索引スキーマ版。読み手は不一致を「索引なし」＝ 何も重ねない、へ倒す。 */
export const OVERLAY_INDEX_VERSION = 1

/** 反映 1 件の記録。 */
export interface OverlayEntry {
  /** 正規化済み相対パス（配置先ルート相対。同梱 golden の rel と同じ座標系） */
  path: string
  /** 反映時刻 ISO 8601 */
  promotedAt: string
  /** 反映した内容の sha256。overlay 実体と照合して途中書き・改変を弾く */
  contentHash: string
  /**
   * 反映を**決めた時点**の同梱 golden 側のハッシュ。
   * ここから動いたら overlay は失効する（上流の更新を覆い隠さないため）。
   *
   * **「この中身が元にした golden」ではない。** 上流が進んだ後（`conflict`）に「ローカルを残す」を
   * 選ぶと、ここには進んだ後の golden が入るが、中身は進む前の golden から作られている。
   * 元にした版が要る読み手は `derivedFromGoldenHash` と `bundledBaseHashOf` を使う。
   */
  baseGoldenHash: string
  /**
   * この中身が元にした同梱 golden のハッシュ（069 発注 2）。
   * - string: 反映の時点で、反映前の台帳の行から導いた値
   * - null: 不明（反映前の行が user・adopted、または台帳と索引が食い違っていた）＝ 信用しない
   * - 欄なし: この欄を足す前に書かれた行（旧い形）。元にした版は不明として扱う（`bundledBaseHashOf` は信用しない）
   * 失効の判定（`resolveOverlay`）には使わない。
   */
  derivedFromGoldenHash?: string | null
}

export interface OverlayIndex {
  version: number
  entries: OverlayEntry[]
}

/** 空の索引（不在・破損時のフェイルセーフ値 ＝ 何も重ねない）。 */
export const EMPTY_OVERLAY_INDEX: OverlayIndex = { version: OVERLAY_INDEX_VERSION, entries: [] }

export function getOverlayDir(parcFermeDir: string): string {
  return join(parcFermeDir, OVERLAY_DIRNAME)
}

export function getOverlayIndexPath(parcFermeDir: string): string {
  return join(getOverlayDir(parcFermeDir), OVERLAY_INDEX_FILENAME)
}

/**
 * rel が overlay の保管先として安全か。
 *
 * 索引はユーザーが手で書き換えられる JSON なので、`..` によるディレクトリ脱出を弾く。
 * 実際には「同梱 golden に同じ rel が無ければ重ねない」ので脱出パスは `orphan` に落ちるが、
 * 集合判定より前に**書き込み側でも**閉じておく（読み側の性質に依存しない）。
 */
export function isSafeOverlayRel(rel: string): boolean {
  const norm = normalizeRelPath(rel)
  if (norm === '' || norm.startsWith('/')) return false
  if (/^[A-Za-z]:/.test(norm)) return false
  return !norm.split('/').includes('..')
}

/** overlay 実体の絶対パス。安全でない rel には解決しない。 */
export function overlayFilePath(parcFermeDir: string, rel: string): string | null {
  if (!isSafeOverlayRel(rel)) return null
  return join(getOverlayDir(parcFermeDir), normalizeRelPath(rel))
}

/**
 * 索引を読む。不在・空・破損・版不一致はいずれも**空の索引**（＝ 何も重ねない）。
 *
 * フェイルセーフの向き: 索引が読めないなら同梱 golden がそのまま使われる。
 * 反映内容は overlay ディレクトリに残るので失われないが、配られはしない。
 * 「壊れた索引で配布物を差し替える」よりは「差し替えない」が安全側。
 */
export async function readOverlayIndex(parcFermeDir: string): Promise<OverlayIndex> {
  const indexPath = getOverlayIndexPath(parcFermeDir)
  if (!existsSync(indexPath)) return { ...EMPTY_OVERLAY_INDEX, entries: [] }
  try {
    const raw = await readFile(indexPath, 'utf-8')
    if (raw.trim() === '') return { ...EMPTY_OVERLAY_INDEX, entries: [] }
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return { ...EMPTY_OVERLAY_INDEX, entries: [] }
    const idx = parsed as Partial<OverlayIndex>
    if (idx.version !== OVERLAY_INDEX_VERSION) return { ...EMPTY_OVERLAY_INDEX, entries: [] }
    if (!Array.isArray(idx.entries)) return { ...EMPTY_OVERLAY_INDEX, entries: [] }
    const entries: OverlayEntry[] = []
    for (const e of idx.entries) {
      if (!e || typeof e !== 'object') continue
      const entry = e as Partial<OverlayEntry>
      if (typeof entry.path !== 'string' || !isSafeOverlayRel(entry.path)) continue
      if (typeof entry.contentHash !== 'string' || entry.contentHash === '') continue
      if (typeof entry.baseGoldenHash !== 'string' || entry.baseGoldenHash === '') continue
      entries.push({
        path: normalizeRelPath(entry.path),
        promotedAt: typeof entry.promotedAt === 'string' ? entry.promotedAt : '',
        contentHash: entry.contentHash,
        baseGoldenHash: entry.baseGoldenHash,
        // 欄なし（旧い形）と「不明」（null）は、読み手にはどちらも信用しない扱いだが、記録の上では区別して保つ。
        // string でも欠落でもない値（型違い・空文字）は null へ倒す。
        ...('derivedFromGoldenHash' in entry
          ? {
              derivedFromGoldenHash:
                typeof entry.derivedFromGoldenHash === 'string' &&
                entry.derivedFromGoldenHash !== ''
                  ? entry.derivedFromGoldenHash
                  : null
            }
          : {})
      })
    }
    return { version: OVERLAY_INDEX_VERSION, entries }
  } catch {
    return { ...EMPTY_OVERLAY_INDEX, entries: [] }
  }
}

/** 索引を書く（原子的置換・親ディレクトリは自動作成）。 */
export async function writeOverlayIndex(parcFermeDir: string, index: OverlayIndex): Promise<void> {
  const sorted: OverlayIndex = {
    version: OVERLAY_INDEX_VERSION,
    entries: [...index.entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  }
  await writeFileAtomic(getOverlayIndexPath(parcFermeDir), JSON.stringify(sorted, null, 2))
}

/** `resolveOverlay` の結果。使わなかった理由ごとに分けて返す（Health が説明できるように）。 */
export interface OverlayResolution {
  /** overlay を重ねた後の `rel → 供給元の絶対パス` */
  merged: Map<string, string>
  /** 実際に重ねた rel */
  active: string[]
  /** 同梱側が反映当時から動いたため使わなかった rel（＝上流に新しい内容がある） */
  stale: string[]
  /** 同梱 golden に対応が無いため使わなかった rel（overlay は置換専用） */
  orphan: string[]
  /** 実体が読めない / `contentHash` と食い違うため使わなかった rel */
  unusable: string[]
}

/**
 * 同梱 golden の集合に overlay を重ねる。
 *
 * ## 循環を作らないこと
 * 失効判定は **`bundled`（overlay を重ねる前）のハッシュ**とだけ突き合わせる。
 * 重ねた後の集合から `G_new` を取って比較すると、常に自分自身と一致して失効しなくなる。
 *
 * ## 走査量
 * ハッシュを取るのは**索引に載っている rel の分だけ**（通常 1〜数件）。
 * 同梱物全体のハッシュ化は従来どおり下流（`hashSourceMap`）が一度だけ行う。
 */
export async function resolveOverlay(
  bundled: Map<string, string>,
  index: OverlayIndex,
  parcFermeDir: string
): Promise<OverlayResolution> {
  const merged = new Map(bundled)
  const active: string[] = []
  const stale: string[] = []
  const orphan: string[] = []
  const unusable: string[] = []

  for (const entry of index.entries) {
    const rel = entry.path
    const bundledSource = bundled.get(rel) ?? bundled.get(rel.replace(/\//g, '\\'))
    if (!bundledSource) {
      orphan.push(rel)
      continue
    }
    const abs = overlayFilePath(parcFermeDir, rel)
    if (abs === null) {
      unusable.push(rel)
      continue
    }
    const bundledHash = await hashFileAt(bundledSource)
    if (bundledHash === null) {
      // 同梱側が読めない。配布物破損は下流の fail-closed（sourceUnreadable）が扱う。
      // ここで overlay を重ねると破損を覆い隠してしまうので重ねない。
      unusable.push(rel)
      continue
    }
    if (bundledHash !== entry.baseGoldenHash) {
      stale.push(rel)
      continue
    }
    const overlayHash = await hashFileAt(abs)
    if (overlayHash === null || overlayHash !== entry.contentHash) {
      unusable.push(rel)
      continue
    }
    merged.set(rel, abs)
    active.push(rel)
  }

  return {
    merged,
    active: active.sort(),
    stale: stale.sort(),
    orphan: orphan.sort(),
    unusable: unusable.sort()
  }
}

/** `promoteOverlayFile` の結果。 */
export interface OverlayWriteResult {
  contentHash: string
  overlayPath: string
}

/**
 * 配置先の内容を overlay へ書き込む（反映の本体）。
 *
 * モードは**同梱 golden 側に合わせる**。合わせないと、反映した `hooks/*.sh` が
 * 実行ビットを失ったまま配られ、hook が黙って発火しなくなる
 *（`backupAndReplace` は供給元ファイルの mode を配置先へ引き継ぐため）。
 */
export async function promoteOverlayFile(opts: {
  parcFermeDir: string
  rel: string
  /** 反映する内容（配置先から読んだバイト列） */
  content: Buffer
  /** モードを合わせる相手（同梱 golden 側の絶対パス） */
  bundledSourcePath: string
}): Promise<OverlayWriteResult> {
  const abs = overlayFilePath(opts.parcFermeDir, opts.rel)
  if (abs === null) throw new Error(`unsafe overlay path: ${opts.rel}`)
  await writeFileAtomic(abs, opts.content)
  try {
    const st = await stat(opts.bundledSourcePath)
    await chmod(abs, st.mode & 0o777)
  } catch {
    // モード引き継ぎの失敗は内容の正しさに影響しない（配布時に golden.ts が hooks へ 0o755 を明示付与する）
  }
  return { contentHash: hashFileBuffer(opts.rel, opts.content), overlayPath: abs }
}

/* ------------------------------------------------------------------ *
 * 「この中身が元にした同梱 golden」の入口（069 発注 2）
 *
 * 台帳の `goldenHash` は、書き手すべてで「前回配置した**有効な** golden（同梱 golden に overlay を
 * 重ねた後）の指紋」＝三方向照合の G_old。道 P2（ローカルを残す）の行では、これは overlay の中身
 * ＝ローカルの指紋であって、同梱 golden の指紋ではない。
 * 「ローカルがどの同梱 golden を元に直したか」が要る読み手（Golden 昇格ブラウザの判定 M4）は、
 * `goldenHash` を直接読まず、必ずこの入口を通す。
 * ------------------------------------------------------------------ */

/**
 * 索引の行を path で引く表を作る。正規化後に同じ path の行が複数あって内容が違うときは、
 * どれが正しいか決められないので、その path を表に載せない（＝ 信用しない側へ倒す）。
 */
export function buildOverlayLookup(
  entries: ReadonlyArray<OverlayEntry>
): Map<string, OverlayEntry> {
  const lookup = new Map<string, OverlayEntry>()
  const ambiguous = new Set<string>()
  for (const e of entries) {
    const path = normalizeRelPath(e.path)
    if (ambiguous.has(path)) continue
    const prev = lookup.get(path)
    if (prev === undefined) {
      lookup.set(path, e)
      continue
    }
    const same =
      prev.contentHash === e.contentHash &&
      prev.baseGoldenHash === e.baseGoldenHash &&
      prev.derivedFromGoldenHash === e.derivedFromGoldenHash
    if (!same) {
      lookup.delete(path)
      ambiguous.add(path)
    }
  }
  return lookup
}

/**
 * 台帳の 1 行について、「その行の中身が元にした同梱 golden の指紋」を返す唯一の入口。
 *
 * - 台帳の指紋が索引の同じ path の行の `contentHash` と一致（＝ その行は overlay の中身を指す）:
 *   - `derivedFromGoldenHash` が string → それ
 *   - `null`（不明）・欄なし（旧い形）→ 台帳の指紋のまま（＝ 同梱 golden とは一致しない値。信用しない）
 * - 一致しない／索引に無い → 台帳の指紋（有効 golden ＝ 同梱 golden の指紋）をそのまま返す
 *
 * owner は見ない。道 P2 の後に deploy が owner `golden` で書いた行（指紋が overlay の中身）も同じ形になるため。
 * 「信用しない」は常に「台帳の指紋のまま返す」で表す。これは同梱 golden の指紋とは（中身が同じでない限り）
 * 一致しないので、読み手は「今の golden から直した」とは判定できず、止まる側に倒れる。
 *
 * 旧い形（欄なし）の行は、`baseGoldenHash` を元にした版と読まない。`baseGoldenHash` は反映を決めた時点の
 * golden で、`conflict` を「ローカルを残す」で解決した行では進んだ後の golden になる。行の記録だけでは
 * その場合と正常な場合を区別できず、控えの名前・時刻のような正規でない記録で補うことも採らない
 * （golden の巻き戻しを止める門番は、分からないときに止める側へ倒す）。
 */
export function bundledBaseHashOf(
  entry: Pick<ManifestEntry, 'path' | 'goldenHash'>,
  lookup: ReadonlyMap<string, OverlayEntry>
): string {
  const ov = lookup.get(normalizeRelPath(entry.path))
  if (ov === undefined || ov.contentHash !== entry.goldenHash) return entry.goldenHash
  return typeof ov.derivedFromGoldenHash === 'string' ? ov.derivedFromGoldenHash : entry.goldenHash
}

/**
 * 「ローカルを残す」を書く時点で、新しい索引の行の `derivedFromGoldenHash` を、反映前の台帳の行 `old` と
 * 反映前の索引から導く。反映後は台帳の行が上書きされるので、この時点でしか導けない。
 *
 * - `old` が無い、または owner が golden・promoted 以外（user・adopted は「golden と証明できない」）→ null
 * - owner が promoted: 台帳の指紋が索引の `contentHash` と一致し、その行に string の由来があるときだけ引き継ぐ。
 *   一致しない（中断・手編集・別反映）・由来が null・旧い形（証跡を取れない）→ null
 * - owner が golden: 索引に一致する行があればその由来（string のみ。null・旧い形は null）、
 *   一致しなければ台帳の指紋（配った有効 golden ＝ 同梱 golden の指紋）
 *
 * `user-modified`（G_old＝G_new）では `old` の指紋が同梱 golden そのもの、`conflict`（G_old≠G_new）では
 * 進む前に配った golden が元になる（進んだ後の golden ではない）。
 */
export function derivedFromForPromote(
  old: Pick<ManifestEntry, 'path' | 'goldenHash' | 'owner'> | undefined,
  lookup: ReadonlyMap<string, OverlayEntry>
): string | null {
  if (old === undefined) return null
  if (old.owner !== 'golden' && old.owner !== 'promoted') return null
  const ov = lookup.get(normalizeRelPath(old.path))
  const matched = ov !== undefined && ov.contentHash === old.goldenHash
  if (matched) {
    return typeof ov.derivedFromGoldenHash === 'string' ? ov.derivedFromGoldenHash : null
  }
  return old.owner === 'promoted' ? null : old.goldenHash
}

/** overlay 1 件を破棄する（実体と索引の両方から消す）。実体が無くても索引は掃除する。 */
export async function discardOverlayEntry(parcFermeDir: string, rel: string): Promise<void> {
  const abs = overlayFilePath(parcFermeDir, rel)
  if (abs !== null) await rm(abs, { force: true }).catch(() => {})
  const index = await readOverlayIndex(parcFermeDir)
  const norm = normalizeRelPath(rel)
  await writeOverlayIndex(parcFermeDir, {
    version: OVERLAY_INDEX_VERSION,
    entries: index.entries.filter((e) => e.path !== norm)
  })
}
