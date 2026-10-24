/**
 * FB02（040_FB01 実機視認 T4 指摘）: モデルカタログ取得時刻の表示フォーマッタ。
 * - 日付のみ（旧 MM-DD 固定）→ 日付+時刻へ拡張
 * - 表記は OS ロケール準拠（locale 未指定 = 実行環境の既定。日本語設定なら日本式、
 *   英語圏設定ならその地域式）
 * LaunchMenu / SettingsDialog の重複実装を本ファイルに統一（テスト対象の純関数）。
 */
export function formatCatalogTimestamp(iso: string, locale?: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })
}
