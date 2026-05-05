export interface ProtocolMarkerView {
  protocol: string
  revision: string
  stage: 'stable' | 'beta' | 'alpha' | 'experimental'
  stage_inferred: boolean
  variant: string | null
  variant_alias: string | null
  applied_at: string | null
  applied_by: string
  detection_evidence: string | null
  detection_confidence: 'explicit' | 'high' | 'low' | 'unknown'
}

/**
 * FSA r5 以前の互換性のため export 維持。
 * r6 では `formatBadgeView` から色決定軸を `stage` から `protocol × confidence` に
 * 切り替えたため、本マップは現状の表示パスでは未使用。将来 stage 表示が必要に
 * なった場合に再利用できるよう残す（scope 外 (iv) で半年後レビュー候補）。
 */
export const STAGE_COLOR: Record<ProtocolMarkerView['stage'], string> = {
  stable: 'bg-green-500/15 text-green-500 border-green-500/30',
  beta: 'bg-yellow-500/15 text-yellow-500 border-yellow-500/30',
  alpha: 'bg-orange-500/15 text-orange-500 border-orange-500/30',
  experimental: 'bg-red-500/15 text-red-500 border-red-500/30',
}

export const STAGE_SUFFIX: Record<ProtocolMarkerView['stage'], string> = {
  stable: '',
  beta: ' β',
  alpha: ' α',
  experimental: ' exp',
}

/**
 * FSA r6 §4 ProtocolBadge ColorSystem.
 * protocol × confidence の 2 軸で色を決定する semantic 設計。
 * stage は本バッジの色決定軸から外す (stage 固有の表現はツールチップに集約)。
 *
 * 色覚多様性配慮: 緑 (emerald) と 橙 (amber) は赤緑色覚多様性でも区別可能 (青-黄軸)。
 *   加えて文言併記 (MANX / Legacy / Untagged) で色非依存性を確保。
 *
 * WCAG AA: emerald-700 (light) / emerald-300 (dark) は背景に対し 4.5:1 以上を確保。
 *   border-emerald-500/40 で識別性 3:1 確保。amber-700/300 同様。
 *
 * confidence 表現:
 *   - high     : filled (bg 塗り)、視認性最大
 *   - low      : outlined (border のみ + 透過 bg)、控えめ表現
 *   - explicit : 高信頼度 filled (Edit Marker UI 手動明示の重み)
 */
export const PROTOCOL_COLOR: Record<
  'manx' | 'legacy' | 'manx-host',
  { high: string; low: string; explicit: string }
> = {
  manx: {
    high: 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border-emerald-500/40',
    low: 'bg-emerald-500/5 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
    explicit:
      'bg-emerald-500/25 text-emerald-700 dark:text-emerald-300 border-emerald-500/50',
  },
  legacy: {
    high: 'bg-amber-500/20 text-amber-700 dark:text-amber-300 border-amber-500/40',
    low: 'bg-amber-500/5 text-amber-700 dark:text-amber-300 border-amber-500/30',
    explicit: 'bg-amber-500/25 text-amber-700 dark:text-amber-300 border-amber-500/50',
  },
  // FSA r7 §6: manx-host (CCDG2 等の MANX 提供・管理側、レガシー保護内蔵の特殊構造)
  // 中間色 violet で「他とは違う特別な PJ」を視認できる (緑 manx / 橙 legacy と独立軸)
  // WCAG AA: violet-700 (light) / violet-300 (dark) は背景に対し 4.5:1 以上を確保
  'manx-host': {
    high: 'bg-violet-500/20 text-violet-700 dark:text-violet-300 border-violet-500/40',
    low: 'bg-violet-500/5 text-violet-700 dark:text-violet-300 border-violet-500/30',
    explicit:
      'bg-violet-500/25 text-violet-700 dark:text-violet-300 border-violet-500/50',
  },
}

export const UNKNOWN_COLOR = 'bg-muted text-muted-foreground border-border'

export interface BadgeView {
  text: string
  className: string
  isInferred: boolean
}

/**
 * 034: BadgeView.text の i18n マッピング（計画書 r2 §2-2 案 B 採用）。
 * 純粋関数 formatBadgeView はリテラル文字列を返し、ここで i18n キー解決を行う。
 *
 * 将来 i18n 化候補（本タスクスコープ外、マッピングテーブルの空席）:
 *   - 'Legacy'                     → pages.projects.protocolBadge.legacy
 *   - 'MANX' / 'MANX r5' 等の動的組立  → 動的キー化を要設計
 *
 * テスト容易性のため component から lib に移動して純粋関数として配置。
 */
export function localizeBadgeText(text: string, translate: (key: string) => string): string {
  if (text === 'Untagged') return translate('pages.projects.protocolBadge.untagged')
  return text
}

/**
 * FSA r6 §4 ProtocolBadge 表示ロジック。
 *
 * 設計原則 (計画書 r3 §3-2):
 *   1. protocol × confidence の 2 軸で色決定 (stage は色決定軸から外す)
 *   2. バッジ文言は確定状態 (explicit) のみ revision/variant を含む。自動判定では
 *      シンプルな名詞 ("MANX" / "Legacy" / "Untagged")
 *   3. `protocol` フィールドは `string` 型 (types.ts L5)、Edit Marker UI で
 *      'Legacy' (Pascal) 等が入りうる → toLowerCase() で正規化 (§3-3、ZT_Test 検体由来)
 *   4. 自動判定マーカーの「? exp *」3 重表現を廃止 (revision='?' / stage='experimental' /
 *      stage_inferred=true は実質「自動判定」の三重表現)
 */
export function formatBadgeView(m: ProtocolMarkerView | null): BadgeView | null {
  if (!m) return null

  // §3-3: protocol フィールドの大文字小文字バリアント正規化
  // Edit Marker UI 経由で 'Legacy' (Pascal) や 'MANX' (大文字) が入りうる。
  // ZT_Test 検証で `'Legacy'` が第 3 分岐に落ちて「LEGACY ? exp」赤色表示の主因と判明。
  const normalizedProtocol = m.protocol.toLowerCase()

  // unknown: confidence='unknown' は null、それ以外は中立 "Untagged"
  if (normalizedProtocol === 'unknown') {
    if (m.detection_confidence === 'unknown') return null
    return { text: 'Untagged', className: UNKNOWN_COLOR, isInferred: false }
  }

  // confidence のキーを正規化 (DetectionConfidence 型: 'explicit' | 'high' | 'low' | 'unknown')
  const isExplicit = m.detection_confidence === 'explicit'
  const confidenceKey: 'high' | 'low' | 'explicit' = isExplicit
    ? 'explicit'
    : m.detection_confidence === 'high'
      ? 'high'
      : 'low'

  // protocol を 'manx' / 'legacy' / 'manx-host' に分類
  // FSA r7 §6: manx-host を新 protocol 値として導入 (CCDG2 等の MANX 提供側、violet 中間色)
  // それ以外の派生値 ('manx_plot' 等) は manx 色系で扱う
  let protocolKey: 'manx' | 'legacy' | 'manx-host'
  if (normalizedProtocol === 'legacy') protocolKey = 'legacy'
  else if (normalizedProtocol === 'manx-host') protocolKey = 'manx-host'
  else protocolKey = 'manx'
  const colorSet = PROTOCOL_COLOR[protocolKey]

  // 文言: explicit は revision/variant を表示、それ以外はシンプルな名詞
  let text: string
  if (protocolKey === 'legacy') {
    // 'Legacy' / 'LEGACY' / 'legacy' すべてここに正規化される
    text = 'Legacy'
  } else if (protocolKey === 'manx-host') {
    // 'MANX-Host' で明確な区別、視認性確保
    text = isExplicit && m.revision !== '?' ? `MANX-Host ${m.revision}` : 'MANX-Host'
  } else if (isExplicit) {
    // explicit (Edit Marker UI 手動設定) では revision/variant をバッジに含める
    text = `${m.protocol.toUpperCase()} ${m.revision}`
    if (m.variant) {
      text += m.variant_alias ? ` [${m.variant_alias}]` : ` (${m.variant})`
    }
  } else {
    // 自動判定 (high or low): シンプルな名詞 "MANX"
    text = m.protocol.toUpperCase()
  }

  return {
    text,
    className: colorSet[confidenceKey],
    isInferred: m.stage_inferred,
  }
}
