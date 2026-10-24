/**
 * 041: px 経由起動（カスタム ANTHROPIC_BASE_URL = gateway）時の 1M コンテキスト窓確保。
 *
 * 公式 Doc（code.claude.com/docs/en/model-config）: gateway 背後では CC が 1M 対応を検証できず
 * 既定 200K に落ちる。model ID へ `[1m]` variant タグを付けると 1M 窓を選択できる
 * （「Only append `[1m]` when the underlying model supports 1M context」）。
 * 本モジュールは「1M 対応モデルにのみ `[1m]` を付ける」純関数だけを提供する（副作用なし）。
 *
 * 設計要点:
 * - config（pxpipe.fableModel / pxpipe.models）には触れない。付与は起動フラグ側でのみ行い
 *   （ipc.ts の px 確定分岐＝ANTHROPIC_BASE_URL 注入点で適用）、PXPIPE_MODELS は base のまま保つ。
 *   → proxy 横取りは pxpipe 側の `[1m]` strip 後の base 一致で継続（040 R-7 結合を温存）。
 * - 1M 対応は Doc のバージョン範囲（Fable 5+ / Sonnet 4.6+ / Opus 4.6+）を符号化する。列挙でなく
 *   範囲ゆえ将来リビジョン（Opus 4.9・5.x 等）へ自動追従し、非対応家系（haiku）は非収載＝
 *   構造的に過付与不能（発注書 §3「1M 対応モデルにのみ付ける」を機械的に保証）。
 */

// 053: MODEL_ID_RE / 構文解析は src/shared/modelId.ts へ移設（renderer の Fable バージョン検出と
// 単一ソース共有）。本モジュールの 1M 判定意味論（minor 欠落=0・範囲符号化）は不変。
import { parseModelId } from '../../shared/modelId'

/**
 * 1M 対応家系と最小バージョン（major.minor）。
 * 出典: 公式 Doc「Fable 5, Sonnet 5, Opus 4.6 and later, and Sonnet 4.6 support a 1 million
 * token context window」。範囲符号化のため非対応家系（haiku）は載せない。
 */
const ONE_M_CAPABLE_FAMILIES: Record<string, { major: number; minor: number }> = {
  opus: { major: 4, minor: 6 }, // Opus 4.6 and later
  sonnet: { major: 4, minor: 6 }, // Sonnet 4.6 and later（4.5 は非対応）
  fable: { major: 5, minor: 0 } // Fable 5 and later
}

/** 末尾の `[..]` のみ variant タグとみなす（中間の `[` は変種タグ扱いしない）。 */
const TRAILING_VARIANT_TAG_RE = /\[[^\]]*\]$/

/** 1M コンテキスト窓を選択する variant タグ（Doc の正規表記）。 */
const ONE_M_TAG = '[1m]'

/** 起動フラグ中のモデル指定オプション名。 */
const MODEL_FLAG = '--model'

/**
 * model ID が 1M コンテキスト窓に対応するか。
 * 未知形式・CLI 別名・custom 自由入力・非対応家系（haiku）はすべて false（安全側＝付与しない）。
 */
export function isOneMCapable(modelId: string): boolean {
  const p = parseModelId(modelId)
  if (!p) return false
  const floor = ONE_M_CAPABLE_FAMILIES[p.family]
  if (!floor) return false
  return p.major > floor.major || (p.major === floor.major && p.minor >= floor.minor)
}

/**
 * 1M 対応 model ID に `[1m]` を付与する。
 * 既に末尾 variant タグを持つ ID は尊重して素通し（冪等・二重付与防止）。
 * 非対応・未知・custom は無変更で返す。
 */
export function applyOneMContext(modelId: string): string {
  if (TRAILING_VARIANT_TAG_RE.test(modelId)) return modelId
  return isOneMCapable(modelId) ? `${modelId}${ONE_M_TAG}` : modelId
}

/**
 * 起動フラグ配列の `--model <id>` の値へ applyOneMContext を適用した**新配列**を返す（入力は不変）。
 * `--model` が無ければ無変更（通常起動でモデル未選択時は CLI 委譲＝従来挙動を厳守）。
 * 重複指定は CLI が最後を採用しうるため、最後の `--model` を対象にする。
 */
export function applyOneMContextToFlags(flags: string[]): string[] {
  const i = flags.lastIndexOf(MODEL_FLAG)
  if (i === -1 || i + 1 >= flags.length) return flags
  const value = flags[i + 1]
  if (value.startsWith('-')) return flags // 直後が別 flag（値欠落）＝モデル値でない → 触らない
  const out = [...flags]
  out[i + 1] = applyOneMContext(value)
  return out
}
