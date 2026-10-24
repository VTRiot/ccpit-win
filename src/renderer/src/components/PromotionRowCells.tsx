import * as React from 'react'
import { Checkbox } from './ui/checkbox'
import { cn } from '../lib/utils'
import {
  blockedRowGuidance,
  composeHoldOf,
  isPromotionItemBlocked,
  type BlockableItem
} from '../lib/promotionBlockedRow'

/**
 * Golden 昇格ブラウザの行のうち、「押せるか」と「合成提案との関係」を決める部品。
 * 画面（GoldenPromotionPage）から切り出したのは、描画して「チェック欄が操作不能であること」と「表示文言」を
 * 試験で確かめるため（`t` は props で受け、react-i18next に依存しない）。
 * 押せるかの判定は lib/promotionBlockedRow.ts の 1 か所の述語（isPromotionItemBlocked）から決まる。
 */

export type Translate = (key: string, params?: Record<string, unknown>) => string

/** 行の先頭のチェック欄。押せない行はチェック欄が無効で、押すと理由の知らせ（onBlockedClick）が出る。 */
export function PromotionRowCheckCell({
  item,
  checked,
  tooltip,
  onToggle,
  onBlockedClick
}: {
  item: BlockableItem
  checked: boolean
  tooltip?: string
  onToggle: () => void
  onBlockedClick: () => void
}): React.JSX.Element {
  const blocked = isPromotionItemBlocked(item)
  return (
    <div
      data-testid="promotion-check-cell"
      className={cn('flex items-center justify-start shrink-0', blocked && 'cursor-not-allowed opacity-50')}
      onClick={(e) => {
        e.stopPropagation()
        if (!blocked) onToggle()
        else onBlockedClick()
      }}
      title={tooltip}
    >
      <Checkbox
        checked={checked}
        disabled={blocked}
        className={cn(blocked && 'pointer-events-none')}
        onCheckedChange={() => {
          if (!blocked) onToggle()
        }}
      />
    </div>
  )
}

/** 題名の下に常時出す 1 行（ツールチップだけにしない）: 「合成提案 X に取り込み済み」「合成提案 X の昇格待ち」。握られていなければ何も出さない。 */
export function PromotionRowHoldLine({
  item,
  t
}: {
  item: BlockableItem
  t: Translate
}): React.JSX.Element | null {
  const hold = composeHoldOf(item)
  if (!hold) return null
  const key =
    hold.kind === 'composed'
      ? 'goldenPromotion.composedRowLine'
      : hold.kind === 'pending'
        ? 'goldenPromotion.pendingRowLine'
        : 'goldenPromotion.waitingRowLine'
  return (
    <span
      data-testid="promotion-hold-line"
      data-hold-kind={hold.kind}
      className="block max-w-full truncate px-1.5 py-0.5 rounded text-[10px] font-medium bg-violet-500/15 text-violet-700 dark:text-violet-300 border border-violet-500/30"
      title={blockedRowGuidance(item) ? t(blockedRowGuidance(item)!.tooltipKey, { composite: hold.compositeId }) : undefined}
    >
      {t(key, { composite: hold.compositeId })}
    </span>
  )
}

/** 差のバッジ。合成提案が握る行は、golden との差（「中身が置き換わる」）の代わりに「取り込み済み」「昇格待ち」を出す。握られていなければ null（従来のバッジを使う）。 */
export function PromotionRowHoldBadge({
  item,
  t
}: {
  item: BlockableItem
  t: Translate
}): React.JSX.Element | null {
  const hold = composeHoldOf(item)
  const g = blockedRowGuidance(item)
  if (!hold || !g) return null
  return (
    <span
      data-testid="promotion-hold-badge"
      className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-violet-500/15 text-violet-700 dark:text-violet-300 border border-violet-500/30"
      title={g.badgeTitleKey ? t(g.badgeTitleKey, { composite: hold.compositeId }) : undefined}
    >
      {t(hold.kind === 'waiting' ? 'goldenPromotion.waitingBadge' : 'goldenPromotion.composedBadge')}
    </span>
  )
}
