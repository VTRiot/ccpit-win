/**
 * 検索クエリおよびメタデータの区切り記号吸収正規化ヘルパー (L-2, F-2)
 *
 * ハイフン (-), アンダースコア (_), 空白 (\s+), スラッシュ (/), ドット (.) などの
 * 記号差異を吸収し、完全一致・前方一致・トークン分割を正確に機能させる。
 */

export const toNorm = (s: string): string =>
  (s || '')
    .toLowerCase()
    .replace(/[-_\s./]+/g, ' ')
    .trim()

export const toCompact = (s: string): string =>
  (s || '')
    .toLowerCase()
    .replace(/[-_\s./]+/g, '')
