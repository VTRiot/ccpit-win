/** 昇格の戻し（Plan r10 §8・T10）の画面の文言。ja/en。2 回押しの確認つき（1 回目で確認の文言に変わる） */
export interface GoldenRollbackText {
  button: string
  confirm: string
  hint: string
  doneTitle: string
  failTitle: string
  doneMessage: (goldenFiles: number) => string
}

export function goldenRollbackText(ja: boolean): GoldenRollbackText {
  return ja
    ? {
        button: 'この昇格を戻す',
        confirm: '本当に戻す（もう一度押すと golden を適用前に戻します）',
        hint: 'golden は契約の手順で、手元の写しと記録は適用の直前の写しから戻します。適用の後に変更されたものがあれば、何も上書きせず止まります。',
        doneTitle: '昇格を戻しました',
        failTitle: '昇格を戻せませんでした',
        doneMessage: (n) => `golden の ${n} ファイルを適用前に戻しました。手元の写しと記録も適用前に戻しています。`
      }
    : {
        button: 'Roll back this promotion',
        confirm: 'Really roll back (press again to restore golden to its state before the promotion)',
        hint: 'Golden is restored through the contract procedure; the local copies and records are restored from the copies saved just before the promotion. If anything changed after the promotion, nothing is overwritten and the rollback stops.',
        doneTitle: 'Promotion rolled back',
        failTitle: 'Could not roll back the promotion',
        doneMessage: (n) => `Restored ${n} golden file(s) to their state before the promotion. Local copies and records were also restored.`
      }
}
