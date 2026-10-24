/**
 * 昇格の完了・失敗のダイアログの「実行ログ / 詳細」を、クリップボードへ写す（CCPIT_L0_004 W7）。
 *
 * 写すのは、画面に出した全文そのもの（`@@PX` の進捗の行も含め、手を加えない）。
 * 書込みは preload の clipboardWrite（主処理の clipboard.writeText）を通す。自動の確かめは、この関数へ渡された
 * 文字列を、画面の中で差し替えた clipboardWrite で受け取って照合する（OS のクリップボードには触れない）。
 */

/** 「写しました」の表示を戻すまでの時間。BgccActivityPanel のコピーと同じ値に揃える */
export const RUNNER_LOG_COPIED_FEEDBACK_MS = 1500

export function buildRunnerLogCopyText(details: string): string {
  return details
}

export async function copyRunnerLog(
  details: string,
  write: (text: string) => Promise<void> = (text) => window.api.clipboardWrite(text)
): Promise<boolean> {
  try {
    await write(buildRunnerLogCopyText(details))
    return true
  } catch {
    return false
  }
}
