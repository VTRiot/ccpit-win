/**
 * composePicker — 合成の元提案の選択ダイアログの、選択の状態と文面を決める純関数（React 非依存・画面を描かずに試験できる）。
 *
 * 一覧（選べる提案・選べない同じ skill の提案とその理由）は主処理が決めて返す（IPC `composeSelectable`）。
 * ここは、その一覧から「既定の選択」「押したときの選択」「実行できるか」「実行に渡す ID」「理由の文面」を決めるだけ。
 */

export interface PickerItem {
  requestId: string
  title: string
  adoptionLabel: string
  selectable: boolean
  reason?: 'unreviewed' | 'findings' | 'rejected' | 'adopted' | 'composite' | 'composed' | 'waiting' | 'notCandidate'
  detail?: string
}

/** 既定の選択: 選べる提案を全件（現在の挙動と同じ） */
export function defaultPickerSelection(items: readonly PickerItem[]): Set<string> {
  return new Set(items.filter((i) => i.selectable).map((i) => i.requestId))
}

/** 1 件の選択を反転する。選べない提案・一覧に無い ID は無視する（選択に入れない） */
export function togglePickerSelection(
  selected: ReadonlySet<string>,
  requestId: string,
  items: readonly PickerItem[]
): Set<string> {
  const item = items.find((i) => i.requestId === requestId)
  const next = new Set(selected)
  if (!item || !item.selectable) return next
  if (next.has(requestId)) next.delete(requestId)
  else next.add(requestId)
  return next
}

/** 実行に渡す ID。一覧の順で、選べる提案のうち選択されているものだけ（選べない提案は、選択に混じっていても渡さない） */
export function pickerSubmitIds(selected: ReadonlySet<string>, items: readonly PickerItem[]): string[] {
  return items.filter((i) => i.selectable && selected.has(i.requestId)).map((i) => i.requestId)
}

/** 実行できるか: 1 件以上選ばれていること */
export function canSubmitPicker(selected: ReadonlySet<string>, items: readonly PickerItem[]): boolean {
  return pickerSubmitIds(selected, items).length > 0
}

/** 選べない理由の文面 */
export function pickerReasonText(item: PickerItem, ja: boolean): string {
  const d = item.detail ?? ''
  switch (item.reason) {
    case 'unreviewed':
      return ja ? '独立レビューが未実施です' : 'No independent review yet'
    case 'findings':
      return ja
        ? `独立レビューに指摘があります（${d || '未承認'}）`
        : `The independent review raised findings (${d || 'not approved'})`
    case 'rejected':
      return ja ? '却下済みです' : 'Rejected'
    case 'adopted':
      return ja ? '採用済みです' : 'Already adopted'
    case 'composite':
      return ja ? '合成提案そのものです' : 'This is a composite proposal itself'
    case 'composed':
      return ja ? `合成提案 ${d} に取り込み済みです` : `Already merged into composite ${d}`
    case 'waiting':
      return ja
        ? `別の合成提案 ${d} の昇格待ちです（その昇格が終わるまで選べません）`
        : `Waiting for another composite ${d} to be promoted (not selectable until then)`
    case 'notCandidate':
    default:
      return ja
        ? '昇格候補にできません（提案の書式・レビューの照合などを確認してください）'
        : 'Not a promotion candidate (check the proposal format or review binding)'
  }
}
