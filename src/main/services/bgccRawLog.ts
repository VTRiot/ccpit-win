import { appendFileSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getParcFermeDir } from './appConfig'

/**
 * FB02 F7（Codex 設計レビュー finding 6 反映）: BG-CC 生ログのファイル保全。
 * 可視ターミナル窓経路の削除に伴う「診断の逃げ道」。CLI 導入不良・環境継承系の調査は
 * ターミナル復活ではなく、byte 忠実な生ログ + Maintenance の「コピー/フォルダを開く」で代替する。
 *
 * 設計方針:
 * - stdout は受信バイトそのまま append（再エンコードなし）。パーサが壊れた時にこそ価値が出る
 *   ログなので、パース結果ではなく生バイトを正とする。
 * - verdict / stderr / exit code は .meta.json サイドカーに分離（.jsonl を純粋に保つ）。
 * - fs 失敗は全て握って no-op 化する（ログ保全の失敗で run 本体を絶対に壊さない）。
 *   初回失敗後は当該 writer を無効化し、失敗スパムを防ぐ。
 */

/** 保持 run 数。1 run ≒ 数十 KB〜上限 10MB。上限時でも最大 ~200MB でディスクを拘束する。 */
export const BGCC_LOG_KEEP_RUNS = 20
/** 1 run の stdout 書込上限（ディスク保護）。超過分は打切り、meta に truncated を記録する。 */
export const BGCC_LOG_MAX_STDOUT_BYTES = 10 * 1024 * 1024
/** クリップボードコピー上限。超過は末尾切詰め + 注記行（クリップボード暴発防止）。 */
export const BGCC_CLIPBOARD_MAX_BYTES = 1 * 1024 * 1024

const LOG_FILE_PREFIX = 'bgcc-'
const STDOUT_SUFFIX = '.stdout.jsonl'
const META_SUFFIX = '.meta.json'

export function getBgccLogDir(): string {
  return join(getParcFermeDir(), 'bgcc-logs')
}

export interface BgccRunMeta {
  runId: string
  source: string
  phase?: string
  trigger?: string
  model: string
  startedAt: string
  durationMs: number
  exitCode: number | null
  timedOut: boolean
  /** STDERR_CAP_BYTES（bgccStream.ts）まで打切り済みの stderr。 */
  stderrExcerpt: string
  verdict: {
    ok: boolean
    error?: string
    permissionDenied?: boolean
    resultEventCount: number
  }
}

export interface BgccRunLogWriter {
  /** 受信バイトそのまま append。上限超過で打切り（truncated フラグは meta に載る）。 */
  appendStdout(chunk: Buffer): void
  writeMeta(meta: BgccRunMeta): void
  readonly stdoutPath: string
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** 名前ソートで時系列になるベース名（bgcc-YYYYMMDD-HHmmss-<runId 先頭8>）。 */
function buildBaseName(runId: string, now: Date): string {
  const ymd = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`
  const hms = `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`
  const shortId = runId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'unknown'
  return `${LOG_FILE_PREFIX}${ymd}-${hms}-${shortId}`
}

/** ディレクトリ内の run ベース名一覧（新しい順）。名前形式が時系列ソート可能なことに依存。 */
function listRunBases(dir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const bases = new Set<string>()
  for (const f of entries) {
    if (!f.startsWith(LOG_FILE_PREFIX)) continue
    if (f.endsWith(STDOUT_SUFFIX)) bases.add(f.slice(0, -STDOUT_SUFFIX.length))
    else if (f.endsWith(META_SUFFIX)) bases.add(f.slice(0, -META_SUFFIX.length))
  }
  return [...bases].sort().reverse()
}

/** 古い run ログを best-effort 削除し、新しい keep 組だけを残す。 */
export function pruneOldRunLogs(keep: number = BGCC_LOG_KEEP_RUNS): void {
  const dir = getBgccLogDir()
  const bases = listRunBases(dir)
  for (const base of bases.slice(keep)) {
    for (const suffix of [STDOUT_SUFFIX, META_SUFFIX]) {
      try {
        unlinkSync(join(dir, base + suffix))
      } catch {
        /* best-effort */
      }
    }
  }
}

export function createRunLogWriter(runId: string, now: Date = new Date()): BgccRunLogWriter {
  const dir = getBgccLogDir()
  const base = buildBaseName(runId, now)
  const stdoutPath = join(dir, base + STDOUT_SUFFIX)
  const metaPath = join(dir, base + META_SUFFIX)
  let disabled = false
  let writtenBytes = 0
  let truncated = false

  try {
    mkdirSync(dir, { recursive: true })
    // 新規 run の開始時点で古い run を掃除する（書込前に実施し、自分自身は保持対象に含める）。
    pruneOldRunLogs(BGCC_LOG_KEEP_RUNS - 1)
  } catch {
    disabled = true
  }

  return {
    stdoutPath,
    appendStdout(chunk: Buffer): void {
      if (disabled || truncated) return
      let toWrite = chunk
      if (writtenBytes + chunk.length > BGCC_LOG_MAX_STDOUT_BYTES) {
        toWrite = chunk.subarray(0, Math.max(0, BGCC_LOG_MAX_STDOUT_BYTES - writtenBytes))
        truncated = true
      }
      if (toWrite.length === 0) return
      try {
        appendFileSync(stdoutPath, toWrite)
        writtenBytes += toWrite.length
      } catch {
        disabled = true
      }
    },
    writeMeta(meta: BgccRunMeta): void {
      if (disabled) return
      try {
        writeFileSync(
          metaPath,
          JSON.stringify(
            { ...meta, stdoutBytes: writtenBytes, stdoutTruncated: truncated },
            null,
            2
          ),
          'utf8'
        )
      } catch {
        disabled = true
      }
    }
  }
}

/**
 * 最新 run の meta + stdout を連結してクリップボード用テキストを作る（meta 先頭）。
 * maxBytes 超過は末尾切詰め + 日本語注記行。run が 1 件も無ければ null。
 */
export function readLatestRunLogForClipboard(
  maxBytes: number = BGCC_CLIPBOARD_MAX_BYTES
): { text: string; path: string } | null {
  const dir = getBgccLogDir()
  const bases = listRunBases(dir)
  if (bases.length === 0) return null
  const base = bases[0]
  const stdoutPath = join(dir, base + STDOUT_SUFFIX)
  let metaText = ''
  let stdoutText = ''
  try {
    metaText = readFileSync(join(dir, base + META_SUFFIX), 'utf8')
  } catch {
    /* meta 無しでも stdout があれば返す */
  }
  try {
    stdoutText = readFileSync(stdoutPath, 'utf8')
  } catch {
    if (!metaText) return null
  }
  let text = `=== BG-CC run meta (${base}) ===\n${metaText}\n=== raw stdout (JSONL) ===\n${stdoutText}`
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    // UTF-8 バイト境界を壊さないよう Buffer 経由で切詰める
    const buf = Buffer.from(text, 'utf8').subarray(0, maxBytes)
    text = `${buf.toString('utf8')}\n…（${BGCC_CLIPBOARD_MAX_BYTES} bytes 上限で切詰め）`
  }
  return { text, path: stdoutPath }
}
