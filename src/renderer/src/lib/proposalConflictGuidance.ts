/**
 * Golden 昇格ブラウザ: 提案競合の相手を、画面に出す形へ整える純関数。
 * 主処理が走査時点で作った相手の情報（題名・日付・requestId・提案側の状態）は、そのまま使う。
 * 候補の一覧から引くのは、昇格ブラウザ側の見送り状態だけ（id で厳密に照合する。一覧に相手がいなければ null ＝「取得できません」と出し、別の候補の値で埋めない）。
 */

export interface ConflictPeerInput {
  id: string
  requestId: string
  title: string
  addedAt: string
  hash12: string
  filePath: string
  proposalState: string
}

export interface ConflictPeerView extends ConflictPeerInput {
  /** 昇格ブラウザで見送り済みか。候補の一覧に相手がいなければ null（不明） */
  dismissedHere: boolean | null
}

export function resolveConflictPeers(
  peers: readonly ConflictPeerInput[] | undefined,
  candidates: readonly { id: string; state: string }[]
): ConflictPeerView[] {
  const stateById = new Map<string, string>()
  for (const c of candidates) stateById.set(c.id, c.state)
  return (peers ?? []).map((p) => {
    const st = stateById.get(p.id)
    return { ...p, dismissedHere: st === undefined ? null : st === 'dismissed' }
  })
}

/** 競合の行か（押せない理由が「提案競合」の行）。本数は 2 以上のときだけ意味を持つので、欠けていれば相手の数から復元する */
export function conflictCountOf(item: {
  conflictCount?: number
  conflictPeers?: readonly unknown[]
}): number {
  if (typeof item.conflictCount === 'number' && item.conflictCount >= 2) return item.conflictCount
  return (item.conflictPeers?.length ?? 0) + 1
}
