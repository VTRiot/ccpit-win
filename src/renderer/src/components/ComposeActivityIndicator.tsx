import * as React from 'react'
import { Loader2 } from 'lucide-react'
import { composeStartingText } from '../lib/composeStartFlow'

/**
 * 合成の「いま動いている」ことを、押したボタンの場所に出す小さな部品（CCPIT_L0_012 W1）。
 * 動きは画面に既にある 2 種類だけを使う: 回転（ProjectDiscoveryDialog の Loader2 + animate-spin）と、
 * 鼓動（StatusBar の BG-CC と同じ bg-amber-400 animate-pulse の点）。新しい意匠は足さない。
 */

/** 回転（待っている）と鼓動（相手が作業中）。kind が null なら何も出さない */
export function ComposeActivityIndicator({
  kind
}: {
  kind: 'spin' | 'pulse' | null
}): React.JSX.Element | null {
  if (kind === 'spin')
    return (
      <Loader2
        size={13}
        className="inline-block shrink-0 animate-spin text-muted-foreground"
        data-testid="compose-activity"
        data-activity="spin"
        aria-hidden="true"
      />
    )
  if (kind === 'pulse')
    return (
      <span
        className="inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-amber-400 animate-pulse"
        data-testid="compose-activity"
        data-activity="pulse"
        aria-hidden="true"
      />
    )
  return null
}

/** 状態 1「準備中」（選択ダイアログの「まとめて合成」の傍。押下から IPC の復帰と取り直しまで出す） */
export function ComposeStartingNotice({ ja }: { ja: boolean }): React.JSX.Element {
  return (
    <span
      className="mr-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground"
      data-testid="compose-starting"
      role="status"
    >
      <ComposeActivityIndicator kind="spin" />
      <span>{composeStartingText(ja)}</span>
    </span>
  )
}
