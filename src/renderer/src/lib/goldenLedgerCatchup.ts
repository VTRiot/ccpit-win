/**
 * 契約 CLI 台帳追補の実行ロジック (073)
 *
 * GoldenPromotionPage.tsx の handleExecuteCatchup から状態更新を deps として注入する形で
 * 切り出したもの。フレームワーク非依存にすることで、DOM/React なしに実行時テストできる。
 */

import {
  goldenWriteAuthRejectedReason,
  type GoldenWriteAuthReason,
  type GoldenWriteAuthText
} from './goldenWriteAuthText'
import { ledgerCatchupConfirmationString } from '../../../shared/ledgerCatchupConfirmation'

export interface LedgerCatchupTarget {
  sha: string
  shortSha: string
  appliedBy: string
  subject: string
  skillsAffected: string[]
}

export interface LedgerCatchupApplyResult {
  success: boolean
  commitSha?: string
  error?: string
  reason?: GoldenWriteAuthReason
}

export interface LedgerCatchupResultDialog {
  success: boolean
  title: string
  message: string
}

export interface LedgerCatchupDeps {
  digestSha256: (input: string) => Promise<string>
  now: () => Date
  applyLedgerCatchup: (
    sha: string,
    approvalContext: { approvedBy: string; approvedAt: string; confirmationHash: string }
  ) => Promise<LedgerCatchupApplyResult>
  setCatchingUp: (sha: string | null) => void
  setConfirmTarget: (target: null) => void
  clearProgress: () => void
  showResult: (dialog: LedgerCatchupResultDialog) => void
  loadDeployedSkills: () => Promise<void>
  // golden の台帳を書くのでパスワード関門を通る（CCPIT_L0_003）。password は applyLedgerCatchup の呼び出し側が渡す
  authText: GoldenWriteAuthText
  clearPassword: () => void
}

export async function executeLedgerCatchup(
  target: LedgerCatchupTarget,
  deps: LedgerCatchupDeps
): Promise<void> {
  deps.setCatchingUp(target.sha)
  try {
    // 主処理が同じ関数で組み直して照合する（CCPIT_L0_004 W4）
    const summaryString = ledgerCatchupConfirmationString(target)
    let confirmationHash: string
    try {
      confirmationHash = await deps.digestSha256(summaryString)
    } catch (err) {
      // fail-closed: ハッシュ計算に失敗した場合は偽装ハッシュで強行せず、即座に中断してエラー通知 (Codex C-3 指摘)
      deps.showResult({
        success: false,
        title: '承認ハッシュ計算エラー',
        message: `承認確認ダイアログの SHA-256 ハッシュ生成に失敗しました: ${String(err)}。台帳追補を中断します。`
      })
      deps.setConfirmTarget(null)
      deps.setCatchingUp(null)
      return
    }

    const approvalContext = {
      approvedBy: 'maintainer（CCPIT GUI 承認モーダル）',
      approvedAt: deps.now().toISOString(),
      confirmationHash
    }

    const res = await deps.applyLedgerCatchup(target.sha, approvalContext)
    deps.setConfirmTarget(null)

    const authReason = goldenWriteAuthRejectedReason(res)
    if (authReason) {
      deps.showResult({
        success: false,
        title: deps.authText.rejectedTitle,
        message: deps.authText.rejectedMessage(authReason)
      })
    } else if (res.success) {
      deps.showResult({
        success: true,
        title: '台帳追補完了',
        message: `コミット ${target.shortSha} の台帳追補パッチを適用しました (適用コミット: ${res.commitSha?.slice(0, 8) || 'N/A'})。`
      })
      await deps.loadDeployedSkills()
    } else {
      deps.showResult({
        success: false,
        title: '台帳追補失敗',
        message: res.error || '台帳追補の適用に失敗しました。'
      })
    }
  } catch (err) {
    deps.setConfirmTarget(null)
    deps.showResult({
      success: false,
      title: '台帳追補エラー',
      message: String(err)
    })
  } finally {
    deps.clearPassword()
    deps.setCatchingUp(null)
    deps.clearProgress()
  }
}
