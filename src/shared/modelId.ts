/**
 * 053: モデル ID 構文解析の単一ソース（main / renderer 共用）。
 *
 * 041 contextWindow.ts の MODEL_ID_RE をここへ移設した（挙動不変・既存 contextWindow テストが pin）。
 * renderer 側（launchOptions.ts の Fable バージョン検出）も本モジュールを import することで、
 * 同型正規表現の二重化を構造的に禁止する（053 W-3 設計判断）。
 *
 * ⚠ 本モジュールは**構文事実のみ**を扱う。1M 対応判定（contextWindow.ts）や
 * date suffix の解釈（launchOptions.ts の検出層）等の意味論は呼び出し側の責務。
 */

/**
 * `claude-<family>-<major>[-<minor>]` を抽出（後続は `-<date/suffix>` か終端のみ許容）。
 * バージョン直後を `(?=$|-)` で境界固定＝`claude-opus-4-8x` 等の不正 suffix を「opus 4.8」と
 * 誤読して過付与しない（041 Codex 実装レビュー Low 反映）。日付版（-20260115）は境界 `-` で正しく通る。
 * 旧命名 `claude-3-5-sonnet-*`（family の前が数字）は非マッチ＝非対応で正しく落ちる。
 */
export const MODEL_ID_RE = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?=$|-)/

export interface ParsedModelId {
  family: string
  major: number
  /** minor 欠落時は 0（041 isOneMCapable の既存規約と同一。挙動不変の要）。 */
  minor: number
  /**
   * minor の生文字列（欠落時 null）。
   * W1-2（053 Codex 計画レビュー）: `claude-fable-5-20260902` は構文上 minor=20260902 と
   * 解析される。「8 桁日付形は date suffix」等の解釈はここでは行わず、構文事実として露出する。
   */
  minorText: string | null
}

/** モデル ID を構文解析する。非マッチ（別名・custom・旧命名・空）は null。 */
export function parseModelId(modelId: string): ParsedModelId | null {
  const m = MODEL_ID_RE.exec(modelId)
  if (!m) return null
  return {
    family: m[1],
    major: Number(m[2]),
    minor: m[3] ? Number(m[3]) : 0,
    minorText: m[3] ?? null
  }
}
