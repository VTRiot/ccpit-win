/**
 * Golden 昇格ブラウザの「押せない行」を決める純関数（React 非依存・画面を描かずに試験できる）。
 *
 * 押せない 4 状態（一致 identical・golden 先行 stale-local・分岐 diverged・競合 proposal-conflict）と、
 * 合成提案が握っている行（取り込み済みの元提案 composedInto・合成の元に選ばれなかった提案 composeWaitingFor）について、
 * 行のチェックの無効化・ツールチップ・押したときの知らせ・バッジの title・詳細ペインの文・全選択の対象・反映の対象を、
 * この 1 か所の述語から決める。状態の分岐が画面に散らばっていた頃は、競合の行にしか知らせが出なかった。
 *
 * 文は候補の種類で分ける（`source`）: 手元のスキル（normal）・救済（rescue）・提案（proposal）。
 * 一致は 3 種類すべてに付き、分岐は手元と提案に付き、golden 先行は手元にだけ、競合は提案にだけ付く。
 */

export type CandidateKind = 'local' | 'rescue' | 'proposal'

export interface BlockableItem {
  diffState?: string
  source?: string
  /** 有効な合成提案に取り込まれた元提案の、その合成提案の request_id（個別には昇格できない） */
  composedInto?: string
  /** 合成の元に選ばれなかった提案の、昇格待ちの相手の合成提案の request_id（個別には昇格できない） */
  composeWaitingFor?: string
  /** 登録済みだがまだ有効でない合成提案の元提案の、その合成提案の request_id（表示専用。個別には昇格できない） */
  composeHeldBy?: string
  /** 握っている合成提案が異常（MD 欠落・書き換え・registered のまま adopted）。承認待ちではなく異常として案内する */
  composeHoldAbnormal?: string
}

/**
 * 合成提案が握っている行の種類: 取り込み済みの元提案（composed）・合成の元に選ばれなかった提案（waiting）・
 * 登録済みだがまだ有効でない（未 approve など）合成提案の元提案（pending）。握られていなければ null
 */
export type ComposeHoldKind = 'composed' | 'waiting' | 'pending'

export function composeHoldOf(item: BlockableItem): { kind: ComposeHoldKind; compositeId: string } | null {
  if (item.composedInto) return { kind: 'composed', compositeId: item.composedInto }
  if (item.composeHeldBy)
    return { kind: item.composeHoldAbnormal ? 'composed' : 'pending', compositeId: item.composeHeldBy }
  if (item.composeWaitingFor) return { kind: 'waiting', compositeId: item.composeWaitingFor }
  return null
}

export interface BlockedRowGuidance {
  /** 行のチェックの title（ツールチップ）。辞書キー（`goldenPromotion.` 付き）。競合だけ `{{count}}` を取る */
  tooltipKey: string
  /** 押せないチェックを押したときの警告の知らせ。`{{skill}}`（競合は `{{count}}` も）を取る */
  noticeKey: string
  /** 差のバッジの title。競合は `{{count}}` を取る */
  badgeTitleKey?: string
  /** 詳細ペインの見出しと本文（一致・golden 先行・競合は別の部品があるので付けない） */
  paneTitleKey?: string
  paneBodyKey?: string
}

const K = (key: string): string => `goldenPromotion.${key}`

/** 候補の種類の正規化。画面の行・ツールチップ・バッジ・詳細ペイン・クリックの知らせは、必ずこれを通した結果を使う。 */
export function candidateKindOf(item: BlockableItem): CandidateKind {
  if (item.source === 'proposal') return 'proposal'
  if (item.source === 'rescue') return 'rescue'
  return 'local'
}

/** 押せない行か（diffState の 4 状態、または合成提案が握っている行）。`blockedRowGuidance` が null でない行と同じ集合。 */
export function isPromotionItemBlocked(item: BlockableItem): boolean {
  return isPromotionRowBlocked(item.diffState) || composeHoldOf(item) !== null
}

/** diffState だけで決まる押せない 4 状態。行の判定には合成提案が握る行も含む `isPromotionItemBlocked` を使う。 */
export function isPromotionRowBlocked(diffState: string | undefined): boolean {
  return (
    diffState === 'identical' ||
    diffState === 'stale-local' ||
    diffState === 'diverged' ||
    diffState === 'proposal-conflict'
  )
}

/** 押せない行の知らせの辞書キー。押せる行（新規・内容変更・未定義）は null。 */
export function blockedRowGuidance(item: BlockableItem): BlockedRowGuidance | null {
  const kind = candidateKindOf(item)
  // 合成提案が握っている行は、diffState（golden との差）より先に、握られている理由を出す
  const hold = composeHoldOf(item)
  if (hold?.kind === 'composed') {
    return {
      tooltipKey: K('composedTooltip'),
      noticeKey: K('composedNotice'),
      badgeTitleKey: K('composedBadgeTitle'),
      paneTitleKey: K('composedPaneTitle'),
      paneBodyKey: K('composedPaneBody')
    }
  }
  if (hold?.kind === 'pending') {
    return {
      tooltipKey: K('pendingTooltip'),
      noticeKey: K('pendingNotice'),
      badgeTitleKey: K('pendingBadgeTitle'),
      paneTitleKey: K('pendingPaneTitle'),
      paneBodyKey: K('pendingPaneBody')
    }
  }
  if (hold?.kind === 'waiting') {
    return {
      tooltipKey: K('waitingTooltip'),
      noticeKey: K('waitingNotice'),
      badgeTitleKey: K('waitingBadgeTitle'),
      paneTitleKey: K('waitingPaneTitle'),
      paneBodyKey: K('waitingPaneBody')
    }
  }
  switch (item.diffState) {
    case 'identical':
      if (kind === 'proposal') {
        return {
          tooltipKey: K('proposalIdenticalTooltip'),
          noticeKey: K('proposalIdenticalNotice')
        }
      }
      if (kind === 'rescue') {
        return { tooltipKey: K('rescueIdenticalTooltip'), noticeKey: K('rescueIdenticalNotice') }
      }
      return { tooltipKey: K('identicalTooltip'), noticeKey: K('identicalNotice') }
    case 'stale-local':
      return {
        tooltipKey: K('staleLocalTooltip'),
        noticeKey: K('staleLocalNotice'),
        badgeTitleKey: K('staleLocalBadgeTitle')
      }
    case 'diverged':
      if (kind === 'proposal') {
        return {
          tooltipKey: K('proposalDivergedTooltip'),
          noticeKey: K('proposalDivergedNotice'),
          badgeTitleKey: K('proposalDivergedBadgeTitle'),
          paneTitleKey: K('proposalDivergedPaneTitle'),
          paneBodyKey: K('proposalDivergedPaneBody')
        }
      }
      return {
        tooltipKey: K('divergedTooltip'),
        noticeKey: K('divergedNotice'),
        badgeTitleKey: K('divergedBadgeTitle'),
        paneTitleKey: K('divergedPaneTitle'),
        paneBodyKey: K('divergedPaneBody')
      }
    case 'proposal-conflict':
      return {
        tooltipKey: K('conflictRowTooltip'),
        noticeKey: K('conflictNotice'),
        badgeTitleKey: K('conflictBadgeTooltip')
      }
    default:
      return null
  }
}

/**
 * 全選択の対象。押せない 4 状態の行は入れない（選べたのに反映で失敗する、を防ぐ）。
 * `includeBlocked` は、絞り込みが「見送り」のときだけ true にする: 見送り済みの行を未処理に戻す道を残すため。
 */
export function bulkSelectableCandidates<T extends BlockableItem>(
  items: readonly T[],
  opts: { includeBlocked?: boolean } = {}
): T[] {
  if (opts.includeBlocked) return [...items]
  return items.filter((c) => !isPromotionItemBlocked(c))
}

/**
 * 反映に渡してよい ID。選択済みの ID のうち、候補にあって押せる行だけ。
 * 候補が更新されて押せない状態に変わった行が選択に残っていても、反映へ届かない。
 */
export function applicableIds<T extends BlockableItem & { id: string }>(
  ids: Iterable<string>,
  candidates: readonly T[]
): string[] {
  const byId = new Map(candidates.map((c) => [c.id, c]))
  const out: string[] = []
  for (const id of ids) {
    const c = byId.get(id)
    if (c && !isPromotionItemBlocked(c)) out.push(id)
  }
  return out
}
