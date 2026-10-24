import { StringDecoder } from 'string_decoder'

/**
 * FB02: `claude -p --output-format=stream-json --verbose` の JSONL ストリーム解析核（純関数）。
 * spawn/fs/electron を一切伴わないため、実CLI出力フィクスチャ（__tests__/fixtures/bgcc-stream/）で
 * チャンク分割・改行規約・切断・result 重複/欠落まで決定論に検証できる。
 *
 * 防御規律（Codex 設計レビュー finding 1/2 反映）:
 * - 最終判定はトップレベル `type:"result"` イベント「ちょうど1件」にのみ基づく（0件・複数件は失敗）。
 *   assistant/tool/system 等の途中イベントは表示専用で判定に一切使わない。
 * - 非0 exit code は有効 result が無い場合のみ失敗根拠。それ以外は診断情報扱い。
 * - 行未確定バッファに上限を敷き、超過は run 失敗（暴走出力・改行なし巨大出力からの防御）。
 * - 非 JSON 行は raw_stdout 表示のみへ退化させ、成功判定に干渉させない。
 */

/**
 * F3: 行未確定バッファ（改行が来ていない蓄積分）の上限。実測の最大行は 55KB（WebFetch の
 * tool_result 行）で、2MB は実用行の約36倍のマージン。超過は「改行を返さない暴走出力」とみなし
 * run を失敗させる。
 */
export const STREAM_LINE_BUFFER_CAP_BYTES = 2 * 1024 * 1024
/** stderr 収集上限。診断用途（エラーメッセージは先頭に出る）のため打切りのみで失敗事由にしない。 */
export const STDERR_CAP_BYTES = 256 * 1024
/** F4: 1イベント text の上限（renderer へ渡す不活性テキスト。ツール結果全文は生ログ側が持つ）。 */
export const ACTIVITY_TEXT_CAP = 400
/** F4: 1 run の表示イベント数上限（イベント洪水対策。判定用 result カウントには影響しない）。 */
export const ACTIVITY_MAX_DISPLAY_EVENTS = 500
/** ツール引数/結果要約の詳細部の長さ。URL・JSON 先頭の識別に足る実用値。 */
const TOOL_SUMMARY_DETAIL_CAP = 80

export interface StreamDisplayEvent {
  kind: 'assistant' | 'tool' | 'raw_stdout'
  text: string
}

export interface StreamVerdict {
  /** true = result ちょうど1件 かつ 厳密検証パス かつ permission 拒否なし かつ overflow なし。 */
  ok: boolean
  resultText?: string
  permissionDenied: boolean
  error?: string
  resultEventCount: number
  costUsd?: number
  overflowed: boolean
}

/**
 * FB01 parseEnvelope の等価物（適用点の移動のみ・防御意味論は逐語維持）。
 * 旧: stdout 全体文字列 → JSON.parse → envelope 検証。
 * 新: stream の result イベント（パース済みオブジェクト）→ 同一の envelope 検証。
 * 外側 JSON.parse はアキュムレータの行パースが担うため本関数からは外れる。
 * - permission_denials 非空 → permissionDenied（偽装成功応答の一次検知）
 * - is_error === true / subtype !== 'success' → 失敗
 * - `.result` 文字列全体への厳密 JSON.parse のみ信頼（部分一致・正規表現抽出は禁止 —
 *   劣化フォールバック応答を誤って本物として通さないため）
 */
export function validateResultEvent(obj: unknown): {
  resultText?: string
  permissionDenied: boolean
  error?: string
} {
  if (!obj || typeof obj !== 'object') {
    return { permissionDenied: false, error: 'CLI出力が不正な形式' }
  }
  const env = obj as Record<string, unknown>
  const denials = Array.isArray(env.permission_denials) ? env.permission_denials : []
  const permissionDenied = denials.length > 0
  if (env.is_error === true || env.subtype !== 'success') {
    return { permissionDenied, error: 'CLI実行が失敗を報告' }
  }
  const result = typeof env.result === 'string' ? env.result.trim() : ''
  try {
    JSON.parse(result)
  } catch {
    return { permissionDenied, error: '応答本文が厳密JSONでない（劣化フォールバック応答の疑い）' }
  }
  return { resultText: result, permissionDenied }
}

// ANSI CSI シーケンス（色・カーソル制御）。CLI が TTY 判定を誤った場合の混入に備える。
// eslint-disable-next-line no-control-regex
const ANSI_CSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
// \t \n を除く C0 制御文字 + DEL。不活性テキスト化（F4: renderer は素のテキストとしてのみ描画）。
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

/** F4: イベント text の無害化（ANSI/制御文字の除去 + 長さ上限）。 */
export function sanitizeEventText(s: string, cap: number = ACTIVITY_TEXT_CAP): string {
  const cleaned = s.replace(ANSI_CSI_RE, '').replace(CONTROL_CHARS_RE, ' ')
  return cleaned.length > cap ? `${cleaned.slice(0, cap)}…` : cleaned
}

/** F4: tool_use の既定要約（名前 + URL があれば URL、なければ引数 JSON の先頭）。全文は生ログ側。 */
export function summarizeToolUse(name: string, input: unknown): string {
  let detail = ''
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>
    if (typeof obj.url === 'string') {
      detail = obj.url.slice(0, TOOL_SUMMARY_DETAIL_CAP)
    } else {
      try {
        detail = JSON.stringify(obj).slice(0, TOOL_SUMMARY_DETAIL_CAP)
      } catch {
        detail = ''
      }
    }
  }
  return sanitizeEventText(detail ? `${name}: ${detail}` : name)
}

/** assistant/user イベントの message.content からテキスト片を安全に取り出す。 */
function extractContentBlocks(obj: Record<string, unknown>): unknown[] {
  const message = obj.message
  if (!message || typeof message !== 'object') return []
  const content = (message as Record<string, unknown>).content
  return Array.isArray(content) ? content : []
}

/** tool_result の content（string | {type:'text'}[] 想定）からプレビュー文字列を取り出す。 */
function toolResultPreview(block: Record<string, unknown>): string {
  const content = block.content
  if (typeof content === 'string') return content.slice(0, TOOL_SUMMARY_DETAIL_CAP)
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item && typeof item === 'object') {
        const text = (item as Record<string, unknown>).text
        if (typeof text === 'string') return text.slice(0, TOOL_SUMMARY_DETAIL_CAP)
      }
    }
  }
  return ''
}

export interface StreamJsonAccumulator {
  /** stdout チャンクを供給し、確定した表示イベントを返す（result イベントは表示に出さず内部蓄積）。 */
  feed(chunk: Buffer): StreamDisplayEvent[]
  /** close 時に1回だけ呼ぶ。decoder 残余 + 未改行の最終行を flush する。 */
  end(): StreamDisplayEvent[]
  /** F2: 最終判定。exit code / timeout / spawn 失敗と result イベント蓄積から verdict を出す。 */
  finalize(input: {
    exitCode: number | null
    timedOut: boolean
    spawnError?: string
  }): StreamVerdict
  readonly overflowed: boolean
}

export function createStreamJsonAccumulator(opts?: {
  maxLineBufferBytes?: number
  maxEventTextLen?: number
  maxDisplayEvents?: number
}): StreamJsonAccumulator {
  const maxLineBufferBytes = opts?.maxLineBufferBytes ?? STREAM_LINE_BUFFER_CAP_BYTES
  const maxEventTextLen = opts?.maxEventTextLen ?? ACTIVITY_TEXT_CAP
  const maxDisplayEvents = opts?.maxDisplayEvents ?? ACTIVITY_MAX_DISPLAY_EVENTS

  const decoder = new StringDecoder('utf8')
  let pending = ''
  let overflowed = false
  let ended = false
  let displayCount = 0
  let suppressionNoticed = false
  // F2: 判定は「ちょうど1件」制約なので、先頭イベントと件数だけ保持すれば十分
  //（2件目以降の中身は判定に使わない。重複格納による肥大も防ぐ）。
  let firstResultEvent: Record<string, unknown> | null = null
  let resultEventCount = 0
  let costUsd: number | undefined

  const cap = (s: string): string => sanitizeEventText(s, maxEventTextLen)

  function pushDisplay(out: StreamDisplayEvent[], ev: StreamDisplayEvent): void {
    if (displayCount >= maxDisplayEvents) {
      if (!suppressionNoticed) {
        suppressionNoticed = true
        out.push({ kind: 'raw_stdout', text: '（表示イベント上限に達したため以降は省略）' })
      }
      return
    }
    displayCount++
    out.push(ev)
  }

  function classifyLine(line: string, out: StreamDisplayEvent[]): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      pushDisplay(out, { kind: 'raw_stdout', text: cap(line) })
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      pushDisplay(out, { kind: 'raw_stdout', text: cap(line) })
      return
    }
    const obj = parsed as Record<string, unknown>
    switch (obj.type) {
      case 'result': {
        resultEventCount++
        if (!firstResultEvent) {
          firstResultEvent = obj
          if (typeof obj.total_cost_usd === 'number') costUsd = obj.total_cost_usd
        }
        // 表示イベントは出さない（終端イベントは runner が verdict 確定後に1回だけ emit する）
        return
      }
      case 'assistant': {
        for (const block of extractContentBlocks(obj)) {
          if (!block || typeof block !== 'object') continue
          const b = block as Record<string, unknown>
          if (b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '') {
            pushDisplay(out, { kind: 'assistant', text: cap(b.text) })
          } else if (b.type === 'tool_use' && typeof b.name === 'string') {
            // summarizeToolUse は既定 cap で sanitize 済みだが、インスタンス毎の cap も適用する
            pushDisplay(out, { kind: 'tool', text: cap(summarizeToolUse(b.name, b.input)) })
          }
        }
        return
      }
      case 'user': {
        for (const block of extractContentBlocks(obj)) {
          if (!block || typeof block !== 'object') continue
          const b = block as Record<string, unknown>
          if (b.type === 'tool_result') {
            pushDisplay(out, { kind: 'tool', text: cap(`ツール結果: ${toolResultPreview(b)}`) })
          }
        }
        return
      }
      default: {
        // system / rate_limit_event（実測で存在）/ 将来の未知 type は表示専用へ退化させる
        //（判定に不使用 — CLI 版数によるスキーマ漂流への耐性）。
        const subtype = typeof obj.subtype === 'string' ? `:${obj.subtype}` : ''
        const t = typeof obj.type === 'string' ? obj.type : '?'
        pushDisplay(out, { kind: 'raw_stdout', text: cap(`[${t}${subtype}]`) })
        return
      }
    }
  }

  // searchFrom: 前回 drain 後の pending には '\n' が存在しないため、新規追記分だけを走査する
  //（1バイト刻みチャンク供給でも O(総バイト数) を維持するための位置ヒント。正しさには影響しない）。
  function drainLines(out: StreamDisplayEvent[], searchFrom: number): void {
    let idx = pending.indexOf('\n', searchFrom)
    while (idx >= 0) {
      let line = pending.slice(0, idx)
      pending = pending.slice(idx + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line.trim() !== '') classifyLine(line, out)
      idx = pending.indexOf('\n')
    }
  }

  return {
    get overflowed(): boolean {
      return overflowed
    },
    feed(chunk: Buffer): StreamDisplayEvent[] {
      if (overflowed || ended) return []
      const out: StreamDisplayEvent[] = []
      const prevLen = pending.length
      pending += decoder.write(chunk)
      drainLines(out, prevLen)
      if (Buffer.byteLength(pending, 'utf8') > maxLineBufferBytes) {
        overflowed = true
        pending = ''
        return out
      }
      return out
    },
    end(): StreamDisplayEvent[] {
      if (overflowed || ended) return []
      ended = true
      const out: StreamDisplayEvent[] = []
      pending += decoder.end()
      drainLines(out, 0)
      const rest = pending.endsWith('\r') ? pending.slice(0, -1) : pending
      pending = ''
      if (rest.trim() !== '') classifyLine(rest, out)
      return out
    },
    finalize(input): StreamVerdict {
      const base = {
        permissionDenied: false,
        resultEventCount,
        costUsd,
        overflowed
      }
      if (input.spawnError) {
        return { ...base, ok: false, error: input.spawnError }
      }
      if (overflowed) {
        return {
          ...base,
          ok: false,
          error: `stdout 行バッファ上限（${maxLineBufferBytes} bytes）超過`
        }
      }
      if (resultEventCount === 0) {
        // F2: 非0 exit code は「有効 result が無い」この経路でのみ失敗根拠として記載する。
        const grounds = input.timedOut
          ? 'timeout'
          : input.exitCode !== 0
            ? `exit code ${input.exitCode}`
            : 'ストリーム完了'
        return { ...base, ok: false, error: `result イベント 0 件（${grounds}）` }
      }
      if (resultEventCount >= 2) {
        return { ...base, ok: false, error: `result イベントが複数（${resultEventCount} 件）` }
      }
      const v = validateResultEvent(firstResultEvent)
      return {
        ...base,
        ok: !v.error && !v.permissionDenied,
        resultText: v.resultText,
        permissionDenied: v.permissionDenied,
        error: v.error
      }
    }
  }
}
