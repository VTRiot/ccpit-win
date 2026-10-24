/**
 * 契約 L リースの早期解放の確認ダイアログ本文（CCPIT_L0_014 P1・U2）。
 *
 * IPC `goldenPromotion:releaseEarlyLease`（ipc.ts）が直に組んでいた本文を、electron（ipcMain・dialog）に依存しない純関数に
 * 切り出した。IPC は単体で呼べず本文を試験できなかったため。文面は切り出し前と一字一句同じ（試験が旧の式の写しと比べる）。
 */

import type { GoldenLeaseStatus } from './goldenPromotion'

export interface EarlyReleaseDialogInput {
  /** 画面が表示していたリースの ID */
  expectedLeaseId: string
  /** 直前に読んだリースの状態（実行記録・blob の base_master を使う） */
  status: Pick<GoldenLeaseStatus, 'matchingRunRecord' | 'blob'>
  /** 早期解放資格の判定結果（実行記録が見つからないときの PID・Run ID の代わり） */
  entitlement: { runningPid?: number; runningRunId?: string }
}

export function buildEarlyReleaseDialogMessage(input: EarlyReleaseDialogInput): string {
  const { expectedLeaseId, status, entitlement } = input
  const targetRecord = status.matchingRunRecord
  const pid = targetRecord?.pid ?? entitlement.runningPid ?? '不明'
  const runId = targetRecord?.runId ?? entitlement.runningRunId ?? '不明'

  let evidenceText = 'CCPIT 管理記録による終了確認済み + OS プロセス不在確認済み'
  if (targetRecord?.exitCode !== undefined) {
    evidenceText = `正常終了記録 (exit code: ${targetRecord.exitCode}) + OS プロセス不在確認済み`
  } else if (targetRecord?.endedAtSource === 'ccpit-crash-recovery') {
    evidenceText = `CCPIT クラッシュ復旧認定 (${targetRecord.endedAtNote || targetRecord.endedAt}) + OS プロセス不在確認済み`
  } else if (targetRecord?.endedAt) {
    evidenceText = `終了記録あり (endedAt: ${targetRecord.endedAt}) + OS プロセス不在確認済み`
  }

  const baseMasterText = status.blob?.base_master
    ? `${status.blob.base_master.slice(0, 8)}... (現在の master と一致)`
    : '検証済み'

  return [
    '契約 L の通常失効（6 時間）を待たず、所有者プロセスの終了・死亡確認に基づいてリースを早期解放します。',
    '',
    '【確認された終了・死亡根拠 (追補条項 L-b)】',
    `・対象 Lease ID: ${expectedLeaseId}`,
    `・所有者 PID: ${pid} (OS プロセス不在を確認済み)`,
    `・CCPIT 実行 Run ID: ${runId}`,
    `・終了判定根拠: ${evidenceText}`,
    `・base_master: ${baseMasterText}`,
    '',
    'この操作は取り消せません。maintainer（承認者）としてこの 1 回の早期解放を個別に承認しますか？'
  ].join('\n')
}
