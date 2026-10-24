/**
 * 053 実装レビュー2巡目 medium [1]: 「モデル一覧の再取得」をマウント済み UI へ伝搬する
 * アプリ内イベント（CCES_CONFIG_CHANGED_EVENT と同じ window イベント方式に相乗り）。
 *
 * 背景: LaunchMenu / FableLaunchButton は catalog を mount 時（+ config 変更時）にしか
 * 読まないため、Settings 系の「モデル一覧を取得」が成功してもマウント済みメニューの
 * Fable バージョン選択肢が陳腐化したままだった（053 AC5「取得のたびに更新」違反）。
 *
 * 不変条件:
 *   - dispatch は**取得成功時のみ**（失敗時に「更新された」と偽通知して選択肢を空へ
 *     巻き戻さない。fail-open の向きは R-4 と同じ）
 *   - イベント名の文字列リテラルを他所へ複製しない（この定数だけを import する。
 *     ズレると「発火しているのに誰も聞いていない」無音故障になるため wiring テストで
 *     重複を禁止している）
 */
export const MODEL_CATALOG_CHANGED_EVENT = 'model-catalog-changed'

/** モデル一覧の取得**成功後**に呼ぶ。購読者（LaunchMenu / FableLaunchButton）が catalog を再読する。 */
export function announceModelCatalogChanged(): void {
  window.dispatchEvent(new Event(MODEL_CATALOG_CHANGED_EVENT))
}
