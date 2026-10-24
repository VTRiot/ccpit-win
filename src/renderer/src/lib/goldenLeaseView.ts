/**
 * Golden 昇格ブラウザの「リース診断」「承認画面の差分欄」の表示の純関数（CCPIT_L0_014 P1・P2・P4）。
 *
 * git が返事をしなかったとき、画面が「アクティブなリースはありません (正常)」「残り約 0 分」「孤立した worktree は検出されませんでした」
 * 「差分なし」と、事実と違うことを言わないための判定。レンダラーにコンポーネントを描く基盤が無いので、ページの式を純関数に切り出して
 * 試験する（実画面の確認は隔離起動で別に行う）。main 側の型には依存しない（構造だけを見る）。
 */

export interface LeaseViewInput {
  exists: boolean
  /** リース・blob・master を git から読めなかった理由。健全時はキーごと無い */
  readError?: string
  /** 残置 worktree の一覧を git から読めなかった理由。健全時はキーごと無い */
  worktreeReadError?: string
  isExpired?: boolean
  remainingSeconds?: number
}

export type LeaseSummaryKind = 'read-error' | 'active' | 'none'

/**
 * 診断モーダルの要約カードの種類。
 * - active: リースがある（読めなかった項目があれば、警告帯を併せて出す）
 * - read-error: リースが無いのではなく、確かめられなかった（「正常」と言わない）
 * - none: 読めた上で、リースが無い（または未取得）＝従来の「アクティブなリースはありません (正常)」
 */
export function leaseSummaryKind(s: LeaseViewInput | null | undefined): LeaseSummaryKind {
  if (!s) return 'none'
  if (s.exists) return 'active'
  if (s.readError) return 'read-error'
  return 'none'
}

export interface LeaseReadWarning {
  key: 'lease' | 'worktree'
  label: string
  message: string
}

/** 警告帯に出す、git から読めなかった項目（健全時は空） */
export function leaseReadWarnings(s: LeaseViewInput | null | undefined): LeaseReadWarning[] {
  const out: LeaseReadWarning[] = []
  if (s?.readError) out.push({ key: 'lease', label: 'リース・master の状態', message: s.readError })
  if (s?.worktreeReadError) out.push({ key: 'worktree', label: '残置 worktree の一覧', message: s.worktreeReadError })
  return out
}

export type LeaseExpiryView = { kind: 'expired' } | { kind: 'valid'; minutes: number } | { kind: 'unknown' }

/**
 * 期限の表示。失効の判定が無い（blob を読めない・解析できない・期限が不正）ときは、「残り約 0 分」と言わず unknown。
 * 有効期限内の分は従来どおり floor（負は 0）。
 */
export function leaseExpiryView(s: LeaseViewInput): LeaseExpiryView {
  if (s.isExpired === true) return { kind: 'expired' }
  if (s.isExpired === false) return { kind: 'valid', minutes: Math.max(0, Math.floor((s.remainingSeconds || 0) / 60)) }
  return { kind: 'unknown' }
}

/**
 * 差分を取得できなかった理由の表示用の文。electron の IPC は主処理の例外を
 * `Error invoking remote method '<チャンネル>': Error: <メッセージ>` として渡すので、前置きを除く。
 */
export function diffErrorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  if (!raw) return '不明なエラー'
  return raw.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^(?:[A-Za-z]*Error):\s*/, '')
}
