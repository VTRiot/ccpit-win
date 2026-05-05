import type { ProtocolMarkerView } from './protocolBadge'

/**
 * CCES Generate ボタンの有効性判定（037 Phase 2-B）。
 *
 * - スイッチ ON (allowAllProjects=true): 常に有効（例外運用）
 * - スイッチ OFF (allowAllProjects=false、既定):
 *   - manx / manx-host のみ有効
 *   - legacy / unknown は無効（灰抜き）
 *   - marker が null/undefined（ロード前）は安全側で有効を維持（busy 表示は短命）
 *
 * marker.protocol は Edit Marker UI で大文字バリアント（'Legacy' Pascal Case）も
 * 入りうるので、toLowerCase で正規化してから判定する（Phase 2-A 申し送り §1-2 の罠対策）。
 */
export function isCcesEnabled(
  marker: ProtocolMarkerView | null | undefined,
  allowAllProjects: boolean,
): boolean {
  if (allowAllProjects) return true
  if (!marker) return true
  const protocol = marker.protocol.toLowerCase()
  return protocol === 'manx' || protocol === 'manx-host'
}

export const CCES_CONFIG_CHANGED_EVENT = 'cces-config-changed'
