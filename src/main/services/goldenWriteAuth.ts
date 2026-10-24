/**
 * Golden 昇格ブラウザで golden（配布物）・その台帳・手元の配布先・golden の repo の ref を書き換える操作の関門（CCPIT_L0_003）。
 *
 * - 検証は既存の「採用 (Apply)」と同じ仕組み（settings.json の auth.password・verifyPassword）をそのまま使う。
 *   新しい保存先・設定・トークンは作らない。主処理は認証の状態を持たず、パスワードは呼び出しごとに検証する
 *   （= 1 回の入力は、その呼び出しで渡した対象にだけ効く。別の対象・別の操作へ使い回せない）。
 * - パスワード未登録は拒否する。「採用」の kind:skill と同じ扱い（verifyPassword の kind に 'skill' を渡す）。
 * - 平文は戻り値・ログのどこにも含めない。
 */
import {
  getDefaultSettingsPaths,
  hasPasswordRegistered,
  verifyPassword,
  type SettingsPaths
} from './settingsChange'

export type GoldenWriteAuthReason = 'auth-missing' | 'authentication-failed'

export type GoldenWriteAuthResult = { ok: true } | { ok: false; reason: GoldenWriteAuthReason }

/** パスワードを要求する IPC チャネル（全数調査の結果。理由は報告書の一覧表） */
export const GOLDEN_WRITE_AUTH_CHANNELS = [
  'goldenPromotion:apply',
  'goldenPromotion:withdraw',
  'goldenPromotion:restore',
  'goldenPromotion:rollback',
  'goldenPromotion:applyLedgerCatchup',
  'goldenPromotion:releaseExpiredLease',
  'goldenPromotion:releaseEarlyLease',
  'goldenPromotion:cleanupArtifacts'
] as const

export async function checkGoldenWriteAuth(
  password: unknown,
  paths: SettingsPaths = getDefaultSettingsPaths()
): Promise<GoldenWriteAuthResult> {
  if (!(await hasPasswordRegistered(paths))) return { ok: false, reason: 'auth-missing' }
  if (typeof password !== 'string' || password.length === 0) {
    return { ok: false, reason: 'authentication-failed' }
  }
  return (await verifyPassword(password, paths, 'skill'))
    ? { ok: true }
    : { ok: false, reason: 'authentication-failed' }
}

/** 拒否のときに IPC が返す値の共通部分。画面はこの reason で文言を決める */
export function goldenWriteAuthRejection(reason: GoldenWriteAuthReason): {
  success: false
  reason: GoldenWriteAuthReason
  error: string
} {
  return {
    success: false,
    reason,
    error:
      reason === 'auth-missing'
        ? '認証パスワードが未登録のため、golden を書き換える操作は実行しませんでした（何も書き換えていません）。'
        : 'パスワードが違うか未入力のため、golden を書き換える操作は実行しませんでした（何も書き換えていません）。'
  }
}
