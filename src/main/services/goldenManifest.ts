/**
 * goldenManifest — 内容ハッシュ per-file manifest と三方向照合（発注仕様 v2 §9）。
 *
 * 設計根拠は `ccpit/docs/adr/0001-hash-deploy-hybrid.md`（原則・ケース4の裁定・WHY）。
 * 本モジュールは **Electron 非依存の純サービス**（パスは全て引数で受ける）。golden.ts が実パスを配線する。
 *
 * ## 保持する 3 状態（§9.1）
 * - `G_old`: 前回配置した golden の内容ハッシュ。本 manifest に永続化する。
 * - `G_new`: 現在同梱されている golden の内容ハッシュ。起動時に算出する。
 * - `U`   : 配置先（~/.claude/）の実内容ハッシュ。起動時に算出する。
 *
 * `G_old` を持たないと「ユーザーが変えた」のか「golden が変わった」のかを区別できない。
 * これが manifest を持つ唯一かつ十分な理由である。
 *
 * ## 削除は行わない（§9.11）
 * **本モジュールおよび配置処理は「追加」と「上書き」しか行わない。**
 * golden から取り除かれたファイルを配置先から削除する処理は **意図的に実装していない**。
 * 削除は誤ると復旧不能であり、発端の問題（配布更新が届かない）は追加・上書きだけで解消する。
 * 将来削除機構を足す場合は別 ADR を起こすこと。ここに黙って足さないこと。
 * （唯一の例外は §9.8 のバックアップ世代上限で、これは対象が `.bak.*` に限定される。）
 */

import { readdir, readFile, stat, lstat, rm, chmod } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { join, relative, dirname, isAbsolute, extname, basename, resolve } from 'path'
import { homedir } from 'os'
import { createHash, randomBytes } from 'crypto'
import { writeFileAtomic } from './atomicFile'

/** manifest スキーマ版。破壊的変更時に上げ、読み手は不一致を「記録なし」として安全側に倒す。 */
export const MANIFEST_VERSION = 1

/** 同一ファイルに残す `.bak.*` の既定世代数（§9.8）。 */
export const DEFAULT_BACKUP_KEEP = 5

/**
 * ハッシュ比較の対象外ファイル（§9.5）。
 *
 * 配置後の `settings.json` は golden のコピーではなく**生成物**である
 * （password 注入 / bash 実体パス注入 / deny の union マージ）。よって配置先と golden の
 * ハッシュは**原理的に一致しない**ため、比較に載せると恒久的に「改変あり」と誤判定する。
 *
 * さらに `settings.json` は `auth.password` を含む。実内容ハッシュを manifest に永続化すると
 * **ハッシュ経由で秘密の変化が観測可能**になるため、記録もしない。
 * アプリ所有キーのみを更新するキー単位の所有権モデルは別タスク（§11 Pending）。
 */
const HASH_EXCLUDED_BASENAMES = new Set(['settings.json'])

/** 走査から除外するファイル名（配置対象でもない）。 */
const SKIP_BASENAMES = new Set(['.gitkeep'])

/**
 * 配置先ファイル 1 件の出自（§9.7）。
 *
 * `promoted` は ADR 0002（逆向き反映）で追加。**配置先の内容をユーザーが配布元へ反映した**
 * ことを表す。`adopted` と同じく「配布元が書いた内容ではない」ため、`U === G_old` を
 * 「ユーザーは触っていない」と読んではならない。詳細は `classifyFile` の該当分岐。
 */
export type FileOwner = 'golden' | 'adopted' | 'user' | 'promoted'

/** `readManifest` が受理する `owner` 値（未知値は `golden` へ丸める）。 */
const KNOWN_OWNERS = new Set<FileOwner>(['golden', 'adopted', 'user', 'promoted'])

/**
 * 「この項目はもう問わない」の記録（ADR 0002）。
 *
 * `deferred`（延期）と違い、確認ダイアログへの提示を抑止する。ただし**永続ではない**:
 * `goldenHashAtDecision` は決定時の `G_new` であり、同梱 golden がそこから動いたら
 * 抑止は効かなくなり通常どおり再提示される（＝上流が前進したら必ずもう一度問う）。
 */
export interface UnmanagedRecord {
  /** 正規化済み相対パス */
  path: string
  /** 決定時刻 ISO 8601 */
  decidedAt: string
  /** 決定した時点の `G_new`。ここから動いたら抑止は失効する */
  goldenHashAtDecision: string
}

/** per-file manifest の 1 エントリ。 */
export interface ManifestEntry {
  /** 正規化済み相対パス（`/` 区切り） */
  path: string
  /**
   * `G_old` — 前回配置した**有効な golden**（同梱 golden に overlay を重ねた後）の内容の sha256。
   * どの書き手もこの意味で書く。三方向照合（`classifyFile`）の G_old はこの意味でないと成り立たない。
   *
   * **同梱 golden の指紋とは限らない。** 道 P2（ローカルを残した）の行では overlay の中身＝ローカルの指紋になる。
   * 「ローカルがどの同梱 golden を元に直したか」が要る読み手は、この欄を直接読まず
   * `goldenOverlay.bundledBaseHashOf` を通すこと（069 発注 2）。
   */
  goldenHash: string
  /** 出自。`adopted` は CCPIT の採用経路が書いたもの（§9.7） */
  owner: FileOwner
  /** 配置時刻 ISO 8601 */
  deployedAt: string
  /** 配置時に実行ビットを付けたか（ハッシュには含めない。§9.10） */
  exec?: boolean
  /**
   * 上書き直後の内容の指紋（ADR 0004 / AC21）。
   * 次サイクル以降の拡張用。今サイクルの復元判定では読まない。
   */
  postHash?: string
}

export interface GoldenManifest {
  manifestVersion: number
  /** 配置したテンプレート名 */
  template: string
  /** 集合ハッシュ。同梱物が変わったかの早期打ち切り判定に使う（§9.2 / §6.2） */
  goldenSetHash: string
  deployedAt: string
  entries: ManifestEntry[]
  /**
   * 「後で」を選んで未追従のまま残っている相対パス（§9.4）。
   * 次回起動時に再提示する対象。拒否ではなく延期であることに注意。
   */
  deferred?: string[]
  /**
   * 「もう問わない」と決めた項目（ADR 0002）。`deferred` と排他ではないが意味が違う:
   * `deferred` は「早期打ち切りに乗らないフラグ」、`unmanaged` は「提示を抑止する記録」。
   *
   * **抑止は同梱 golden が動くまで**。`goldenHashAtDecision` が現在の `G_new` と食い違えば
   * 抑止は効かず通常提示される。`buildManifest`（新規配置・ベースライン移行）は本欄を持たない
   * ＝ 再配備すると決定は消える（再配備は全ファイルを上書きするので決定の前提自体が消えるため）。
   */
  unmanaged?: UnmanagedRecord[]
}

/**
 * 相対パスの正規化（§9.10）。
 * - 区切りを `/` に統一（Windows の `\` を吸収）
 * - 先頭の `./` を除去
 * - 大文字小文字は**変換しない**（golden 同梱物は決定的に生成されるため、
 *   小文字化すると別ファイルが衝突しうる。比較は常に正規化後の完全一致で行う）
 */
export function normalizeRelPath(rel: string): string {
  return rel.replace(/\\/g, '/').replace(/^\.\//, '')
}

/**
 * 改行正規化対象とするテキストファイル拡張子ホワイトリスト（W-1 / AC-4）。
 * ここに含まれ、かつ NULL バイト (0x00) を含まない UTF-8 ファイルのみ改行コード（CRLF -> LF）を正規化してハッシュを計算する。
 * 画像・バイナリ等のファイルは改行正規化せず、生バイト SHA-256 を計算する。
 */
export const TEXT_FILE_EXTENSIONS = new Set<string>([
  '.md',
  '.json',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.sh',
  '.bash',
  '.ps1',
  '.py',
  '.txt',
  // 行ごとの JSON（試験の fixture。L0_013 W4 で golden の hooks に stuck-loop-detect.fixture-loop.jsonl が入った）
  '.jsonl',
  '.yml',
  '.yaml',
  '.toml',
  '.xml',
  '.html',
  '.htm',
  '.css',
  '.svg',
  '.env',
  '.gitignore',
  '.gitattributes',
  '.editorconfig'
])

/**
 * ファイルがテキストとして扱えるか判定する（拡張子＋NULLバイト検査）。
 */
export function isTextFile(filePath: string, buf?: Buffer): boolean {
  const ext = extname(filePath).toLowerCase()
  const base = basename(filePath).toLowerCase()
  const isKnownText =
    TEXT_FILE_EXTENSIONS.has(ext) ||
    base === 'license' ||
    base === 'readme' ||
    base === '.gitattributes' ||
    base === '.gitignore'
  if (!isKnownText) return false

  if (buf && buf.includes(0)) {
    return false
  }
  return true
}

/**
 * 内容ハッシュ（生バイト列）。**バイト列そのもの**の sha256 hex。
 */
export function hashBytes(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

const utf8FatalDecoder = new TextDecoder('utf-8', { fatal: true })

/**
 * ファイルバッファの内容ハッシュを計算する（W-1 / AC-4）。
 * テキストファイルかつ UTF-8 でデコード可能な場合、CRLF を LF に正規化してハッシュを計算する。
 * これにより、Windows 環境での改行コード差（CRLF / LF）に起因するハッシュの不一致を防ぎ、
 * Git blob（LF）由来のハッシュ値と 100% 互換（AC-4）を保つ。
 * 不正 UTF-8 バイト列またはバイナリファイルの場合は生バイト SHA-256 を返す。
 */
export function hashFileBuffer(filePath: string, buf: Buffer): string {
  if (isTextFile(filePath, buf)) {
    try {
      const text = utf8FatalDecoder.decode(buf)
      const normalized = text.replace(/\r\n/g, '\n')
      return createHash('sha256').update(normalized, 'utf-8').digest('hex')
    } catch {
      // 不正な UTF-8 バイト列の場合は生バイト SHA-256
    }
  }
  return hashBytes(buf)
}

const utf8KeepBomDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/**
 * golden として書く（配る・上げる）バイトにそろえる: `hashFileBuffer` と同じ判定でテキストなら、
 * バイト列のまま CRLF を LF にする。テキストでない・UTF-8 として読めない・NUL を含むものは元の Buffer をそのまま返す。
 *
 * `hashFileBuffer(p, x) === computeGoldenTargetHash(p, toGoldenBytes(p, x))` が成り立つ（BOM 無しの入力。
 * BOM 付きは `hashFileBuffer` が BOM を除くため食い違う既知の限界で、BOM は消さずに保つ）。
 * 契約の道具は `.js` などを生バイトで測るので、patch に入れるバイトをここで LF にそろえておけば期待値が合う。
 */
export function toGoldenBytes(filePath: string, buf: Buffer): Buffer {
  if (!isTextFile(filePath, buf)) return buf
  try {
    utf8KeepBomDecoder.decode(buf)
  } catch {
    return buf
  }
  if (!buf.includes(0x0d)) return buf
  // UTF-8 では 0x0D 0x0A は CRLF にしか現れないので、バイト列（latin1 の 1 バイト 1 文字）のまま置換してよい
  return Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')
}

/** ハッシュ比較の対象外か（§9.5）。 */
export function isHashExcluded(rel: string): boolean {
  const norm = normalizeRelPath(rel)
  const base = norm.split('/').pop() ?? ''
  return HASH_EXCLUDED_BASENAMES.has(base)
}

/** 走査対象外の付随ファイルか。 */
export function isSkippedFile(rel: string): boolean {
  const base = normalizeRelPath(rel).split('/').pop() ?? ''
  return SKIP_BASENAMES.has(base)
}

/**
 * 集合ハッシュ（§9.2）。**走査順序に依存しない**よう相対パス昇順へ正規化してから連結する。
 * 用途は「同梱物が変わったか」の早期打ち切りと診断のみ。
 * 単体で無確認上書きの根拠にはしない（Codex が非承認とした設計。§6.3）。
 */
export function computeSetHash(entries: { path: string; hash: string }[]): string {
  const sorted = [...entries]
    .map((e) => ({ path: normalizeRelPath(e.path), hash: e.hash }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const h = createHash('sha256')
  for (const e of sorted) {
    // NUL 区切り: パスにも hash にも現れない文字なので連結の曖昧性が生じない
    h.update(e.path, 'utf-8')
    h.update('\0')
    h.update(e.hash, 'utf-8')
    h.update('\n')
  }
  return h.digest('hex')
}

/**
 * ファイル 1 件のハッシュ。不在・読取不能なら null（呼び出し側がケース判定で扱う）。
 * シンボリックリンクは**追跡せず null を返す**（§9.10: リンク先次第でハッシュが非決定になるため。
 * golden 同梱物にシンボリックリンクは存在しない前提であり、現れたら比較対象から外して可視化する）。
 * テキストファイルの場合は CRLF を LF に正規化してハッシュを計算する（W-1 / AC-4）。
 */
export async function hashFileAt(absPath: string): Promise<string | null> {
  try {
    const st = await lstat(absPath)
    if (st.isSymbolicLink() || !st.isFile()) return null
    const buf = await readFile(absPath)
    return hashFileBuffer(absPath, buf)
  } catch {
    return null
  }
}

/** 再帰走査してファイルの絶対パスを集める（シンボリックリンクは辿らない）。 */
async function walkFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return []
  const out: string[] = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isSymbolicLink()) continue // §9.10
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(full)))
    } else if (entry.isFile()) {
      out.push(full)
    }
  }
  return out
}

/**
 * ディレクトリ配下を `rel → hash` に写す。`base` からの相対パスを正規化して使う。
 * `settings.json` 等の除外対象と `.gitkeep` は含めない。
 */
export async function hashTree(base: string): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  for (const abs of await walkFiles(base)) {
    const rel = normalizeRelPath(relative(base, abs))
    if (isSkippedFile(rel) || isHashExcluded(rel)) continue
    const h = await hashFileAt(abs)
    if (h !== null) map.set(rel, h)
  }
  return map
}

/** `hashSourceMap` の結果。読めなかった同梱物を**握り潰さず**返す（§9.10 / fail-closed）。 */
export interface SourceHashResult {
  /** `rel → hash`。ハッシュできたものだけ */
  map: Map<string, string>
  /**
   * ハッシュできなかった相対パス（不在・読取不能・シンボリックリンク・非ファイル）。
   *
   * source 側 golden は**単一情報源**なので、ここで黙って落とすと
   * 「同梱物の一部が manifest にも配置対象にも現れないまま成功扱い」になる。
   * 壊れた配布物・packaging 差分を silent success にしないため、必ず呼び出し側へ渡す。
   */
  unreadable: string[]
}

/**
 * `rel → 絶対ソースパス` の集合をハッシュ表に変換する（deploy の mergedFiles をそのまま渡す用）。
 *
 * 除外規則（`settings.json` / `.gitkeep`）に**明示的に該当するものだけ**を黙って落とし、
 * それ以外でハッシュできなかったものは `unreadable` に積んで返す。
 */
export async function hashSourceMap(files: Map<string, string>): Promise<SourceHashResult> {
  const map = new Map<string, string>()
  const unreadable: string[] = []
  for (const [rel, abs] of files) {
    const norm = normalizeRelPath(rel)
    if (isSkippedFile(norm) || isHashExcluded(norm)) continue
    const h = await hashFileAt(abs)
    if (h === null) {
      unreadable.push(norm)
      continue
    }
    map.set(norm, h)
  }
  unreadable.sort()
  return { map, unreadable }
}

/**
 * 配置先ファイルシステム上で**同一実体に落ちうる**相対パスの組を検出する（fail-closed）。
 *
 * Windows / macOS の既定 FS はパスの大小文字を区別しない。manifest 上は `CLAUDE.md` と
 * `claude.md` が別 entry でも、`join(targetDir, rel)` は同じ実体へ収束しうる。
 * その状態で配置すると、適用順によって片方がもう片方を無確認で上書きする。
 *
 * 正規化（小文字化）で吸収**しない**のは、それが逆に別ファイルの取り違えを生むため。
 * 検出したら配置も manifest 反映も行わず、上位へ返して人間の判断に載せる。
 *
 * @returns 衝突した相対パスの組の配列（各組はパス昇順、組自体も昇順）
 */
export function detectPathCollisions(paths: Iterable<string>): string[][] {
  const byKey = new Map<string, string[]>()
  for (const p of paths) {
    const norm = normalizeRelPath(p)
    const key = norm.toLowerCase()
    const bucket = byKey.get(key)
    if (bucket) {
      if (!bucket.includes(norm)) bucket.push(norm)
    } else {
      byKey.set(key, [norm])
    }
  }
  const collisions: string[][] = []
  for (const bucket of byKey.values()) {
    if (bucket.length > 1) collisions.push([...bucket].sort())
  }
  return collisions.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}

/* ------------------------------------------------------------------ *
 * manifest の永続化
 * ------------------------------------------------------------------ */

/** manifest の既定パス（`<parcFermeDir>/golden-manifest.json`）。 */
export function getManifestPath(parcFermeDir: string): string {
  return join(parcFermeDir, 'golden-manifest.json')
}

/**
 * `unmanaged` 1 件を検証して返す（不正なら空配列 ＝ 落とす）。
 *
 * 3 欄が揃わない記録を通すと「ピンの無い永続抑止」になり、上流が前進しても
 * 二度と問われない項目が生まれる。ADR 0002 の失効機構が壊れるので fail-closed で落とす。
 */
function parseUnmanagedRecord(u: unknown): UnmanagedRecord[] {
  if (!u || typeof u !== 'object') return []
  const r = u as Partial<UnmanagedRecord>
  if (typeof r.path !== 'string' || r.path === '') return []
  if (typeof r.decidedAt !== 'string') return []
  if (typeof r.goldenHashAtDecision !== 'string' || r.goldenHashAtDecision === '') return []
  return [
    {
      path: normalizeRelPath(r.path),
      decidedAt: r.decidedAt,
      goldenHashAtDecision: r.goldenHashAtDecision
    }
  ]
}

/**
 * manifest を読む。不在・空・破損・スキーマ版不一致はいずれも **null**（＝「記録なし」）。
 *
 * フェイルセーフの向き: 記録なしはケース5（新規/昇格）へ落ち、配置先に既存があれば
 * 確認ダイアログ側へ回る。つまり**壊れた manifest が無確認上書きを引き起こすことはない**。
 */
export async function readManifest(manifestPath: string): Promise<GoldenManifest | null> {
  if (!existsSync(manifestPath)) return null
  try {
    const raw = await readFile(manifestPath, 'utf-8')
    if (raw.trim() === '') return null
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const m = parsed as Partial<GoldenManifest>
    if (m.manifestVersion !== MANIFEST_VERSION) return null
    if (!Array.isArray(m.entries)) return null
    const entries: ManifestEntry[] = []
    for (const e of m.entries) {
      if (!e || typeof e !== 'object') continue
      const entry = e as Partial<ManifestEntry>
      if (typeof entry.path !== 'string' || typeof entry.goldenHash !== 'string') continue
      const owner: FileOwner =
        typeof entry.owner === 'string' && KNOWN_OWNERS.has(entry.owner as FileOwner)
          ? (entry.owner as FileOwner)
          : 'golden'
      entries.push({
        path: normalizeRelPath(entry.path),
        goldenHash: entry.goldenHash,
        owner,
        deployedAt: typeof entry.deployedAt === 'string' ? entry.deployedAt : '',
        ...(typeof entry.exec === 'boolean' ? { exec: entry.exec } : {}),
        ...(typeof entry.postHash === 'string' && entry.postHash ? { postHash: entry.postHash } : {})
      })
    }
    return {
      manifestVersion: MANIFEST_VERSION,
      template: typeof m.template === 'string' ? m.template : '',
      goldenSetHash: typeof m.goldenSetHash === 'string' ? m.goldenSetHash : '',
      deployedAt: typeof m.deployedAt === 'string' ? m.deployedAt : '',
      entries,
      ...(Array.isArray(m.deferred)
        ? { deferred: m.deferred.filter((d): d is string => typeof d === 'string') }
        : {}),
      // 壊れた行は落とす（`entries` と同じ向き）。3 欄すべて揃っていない記録は
      // 抑止の根拠として使えない ＝ 落として「問い直す」側へ倒すのが安全側。
      ...(Array.isArray(m.unmanaged)
        ? { unmanaged: m.unmanaged.flatMap((u) => parseUnmanagedRecord(u)) }
        : {})
    }
  } catch {
    return null
  }
}

/**
 * 同一ディレクトリの一時ファイルへ書いてから `rename` で差し替える（原子的置換）。
 * 実装は `atomicFile.ts::writeFileAtomic` へ抽出済み（挙動不変のリファクタ）。
 */

// ──────────────────────────────────────────────
// トークン型再入可能台帳排他プロトコル (Cooperative Manifest Mutex)
// ──────────────────────────────────────────────
let isManifestLocked = false
let currentManifestLockToken: string | null = null
let currentManifestHolder: string | null = null

export function acquireManifestLock(holder: string): { ok: true; lockToken: string } | { ok: false; error: string } {
  if (isManifestLocked) {
    return {
      ok: false,
      error: `台帳が別の処理（${currentManifestHolder || '不明'}）により排他ロックされています。完了までお待ちください。`
    }
  }
  isManifestLocked = true
  currentManifestHolder = holder
  currentManifestLockToken = randomBytes(16).toString('hex')
  return { ok: true, lockToken: currentManifestLockToken }
}

export function releaseManifestLock(lockToken: string): void {
  if (currentManifestLockToken === lockToken) {
    isManifestLocked = false
    currentManifestLockToken = null
    currentManifestHolder = null
  }
}

export function isManifestBusy(): boolean {
  return isManifestLocked
}

/** manifest を書く（親ディレクトリは自動作成／原子的置換）。排他ロック中は一致する lockToken 保持者のみ書き込みを許可する。 */
export async function writeManifest(
  manifestPath: string,
  manifest: GoldenManifest,
  options?: {
    lockToken?: string
    expectedManifestSha?: string | null
    __testPreRenameHook?: () => Promise<void>
  }
): Promise<void> {
  if (isManifestLocked && options?.lockToken !== currentManifestLockToken) {
    throw new Error('台帳が別の協調的処理により排他ロックされています。書込みを拒否します。')
  }

  const verifyExpectedSha = (): void => {
    if (options?.expectedManifestSha !== undefined) {
      const currentSha = existsSync(manifestPath)
        ? createHash('sha256').update(readFileSync(manifestPath)).digest('hex')
        : null
      if (currentSha !== options.expectedManifestSha) {
        throw new Error(
          `台帳書込み直前にローカル台帳ファイルが外部により変更・置換または新規作成されました（期待SHA: ${options.expectedManifestSha ?? 'NONE(不在)'}, 実測SHA: ${currentSha ?? 'NONE(不在)'}）。上書きを防止するため書込みを拒否します。`
        )
      }
    }
  }

  // (1) 一時ファイル作成・書込み前にも検証
  verifyExpectedSha()

  // (2) 一時ファイル作成後・rename まさに直前に再度検証（TOCTOU 窓を極限縮小）
  await writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2), {
    beforeRename: async () => {
      if (options?.__testPreRenameHook) {
        await options.__testPreRenameHook()
      }
      verifyExpectedSha()
    }
  })
}

/**
 * `rel → hash` から manifest を組み立てる。
 * `owners` に指定が無いパスは `golden` 所有として記録する。
 */
export function buildManifest(opts: {
  template: string
  goldenHashes: Map<string, string>
  deployedAt?: string
  owners?: Map<string, FileOwner>
  execPaths?: Set<string>
  deferred?: string[]
  /**
   * 書いた直後に配置先を読み戻した指紋（`rel → hashFileBuffer`）。**ここに載る行にだけ** `postHash` を書く。
   * 載らない行（書いていない・書けなかった・読み戻せなかった）は「不明」で、`postHash` を付けない。
   * この関数は行を新しく組み立てるので、以前の行の `postHash` を引き継がない。
   */
  postHashes?: Map<string, string>
}): GoldenManifest {
  const deployedAt = opts.deployedAt ?? new Date().toISOString()
  const entries: ManifestEntry[] = []
  for (const [rel, hash] of opts.goldenHashes) {
    const path = normalizeRelPath(rel)
    const postHash = opts.postHashes?.get(path)
    entries.push({
      path,
      goldenHash: hash,
      owner: opts.owners?.get(path) ?? 'golden',
      deployedAt,
      ...(opts.execPaths?.has(path) ? { exec: true } : {}),
      ...(postHash ? { postHash } : {})
    })
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return {
    manifestVersion: MANIFEST_VERSION,
    template: opts.template,
    goldenSetHash: computeSetHash(entries.map((e) => ({ path: e.path, hash: e.goldenHash }))),
    deployedAt,
    entries,
    ...(opts.deferred && opts.deferred.length > 0 ? { deferred: opts.deferred } : {})
  }
}

/* ------------------------------------------------------------------ *
 * 採用経路の出自記録（§9.7）
 * ------------------------------------------------------------------ */

/** `markAdopted` の結果。呼び出し側のログ用。 */
export interface MarkAdoptedResult {
  changed: boolean
  reason: 'marked' | 'already-adopted' | 'not-in-manifest' | 'no-manifest' | 'outside-target'
}

/**
 * 配置先の 1 ファイルに「CCPIT の採用経路が書いた」印（`owner: 'adopted'`）を付ける（§9.7）。
 *
 * これを怠ると、golden 配布パスへの採用（緊急 override 等）が次回起動の三方向照合で
 * `user-modified` に見え、**毎回**上書き確認ダイアログに載る。
 *
 * 意図的にしないこと（後から「直したくなる」が、いずれも壊れる）:
 * - **`goldenHash` を書き換えない**。これは `G_old`＝前回配置した *golden* の内容であって
 *   採用内容ではない。採用内容で上書きすると golden 側の変化検出（`G_old` vs `G_new`）が壊れ、
 *   次の golden 更新を取りこぼす／偽の更新を出す。
 * - **`goldenSetHash` を再計算しない**。集合ハッシュは `path + goldenHash` のみから導出され
 *   `owner` を含まない。再計算しても同値であり、触らないことで「集合が変わった」という
 *   誤検知の芽を残さない。
 * - **`deployedAt` を更新しない**。これは golden 配置時刻。採用時刻は出自レジストリ側の
 *   `adoptedAt` が持つ。2 つの時計を 1 つの欄に混ぜない。
 *
 * manifest 不在・管轄外・未収録はいずれも「何もしない」で正常終了する
 * （採用自体は既に完了しており、ここでの失敗が採用を覆してはならない）。
 */
export async function markAdopted(opts: {
  /** `getManifestPath(parcFermeDir)` */
  manifestPath: string
  /** 配置先ルート（通常 `~/.claude`）。manifest のキーはここからの相対パス。 */
  targetDir: string
  /** 採用が書いた実体の絶対パス */
  absPath: string
}): Promise<MarkAdoptedResult> {
  const manifest = await readManifest(opts.manifestPath)
  if (!manifest) return { changed: false, reason: 'no-manifest' }

  const rel = normalizeRelPath(relative(opts.targetDir, opts.absPath))
  // targetDir の外（親方向・別ドライブ）は manifest の管轄外。
  if (rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    return { changed: false, reason: 'outside-target' }
  }

  // 照合側（reconcile）と同じく正規化後の完全一致で引く。ここだけ緩い一致にすると
  // 「印は付いたのに照合では別ファイル扱い」というズレが生まれる。
  const entry = manifest.entries.find((e) => e.path === rel)
  // 未収録は正常系: golden に無い skill の新規採用、ケース2 の一時名など。
  if (!entry) return { changed: false, reason: 'not-in-manifest' }
  if (entry.owner === 'adopted') return { changed: false, reason: 'already-adopted' }

  entry.owner = 'adopted'
  await writeManifest(opts.manifestPath, manifest)
  return { changed: true, reason: 'marked' }
}

/* ------------------------------------------------------------------ *
 * 三方向照合（§5.2 ケース表 / §9.3）
 * ------------------------------------------------------------------ */

/**
 * 照合ケース。§5.2 のケース表に 1:1 対応する。
 *
 * | 値 | ケース | `U` vs `G_old` | `G_old` vs `G_new` | 動作 |
 * |---|---|---|---|---|
 * | `unchanged`     | 1 | 一致   | 変化なし | 何もしない |
 * | `auto-update`   | 2 | 一致   | 変化あり | **無確認で更新** |
 * | `user-modified` | 3 | 不一致 | 変化なし | 確認 → .bak → 上書き |
 * | `conflict`      | 4 | 不一致 | 変化あり | 確認 → .bak → 上書き |
 * | `new`           | 5 | 配置先が空 | 記録なし | 無確認で書く |
 * | `restore`       | — | 配置先が消えた | — | 無確認で書き戻す（追加であって削除ではない） |
 */
export type ReconcileCase =
  | 'unchanged'
  | 'auto-update'
  | 'user-modified'
  | 'conflict'
  | 'new'
  | 'restore'

/** 無確認で適用してよいケースか（§5.2 / §6.3）。 */
export function isAutoApplicable(c: ReconcileCase): boolean {
  return c === 'auto-update' || c === 'new' || c === 'restore'
}

/** 確認ダイアログを要するケースか（§9.4）。 */
export function needsConfirmation(c: ReconcileCase): boolean {
  return c === 'user-modified' || c === 'conflict'
}

/**
 * 1 ファイルのケース判定（§5.2）。純関数。
 *
 * @param goldenOld `G_old`。manifest に記録が無ければ null（ケース5）
 * @param goldenNew `G_new`。同梱 golden の現ハッシュ
 * @param deployed  `U`。配置先の実ハッシュ。不在なら null
 * @param owner     出自。`adopted` は改変扱いしない（§9.7）
 */
export function classifyFile(
  goldenOld: string | null,
  goldenNew: string,
  deployed: string | null,
  owner: FileOwner = 'golden'
): ReconcileCase {
  // 配置先が存在しない
  if (deployed === null) {
    // 記録なし＝初回配置/新規収録（ケース5）。記録あり＝配置後に消えた → 書き戻す。
    // どちらも「追加」であり削除ではないため無確認でよい（§9.11 の非対称性）。
    return goldenOld === null ? 'new' : 'restore'
  }

  // ケース5: manifest に記録が無く、配置先には既存がある。
  // 「昇格・新規配布」だが手元の実体が何者か判らない ＝ 改変ありと同じ慎重さで扱う（§5.2 注記）。
  if (goldenOld === null) {
    return deployed === goldenNew ? 'unchanged' : 'conflict'
  }

  const userTouched = deployed !== goldenOld
  const goldenChanged = goldenOld !== goldenNew

  // §9.7: CCPIT の採用経路が書いたファイル（adopted）は「ユーザー改変」として扱わない。
  // これを怠ると、正規手順で採用した skill が毎回上書き候補として提示される。
  // golden 側に更新がある場合のみケース4のダイアログ対象へ載せる。
  if (owner === 'adopted') {
    return goldenChanged ? 'conflict' : 'unchanged'
  }

  // ADR 0002: 逆向き反映した項目（promoted）。adopted と同型で扱う。
  //
  // **ここを省くと無確認でユーザーの反映内容が消える。** 反映後の台帳は
  // `G_old = 反映内容` になるため、同梱 golden が前進した瞬間に
  // `U === G_old`（＝ userTouched false）かつ `G_old !== G_new`（＝ goldenChanged true）が成立し、
  // 素の判定では `auto-update` ＝ 無確認上書きへ落ちる。overlay を失効させるだけでは
  // 「この内容は配布元由来ではない」という事実が台帳に残らないので防げない。
  // 上流が前進したときは必ず確認付き（conflict）にする。
  //
  // **保証の射程**: 守るのは「**存在している**反映内容を無確認で置き換えない」こと。
  // 配置先が消えている場合は上の `deployed === null` 分岐が先に `restore` を返し、
  // owner を見ないまま無確認で書き戻す。これは意図した非対称性（§9.11）である —
  // 空いた場所への書き込みは追加であって上書きではなく、失われる内容がそもそも無い。
  // ここで確認を挟むと、何も壊しえない操作のためにモーダルを出すことになる。
  if (owner === 'promoted') {
    return goldenChanged ? 'conflict' : 'unchanged'
  }

  if (!userTouched) return goldenChanged ? 'auto-update' : 'unchanged'
  return goldenChanged ? 'conflict' : 'user-modified'
}

export interface ReconcileItem {
  /** 正規化相対パス */
  path: string
  case: ReconcileCase
  owner: FileOwner
  /** 同梱 golden 側の絶対パス（適用時のコピー元） */
  sourcePath: string
  /** 配置先の絶対パス */
  destPath: string
  goldenOldHash: string | null
  goldenNewHash: string
  deployedHash: string | null
}

export interface ReconcileReport {
  /**
   * 同梱 golden の集合ハッシュが前回配置時と一致したか。
   * **「配置先が正しい」ことは意味しない**（配置先の欠落・改変とは独立の指標）。
   */
  setHashMatches: boolean
  /** 何も差分が無く、異常も無いか（`clean` なら呼び出し側は何もしなくてよい） */
  clean: boolean
  /** 無確認で適用してよい項目（ケース2/5-新規/書き戻し） */
  autoApply: ReconcileItem[]
  /** 確認ダイアログを要する項目（ケース3/4） */
  needsConfirm: ReconcileItem[]
  /** 差分なし項目の件数（一覧は保持しない＝起動時のメモリと出力を抑える） */
  unchangedCount: number
  /** 前回「後で」を選んだまま未追従のパス（再提示対象） */
  deferred: string[]
  /**
   * 「もう問わない」で提示を抑止した項目（ADR 0002）。
   *
   * **分類はしている**（差分は測れている）。提示しないだけ。ここを空配列にせず値で返すのは、
   * 未追従を「後から確認できる」ようにするため — 沈黙は放置と区別が付かない（ADR 0001 D3）。
   * 抑止が失効した項目（同梱 golden が動いた）はここに入らず `needsConfirm` へ回る。
   */
  unmanaged: ReconcileItem[]
  /**
   * 同梱 golden 側が読めなかった相対パス（配布物の破損・packaging 事故）。
   * **空でない場合、呼び出し側は配置と manifest 更新を進めてはならない**（fail-closed）。
   * ここで例外にせず値で返すのは、Windows の一時的なファイルロックで
   * アプリ起動そのものを不能にしないため。判断は上位（golden.ts / UI）が持つ。
   */
  sourceUnreadable: string[]
  /**
   * 配置先 FS 上で同一実体に落ちうる相対パスの組（§9.10 / 大小文字非区別 FS）。
   * 該当パスは適用対象から**外して**ここに出す。無確認どころか確認付きでも書かない。
   */
  pathCollisions: string[][]
}

/**
 * 三方向照合の本体（§6.2）。
 *
 * 集合ハッシュが一致したら per-file 走査を行わず即座に打ち切る（起動を遅くしないため）。
 * ただし前回「後で」を選んだ未追従項目がある場合は、集合が同一でも再提示が要るので走査する。
 */
export async function reconcile(opts: {
  /** `rel → 同梱 golden の絶対パス`（deploy の mergedFiles と同一の集合） */
  goldenFiles: Map<string, string>
  /** 配置先ルート（通常 `~/.claude`） */
  targetDir: string
  /** 前回配置の manifest。null なら「記録なし」 */
  manifest: GoldenManifest | null
  /**
   * 失効した逆向き反映（overlay）の相対パス（ADR 0002）。
   *
   * 本モジュールは overlay の実体を知らない（純粋ライブラリの層を保つ）ので、
   * 判定済みの集合を配線層から受け取る。ここに載る rel は **無確認適用の対象から外す**
   * — `owner: 'promoted'` による防御と独立した二重化であり、台帳側の記録が
   * 何らかの理由で失われていても無確認上書きを起こさないための保険。
   */
  staleOverlayPaths?: ReadonlySet<string>
}): Promise<ReconcileReport> {
  const { map: goldenHashes, unreadable: sourceUnreadable } = await hashSourceMap(opts.goldenFiles)
  const setHash = computeSetHash([...goldenHashes].map(([path, hash]) => ({ path, hash })))
  const deferred = opts.manifest?.deferred ?? []
  const setHashMatches = opts.manifest !== null && opts.manifest.goldenSetHash === setHash

  // 配置先 FS 上で同一実体に落ちうる組は、適用対象から外して上位へ返す（fail-closed）。
  const pathCollisions = detectPathCollisions(goldenHashes.keys())
  const collidingPaths = new Set(pathCollisions.flat())

  // 早期打ち切り（§6.2）は「同梱物が変わっていない」だけでは足りない。
  // 集合ハッシュは source 側の指標であって、配置先が消えた・壊れたことは何も語らない。
  // よって存在確認（stat のみ・内容は読まない）を通してから打ち切る。
  // ここを省くと、ユーザーが配置先の golden を削除しても次の配布更新まで `restore` に
  // 到達せず、「壊れた導入を clean と報告する」ことになる（D1 の前提が崩れる）。
  const anyDestMissing = [...goldenHashes.keys()].some(
    (rel) => !existsSync(join(opts.targetDir, rel))
  )

  // 内容の改変（ケース3）だけは、集合ハッシュ一致時に持ち越す。
  // 全ファイルを毎起動で読むコストに見合わないため、次の配布更新で拾う（明示的な割り切り）。
  if (
    setHashMatches &&
    deferred.length === 0 &&
    !anyDestMissing &&
    sourceUnreadable.length === 0 &&
    pathCollisions.length === 0
  ) {
    return {
      setHashMatches: true,
      clean: true,
      autoApply: [],
      needsConfirm: [],
      unchangedCount: goldenHashes.size,
      deferred: [],
      unmanaged: [],
      sourceUnreadable: [],
      pathCollisions: []
    }
  }

  const oldByPath = new Map<string, ManifestEntry>()
  for (const e of opts.manifest?.entries ?? []) oldByPath.set(e.path, e)

  const autoApply: ReconcileItem[] = []
  const needsConfirm: ReconcileItem[] = []
  const unmanagedItems: ReconcileItem[] = []
  let unchangedCount = 0

  // 「もう問わない」の記録。抑止は決定時の `G_new` にピン留めされているので、
  // 同梱 golden がそこから動いていたら効かない（＝上流前進で必ずもう一度問う）。
  const unmanagedByPath = new Map<string, UnmanagedRecord>()
  for (const u of opts.manifest?.unmanaged ?? []) unmanagedByPath.set(u.path, u)
  const staleOverlayPaths = opts.staleOverlayPaths ?? new Set<string>()

  for (const [rel, goldenNewHash] of goldenHashes) {
    // 衝突組は「どちらを書いても他方を壊す」ため、確認付きですら適用候補に載せない。
    if (collidingPaths.has(rel)) continue
    const sourcePath = opts.goldenFiles.get(rel) ?? opts.goldenFiles.get(rel.replace(/\//g, '\\'))
    if (!sourcePath) continue
    const destPath = join(opts.targetDir, rel)
    const entry = oldByPath.get(rel) ?? null
    const owner: FileOwner = entry?.owner ?? 'golden'
    const deployedHash = await hashFileAt(destPath)
    const c = classifyFile(entry?.goldenHash ?? null, goldenNewHash, deployedHash, owner)

    if (c === 'unchanged') {
      // 「後で」で持ち越した項目は、状態が unchanged に落ちたなら解消済み。再提示しない。
      unchangedCount++
      continue
    }
    const item: ReconcileItem = {
      path: rel,
      case: c,
      owner,
      sourcePath,
      destPath,
      goldenOldHash: entry?.goldenHash ?? null,
      goldenNewHash,
      deployedHash
    }
    // ADR 0002: 抑止はピンが現在の `G_new` と一致するときだけ効く。
    // 一致しない ＝ 同梱 golden が決定時から動いた ＝ もう一度問う。
    const um = unmanagedByPath.get(rel)
    if (um && um.goldenHashAtDecision === goldenNewHash) {
      unmanagedItems.push(item)
      continue
    }

    // 失効した overlay の rel は無確認適用に載せない（owner: 'promoted' と独立した二重化）。
    if (isAutoApplicable(c) && !staleOverlayPaths.has(rel)) autoApply.push(item)
    else needsConfirm.push(item)
  }

  // 注記（§9.11）: `oldByPath` にあって `goldenHashes` に無いパス ＝ golden から取り除かれた
  // ファイルだが、**配置先からの削除は行わない**。manifest からも落とさず記録を残す
  // （次回 golden に戻ってきたときに `G_old` を失っていると誤って改変扱いになるため）。

  return {
    setHashMatches,
    // 異常（source 破損・パス衝突）がある間は clean を名乗らない。
    // clean は「呼び出し側は何もしなくてよい」の意であり、握り潰しの別名ではない。
    // `unmanaged` は clean を汚さない。「呼び出し側は何もしなくてよい」は真だから
    //（ユーザーが問うなと決めた項目に対して、起動時にできることは何も無い）。
    // 未追従であることの可視化は Health 側の責務であり、clean の意味を広げて代用しない。
    clean:
      autoApply.length === 0 &&
      needsConfirm.length === 0 &&
      sourceUnreadable.length === 0 &&
      pathCollisions.length === 0,
    autoApply,
    needsConfirm,
    unchangedCount,
    deferred,
    unmanaged: unmanagedItems,
    sourceUnreadable,
    pathCollisions
  }
}

/* ------------------------------------------------------------------ *
 * バックアップ運用（§9.8）
 * ------------------------------------------------------------------ */

/**
 * 分類（reconcile）時に観測した配置先ハッシュと、上書き直前の実ハッシュが食い違った。
 *
 * これは「適用の失敗」ではなく「無確認適用の前提が崩れた」ことを表す。
 * 呼び出し側は失敗として捨てず、確認経路（pending）へ回すこと。
 */
export class StaleDestinationError extends Error {
  readonly path: string
  readonly expected: string | null
  readonly actual: string | null

  constructor(path: string, expected: string | null, actual: string | null) {
    super(
      `stale destination snapshot: ${path} — 分類後に配置先が変化したため適用を中止` +
        `（expected ${expected ?? 'absent'}, got ${actual ?? 'absent'}）`
    )
    this.name = 'StaleDestinationError'
    this.path = path
    this.expected = expected
    this.actual = actual
  }
}

/** `<dest>.bak.<ISO8601>` の実パスを組み立てる。 */
export function makeBackupPath(destPath: string, at: Date = new Date()): string {
  return `${destPath}.bak.${at.toISOString().replace(/[:.]/g, '-')}`
}

/**
 * `hooks/` 配下の `.bak.*` から実行ビットを落とす（§9.8）。
 *
 * 将来 `hooks/*` を glob 登録する変更が入ったとき、退避した旧 hook が**誤発火**するのを予防する。
 * Windows では chmod がほぼ無効だが、macOS/Linux 配布と WSL 経由の実行で意味を持つ。
 */
export async function stripBackupExecBit(bakPath: string): Promise<void> {
  try {
    await chmod(bakPath, 0o644)
  } catch {
    // 実行ビット除去の失敗は配置を止めない（予防措置であって正当性パスではない）
  }
}

/**
 * 同一ファイルの `.bak.*` を世代数上限まで刈り込む（§9.8）。
 *
 * 対象は `<basename>.bak.*` に**厳密一致**するものだけで、元ファイルや他ファイルの
 * バックアップには触れない。タイムスタンプ文字列は ISO 8601 を `-` 置換した形式であり
 * 辞書順＝時系列順になるため、名前でソートして古い順に落とす。
 *
 * @returns 削除したバックアップの絶対パス一覧
 */
export async function pruneBackups(
  destPath: string,
  keep: number = DEFAULT_BACKUP_KEEP
): Promise<string[]> {
  if (keep < 0) return []
  const dir = dirname(destPath)
  const base = destPath.slice(dir.length + 1)
  const prefix = `${base}.bak.`
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const baks = names.filter((n) => n.startsWith(prefix)).sort() // 辞書順＝時系列順
  const excess = baks.slice(0, Math.max(0, baks.length - keep))
  const removed: string[] = []
  for (const n of excess) {
    const p = join(dir, n)
    try {
      const st = await lstat(p)
      if (!st.isFile()) continue // ディレクトリ・リンクは触らない
      await rm(p, { force: true })
      removed.push(p)
    } catch {
      // 刈り込み失敗は配置を止めない
    }
  }
  return removed
}

/**
 * 配置先を退避してから golden 内容で上書きする（ケース2/3/4/5 共通の適用処理）。
 *
 * 手順は「退避 → 実行ビット除去 → 世代刈り込み → 上書き」。退避に失敗したら **上書きしない**
 * （新原則2: 黙って消さない）。
 *
 * @returns 作成した `.bak` パス（既存が無ければ null）と、書いた直後に配置先を読み戻して期待値と一致を確認した
 *   指紋 `verifiedHash`（＝ 台帳の `postHash`）。一致しなければ元に戻して投げるので、戻り値がある＝読み戻し済み。
 */
export async function backupAndReplace(
  item: {
    sourcePath: string
    destPath: string
    /**
     * 分類時（reconcile）に観測した配置先ハッシュ。存在しなかった場合は null。
     *
     * 渡された場合、上書き直前に配置先を再ハッシュして一致を確認する（TOCTOU 防止）。
     * 分類から適用までの間に外部エディタや別プロセスが書き換えた内容を、
     * 無確認経路で黙って退避・上書きしてしまうのを防ぐのが目的。
     * `undefined` は検証をスキップ（呼び出し側が意図的に「現状を問わず上書き」する経路用）。
     */
    expectedDestHash?: string | null
    /**
     * `'lf'`: 同梱 golden 由来の配置。テキストは git の版と同じ LF にそろえて書く（`toGoldenBytes`）。
     * 未指定（既定）: 供給元のバイトをそのまま複写する。先祖返りの復元（控えの世代を戻す）は利用者が以前に居た版を
     * 1 バイトも変えずに戻すので指定しない。overlay（利用者の版）を供給元にする配置も指定しない。
     */
    eol?: 'lf'
  },
  opts: { keep?: number; now?: Date } = {}
): Promise<{ backupPath: string | null; verifiedHash: string }> {
  // 手順0: 分類時スナップショットの再検証。無確認適用の前提は「分類した内容のままであること」で、
  // ここが崩れたまま進むと "ユーザーが今書いた内容" を退避扱いで上書きすることになる。
  // 検証に落ちたら適用しない（fail-closed）。呼び出し側は pending へ回して確認を取る。
  if (item.expectedDestHash !== undefined) {
    const currentHash = await hashFileAt(item.destPath)
    if (currentHash !== item.expectedDestHash) {
      throw new StaleDestinationError(item.destPath, item.expectedDestHash, currentHash)
    }
  }

  // 手順1: 先に source を読み切る。ここで失敗したら退避も上書きも**まだ何もしていない**。
  // （後から読むと「退避だけ済んで上書きできない」中途状態を作る）
  const sourceBytes = await readFile(item.sourcePath)
  const payload = item.eol === 'lf' ? toGoldenBytes(item.destPath, sourceBytes) : sourceBytes
  // 指紋の「テキストか」の判定は配置先のパスで行う（読み戻しの `hashFileAt(destPath)` と同じ決まり）。
  // 供給元が控え（`x.sh.bak.<時刻>`）だと拡張子でテキスト判定に落ち、CRLF の控えを戻すと必ず食い違って失敗していた。
  const expectedHash = hashFileBuffer(item.destPath, payload)

  // 手順2: 既存を退避。退避は正当性パスであり、失敗したら上書きへ進ませない（新原則2: 黙って消さない）。
  let backupPath: string | null = null
  let previous: Buffer | null = null
  if (existsSync(item.destPath)) {
    previous = await readFile(item.destPath)
    backupPath = makeBackupPath(item.destPath, opts.now ?? new Date())
    await writeFileAtomic(backupPath, previous)
    await stripBackupExecBit(backupPath)
    await pruneBackups(item.destPath, opts.keep ?? DEFAULT_BACKUP_KEEP)
  }

  // 手順3: 原子的置換。観測される dest は常に「旧内容」か「新内容」のどちらか。
  await writeFileAtomic(item.destPath, payload)

  // 手順4: post-verify。書けたつもりで壊れている（ENOSPC・FS 層の異常・外部干渉）ケースを
  // ここで捕まえる。検証に落ちたら**元に戻してから**投げる。manifest を更新させないため
  // 例外にするのが要点で、戻り値で握り潰させない。
  const actualHash = await hashFileAt(item.destPath)
  if (actualHash !== expectedHash) {
    if (previous !== null) {
      await writeFileAtomic(item.destPath, previous).catch(() => {})
    } else {
      await rm(item.destPath, { force: true }).catch(() => {})
    }
    throw new Error(
      `post-verify failed: ${item.destPath} (expected ${expectedHash}, got ${actualHash ?? 'null'}) — rolled back`
    )
  }

  // 元の実行ビットを引き継ぐ（hooks/*.sh は golden.ts 側で 0o755 を明示付与する）
  try {
    const st = await stat(item.sourcePath)
    await chmod(item.destPath, st.mode & 0o777)
  } catch {
    // モード引き継ぎ失敗は致命ではない（内容の正しさには影響しない）
  }
  return { backupPath, verifiedHash: expectedHash }
}

/* ------------------------------------------------------------------ *
 * W3: アンドゥ・世代復元低レベルプリミティブ (ADR 0004)
 * ------------------------------------------------------------------ */

export interface UndoBackupFileEntry {
  rel: string
  destPath: string
  backupPath: string
  backupHash: string
  currentHash: string | null
  canRestore: boolean
  notRestorableReason?: 'modified' | 'older_generation' | 'backup_missing' | 'dest_missing'
}

export interface UndoGenerationGroup {
  generationStamp: string
  timestamp: string
  isLatest: boolean
  files: UndoBackupFileEntry[]
}

/**
 * 台帳に記録された各エントリについて、隣接する `.bak.<ISO 時刻>` を走査し、
 * 時刻印でグループ化した世代一覧を返す（AC9, AC12, AC13）。
 */
export async function listUndoGenerations(opts: {
  parcFermeDir: string
  targetDir?: string
}): Promise<UndoGenerationGroup[]> {
  const manifest = await readManifest(getManifestPath(opts.parcFermeDir))
  if (!manifest || !Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    return []
  }
  const targetDir = opts.targetDir ?? join(homedir(), '.claude')

  // stamp -> files
  const groupsMap = new Map<string, UndoBackupFileEntry[]>()

  for (const entry of manifest.entries) {
    const rel = normalizeRelPath(entry.path)
    const destPath = join(targetDir, rel)
    const parentDir = dirname(destPath)
    const fileName = basename(destPath)

    if (!existsSync(parentDir)) continue

    let files: string[] = []
    try {
      files = await readdir(parentDir)
    } catch {
      continue
    }

    const prefix = `${fileName}.bak.`
    for (const f of files) {
      if (!f.startsWith(prefix)) continue
      const stamp = f.slice(prefix.length)
      if (!stamp) continue

      const backupPath = join(parentDir, f)
      try {
        const st = await lstat(backupPath)
        if (!st.isFile()) continue // 通常ファイル以外は除外 (AC11, AC25)
      } catch {
        continue
      }

      let list = groupsMap.get(stamp)
      if (!list) {
        list = []
        groupsMap.set(stamp, list)
      }

      list.push({
        rel,
        destPath,
        backupPath,
        backupHash: '', // 後で計算
        currentHash: null,
        canRestore: false
      })
    }
  }

  if (groupsMap.size === 0) return []

  // stamp 降順で整列（新しい順）
  const sortedStamps = [...groupsMap.keys()].sort((a, b) => b.localeCompare(a))

  // 各 rel ごとの最新世代 stamp を同定 (Codex 指摘)
  const latestStampByRel = new Map<string, string>()
  for (const stamp of sortedStamps) {
    const rawFiles = groupsMap.get(stamp)!
    for (const f of rawFiles) {
      if (!latestStampByRel.has(f.rel)) {
        latestStampByRel.set(f.rel, stamp)
      }
    }
  }

  const result: UndoGenerationGroup[] = []

  for (let i = 0; i < sortedStamps.length; i++) {
    const stamp = sortedStamps[i]
    const isLatest = i === 0
    const rawFiles = groupsMap.get(stamp)!

    const uniqueFiles: UndoBackupFileEntry[] = []
    const seenRel = new Set<string>()

    for (const file of rawFiles) {
      if (seenRel.has(file.rel)) continue
      seenRel.add(file.rel)

      const backupHash = (await hashFileAt(file.backupPath)) ?? ''
      file.backupHash = backupHash

      const manifestEntry = manifest.entries.find((e) => normalizeRelPath(e.path) === file.rel)
      const expectedGoldenHash = manifestEntry?.goldenHash

      const isRelLatest = latestStampByRel.get(file.rel) === stamp

      if (!existsSync(file.destPath)) {
        file.canRestore = false
        file.notRestorableReason = 'dest_missing'
      } else {
        const currentHash = await hashFileAt(file.destPath)
        file.currentHash = currentHash

        if (!isRelLatest) {
          file.canRestore = false
          file.notRestorableReason = 'older_generation'
        } else if (currentHash !== expectedGoldenHash) {
          // 上書き後に手編集されている（AC12）
          file.canRestore = false
          file.notRestorableReason = 'modified'
        } else {
          file.canRestore = true
        }
      }

      uniqueFiles.push(file)
    }

    uniqueFiles.sort((a, b) => a.rel.localeCompare(b.rel))

    result.push({
      generationStamp: stamp,
      timestamp: stamp,
      isLatest,
      files: uniqueFiles
    })
  }

  return result
}

export type RestorePrimitiveResult =
  | { ok: true; backupPath: string | null; verifiedHash: string }
  | { ok: false; reason: 'dest_not_found' | 'backup_not_found' | 'backup_tampered' | 'unsafe_path' | 'not_in_manifest' | string }

/**
 * 指定された rel と generationStamp のバックアップを安全に復元する低レベルプリミティブ (AC11, AC25)。
 */
export async function restoreUndoBackupPrimitive(opts: {
  parcFermeDir: string
  targetDir?: string
  rel: string
  generationStamp: string
  expectedBackupHash: string
  expectedDestHash: string
  now?: Date
}): Promise<RestorePrimitiveResult> {
  const normRel = normalizeRelPath(opts.rel)
  // パストラバーサル等の不正パス検知 (AC25)
  if (normRel.includes('..') || isAbsolute(normRel)) {
    return { ok: false, reason: 'unsafe_path' }
  }

  const manifest = await readManifest(getManifestPath(opts.parcFermeDir))
  if (!manifest || !manifest.entries.some((e) => normalizeRelPath(e.path) === normRel)) {
    return { ok: false, reason: 'not_in_manifest' }
  }

  const targetDir = opts.targetDir ?? join(homedir(), '.claude')
  const destPath = join(targetDir, normRel)
  const resolvedTarget = resolve(targetDir)
  const resolvedDest = resolve(destPath)
  const relDiff = relative(resolvedTarget, resolvedDest)

  if (relDiff.startsWith('..') || isAbsolute(relDiff)) {
    return { ok: false, reason: 'unsafe_path' }
  }

  const backupPath = join(dirname(destPath), `${basename(destPath)}.bak.${opts.generationStamp}`)
  if (!existsSync(backupPath)) {
    return { ok: false, reason: 'backup_not_found' }
  }

  try {
    const st = await lstat(backupPath)
    if (!st.isFile()) {
      return { ok: false, reason: 'backup_not_found' }
    }
  } catch {
    return { ok: false, reason: 'backup_not_found' }
  }

  // backup の実測指紋照合（改変検知・AC25）
  const actualBackupHash = await hashFileAt(backupPath)
  if (actualBackupHash !== opts.expectedBackupHash) {
    return { ok: false, reason: 'backup_tampered' }
  }

  try {
    const res = await backupAndReplace(
      {
        sourcePath: backupPath,
        destPath,
        expectedDestHash: opts.expectedDestHash
      },
      { now: opts.now ?? new Date() }
    )
    return { ok: true, backupPath: res.backupPath, verifiedHash: res.verifiedHash }
  } catch (err: unknown) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

