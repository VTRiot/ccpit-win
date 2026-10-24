/**
 * ユーザーコメントのストア I/O（5 本目のストア）。
 *
 * 設計正本: `user_comment_dialogue_plan.md` §3-2 / §3-4c。
 *
 * ## 設計の芯
 * - **versioned schema**。`{ schemaVersion, repair, adoptions, requests }` を正本とし、
 *   requestId の連想配列を**トップレベルへ直に置かない**（破損マーカーと同階層になって事故る・r5#4）
 * - **schema-valid の判定は `schemaVersion` の有無だけ**で行う。`adoptions` 欠落のみ `{}` へ正規化（r49#1）
 * - **「コメント無し」として正常扱いするのは*一度も作られていない*場合だけ**（r7#1 / r15#3）。
 *   `open` があったストアを**削除するだけで無応答を消せる**なら、空ファイルを塞いだ意味が無い
 * - 書き込みは `.bak`（既存を保護）→ temp → **atomic rename**、対象キーのみ**非破壊マージ**
 *
 * **これは改ざん耐性ではない**（r20#3）。`proposal-comments.json` と `app-config.json` を
 * **同時に**消せば「まっさら」と判定され検知できない。狙いは**事故の検出**である。
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync, renameSync, mkdirSync, statSync } from 'fs'
import { createHash } from 'crypto'
import { homedir } from 'os'
import { join, dirname } from 'path'
import type { ProposalComment, RepairRecord } from './commentGate'
import { COMMENT_SCHEMA_VERSION } from './commentGate'

export interface CommentAdoptionRecord {
  attemptId: string
  at: string
  proposalHash: string
  commentAdoptionSnapshotKey: string
  /** repair 解除の影響下で採用した場合、どの ack で通ったか（r57#2） */
  repairAckRef?: string
  /** repair 影響下では「この requestId のコメント有無は検証不能」を明示（r57#2） */
  unverifiableDueToRepair?: boolean
}

export interface CommentStore {
  schemaVersion: number
  repair: RepairRecord | null
  adoptions: Record<string, CommentAdoptionRecord[]>
  requests: Record<string, ProposalComment[]>
}

export interface CommentStorePaths {
  /** ~/.ccpit/proposal-comments.json */
  storePath: string
  /** ~/.ccpit/comment-snapshots */
  snapshotsDir: string
  /** ~/.ccpit/app-config.json（初期化マーカーの置き場） */
  appConfigPath: string
}

export function defaultCommentStorePaths(): CommentStorePaths {
  const base = join(homedir(), '.ccpit')
  return {
    storePath: join(base, 'proposal-comments.json'),
    snapshotsDir: join(base, 'comment-snapshots'),
    appConfigPath: join(base, 'app-config.json')
  }
}

/** 初期化マーカーの置き場（**別ファイル**に置くのは、ストアごと消しても痕跡が残るようにするため） */
const MARKER_SECTION = 'skillProposals'
const MARKER_KEY = 'commentsStoreInitializedAt'

export const emptyStore = (): CommentStore => ({
  schemaVersion: COMMENT_SCHEMA_VERSION,
  repair: null,
  adoptions: {},
  requests: {}
})

export type StoreProblemKind =
  | 'invalid-json'
  | 'schema-invalid'
  | 'deleted-after-init'
  | 'config-unreadable'

export interface StoreReadResult {
  /** 読めた場合の中身。problem があるときは null */
  store: CommentStore | null
  /** 問題があれば種別と理由（採用ゲートで hard block になる） */
  problem: { kind: StoreProblemKind; reason: string } | null
  /** 一度も作られていない（正常。コメント無しとして扱う） */
  uninitialized: boolean
}

function readJsonFile(path: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf-8')) }
  } catch {
    return { ok: false }
  }
}

function readMarker(appConfigPath: string): { exists: boolean; readable: boolean } {
  if (!existsSync(appConfigPath)) return { exists: false, readable: true }
  const r = readJsonFile(appConfigPath)
  if (!r.ok) return { exists: false, readable: false }
  const cfg = r.value as Record<string, unknown>
  const section = cfg?.[MARKER_SECTION] as Record<string, unknown> | undefined
  return { exists: typeof section?.[MARKER_KEY] === 'string', readable: true }
}

/**
 * ストアを読む。**4 分岐を明示的に分ける**（r16#3。新規インストールを詰ませないため）:
 *
 * | app-config | マーカー | ストア | 判定 |
 * |---|---|---|---|
 * | 不在 | — | 不在 | 正常（まっさら） |
 * | 読める | 無し | 不在 | 正常（未初期化） |
 * | 読める | **あり** | **不在** | **fail-closed**（削除された） |
 * | 読める | — | **あり** | ストアを検査（`schemaVersion` の有無で判定） |
 * | **壊れている** | 判定不能 | — | **fail-closed** |
 */
export function readCommentStore(paths: CommentStorePaths = defaultCommentStorePaths()): StoreReadResult {
  const storeExists = existsSync(paths.storePath)

  if (storeExists) {
    const r = readJsonFile(paths.storePath)
    if (!r.ok) {
      return {
        store: null,
        uninitialized: false,
        problem: {
          kind: 'invalid-json',
          reason: `コメントストアが読めません（不正な JSON）: ${paths.storePath}`
        }
      }
    }
    const v = r.value as Partial<CommentStore> | null
    // schema-valid の判定は `schemaVersion` の有無だけで行う（r49#1）
    if (!v || typeof v !== 'object' || Array.isArray(v) || typeof v.schemaVersion !== 'number') {
      return {
        store: null,
        uninitialized: false,
        problem: {
          kind: 'schema-invalid',
          reason: `コメントストアの形が想定外です（schemaVersion がありません）: ${paths.storePath}`
        }
      }
    }
    return {
      store: {
        schemaVersion: v.schemaVersion,
        repair: v.repair ?? null,
        // `adoptions` 欠落**のみ**互換補完する（唯一の例外・r49#1）
        adoptions: (v.adoptions as Record<string, CommentAdoptionRecord[]>) ?? {},
        requests: (v.requests as Record<string, ProposalComment[]>) ?? {}
      },
      problem: null,
      uninitialized: false
    }
  }

  // --- ストアが無い場合。「未初期化」と「削除された」を区別する ---
  const marker = readMarker(paths.appConfigPath)
  if (!marker.readable) {
    return {
      store: null,
      uninitialized: false,
      problem: {
        kind: 'config-unreadable',
        reason: `設定ファイルが壊れており、コメント機能の初期化状態を判定できません: ${paths.appConfigPath}`
      }
    }
  }
  if (marker.exists) {
    return {
      store: null,
      uninitialized: false,
      problem: {
        kind: 'deleted-after-init',
        reason: `コメントストアが初期化済みなのに存在しません（削除された可能性）: ${paths.storePath}`
      }
    }
  }
  return { store: null, problem: null, uninitialized: true }
}

/** 対象 requestId のコメント一覧（読めない場合は空配列 ＋ problem を呼び出し側が見る） */
export function listComments(requestId: string, read: StoreReadResult): ProposalComment[] {
  return read.store?.requests?.[requestId] ?? []
}

/**
 * ストアを書く。`.bak`（既存は保護）→ temp → **atomic rename**。
 * 呼び出し側は**読んだ store を丸ごと渡す**のではなく、対象キーだけ差し替えた store を渡すこと
 * （全件再構築は他ツールのフィールドを消す — 既存台帳で実際に踏んだ失敗）。
 */
export function writeCommentStore(store: CommentStore, paths: CommentStorePaths = defaultCommentStorePaths()): void {
  mkdirSync(dirname(paths.storePath), { recursive: true })
  const bak = `${paths.storePath}.bak`
  if (existsSync(paths.storePath) && !existsSync(bak)) {
    try {
      copyFileSync(paths.storePath, bak)
    } catch {
      /* .bak はロールバック用であって競合制御ではない。取得失敗で書込は止めない */
    }
  }
  const tmp = `${paths.storePath}.tmp`
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8')
  renameSync(tmp, paths.storePath)
}

/** 初回に schema 付き空ストアを作り、マーカーを別ファイルへ記録する（r15#3） */
export function initializeCommentStore(
  paths: CommentStorePaths = defaultCommentStorePaths(),
  now: string = new Date().toISOString()
): CommentStore {
  const store = emptyStore()
  writeCommentStore(store, paths)
  // マーカーは app-config.json 側（**非破壊マージ**。他セクションを壊さない）
  let cfg: Record<string, unknown> = {}
  if (existsSync(paths.appConfigPath)) {
    const r = readJsonFile(paths.appConfigPath)
    if (r.ok && r.value && typeof r.value === 'object') cfg = r.value as Record<string, unknown>
  }
  const section = { ...((cfg[MARKER_SECTION] as Record<string, unknown>) ?? {}), [MARKER_KEY]: now }
  const next = { ...cfg, [MARKER_SECTION]: section }
  mkdirSync(dirname(paths.appConfigPath), { recursive: true })
  const tmp = `${paths.appConfigPath}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8')
  renameSync(tmp, paths.appConfigPath)
  return store
}

// ---------------------------------------------------------------------------
// スナップショット（`removed` 証跡の基準）
// ---------------------------------------------------------------------------

export const sha256 = (s: string): string => createHash('sha256').update(s, 'utf-8').digest('hex')

export function snapshotPath(paths: CommentStorePaths, requestId: string, commentId: string): string {
  return join(paths.snapshotsDir, requestId, `${commentId}.md`)
}

/**
 * コメント投稿と**同一トランザクション**で提案 content のスナップショットを取る（r44#1）。
 *
 * 基準時点を「依頼文生成時」ではなく「**コメント投稿時**」に置くのが要点。
 * 依頼時点だと「コメント後・依頼前に消えていた」ケースを拾えず、
 * 満たしているのに弱い kind へ落ちる。
 */
export function writeCommentSnapshot(
  paths: CommentStorePaths,
  requestId: string,
  commentId: string,
  content: string
): void {
  const p = snapshotPath(paths, requestId, commentId)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content, 'utf-8')
}

/** snapshot の実在と sha256 一致（層 1b の判定に渡す） */
export function snapshotMatches(
  paths: CommentStorePaths,
  requestId: string,
  commentId: string,
  expectedSha256: string
): boolean {
  const p = snapshotPath(paths, requestId, commentId)
  if (!existsSync(p)) return false
  try {
    return sha256(readFileSync(p, 'utf-8')) === expectedSha256
  } catch {
    return false
  }
}

/** 退避ファイルの実在と sha256 一致（ストア単位ゲートの `reviewed` ack 検証に渡す） */
export function quarantineFileMatches(path: string, expectedSha256: string): boolean {
  if (!path || !existsSync(path)) return false
  try {
    return sha256(readFileSync(path, 'utf-8')) === expectedSha256
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 復旧（`--repair` 相当）
// ---------------------------------------------------------------------------

/**
 * 破損ストアを退避して空ストアを再生成する。
 *
 * **退避は rename（コピーではない）**（r9#3）。`repairAck` が指す `corruptPath` /
 * `corruptSha256` が**退避ファイル 1 本を一意に指す**ようにするため。
 *
 * **退避しただけでは採用ブロックは解けない**（r4#1）。空にすれば通れるなら
 * 「壊れたことにすれば無応答を消せる」という最悪の迂回路になる。
 */
export function repairCommentStore(
  paths: CommentStorePaths = defaultCommentStorePaths(),
  now: string = new Date().toISOString()
): { corruptPath: string; corruptSha256: string } | { missingPath: string } {
  if (existsSync(paths.storePath)) {
    const corruptPath = `${paths.storePath}.corrupt.${now.replace(/[:.]/g, '-')}`
    const body = readFileSync(paths.storePath, 'utf-8')
    renameSync(paths.storePath, corruptPath)
    const corruptSha256 = sha256(body)
    const store = emptyStore()
    store.repair = { kind: 'corrupt_store', at: now, corruptPath, corruptSha256, ack: null }
    writeCommentStore(store, paths)
    return { corruptPath, corruptSha256 }
  }
  // ストアが不在（初期化済みなのに消えた）→ missing_store
  const store = emptyStore()
  store.repair = { kind: 'missing_store', at: now, missingPath: paths.storePath, observedAt: now, ack: null }
  writeCommentStore(store, paths)
  return { missingPath: paths.storePath }
}

/** ファイルの mtime（ミリ秒）。存在しなければ null */
export function mtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}
