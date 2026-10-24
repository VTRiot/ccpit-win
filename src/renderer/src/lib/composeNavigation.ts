/**
 * composeNavigation — 合成が登録・承認まで進んだとき、Golden 昇格画面を「その提案を選択済み」で開く合流（T7・純関数＋薄い副作用）。
 *
 * 画面間の受け渡しは sessionStorage（再読込でも残る）と window イベント（App が受けて画面を切り替える）。
 * 承認の押下そのものは Golden 昇格画面の既存の承認ボタンで行う（新しい承認 UI は作らない）。
 */

const PRESELECT_KEY = 'ccpit.goldenPromotion.preselectRequestId'
export const NAVIGATE_EVENT = 'ccpit:navigate'

export interface NavigateDetail {
  page: 'goldenPromotion' | 'adoption'
}

const safeStorage = (): Storage | null => {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

/** 昇格画面で選択済みにしたい提案の request_id を預ける */
export function setPromotionPreselect(
  requestId: string,
  store: Storage | null = safeStorage()
): void {
  try {
    store?.setItem(PRESELECT_KEY, requestId)
  } catch {
    /* 保存できなくても画面移動は続ける */
  }
}

/** 預かった request_id を取り出して消す（1 回だけ効く）。無ければ null */
export function takePromotionPreselect(store: Storage | null = safeStorage()): string | null {
  try {
    const v = store?.getItem(PRESELECT_KEY) ?? null
    if (v !== null) store?.removeItem(PRESELECT_KEY)
    return v && v.trim() !== '' ? v : null
  } catch {
    return null
  }
}

/** 候補の中から、預かった request_id の提案を探す（見つからなければ null。選択を変えない） */
export function findPreselected<T extends { id: string; proposalRequestId?: string }>(
  candidates: readonly T[],
  requestId: string | null
): T | null {
  if (!requestId) return null
  return candidates.find((c) => c.proposalRequestId === requestId) ?? null
}

/** 画面を切り替える依頼を出す（App が受ける） */
export function requestNavigate(
  page: NavigateDetail['page'],
  target: Pick<EventTarget, 'dispatchEvent'> = window
): void {
  target.dispatchEvent(new CustomEvent<NavigateDetail>(NAVIGATE_EVENT, { detail: { page } }))
}
