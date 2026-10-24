import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  RefreshCw,
  Check,
  X,
  AlertTriangle,
  Award,
  Filter,
  CheckCircle2,
  FileCode,
  Layers,
  HelpCircle,
  RotateCcw,
  FileText,
  Archive,
  Search,
  Lock,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Activity,
  AlertCircle,
  Copy
} from 'lucide-react'
import { copyRunnerLog, RUNNER_LOG_COPIED_FEEDBACK_MS } from '../lib/goldenRunnerLogCopy'
import { Button } from '../components/ui/button'
import { Checkbox } from '../components/ui/checkbox'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '../components/ui/tooltip'
import { cn } from '../lib/utils'

type PromotionCandidate = Awaited<ReturnType<typeof window.api.goldenPromotionList>>[number]
type PromotionState = PromotionCandidate['state']

type GoldenDeployedSkill = Awaited<
  ReturnType<typeof window.api.goldenPromotionListDeployed>
>[number]

import { toNorm, toCompact } from '../lib/searchUtils'
import { executeLedgerCatchup } from '../lib/goldenLedgerCatchup'
import { findPreselected, takePromotionPreselect } from '../lib/composeNavigation'
import {
  executeGoldenPromotionApply,
  executeGoldenWithdraw,
  executeGoldenRestore
} from '../lib/goldenPromotionActions'
import { goldenRollbackText } from '../lib/goldenRollbackText'
import { diffErrorText, leaseExpiryView, leaseReadWarnings, leaseSummaryKind } from '../lib/goldenLeaseView'
import {
  goldenWriteAuthText,
  goldenWriteAuthRejectedReason,
  goldenWriteBlocker,
  canRunGoldenWrite,
  requestOpenSetup,
  type GoldenWriteAuthText
} from '../lib/goldenWriteAuthText'
import { resolveConflictPeers, conflictCountOf } from '../lib/proposalConflictGuidance'
import {
  applicableIds,
  blockedRowGuidance,
  bulkSelectableCandidates,
  composeHoldOf
} from '../lib/promotionBlockedRow'
import {
  PromotionRowCheckCell,
  PromotionRowHoldBadge,
  PromotionRowHoldLine
} from '../components/PromotionRowCells'

const STEP_NAME_LABELS: Record<string, string> = {
  'init-check': '初期状態検査 (init-check)',
  'verify-approval': '承認根拠・報告書検証 (verify-approval)',
  'verify-manifest': 'MANIFEST ハッシュ照合 (verify-manifest)',
  'acquire-lease': '契約 L リース取得 (acquire-lease)',
  'verify-base': '基底 master・対象ファイル事前照合 (verify-base)',
  'create-worktree': '隔離 worktree 作成 (create-worktree)',
  'apply-patches': 'パッチ適用・差分検査 (apply-patches)',
  'verify-post': '事後照合・内蔵 selftest (verify-post)',
  'commit-cas': '記名コミット・契約 6 CAS (commit-cas)',
  'sync-main': '主 worktree 同期 (sync-main)',
  'cleanup-release': '隔離環境清掃・リース解放 (cleanup-release)',
}

/** 分岐の行の詳細ペインの案内。候補の種類（手元・提案）で見出しと本文が変わる（lib/promotionBlockedRow.ts）。 */
function DivergedGuidanceCard({ item }: { item: PromotionCandidate }): React.JSX.Element | null {
  const { t } = useTranslation()
  const guidance = blockedRowGuidance(item)
  if (!guidance?.paneTitleKey || !guidance.paneBodyKey) return null
  return (
    <div className="pt-3 space-y-2">
      <div className="p-3 rounded bg-red-500/10 border border-red-500/30 text-xs space-y-2">
        <div className="font-semibold text-red-600 dark:text-red-400 flex items-center gap-1.5">
          <span>{t(guidance.paneTitleKey)}</span>
        </div>
        <p className="text-muted-foreground text-[11px] leading-relaxed">
          {t(guidance.paneBodyKey)}
        </p>
      </div>
    </div>
  )
}

/**
 * 合成提案が握っている行（取り込み済みの元提案・合成の元に選ばれなかった提案）の詳細ペインの案内。
 * 異常（合成提案の MD が無い・台帳が registered のまま adopted）のときは、通常の却下が届かないので「合成を破棄」を出す。
 */
function ComposeHoldGuidanceCard({
  item,
  discardArmed,
  onDiscard
}: {
  item: PromotionCandidate
  discardArmed: boolean
  onDiscard: (compositeId: string) => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const hold = composeHoldOf(item)
  const guidance = blockedRowGuidance(item)
  if (!hold || !guidance?.paneTitleKey || !guidance.paneBodyKey) return null
  const abnormal = item.composeHoldAbnormal
  return (
    <div className="pt-3 space-y-2" data-testid="compose-hold-card">
      <div className="p-3 rounded bg-violet-500/10 border border-violet-500/30 text-xs space-y-2">
        <div className="font-semibold text-violet-700 dark:text-violet-300">
          {t(guidance.paneTitleKey, { composite: hold.compositeId })}
        </div>
        <p className="text-muted-foreground text-[11px] leading-relaxed">
          {t(guidance.paneBodyKey, { composite: hold.compositeId })}
        </p>
        {abnormal && (
          <div className="space-y-1.5">
            <p className="text-[11px] text-amber-600 dark:text-amber-400">
              {t(
                abnormal === 'missing'
                  ? 'goldenPromotion.holdAbnormalMissing'
                  : abnormal === 'changed'
                    ? 'goldenPromotion.holdAbnormalChanged'
                    : 'goldenPromotion.holdAbnormalAdopted',
                { composite: hold.compositeId }
              )}
            </p>
            <Button
              size="sm"
              variant="outline"
              className={discardArmed ? 'border-red-500/70 text-red-500' : undefined}
              onClick={() => onDiscard(hold.compositeId)}
            >
              {discardArmed ? t('goldenPromotion.composeDiscardConfirm') : t('goldenPromotion.composeDiscardButton')}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * golden を書き換える操作のパスワード欄（CCPIT_L0_003）。「採用 (Apply)」の入力欄と同じ見た目。
 * 未登録なら入力欄の代わりに登録の案内を出す（押す前に止める）。未入力なら押せない理由を出す。
 */
function GoldenWritePasswordField({
  hasPassword,
  password,
  onChange,
  text,
  disabled
}: {
  hasPassword: boolean
  password: string
  onChange: (v: string) => void
  text: GoldenWriteAuthText
  disabled?: boolean
}): React.JSX.Element {
  const blocker = goldenWriteBlocker(hasPassword, password, text)
  return (
    <div className="space-y-1" data-golden-write-password>
      {hasPassword && (
        <input
          type="password"
          value={password}
          onChange={(e) => onChange(e.target.value)}
          placeholder={text.placeholder}
          disabled={disabled}
          autoComplete="off"
          className="px-2 py-1 text-sm border border-border rounded bg-background w-40"
        />
      )}
      {blocker && (
        <p
          className={cn(
            'text-[11px] leading-relaxed',
            hasPassword ? 'text-muted-foreground' : 'text-amber-700 dark:text-amber-300'
          )}
        >
          {blocker}
        </p>
      )}
      {!hasPassword && (
        // 未登録の案内から、パスワードの登録（Setup）へ 1 回で移る（CCPIT_L0_004 W5）
        <div className="flex items-center gap-2 pt-0.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-golden-open-setup
            className="h-6 text-[11px] px-2"
            onClick={() => requestOpenSetup()}
          >
            {text.openSetupLabel}
          </Button>
          <span className="text-[10px] text-muted-foreground leading-snug">{text.openSetupNote}</span>
        </div>
      )}
    </div>
  )
}

export function GoldenPromotionPage(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const [rollbackConfirmId, setRollbackConfirmId] = useState<string | null>(null) // T10 戻しの 2 回押し確認

  // golden を書き換える操作のパスワード（CCPIT_L0_003）。検証は主処理。1 回の操作ごとに消す
  const authText = goldenWriteAuthText(i18n.language.startsWith('ja'))
  const [hasPassword, setHasPassword] = useState(false)
  const [writePassword, setWritePassword] = useState('')
  const canWrite = canRunGoldenWrite(hasPassword, writePassword)
  const clearPassword = useCallback(() => setWritePassword(''), [])
  useEffect(() => {
    window.api
      .settingsHasPassword()
      .then(setHasPassword)
      .catch(() => setHasPassword(false))
  }, [])

  // タブ状態: 'queue' (昇格待ち列) | 'deployed' (Golden 配布中)
  const [activeTab, setActiveTab] = useState<'queue' | 'deployed'>('queue')

  // 昇格待ち列データ
  const [candidates, setCandidates] = useState<PromotionCandidate[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  // 一覧の取得が何回終わったか（自動の確かめ・待ち時間の計測が「列の表示完了」を判定する印。CCPIT_L0_004）
  const [candidatesLoadSeq, setCandidatesLoadSeq] = useState(0)
  const [applying, setApplying] = useState(false)

  // 契約 L リース状態 (What 1, C-1)
  const [leaseStatus, setLeaseStatus] = useState<
    Awaited<ReturnType<typeof window.api.goldenPromotionGetLeaseStatus>> | null
  >(null)
  const [loadingLeaseStatus, setLoadingLeaseStatus] = useState(false)
  const [leaseModalOpen, setLeaseModalOpen] = useState(false)
  const [releasingLease, setReleasingLease] = useState(false)
  const [cleaningArtifacts, setCleaningArtifacts] = useState(false)

  // 昇格進捗イベント・段階表示 (R-1, C-11)
  const [progressInfo, setProgressInfo] = useState<{
    runId: string
    stepIndex: number
    totalSteps: number
    stepName: string
    timestamp: string
    leaseId?: string
    startedAtMs: number
    lastUpdatedAtMs: number
  } | null>(null)
  const [nowMs, setNowMs] = useState(Date.now())

  // 検索・並べ替え状態 (H-4, J-5)
  const [searchQuery, setSearchQuery] = useState('')
  const [sortOrder, setSortOrder] = useState<
    'date-desc' | 'date-asc' | 'title-asc' | 'title-desc' | 'path-asc' | 'path-desc' | 'name-asc' | 'name-desc'
  >('date-desc')

  // Golden 配布中データ (G-1, G-2)
  const [deployedSkills, setDeployedSkills] = useState<GoldenDeployedSkill[]>([])
  const [selectedDeployedName, setSelectedDeployedName] = useState<string | null>(null)
  const [loadingDeployed, setLoadingDeployed] = useState(false)

  // 契約 CLI 台帳ドリフト状態 (W3 / Codex MAJOR 2 指摘反映)
  const [ledgerDrift, setLedgerDrift] = useState<{
    hasDrift: boolean
    unrecordedCommits: Array<{
      sha: string
      shortSha: string
      appliedBy: string
      subject: string
      skillsAffected: string[]
    }>
    ledgerStatus?: 'ok' | 'not-found' | 'corrupt'
    ledgerError?: string
    /** 履歴（git log・diff-tree）を読めず、ずれの検出が完了しなかった理由。あるときの hasDrift:false は「ずれ無し」ではない */
    gitScanError?: string
  } | null>(null)
  // 一覧の検出が完了したかの診断（CCPIT_L0_010）。null＝未取得、'unavailable'＝診断の取得自体が失敗した（確認できなかった）
  const [scanDiagnostics, setScanDiagnostics] = useState<
    { rescueScanError?: string } | 'unavailable' | null
  >(null)
  const [catchingUpSha, setCatchingUpSha] = useState<string | null>(null)
  const [catchupConfirmTarget, setCatchupConfirmTarget] = useState<{
    sha: string
    shortSha: string
    appliedBy: string
    subject: string
    skillsAffected: string[]
  } | null>(null)

  // 台帳破損状態の検知 (Z-4)
  const isLedgerCorrupt = useMemo(() => {
    return ledgerDrift?.ledgerStatus === 'corrupt' || (deployedSkills as any)?.ledgerCorrupt === true
  }, [ledgerDrift, deployedSkills])

  // 未記録コミットの古い順（昇順）並べ替え (Z-3 (5))
  const sortedUnrecordedCommits = useMemo(() => {
    if (!ledgerDrift?.unrecordedCommits) return []
    return [...ledgerDrift.unrecordedCommits].reverse()
  }, [ledgerDrift])

  // フィルタ状態 (F-5: 既定は recommend＝おすすめ/優先)
  const [filterType, setFilterType] = useState<'recommend' | 'all' | 'rescue' | 'adopted'>(
    'recommend'
  )
  const [stateFilter, setStateFilter] = useState<'all' | PromotionState>('all')

  // モーダル状態
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [legendOpen, setLegendOpen] = useState(false) // F-4 凡例モーダル
  const [fullContentModal, setFullContentModal] = useState<{
    title: string
    content: string
  } | null>(null) // F-3, G-1 全文モーダル
  const [withdrawTarget, setWithdrawTarget] = useState<GoldenDeployedSkill | null>(null) // G-2 撤去確認
  const [restoreTarget, setRestoreTarget] = useState<GoldenDeployedSkill | null>(null) // G-2 復帰確認

  // 結果メッセージ・ダイアログ
  // 実行ログをクリップボードへ写した直後の表示（CCPIT_L0_004 W7）
  const [runnerLogCopied, setRunnerLogCopied] = useState(false)
  const [resultDialog, setResultDialog] = useState<{
    open: boolean
    success: boolean
    title: string
    message: string
    details?: string
  } | null>(null)

  // 一括操作インラインフィードバック (L-1, F-1, F-3)
  const [bulkActionResult, setBulkActionResult] = useState<{
    message: string
    type: 'success' | 'info' | 'warning'
  } | null>(null)

  // 競合の相手を却下する 2 回押しの確認（1 回目で「本当に却下する」に変え、2 回目で確定）。押した提案の候補 id
  const [rejectArmedId, setRejectArmedId] = useState<string | null>(null)
  // 合成の破棄（握りの解除口）の 2 回押し確認。押した合成提案の ID を覚える
  const [discardArmedId, setDiscardArmedId] = useState<string | null>(null)

  // 6秒後に自動消滅するタイマー (L-1, F-3)。警告（押せない理由）は読み終える前に消さない: 閉じるか次の操作で消える
  useEffect(() => {
    if (!bulkActionResult || bulkActionResult.type === 'warning') return
    const timer = setTimeout(() => {
      setBulkActionResult(null)
    }, 6000)
    return () => clearTimeout(timer)
  }, [bulkActionResult])

  // 診断の取得の世代。再読み込みの途中で古い要求の診断が返っても、新しい一覧の警告を上書きしない（最新の世代の結果だけ反映する）
  const diagnosticsSeqRef = useRef(0)

  // 昇格候補一覧の取得
  const loadCandidates = useCallback(async () => {
    setLoading(true)
    try {
      const list = await window.api.goldenPromotionList()
      setCandidates(list)
      // 「救済候補 0 件」が「確かに無い」のか「履歴を読めなかった」のかの診断。一覧の取得とは別に取り、
      // 診断の取得が失敗しても一覧は出す（その場合は「確認できませんでした」を出す）。
      // 診断は別の git を 1 回読むので、一覧の表示（setLoading）を待たせないよう、待たずに取る
      const diagSeq = ++diagnosticsSeqRef.current
      void window.api
        .goldenPromotionScanDiagnostics()
        .then((d) => {
          if (diagSeq === diagnosticsSeqRef.current) setScanDiagnostics(d)
        })
        .catch((diagErr) => {
          console.error('Failed to load promotion scan diagnostics:', diagErr)
          if (diagSeq === diagnosticsSeqRef.current) setScanDiagnostics('unavailable')
        })
      // 提案の合成が登録・承認まで進んで開かれたとき: その合成提案を選択済み（チェック済み）にする。
      // 承認の押下はこの画面の既存のボタンで行う（新しい承認 UI は作らない）
      const pre = findPreselected(list, takePromotionPreselect())
      if (pre) {
        setFilterType('all')
        setStateFilter('all')
        setSearchQuery('')
        setSelectedId(pre.id)
        setCheckedIds(new Set([pre.id]))
        setActiveTab('queue')
      }
    } catch (err) {
      console.error('Failed to load promotion candidates:', err)
    } finally {
      setLoading(false)
      setCandidatesLoadSeq((n) => n + 1)
    }
  }, [])

  // Golden 配布中スキルの取得 (G-1) および契約 CLI 台帳ドリフト検知 (W3)
  const loadDeployedSkills = useCallback(async () => {
    setLoadingDeployed(true)
    try {
      const list = await window.api.goldenPromotionListDeployed()
      setDeployedSkills(list)
      const drift = await window.api.goldenPromotionDetectLedgerDrift()
      setLedgerDrift(drift)
    } catch (err) {
      console.error('Failed to load deployed golden skills or drift:', err)
    } finally {
      setLoadingDeployed(false)
    }
  }, [])

  // 契約 CLI 台帳追補の適用実行 (C-3: 人間承認の事実・確認ダイアログの表示内容ハッシュ・影響スキルを記録)
  // 本体ロジックは goldenLedgerCatchup.ts の executeLedgerCatchup へ切り出し済み (073)
  const handleExecuteCatchup = async (target: {
    sha: string
    shortSha: string
    appliedBy: string
    subject: string
    skillsAffected: string[]
  }) => {
    // 昇格・撤去・復帰(applying)と進捗帯を共有するため、二重起動で互いの進捗を消し合わないよう防御する (073 レビュー指摘)
    if (applying) return
    await executeLedgerCatchup(target, {
      setCatchingUp: setCatchingUpSha,
      setConfirmTarget: setCatchupConfirmTarget,
      clearProgress: () => setProgressInfo(null),
      showResult: (dialog) => setResultDialog({ open: true, ...dialog }),
      digestSha256: async (input) => {
        const enc = new TextEncoder().encode(input)
        const hashBuf = await window.crypto.subtle.digest('SHA-256', enc)
        return Array.from(new Uint8Array(hashBuf))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('')
      },
      now: () => new Date(),
      // メソッドとして参照を外して渡さず、receiver を固定して呼ぶ (Codex 実装レビュー指摘)
      applyLedgerCatchup: (sha, approvalContext) =>
        window.api.goldenPromotionApplyLedgerCatchup(sha, approvalContext, writePassword),
      loadDeployedSkills,
      authText,
      clearPassword,
    })
  }

  // 昇格進捗の購読 (R-1)
  useEffect(() => {
    const unsub = window.api.onGoldenPromotionProgress?.((data) => {
      setProgressInfo((prev) => {
        const now = Date.now()
        return {
          ...data,
          startedAtMs: prev ? prev.startedAtMs : now,
          lastUpdatedAtMs: now,
        }
      })
    })
    return () => unsub?.()
  }, [])

  // 1秒ごとのタイマー（経過時間・応答停止警告用）
  useEffect(() => {
    if (!progressInfo && !applying) return
    const interval = setInterval(() => {
      setNowMs(Date.now())
    }, 1000)
    return () => clearInterval(interval)
  }, [progressInfo, applying])

  // 契約 L リース状態の取得 (What 1, C-1)
  const loadLeaseStatus = useCallback(async () => {
    setLoadingLeaseStatus(true)
    try {
      const status = await window.api.goldenPromotionGetLeaseStatus()
      setLeaseStatus(status)
    } catch (err) {
      console.error('Failed to load golden lease status:', err)
    } finally {
      setLoadingLeaseStatus(false)
    }
  }, [])

  // 昇格待ちの列を先に取り、配布中の一覧・台帳のずれ・リースの状態はその後に取る（CCPIT_L0_004 W6）。
  // 主処理は git を同期で起動するので、同時に投げると、一覧の取得が他の取得の待ちに割り込まれて遅くなっていた
  // （起動直後の 1 回目で、配布中の一覧だけで 14 秒）
  const loadAllInOrder = useCallback(async () => {
    await loadCandidates()
    void loadDeployedSkills()
    void loadLeaseStatus()
  }, [loadCandidates, loadDeployedSkills, loadLeaseStatus])

  useEffect(() => {
    void loadAllInOrder()
  }, [loadAllInOrder])

  // 失効したリースの安全な CAS 解放 (What 2, C-2, C-3)
  const handleReleaseExpiredLease = async () => {
    if (!leaseStatus?.leaseId) return
    setReleasingLease(true)
    try {
      const res = await window.api.goldenPromotionReleaseExpiredLease(leaseStatus.leaseId, writePassword)
      const authReason = goldenWriteAuthRejectedReason(res)
      if (authReason) {
        setResultDialog({
          open: true,
          success: false,
          title: authText.rejectedTitle,
          message: authText.rejectedMessage(authReason),
        })
        return
      }
      setBulkActionResult({
        message: `失効した契約 L リース (${leaseStatus.leaseId.slice(0, 8)}) を正常に解放しました。`,
        type: 'success',
      })
      await loadLeaseStatus()
    } catch (err: any) {
      setResultDialog({
        open: true,
        success: false,
        title: 'リース解放拒否・エラー',
        message: err.message || String(err),
      })
    } finally {
      clearPassword()
      setReleasingLease(false)
    }
  }

  // 所有者死亡・終了時の安全な早期解放 (What 7, C-7, 追補条項 L-b, W3: Main 側 1 箇所承認)
  const handleExecuteEarlyReleaseLease = async () => {
    if (!leaseStatus?.leaseId) return
    setReleasingLease(true)
    try {
      const res = await window.api.goldenPromotionReleaseEarlyLease(leaseStatus.leaseId, writePassword)
      const authReason = goldenWriteAuthRejectedReason(res)
      if (authReason) {
        setResultDialog({
          open: true,
          success: false,
          title: authText.rejectedTitle,
          message: authText.rejectedMessage(authReason),
        })
        return
      }
      if (res.cancelled) {
        return
      }
      setBulkActionResult({
        message: `maintainer明示承認に基づき、所有者死亡・終了が確認された契約 L リース (${res.releasedLeaseId ? res.releasedLeaseId.slice(0, 8) : leaseStatus.leaseId.slice(0, 8)}) を安全に早期解放しました。`,
        type: 'success',
      })
      await loadLeaseStatus()
    } catch (err: any) {
      setResultDialog({
        open: true,
        success: false,
        title: '早期解放拒否・エラー',
        message: err.message || String(err),
      })
    } finally {
      clearPassword()
      setReleasingLease(false)
    }
  }

  // 残骸（worktree / 一時ブランチ / 一時作業フォルダ）の清掃 (What 3, C-4, W2)
  const handleCleanupArtifacts = async () => {
    setCleaningArtifacts(true)
    try {
      const res = await window.api.goldenPromotionCleanupArtifacts(writePassword)
      const authReason = goldenWriteAuthRejectedReason(res)
      if (authReason) {
        setResultDialog({
          open: true,
          success: false,
          title: authText.rejectedTitle,
          message: authText.rejectedMessage(authReason),
        })
        return
      }
      const wtCount = res.cleanedWorktrees?.length || 0
      const brCount = res.cleanedBranches?.length || 0
      const tmpCount = res.cleanedTempDirs?.length || 0
      const totalCount = wtCount + brCount + tmpCount
      // 持ち主（CCPIT の昇格の記録）を確かめられない物は消さずに残す（CCPIT_L0_004 W3）
      const keptCount = res.keptUnknownOwner?.length || 0
      setBulkActionResult({
        message:
          `昇格の残骸を清掃しました (計 ${totalCount} 件: worktree ${wtCount} 件, branch ${brCount} 件, 一時作業フォルダ ${tmpCount} 件)。` +
          (keptCount > 0
            ? ` CCPIT の昇格が作ったと確かめられない ${keptCount} 件は消さずに残しました（${res.keptUnknownOwner!.join(' / ')}）。`
            : ''),
        type: 'success',
      })
      await loadLeaseStatus()
    } catch (err: any) {
      setResultDialog({
        open: true,
        success: false,
        title: '残骸清掃失敗',
        message: err.message || String(err),
      })
    } finally {
      clearPassword()
      setCleaningArtifacts(false)
    }
  }

  // アイテム選択時（未閲覧であれば既読にする） (J-4: テキスト選択中のクリックガード)
  const handleSelectItem = useCallback(async (item: PromotionCandidate) => {
    const selection = window.getSelection()
    if (selection && selection.toString().trim().length > 0) {
      return
    }
    setSelectedId(item.id)
    setRejectArmedId(null)
    if (!item.viewed) {
      try {
        await window.api.goldenPromotionMarkViewed(item.id)
        setCandidates((prev) =>
          prev.map((c) => (c.id === item.id ? { ...c, viewed: true } : c))
        )
      } catch (err) {
        console.error('Failed to mark item as viewed:', err)
      }
    }
  }, [])

  // おすすめ対象外（hiddenFromRecommend）の動的計算（常に全候補 candidates を母数として計算 J-6）
  const hiddenFromRecommendSkills = useMemo(() => {
    return candidates.filter((c) => c.source !== 'rescue' && !c.isAdopted)
  }, [candidates])
  const hiddenGoldenCount = useMemo(() => {
    return hiddenFromRecommendSkills.filter((c) => c.diffState !== 'new').length
  }, [hiddenFromRecommendSkills])
  const hiddenUnknownCount = useMemo(() => {
    return hiddenFromRecommendSkills.filter((c) => c.diffState === 'new').length
  }, [hiddenFromRecommendSkills])

  // マッチスコアリング関数 (J-8, L-2, F-2, F-4: 単一情報源化)
  const getMatchScore = useCallback((item: PromotionCandidate, query: string): number => {
    const qTrimmed = query.trim()
    if (!qTrimmed) return 0

    const qNorm = toNorm(qTrimmed)
    const qCompact = toCompact(qTrimmed)
    const normTokens = qNorm.split(/\s+/).filter(Boolean)
    const rawTokens = qTrimmed.toLowerCase().split(/\s+/).filter(Boolean)
    const searchTokens = Array.from(new Set([...rawTokens, ...normTokens]))
    const allTokens = searchTokens

    const titleNorm = toNorm(item.title || '')
    const titleCompact = toCompact(item.title || '')
    const nameNorm = toNorm(item.skillName || '')
    const nameCompact = toCompact(item.skillName || '')

    const titleLower = (item.title || '').toLowerCase()
    const nameLower = (item.skillName || '').toLowerCase()
    const descLower = (item.description || '').toLowerCase()
    const pathLower = (item.targetPath || item.localPath || '').toLowerCase()
    const diffLower = (item.diffSummary || '').toLowerCase()
    const rawLower = (item.capturedContent || item.skillDetail?.rawContent || '').toLowerCase()

    // 1. 完全一致（区切り文字吸収: "md render" === "md-render"）
    if (
      titleCompact === qCompact ||
      nameCompact === qCompact ||
      titleNorm === qNorm ||
      nameNorm === qNorm
    ) {
      return 200
    }

    // 2. 前方一致（区切り文字吸収）
    if (
      (qCompact.length >= 2 && (titleCompact.startsWith(qCompact) || nameCompact.startsWith(qCompact))) ||
      (qNorm.length >= 2 && (titleNorm.startsWith(qNorm) || nameNorm.startsWith(qNorm)))
    ) {
      return 150
    }

    // 3. 全トークン包含（AND タイトル/スキル名一致）
    if (searchTokens.length > 0 && searchTokens.every((t) => titleLower.includes(t) || nameLower.includes(t))) {
      return 100
    }

    // 4. 部分トークン包含（OR タイトル/スキル名一致）
    if (allTokens.some((t) => titleLower.includes(t) || nameLower.includes(t))) {
      return 50
    }

    // 5. 説明文・パス・差分サマリに一致
    if (allTokens.some((t) => descLower.includes(t) || pathLower.includes(t) || diffLower.includes(t))) {
      return 20
    }

    // 6. 本文のみに一致
    if (allTokens.some((t) => rawLower.includes(t))) {
      return 10
    }

    return 0
  }, [])

  // 検索クエリがある場合、現在の絞り込み条件を外して全候補でヒットする件数を計算 (J-7, L-2, F-2, F-4)
  const matchesInAllCandidates = useMemo(() => {
    if (!searchQuery.trim()) return []
    return candidates.filter((item) => getMatchScore(item, searchQuery) > 0)
  }, [candidates, searchQuery, getMatchScore])

  // フィルタ・検索・並べ替え適用後の一覧 (F-5, H-2, H-4, J-5, J-8, L-2, F-2, F-4)
  const filteredCandidates = useMemo(() => {
    const qTrimmed = searchQuery.trim()

    let result = candidates.filter((item) => {
      // 状態フィルタ
      if (stateFilter !== 'all' && item.state !== stateFilter) return false

      // 種別・おすすめフィルタ
      if (filterType === 'recommend') {
        // おすすめ: 救済対象 または CCPIT採用済みスキル
        const isPriority = item.source === 'rescue' || item.isAdopted === true
        if (!isPriority) return false
      } else if (filterType === 'rescue') {
        if (item.source !== 'rescue') return false
      } else if (filterType === 'adopted') {
        if (!item.isAdopted) return false
      }

      // 部分一致検索 (H-4, J-8, L-2, F-2, F-4: 単一情報源判定)
      if (qTrimmed.length > 0 && getMatchScore(item, searchQuery) === 0) {
        return false
      }

      return true
    })

    // 並べ替え (H-4, J-5, J-8, L-2)
    result = [...result].sort((a, b) => {
      // 検索語がある場合はマッチ優先度スコア降順を最優先 (J-8, L-2)
      if (qTrimmed.length > 0) {
        const scoreA = getMatchScore(a, searchQuery)
        const scoreB = getMatchScore(b, searchQuery)
        if (scoreA !== scoreB) {
          return scoreB - scoreA
        }
      }

      // 同スコア内または通常時はユーザー指定のソート順 (J-5)
      switch (sortOrder) {
        case 'date-desc':
          return (b.addedAt || '').localeCompare(a.addedAt || '') || a.id.localeCompare(b.id)
        case 'date-asc':
          return (a.addedAt || '').localeCompare(b.addedAt || '') || a.id.localeCompare(b.id)
        case 'title-asc':
        case 'name-asc':
          return (
            a.title.localeCompare(b.title, 'ja', { numeric: true, sensitivity: 'base' }) ||
            a.id.localeCompare(b.id)
          )
        case 'title-desc':
        case 'name-desc':
          return (
            b.title.localeCompare(a.title, 'ja', { numeric: true, sensitivity: 'base' }) ||
            b.id.localeCompare(a.id)
          )
        case 'path-asc':
          return (
            (a.skillName || '').localeCompare(b.skillName || '', 'en', { numeric: true }) ||
            a.id.localeCompare(b.id)
          )
        case 'path-desc':
          return (
            (b.skillName || '').localeCompare(a.skillName || '', 'en', { numeric: true }) ||
            b.id.localeCompare(a.id)
          )
        default:
          return 0
      }
    })

    return result
  }, [candidates, stateFilter, filterType, searchQuery, sortOrder])

  // 検索・フィルタ変更時の選択アイテム追従 (Finding 5)
  useEffect(() => {
    if (selectedId && !filteredCandidates.some((item) => item.id === selectedId)) {
      setSelectedId(filteredCandidates.length > 0 ? filteredCandidates[0].id : null)
    } else if (!selectedId && filteredCandidates.length > 0) {
      setSelectedId(filteredCandidates[0].id)
    }
  }, [filteredCandidates, selectedId])

  // 選択中のアイテム
  const selectedItemRaw = useMemo(() => {
    return candidates.find((c) => c.id === selectedId) || null
  }, [candidates, selectedId])

  // 差分の表示は、一覧では作らず、詳細の欄を開いたときに主処理で作る（CCPIT_L0_004 W6）。
  // 一覧を読み直したら作り直す（golden・手元が変わっているかもしれない）
  const [lazyDiffs, setLazyDiffs] = useState<Record<string, string | null>>({})
  // 差分を取得できなかった理由（git から読めなかったとき等）。握りつぶして「差分なし」に見せない（CCPIT_L0_014 P4）
  const [lazyDiffErrors, setLazyDiffErrors] = useState<Record<string, string>>({})
  useEffect(() => {
    setLazyDiffs({})
    setLazyDiffErrors({})
  }, [candidatesLoadSeq])
  useEffect(() => {
    const it = selectedItemRaw
    if (!it || it.diffDetail !== undefined || (it.source !== 'normal' && it.source !== 'proposal')) return
    if (Object.prototype.hasOwnProperty.call(lazyDiffs, it.id)) return
    let alive = true
    window.api
      .goldenPromotionDiffDetail({ source: it.source, skillName: it.skillName, capturedContent: it.capturedContent })
      .then((d) => {
        if (alive) setLazyDiffs((prev) => ({ ...prev, [it.id]: d }))
      })
      .catch((err: unknown) => {
        if (alive) {
          setLazyDiffs((prev) => ({ ...prev, [it.id]: null }))
          setLazyDiffErrors((prev) => ({ ...prev, [it.id]: diffErrorText(err) }))
        }
      })
    return () => {
      alive = false
    }
  }, [selectedItemRaw, lazyDiffs])
  const selectedItem = useMemo(() => {
    if (!selectedItemRaw) return null
    if (selectedItemRaw.diffDetail !== undefined) return selectedItemRaw
    const d = lazyDiffs[selectedItemRaw.id]
    return d ? { ...selectedItemRaw, diffDetail: d } : selectedItemRaw
  }, [selectedItemRaw, lazyDiffs])
  // 差分を作っている途中か（詳細の欄に「差分を作成中…」を出す）
  const diffLoading =
    selectedItemRaw !== null &&
    selectedItemRaw.diffDetail === undefined &&
    (selectedItemRaw.source === 'normal' || selectedItemRaw.source === 'proposal') &&
    !Object.prototype.hasOwnProperty.call(lazyDiffs, selectedItemRaw.id)

  // 選択中の Golden 配布中アイテム
  const selectedDeployedSkill = useMemo(() => {
    return deployedSkills.find((s) => s.name === selectedDeployedName) || null
  }, [deployedSkills, selectedDeployedName])

  // 全選択の対象（押せない 4 状態を除く）。絞り込みが「見送り」のときだけ、押せない行も含める
  // （見送り済みの行を「未処理に戻す」道を残すため）。 (H-2 Finding 2 方針 A・069 発注 13)
  const checkableCandidates = useMemo(() => {
    return bulkSelectableCandidates(filteredCandidates, { includeBlocked: stateFilter === 'dismissed' })
  }, [filteredCandidates, stateFilter])

  // 反映に渡してよい選択（押せない行が選択に残っていても、反映へ届かない）
  const applicableCheckedIds = useMemo(
    () => applicableIds(checkedIds, candidates),
    [checkedIds, candidates]
  )

  // 全選択 / 全解除（チェック可能アイテムのみを対象）
  const isAllChecked = useMemo(() => {
    if (checkableCandidates.length === 0) return false
    return checkableCandidates.every((c) => checkedIds.has(c.id))
  }, [checkableCandidates, checkedIds])

  const handleToggleSelectAll = () => {
    if (bulkActionResult) setBulkActionResult(null)
    if (isAllChecked) {
      const next = new Set(checkedIds)
      for (const c of checkableCandidates) {
        next.delete(c.id)
      }
      setCheckedIds(next)
    } else {
      const next = new Set(checkedIds)
      for (const c of checkableCandidates) {
        next.add(c.id)
      }
      setCheckedIds(next)
    }
  }

  // 押せない行（一致・golden 先行・分岐・競合の 4 状態）のチェックを押したとき:
  // その行を選んで詳細を開き、警告色の知らせで、その状態・候補の種類に合った理由と抜け方を出す
  const handleBlockedRowClick = (item: PromotionCandidate): void => {
    const guidance = blockedRowGuidance(item)
    if (!guidance) return
    void handleSelectItem(item)
    setBulkActionResult({
      message: t(guidance.noticeKey, {
        skill: item.skillName,
        count: conflictCountOf(item),
        composite: composeHoldOf(item)?.compositeId ?? ''
      }),
      type: 'warning'
    })
  }

  // 合成を破棄する（合成提案が異常で、通常の却下が届かないときの握りの解除口。1 回目は確認に変えるだけ・2 回目で確定）
  const handleDiscardCompose = async (compositeId: string): Promise<void> => {
    if (discardArmedId !== compositeId) {
      setDiscardArmedId(compositeId)
      return
    }
    setDiscardArmedId(null)
    try {
      const res = await window.api.skillProposalsComposeDiscard({ compositeId })
      if (res.ok) {
        setBulkActionResult({ message: t('goldenPromotion.composeDiscardDone'), type: 'success' })
        await loadCandidates()
      } else {
        setBulkActionResult({ message: res.error ?? 'error', type: 'warning' })
      }
    } catch (err) {
      setBulkActionResult({ message: err instanceof Error ? err.message : String(err), type: 'warning' })
    }
  }

  // 競合している提案を、この画面から提案側の状態で「却下」にする（1 回目は確認に変えるだけ・2 回目で確定）
  const handleRejectConflicted = async (id: string): Promise<void> => {
    if (rejectArmedId !== id) {
      setRejectArmedId(id)
      return
    }
    setRejectArmedId(null)
    try {
      const res = await window.api.goldenPromotionRejectConflicted(id)
      if (res.ok) {
        setCheckedIds(new Set())
        setBulkActionResult({ message: t('goldenPromotion.conflictRejected'), type: 'success' })
        await loadCandidates()
      } else {
        setBulkActionResult({
          message: t('goldenPromotion.conflictRejectFailed', { reason: res.error ?? '' }),
          type: 'warning'
        })
      }
    } catch (err) {
      console.error('Failed to reject conflicted proposal:', err)
      setBulkActionResult({
        message: t('goldenPromotion.conflictRejectFailed', {
          reason: err instanceof Error ? err.message : String(err)
        }),
        type: 'warning'
      })
    }
  }

  const handleToggleCheck = (id: string) => {
    if (bulkActionResult) setBulkActionResult(null)
    const next = new Set(checkedIds)
    if (next.has(id)) {
      next.delete(id)
    } else {
      next.add(id)
    }
    setCheckedIds(next)
  }

  // 一括見送り (L-1)
  const handleDismissSelected = async () => {
    const ids = Array.from(checkedIds)
    if (ids.length === 0) return
    try {
      await window.api.goldenPromotionSetState(ids, 'dismissed')
      setCheckedIds(new Set())
      setBulkActionResult({
        message: t('goldenPromotion.bulkActionDismissed', { count: ids.length }),
        type: 'info'
      })
      await loadCandidates()
    } catch (err) {
      console.error('Failed to dismiss selected items:', err)
    }
  }

  // 未処理に戻す (L-1)
  const handleRestoreSelectedToPending = async () => {
    const ids = Array.from(checkedIds)
    if (ids.length === 0) return
    try {
      await window.api.goldenPromotionSetState(ids, 'pending')
      setCheckedIds(new Set())
      setBulkActionResult({
        message: t('goldenPromotion.bulkActionRestored', { count: ids.length }),
        type: 'info'
      })
      await loadCandidates()
    } catch (err) {
      console.error('Failed to restore selected items to pending:', err)
    }
  }

  // 個別・一括で「配布済み」へ切り替え (L-1, F-1)
  const handleMarkDistributed = async (ids: string[]) => {
    if (ids.length === 0) return
    try {
      await window.api.goldenPromotionSetState(ids, 'distributed')
      setCheckedIds(new Set())
      setBulkActionResult({
        message: t('goldenPromotion.bulkActionDistributed', { count: ids.length }),
        type: 'success'
      })
      await loadCandidates()
      await loadDeployedSkills()
    } catch (err) {
      console.error('Failed to mark items as distributed:', err)
    }
  }

  // 承認実行
  // 本体ロジックは goldenPromotionActions.ts の executeGoldenPromotionApply へ切り出し済み (074)。
  // 台帳追補 (catchingUpSha) の実行中は、共有の進捗帯を消し合わないよう本体を一切実行しない。
  const handleApplyPromotion = async () => {
    const ids = applicableIds(checkedIds, candidates)
    await executeGoldenPromotionApply(ids, {
      catchingUpSha,
      now: () => Date.now(),
      setApplying,
      setConfirmOpen,
      setProgressInfo,
      // 選んだ全件とパスワードを 1 回の呼び出しで渡す（認証はこの呼び出しの対象にだけ効く）
      applyPromotion: (ids) => window.api.goldenPromotionApply(ids, writePassword),
      setCheckedIds,
      showResult: (dialog) => setResultDialog(dialog),
      loadCandidates,
      loadDeployedSkills,
      loadLeaseStatus,
      t,
      authText,
      clearPassword
    })
  }

  // 提案の昇格を戻す（Plan r10 §8・T10）。2 回押しの確認（1 回目で確認の文言に変え、2 回目で実行）
  const rollbackText = goldenRollbackText(i18n.language.startsWith('ja'))
  const handleRollbackPromotion = async (requestId: string): Promise<void> => {
    if (rollbackConfirmId !== requestId) {
      setRollbackConfirmId(requestId)
      return
    }
    setRollbackConfirmId(null)
    setApplying(true)
    try {
      const r = await window.api.goldenPromotionRollback(requestId, writePassword)
      const authReason = goldenWriteAuthRejectedReason(r)
      if (authReason) {
        setResultDialog({
          open: true,
          success: false,
          title: authText.rejectedTitle,
          message: authText.rejectedMessage(authReason)
        })
        return
      }
      setResultDialog({
        open: true,
        success: r.success,
        title: r.success ? rollbackText.doneTitle : rollbackText.failTitle,
        message: r.success ? rollbackText.doneMessage(r.restoredGolden.length) : (r.error ?? ''),
        details: r.skipped.length > 0 ? r.skipped.map((s) => `${s.path}: ${s.reason}`).join('\n') : undefined
      })
      await loadCandidates()
      await loadDeployedSkills()
    } finally {
      clearPassword()
      setApplying(false)
    }
  }

  // Golden から引っ込める (G-2)
  // 本体ロジックは goldenPromotionActions.ts の executeGoldenWithdraw へ切り出し済み (074)。
  // 台帳追補 (catchingUpSha) の実行中は、共有の進捗帯を消し合わないよう本体を一切実行しない。
  const handleWithdrawSkill = async (skill: GoldenDeployedSkill) => {
    await executeGoldenWithdraw(skill, {
      catchingUpSha,
      now: () => Date.now(),
      setWithdrawTarget,
      setApplying,
      setProgressInfo,
      withdraw: (name) => window.api.goldenPromotionWithdraw(name, writePassword),
      setBulkActionResult,
      showResult: (dialog) => setResultDialog(dialog),
      loadDeployedSkills,
      loadCandidates,
      loadLeaseStatus,
      t,
      authText,
      clearPassword
    })
  }

  // 引っ込めたスキルを復帰させる (G-2)
  // 本体ロジックは goldenPromotionActions.ts の executeGoldenRestore へ切り出し済み (074)。
  // 台帳追補 (catchingUpSha) の実行中は、共有の進捗帯を消し合わないよう本体を一切実行しない。
  const handleRestoreSkill = async (skill: GoldenDeployedSkill) => {
    await executeGoldenRestore(skill, {
      catchingUpSha,
      now: () => Date.now(),
      setRestoreTarget,
      setApplying,
      setProgressInfo,
      restore: (name) => window.api.goldenPromotionRestore(name, writePassword),
      setBulkActionResult,
      showResult: (dialog) => setResultDialog(dialog),
      loadDeployedSkills,
      loadCandidates,
      loadLeaseStatus,
      t,
      authText,
      clearPassword
    })
  }

  // 入力したパスワードを、別の対象・別の操作へ持ち越さない（CCPIT_L0_003 W5）。
  // 確認の対象が開く・閉じる・変わるたびに消す（× や背景のクリックで閉じた場合も含む）。
  // 選んでいる行が変わったら、戻しの確認状態も解く（A で確認・入力 → B を見る → A に戻る、で再入力なしに実行させない）
  useEffect(() => {
    setRollbackConfirmId(null)
  }, [selectedId, selectedDeployedName, activeTab])
  useEffect(() => {
    clearPassword()
  }, [
    confirmOpen,
    withdrawTarget,
    restoreTarget,
    catchupConfirmTarget,
    rollbackConfirmId,
    leaseModalOpen,
    selectedId,
    selectedDeployedName,
    activeTab,
    clearPassword
  ])

  // 反映の確認ダイアログに出すアイテム（選択済みのうち、反映に渡してよい行だけ。反映の対象と一致させる）
  const checkedItems = useMemo(() => {
    const ok = new Set(applicableCheckedIds)
    return candidates.filter((c) => ok.has(c.id))
  }, [candidates, applicableCheckedIds])

  const handleSetFilterType = (type: 'recommend' | 'all' | 'rescue' | 'adopted') => {
    setFilterType(type)
    setCheckedIds(new Set())
  }

  const handleSetStateFilter = (filter: 'all' | PromotionState) => {
    setStateFilter(filter)
    setCheckedIds(new Set())
  }

  const unviewedCheckedCount = useMemo(() => {
    return checkedItems.filter((c) => !c.viewed).length
  }, [checkedItems])

  // 各種カウント
  const counts = useMemo(() => {
    return {
      all: candidates.length,
      pending: candidates.filter((c) => c.state === 'pending').length,
      dismissed: candidates.filter((c) => c.state === 'dismissed').length,
      applied_unpushed: candidates.filter((c) => c.state === 'applied_unpushed').length,
      distributed: candidates.filter((c) => c.state === 'distributed').length,
      rescue: candidates.filter((c) => c.source === 'rescue').length,
      adopted: candidates.filter((c) => c.isAdopted).length,
      deployed: deployedSkills.filter((s) => s.status === 'deployed').length,
      withdrawn: deployedSkills.filter((s) => s.status === 'withdrawn').length
    }
  }, [candidates, deployedSkills])

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex flex-col h-full bg-background text-foreground overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-3.5 border-b border-border shrink-0 bg-card/40">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10 text-primary">
              <Award size={22} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-bold tracking-tight">
                  {t('goldenPromotion.title')}
                </h1>
                <span className="text-[11px] px-2 py-0.5 rounded bg-muted text-muted-foreground font-medium">
                  Developer Mode
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {t('goldenPromotion.subtitle')}
              </p>
            </div>
          </div>

          {/* 上部タブ切り替え (G-1) & リフレッシュ */}
          <div className="flex items-center gap-2">
            <div className="flex items-center bg-muted/70 p-1 rounded-lg border border-border/50 text-xs">
              <button
                id="gp-tab-queue"
                data-gp-loading={loading ? '1' : '0'}
                data-gp-load-seq={candidatesLoadSeq}
                data-gp-total={candidates.length}
                data-gp-deployed-loading={loadingDeployed ? '1' : '0'}
                data-gp-lease-loading={loadingLeaseStatus ? '1' : '0'}
                onClick={() => setActiveTab('queue')}
                className={cn(
                  'px-3 py-1.5 rounded-md font-medium transition-colors flex items-center gap-1.5',
                  activeTab === 'queue'
                    ? 'bg-background text-foreground shadow-xs'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <Layers size={13} />
                <span>
                  {t('goldenPromotion.tabPromotionQueue', {
                    count: filteredCandidates.length,
                    total: candidates.length
                  })}
                </span>
              </button>
              <button
                onClick={() => setActiveTab('deployed')}
                className={cn(
                  'px-3 py-1.5 rounded-md font-medium transition-colors flex items-center gap-1.5',
                  activeTab === 'deployed'
                    ? 'bg-background text-foreground shadow-xs'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <Award size={13} />
                <span>
                  {t('goldenPromotion.tabDeployedGolden', {
                    count: counts.deployed
                  })}
                </span>
              </button>
            </div>

            {/* 契約 L リース診断ボタン (What 1, C-1) */}
            <Button
              variant={leaseStatus?.exists ? 'destructive' : 'outline'}
              size="sm"
              onClick={() => {
                void loadLeaseStatus()
                setLeaseModalOpen(true)
              }}
              className="gap-1.5 h-8 text-xs relative"
              title="契約 L リース状態の確認と回復"
            >
              <Lock size={13} />
              <span>リース診断</span>
              {leaseStatus?.exists && (
                <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
              )}
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void loadAllInOrder()
              }}
              disabled={loading || loadingDeployed || applying}
              className="gap-1.5 h-8 text-xs"
            >
              <RefreshCw
                size={13}
                className={loading || loadingDeployed ? 'animate-spin' : undefined}
              />
              {t('goldenPromotion.refresh')}
            </Button>
          </div>
        </div>

        {/* 昇格進捗バナー (R-1, C-11) */}
        {progressInfo && (
          <div className="bg-primary/10 border-b border-primary/20 px-6 py-2.5 flex flex-col gap-1.5 shrink-0 text-xs">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-medium text-foreground">
                <RefreshCw size={14} className="animate-spin text-primary" />
                <span>
                  昇格処理実行中 — ステップ {progressInfo.stepIndex} / {progressInfo.totalSteps}:{' '}
                  <strong className="text-primary">
                    {STEP_NAME_LABELS[progressInfo.stepName] || progressInfo.stepName}
                  </strong>
                </span>
                {progressInfo.leaseId && (
                  <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border">
                    lease: {progressInfo.leaseId.slice(0, 8)}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 text-muted-foreground text-[11px]">
                <span>経過: {Math.floor((nowMs - progressInfo.startedAtMs) / 1000)}秒</span>
                <span>更新: {Math.floor((nowMs - progressInfo.lastUpdatedAtMs) / 1000)}秒前</span>
                {nowMs - progressInfo.lastUpdatedAtMs >= 60000 && (
                  <span className="flex items-center gap-1 text-amber-500 font-semibold bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/30 animate-pulse">
                    <AlertTriangle size={12} />
                    60秒以上応答なし（停止またはタイムアウトの疑い）
                  </span>
                )}
              </div>
            </div>
            <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
              <div
                className="bg-primary h-1.5 rounded-full transition-all duration-300"
                style={{
                  width: `${Math.min(100, Math.max(5, (progressInfo.stepIndex / progressInfo.totalSteps) * 100))}%`
                }}
              />
            </div>
          </div>
        )}

        {/* リース存在注意バナー (What 1, C-1) */}
        {!progressInfo && leaseStatus?.exists && (
          <div className="bg-amber-500/10 border-b border-amber-500/20 px-6 py-2 flex items-center justify-between text-xs shrink-0">
            <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
              <Lock size={14} />
              <span>
                <strong>契約 L リースが存在しています</strong> (ID: {leaseStatus.leaseId?.slice(0, 8)}... /{' '}
                {(() => {
                  const ex = leaseExpiryView(leaseStatus)
                  if (ex.kind === 'expired') return <span className="text-red-500 font-semibold">失効済み</span>
                  if (ex.kind === 'valid') return <span>有効期限内: 残り約 {ex.minutes} 分</span>
                  return <span className="font-semibold">期限不明（失効の判定ができていません）</span>
                })()}
                )
              </span>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void loadLeaseStatus()
                setLeaseModalOpen(true)
              }}
              className="h-6 text-[11px] gap-1 border-amber-500/30 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10"
            >
              診断・回復を開く
            </Button>
          </div>
        )}

        {/* git から読めなかった項目の警告帯（リースが無い・0 件・正常と言わない。CCPIT_L0_014 P1・P2） */}
        {!progressInfo && leaseReadWarnings(leaseStatus).length > 0 && (
          <div
            className="bg-amber-500/10 border-b border-amber-500/30 px-6 py-2 flex items-center justify-between text-xs shrink-0"
            data-gp-lease-read-warning
          >
            <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400 min-w-0">
              <AlertTriangle size={14} className="shrink-0" />
              <span className="break-all">
                <strong>git から読めなかった項目があります</strong>（
                {leaseReadWarnings(leaseStatus)
                  .map((w) => w.label)
                  .join('・')}
                ）。「無い」「0 件」「正常」ではなく、確かめられていません。
              </span>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void loadLeaseStatus()
                setLeaseModalOpen(true)
              }}
              className="h-6 text-[11px] gap-1 shrink-0 border-amber-500/30 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10"
            >
              詳細を開く
            </Button>
          </div>
        )}

        {/* ────────────────────────────────────────────────────────── */}
        {/* タブ 1: 昇格待ち列 (Promotion Queue) */}
        {/* ────────────────────────────────────────────────────────── */}
        {activeTab === 'queue' && (
          <div className="flex flex-1 min-h-0 divide-x divide-border overflow-hidden">
            {/* 左ペイン: 絞り込み (Filters) */}
            <div className="w-56 p-4 flex flex-col gap-6 shrink-0 overflow-y-auto bg-card/30">
              {/* おすすめ / 種別フィルタ (F-5) */}
              <div className="space-y-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  <Filter size={13} />
                  <span>表示対象絞り込み</span>
                </div>
                <div className="flex flex-col gap-1">
                  <button
                    onClick={() => handleSetFilterType('recommend')}
                    className={cn(
                      'flex items-center justify-between px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors text-left',
                      filterType === 'recommend'
                        ? 'bg-primary/15 text-primary'
                        : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                    )}
                  >
                    <span>{t('goldenPromotion.filterRecommend')}</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-primary/20 text-primary font-semibold">
                      推奨
                    </span>
                  </button>
                  <button
                    onClick={() => handleSetFilterType('all')}
                    className={cn(
                      'flex items-center justify-between px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors text-left',
                      filterType === 'all'
                        ? 'bg-primary/15 text-primary'
                        : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                    )}
                  >
                    <span>{t('goldenPromotion.all')}</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-muted">
                      {counts.all}
                    </span>
                  </button>
                  <button
                    onClick={() => handleSetFilterType('rescue')}
                    className={cn(
                      'flex items-center justify-between px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors text-left',
                      filterType === 'rescue'
                        ? 'bg-primary/15 text-primary'
                        : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                    )}
                  >
                    <span>{t('goldenPromotion.filterRescueOnly')}</span>
                    <span
                      className={cn(
                        'text-[10px] px-1.5 py-0.2 rounded-full font-semibold',
                        counts.rescue > 0
                          ? 'bg-orange-500/20 text-orange-600 dark:text-orange-400'
                          : 'bg-muted text-muted-foreground'
                      )}
                    >
                      {counts.rescue > 0 ? counts.rescue : t('goldenPromotion.rescueNormalStatus')}
                    </span>
                  </button>
                  <button
                    onClick={() => handleSetFilterType('adopted')}
                    className={cn(
                      'flex items-center justify-between px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors text-left',
                      filterType === 'adopted'
                        ? 'bg-primary/15 text-primary'
                        : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                    )}
                  >
                    <span>{t('goldenPromotion.filterAdoptedOnly')}</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400">
                      {counts.adopted}
                    </span>
                  </button>
                </div>
              </div>

              {/* 状態フィルタ */}
              <div className="space-y-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  <Layers size={13} />
                  <span>{t('goldenPromotion.filterState')}</span>
                </div>
                <div className="flex flex-col gap-1">
                  <button
                    onClick={() => handleSetStateFilter('all')}
                    className={cn(
                      'flex items-center justify-between px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors text-left',
                      stateFilter === 'all'
                        ? 'bg-primary/15 text-primary'
                        : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                    )}
                  >
                    <span>{t('goldenPromotion.all')}</span>
                  </button>
                  <button
                    onClick={() => handleSetStateFilter('pending')}
                    className={cn(
                      'flex items-center justify-between px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors text-left',
                      stateFilter === 'pending'
                        ? 'bg-primary/15 text-primary'
                        : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                    )}
                  >
                    <span>{t('goldenPromotion.statePending')}</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-muted">
                      {counts.pending}
                    </span>
                  </button>
                  <button
                    onClick={() => handleSetStateFilter('applied_unpushed')}
                    className={cn(
                      'flex items-center justify-between px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors text-left',
                      stateFilter === 'applied_unpushed'
                        ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                        : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                    )}
                  >
                    <span>{t('goldenPromotion.stateAppliedUnpushed')}</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">
                      {counts.applied_unpushed}
                    </span>
                  </button>
                  <button
                    onClick={() => handleSetStateFilter('distributed')}
                    className={cn(
                      'flex items-center justify-between px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors text-left',
                      stateFilter === 'distributed'
                        ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                        : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                    )}
                  >
                    <span>{t('goldenPromotion.stateDistributed')}</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                      {counts.distributed}
                    </span>
                  </button>
                  <button
                    onClick={() => handleSetStateFilter('dismissed')}
                    className={cn(
                      'flex items-center justify-between px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors text-left',
                      stateFilter === 'dismissed'
                        ? 'bg-muted text-foreground'
                        : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                    )}
                  >
                    <span>{t('goldenPromotion.stateDismissed')}</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-muted">
                      {counts.dismissed}
                    </span>
                  </button>
                </div>
              </div>

              {/* 凡例ボタン (F-4) */}
              <div className="pt-4 border-t border-border/60">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setLegendOpen(true)}
                  className="w-full text-xs gap-1.5 text-muted-foreground hover:text-foreground"
                >
                  <HelpCircle size={13} />
                  {t('goldenPromotion.legendButton')}
                </Button>
              </div>
            </div>

            {/* 中央ペイン: 一覧テーブル (Grid 縦揃え F-4) */}
            <div className="flex-1 flex flex-col min-w-0 overflow-hidden bg-background">
              {/* 台帳破損警告バナー (Z-4) */}
              {isLedgerCorrupt && (
                <div className="p-3 bg-destructive/15 border-b border-destructive/30 text-xs space-y-1 text-destructive shrink-0">
                  <div className="flex items-center gap-1.5 font-bold">
                    <AlertTriangle size={16} />
                    <span>台帳ファイル破損警告: golden-ledger.json が壊れています</span>
                  </div>
                  <p className="text-[11px] text-destructive/90 leading-relaxed font-mono">
                    エラー詳細: {ledgerDrift?.ledgerError || (deployedSkills as any)?.ledgerError || 'JSON構文またはスキーマの不整合'}
                  </p>
                  <p className="text-[11px] text-destructive/80">
                    ※台帳破損による誤適用・事故を防ぐため、全台帳操作（追補・昇格・撤去・復帰）を安全に遮断しています。
                  </p>
                </div>
              )}

              {/* 検出が完了していない警告（CCPIT_L0_010）: 「0 件」「ずれ無し」を、確かに無い意味に見せない */}
              {(scanDiagnostics === 'unavailable' ||
                (scanDiagnostics !== null && scanDiagnostics.rescueScanError !== undefined)) && (
                <div
                  className="p-3 bg-amber-500/10 border-b border-amber-500/30 text-xs space-y-1 text-amber-700 dark:text-amber-300 shrink-0"
                  data-testid="scan-diagnostics-band"
                >
                  <div className="flex items-center gap-1.5 font-semibold">
                    <AlertTriangle size={14} />
                    <span>
                      {scanDiagnostics === 'unavailable'
                        ? '救済候補の検出が完了したか、確認できませんでした。「救済候補 0 件」は、確かに無いという意味ではありません。'
                        : '救済候補の検出が完了していません（golden の履歴を git から読めませんでした）。「救済候補 0 件」は、確かに無いという意味ではありません。'}
                    </span>
                  </div>
                  {scanDiagnostics !== 'unavailable' && scanDiagnostics?.rescueScanError && (
                    <p className="text-[11px] leading-relaxed font-mono break-all">
                      {scanDiagnostics.rescueScanError}
                    </p>
                  )}
                </div>
              )}

              {/* 操作バー & 検索・並べ替え (H-4) & 母数バッジ (F-5) */}
              <div className="flex flex-col gap-2 px-4 py-2.5 border-b border-border bg-card/20 shrink-0">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button
                      variant="default"
                      size="sm"
                      disabled={applicableCheckedIds.length === 0 || applying || isLedgerCorrupt || catchingUpSha !== null}
                      onClick={() => setConfirmOpen(true)}
                      id="gp-approve-selected"
                      className="gap-1.5 h-8 text-xs font-semibold"
                    >
                      <Check size={14} />
                      {t('goldenPromotion.approveSelected', { count: applicableCheckedIds.length })}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={checkedIds.size === 0 || applying}
                      onClick={handleDismissSelected}
                      className="gap-1.5 h-8 text-xs"
                      title={t('goldenPromotion.dismissTooltip')}
                    >
                      <X size={14} />
                      {t('goldenPromotion.dismissSelected', { count: checkedIds.size })}
                    </Button>
                    {stateFilter === 'dismissed' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={checkedIds.size === 0 || applying}
                        onClick={handleRestoreSelectedToPending}
                        className="gap-1.5 h-8 text-xs text-muted-foreground"
                      >
                        <RotateCcw size={13} />
                        {t('goldenPromotion.restoreToPending')}
                      </Button>
                    )}
                    {(stateFilter === 'applied_unpushed' ||
                      Array.from(checkedIds).some(
                        (id) => candidates.find((c) => c.id === id)?.state === 'applied_unpushed'
                      )) && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={checkedIds.size === 0 || applying}
                        onClick={() => handleMarkDistributed(Array.from(checkedIds))}
                        className="gap-1.5 h-8 text-xs text-emerald-600 dark:text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/10"
                        title={t('goldenPromotion.markDistributedSelectedTooltip')}
                      >
                        <CheckCircle2 size={13} />
                        {t('goldenPromotion.markDistributedSelected', { count: checkedIds.size })}
                      </Button>
                    )}

                    {/* 直近インラインフィードバック (L-1) */}
                    {bulkActionResult && (
                      <div
                        role={bulkActionResult.type === 'warning' ? 'alert' : undefined}
                        className={cn(
                          'flex items-center gap-1.5 px-2.5 py-1 rounded text-xs shadow-xs animate-in fade-in slide-in-from-left-2 duration-200',
                          bulkActionResult.type === 'warning'
                            ? 'bg-amber-500/20 text-foreground border border-amber-500/60'
                            : 'bg-muted/90 text-foreground border border-border/80'
                        )}
                      >
                        {bulkActionResult.type === 'warning' ? (
                          <AlertTriangle size={13} className="text-amber-500 shrink-0" />
                        ) : (
                          <CheckCircle2 size={13} className="text-emerald-500 shrink-0" />
                        )}
                        <span className="font-medium">{bulkActionResult.message}</span>
                        <button
                          onClick={() => setBulkActionResult(null)}
                          className="ml-1 text-muted-foreground hover:text-foreground cursor-pointer p-0.5 rounded hover:bg-muted"
                          aria-label="close"
                        >
                          <X size={11} />
                        </button>
                      </div>
                    )}
                  </div>

                  {/* 母数・非表示数・配布数表示 (F-5, J-6) */}
                  <div className="flex items-center gap-3 text-xs flex-wrap">
                    {filterType === 'recommend' ? (
                      <div className="flex items-center gap-2">
                        <span className="text-muted-foreground font-mono">
                          {t('goldenPromotion.displayingCountRecommend', {
                            count: filteredCandidates.length,
                            hidden: hiddenFromRecommendSkills.length,
                            total: candidates.length
                          })}
                        </span>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              onClick={() => handleSetFilterType('all')}
                              className="px-2 py-0.5 rounded text-[11px] font-medium bg-muted hover:bg-muted/80 text-primary hover:underline transition-colors cursor-pointer"
                            >
                              {t('goldenPromotion.viewAllHidden')}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {t('goldenPromotion.hiddenTooltip', {
                              golden: hiddenGoldenCount,
                              unknown: hiddenUnknownCount
                            })}
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    ) : (
                      <span className="text-muted-foreground font-mono">
                        {t('goldenPromotion.displayingCountAll', {
                          count: filteredCandidates.length,
                          total: candidates.length
                        })}
                      </span>
                    )}
                    <button
                      onClick={() => setActiveTab('deployed')}
                      className="px-2 py-0.5 rounded bg-primary/10 text-primary hover:bg-primary/20 transition-colors font-medium cursor-pointer"
                    >
                      {t('goldenPromotion.goldenDeployedCount', { count: counts.deployed })}
                    </button>
                  </div>
                </div>

                {/* 検索 (Search) & 並べ替え (Sort) コントロール (H-4, J-5) */}
                <div className="flex items-center justify-between gap-3 pt-1 border-t border-border/40 text-xs">
                  <div className="relative flex-1 max-w-sm">
                    <Search
                      size={13}
                      className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
                    />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => {
                        if (bulkActionResult) setBulkActionResult(null)
                        setSearchQuery(e.target.value)
                      }}
                      placeholder={t('goldenPromotion.searchPlaceholder')}
                      className="w-full h-7 pl-8 pr-7 text-xs rounded-md border border-border bg-background/80 text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-1 focus:ring-primary select-text"
                    />
                    {searchQuery && (
                      <button
                        onClick={() => setSearchQuery('')}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground cursor-pointer"
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className="text-muted-foreground text-[11px]">
                      {t('goldenPromotion.sortLabel')}:
                    </span>
                    <select
                      value={sortOrder}
                      onChange={(e) => setSortOrder(e.target.value as any)}
                      className="h-7 px-2 text-xs rounded-md border border-border bg-background/80 text-foreground focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
                    >
                      <option value="date-desc">{t('goldenPromotion.sortDateDesc')}</option>
                      <option value="date-asc">{t('goldenPromotion.sortDateAsc')}</option>
                      <option value="title-asc">{t('goldenPromotion.sortTitleAsc')}</option>
                      <option value="title-desc">{t('goldenPromotion.sortTitleDesc')}</option>
                      <option value="path-asc">{t('goldenPromotion.sortPathAsc')}</option>
                      <option value="path-desc">{t('goldenPromotion.sortPathDesc')}</option>
                      {/* テスト互換用隠しオプション */}
                      <option value="name-asc" className="hidden">{t('goldenPromotion.sortNameAsc')}</option>
                      <option value="name-desc" className="hidden">{t('goldenPromotion.sortNameDesc')}</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* 一覧スクロールコンテナ (J-3: 見出しを sticky top-0 として内包しスクロールバー幅ズレを根治) */}
              <div className="flex-1 overflow-y-auto divide-y divide-border/60 relative">
                {/* 一覧見出し行 (F-4, H-2, J-3: sticky top-0, select-text 対応) */}
                <div className="sticky top-0 z-10 bg-muted/95 backdrop-blur-xs grid grid-cols-[40px_1fr_120px_100px_130px_140px] items-center px-4 py-2 border-b border-border text-xs font-semibold text-muted-foreground shrink-0 shadow-xs">
                  <div className="flex items-center justify-start">
                    <Checkbox
                      checked={isAllChecked}
                      onCheckedChange={handleToggleSelectAll}
                      aria-label={t('goldenPromotion.selectAll')}
                    />
                  </div>
                  <div className="px-2 text-left">{t('goldenPromotion.colTitle')}</div>
                  <div className="px-2 text-left">{t('goldenPromotion.colDate')}</div>
                  <div className="px-2 text-center">{t('goldenPromotion.colSource')}</div>
                  <div className="px-2 text-center">{t('goldenPromotion.colDiffState')}</div>
                  <div className="px-2 text-center">{t('goldenPromotion.colState')}</div>
                </div>

                {loading && candidates.length === 0 ? (
                  // 読み込み中は、空の表示でなく、何を待っているかを出す（CCPIT_L0_004 W6）
                  <div
                    className="flex flex-col items-center justify-center p-12 text-center text-muted-foreground space-y-3"
                    data-gp-list-loading
                  >
                    <RefreshCw size={28} className="animate-spin opacity-60" />
                    <p className="text-sm">昇格の候補を走査中…（ローカルの skill・提案・golden の履歴を照合しています）</p>
                  </div>
                ) : filteredCandidates.length === 0 ? (
                  <div className="flex flex-col items-center justify-center p-12 text-center text-muted-foreground space-y-3">
                    <FileCode size={36} className="opacity-30" />
                    {matchesInAllCandidates.length > 0 && filterType !== 'all' ? (
                      <>
                        <p className="text-sm font-medium text-foreground max-w-md leading-relaxed">
                          {t('goldenPromotion.emptyMatchesInAll', {
                            filter:
                              filterType === 'recommend'
                                ? 'おすすめ'
                                : filterType === 'rescue'
                                  ? '救済のみ'
                                  : 'ローカル採用のみ',
                            query: searchQuery,
                            count: matchesInAllCandidates.length
                          })}
                        </p>
                        <Button
                          variant="default"
                          size="sm"
                          onClick={() => handleSetFilterType('all')}
                          className="text-xs gap-1.5"
                        >
                          <Layers size={13} />
                          {t('goldenPromotion.switchFilterToAll', {
                            count: matchesInAllCandidates.length
                          })}
                        </Button>
                      </>
                    ) : (
                      <>
                        <p className="text-sm">
                          {filterType === 'rescue' && counts.rescue === 0
                            ? t('goldenPromotion.rescueEmptyDesc')
                            : t('goldenPromotion.emptyList')}
                        </p>
                        {searchQuery && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setSearchQuery('')}
                            className="text-xs text-muted-foreground hover:text-foreground"
                          >
                            {t('goldenPromotion.clearSearchQuery')}
                          </Button>
                        )}
                        {filterType !== 'all' && !searchQuery && (
                          <Button
                            variant="link"
                            size="sm"
                            onClick={() => handleSetFilterType('all')}
                            className="text-xs text-primary"
                          >
                            すべての候補を表示する (全 {candidates.length} 件)
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                ) : (
                  filteredCandidates.map((item) => {
                    const isChecked = checkedIds.has(item.id)
                    const isSelected = selectedId === item.id

                    // 押せない行（一致・golden 先行・分岐・競合の 4 状態）。ツールチップ・知らせ・バッジの title・
                    // 詳細ペインは、候補の種類つきでこの 1 回の判定から決まる（lib/promotionBlockedRow.ts）
                    const blocked = blockedRowGuidance(item)

                    const disabledTooltip: string | undefined = blocked
                      ? t(blocked.tooltipKey, {
                          count: conflictCountOf(item),
                          composite: composeHoldOf(item)?.compositeId ?? ''
                        })
                      : undefined

                    // 本文のみにマッチしたかの判定 (J-8, L-2, F-4: 単一情報源化)
                    const isContentOnlyMatch =
                      searchQuery.trim().length > 0 && getMatchScore(item, searchQuery) === 10

                    return (
                      <Tooltip key={item.id}>
                        <TooltipTrigger asChild>
                          <div
                            onClick={() => handleSelectItem(item)}
                            data-gp-candidate-id={item.id}
                            className={cn(
                              'grid grid-cols-[40px_1fr_120px_100px_130px_140px] items-center px-4 py-2.5 cursor-pointer text-xs transition-colors group',
                              isSelected
                                ? 'bg-primary/10 hover:bg-primary/15'
                                : 'hover:bg-accent/50'
                            )}
                          >
                            {/* 列1: チェックボックス (disabled の場合は非活性 ＋ ツールチップ案内) */}
                            <PromotionRowCheckCell
                              item={item}
                              checked={isChecked}
                              tooltip={disabledTooltip}
                              onToggle={() => handleToggleCheck(item.id)}
                              onBlockedClick={() => handleBlockedRowClick(item)}
                            />

                            {/* 列2: 題名 (J-2, J-4: select-text cursor-text, CCPIT採用済 / 未閲覧 / 付随ファイル数) */}
                            <div className="px-2 flex flex-col items-start justify-center gap-1 min-w-0 text-left">
                              {/* 合成提案との関係（取り込み済み・昇格待ち）は、題名と重ならないよう題名の下の行に出す */}
                              <div className="flex items-center gap-2 min-w-0 max-w-full">
                              <span className="font-medium text-foreground truncate select-text cursor-text">
                                {item.title}
                              </span>
                              {item.companionFilesCount !== undefined && item.companionFilesCount > 0 && (
                                <span
                                  className="shrink-0 px-1.5 py-0.2 rounded text-[10px] font-normal bg-muted text-muted-foreground border border-border/60"
                                  title={`付随ファイル: ${item.companionFilesCount} 件`}
                                >
                                  +{item.companionFilesCount}
                                </span>
                              )}
                              {item.isAdopted && (
                                <span
                                  className="shrink-0 px-1.5 py-0.2 rounded text-[10px] font-medium bg-blue-500/15 text-blue-600 dark:text-blue-400 select-text"
                                  title={t('goldenPromotion.badgeAdoptedTooltip')}
                                >
                                  {t('goldenPromotion.badgeAdopted')}
                                </span>
                              )}
                              {!item.viewed && (
                                <span className="shrink-0 px-1.5 py-0.2 rounded text-[10px] font-semibold bg-amber-500/20 text-amber-600 dark:text-amber-400 select-text">
                                  {t('goldenPromotion.badgeUnviewed')}
                                </span>
                              )}
                              {isContentOnlyMatch && (
                                <span
                                  className="shrink-0 px-1.5 py-0.2 rounded text-[10px] font-normal bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20"
                                  title={t('goldenPromotion.matchContentTooltip')}
                                >
                                  {t('goldenPromotion.matchContentBadge')}
                                </span>
                              )}
                              </div>
                              <PromotionRowHoldLine item={item} t={t as never} />
                            </div>

                            {/* 列3: 追加日 (J-4: select-text) */}
                            <div className="px-2 text-left text-muted-foreground shrink-0 font-mono text-[11px] select-text">
                              {item.addedAt || '不明'}
                            </div>

                            {/* 列4: 入口の種別 */}
                            <div className="px-2 text-center shrink-0">
                              {item.source === 'rescue' && (
                                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-orange-500/15 text-orange-600 dark:text-orange-400">
                                  {t('goldenPromotion.sourceRescue')}
                                </span>
                              )}
                              {item.source === 'normal' && (
                                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-500/15 text-blue-600 dark:text-blue-400">
                                  {t('goldenPromotion.sourceNormal')}
                                </span>
                              )}
                              {item.source === 'proposal' && (
                                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-purple-500/15 text-purple-600 dark:text-purple-400 border border-purple-500/30">
                                  提案 (CC)
                                </span>
                              )}
                            </div>

                            {/* 列5: golden との差バッジ (H-2 / W3) */}
                            <div className="px-2 text-center shrink-0">
                              {/* 合成提案が握る行は、golden との差のバッジ（「中身が置き換わる」）の代わりに取り込み済み・昇格待ちを出す */}
                              {composeHoldOf(item) && <PromotionRowHoldBadge item={item} t={t as never} />}
                              {!composeHoldOf(item) && item.diffState === 'new' && (
                                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30">
                                  {t('goldenPromotion.diffStateNew')}
                                </span>
                              )}
                              {!composeHoldOf(item) && item.diffState === 'modified' && (
                                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30">
                                  {t('goldenPromotion.diffStateModified')}
                                </span>
                              )}
                              {!composeHoldOf(item) && item.diffState === 'identical' && (
                                <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-slate-500/15 text-slate-600 dark:text-slate-400 border border-slate-500/20">
                                  {t('goldenPromotion.diffStateIdentical')}
                                </span>
                              )}
                              {!composeHoldOf(item) && item.diffState === 'stale-local' && (
                                <span
                                  className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/20 text-amber-700 dark:text-amber-300 border border-amber-500/40"
                                  title={blocked?.badgeTitleKey ? t(blocked.badgeTitleKey) : undefined}
                                >
                                  {t('goldenPromotion.diffStateStaleLocal')}
                                </span>
                              )}
                              {!composeHoldOf(item) && item.diffState === 'diverged' && (
                                <span
                                  className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-red-500/20 text-red-700 dark:text-red-300 border border-red-500/40"
                                  title={blocked?.badgeTitleKey ? t(blocked.badgeTitleKey) : undefined}
                                >
                                  {t('goldenPromotion.diffStateDiverged')}
                                </span>
                              )}
                              {!composeHoldOf(item) && item.diffState === 'proposal-conflict' && (
                                <span
                                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/25 text-foreground border border-amber-500/60"
                                  title={t('goldenPromotion.conflictBadgeTooltip', {
                                    count: conflictCountOf(item)
                                  })}
                                >
                                  <AlertTriangle size={11} className="shrink-0 text-amber-500" />
                                  {t('goldenPromotion.conflictBadge', { count: conflictCountOf(item) })}
                                </span>
                              )}
                            </div>

                            {/* 列6: 状態バッジ */}
                            <div className="px-2 text-center shrink-0">
                              {item.state === 'pending' && (
                                <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-muted text-muted-foreground">
                                  {t('goldenPromotion.statePending')}
                                </span>
                              )}
                              {item.state === 'dismissed' && (
                                <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-muted/60 text-muted-foreground/60 line-through">
                                  {t('goldenPromotion.stateDismissed')}
                                </span>
                              )}
                              {item.state === 'applied_unpushed' && (
                                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/20 text-amber-600 dark:text-amber-400 border border-amber-500/30">
                                  {t('goldenPromotion.stateAppliedUnpushed')}
                                </span>
                              )}
                              {item.state === 'distributed' && (
                                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30">
                                  {t('goldenPromotion.stateDistributed')}
                                </span>
                              )}
                            </div>
                          </div>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="z-50 max-w-sm text-xs p-2 select-text">
                          <p className="font-semibold text-foreground">{item.skillName}</p>
                          <p className="font-mono text-[11px] text-muted-foreground break-all">
                            {item.targetPath}
                          </p>
                          {disabledTooltip && (
                            <p className="text-[11px] text-amber-400 mt-1">
                              {disabledTooltip}
                            </p>
                          )}
                        </TooltipContent>
                      </Tooltip>
                    )
                  })
                )}
              </div>
            </div>

            {/* 右ペイン: 詳細 (F-3: Unified Diff & What/Why/How) */}
            <div className="w-88 p-4 flex flex-col shrink-0 overflow-y-auto bg-card/20 divide-y divide-border/60 select-text cursor-text">
              {selectedItem ? (
                <div className="space-y-4">
                  <div>
                    <h2 className="text-sm font-bold text-foreground">
                      {selectedItem.title}
                    </h2>
                    <p className="text-xs text-muted-foreground font-mono mt-0.5">
                      {selectedItem.skillName}
                    </p>
                  </div>

                  {/* 提案競合: 押せない理由・相手・抜け方 (069 発注 6)。右ペインの一番上に置く（下に置くとスクロールの外に出る） */}
                  {selectedItem.diffState === 'proposal-conflict' && (
                    <div
                      role="alert"
                      className="p-3 rounded border border-amber-500/60 bg-amber-500/15 text-xs space-y-2"
                    >
                      <div className="font-semibold text-foreground flex items-center gap-1.5">
                        <AlertTriangle size={14} className="shrink-0 text-amber-500" />
                        <span>{t('goldenPromotion.conflictCardTitle')}</span>
                      </div>
                      <p className="text-foreground leading-relaxed">
                        {t('goldenPromotion.conflictCardWhy', {
                          skill: selectedItem.skillName,
                          count: conflictCountOf(selectedItem)
                        })}
                      </p>
                      <div className="space-y-1">
                        <div className="text-[11px] font-semibold text-foreground">
                          {t('goldenPromotion.conflictCardPeers')}
                        </div>
                        <ul className="space-y-1.5">
                          {resolveConflictPeers(selectedItem.conflictPeers, candidates).map((peer) => (
                            <li
                              key={peer.id}
                              className="p-2 rounded bg-background/60 border border-amber-500/30 space-y-0.5"
                            >
                              <div className="font-medium text-foreground break-words select-text">{peer.title}</div>
                              <div className="text-[11px] text-muted-foreground select-text">
                                {t('goldenPromotion.conflictPeerMeta', {
                                  date: peer.addedAt || t('goldenPromotion.unknown'),
                                  state: peer.proposalState
                                })}
                              </div>
                              <div className="font-mono text-[10px] text-muted-foreground break-all select-text">
                                {peer.requestId} ・ {peer.hash12}
                              </div>
                              <div className="text-[10px] text-muted-foreground">
                                {peer.dismissedHere === null
                                  ? t('goldenPromotion.conflictPeerMissing')
                                  : peer.dismissedHere
                                    ? t('goldenPromotion.conflictPeerDismissed')
                                    : null}
                              </div>
                              <Button
                                variant="outline"
                                size="sm"
                                className={cn(
                                  'h-6 text-[11px] mt-1',
                                  rejectArmedId === peer.id && 'border-red-500/70 text-red-500'
                                )}
                                onClick={() => void handleRejectConflicted(peer.id)}
                              >
                                {rejectArmedId === peer.id
                                  ? t('goldenPromotion.conflictRejectConfirm')
                                  : t('goldenPromotion.conflictRejectBtn')}
                              </Button>
                            </li>
                          ))}
                        </ul>
                      </div>
                      <div className="space-y-1">
                        <div className="text-[11px] font-semibold text-foreground">
                          {t('goldenPromotion.conflictCardExit')}
                        </div>
                        <p className="text-foreground leading-relaxed">
                          {t('goldenPromotion.conflictCardExitSteps')}
                        </p>
                        <p className="text-foreground leading-relaxed">
                          {t('goldenPromotion.conflictCardExitInPlace')}
                        </p>
                        <Button
                          variant="outline"
                          size="sm"
                          className={cn(
                            'h-6 text-[11px]',
                            rejectArmedId === selectedItem.id && 'border-red-500/70 text-red-500'
                          )}
                          onClick={() => void handleRejectConflicted(selectedItem.id)}
                        >
                          {rejectArmedId === selectedItem.id
                            ? t('goldenPromotion.conflictRejectConfirm')
                            : t('goldenPromotion.conflictRejectSelf')}
                        </Button>
                      </div>
                      <p className="text-[11px] text-muted-foreground leading-relaxed">
                        {t('goldenPromotion.conflictCardDismissNote')}
                      </p>
                      <p className="text-[11px] text-muted-foreground leading-relaxed">
                        {t('goldenPromotion.conflictCardOtherNote')}
                      </p>
                    </div>
                  )}

                  {/* 差分プレビュー または What/Why/How 構造化カード (F-3) */}
                  {diffLoading && (
                    <p className="pt-3 text-[11px] text-muted-foreground" data-gp-diff-loading>
                      差分を作成中…
                    </p>
                  )}
                  {!selectedItem.diffDetail && lazyDiffErrors[selectedItem.id] && (
                    <p
                      className="mt-3 text-[11px] text-amber-600 dark:text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1.5 break-all"
                      data-gp-diff-error
                    >
                      差分を取得できませんでした（差分が無いのではありません）: {lazyDiffErrors[selectedItem.id]}
                    </p>
                  )}
                  {selectedItem.diffDetail ? (
                    <div className="pt-3 space-y-1.5">
                      <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center justify-between">
                        <span>{t('goldenPromotion.diffPreview')}</span>
                        <span className="text-[10px] text-muted-foreground font-mono">Unified Diff</span>
                      </div>
                      <div className="text-[11px] font-mono p-2 rounded bg-muted/60 text-foreground overflow-x-auto max-h-60 overflow-y-auto border border-border/50 divide-y divide-border/10">
                        {selectedItem.diffDetail.split('\n').map((line, idx) => {
                          let lineCls = 'text-foreground'
                          if (line.startsWith('+') && !line.startsWith('+++')) {
                            lineCls = 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 font-medium'
                          } else if (line.startsWith('-') && !line.startsWith('---')) {
                            lineCls = 'bg-rose-500/15 text-rose-700 dark:text-rose-400 font-medium'
                          } else if (line.startsWith('@@')) {
                            lineCls = 'text-blue-500 bg-blue-500/10'
                          }
                          return (
                            <div key={idx} className={cn('px-1 py-0.5 whitespace-pre', lineCls)}>
                              {line}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  ) : selectedItem.skillDetail ? (
                    <div className="pt-3 space-y-2">
                      <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                        {t('goldenPromotion.skillStructure')}
                      </div>
                      {selectedItem.skillDetail.what && (
                        <div className="p-2.5 rounded bg-muted/30 border border-border/40 text-xs space-y-0.5">
                          <span className="font-semibold text-primary text-[11px]">What (機能概要):</span>
                          <p className="text-muted-foreground leading-relaxed whitespace-pre-wrap">
                            {selectedItem.skillDetail.what}
                          </p>
                        </div>
                      )}
                      {selectedItem.skillDetail.why && (
                        <div className="p-2.5 rounded bg-muted/30 border border-border/40 text-xs space-y-0.5">
                          <span className="font-semibold text-primary text-[11px]">Why (動機・背景):</span>
                          <p className="text-muted-foreground leading-relaxed whitespace-pre-wrap">
                            {selectedItem.skillDetail.why}
                          </p>
                        </div>
                      )}
                      {selectedItem.skillDetail.how && (
                        <div className="p-2.5 rounded bg-muted/30 border border-border/40 text-xs space-y-0.5">
                          <span className="font-semibold text-primary text-[11px]">How (使い方・発火条件):</span>
                          <p className="text-muted-foreground leading-relaxed whitespace-pre-wrap">
                            {selectedItem.skillDetail.how}
                          </p>
                        </div>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full text-xs gap-1.5 mt-1"
                        onClick={() =>
                          setFullContentModal({
                            title: selectedItem.title,
                            content: selectedItem.skillDetail?.rawContent || ''
                          })
                        }
                      >
                        <FileText size={13} />
                        {t('goldenPromotion.viewFullSkillMd')}
                      </Button>
                    </div>
                  ) : (
                    <div className="pt-3 space-y-1">
                      <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                        {t('goldenPromotion.diff')}
                      </div>
                      <div className="text-xs font-mono text-muted-foreground bg-muted/40 p-2 rounded border border-border/40">
                        {selectedItem.diffSummary || t('goldenPromotion.unknown')}
                      </div>
                    </div>
                  )}

                  {/* パス */}
                  <div className="pt-3 space-y-1">
                    <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                      {t('goldenPromotion.path')}
                    </div>
                    <div className="text-xs font-mono p-2 rounded bg-muted/60 text-foreground break-all border border-border/50">
                      {selectedItem.targetPath || t('goldenPromotion.unknown')}
                    </div>
                  </div>

                  {/* 中で何をしとるか */}
                  <div className="pt-3 space-y-1">
                    <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                      {t('goldenPromotion.description')}
                    </div>
                    <div className="text-xs text-foreground bg-muted/30 p-2.5 rounded border border-border/40 whitespace-pre-wrap leading-relaxed">
                      {selectedItem.description || t('goldenPromotion.unknown')}
                    </div>
                  </div>

                  {/* いつ入ったか */}
                  <div className="pt-3 space-y-1">
                    <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                      {t('goldenPromotion.addedAt')}
                    </div>
                    <div className="text-xs text-foreground">
                      {selectedItem.addedAt || t('goldenPromotion.unknown')}
                    </div>
                  </div>

                  {/* 入れた本人の弁 */}
                  <div className="pt-3 space-y-1">
                    <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                      {t('goldenPromotion.authorStatement')}
                    </div>
                    <div className="text-xs text-foreground italic bg-muted/20 p-2 rounded">
                      {selectedItem.authorStatement || t('goldenPromotion.unknown')}
                    </div>
                  </div>

                  {/* どのレーンが入れたか */}
                  <div className="pt-3 space-y-1">
                    <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                      {t('goldenPromotion.lane')}
                    </div>
                    <div className="text-xs font-mono text-foreground">
                      {selectedItem.lane || t('goldenPromotion.unknown')}
                    </div>
                  </div>

                  {/* CC 提案メタデータカード (W2) */}
                  {selectedItem.source === 'proposal' && (
                    <div className="pt-3 space-y-2">
                      <div className="text-[11px] font-semibold text-purple-600 dark:text-purple-400 uppercase tracking-wider flex items-center gap-1.5">
                        <span>Claude Code 提案情報</span>
                      </div>
                      <div className="p-3 rounded bg-purple-500/10 border border-purple-500/30 text-xs space-y-1.5">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] text-muted-foreground">Request ID:</span>
                          <span className="font-mono font-medium">{selectedItem.proposalRequestId || '不明'}</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] text-muted-foreground">提案ハッシュ:</span>
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {selectedItem.proposalHash ? selectedItem.proposalHash.slice(0, 16) + '...' : '不明'}
                          </span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* 分岐・競合時のマージ相談導線 (W3) */}
                  {selectedItem.diffState === 'diverged' && !composeHoldOf(selectedItem) && (
                    <DivergedGuidanceCard item={selectedItem} />
                  )}

                  {/* 合成提案が握っている行（取り込み済み・昇格待ち）: 理由と、戻し方。異常のときは「合成を破棄」 */}
                  {composeHoldOf(selectedItem) && (
                    <ComposeHoldGuidanceCard
                      item={selectedItem}
                      discardArmed={discardArmedId === composeHoldOf(selectedItem)?.compositeId}
                      onDiscard={(id) => void handleDiscardCompose(id)}
                    />
                  )}

                  {/* 運ばれなかったファイル (skippedFiles - W1) */}
                  {selectedItem.skippedFiles && selectedItem.skippedFiles.length > 0 && (
                    <div className="pt-3 space-y-1.5">
                      <div className="text-[11px] font-semibold text-amber-600 dark:text-amber-400 uppercase tracking-wider flex items-center justify-between">
                        <span>除外・保留ファイル ({selectedItem.skippedFiles.length} 件)</span>
                      </div>
                      <div className="p-2 rounded bg-amber-500/10 border border-amber-500/20 text-xs divide-y divide-border/20 max-h-40 overflow-y-auto">
                        {selectedItem.skippedFiles.map((sf, idx) => {
                          let reasonLabel = sf.reason as string
                          if (sf.reason === 'bak-file') reasonLabel = 'バックアップ除外 (.bak)'
                          else if (sf.reason === 'pending-translation') reasonLabel = '翻訳待ち (en 配置保留)'
                          else if (sf.reason === 'symlink-or-special') reasonLabel = '特殊ファイル・symlink 除外'
                          else if (sf.reason === 'size-exceeded') reasonLabel = 'サイズ上限超過 (>10MB)'
                          else if (sf.reason === 'os-vcs-artifact') reasonLabel = 'OS/VCS 除外'
                          return (
                            <div key={idx} className="py-1 flex items-center justify-between gap-1 font-mono text-[11px]">
                              <span className="truncate text-foreground" title={sf.relPath}>{sf.relPath}</span>
                              <span className="shrink-0 text-[10px] text-amber-600 dark:text-amber-400 bg-amber-500/15 px-1 rounded">
                                {reasonLabel}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {/* golden 余剰ファイル (extraGoldenFiles) */}
                  {selectedItem.extraGoldenFiles && selectedItem.extraGoldenFiles.length > 0 && (
                    <div className="pt-3 space-y-1.5">
                      <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                        <span>golden 側の余剰ファイル ({selectedItem.extraGoldenFiles.length} 件)</span>
                      </div>
                      <div className="p-2 rounded bg-muted/40 border border-border/40 text-xs divide-y divide-border/20 max-h-32 overflow-y-auto">
                        {selectedItem.extraGoldenFiles.map((ef, idx) => (
                          <div key={idx} className="py-1 flex items-center justify-between font-mono text-[11px]">
                            <span className="truncate text-muted-foreground" title={ef.relPath}>{ef.relPath}</span>
                            <span className="shrink-0 text-[10px] text-muted-foreground">{ef.size} B</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 配布済みへの遷移ボタン */}
                  {selectedItem.state === 'applied_unpushed' && (
                    <div className="pt-4 border-t border-border/80 space-y-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleMarkDistributed([selectedItem.id])}
                        className="w-full gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/10"
                      >
                        <CheckCircle2 size={14} />
                        {t('goldenPromotion.markDistributed')}
                      </Button>
                      <p className="text-[10px] text-muted-foreground text-center">
                        {t('goldenPromotion.markDistributedHint')}
                      </p>
                      {selectedItem.source === 'proposal' && selectedItem.proposalRequestId && (
                        <div className="space-y-1" data-testid="rollback-entry">
                          {/* 2 回目（実行）の前にパスワード（CCPIT_L0_003）。1 回目の押下は確認の文言に変えるだけで何も書かない */}
                          {rollbackConfirmId === selectedItem.proposalRequestId && (
                            <GoldenWritePasswordField
                              hasPassword={hasPassword}
                              password={writePassword}
                              onChange={setWritePassword}
                              text={authText}
                              disabled={applying}
                            />
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={
                              applying ||
                              (rollbackConfirmId === selectedItem.proposalRequestId && !canWrite)
                            }
                            onClick={() => handleRollbackPromotion(selectedItem.proposalRequestId as string)}
                            className="w-full gap-1.5 text-xs text-rose-600 dark:text-rose-400 border-rose-500/30 hover:bg-rose-500/10"
                          >
                            {rollbackConfirmId === selectedItem.proposalRequestId
                              ? rollbackText.confirm
                              : rollbackText.button}
                          </Button>
                          <p className="text-[10px] text-muted-foreground text-center">{rollbackText.hint}</p>
                        </div>
                      )}
                      {bulkActionResult && (
                        <div className="flex items-center justify-between gap-1.5 p-2 rounded text-xs bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30 animate-in fade-in">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <CheckCircle2 size={13} className="shrink-0" />
                            <span className="font-medium truncate">{bulkActionResult.message}</span>
                          </div>
                          <button
                            onClick={() => setBulkActionResult(null)}
                            className="text-muted-foreground hover:text-foreground cursor-pointer p-0.5"
                            aria-label="close"
                          >
                            <X size={11} />
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground p-6">
                  <HelpCircle size={32} className="mb-2 opacity-30" />
                  <p className="text-xs">{t('goldenPromotion.noSelection')}</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ────────────────────────────────────────────────────────── */}
        {/* タブ 2: Golden 配布中 (G-1, G-2) */}
        {/* ────────────────────────────────────────────────────────── */}
        {activeTab === 'deployed' && (
          <div className="flex flex-1 min-h-0 divide-x divide-border overflow-hidden">
            {/* 左側: 配布中スキル一覧 */}
            <div className="flex-1 flex flex-col min-w-0 overflow-hidden bg-background">
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-card/20 shrink-0">
                <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                  <Award size={14} className="text-primary" />
                  <span>{t('goldenPromotion.deployedList')} ({deployedSkills.length})</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  配布中: {counts.deployed} 件 / 撤去済み: {counts.withdrawn} 件
                </div>
              </div>

              {/* 台帳破損警告バナー (Z-4) */}
              {isLedgerCorrupt && (
                <div className="p-3 bg-destructive/15 border-b border-destructive/30 text-xs space-y-1 text-destructive shrink-0">
                  <div className="flex items-center gap-1.5 font-bold">
                    <AlertTriangle size={16} />
                    <span>台帳ファイル破損警告: golden-ledger.json が壊れています</span>
                  </div>
                  <p className="text-[11px] text-destructive/90 leading-relaxed font-mono">
                    エラー詳細: {ledgerDrift?.ledgerError || (deployedSkills as any)?.ledgerError || 'JSON構文またはスキーマの不整合'}
                  </p>
                  <p className="text-[11px] text-destructive/80">
                    ※台帳破損による誤適用・事故を防ぐため、全台帳操作（追補・昇格・撤去・復帰）を安全に遮断しています。
                  </p>
                </div>
              )}

              {/* 契約 CLI コミットの検出が完了していない警告（CCPIT_L0_010）: 「ずれ無し」を、確かに無い意味に見せない */}
              {!isLedgerCorrupt && ledgerDrift?.gitScanError !== undefined && (
                <div
                  className="p-3 bg-amber-500/10 border-b border-amber-500/30 text-xs space-y-1 text-amber-700 dark:text-amber-300"
                  data-testid="ledger-drift-scan-error-band"
                >
                  <div className="flex items-center gap-1.5 font-semibold">
                    <AlertTriangle size={14} />
                    <span>
                      契約 CLI コミットの台帳未記録の検出が完了していません（golden の履歴を git から読めませんでした）。「ずれ無し」という意味ではありません。
                    </span>
                  </div>
                  <p className="text-[11px] leading-relaxed font-mono break-all">{ledgerDrift.gitScanError}</p>
                </div>
              )}

              {/* 契約 CLI 台帳ドリフト警告・追補導線 (W3 / Codex MAJOR 2 反映 / Z-3 (5) 順序案内) */}
              {!isLedgerCorrupt && ledgerDrift?.hasDrift && (
                <div className="p-3 bg-amber-500/10 border-b border-amber-500/30 text-xs space-y-2">
                  <div className="flex items-center justify-between text-amber-600 dark:text-amber-400 font-semibold">
                    <span className="flex items-center gap-1.5">
                      <AlertTriangle size={14} />
                      契約 CLI コミットの台帳未記録（ドリフト）を {sortedUnrecordedCommits.length} 件検知しました
                    </span>
                  </div>
                  <p className="text-[11px] text-amber-700 dark:text-amber-300 font-sans">
                    ※依存関係や履歴の整合のため、古いコミットから順に追補することを推奨します。
                  </p>
                  <div className="space-y-1 text-[11px] font-mono">
                    {sortedUnrecordedCommits.map((c) => (
                      <div
                        key={c.sha}
                        className="flex items-center justify-between p-1.5 rounded bg-background/60 border border-border"
                      >
                        <div className="truncate mr-2">
                          <span className="font-bold text-foreground mr-2">[{c.shortSha}]</span>
                          <span className="text-muted-foreground mr-2">({c.appliedBy})</span>
                          <span>{c.subject}</span>
                          {c.skillsAffected.length > 0 && (
                            <span className="ml-2 text-primary font-sans">
                              (影響: {c.skillsAffected.join(', ')})
                            </span>
                          )}
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={catchingUpSha !== null || isLedgerCorrupt || applying}
                          onClick={() => setCatchupConfirmTarget(c)}
                          className="h-6 text-[11px] px-2 shrink-0 bg-primary/10 hover:bg-primary/20 text-primary border-primary/30"
                        >
                          {catchingUpSha === c.sha ? '追補中...' : '台帳追補'}
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ヘッダー行 */}
              <div className="grid grid-cols-[1fr_120px_100px] items-center px-4 py-2 border-b border-border bg-muted/30 text-xs font-semibold text-muted-foreground shrink-0 select-none">
                <div className="px-2">スキル名 / 題名</div>
                <div className="px-2 text-left">同期状態 (en)</div>
                <div className="px-2 text-right">状態</div>
              </div>

              {/* リストボディ */}
              <div className="flex-1 overflow-y-auto divide-y divide-border/60">
                {deployedSkills.length === 0 ? (
                  <div className="flex flex-col items-center justify-center p-12 text-center text-muted-foreground">
                    <FileCode size={36} className="mb-2 opacity-30" />
                    <p className="text-sm">Golden 配布スキルがありません。</p>
                  </div>
                ) : (
                  deployedSkills.map((skill) => {
                    const isSelected = selectedDeployedName === skill.name
                    const isWithdrawn = skill.status === 'withdrawn'

                    return (
                      <div
                        key={skill.name}
                        onClick={() => setSelectedDeployedName(skill.name)}
                        className={cn(
                          'grid grid-cols-[1fr_120px_100px] items-center px-4 py-2.5 cursor-pointer text-xs transition-colors select-none',
                          isSelected
                            ? 'bg-primary/10 hover:bg-primary/15'
                            : 'hover:bg-accent/50'
                        )}
                      >
                        {/* スキル名 / 題名 */}
                        <div className="px-2 flex items-center gap-2 min-w-0">
                          <span className={cn('font-medium text-foreground truncate', isWithdrawn && 'line-through text-muted-foreground')}>
                            {skill.title}
                          </span>
                          <span className="text-[11px] font-mono text-muted-foreground">
                            ({skill.name})
                          </span>
                          {skill.ledgerMismatch && (
                            <span
                              className="shrink-0 px-1.5 py-0.2 rounded text-[10px] font-semibold bg-rose-500/20 text-rose-600 dark:text-rose-400 border border-rose-500/30"
                              title="台帳ハッシュと実体ファイルが不一致です"
                            >
                              台帳不一致
                            </span>
                          )}
                        </div>

                        {/* en 同期 */}
                        <div className="px-2 text-left text-muted-foreground text-[11px]">
                          {skill.hasEn ? (
                            <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                              ja / en 同期済
                            </span>
                          ) : (
                            <span className="text-amber-600 dark:text-amber-400 font-medium">
                              ja のみ
                            </span>
                          )}
                        </div>

                        {/* 状態バッジ */}
                        <div className="px-2 text-right">
                          {isWithdrawn ? (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-muted text-muted-foreground">
                              {t('goldenPromotion.stateWithdrawn')}
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30">
                              {t('goldenPromotion.stateDeployed')}
                            </span>
                          )}
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
            </div>

            {/* 右ペイン: 配布中スキル詳細 (G-1, G-2) */}
            <div className="w-88 p-4 flex flex-col shrink-0 overflow-y-auto bg-card/20 divide-y divide-border/60">
              {selectedDeployedSkill ? (
                <div className="space-y-4">
                  <div>
                    <div className="flex items-center justify-between">
                      <h2 className="text-sm font-bold text-foreground">
                        {selectedDeployedSkill.title}
                      </h2>
                      {selectedDeployedSkill.status === 'withdrawn' ? (
                        <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-muted text-muted-foreground">
                          撤去済み
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/15 text-emerald-600">
                          配布中
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground font-mono mt-0.5">
                      {selectedDeployedSkill.name}
                    </p>
                  </div>

                  {/* 台帳不一致警告カード (W3) */}
                  {selectedDeployedSkill.ledgerMismatch && (
                    <div className="pt-3 space-y-2">
                      <div className="p-3 rounded bg-rose-500/10 border border-rose-500/30 text-xs space-y-2">
                        <div className="font-semibold text-rose-600 dark:text-rose-400 flex items-center gap-1.5">
                          <span>⚠️ 台帳ハッシュ不一致を検知</span>
                        </div>
                        <p className="text-muted-foreground text-[11px] leading-relaxed">
                          golden-ledger.json の記録と実体ファイルが食い違っています（契約 CLI の直接適用等）。
                        </p>
                        {selectedDeployedSkill.mismatchedFiles && selectedDeployedSkill.mismatchedFiles.length > 0 && (
                          <div className="p-2 rounded bg-background/50 border border-border/40 divide-y divide-border/20 max-h-36 overflow-y-auto font-mono text-[10px]">
                            {selectedDeployedSkill.mismatchedFiles.map((mf, idx) => (
                              <div key={idx} className="py-1">
                                <div className="font-medium text-foreground">{mf.path}</div>
                                <div className="text-muted-foreground">台帳: {mf.ledgerHash.slice(0, 12)}...</div>
                                <div className="text-rose-600 dark:text-rose-400">実体: {mf.actualHash.slice(0, 12)}...</div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* 構造化情報 (What / Why / How) */}
                  <div className="pt-3 space-y-2">
                    <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                      {t('goldenPromotion.skillStructure')}
                    </div>
                    {selectedDeployedSkill.detail.what && (
                      <div className="p-2.5 rounded bg-muted/30 border border-border/40 text-xs space-y-0.5">
                        <span className="font-semibold text-primary text-[11px]">What (機能概要):</span>
                        <p className="text-muted-foreground leading-relaxed whitespace-pre-wrap">
                          {selectedDeployedSkill.detail.what}
                        </p>
                      </div>
                    )}
                    {selectedDeployedSkill.detail.why && (
                      <div className="p-2.5 rounded bg-muted/30 border border-border/40 text-xs space-y-0.5">
                        <span className="font-semibold text-primary text-[11px]">Why (動機・背景):</span>
                        <p className="text-muted-foreground leading-relaxed whitespace-pre-wrap">
                          {selectedDeployedSkill.detail.why}
                        </p>
                      </div>
                    )}
                    {selectedDeployedSkill.detail.how && (
                      <div className="p-2.5 rounded bg-muted/30 border border-border/40 text-xs space-y-0.5">
                        <span className="font-semibold text-primary text-[11px]">How (使い方・発火条件):</span>
                        <p className="text-muted-foreground leading-relaxed whitespace-pre-wrap">
                          {selectedDeployedSkill.detail.how}
                        </p>
                      </div>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full text-xs gap-1.5 mt-1"
                      onClick={() =>
                        setFullContentModal({
                          title: selectedDeployedSkill.title,
                          content: selectedDeployedSkill.detail.rawContent || ''
                        })
                      }
                    >
                      <FileText size={13} />
                      {t('goldenPromotion.viewFullSkillMd')}
                    </Button>
                  </div>

                  {/* パス情報 */}
                  <div className="pt-3 space-y-1">
                    <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                      配置ファイル
                    </div>
                    <div className="text-xs font-mono p-2 rounded bg-muted/60 text-foreground break-all border border-border/50">
                      {selectedDeployedSkill.jaPath}
                    </div>
                  </div>

                  {/* 操作ボタン: 撤去 / 復帰 (G-2) */}
                  <div className="pt-4 border-t border-border/80 space-y-2">
                    {selectedDeployedSkill.status === 'deployed' ? (
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={applying || isLedgerCorrupt || catchingUpSha !== null}
                        onClick={() => setWithdrawTarget(selectedDeployedSkill)}
                        className="w-full gap-1.5 text-xs font-semibold"
                      >
                        <Archive size={14} />
                        {t('goldenPromotion.withdrawSkill')}
                      </Button>
                    ) : (
                      <Button
                        variant="default"
                        size="sm"
                        disabled={applying || isLedgerCorrupt || catchingUpSha !== null}
                        onClick={() => setRestoreTarget(selectedDeployedSkill)}
                        className="w-full gap-1.5 text-xs font-semibold"
                      >
                        <RotateCcw size={14} />
                        {t('goldenPromotion.restoreSkill')}
                      </Button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground p-6">
                  <Award size={32} className="mb-2 opacity-30" />
                  <p className="text-xs">スキルを選択してください。</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ────────────────────────────────────────────────────────── */}
        {/* 凡例モーダル (F-4: Legend Modal) */}
        {/* ────────────────────────────────────────────────────────── */}
        {legendOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-xs" onClick={() => setLegendOpen(false)} />
            <div className="relative bg-card border border-border rounded-lg shadow-xl w-full max-w-lg mx-4 flex flex-col overflow-hidden max-h-[85vh]">
              <div className="p-4 border-b border-border flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <HelpCircle size={18} className="text-primary" />
                  <h3 className="text-base font-semibold text-foreground">
                    {t('goldenPromotion.legendTitle')}
                  </h3>
                </div>
                <Button variant="ghost" size="icon" onClick={() => setLegendOpen(false)} className="h-7 w-7 text-muted-foreground">
                  <X size={14} />
                </Button>
              </div>

              <div className="p-4 space-y-5 overflow-y-auto text-xs leading-relaxed">
                {/* 列の説明 */}
                <div className="space-y-2">
                  <h4 className="font-bold text-foreground text-xs uppercase tracking-wider text-primary">
                    {t('goldenPromotion.legendColDesc')}
                  </h4>
                  <div className="border border-border rounded-md divide-y divide-border/60">
                    <div className="p-2 flex gap-2">
                      <span className="font-semibold w-20 shrink-0">チェック列:</span>
                      <span className="text-muted-foreground">一括承認・一括見送りの対象を選択します。見出し左端で全選択が可能です。</span>
                    </div>
                    <div className="p-2 flex gap-2">
                      <span className="font-semibold w-20 shrink-0">題名:</span>
                      <span className="text-muted-foreground">スキルの日本語題名と名前です。未確認の項目には琥珀色のバッジが付きます。</span>
                    </div>
                    <div className="p-2 flex gap-2">
                      <span className="font-semibold w-20 shrink-0">追加日:</span>
                      <span className="text-muted-foreground">ファイルが追加・更新された日付です。</span>
                    </div>
                    <div className="p-2 flex gap-2">
                      <span className="font-semibold w-20 shrink-0">入口:</span>
                      <span className="text-muted-foreground">候補の出所です（救済または正規昇格）。</span>
                    </div>
                    <div className="p-2 flex gap-2">
                      <span className="font-semibold w-20 shrink-0">golden との差:</span>
                      <span className="text-muted-foreground">承認時に golden 側に発生する変更の種別（新しく入る / 中身が置き換わる / 一致）です。</span>
                    </div>
                    <div className="p-2 flex gap-2">
                      <span className="font-semibold w-20 shrink-0">状態:</span>
                      <span className="text-muted-foreground">現在の昇格ライフサイクルステータスです。</span>
                    </div>
                  </div>
                </div>

                {/* 題名脇のバッジの説明 (J-2) */}
                <div className="space-y-2">
                  <h4 className="font-bold text-foreground text-xs uppercase tracking-wider text-primary">
                    {t('goldenPromotion.legendTitleBadgeDesc')}
                  </h4>
                  <div className="border border-border rounded-md divide-y divide-border/60">
                    <div className="p-2 flex items-center gap-3">
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 border border-indigo-500/30 w-28 text-center shrink-0">
                        {t('goldenPromotion.badgeAdopted')}
                      </span>
                      <span className="text-muted-foreground">
                        {t('goldenPromotion.legendBadgeAdoptedDesc')}
                      </span>
                    </div>
                    <div className="p-2 flex items-center gap-3">
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-500/20 text-amber-700 dark:text-amber-400 border border-amber-500/40 w-28 text-center shrink-0">
                        {t('goldenPromotion.badgeUnviewed')}
                      </span>
                      <span className="text-muted-foreground">
                        {t('goldenPromotion.legendBadgeUnviewedDesc')}
                      </span>
                    </div>
                  </div>
                </div>

                {/* golden との差（3状態）の説明 (H-2) */}
                <div className="space-y-2">
                  <h4 className="font-bold text-foreground text-xs uppercase tracking-wider text-primary">
                    {t('goldenPromotion.legendDiffStateDesc')}
                  </h4>
                  <div className="border border-border rounded-md divide-y divide-border/60">
                    <div className="p-2 flex items-center gap-3">
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 w-28 text-center shrink-0">
                        {t('goldenPromotion.diffStateNew')}
                      </span>
                      <span className="text-muted-foreground">golden 側に同名スキルが存在せず、承認時に新規追加（add）される候補です。</span>
                    </div>
                    <div className="p-2 flex items-center gap-3">
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30 w-28 text-center shrink-0">
                        {t('goldenPromotion.diffStateModified')}
                      </span>
                      <span className="text-muted-foreground">golden 側に同名スキルが存在し、内容が更新（update）される候補です。右ペインで差分が確認できます。</span>
                    </div>
                    <div className="p-2 flex items-center gap-3">
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-slate-500/15 text-slate-600 dark:text-slate-400 border border-slate-500/20 w-28 text-center shrink-0">
                        {t('goldenPromotion.diffStateIdentical')}
                      </span>
                      <span className="text-muted-foreground">golden 側と内容が完全に一致しており変更不要です。誤爆防止のためチェックボックスは無効化されています。</span>
                    </div>
                  </div>
                </div>

                {/* 状態バッジの説明 */}
                <div className="space-y-2">
                  <h4 className="font-bold text-foreground text-xs uppercase tracking-wider text-primary">
                    {t('goldenPromotion.legendStateDesc')}
                  </h4>
                  <div className="border border-border rounded-md divide-y divide-border/60">
                    <div className="p-2 flex items-center gap-3">
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-muted text-muted-foreground w-24 text-center shrink-0">
                        未処理
                      </span>
                      <span className="text-muted-foreground">まだ承認または見送りの判断を行っていない初期状態です。</span>
                    </div>
                    <div className="p-2 flex items-center gap-3">
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-muted/60 text-muted-foreground/60 line-through w-24 text-center shrink-0">
                        見送り
                      </span>
                      <div className="space-y-0.5">
                        <p className="text-muted-foreground">
                          今回は昇格を見送る判断をした候補です。いつでも「未処理に戻す」ことができます。
                        </p>
                        <p className="text-[11px] text-primary/90 font-medium">
                          {t('goldenPromotion.legendDismissProperties')}
                        </p>
                      </div>
                    </div>
                    <div className="p-2 flex items-center gap-3">
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/20 text-amber-600 dark:text-amber-400 border border-amber-500/30 w-24 text-center shrink-0">
                        反映済み (未push)
                      </span>
                      <span className="text-muted-foreground">契約実行ツールによりローカル golden へ反映完了しましたが、共有リポジトリへ未 push の状態です。</span>
                    </div>
                    <div className="p-2 flex items-center gap-3">
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 w-24 text-center shrink-0">
                        配布済み
                      </span>
                      <span className="text-muted-foreground">リモートへ push され、全環境に配布可能な完了状態です。</span>
                    </div>
                  </div>
                </div>

                {/* 入口種別の説明 */}
                <div className="space-y-2">
                  <h4 className="font-bold text-foreground text-xs uppercase tracking-wider text-primary">
                    {t('goldenPromotion.legendSourceDesc')}
                  </h4>
                  <div className="border border-border rounded-md divide-y divide-border/60">
                    <div className="p-2 flex items-center gap-3">
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-orange-500/15 text-orange-600 dark:text-orange-400 w-20 text-center shrink-0">
                        救済
                      </span>
                      <span className="text-muted-foreground">契約実行ツールを通さずにコミットされた裏口混入コミットから内容を捕獲し、正規に救済・復元した候補です。</span>
                    </div>
                    <div className="p-2 flex items-center gap-3">
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-500/15 text-blue-600 dark:text-blue-400 w-20 text-center shrink-0">
                        正規昇格
                      </span>
                      <span className="text-muted-foreground">ローカル環境（~/.claude/skills）から golden へ正規に昇格させる候補です。</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="p-3 border-t border-border bg-muted/20 flex justify-end">
                <Button variant="outline" size="sm" onClick={() => setLegendOpen(false)}>
                  閉じる
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* ────────────────────────────────────────────────────────── */}
        {/* SKILL.md 全文モーダル (F-3, G-1) */}
        {/* ────────────────────────────────────────────────────────── */}
        {fullContentModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-xs" onClick={() => setFullContentModal(null)} />
            <div className="relative bg-card border border-border rounded-lg shadow-xl w-full max-w-2xl mx-4 flex flex-col overflow-hidden max-h-[85vh]">
              <div className="p-4 border-b border-border flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <FileText size={18} className="text-primary" />
                  <h3 className="text-base font-semibold text-foreground">
                    {fullContentModal.title} — SKILL.md 全文
                  </h3>
                </div>
                <Button variant="ghost" size="icon" onClick={() => setFullContentModal(null)} className="h-7 w-7 text-muted-foreground">
                  <X size={14} />
                </Button>
              </div>
              <div className="p-4 overflow-y-auto flex-1">
                <pre className="text-xs font-mono text-foreground bg-muted/40 p-3 rounded border border-border/50 whitespace-pre-wrap leading-relaxed">
                  {fullContentModal.content}
                </pre>
              </div>
              <div className="p-3 border-t border-border bg-muted/20 flex justify-end">
                <Button variant="outline" size="sm" onClick={() => setFullContentModal(null)}>
                  閉じる
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* ────────────────────────────────────────────────────────── */}
        {/* 昇格確認ダイアログ (Confirmation Modal) */}
        {/* ────────────────────────────────────────────────────────── */}
        {confirmOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div
              className="absolute inset-0 bg-black/60 backdrop-blur-xs"
              onClick={() => {
                if (applying) return
                setConfirmOpen(false)
                clearPassword()
              }}
            />
            <div className="relative bg-card border border-border rounded-lg shadow-xl w-full max-w-lg mx-4 flex flex-col overflow-hidden max-h-[85vh]">
              <div className="p-4 border-b border-border flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Award size={18} className="text-primary" />
                  <h3 className="text-base font-semibold text-foreground">
                    {t('goldenPromotion.confirmDialogTitle')}
                  </h3>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={applying}
                  onClick={() => {
                    setConfirmOpen(false)
                    clearPassword()
                  }}
                  className="h-7 w-7 text-muted-foreground"
                >
                  <X size={14} />
                </Button>
              </div>

              <div className="p-4 space-y-4 overflow-y-auto">
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {t('goldenPromotion.confirmDialogDescription', { count: checkedItems.length })}
                </p>

                {/* 未閲覧項目の警告表示 */}
                {unviewedCheckedCount > 0 && (
                  <div className="p-3 rounded-md bg-amber-500/15 border border-amber-500/30 flex items-start gap-2.5">
                    <AlertTriangle size={16} className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                    <div className="text-xs text-amber-700 dark:text-amber-300 font-medium leading-relaxed">
                      {t('goldenPromotion.confirmDialogUnviewedWarning', {
                        count: unviewedCheckedCount
                      })}
                    </div>
                  </div>
                )}

                <div className="space-y-1.5 max-h-48 overflow-y-auto border border-border rounded-md p-2 divide-y divide-border/50">
                  {checkedItems.map((item) => (
                    <div key={item.id} className="pt-1.5 first:pt-0 flex items-center justify-between text-xs">
                      <span className="font-medium text-foreground truncate">{item.title}</span>
                      <span className="text-[11px] text-muted-foreground font-mono">
                        {item.skillName}
                      </span>
                    </div>
                  ))}
                </div>

                {/* golden を書き換えるのでパスワード（CCPIT_L0_003）。選んだ全件に 1 回の入力 */}
                <GoldenWritePasswordField
                  hasPassword={hasPassword}
                  password={writePassword}
                  onChange={setWritePassword}
                  text={authText}
                  disabled={applying}
                />
              </div>

              <div className="p-4 border-t border-border bg-muted/20 flex items-center justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={applying}
                  onClick={() => {
                    setConfirmOpen(false)
                    clearPassword()
                  }}
                >
                  {t('goldenPromotion.cancel')}
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  disabled={applying || catchingUpSha !== null || !canWrite}
                  onClick={handleApplyPromotion}
                  id="gp-approve-confirm"
                  className="gap-1.5 font-semibold"
                >
                  {applying ? (
                    <>
                      <RefreshCw size={14} className="animate-spin" />
                      {t('goldenPromotion.applying')}
                    </>
                  ) : (
                    <>
                      <Check size={14} />
                      {t('goldenPromotion.confirmDialogButton')}
                    </>
                  )}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* ────────────────────────────────────────────────────────── */}
        {/* 撤去確認モーダル (G-2: Withdraw Confirmation) */}
        {/* ────────────────────────────────────────────────────────── */}
        {withdrawTarget && (
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-xs" onClick={() => !applying && setWithdrawTarget(null)} />
            <div className="relative bg-card border border-border rounded-lg shadow-xl w-full max-w-md mx-4 flex flex-col overflow-hidden">
              <div className="p-4 border-b border-border flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Archive size={18} className="text-destructive" />
                  <h3 className="text-base font-semibold text-foreground">
                    {t('goldenPromotion.confirmWithdrawTitle')}
                  </h3>
                </div>
                <Button variant="ghost" size="icon" disabled={applying} onClick={() => setWithdrawTarget(null)} className="h-7 w-7 text-muted-foreground">
                  <X size={14} />
                </Button>
              </div>
              <div className="p-4 space-y-3 text-xs leading-relaxed text-muted-foreground">
                <p>
                  {t('goldenPromotion.confirmWithdrawDesc', { name: withdrawTarget.title })}
                </p>
                <div className="p-2.5 rounded bg-muted/40 font-mono text-[11px] text-foreground border border-border/50">
                  対象: {withdrawTarget.name} ({withdrawTarget.jaPath})
                </div>
                <GoldenWritePasswordField
                  hasPassword={hasPassword}
                  password={writePassword}
                  onChange={setWritePassword}
                  text={authText}
                  disabled={applying}
                />
              </div>
              <div className="p-3 border-t border-border bg-muted/20 flex items-center justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={applying}
                  onClick={() => {
                    setWithdrawTarget(null)
                    clearPassword()
                  }}
                >
                  {t('goldenPromotion.cancel')}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={applying || catchingUpSha !== null || !canWrite}
                  onClick={() => handleWithdrawSkill(withdrawTarget)}
                  className="font-semibold"
                >
                  {t('goldenPromotion.confirmWithdrawBtn')}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* ────────────────────────────────────────────────────────── */}
        {/* 復帰確認モーダル (G-2: Restore Confirmation) */}
        {/* ────────────────────────────────────────────────────────── */}
        {restoreTarget && (
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-xs" onClick={() => !applying && setRestoreTarget(null)} />
            <div className="relative bg-card border border-border rounded-lg shadow-xl w-full max-w-md mx-4 flex flex-col overflow-hidden">
              <div className="p-4 border-b border-border flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <RotateCcw size={18} className="text-primary" />
                  <h3 className="text-base font-semibold text-foreground">
                    {t('goldenPromotion.confirmRestoreTitle')}
                  </h3>
                </div>
                <Button variant="ghost" size="icon" disabled={applying} onClick={() => setRestoreTarget(null)} className="h-7 w-7 text-muted-foreground">
                  <X size={14} />
                </Button>
              </div>
              <div className="p-4 space-y-3 text-xs leading-relaxed text-muted-foreground">
                <p>
                  {t('goldenPromotion.confirmRestoreDesc', { name: restoreTarget.title })}
                </p>
                <div className="p-2.5 rounded bg-muted/40 font-mono text-[11px] text-foreground border border-border/50">
                  対象: {restoreTarget.name}
                </div>
                <GoldenWritePasswordField
                  hasPassword={hasPassword}
                  password={writePassword}
                  onChange={setWritePassword}
                  text={authText}
                  disabled={applying}
                />
              </div>
              <div className="p-3 border-t border-border bg-muted/20 flex items-center justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={applying}
                  onClick={() => {
                    setRestoreTarget(null)
                    clearPassword()
                  }}
                >
                  {t('goldenPromotion.cancel')}
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  disabled={applying || catchingUpSha !== null || !canWrite}
                  onClick={() => handleRestoreSkill(restoreTarget)}
                  className="font-semibold"
                >
                  {t('goldenPromotion.confirmRestoreBtn')}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* ────────────────────────────────────────────────────────── */}
        {/* 台帳追補の人間承認モーダル (C-3 / ADR 0002) */}
        {/* ────────────────────────────────────────────────────────── */}
        {catchupConfirmTarget && (
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div
              className="absolute inset-0 bg-black/60 backdrop-blur-xs"
              onClick={() => {
                if (catchingUpSha === null) setCatchupConfirmTarget(null)
              }}
            />
            <div className="relative bg-card border border-border rounded-lg shadow-xl w-full max-w-lg mx-4 flex flex-col overflow-hidden">
              <div className="p-4 border-b border-border flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ShieldCheck size={18} className="text-primary" />
                  <h3 className="text-base font-semibold text-foreground">
                    契約 CLI 台帳追補の承認確認
                  </h3>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    if (catchingUpSha === null) setCatchupConfirmTarget(null)
                  }}
                  className="h-7 w-7 text-muted-foreground"
                >
                  <X size={14} />
                </Button>
              </div>

              <div className="p-5 space-y-4 text-xs">
                <p className="text-foreground leading-relaxed">
                  ADR 0002 に準拠し、契約 CLI（Applied-by）によって golden に適用されたが台帳（golden-ledger.json）に未記録であるコミットを正式に追補します。
                </p>

                <div className="p-3.5 rounded-md bg-muted/60 border border-border/70 space-y-2 font-mono text-[11px]">
                  <div>
                    <span className="text-muted-foreground">対象コミット: </span>
                    <span className="text-foreground font-semibold">{catchupConfirmTarget.shortSha}</span>
                    <span className="text-muted-foreground text-[10px] ml-1">({catchupConfirmTarget.sha})</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">コミット件名: </span>
                    <span className="text-foreground">{catchupConfirmTarget.subject}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">適用者: </span>
                    <span className="text-foreground">{catchupConfirmTarget.appliedBy}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">影響スキル: </span>
                    <span className="text-foreground">
                      {catchupConfirmTarget.skillsAffected.length > 0
                        ? catchupConfirmTarget.skillsAffected.join(', ')
                        : '（特定なし）'}
                    </span>
                  </div>
                </div>

                <div className="p-3 rounded-md bg-primary/10 border border-primary/20 text-[11px] text-primary-foreground/90 space-y-1">
                  <p className="font-semibold text-primary">承認者記録（maintainer）:</p>
                  <p className="text-muted-foreground">
                    本操作を実行すると、maintainerによる明示的な GUI 承認操作の事実、時刻、および上記表示内容のハッシュが追補承認記録 MD として記録され、golden-apply 経由で安全に適用されます。
                  </p>
                </div>

                <GoldenWritePasswordField
                  hasPassword={hasPassword}
                  password={writePassword}
                  onChange={setWritePassword}
                  text={authText}
                  disabled={catchingUpSha !== null}
                />
              </div>

              <div className="p-4 border-t border-border flex items-center justify-end gap-2 bg-muted/20">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={catchingUpSha !== null}
                  onClick={() => {
                    setCatchupConfirmTarget(null)
                    clearPassword()
                  }}
                >
                  キャンセル
                </Button>
                <Button
                  size="sm"
                  disabled={catchingUpSha !== null || applying || !canWrite}
                  onClick={() => handleExecuteCatchup(catchupConfirmTarget)}
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  {catchingUpSha !== null ? '追補適用中...' : '承認して台帳追補を実行'}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* ────────────────────────────────────────────────────────── */}
        {/* 結果通知ダイアログ */}
        {/* ────────────────────────────────────────────────────────── */}
        {resultDialog && (
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div
              className="absolute inset-0 bg-black/60 backdrop-blur-xs"
              onClick={() => setResultDialog(null)}
            />
            <div className="relative bg-card border border-border rounded-lg shadow-xl w-full max-w-md mx-4 flex flex-col overflow-hidden">
              <div className="p-4 border-b border-border flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {resultDialog.success ? (
                    <CheckCircle2 size={18} className="text-emerald-500" />
                  ) : (
                    <AlertTriangle size={18} className="text-destructive" />
                  )}
                  <h3 className="text-base font-semibold text-foreground">
                    {resultDialog.title}
                  </h3>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setResultDialog(null)}
                  className="h-7 w-7 text-muted-foreground"
                >
                  <X size={14} />
                </Button>
              </div>

              <div className="p-4 space-y-3 text-xs">
                <p className="text-foreground leading-relaxed">{resultDialog.message}</p>
                {resultDialog.details && (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-muted-foreground text-[11px] uppercase tracking-wider">
                        実行ログ / 詳細
                      </span>
                      {/* 実行ログの全文をクリップボードへ写す（CCPIT_L0_004 W7） */}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        id="gp-copy-runner-log"
                        className="h-6 px-2 gap-1 text-[11px]"
                        title={t('common.copy')}
                        onClick={() => {
                          void copyRunnerLog(resultDialog.details ?? '').then((ok) => {
                            if (!ok) return
                            setRunnerLogCopied(true)
                            setTimeout(() => setRunnerLogCopied(false), RUNNER_LOG_COPIED_FEEDBACK_MS)
                          })
                        }}
                      >
                        {runnerLogCopied ? <Check size={12} /> : <Copy size={12} />}
                        {runnerLogCopied ? t('common.copied') : t('common.copy')}
                      </Button>
                    </div>
                    {/* 暗いテーマでは color-scheme を dark にする。指定が無いと、枠のスクロールバーが明るい既定の描画のまま白く出ていた（W7）。
                        文字を選べるようにする（body は user-select: none） */}
                    <pre
                      id="gp-runner-log"
                      className="p-2 rounded bg-muted/60 text-[11px] font-mono text-muted-foreground max-h-36 overflow-y-auto whitespace-pre-wrap border border-border/50 select-text dark:[color-scheme:dark]"
                    >
                      {resultDialog.details}
                    </pre>
                  </div>
                )}
              </div>

              <div className="p-3 border-t border-border bg-muted/20 flex items-center justify-between">
                <div>
                  {!resultDialog.success && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setResultDialog(null)
                        void loadLeaseStatus()
                        setLeaseModalOpen(true)
                      }}
                      className="text-xs gap-1 border-amber-500/40 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10"
                    >
                      <Lock size={12} />
                      リース状態を確認・回復
                    </Button>
                  )}
                </div>
                <Button variant="outline" size="sm" onClick={() => setResultDialog(null)}>
                  閉じる
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* ────────────────────────────────────────────────────────── */}
        {/* 契約 L リース診断・回復モーダル (What 1〜7) */}
        {/* ────────────────────────────────────────────────────────── */}
        {leaseModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div
              className="absolute inset-0 bg-black/60 backdrop-blur-xs"
              onClick={() => !releasingLease && !cleaningArtifacts && setLeaseModalOpen(false)}
            />
            <div className="relative bg-card border border-border rounded-lg shadow-xl w-full max-w-2xl mx-4 max-h-[85vh] flex flex-col overflow-hidden">
              <div className="p-4 border-b border-border flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Lock size={18} className="text-primary" />
                  <h3 className="text-base font-semibold text-foreground">
                    契約 L リース診断・回復（Crash-safe）
                  </h3>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void loadLeaseStatus()}
                    disabled={loadingLeaseStatus || releasingLease || cleaningArtifacts}
                    className="h-7 text-xs gap-1"
                  >
                    <RefreshCw size={12} className={loadingLeaseStatus ? 'animate-spin' : ''} />
                    再診断
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={releasingLease || cleaningArtifacts}
                    onClick={() => setLeaseModalOpen(false)}
                    className="h-7 w-7 text-muted-foreground"
                  >
                    <X size={14} />
                  </Button>
                </div>
              </div>

              <div className="p-5 space-y-4 text-xs overflow-y-auto flex-1">
                {/* 状態サマリーカード */}
                <div className="p-3.5 rounded-lg bg-muted/40 border border-border flex items-center justify-between">
                  <div className="space-y-1">
                    <span className="font-semibold text-foreground text-sm flex items-center gap-1.5">
                      {leaseStatus?.exists ? (
                        <>
                          <AlertCircle size={16} className="text-amber-500" />
                          アクティブな契約 L リースを検出
                        </>
                      ) : leaseSummaryKind(leaseStatus) === 'read-error' ? (
                        <>
                          <AlertTriangle size={16} className="text-amber-500" />
                          リースの状態を git から読めませんでした
                        </>
                      ) : (
                        <>
                          <CheckCircle2 size={16} className="text-emerald-500" />
                          アクティブなリースはありません (正常)
                        </>
                      )}
                    </span>
                    <p className="text-muted-foreground text-[11px]">
                      {leaseStatus?.exists
                        ? '契約実行機構の排他ロックが保持されています。所有者の生死・有効期限を確認してください。'
                        : leaseSummaryKind(leaseStatus) === 'read-error'
                          ? 'リースが無いのではなく、確かめられていません。解放・清掃はできません（何も変更していません）。'
                          : '他レーンまたは前回の昇格処理による排他ロックは残置していません。'}
                    </p>
                  </div>
                  {leaseStatus?.exists && (
                    <div className="text-right shrink-0">
                      {(() => {
                        const ex = leaseExpiryView(leaseStatus)
                        if (ex.kind === 'expired')
                          return (
                            <span className="px-2 py-1 rounded bg-destructive/20 text-destructive font-bold text-xs border border-destructive/30">
                              期限切れ (失効済み)
                            </span>
                          )
                        if (ex.kind === 'valid')
                          return (
                            <span className="px-2 py-1 rounded bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 font-bold text-xs border border-emerald-500/30">
                              有効 (残り約 {ex.minutes} 分)
                            </span>
                          )
                        return (
                          <span className="px-2 py-1 rounded bg-amber-500/20 text-amber-600 dark:text-amber-400 font-bold text-xs border border-amber-500/30">
                            期限不明
                          </span>
                        )
                      })()}
                    </div>
                  )}
                </div>

                {/* git から読めなかった項目（理由の全文）。警告帯と同じ項目 */}
                {leaseReadWarnings(leaseStatus).map((w) => (
                  <div
                    key={w.key}
                    className="p-2.5 rounded-lg border border-amber-500/30 bg-amber-500/5 text-amber-600 dark:text-amber-400 space-y-1"
                    data-gp-lease-read-warning
                  >
                    <div className="font-medium flex items-center gap-1.5">
                      <AlertTriangle size={13} />
                      {w.label}を git から読めませんでした
                    </div>
                    <div className="font-mono text-[11px] break-all text-muted-foreground">{w.message}</div>
                  </div>
                ))}

                {/* リース存在時の詳細 */}
                {leaseStatus?.exists && (
                  <>
                    {/* 7 キー詳細表 */}
                    <div className="space-y-1.5">
                      <span className="font-semibold text-foreground text-[11px] uppercase tracking-wider flex items-center gap-1">
                        <FileText size={12} />
                        契約 L リース情報（7キー検証）
                      </span>
                      <div className="border border-border rounded-lg overflow-hidden font-mono text-[11px]">
                        <div className="grid grid-cols-3 divide-x divide-border border-b border-border bg-muted/50 p-1.5 font-sans font-semibold text-muted-foreground">
                          <div>項目</div>
                          <div className="col-span-2">値</div>
                        </div>
                        <div className="grid grid-cols-3 divide-x divide-border border-b border-border p-1.5">
                          <div className="text-muted-foreground font-sans">Lease ID (git blob)</div>
                          <div className="col-span-2 text-foreground break-all">{leaseStatus.leaseId}</div>
                        </div>
                        <div className="grid grid-cols-3 divide-x divide-border border-b border-border p-1.5">
                          <div className="text-muted-foreground font-sans">レーン (lane)</div>
                          <div className="col-span-2 text-foreground">{leaseStatus.blob?.lane || '不明'}</div>
                        </div>
                        <div className="grid grid-cols-3 divide-x divide-border border-b border-border p-1.5">
                          <div className="text-muted-foreground font-sans">発行者 (issued_by)</div>
                          <div className="col-span-2 text-foreground">{leaseStatus.blob?.issued_by || '不明'}</div>
                        </div>
                        <div className="grid grid-cols-3 divide-x divide-border border-b border-border p-1.5">
                          <div className="text-muted-foreground font-sans">発行日時 (issued_at)</div>
                          <div className="col-span-2 text-foreground">{leaseStatus.blob?.issued_at || '不明'}</div>
                        </div>
                        <div className="grid grid-cols-3 divide-x divide-border border-b border-border p-1.5">
                          <div className="text-muted-foreground font-sans">失効日時 (expires_at)</div>
                          <div className="col-span-2 text-foreground">{leaseStatus.blob?.expires_at || '不明'}</div>
                        </div>
                        <div className="grid grid-cols-3 divide-x divide-border border-b border-border p-1.5">
                          <div className="text-muted-foreground font-sans">基底 master (base_master)</div>
                          <div className="col-span-2 text-foreground flex items-center gap-1.5">
                            <span>{leaseStatus.blob?.base_master?.slice(0, 8) || '不明'}</span>
                            {leaseStatus.currentMasterMatches === true && (
                              <span className="text-emerald-500 font-sans text-[10px] font-semibold">(現在の master と一致)</span>
                            )}
                            {leaseStatus.currentMasterMatches === false && (
                              <span className="text-amber-500 font-sans text-[10px] font-semibold">(現在の master と不一致)</span>
                            )}
                          </div>
                        </div>
                        <div className="grid grid-cols-3 divide-x divide-border border-b border-border p-1.5">
                          <div className="text-muted-foreground font-sans">MANIFEST SHA-256</div>
                          <div className="col-span-2 text-foreground break-all">{leaseStatus.blob?.manifest_sha256 || '不明'}</div>
                        </div>
                        <div className="grid grid-cols-3 divide-x divide-border p-1.5">
                          <div className="text-muted-foreground font-sans">セッション (session8)</div>
                          <div className="col-span-2 text-foreground">{leaseStatus.blob?.session8 || '不明'}</div>
                        </div>
                      </div>
                    </div>

                    {/* 所有者プロセスおよび早期解放適格性の診断 */}
                    <div className="space-y-1.5">
                      <span className="font-semibold text-foreground text-[11px] uppercase tracking-wider flex items-center gap-1">
                        <Activity size={12} />
                        所有者プロセス診断 & 早期解放資格（追補条項 L-b）
                      </span>
                      <div className="p-3 rounded-lg border border-border bg-card space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-muted-foreground">ローカル実行記録:</span>
                          <span className="font-mono text-foreground font-medium">
                            {leaseStatus.matchingRunRecord
                              ? `PID: ${leaseStatus.matchingRunRecord.pid} (Run: ${leaseStatus.matchingRunRecord.runId.slice(0, 8)})`
                              : '記録なし（他PCまたは外部レーン発行）'}
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-muted-foreground">所有者プロセス生死判定:</span>
                          <span>
                            {leaseStatus.isOwnerAlive === true ? (
                              <strong className="text-amber-500 flex items-center gap-1">
                                <Activity size={12} /> 生存中 (実行中)
                              </strong>
                            ) : leaseStatus.isOwnerAlive === false ? (
                              <strong className="text-emerald-500 flex items-center gap-1">
                                <CheckCircle2 size={12} /> 死亡確認済み (プロセス非存在)
                              </strong>
                            ) : (
                              <span className="text-muted-foreground">判定不能（PID未特定）</span>
                            )}
                          </span>
                        </div>
                        <div className="flex items-start justify-between border-t border-border pt-2">
                          <span className="text-muted-foreground">早期解放資格 (What 5):</span>
                          <div className="text-right">
                            {leaseStatus.earlyReleaseEntitlement?.entitled ? (
                              <span className="text-emerald-500 font-bold flex items-center gap-1 justify-end">
                                <CheckCircle2 size={13} /> 適格（安全に早期解放可能）
                              </span>
                            ) : (
                              <span className="text-amber-500 font-semibold flex items-center gap-1 justify-end">
                                <AlertTriangle size={13} /> 不適格 ({leaseStatus.earlyReleaseEntitlement?.reason || '条件未達'})
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  </>
                )}

                {/* 孤立 worktree / 残骸の診断 */}
                <div className="space-y-1.5">
                  <span className="font-semibold text-foreground text-[11px] uppercase tracking-wider flex items-center gap-1">
                    <Trash2 size={12} />
                    残骸検査 (孤立 worktree / 一時ブランチ)
                  </span>
                  {leaseStatus?.worktreeReadError ? (
                    <div
                      className="p-2.5 rounded-lg border border-amber-500/30 bg-amber-500/5 text-amber-600 dark:text-amber-400 space-y-1"
                      data-gp-worktree-read-error
                    >
                      <div className="font-medium flex items-center gap-1.5">
                        <AlertTriangle size={13} />
                        残置 worktree の一覧を git から読めませんでした（「検出されなかった」ではありません）
                      </div>
                      <div className="font-mono text-[11px] break-all text-muted-foreground">
                        {leaseStatus.worktreeReadError}
                      </div>
                    </div>
                  ) : (leaseStatus?.orphanedWorktrees?.length || 0) > 0 ? (
                    <div className="p-2.5 rounded-lg border border-amber-500/30 bg-amber-500/5 space-y-2">
                      <div className="flex items-center justify-between text-amber-600 dark:text-amber-400 font-medium">
                        <span>検出された残置 worktree: {leaseStatus?.orphanedWorktrees?.length} 件</span>
                      </div>
                      <div className="space-y-1 font-mono text-[11px]">
                        {leaseStatus?.orphanedWorktrees?.map((wt, i) => (
                          <div key={i} className="p-1.5 rounded bg-muted/60 text-muted-foreground break-all border border-border">
                            {wt.path} ({wt.branch})
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="p-2.5 rounded-lg border border-border bg-muted/20 text-muted-foreground flex items-center gap-1.5">
                      <CheckCircle2 size={13} className="text-emerald-500" />
                      <span>孤立した worktree は検出されませんでした。</span>
                    </div>
                  )}
                </div>
              </div>

              {/* 解放・清掃は golden の repo の ref・ブランチを消すのでパスワード（CCPIT_L0_003） */}
              <div className="px-3 pt-3 border-t border-border bg-muted/20">
                <GoldenWritePasswordField
                  hasPassword={hasPassword}
                  password={writePassword}
                  onChange={setWritePassword}
                  text={authText}
                  disabled={releasingLease || cleaningArtifacts}
                />
              </div>

              {/* フッター操作ボタン群 */}
              <div className="p-3 bg-muted/20 flex items-center justify-between">
                <div className="text-[11px] text-muted-foreground">
                  安全第一: 解放操作はすべて CAS によりアトミックに検証されます
                </div>
                <div className="flex items-center gap-2">
                  {/* 残骸清掃ボタン (What 3) */}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={cleaningArtifacts || releasingLease || leaseStatus?.exists || !!leaseStatus?.readError || !canWrite}
                    onClick={handleCleanupArtifacts}
                    className="gap-1 text-xs"
                    title={
                      leaseStatus?.exists
                        ? 'リース解放後に清掃可能です'
                        : leaseStatus?.readError
                          ? 'リースの状態を git から読めないため、清掃できません'
                          : '残骸を清掃します'
                    }
                  >
                    <Trash2 size={13} />
                    {cleaningArtifacts ? '清掃中...' : '残骸を清掃'}
                  </Button>

                  {/* 失効後解放ボタン (What 2) */}
                  {leaseStatus?.exists && (
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={releasingLease || !leaseStatus.isExpired || !canWrite}
                      onClick={handleReleaseExpiredLease}
                      className="gap-1 text-xs font-semibold"
                      title={!leaseStatus.isExpired ? '失効時刻（6時間経過）後に活性化します' : '失効したリースを解放します'}
                    >
                      <Lock size={13} />
                      {releasingLease ? '解放中...' : '失効後解放'}
                    </Button>
                  )}

                  {/* 早期解放ボタン (What 7) */}
                  {leaseStatus?.exists && (
                    <Button
                      variant="default"
                      size="sm"
                      disabled={releasingLease || !leaseStatus.earlyReleaseEntitlement?.entitled || !canWrite}
                      onClick={handleExecuteEarlyReleaseLease}
                      className="gap-1 text-xs font-semibold bg-amber-600 hover:bg-amber-700 text-white"
                      title={
                        !leaseStatus.earlyReleaseEntitlement?.entitled
                          ? leaseStatus.earlyReleaseEntitlement?.reason || '早期解放条件を満たしていません'
                          : '所有者プロセス死亡確認に基づき、maintainer承認を経て即時解放します'
                      }
                    >
                      <ShieldAlert size={13} />
                      {releasingLease ? '早期解放中...' : '即時早期解放 (所有者死亡)'}
                    </Button>
                  )}

                  <Button variant="outline" size="sm" onClick={() => setLeaseModalOpen(false)}>
                    閉じる
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </TooltipProvider>
  )
}
