/**
 * platform (process.platform) → golden template マッピング（純関数、electron/React 非依存）。
 *
 * ※ main 側 `src/main/services/denyValidation.ts` の platformToTemplate と**同一ロジック**。
 *   プロセス分離で共有 import できないため二重定義。変更時は両方を同期すること。
 *
 * Marshal F6: darwin は macau（macOS 固有 Keychain/security deny を適用・検証するため）。
 *   win32 → manx / darwin → macau / linux → asama / その他 → manx（既定）。
 *
 * deploy() がこの template を deploy + config に記録し、health がその template の期待 deny を
 * 検証する（resolveExpectedDeny）。両者が同じ template 基準を使う前提を、ここで一元化する。
 */
export function platformToTemplate(platform: string): string {
  if (platform === 'darwin') return 'macau'
  if (platform === 'linux') return 'asama'
  return 'manx'
}
