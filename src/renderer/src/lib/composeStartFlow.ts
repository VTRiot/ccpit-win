/**
 * 「まとめて合成」を押してからダイアログを閉じるまでの手順（CCPIT_L0_012 W1 状態 1）。
 * 押した瞬間に「準備中」を立て、IPC の復帰 → 状態の取り直し（カードに「起動待ち」が出る）→ ダイアログを閉じる、の順で進め、
 * 最後に「準備中」を下ろす。ダイアログを閉じる前にカードの状態を取り直すので、押した場所から文が消えて何も出ていない間が無い。
 * React に依存しない純粋な段取りにして、順番を試験で固定する（画面はページがこれを呼ぶだけ）。
 */

/** 状態 1「準備中」の文（誰が＝CCPIT／何を＝作業場を作っている／あなたは＝待つ） */
export function composeStartingText(ja: boolean): string {
  return ja
    ? '準備中：CCPIT が合成の作業場を作っています。数秒で Claude Code を起動します。このまま待ってください。'
    : 'Preparing: CCPIT is creating the composition workspace and will start Claude Code in a few seconds. Please wait.'
}

export interface ComposeStartFlowDeps<R extends { ok: boolean }> {
  /** 「準備中」の表示を立てる・下ろす */
  setStarting: (on: boolean) => void
  /** 合成の開始の IPC */
  start: () => Promise<R>
  /** 合成の状態の取り直し（カードの表示の材料） */
  refresh: () => Promise<void>
  /** 選択ダイアログを閉じる */
  closePicker: () => void
  onOk: (r: R) => void
  onError: (r: R | { ok: false; thrown: unknown }) => void
}

export async function runComposeStart<R extends { ok: boolean }>(
  d: ComposeStartFlowDeps<R>
): Promise<void> {
  d.setStarting(true)
  try {
    const r = await d.start()
    if (r.ok) {
      await d.refresh()
      d.closePicker()
      d.onOk(r)
    } else {
      d.onError(r)
    }
  } catch (thrown) {
    d.onError({ ok: false, thrown })
  } finally {
    d.setStarting(false)
  }
}
