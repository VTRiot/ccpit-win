/**
 * パス同一性の正規化キー（renderer 唯一の正本）。
 *
 * 043: 元は `specialEntries.ts` に住んでいたが、`launchOptions.ts` の `samePath`（比較器）と
 * 起動オプション PJ 単位ストアの**マップキー**が同じ規則でなければならないため、中立な場所へ移した。
 * 比較器とキーが割れると「popover では別 PJ 扱いなのにバケツは同じ（またはその逆）」という
 * 判定不一致が起き、042 の resume 束縛と食い違う。
 *
 * Windows 前提の規則:
 * - 前後空白除去
 * - 区切りを `/` に統一（`C:\a` と `C:/a` を同一視）
 * - 末尾区切りを除去（`C:\a\` と `C:\a` を同一視）
 * - 小文字化（Windows FS は大文字小文字非依存）
 *
 * **意図的に行わないこと**（042 §6-4 案 E で決着済み）: realpath 解決（junction / 8.3 / UNC の同一視）。
 * 純関数へ同期 FS I/O を持ち込み、不在・権限拒否で throw する経路を作るため。比較の両辺は
 * いずれも本アプリが保存したパス文字列なので、差が出るのは区切りと大小のみ。
 *
 * 正規化が足りずに表記が割れた場合（例: Unicode の合成/分解が異なる同名ディレクトリ）、
 * 結果は「**別キー＝別バケツ＝ DEFAULT_OPTIONS**」であって「別 PJ の値の流入」ではない。
 * すなわち**割れる方向は fail-safe** で、危険側（他 PJ の BypassMode 継承）へは倒れない。
 *
 * 表示・保存用の原文には使わない（比較専用）。
 */
export function normalizePathKey(p: string): string {
  const unified = p.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return unified.toLowerCase()
}
