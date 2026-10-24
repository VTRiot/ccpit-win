/**
 * 台帳の追い付けの「確認ダイアログに出した内容」の正規の文字列（CCPIT_L0_004 W4）。
 *
 * 画面（renderer）はこの文字列の SHA-256 を承認の証跡（confirmationHash）として送り、
 * 主処理（main）は自分の drift の結果から同じ関数で組み直して照合する。食い違えば何も書かずに拒否する。
 * 両側で同じ定義を使うため、ここ（src/shared）に置く。形を変えるときは両側が同時に変わる。
 */
export interface LedgerCatchupConfirmationSubject {
  sha: string
  subject: string
  appliedBy: string
  skillsAffected: readonly string[]
}

export function ledgerCatchupConfirmationString(t: LedgerCatchupConfirmationSubject): string {
  return `${t.sha}:${t.subject}:${t.appliedBy}:${t.skillsAffected.join(',')}`
}

/** 影響スキルの集合が等しいか（順序・重複に依らない）。 */
export function sameSkillSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a)
  const sb = new Set(b)
  if (sa.size !== sb.size) return false
  for (const x of sa) if (!sb.has(x)) return false
  return true
}
