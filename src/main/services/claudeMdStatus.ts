/**
 * CLAUDE.md の基準比較（golden / imported .pit）の Health 表示を決める純関数（electron 非依存・テスト可能）。
 *
 * 不一致を warn にしない — CCPIT は設定 GUI であり、CLAUDE.md のユーザーカスタマイズは製品の
 * 目的そのもの（022 で .pit 分岐に確立した意味論。golden 分岐だけ初期実装の warn が残っていた
 * のを v1.6.0 で統一）。hash 比較は「カスタマイズ」と「破損」を区別できないため、warn にしても
 * 情報量は増えず、正常運用が常設警告（StatusBar の issue 集計対象）になるだけ
 * （v1.3 GoldenDrift 調査で誤誘導表現と指摘済み）。ファイル不在（Not found）は従来どおり
 * 呼び出し側が error として扱う。
 *
 * 【境界契約】本検査が機械判定するのは「不在」「空/空白のみ」（= 挙動的に不在と等価）まで。
 * 非空コンテンツの妥当性（必須節・マーカーの有無等）は検証しない — CLAUDE.md の内容は
 * デプロイ後ユーザーの所有物で、全面書換（migration 相当の運用）も正当なため、golden 由来の
 * 節を不変条件にすると正当な全面カスタムが偽 error 化する。意味層の診断は Doctor Analysis の
 * 管轄であり、この deploy ドリフト検査の scope 外とする。
 */
export interface ClaudeMdComparisonStatus {
  status: 'ok' | 'info'
  detail: string
}

export function claudeMdComparisonStatus(
  reference: 'golden' | 'pit',
  matches: boolean
): ClaudeMdComparisonStatus {
  const refLabel = reference === 'golden' ? 'Golden' : 'imported .pit'
  if (matches) {
    return { status: 'ok', detail: `Matches ${refLabel}` }
  }
  return { status: 'info', detail: `Modified from ${refLabel} (user-edited)` }
}

/**
 * 空/空白のみの CLAUDE.md 判定。CC に指示が一切届かない点で不在と挙動等価であり、
 * 破損の現実的な壊れ方（切詰め・書きかけ保存・誤上書き）でもあるため、比較結果に
 * かかわらず不在（Not found）と同じ error 意味論で扱う（info 化の補償検査 —
 * Codex adversarial review 指摘対応: カスタマイズと破損を混同しない範囲の機械判定のみ）。
 */
export function isDegenerateClaudeMd(text: string): boolean {
  return text.trim().length === 0
}
