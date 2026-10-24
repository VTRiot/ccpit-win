/**
 * Golden 昇格ブラウザで golden を書き換える操作（承認・戻し・撤去・復帰・台帳の追い付け・リースの解放・残骸の清掃）の
 * パスワード関門の画面側（CCPIT_L0_003）。検証そのものは主処理が行い、ここは「押せるか」と文言だけを決める。
 *
 * 「採用 (Apply)」と同じ型: 登録済みなら入力欄を出し、未入力なら押せない（理由は adoptBlockers と同じ文言）。
 * 「採用」と違うのは未登録のとき: 押した後に主処理が拒否するのでなく、押す前に案内を出して押せなくする。
 *
 * 未登録の案内（CCPIT_L0_004 W5）: Setup の完了後はサイドバーに Setup が出ないので、実際の導線（設定 → メンテナンス →
 * Recovery Kit →「Setup ナビを常に表示」）を書く。案内の「Setup を開く」ボタンは、その手数を 1 回にまとめる。
 * パスワードを単独で登録する画面は無い。登録は Fresh Start / Migration の中にあり、golden を ~/.claude に配り直す。
 */
export type GoldenWriteAuthReason = 'auth-missing' | 'authentication-failed'

export interface GoldenWriteAuthText {
  placeholder: string
  /** 登録済み・未入力で押せない理由（「採用」の adoptBlockers と同じ文言） */
  notEntered: string
  /** 未登録の案内（押す前に出す） */
  notRegistered: string
  /** 未登録の案内のボタン（押すと Setup のナビを表示にして、Setup の画面へ移る） */
  openSetupLabel: string
  /** ボタンの横の注意: Setup のナビの表示が残ることと、その切り方 */
  openSetupNote: string
  /** 拒否が返ったときの結果ダイアログの題 */
  rejectedTitle: string
  /** 拒否が返ったときの本文: 何が起きなかったか ＋ 次の手 */
  rejectedMessage: (reason: GoldenWriteAuthReason) => string
}

export function goldenWriteAuthText(ja: boolean): GoldenWriteAuthText {
  return ja
    ? {
        placeholder: 'パスワード',
        notEntered: '認証パスワードが未入力です',
        notRegistered:
          '認証パスワードが未登録のため、golden を書き換える操作はできません。下の「Setup を開く」を押し、「Fresh Start」→「認証パスワード設定」で登録してください（ボタンを使わない場合は、サイドバー下の「設定」→「メンテナンス画面を開く」→「Recovery Kit」→「Setup ナビを常に表示」を入れると、サイドバーに「Setup」が出ます）。Fresh Start は golden を ~/.claude に配り直します（上書きの前に控えを取ります）。',
        openSetupLabel: 'Setup を開く',
        openSetupNote:
          'サイドバーの「Setup」は、Setup を最後まで終えると消えます。途中でやめた場合は残るので、「Recovery Kit」の「Setup ナビを常に表示」を切って消してください。',
        rejectedTitle: '実行しませんでした（パスワード）',
        rejectedMessage: (reason) =>
          reason === 'auth-missing'
            ? 'golden・手元の配布先・台帳は、どれも書き換えていません。認証パスワードが未登録です。確認の欄の「Setup を開く」から「Fresh Start」→「認証パスワード設定」で登録してから、もう一度実行してください。'
            : 'golden・手元の配布先・台帳は、どれも書き換えていません。パスワードが違うか未入力です。パスワードを確かめて、もう一度実行してください。'
      }
    : {
        placeholder: 'password',
        notEntered: 'password not entered',
        notRegistered:
          'No authentication password is registered, so operations that change golden are unavailable. Press "Open Setup" below, then register one under "Fresh Start" → "Set Auth Password". (Without the button: Settings at the bottom of the sidebar → "Open Maintenance" → "Recovery Kit" → turn on "Always show Setup nav", and "Setup" appears in the sidebar.) Fresh Start redeploys golden into ~/.claude (a backup is taken before overwriting).',
        openSetupLabel: 'Open Setup',
        openSetupNote:
          '"Setup" stays in the sidebar until Setup is finished. If you stop midway, turn off "Always show Setup nav" in "Recovery Kit" to hide it.',
        rejectedTitle: 'Not executed (password)',
        rejectedMessage: (reason) =>
          reason === 'auth-missing'
            ? 'Nothing was changed: golden, the local copies and the ledgers are untouched. No authentication password is registered. Use "Open Setup" in the confirmation, then "Fresh Start" → "Set Auth Password", and try again.'
            : 'Nothing was changed: golden, the local copies and the ledgers are untouched. The password was wrong or empty. Check the password and try again.'
      }
}

/** 実行ボタンを押せるか。未登録・未入力なら押せない（押す前に止める） */
export function canRunGoldenWrite(hasPassword: boolean, password: string): boolean {
  return hasPassword && password.length > 0
}

/** 押せない理由（押せるなら null） */
export function goldenWriteBlocker(
  hasPassword: boolean,
  password: string,
  text: GoldenWriteAuthText
): string | null {
  if (!hasPassword) return text.notRegistered
  if (password.length === 0) return text.notEntered
  return null
}

/** 主処理が返した値が、パスワードの関門による拒否か */
export function goldenWriteAuthRejectedReason(res: unknown): GoldenWriteAuthReason | null {
  if (!res || typeof res !== 'object') return null
  const r = res as { success?: unknown; reason?: unknown }
  if (r.success !== false) return null
  return r.reason === 'auth-missing' || r.reason === 'authentication-failed' ? r.reason : null
}

/**
 * Setup の画面を開く依頼（CCPIT_L0_004 W5）。App が受けて、Setup のナビを表示（永続の設定 showSetupNav=true）にして移る。
 * showSetupNav が元に戻るのは、Setup の完了（handleSetupCompleted）か、Recovery Kit のトグルで切ったとき。
 */
export const OPEN_SETUP_EVENT_DETAIL = { page: 'setup', showSetupNav: true } as const

export function requestOpenSetup(target: Pick<Window, 'dispatchEvent'> = window): void {
  target.dispatchEvent(new CustomEvent('ccpit:navigate', { detail: OPEN_SETUP_EVENT_DETAIL }))
}
