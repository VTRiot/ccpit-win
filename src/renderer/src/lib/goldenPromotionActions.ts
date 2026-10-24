/**
 * 昇格・撤去・復帰の実行ロジック (074)
 *
 * GoldenPromotionPage.tsx の handleApplyPromotion / handleWithdrawSkill / handleRestoreSkill から
 * 状態更新を deps として注入する形で切り出したもの。goldenLedgerCatchup.ts (073) と同じ設計を踏襲し、
 * フレームワーク非依存にすることで DOM/React なしに実行時テストできる。
 *
 * 台帳追補 (catchingUpSha) の実行中は、進捗表示 (progressInfo) を共有する台帳追補と互いの進捗を
 * 消し合わないよう、3関数とも本体全体を isLedgerCatchupInProgress で防御する (073 の逆方向)。
 */

import {
  goldenWriteAuthRejectedReason,
  type GoldenWriteAuthReason,
  type GoldenWriteAuthText
} from './goldenWriteAuthText'

export function isLedgerCatchupInProgress(catchingUpSha: string | null): boolean {
  return catchingUpSha !== null
}

/**
 * golden を書き換える操作のパスワード関門（CCPIT_L0_003）。主処理が拒否したら、何も書いていないことと次の手を出す。
 * 入力したパスワードは、成否にかかわらず 1 回ごとに消す（clearPassword）。
 */
export interface GoldenWriteAuthDeps {
  authText: GoldenWriteAuthText
  clearPassword: () => void
}

function showAuthRejected(
  reason: GoldenWriteAuthReason,
  deps: GoldenWriteAuthDeps & { showResult: (dialog: GoldenActionResultDialog) => void }
): void {
  deps.showResult({
    open: true,
    success: false,
    title: deps.authText.rejectedTitle,
    message: deps.authText.rejectedMessage(reason)
  })
}

export interface GoldenActionProgress {
  runId: string
  stepIndex: number
  totalSteps: number
  stepName: string
  timestamp: string
  startedAtMs: number
  lastUpdatedAtMs: number
}

export interface GoldenActionResultDialog {
  open: true
  success: boolean
  title: string
  message: string
  details?: string
}

function startingProgress(nowMs: number): GoldenActionProgress {
  return {
    runId: 'starting...',
    stepIndex: 1,
    totalSteps: 11,
    stepName: 'init-check',
    timestamp: new Date(nowMs).toISOString(),
    startedAtMs: nowMs,
    lastUpdatedAtMs: nowMs
  }
}

// ────────────────────────────────────────────────────────────
// 昇格 (handleApplyPromotion)
// ────────────────────────────────────────────────────────────

export interface GoldenPromotionApplyResult {
  success: boolean
  commitSha?: string
  error?: string
  runnerLog?: string
  reason?: GoldenWriteAuthReason
}

export interface GoldenPromotionApplyDeps extends GoldenWriteAuthDeps {
  catchingUpSha: string | null
  now: () => number
  setApplying: (v: boolean) => void
  setConfirmOpen: (v: boolean) => void
  setProgressInfo: (v: GoldenActionProgress | null) => void
  applyPromotion: (ids: string[]) => Promise<GoldenPromotionApplyResult>
  setCheckedIds: (v: Set<string>) => void
  showResult: (dialog: GoldenActionResultDialog) => void
  loadCandidates: () => Promise<void>
  loadDeployedSkills: () => Promise<void>
  loadLeaseStatus: () => Promise<void>
  t: (key: string, options?: Record<string, unknown>) => string
}

export async function executeGoldenPromotionApply(
  ids: string[],
  deps: GoldenPromotionApplyDeps
): Promise<void> {
  if (ids.length === 0) return
  if (isLedgerCatchupInProgress(deps.catchingUpSha)) return

  deps.setApplying(true)
  deps.setConfirmOpen(false)
  deps.setProgressInfo(startingProgress(deps.now()))

  try {
    const result = await deps.applyPromotion(ids)
    const authReason = goldenWriteAuthRejectedReason(result)
    if (authReason) {
      // 何も書いていない。選んだ対象は残し、パスワードを入れ直して再実行できるようにする
      showAuthRejected(authReason, deps)
      return
    }
    if (result.success) {
      deps.setCheckedIds(new Set())
      deps.showResult({
        open: true,
        success: true,
        title: deps.t('goldenPromotion.applySuccessTitle'),
        message: deps.t('goldenPromotion.applySuccessMessage', {
          sha: result.commitSha ? result.commitSha.slice(0, 8) : 'unknown'
        }),
        details: result.runnerLog
      })
    } else {
      deps.showResult({
        open: true,
        success: false,
        title: deps.t('goldenPromotion.applyErrorTitle'),
        message: result.error || '不明なエラーが発生しました。',
        details: result.runnerLog
      })
    }
    await deps.loadCandidates()
    await deps.loadDeployedSkills()
  } catch (err) {
    deps.showResult({
      open: true,
      success: false,
      title: deps.t('goldenPromotion.applyErrorTitle'),
      message: err instanceof Error ? err.message : String(err)
    })
  } finally {
    deps.clearPassword()
    deps.setApplying(false)
    deps.setProgressInfo(null)
    void deps.loadLeaseStatus()
  }
}

// ────────────────────────────────────────────────────────────
// 撤去 (handleWithdrawSkill) / 復帰 (handleRestoreSkill) 共通の形
// ────────────────────────────────────────────────────────────

export interface GoldenWithdrawRestoreResult {
  success: boolean
  error?: string
  reason?: GoldenWriteAuthReason
}

export interface GoldenSkillRef {
  name: string
  title: string
}

export interface GoldenWithdrawDeps extends GoldenWriteAuthDeps {
  catchingUpSha: string | null
  now: () => number
  setWithdrawTarget: (v: null) => void
  setApplying: (v: boolean) => void
  setProgressInfo: (v: GoldenActionProgress | null) => void
  withdraw: (name: string) => Promise<GoldenWithdrawRestoreResult>
  setBulkActionResult: (v: { message: string; type: 'success' | 'info' }) => void
  showResult: (dialog: Omit<GoldenActionResultDialog, 'details'>) => void
  loadDeployedSkills: () => Promise<void>
  loadCandidates: () => Promise<void>
  loadLeaseStatus: () => Promise<void>
  t: (key: string, options?: Record<string, unknown>) => string
}

export async function executeGoldenWithdraw(
  skill: GoldenSkillRef,
  deps: GoldenWithdrawDeps
): Promise<void> {
  if (isLedgerCatchupInProgress(deps.catchingUpSha)) return
  deps.setWithdrawTarget(null)

  deps.setApplying(true)
  deps.setProgressInfo(startingProgress(deps.now()))

  try {
    const res = await deps.withdraw(skill.name)
    const authReason = goldenWriteAuthRejectedReason(res)
    if (authReason) {
      showAuthRejected(authReason, deps)
      return
    }
    if (res.success) {
      deps.setBulkActionResult({
        message: deps.t('goldenPromotion.withdrawSuccess', { name: skill.title }),
        type: 'success'
      })
      await deps.loadDeployedSkills()
      await deps.loadCandidates()
    } else {
      deps.showResult({
        open: true,
        success: false,
        title: '撤去失敗',
        message: res.error || '不明なエラーが発生しました。'
      })
    }
  } catch (err) {
    deps.showResult({
      open: true,
      success: false,
      title: '撤去失敗',
      message: err instanceof Error ? err.message : String(err)
    })
  } finally {
    deps.clearPassword()
    deps.setApplying(false)
    deps.setProgressInfo(null)
    void deps.loadLeaseStatus()
  }
}

export interface GoldenRestoreDeps extends GoldenWriteAuthDeps {
  catchingUpSha: string | null
  now: () => number
  setRestoreTarget: (v: null) => void
  setApplying: (v: boolean) => void
  setProgressInfo: (v: GoldenActionProgress | null) => void
  restore: (name: string) => Promise<GoldenWithdrawRestoreResult>
  setBulkActionResult: (v: { message: string; type: 'success' | 'info' }) => void
  showResult: (dialog: Omit<GoldenActionResultDialog, 'details'>) => void
  loadDeployedSkills: () => Promise<void>
  loadCandidates: () => Promise<void>
  loadLeaseStatus: () => Promise<void>
  t: (key: string, options?: Record<string, unknown>) => string
}

export async function executeGoldenRestore(
  skill: GoldenSkillRef,
  deps: GoldenRestoreDeps
): Promise<void> {
  if (isLedgerCatchupInProgress(deps.catchingUpSha)) return
  deps.setRestoreTarget(null)

  deps.setApplying(true)
  deps.setProgressInfo(startingProgress(deps.now()))

  try {
    const res = await deps.restore(skill.name)
    const authReason = goldenWriteAuthRejectedReason(res)
    if (authReason) {
      showAuthRejected(authReason, deps)
      return
    }
    if (res.success) {
      deps.setBulkActionResult({
        message: deps.t('goldenPromotion.restoreSuccess', { name: skill.title }),
        type: 'success'
      })
      await deps.loadDeployedSkills()
      await deps.loadCandidates()
    } else {
      deps.showResult({
        open: true,
        success: false,
        title: '復帰失敗',
        message: res.error || '不明なエラーが発生しました。'
      })
    }
  } catch (err) {
    deps.showResult({
      open: true,
      success: false,
      title: '復帰失敗',
      message: err instanceof Error ? err.message : String(err)
    })
  } finally {
    deps.clearPassword()
    deps.setApplying(false)
    deps.setProgressInfo(null)
    void deps.loadLeaseStatus()
  }
}
