/**
 * goldenReconcileService — golden 配置先と同梱 golden の照合をアプリ動線に接続する層。
 *
 * `goldenManifest.ts` は純粋なライブラリ（判定と I/O プリミティブ）であり、
 * 「いつ・どのディレクトリに対して走らせるか」は持たない。本ファイルがその配線を担う。
 *
 * 責務は `ensureBaseline()`（D5）、`runStartupReconcile()`（§6.2）、
 * および確認ダイアログの背後（§9.4 / `applyPendingReconcile` `deferPendingReconcile`）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

import {
  MANIFEST_VERSION,
  StaleDestinationError,
  backupAndReplace,
  buildManifest,
  computeSetHash,
  detectPathCollisions,
  getManifestPath,
  hashFileAt,
  hashFileBuffer,
  hashSourceMap,
  isHashExcluded,
  isSkippedFile,
  isTextFile,
  normalizeRelPath,
  readManifest,
  reconcile,
  writeManifest,
  type FileOwner,
  type GoldenManifest,
  type ManifestEntry,
  type ReconcileCase,
  type ReconcileItem,
  type UnmanagedRecord
} from './goldenManifest'
import {
  buildOverlayLookup,
  derivedFromForPromote,
  getOverlayDir,
  promoteOverlayFile,
  readOverlayIndex,
  writeOverlayIndex,
  type OverlayEntry
} from './goldenOverlay'
import {
  getDefaultProvenancePaths,
  readAdoptedRegistry,
  type ProvenancePaths
} from './skillProvenance'
import { getPromotedRelPaths } from './goldenPromotion'

/** `ensureBaseline` が何もしなかった / できなかった理由。 */
export type BaselineSkipReason =
  /** 既に manifest がある。移行は不要（冪等） */
  | 'manifest-exists'
  /** 配置先が無い、または golden 由来のファイルが 1 件も無い。新規配置は deploy の担当 */
  | 'not-populated'
  /** 同梱 golden の一部が読めない。壊れた配布物からベースラインを作らない（fail-closed） */
  | 'source-unreadable'
  /** 配置先 FS 上で同一実体に落ちうるパスがある（§9.10）。fail-closed */
  | 'path-collisions'
  /** 採用レジストリが破損。adopted を user と誤記録しないため中断（fail-closed） */
  | 'adopted-registry-unreadable'

export interface EnsureBaselineResult {
  /** manifest を書いたか */
  created: boolean
  /** `created: false` のときの理由 */
  reason?: BaselineSkipReason
  manifestPath: string
  /** 記録したエントリ数 */
  entryCount: number
  /** 出自別の内訳（移行結果の可視化用） */
  owners: { golden: number; adopted: number; user: number; promoted: number }
  /**
   * golden には在るが配置先に無かった相対パス。**エントリを作らない**。
   *
   * 配置した事実が無いものに `goldenHash` を書くと「配置記録の捏造」になる。
   * 記録しなければ次回照合で `goldenOld === null` かつ配置先不在 → ケース5 `new` となり、
   * 無確認で書かれる（追加であって上書きではないため安全）。
   */
  omittedAbsent: string[]
  /** fail-closed の原因（`source-unreadable` 時） */
  sourceUnreadable: string[]
  /** fail-closed の原因（`path-collisions` 時） */
  pathCollisions: string[][]
}

const EMPTY_RESULT_FIELDS = {
  entryCount: 0,
  owners: { golden: 0, adopted: 0, user: 0, promoted: 0 },
  omittedAbsent: [] as string[],
  sourceUnreadable: [] as string[],
  pathCollisions: [] as string[][]
}

/**
 * 採用レジストリの `target`（絶対パス）を配置先ルート相対へ写す。
 *
 * レジストリは skill 名ではなく**採用時の実 target パス**を持っているため、
 * `skills/<name>/SKILL.md` のような命名規約を推測せずに対応付けできる。
 * `targetDir` の外を指すエントリ（別ホーム・可搬前の記録）は対象外として捨てる。
 */
/**
 * 現配布に含まれる相対パスの集合。
 *
 * `hashSourceMap()` の除外規則（`settings.json` / `.gitkeep`）と**同一でなければならない**。
 * ここがずれると `goldenSetHash` の対象範囲が `reconcile()` の計算とずれ、
 * 集合ハッシュが一致しなくなって早期打ち切りが機能しなくなる。
 */
function goldenRelSet(goldenFiles: Map<string, string>): Set<string> {
  const out = new Set<string>()
  for (const rel of goldenFiles.keys()) {
    const norm = normalizeRelPath(rel)
    if (isSkippedFile(norm) || isHashExcluded(norm)) continue
    out.add(norm)
  }
  return out
}

function toTargetRelative(targetDir: string, absTarget: string): string | null {
  const rel = normalizeRelPath(relative(targetDir, absTarget))
  if (rel === '' || rel.startsWith('../') || rel === '..') return null
  return rel
}

/**
 * 移行ベースライン（D5）。
 *
 * manifest を持たない既存ユーザーに対し、**配置先へ 1 バイトも書かずに**
 * 実測だけで manifest を作る。所有者は推測ではなく測定で決める:
 *
 * - 採用レジストリに載っている → `adopted`（§9.7。以後ユーザー改変扱いしない）
 * - 配置先の内容が同梱 golden と一致 → `golden`
 * - 一致しない → `user`（「ユーザーが書いた」ではなく **「golden と証明できない」** の意。§9.9）
 *
 * `goldenHash` は 3 者いずれも**現時点の同梱 golden のハッシュ** `G_new` を記録する。
 * これは「ベースライン時点の golden を基準点とする」という宣言であり、
 * 配置先実体 `U` を書くのは誤り（`U` を書くと次回 golden 更新時に
 * ケース2 `auto-update` へ落ち、ユーザーの改変を**無確認で破壊する**）。
 * `G_new` を書けば `user` は次回ケース3 `user-modified` ＝ 確認付きとなり、
 * 「証明できないものは黙って上書きしない」という不変条件が保たれる。
 *
 * `exec` は記録しない。実行ビットはハッシュ対象外の付随情報であり（§9.10）、
 * 判定に使われる箇所も無い。実配置が起きた時点で deploy が正しく記録する。
 *
 * @returns 書いたか / 書かなかった理由と、移行結果の内訳
 */
export async function ensureBaseline(opts: {
  /** 記録するテンプレート名 */
  templateName: string
  /** `rel → 同梱 golden の絶対パス`（deploy の mergedFiles と同一の集合） */
  goldenFiles: Map<string, string>
  /** 配置先ルート（通常 `~/.claude`）。**ここには一切書かない** */
  targetDir: string
  /** manifest の置き場（通常 `~/.ccpit`）。`targetDir` とは別でなければならない */
  parcFermeDir: string
  provenancePaths?: ProvenancePaths
  /**
   * 逆向き反映が有効な相対パス（ADR 0002）。
   *
   * ここに載る rel は `golden` ではなく **`promoted`** として記録する。
   * 内容は overlay（＝ユーザーの反映内容）と一致するのでハッシュ一致判定では `golden` に見えるが、
   * それで記録すると台帳再生成のたびに「配布元由来ではない」事実が消え、
   * 次の配布更新で**無確認上書き**へ落ちる（`classifyFile` の `promoted` 分岐が効かなくなる）。
   */
  overlayActivePaths?: ReadonlySet<string>
  /** 逆昇格が有効な相対パス（W-2 / Round 4 耐久回復） */
  promotedPaths?: ReadonlySet<string>
  /** ベースラインを測定した時刻（テスト用に注入可能） */
  now?: Date
}): Promise<EnsureBaselineResult> {
  const manifestPath = getManifestPath(opts.parcFermeDir)
  const base = { ...EMPTY_RESULT_FIELDS, manifestPath }

  // 1) 冪等性: 既に記録があるなら移行しない。既存 manifest を上書きすると
  //    実配置で得た正しい G_old が実測値に置き換わり、履歴が失われる。
  if ((await readManifest(manifestPath)) !== null) {
    return { ...base, created: false, reason: 'manifest-exists' }
  }

  // 2) 配置先が空なら移行対象ではない（新規配置は deploy が manifest ごと作る）
  if (!existsSync(opts.targetDir)) {
    return { ...base, created: false, reason: 'not-populated' }
  }
  const dirEntries = await readdir(opts.targetDir).catch(() => [] as string[])
  if (dirEntries.length === 0) {
    return { ...base, created: false, reason: 'not-populated' }
  }

  // 3) 同梱 golden 側をハッシュ化。読めないものが 1 件でもあれば中断（fail-closed）。
  //    壊れた配布物を基準点として焼き付けると、以後の照合が全て誤った基準で走る。
  const { map: goldenHashes, unreadable } = await hashSourceMap(opts.goldenFiles)
  if (unreadable.length > 0) {
    return { ...base, created: false, reason: 'source-unreadable', sourceUnreadable: unreadable }
  }

  // 4) 大小文字非区別 FS での実体衝突（§9.10）。基準点作成そのものを中断する
  const pathCollisions = detectPathCollisions(goldenHashes.keys())
  if (pathCollisions.length > 0) {
    return { ...base, created: false, reason: 'path-collisions', pathCollisions }
  }

  // 5) 採用レジストリ。破損時は throw されるので握って中断する。
  //    ここで握り潰して [] 扱いにすると、採用済み skill が全て `user` として記録され、
  //    次回起動で「あなたが改変しました」という誤った確認ダイアログを出してしまう。
  let adoptedRels: Set<string>
  try {
    const registry = await readAdoptedRegistry(opts.provenancePaths ?? getDefaultProvenancePaths())
    adoptedRels = new Set(
      registry
        .map((e) =>
          typeof e?.target === 'string' ? toTargetRelative(opts.targetDir, e.target) : null
        )
        .filter((r): r is string => r !== null)
    )
  } catch {
    return { ...base, created: false, reason: 'adopted-registry-unreadable' }
  }

  // 昇格状態ストア（golden-promotion-state.json）からも昇格済みパスを自動読取（同期失敗時・manifest不在時の耐久的回復）
  const promoStatePath = join(opts.parcFermeDir, 'golden-promotion-state.json')
  const persistentPromoted = getPromotedRelPaths(promoStatePath)

  // 6) 実測。配置先を読むだけで、書き込みは一切行わない
  const measured = new Map<string, string>()
  const owners = new Map<string, FileOwner>()
  const counts = { golden: 0, adopted: 0, user: 0, promoted: 0 }
  const omittedAbsent: string[] = []

  for (const [rel, goldenNew] of goldenHashes) {
    const deployedHash = await hashFileAt(join(opts.targetDir, rel))
    if (deployedHash === null) {
      // 配置先に無い ＝ 配置した事実が無い。記録を作らない（次回ケース5 `new`）
      omittedAbsent.push(rel)
      continue
    }
    const normRel = normalizeRelPath(rel)
    const isPromoted =
      (opts.overlayActivePaths?.has(rel) ?? false) ||
      (opts.overlayActivePaths?.has(normRel) ?? false) ||
      (opts.promotedPaths?.has(rel) ?? false) ||
      (opts.promotedPaths?.has(normRel) ?? false) ||
      persistentPromoted.has(normRel)

    const owner: FileOwner = isPromoted
      ? 'promoted'
      : adoptedRels.has(rel)
        ? 'adopted'
        : deployedHash === goldenNew
          ? 'golden'
          : 'user'
    measured.set(rel, goldenNew)
    owners.set(rel, owner)
    counts[owner] += 1
  }

  if (measured.size === 0) {
    // golden 由来のファイルが 1 件も配置されていない ＝ 実質新規環境。
    // 空の manifest を書くと以後 `manifest-exists` で移行が二度と走らなくなるため書かない
    return { ...base, created: false, reason: 'not-populated', omittedAbsent }
  }

  omittedAbsent.sort()

  const manifest = buildManifest({
    template: opts.templateName,
    goldenHashes: measured,
    owners,
    deployedAt: (opts.now ?? new Date()).toISOString()
  })

  await mkdir(opts.parcFermeDir, { recursive: true })
  await writeManifest(manifestPath, manifest)

  return {
    created: true,
    manifestPath,
    entryCount: manifest.entries.length,
    owners: counts,
    omittedAbsent,
    sourceUnreadable: [],
    pathCollisions: []
  }
}

/* ------------------------------------------------------------------ *
 * P4 — 起動時照合と無確認適用（§6.2）
 * ------------------------------------------------------------------ */

/** `runStartupReconcile` の帰結。 */
export type StartupReconcileStatus =
  /** 差分なし。呼び出し側は何もしなくてよい */
  | 'clean'
  /** 全ての自動適用が成功し、確認待ちも残っていない */
  | 'applied'
  /** 確認待ち、または書き込み失敗が残っている（P5 の提示対象） */
  | 'pending'
  /** 同梱 golden が読めない。**何も書いていない**（fail-closed） */
  | 'source-unreadable'
  /** パス衝突（§9.10）。**何も書いていない**（fail-closed） */
  | 'path-collisions'

export interface StartupReconcileFailure {
  path: string
  message: string
}

export interface StartupReconcileResult {
  status: StartupReconcileStatus
  manifestPath: string
  /** 書き込みに成功した相対パス（manifest を更新した対象と一致する） */
  applied: string[]
  /** 書き込みに失敗した相対パス。manifest の当該エントリは**更新していない**（D7） */
  failed: StartupReconcileFailure[]
  /** 確認を要する項目。P4 では保持するだけで何もしない（P5 が提示する） */
  pending: ReconcileItem[]
  /** 作成した `.bak` の実パス */
  backups: string[]
  unchangedCount: number
  /**
   * 台帳のずれだけを直した相対パス（ADR 0002・no-op 自動解消）。
   *
   * `U === G_new` すなわち**適用しても内容が 1 バイトも変わらない**項目。
   * 確認する意味が無い（得るものも失うものも無い）のでダイアログへ出さず、
   * 配置先には一切書かずに台帳のハッシュだけを実態へ合わせる。
   * `applied` と分けて数えるのは、「適用した」と「記録を直した」を混同しないため。
   */
  ledgerHealed: string[]
  /** 「もう問わない」で提示を抑止した項目（未追従の可視化用に件数と一覧を残す） */
  unmanaged: ReconcileItem[]
  /** manifest を書き換えたか */
  manifestUpdated: boolean
  sourceUnreadable: string[]
  pathCollisions: string[][]
  /** ベースライン移行（D5）が同時に走った場合のその結果 */
  baseline?: EnsureBaselineResult
}

/**
 * 2つのテキストファイルの内容が、改行コード正規化（CRLF→LF）後に完全に一致するかを判定する純粋ヘルパー。
 * バイナリ・NULLバイト含有・不正UTF-8は安全に false を返す。
 */
export function isContentEqualNormalized(sourcePath: string, destPath: string): boolean {
  try {
    if (!existsSync(sourcePath) || !existsSync(destPath)) return false
    if (!isTextFile(sourcePath) || !isTextFile(destPath)) return false

    const srcBuf = readFileSync(sourcePath)
    const dstBuf = readFileSync(destPath)

    if (srcBuf.includes(0) || dstBuf.includes(0)) return false

    const decoder = new TextDecoder('utf-8', { fatal: true })
    const srcText = decoder.decode(srcBuf)
    const dstText = decoder.decode(dstBuf)

    return srcText.replace(/\r\n/g, '\n') === dstText.replace(/\r\n/g, '\n')
  } catch {
    return false
  }
}

/**
 * 適用しても配置先の内容が変わらない項目か（ADR 0002 / W-1 改行正規化対応）。
 *
 * 三方向のケース表には `U` vs `G_new` の列が無いため、この状態は `case` のどこにも現れない。
 * 実測（2026-09-07）では「衝突」表示の 2 件がこれで、内容差ゼロにもかかわらず
 * 実損のある「ユーザー編集」表示と同じ見た目で並んでいた。
 *
 * W-1 対応:
 * 生バイトハッシュが異なっていても、改行コード（CRLF / LF）の差だけで
 * テキスト内容が完全に同一である場合も no-op とみなす。
 * これにより、Windows 環境での EOL 差による不要な確認ダイアログ（誤検知）を抑止し、
 * 台帳のハッシュだけを安全に訂正する。
 */
export function isNoOpItem(item: ReconcileItem): boolean {
  if (item.deployedHash !== null && item.deployedHash === item.goldenNewHash) {
    return true
  }

  // W-1: 改行正規化による実質同一性判定
  if (
    item.deployedHash !== null &&
    item.sourcePath &&
    item.destPath
  ) {
    return isContentEqualNormalized(item.sourcePath, item.destPath)
  }

  return false
}

/**
 * 起動時照合（§6.2）。`app.whenReady()` から 1 回だけ呼ぶ。
 *
 * ## 手順
 * 1. `ensureBaseline()`（冪等）
 * 2. `reconcile()`
 * 3. 異常があれば**何もせず**返す（fail-closed）
 * 4. `autoApply` を `backupAndReplace` で適用
 * 5. **書き込みに成功したものだけ** manifest へ反映
 *
 * ## なぜ内部で `ensureBaseline` を呼ぶか
 * 順序は安全性に直結する。manifest 不在のまま照合すると、既存ユーザーの全ファイルが
 * `goldenOld === null` かつ配置先ありで**一斉に `conflict`** へ落ち、初回起動でユーザーが
 * 数十件の確認ダイアログに晒される（D5 が防ごうとしている事象そのもの）。
 * 呼び出し側の順序遵守に委ねず、ここで不変条件を閉じる。`ensureBaseline` は
 * `manifest-exists` で即帰るので二重コストは無い。
 *
 * ## 部分失敗の扱い（D7 / Codex [3]）
 * `autoApply` を一括成功とみなして manifest を丸ごと更新すると、**書けていない内容を
 * 配置済みとして記録**してしまい、以後その差分は永久に検出されない。
 * よって manifest への反映は成功したパス単位で行い、失敗分は旧エントリを据え置く。
 *
 * ## `goldenSetHash` の決め方
 * 「記録済みハッシュの集合ハッシュ」を書く（＝*配布物* の集合ハッシュではない）。
 * 全て解決していれば両者は一致するので次回起動は早期打ち切りに乗る。
 * 未解決（失敗・確認待ち）が 1 件でもあれば値がずれるため、次回起動は per-file 走査へ落ち、
 * 取りこぼした差分が再度拾われる。**特別扱いのフラグを持たずに再試行が保証される**。
 */
export async function runStartupReconcile(opts: {
  templateName: string
  /** `rel → 同梱 golden の絶対パス`（deploy の mergedFiles と同一の集合） */
  goldenFiles: Map<string, string>
  targetDir: string
  parcFermeDir: string
  provenancePaths?: ProvenancePaths
  /** 逆向き反映が有効な rel（ADR 0002。ベースライン移行の出自判定に要る） */
  overlayActivePaths?: ReadonlySet<string>
  /** 逆昇格が有効な相対パス（W-2 / Round 4 耐久回復） */
  promotedPaths?: ReadonlySet<string>
  /** 失効した逆向き反映の rel（ADR 0002。無確認適用から外す） */
  overlayStalePaths?: ReadonlySet<string>
  /** `.bak` の保持世代数 */
  backupKeep?: number
  now?: Date
}): Promise<StartupReconcileResult> {
  const manifestPath = getManifestPath(opts.parcFermeDir)
  const at = opts.now ?? new Date()

  const baseline = await ensureBaseline({
    templateName: opts.templateName,
    goldenFiles: opts.goldenFiles,
    targetDir: opts.targetDir,
    parcFermeDir: opts.parcFermeDir,
    provenancePaths: opts.provenancePaths,
    overlayActivePaths: opts.overlayActivePaths,
    promotedPaths: opts.promotedPaths,
    now: at
  })

  const manifest = await readManifest(manifestPath)
  const report = await reconcile({
    goldenFiles: opts.goldenFiles,
    targetDir: opts.targetDir,
    manifest,
    staleOverlayPaths: opts.overlayStalePaths
  })

  // ADR 0002: 確認対象のうち「適用しても内容が変わらない」ものを分ける。
  // 問う意味が無い問いを人へ出さない — 狂っているのは台帳だけなので、そこだけ直す。
  const noOps = report.needsConfirm.filter(isNoOpItem)
  const realConfirm = report.needsConfirm.filter((i) => !isNoOpItem(i))

  const base = {
    manifestPath,
    applied: [] as string[],
    failed: [] as StartupReconcileFailure[],
    pending: realConfirm,
    backups: [] as string[],
    unchangedCount: report.unchangedCount,
    ledgerHealed: [] as string[],
    unmanaged: report.unmanaged,
    manifestUpdated: false,
    sourceUnreadable: report.sourceUnreadable,
    pathCollisions: report.pathCollisions,
    baseline
  }

  // fail-closed: 壊れた配布物・衝突パスに対しては配置も manifest 更新も行わない。
  // ここで «読めたものだけ適用» に妥協すると、欠損した配布物で部分適用が進み、
  // 「何が配置済みか」の記録が実態から静かに乖離する。
  if (report.sourceUnreadable.length > 0) {
    return { ...base, status: 'source-unreadable', pending: [] }
  }
  if (report.pathCollisions.length > 0) {
    return { ...base, status: 'path-collisions', pending: [] }
  }

  // ADR 0002 / Round 3 指摘 1: 台帳未登録だが、配置先に実体が存在し golden と内容一致するエントリを検出。
  // （Promotion 後の台帳同期失敗時や、外部追加時の自動自己修復）
  const missingHeals: Array<{ path: string; goldenHash: string; owner: FileOwner }> = []
  if (manifest) {
    const existingPaths = new Set(manifest.entries.map((e) => normalizeRelPath(e.path)))
    for (const [rawRel, sourcePath] of opts.goldenFiles) {
      const rel = normalizeRelPath(rawRel)
      if (existingPaths.has(rel)) continue

      const destPath = join(opts.targetDir, rel)
      if (!existsSync(destPath)) continue

      const goldenHash = await hashFileAt(sourcePath)
      const deployedHash = await hashFileAt(destPath)
      if (goldenHash === null || deployedHash === null) continue

      const isMatch =
        goldenHash === deployedHash ||
        isContentEqualNormalized(sourcePath, destPath)

      if (isMatch) {
        // 逆昇格後の台帳同期失敗からの回復、および手元既存一致ファイルの安全保護（上流前進時の無確認上書き防止）
        missingHeals.push({
          path: rel,
          goldenHash,
          owner: 'promoted'
        })
      }
    }
  }

  if (report.clean && missingHeals.length === 0) {
    return { ...base, status: 'clean' }
  }

  // --- 適用 ---
  const applied: ReconcileItem[] = []
  const failed: StartupReconcileFailure[] = []
  const backups: string[] = []
  /**
   * 分類後に配置先が変わったため適用を見送った項目。
   *
   * これは失敗ではなく「無確認適用の前提が崩れた」状態なので `failed` に混ぜない。
   * 確認待ちへ回し、中身は次回の再分類から導出させる（今の分類はもう古い）。
   */
  const stale: ReconcileItem[] = []

  const appliedResults: AppliedResult[] = []
  for (const item of report.autoApply) {
    try {
      const r = await applyReconcileItem(item, { parcFermeDir: opts.parcFermeDir, backupKeep: opts.backupKeep, now: at })
      if (r.backupPath !== null) backups.push(r.backupPath)
      applied.push(item)
      appliedResults.push({ item, verifiedHash: r.verifiedHash })
    } catch (err) {
      if (err instanceof StaleDestinationError) {
        stale.push(item)
        continue
      }
      // 1 件の失敗で残りを諦めない。失敗は記録して次へ進む
      //（部分適用は許容し、記録の側で正確に表現する — D7）
      failed.push({ path: item.path, message: err instanceof Error ? err.message : String(err) })
    }
  }

  // 台帳のずれだけを直す（no-op 自動解消 & 台帳欠落の自己修復）。**配置先へは 1 バイトも書かない**。
  //
  // `commitApplied` を使わないのは、あちらが `owner: 'golden'` を強制するため。
  // ここでやっているのは「適用」ではなく「記録の訂正」なので、主張はハッシュに留め、
  // `adopted` / `promoted` といった出自は保存する（`writeLedger` は owner 未指定で既存を保つ）。
  const ledgerHealed = [...noOps.map((i) => i.path), ...missingHeals.map((m) => m.path)]
  const healUpdates: LedgerUpdate[] = [
    ...noOps.map((i) => ({ path: i.path, goldenHash: i.goldenNewHash })),
    ...missingHeals.map((m) => ({ path: m.path, goldenHash: m.goldenHash, owner: m.owner }))
  ]

  const appliedUpdates = appliedResults.map(writtenUpdate)

  // 解消済み（適用・no-op）は「後で」の持ち越しから外す。残置すると解決済みなのに
  // 毎起動で全走査を強い続ける（`reconcile()` は `deferred` が空でない限り打ち切らない）。
  const resolvedPaths = new Set([...applied.map((i) => i.path), ...ledgerHealed])
  const prevDeferred = manifest?.deferred ?? []
  const nextDeferred = prevDeferred.filter((p) => !resolvedPaths.has(p))
  const deferredChanged = nextDeferred.length !== prevDeferred.length

  const updates = [...appliedUpdates, ...healUpdates]
  const manifestUpdated =
    updates.length > 0 || deferredChanged
      ? await writeLedger({
          manifestPath,
          manifest,
          updates,
          templateName: opts.templateName,
          at,
          goldenRels: goldenRelSet(opts.goldenFiles),
          deferred: nextDeferred
        })
      : false

  // 適用を見送った項目も確認待ちに含める。ここで落とすと、書き換わった配置先が
  // 誰にも提示されないまま «applied» と報告される（静かな取りこぼし）。
  const pending = [...realConfirm, ...stale]

  const status: StartupReconcileStatus =
    failed.length === 0 && pending.length === 0 ? 'applied' : 'pending'

  return {
    ...base,
    status,
    applied: applied.map((i) => i.path),
    failed,
    pending,
    backups,
    ledgerHealed,
    manifestUpdated
  }
}

/**
 * `writeLedger` が 1 エントリへ加える変更。
 *
 * 配置先へ**書いた**更新（`written: true`）は、書いた直後に読み戻した指紋 `postHash` を必ず持つ（型で強制）。
 * 書いていない更新（台帳のずれを直しただけ・overlay への反映）は `postHash` を持たず、既存行の値を保つ。
 * 「書いた」更新は `writtenUpdate` でしか作らない（path と `postHash` を別々に渡して取り違えないため）。
 */
type LedgerUpdate = {
  path: string
  /** 記録する `G_old` */
  goldenHash: string
  /**
   * 記録する出自。**未指定なら既存を保持**する（新規エントリなら `golden`）。
   * 「適用した」は `golden`、「逆向き反映した」は `promoted`、
   * 「台帳のずれを直しただけ」は**未指定**（主張を増やさない）。
   */
  owner?: FileOwner
} & ({ written: true; postHash: string } | { written?: false; postHash?: undefined })

/** 適用（`backupAndReplace`）が成功した 1 件。`verifiedHash` は書いた直後の読み戻し指紋。 */
interface AppliedResult {
  item: ReconcileItem
  verifiedHash: string
}

/** 適用した項目から「書いた」更新を作る（path は項目のもの・`postHash` は同じ書き込みの読み戻し指紋）。 */
function writtenUpdate(a: AppliedResult): LedgerUpdate {
  return {
    path: a.item.path,
    goldenHash: a.item.goldenNewHash,
    owner: 'golden',
    written: true,
    postHash: a.verifiedHash
  }
}

/** overlay ディレクトリの下のファイルか（文字列の前方一致でなく相対パスで判定する）。 */
function isUnderOverlayDir(sourcePath: string, overlayDir: string): boolean {
  const rel = relative(resolve(overlayDir), resolve(sourcePath))
  return rel !== '' && !/^\.\.(?:[\\/]|$)/.test(rel) && !isAbsolute(rel)
}

/**
 * 照合の適用 1 件（`backupAndReplace`）。同梱 golden 由来の配置だけ、git の版と同じ LF で書く。
 * overlay（利用者が「ローカルを残す」と決めた版）を供給元にする配置は、利用者の選んだバイトのまま複写する。
 */
async function applyReconcileItem(
  item: ReconcileItem & { expectedDestHash?: string | null },
  ctx: { parcFermeDir: string; backupKeep?: number; now: Date }
): Promise<AppliedResult & { backupPath: string | null }> {
  const fromOverlay = isUnderOverlayDir(item.sourcePath, getOverlayDir(ctx.parcFermeDir))
  const { backupPath, verifiedHash } = await backupAndReplace(fromOverlay ? item : { ...item, eol: 'lf' }, {
    keep: ctx.backupKeep,
    now: ctx.now
  })
  return { item, verifiedHash, backupPath }
}

/**
 * manifest を書き出す唯一の経路（`deploy()` の新規作成を除く）。
 *
 * ## なぜ 1 本にまとめるか
 * ここは**明示列挙で書く**（スプレッドで素通しできない — `goldenSetHash` と `deployedAt` を
 * 必ず計算し直す必要があるため）。列挙を複数箇所に散らすと、後から増えたキー
 * （`deferred` / `unmanaged`）をどれか 1 箇所が書き忘れ、**次の書込で静かに消える**。
 * 実際 `unmanaged` は「読めるが次の適用で消える」を作りやすい形をしている。
 *
 * golden から取り除かれたパスのエントリは**落とさない**（§9.11）。次の配布で戻ってきたときに
 * `G_old` を失っていると、無改変のファイルを `conflict` と誤判定するため。
 */
async function writeLedger(args: {
  manifestPath: string
  manifest: GoldenManifest | null
  updates: LedgerUpdate[]
  templateName: string
  at: Date
  /** 現配布に含まれる相対パス（`goldenSetHash` の対象範囲） */
  goldenRels: Set<string>
  /**
   * `deferred` の差し替え。**未指定なら既存を保持**し、`[]` を渡すとキーごと消す。
   * 「後で」を解消した項目を残置すると、解決済みなのに毎起動で全走査を強い続ける
   * （`reconcile()` は `deferred` が空でない限り早期打ち切りに乗らない）。
   */
  deferred?: string[]
  /** `unmanaged` の差し替え。**未指定なら既存を保持**し、`[]` を渡すとキーごと消す。 */
  unmanaged?: UnmanagedRecord[]
}): Promise<boolean> {
  const { manifest, updates, at } = args
  const deployedAt = at.toISOString()
  const nextDeferred = args.deferred ?? manifest?.deferred
  const nextUnmanaged = args.unmanaged ?? manifest?.unmanaged

  const byPath = new Map<string, ManifestEntry>()
  for (const e of manifest?.entries ?? []) byPath.set(e.path, e)

  for (const u of updates) {
    const prev = byPath.get(u.path)
    // 書いた更新はその読み戻し指紋。書いていない更新（台帳のずれの訂正など）は前の値を保つ
    // （この行は明示列挙で作り直すので、書き足さないと `postHash` は黙って消える）
    const postHash = u.written ? u.postHash : prev?.postHash
    byPath.set(u.path, {
      path: u.path,
      goldenHash: u.goldenHash,
      owner: u.owner ?? prev?.owner ?? 'golden',
      deployedAt,
      ...(prev?.exec !== undefined ? { exec: prev.exec } : {}),
      ...(postHash ? { postHash } : {})
    })
  }

  const entries = [...byPath.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  )

  // 集合ハッシュは「現配布に含まれるパスについて、記録済みハッシュを並べたもの」。
  // 対象を現配布のパスに限るのは `reconcile()` 側の計算と範囲を揃えるため。
  // golden から取り除かれたパスのエントリ（§9.11 で保持している分）を混ぜると、
  // どれだけ同期が取れていても集合ハッシュが永久に一致せず、早期打ち切りが死ぬ。
  const setHash = computeSetHash(
    entries
      .filter((e) => args.goldenRels.has(e.path))
      .map((e) => ({ path: e.path, hash: e.goldenHash }))
  )

  await writeManifest(args.manifestPath, {
    manifestVersion: manifest?.manifestVersion ?? MANIFEST_VERSION,
    template: manifest?.template ?? args.templateName,
    goldenSetHash: setHash,
    deployedAt,
    entries,
    ...(nextDeferred !== undefined && nextDeferred.length > 0 ? { deferred: nextDeferred } : {}),
    ...(nextUnmanaged !== undefined && nextUnmanaged.length > 0 ? { unmanaged: nextUnmanaged } : {})
  })
  return true
}

/**
 * 適用に成功した項目を manifest へ反映して書き出す。
 *
 * `owner` は `golden` へ倒す: 配置先には今 golden の内容そのものが入っている。
 * `adopted` だったものを書き戻した場合も採用内容は既に失われている（`restore` ＝ ユーザーが消した）。
 */
async function commitApplied(args: {
  manifestPath: string
  manifest: GoldenManifest | null
  applied: AppliedResult[]
  templateName: string
  at: Date
  goldenRels: Set<string>
  deferred?: string[]
  unmanaged?: UnmanagedRecord[]
}): Promise<boolean> {
  const { applied, ...rest } = args
  return writeLedger({ ...rest, updates: applied.map(writtenUpdate) })
}

/* ------------------------------------------------------------------ *
 * P5 — 確認ダイアログの背後（§9.4 / ケース3・4）
 * ------------------------------------------------------------------ */

/** 確認ダイアログ 1 行分。renderer が描くのに要るものだけを渡す。 */
export interface PendingReconcileEntry {
  /** 正規化相対パス（`~/.claude` からの相対。実絶対パスは renderer へ出さない） */
  path: string
  case: ReconcileCase
  owner: FileOwner
  /**
   * 適用時に `.bak` を作るか。確認対象（ケース3/4）は配置先が存在するから常に真だが、
   * 「上書きされるが退避もされる」ことは UI の明示要件なので値として持たせる。
   */
  willBackup: boolean
  /**
   * 適用すると配置先の内容が変わるか（ADR 0002）。
   *
   * `case` はこれを語らない（ケース表に `U` vs `G_new` の列が無い）。
   * これが偽なら得るものも失うものも無い ＝ 問う意味が無い。
   */
  wouldChangeContent: boolean
  /** 台帳に配置記録があるか。偽なら「上流が進んだか」を判定できない */
  hasBaseRecord: boolean
  /**
   * 配布元に新規性があるか。**偽なら上書きは純粋な巻き戻し**
   * （戻る先の推奨状態が存在しないので、ADR 0001 の上書き根拠が空振りする）。
   */
  upstreamAdvanced: boolean
}

/**
 * `pending` を UI 向けへ射影する純粋関数。
 *
 * 絶対パス（`sourcePath` / `destPath`）と**生ハッシュは renderer へ渡さない**。
 * 危険度の判別に要るのは値そのものではなく「変わるか」「上流が進んだか」の真偽なので、
 * ここで導出して真偽値だけを渡す（従来の情報境界を保ったまま UI が判断できるようにする）。
 */
export function toPendingReconcileEntries(items: ReconcileItem[]): PendingReconcileEntry[] {
  return items.map((i) => ({
    path: i.path,
    case: i.case,
    owner: i.owner,
    willBackup: i.deployedHash !== null,
    wouldChangeContent: i.deployedHash !== i.goldenNewHash,
    hasBaseRecord: i.goldenOldHash !== null,
    upstreamAdvanced: i.goldenOldHash !== null && i.goldenOldHash !== i.goldenNewHash
  }))
}

/** 「何も書かなかった」理由（fail-closed）。 */
export type ApplyReconcileBlocked = 'source-unreadable' | 'path-collisions'

export interface ApplyReconcileResult {
  applied: string[]
  failed: StartupReconcileFailure[]
  backups: string[]
  /**
   * 要求されたが**再照合時点では確認対象でなくなっていた**パス。
   * ダイアログ表示中にユーザー自身が直した / 別経路で解消した場合に出る。
   */
  skipped: string[]
  manifestUpdated: boolean
  blocked?: ApplyReconcileBlocked
}

/**
 * 確認ダイアログで「OK」された項目を適用する（§9.4）。
 *
 * ## なぜ起動時の `pending` をそのまま書かないか
 * ダイアログは pull で出る（D3）ため、起動時の照合結果とユーザーのクリックの間には
 * 任意の時間が空く。その間に編集されたファイルへ古い判定で上書きをかけると、
 * **ユーザーが今書いた内容を、同意していない根拠で破棄する**ことになる。
 * よってここで `reconcile()` を引き直し、**今なお確認対象であるものだけ**を適用する。
 * 対象から外れたものは黙って落とさず `skipped` として返し、UI が説明できるようにする。
 *
 * fail-closed の判断は `runStartupReconcile` と同一（配布物破損・パス衝突では何も書かない）。
 */
export async function applyPendingReconcile(opts: {
  templateName: string
  goldenFiles: Map<string, string>
  targetDir: string
  parcFermeDir: string
  /** UI が「OK」した相対パス */
  paths: string[]
  backupKeep?: number
  now?: Date
}): Promise<ApplyReconcileResult> {
  const manifestPath = getManifestPath(opts.parcFermeDir)
  const at = opts.now ?? new Date()
  const requested = [...new Set(opts.paths.map(normalizeRelPath))]

  const manifest = await readManifest(manifestPath)
  const report = await reconcile({
    goldenFiles: opts.goldenFiles,
    targetDir: opts.targetDir,
    manifest
  })

  const base: ApplyReconcileResult = {
    applied: [],
    failed: [],
    backups: [],
    skipped: [],
    manifestUpdated: false
  }
  if (report.sourceUnreadable.length > 0) {
    return { ...base, skipped: requested, blocked: 'source-unreadable' }
  }
  if (report.pathCollisions.length > 0) {
    return { ...base, skipped: requested, blocked: 'path-collisions' }
  }

  const stillPending = new Map(report.needsConfirm.map((i) => [i.path, i]))
  const targets = requested.flatMap((p) => {
    const item = stillPending.get(p)
    return item ? [item] : []
  })
  const skipped = requested.filter((p) => !stillPending.has(p))

  const applied: AppliedResult[] = []
  const failed: StartupReconcileFailure[] = []
  const backups: string[] = []
  /**
   * 確認を得てから適用するまでの間に配置先が書き換わった項目。
   *
   * 同意の対象だった内容がもう存在しないので、その同意で上書きしてはいけない。
   * 失敗でもないため `skipped` として返し、次の分類で改めて提示させる。
   */
  const stale: string[] = []

  for (const item of targets) {
    try {
      const r = await applyReconcileItem(item, { parcFermeDir: opts.parcFermeDir, backupKeep: opts.backupKeep, now: at })
      if (r.backupPath !== null) backups.push(r.backupPath)
      applied.push({ item, verifiedHash: r.verifiedHash })
    } catch (err) {
      if (err instanceof StaleDestinationError) {
        stale.push(item.path)
        continue
      }
      failed.push({ path: item.path, message: err instanceof Error ? err.message : String(err) })
    }
  }

  // 適用できた項目は「後で」の持ち越しからも外す（解決済みを再提示しない・全走査を残さない）。
  const appliedPaths = new Set(applied.map((a) => a.item.path))
  const nextDeferred = (manifest?.deferred ?? []).filter((p) => !appliedPaths.has(p))

  const manifestUpdated =
    applied.length > 0
      ? await commitApplied({
          manifestPath,
          manifest,
          applied,
          templateName: opts.templateName,
          at,
          goldenRels: goldenRelSet(opts.goldenFiles),
          deferred: nextDeferred
        })
      : false

  return {
    applied: applied.map((a) => a.item.path),
    failed,
    backups,
    skipped: [...skipped, ...stale],
    manifestUpdated
  }
}

/**
 * 「後で」を永続化する（D6）。
 *
 * `deferred` は**再提示すべき項目の台帳ではない**。`reconcile()` はこれを
 * 「早期打ち切りに乗らない」フラグとしてのみ読み、再提示の中身は毎回の再分類から導出する。
 * よって解決済みのパスがここに残っても誤提示は起きず（`unchanged` は提示されない）、
 * 起きるのは全走査コストだけ — その掃除は `applyPendingReconcile` 側で行う。
 *
 * manifest が無い環境では何もしない（照合の土台が無く、記録する意味が無い）。
 */
export async function deferPendingReconcile(opts: {
  parcFermeDir: string
  paths: string[]
}): Promise<{ deferred: string[]; manifestUpdated: boolean }> {
  const manifestPath = getManifestPath(opts.parcFermeDir)
  const manifest = await readManifest(manifestPath)
  if (manifest === null) return { deferred: [], manifestUpdated: false }

  const next = [
    ...new Set([...(manifest.deferred ?? []), ...opts.paths.map(normalizeRelPath)])
  ].sort()
  if (next.length === 0) return { deferred: [], manifestUpdated: false }

  await writeManifest(manifestPath, { ...manifest, deferred: next })
  return { deferred: next, manifestUpdated: true }
}

/* ------------------------------------------------------------------ *
 * ADR 0002 — 逆向き反映と「もう問わない」を含む単一の解決経路
 * ------------------------------------------------------------------ */

/** 確認ダイアログ 1 行に対してユーザーが選んだ出口。 */
export type ReconcileAction =
  /** 退避のうえ配布元の内容で上書きする（ADR 0001 の従来動線） */
  | 'apply'
  /** 手元の内容を配布元へ反映する（ADR 0002・本件の主目的） */
  | 'promote'
  /** この項目については以後問わない（ADR 0002・上流が動けば失効する） */
  | 'unmanage'
  /** 次回起動で再提示する（ADR 0001 D6） */
  | 'defer'

export interface ReconcileDecision {
  path: string
  action: ReconcileAction
}

/** 要求されたが実行しなかった理由。**黙って落とさない**ための値。 */
export type ResolveSkipReason =
  /** 再照合時点で確認対象ではなくなっていた（ダイアログ表示中に解消された） */
  | 'not-pending'
  /** 分類後に配置先が書き換わった。その同意で書いてはいけない */
  | 'stale-destination'
  /** 配置記録が無く「手元の方が新しい」と言えない ＝ 反映の対象にしない */
  | 'no-base-record'
  /** 反映の書き込みに失敗した */
  | 'promote-failed'
  /**
   * 台帳が読めない（不在・破損・版不一致）。**何も実行しない**。
   *
   * ここで「実行はするが記録はしない」を選ぶと、ファイルは書き換わったのに配置記録が残らず、
   * 次回起動で同じ項目がまた確認対象になる（しかも `.bak` だけが増える）。
   * 「もう問わない」に至っては決定そのものが消える。**書いたのに記録しない**のは
   * 「記録したのに書いていない」と同じくらい悪いので、両方やらない側へ倒す。
   * 台帳は次回起動の `ensureBaseline` が実測から作り直す。
   */
  | 'no-ledger'

export interface ResolveSkip {
  path: string
  reason: ResolveSkipReason
}

export interface ResolveReconcileResult {
  /** 退避のうえ上書きした rel */
  applied: string[]
  /** 配布元へ反映した rel */
  promoted: string[]
  /** 以後問わないと記録した rel */
  unmanaged: string[]
  /** 次回へ持ち越した rel */
  deferred: string[]
  failed: StartupReconcileFailure[]
  backups: string[]
  skipped: ResolveSkip[]
  /** 反映先ディレクトリの実パス（「どこへ残ったか」を UI が示せるように） */
  overlayDir: string
  manifestUpdated: boolean
  blocked?: ApplyReconcileBlocked
}

/**
 * 確認ダイアログの決定をまとめて実行する（ADR 0002）。
 *
 * ## なぜ 1 本の関数・1 本の IPC なのか
 * 出口が 4 つに増えても、**承認と要求の組み立ては 1 か所に閉じる**（ADR 0001 の
 * `approvedPaths` が守っていた不変条件）。行ごとに別々の IPC を叩く形にすると、
 * 「一部だけ実行された」状態が UI と main の双方に散らばり、部分成功を成功と誤報する
 * 経路が再び生まれる（049 の再演）。ここで 1 回だけ再照合し、1 回だけ台帳を書く。
 *
 * ## なぜ起動時の分類をそのまま使わないか
 * ダイアログは pull で出る（D3）ため、分類とクリックの間に任意の時間が空く。
 * その間に編集されたファイルへ古い判定で書くと、**ユーザーが今書いた内容を、
 * 同意していない根拠で破棄する**ことになる。よって `reconcile()` を引き直し、
 * 今なお確認対象のものだけを扱う。外れたものは `skipped` として返す。
 *
 * ## 中断安全性（overlay 実体 → 索引 → 台帳 の順）
 * 3 つの書き込みは単一トランザクションではない。順序で安全側に倒す:
 * - overlay 実体だけ書けた時点で落ちた → 索引に無いので**使われない**（影響ゼロ）
 * - 索引まで書けた時点で落ちた → overlay は有効・台帳は旧 `G_old` のまま
 *   → 次回照合で `U === G_new` となり **no-op 自動解消**へ落ちて自力で収束する
 */
export async function resolvePendingReconcile(opts: {
  templateName: string
  goldenFiles: Map<string, string>
  targetDir: string
  parcFermeDir: string
  decisions: ReconcileDecision[]
  /** 失効した逆向き反映の rel（無確認適用から外すため `reconcile()` へ渡す） */
  overlayStalePaths?: ReadonlySet<string>
  backupKeep?: number
  now?: Date
}): Promise<ResolveReconcileResult> {
  const manifestPath = getManifestPath(opts.parcFermeDir)
  const at = opts.now ?? new Date()
  const overlayDir = getOverlayDir(opts.parcFermeDir)

  // 同一 rel への重複指定は先勝ち（後勝ちにすると UI の並び順で結果が変わる）。
  const byPath = new Map<string, ReconcileAction>()
  for (const d of opts.decisions) {
    const p = normalizeRelPath(d.path)
    if (!byPath.has(p)) byPath.set(p, d.action)
  }
  const requested = [...byPath.keys()]

  const manifest = await readManifest(manifestPath)

  const base: ResolveReconcileResult = {
    applied: [],
    promoted: [],
    unmanaged: [],
    deferred: [],
    failed: [],
    backups: [],
    skipped: [],
    overlayDir,
    manifestUpdated: false
  }

  // 台帳が読めないなら 1 バイトも書かない（fail-closed）。
  // 実行だけして記録できない状態を作ると、ファイルは書き換わったのに配置記録が残らず
  // 次回も同じ項目が出る。ここで空の台帳を新規作成するのも不可 —
  // 実体の無い記録を置くと `ensureBaseline`（台帳不在時の移行）が `manifest-exists` で
  // 二度と走らなくなり、全ファイルが恒久的に「配置記録なし」へ落ちる。
  if (manifest === null) {
    return { ...base, skipped: requested.map((p) => ({ path: p, reason: 'no-ledger' as const })) }
  }

  const report = await reconcile({
    goldenFiles: opts.goldenFiles,
    targetDir: opts.targetDir,
    manifest,
    staleOverlayPaths: opts.overlayStalePaths
  })

  // fail-closed は既存経路と同一（配布物破損・パス衝突では何も書かない）。
  if (report.sourceUnreadable.length > 0) {
    return {
      ...base,
      skipped: requested.map((p) => ({ path: p, reason: 'not-pending' as const })),
      blocked: 'source-unreadable'
    }
  }
  if (report.pathCollisions.length > 0) {
    return {
      ...base,
      skipped: requested.map((p) => ({ path: p, reason: 'not-pending' as const })),
      blocked: 'path-collisions'
    }
  }

  const stillPending = new Map(report.needsConfirm.map((i) => [i.path, i]))

  const applied: string[] = []
  const promoted: string[] = []
  const unmanagedPaths: string[] = []
  const deferredPaths: string[] = []
  const failed: StartupReconcileFailure[] = []
  const backups: string[] = []
  const skipped: ResolveSkip[] = []
  const updates: LedgerUpdate[] = []
  const newOverlayEntries: OverlayEntry[] = []
  const newUnmanaged: UnmanagedRecord[] = []

  // 「ローカルを残す」が索引へ書く「元にした golden」は、反映前の台帳の行と反映前の索引からしか導けない
  // （書いた後は台帳の行が上書きされる）。ループの前に 1 度だけ読む。
  const priorOverlayLookup = buildOverlayLookup((await readOverlayIndex(opts.parcFermeDir)).entries)
  // 台帳の同じ path に指紋か持ち主の違う行が複数あるとき（壊れた台帳）は、どれが正しいか決められないので
  // null（＝ 元にした版は不明）。読み側（trustedDeployedHashes）の「曖昧な path は信用しない」と揃える
  const priorLedgerByPath = new Map<string, ManifestEntry | null>()
  for (const e of manifest?.entries ?? []) {
    const p = normalizeRelPath(e.path)
    const prev = priorLedgerByPath.get(p)
    if (prev === undefined) priorLedgerByPath.set(p, e)
    else if (prev !== null && (prev.goldenHash !== e.goldenHash || prev.owner !== e.owner)) {
      priorLedgerByPath.set(p, null)
    }
  }

  for (const [path, action] of byPath) {
    const item = stillPending.get(path)
    if (!item) {
      skipped.push({ path, reason: 'not-pending' })
      continue
    }

    if (action === 'defer') {
      deferredPaths.push(path)
      continue
    }

    if (action === 'unmanage') {
      // 抑止は「決定した時点の配布元」に対してのみ有効。ここでピンを打つ。
      newUnmanaged.push({
        path,
        decidedAt: at.toISOString(),
        goldenHashAtDecision: item.goldenNewHash
      })
      unmanagedPaths.push(path)
      continue
    }

    if (action === 'apply') {
      try {
        // 分類時のスナップショットを再検証してから書く。
        // 既存の `applyPendingReconcile` では `expectedDestHash` が渡されておらず
        // この TOCTOU 検証は本番で死んでいるが、本経路は新設なので最初から有効にする。
        const r = await applyReconcileItem(
          { ...item, expectedDestHash: item.deployedHash },
          { parcFermeDir: opts.parcFermeDir, backupKeep: opts.backupKeep, now: at }
        )
        if (r.backupPath !== null) backups.push(r.backupPath)
        applied.push(path)
        updates.push(writtenUpdate(r))
      } catch (err) {
        if (err instanceof StaleDestinationError) {
          skipped.push({ path, reason: 'stale-destination' })
          continue
        }
        failed.push({ path, message: err instanceof Error ? err.message : String(err) })
      }
      continue
    }

    // action === 'promote'
    //
    // 配置記録が無い項目は反映しない。反映は「手元の方が配布元より新しい」という主張だが、
    // 基準となる配置記録が無ければそれを裏付けられない。とくに台帳が破損すると
    // `readManifest` は null を返し確認対象が全件この状態になるため、ここを開けておくと
    // 「配置先の現状を丸ごと配布物として固定する」一括操作が成立してしまう。
    if (item.goldenOldHash === null) {
      skipped.push({ path, reason: 'no-base-record' })
      continue
    }
    // `settings.json` はハッシュ対象外＝確認対象に載らないはずだが、境界で明示的に拒否する。
    if (isHashExcluded(path)) {
      skipped.push({ path, reason: 'no-base-record' })
      continue
    }
    try {
      const content = await readFile(item.destPath)
      // 分類時から配置先が変わっていたら、その同意で反映してはいけない。
      if (hashFileBuffer(item.destPath, content) !== item.deployedHash) {
        skipped.push({ path, reason: 'stale-destination' })
        continue
      }
      const { contentHash } = await promoteOverlayFile({
        parcFermeDir: opts.parcFermeDir,
        rel: path,
        content,
        bundledSourcePath: item.sourcePath
      })
      newOverlayEntries.push({
        path,
        promotedAt: at.toISOString(),
        contentHash,
        // 反映対象は必ず overlay 未適用（適用中なら unchanged で確認対象に載らない）なので、
        // `goldenNewHash` は同梱 golden 側のハッシュそのもの ＝ 失効判定の基準になる。
        // これは「反映を決めた時点の golden」であり、`conflict` を解決したときは中身の元になった golden ではない。
        baseGoldenHash: item.goldenNewHash,
        derivedFromGoldenHash: derivedFromForPromote(
          priorLedgerByPath.get(normalizeRelPath(path)) ?? undefined,
          priorOverlayLookup
        )
      })
      promoted.push(path)
      updates.push({ path, goldenHash: contentHash, owner: 'promoted' })
    } catch (err) {
      failed.push({ path, message: err instanceof Error ? err.message : String(err) })
      skipped.push({ path, reason: 'promote-failed' })
    }
  }

  // --- 索引を先に確定させる（台帳より前。中断時に「索引に無い overlay」で止まるように） ---
  if (newOverlayEntries.length > 0) {
    const index = await readOverlayIndex(opts.parcFermeDir)
    const merged = new Map(index.entries.map((e) => [e.path, e]))
    for (const e of newOverlayEntries) merged.set(e.path, e)
    await writeOverlayIndex(opts.parcFermeDir, {
      version: index.version,
      entries: [...merged.values()]
    })
  }

  // --- 台帳を 1 回だけ書く ---
  const resolvedPaths = new Set([...applied, ...promoted, ...unmanagedPaths])
  const prevDeferred = [...(manifest?.deferred ?? [])].sort()
  const nextDeferred = [
    ...new Set([...prevDeferred.filter((p) => !resolvedPaths.has(p)), ...deferredPaths])
  ].sort()

  // 反映・適用した rel の「もう問わない」は消す（有効な反映と抑止は共存しない）。
  // 反映が済めば三方向は一致し、そもそも問われないので抑止は無意味になる。
  const prevUnmanaged = manifest?.unmanaged ?? []
  const keptUnmanaged = prevUnmanaged.filter(
    (u) => !promoted.includes(u.path) && !applied.includes(u.path)
  )
  const unmanagedMerged = new Map(keptUnmanaged.map((u) => [u.path, u]))
  for (const u of newUnmanaged) unmanagedMerged.set(u.path, u)
  const nextUnmanaged = [...unmanagedMerged.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  )

  const deferredChanged =
    nextDeferred.length !== prevDeferred.length ||
    nextDeferred.some((p, i) => p !== prevDeferred[i])
  const unmanagedChanged =
    nextUnmanaged.length !== prevUnmanaged.length ||
    nextUnmanaged.some((u, i) => u.path !== prevUnmanaged[i]?.path)

  // 台帳の存在は先頭で確認済み（不在なら 1 バイトも書かずに返している）。
  // よってここでは「変化があったか」だけを見る。
  const manifestUpdated =
    updates.length > 0 || deferredChanged || unmanagedChanged
      ? await writeLedger({
          manifestPath,
          manifest,
          updates,
          templateName: opts.templateName,
          at,
          goldenRels: goldenRelSet(opts.goldenFiles),
          deferred: nextDeferred,
          unmanaged: nextUnmanaged
        })
      : false

  return {
    applied,
    promoted,
    unmanaged: unmanagedPaths,
    deferred: deferredPaths,
    failed,
    backups,
    skipped,
    overlayDir,
    manifestUpdated
  }
}

/** 未追従の内訳 1 件（Health 表示用）。 */
export interface FollowUpEntry {
  path: string
  /** `deferred` = 次回再提示 / `unmanaged` = 問わないと決めた / `overlay` = 反映済み */
  kind: 'deferred' | 'unmanaged' | 'overlay'
  /** 現在の配置先と配布元の内容が食い違っているか（実測。取れなければ null） */
  drifted: boolean | null
  /** `overlay` のとき: 上流が前進して失効しているか */
  lapsed?: boolean
  decidedAt?: string
}

/**
 * 未追従の一覧を実測して返す（ADR 0001 D3 が前提にした「可視化」の実体）。
 *
 * ## なぜ起動時ではなくここで測るか
 * `deferred` は早期打ち切りを外すが、`unmanaged` は外さない（外すと抑止した項目がある限り
 * 毎起動で全走査になる）。可視化のために起動を重くするのは筋が悪いので、
 * **列挙された数件だけ**をこの関数が呼ばれた時に測る。見る人が居るときだけ測る。
 */
export async function collectFollowUpState(opts: {
  goldenFiles: Map<string, string>
  targetDir: string
  parcFermeDir: string
}): Promise<FollowUpEntry[]> {
  const manifest = await readManifest(getManifestPath(opts.parcFermeDir))
  const index = await readOverlayIndex(opts.parcFermeDir)
  const overlayDir = getOverlayDir(opts.parcFermeDir)
  const out: FollowUpEntry[] = []

  const measure = async (rel: string): Promise<boolean | null> => {
    const source = opts.goldenFiles.get(rel) ?? opts.goldenFiles.get(rel.replace(/\//g, '\\'))
    if (!source) return null
    const [a, b] = await Promise.all([hashFileAt(source), hashFileAt(join(opts.targetDir, rel))])
    if (a === null || b === null) return null
    return a !== b
  }

  for (const rel of manifest?.deferred ?? []) {
    out.push({ path: rel, kind: 'deferred', drifted: await measure(rel) })
  }
  for (const u of manifest?.unmanaged ?? []) {
    out.push({
      path: u.path,
      kind: 'unmanaged',
      drifted: await measure(u.path),
      decidedAt: u.decidedAt
    })
  }
  for (const e of index.entries) {
    const bundled = opts.goldenFiles.get(e.path)
    // 供給元が overlay 自身なら有効、同梱側のままなら失効している（`resolveOverlay` の判定と一致）。
    const lapsed = bundled === undefined || !bundled.startsWith(overlayDir)
    out.push({
      path: e.path,
      kind: 'overlay',
      drifted: await measure(e.path),
      lapsed,
      decidedAt: e.promotedAt
    })
  }
  return out
}

/**
 * 「もう問わない」を取り消す（ADR 0002）。
 *
 * `unmanaged` から外すだけでは次回起動で再提示されない
 * （抑止が無い＝分類対象ではあるが、早期打ち切りに乗ると走査自体が起きない）。
 * よって **`deferred` へ入れ直す**。`deferred` は既に「早期打ち切りに乗らないフラグ」なので、
 * 新しい機構を足さずに「次回必ず問い直す」が成立する。
 */
export async function remanagePaths(opts: {
  parcFermeDir: string
  paths: string[]
}): Promise<{ unmanaged: string[]; deferred: string[]; manifestUpdated: boolean }> {
  const manifestPath = getManifestPath(opts.parcFermeDir)
  const manifest = await readManifest(manifestPath)
  if (manifest === null) return { unmanaged: [], deferred: [], manifestUpdated: false }

  const targets = new Set(opts.paths.map(normalizeRelPath))
  const prev = manifest.unmanaged ?? []
  const nextUnmanaged = prev.filter((u) => !targets.has(u.path))
  const restored = prev.filter((u) => targets.has(u.path)).map((u) => u.path)
  if (restored.length === 0) {
    return {
      unmanaged: nextUnmanaged.map((u) => u.path),
      deferred: manifest.deferred ?? [],
      manifestUpdated: false
    }
  }
  const nextDeferred = [...new Set([...(manifest.deferred ?? []), ...restored])].sort()

  const next: GoldenManifest = {
    ...manifest,
    deferred: nextDeferred,
    unmanaged: nextUnmanaged
  }
  if (nextUnmanaged.length === 0) delete next.unmanaged
  await writeManifest(manifestPath, next)
  return {
    unmanaged: nextUnmanaged.map((u) => u.path),
    deferred: nextDeferred,
    manifestUpdated: true
  }
}
