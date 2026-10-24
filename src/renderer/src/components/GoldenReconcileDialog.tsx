import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from './ui/button'
import {
  allowedChoices,
  buildDecisions,
  classifyImpact,
  consultLaunchFailure,
  consultPaths,
  defaultAction,
  proposePaths,
  remainingAfterResolve,
  summarizeResolve,
  uniformDecisions,
  type ConsultLaunchLike,
  type PendingEntry,
  type ReconcileDecision,
  type ResolveOutcome,
  type ResolveResultLike,
  type RowChoice
} from '../lib/goldenReconcilePlan'

/**
 * 起動時照合（§9.4 / P5）の確認ダイアログ。
 *
 * 背景:
 *   起動時に goldenReconcileService が三方向照合を行い、無確認で適用してよいもの
 *   （unchanged / auto-update）は main 側で適用済み。ユーザー判断が要るもの
 *   （user-modified / conflict / restore など）だけが pending として main に残る。
 *   本ダイアログはその pending をユーザーに提示し、行ごとの出口を確定させる。
 *
 * 設計上の決定（ConfirmDialog との差分は意図的）:
 *
 *   1. 背景クリック / ESC で閉じない。
 *      閉じられると「実行もしないが記録も残さない」という経路が暗黙に生まれる。
 *      ConfirmDialog は背景クリック = onCancel だが、ここでは意図的に採用しない。
 *
 *   2. 行ごとに出口を選ぶ。ただし**未設定状態は作らない**（ADR 0002）。
 *      旧実装は「提示集合そのものへの all-or-nothing 承認」だった。その意図は
 *      「チェックボックスで部分状態を作ると仕様外の状態が増える」＝**未定義状態**の忌避で
 *      あって、粒度の否定ではない。ここでは各行が常に 1 つの出口を持ち（未選択は既定へ落ちる）、
 *      「選ばれていない行」という曖昧な状態を表現できない。
 *      出口の既定は危険度から機械的に決まるので、既定でよければ操作は「実行」1 回で済む。
 *
 *   3. 書込経路は 1 本（`goldenResolveReconcile`）。
 *      出口が増えても「承認と要求の組み立ては 1 か所」という不変条件を守る。
 *      行ごとに別 IPC を叩くと部分成功が UI と main に散らばり、049 の誤報が再発する。
 *
 *   4. 失敗時は自動で閉じない（D7: 黙って落とさない）。
 *      failed / blocked / 未解決があれば結果パネルに切り替えて必ず可視化する。
 *
 *   native dialog (window.confirm) を使わない理由は ConfirmDialog の comment を参照。
 */

// 行の型（PendingEntry）と結果の型（ResolveResultLike）、および
// 「何を要求するか」「閉じてよいか」「何が残っているか」の判断は ../lib/goldenReconcilePlan に置いた。
// ここで再宣言すると、判断のテストが .tsx 側の写しと乖離しても気付けない。

interface GoldenReconcileDialogProps {
  /** 起動シーケンスが落ち着き、確認を出してよい状態か（Setup ウィザード中などは false） */
  enabled: boolean
}

export function GoldenReconcileDialog({
  enabled
}: GoldenReconcileDialogProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<PendingEntry[] | null>(null)
  const [chosen, setChosen] = useState<Record<string, RowChoice>>({})
  const [consultResult, setConsultResult] = useState<ConsultLaunchLike | null>(null)
  const [report, setReport] = useState<ResolveResultLike | null>(null)
  /** 実行結果の要約。report と必ず同時に立てる（片方だけでは判断根拠を失う） */
  const [outcome, setOutcome] = useState<ResolveOutcome | null>(null)
  const [busy, setBusy] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [undoRestored, setUndoRestored] = useState(false)

  // D3: main から push させず renderer 側から取りに行く pull。
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void (async () => {
      try {
        const pending = await window.api.goldenPendingReconcile()
        if (!cancelled) setEntries(pending)
      } catch (err) {
        // 取得自体が失敗した場合、pending は main 側に残り次回起動で再導出される。
        // ここでモーダルを出しても操作対象が無いので、記録だけ残して黙って出さない。
        console.error('[GoldenReconcileDialog] failed to pull pending reconcile', err)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [enabled])

  const runDecisions = useCallback(
    async (
      decisions: ReconcileDecision[],
      launchedConsult?: ConsultLaunchLike,
      toPropose?: string[]
    ): Promise<void> => {
      if (decisions.length === 0) return
      setBusy(true)
      try {
        const res = await window.api.goldenResolveReconcile(
          decisions,
          toPropose && toPropose.length > 0 ? { proposePaths: toPropose } : undefined
        )
        const summary = summarizeResolve(decisions, res)
        if (summary.mustSurface) {
          // 要求した全行が意図どおりの出口へ着いたときだけ閉じてよい。
          setOutcome(summary)
          setReport(res) // D7: 失敗は必ず見せる
        } else if (summary.didPromote || res.proposeResults) {
          // 反映したときや提案起票したときは「どこへ残ったか」を必ず見せる。
          setOutcome(summary)
          setReport(res)
        } else if (launchedConsult?.ok) {
          // AC8: 相談起動成功時もダイアログを閉じず、パケット所在・適用引数・拒否設定・作業後手順を見せる
          setOutcome(summary)
          setReport(res)
        } else {
          setDismissed(true)
        }
      } catch (err) {
        const failure: ResolveResultLike = {
          applied: [],
          promoted: [],
          unmanaged: [],
          deferred: [],
          failed: [{ path: '*', message: err instanceof Error ? err.message : String(err) }],
          backups: [],
          skipped: [],
          overlayDir: '',
          overlayDurable: true,
          manifestUpdated: false
        }
        setOutcome(summarizeResolve(decisions, failure))
        setReport(failure)
      } finally {
        setBusy(false)
      }
    },
    []
  )

  // 承認と要求の組み立ては buildDecisions ただ 1 か所。
  const handleExecute = useCallback(async (): Promise<void> => {
    if (!entries || entries.length === 0) return
    const toConsult = consultPaths(entries, chosen)
    const toPropose = proposePaths(entries, chosen)
    let launched: ConsultLaunchLike | undefined
    if (toConsult.length > 0) {
      setBusy(true)
      try {
        const cRes = await window.api.goldenLaunchMergeConsult({ paths: toConsult })
        setConsultResult(cRes)
        launched = cRes
        if (!cRes.ok) {
          const { report: fReport, outcome: fOutcome } = consultLaunchFailure(
            toConsult,
            cRes.error ?? 'failed to launch merge consult'
          )
          setOutcome(fOutcome)
          setReport(fReport)
          return
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const { report: fReport, outcome: fOutcome } = consultLaunchFailure(toConsult, msg)
        setOutcome(fOutcome)
        setReport(fReport)
        return
      } finally {
        setBusy(false)
      }
    }
    await runDecisions(buildDecisions(entries, chosen), launched, toPropose)
  }, [entries, chosen, runDecisions])

  // 直前の上書きを元に戻す（アンドゥ）
  const handleUndoLastApply = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const generations = await window.api.goldenListUndoGenerations()
      const latest = generations.find((g) => g.isLatest)
      if (!latest) return
      const requests = latest.files
        .filter((f) => f.canRestore)
        .map((f) => ({
          rel: f.rel,
          generationStamp: latest.generationStamp
        }))
      if (requests.length === 0) return
      await window.api.goldenRestoreUndoBackups(requests)
      setUndoRestored(true)
    } catch (err) {
      console.error('[GoldenReconcileDialog] failed to undo', err)
    } finally {
      setBusy(false)
    }
  }, [])

  // 「後で（全件）」は D3 の権利をそのまま残したもの。
  const handleDeferAll = useCallback(async (): Promise<void> => {
    if (!entries || entries.length === 0) return
    await runDecisions(uniformDecisions(entries, 'defer'))
  }, [entries, runDecisions])

  const rows = useMemo(
    () =>
      (entries ?? []).map((e) => {
        const impact = classifyImpact(e)
        return {
          entry: e,
          impact,
          options: allowedChoices(impact),
          action: chosen[e.path] ?? defaultAction(impact)
        }
      }),
    [entries, chosen]
  )

  if (!enabled || dismissed) return null
  if (entries === null || entries.length === 0) return null

  const backupCount = rows.filter((r) => r.entry.willBackup && r.action === 'apply').length

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center">
      {/* 背景クリックでは閉じない（上記 設計上の決定 1） */}
      <div className="absolute inset-0 bg-black/50" />
      <div className="relative bg-card border border-border rounded-lg shadow-lg w-full max-w-3xl mx-4 flex flex-col">
        {report && outcome ? (
          <>
            <div className="px-6 pt-5 pb-2">
              <h3 className="text-base font-semibold">{t('goldenReconcile.reportTitle')}</h3>
            </div>
            <div className="px-6 py-4 space-y-3">
              {report.blocked && (
                <p className="text-sm text-destructive">
                  {t(`goldenReconcile.blocked.${report.blocked}`)}
                </p>
              )}
              <p className="text-sm text-muted-foreground">
                {t('goldenReconcile.resolveSummary', {
                  requested: outcome.counts.requested,
                  applied: outcome.counts.applied,
                  promoted: outcome.counts.promoted,
                  unmanaged: outcome.counts.unmanaged,
                  deferred: outcome.counts.deferred,
                  backups: outcome.counts.backups
                })}
              </p>
              {outcome.didPromote && (
                <div className="rounded border border-border bg-muted/30 px-3 py-2 space-y-1">
                  <p className="text-xs text-foreground">
                    {t('goldenReconcile.promotedNote', { n: outcome.counts.promoted })}
                  </p>
                  <p className="text-xs font-mono break-all text-muted-foreground">
                    {report.overlayDir}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {report.overlayDurable
                      ? t('goldenReconcile.promotedDurable')
                      : t('goldenReconcile.promotedVolatile')}
                  </p>
                </div>
              )}
              {consultResult && consultResult.ok && (
                <div className="rounded border border-border bg-muted/30 px-3 py-2 space-y-1">
                  <p className="text-xs text-foreground">
                    {t('goldenReconcile.consultLaunched', {
                      path: consultResult.promptFilePath ?? ''
                    })}
                  </p>
                  {consultResult.appliedFlags && consultResult.appliedFlags.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {t('goldenReconcile.consultFlags', {
                        flags: consultResult.appliedFlags.join(' ')
                      })}
                    </p>
                  )}
                  {consultResult.rejectedSettings && consultResult.rejectedSettings.length > 0 && (
                    <p className="text-xs text-destructive">
                      {t('goldenReconcile.consultRejected', {
                        rejected: consultResult.rejectedSettings.join(', ')
                      })}
                    </p>
                  )}
                </div>
              )}
              {report.proposeResults && (
                <div className="rounded border border-border bg-muted/30 px-3 py-2 space-y-1">
                  <p className="text-xs font-semibold text-foreground">
                    {t('goldenReconcile.proposeLaunched')}
                  </p>
                  <p className="text-xs font-mono break-all text-muted-foreground">
                    {report.proposeResults.packetPath}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t('goldenReconcile.proposeAutoExitNote')}
                  </p>
                  {report.proposeResults.sanitizedSummaries?.some((s) => s.attentionCount > 0) && (
                    <p className="text-xs text-yellow-600">
                      {t('goldenReconcile.proposeAttentionNote')}
                    </p>
                  )}
                </div>
              )}
              {consultResult && consultResult.ok && report.proposeResults && (
                <p className="text-xs text-muted-foreground">
                  {t('goldenReconcile.proposeConsultMixedNote')}
                </p>
              )}
              {report.failed.length > 0 && (
                <div className="space-y-1">
                  <p className="text-sm font-medium text-destructive">
                    {t('goldenReconcile.failedTitle', { n: report.failed.length })}
                  </p>
                  <ul className="max-h-40 overflow-auto space-y-1">
                    {report.failed.map((f) => (
                      <li key={f.path} className="text-xs">
                        <span className="font-mono break-all">{f.path}</span>
                        <span className="text-destructive"> — {f.message}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {outcome.unresolved.length > 0 && (
                <div className="space-y-1">
                  <p className="text-sm font-medium text-destructive">
                    {t('goldenReconcile.unresolvedTitle', { n: outcome.unresolved.length })}
                  </p>
                  {/* 未解決分は元の行のまま見せる。ここで行を組み直すと case / owner を
                      推測で埋めることになり、それ自体が新しい虚偽記録になる。 */}
                  <ul className="max-h-40 overflow-auto rounded border border-border divide-y divide-border">
                    {remainingAfterResolve(entries, outcome).map((e) => (
                      <li key={e.path} className="flex items-center gap-2 px-3 py-2">
                        <span className="font-mono text-xs break-all flex-1">{e.path}</span>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {t(`goldenReconcile.impact.${classifyImpact(e)}`)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {report.skipped.length > 0 && (
                    <ul className="max-h-32 overflow-auto space-y-1">
                      {report.skipped.map((s) => (
                        <li key={`${s.path}:${s.reason}`} className="text-xs text-muted-foreground">
                          <span className="font-mono break-all">{s.path}</span>
                          <span> — {t(`goldenReconcile.skipReason.${s.reason}`)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
            <div className="flex gap-2 justify-between items-center px-6 pb-5">
              <div>
                {(report.backups.length > 0 || (outcome && outcome.counts.applied > 0)) && (
                  undoRestored ? (
                    <span className="text-xs text-green-600 font-medium">
                      {t('goldenReconcile.undoSuccess')}
                    </span>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => void handleUndoLastApply()}
                    >
                      {t('goldenReconcile.undoApply')}
                    </Button>
                  )
                )}
              </div>
              <Button onClick={() => setDismissed(true)}>{t('common.ok')}</Button>
            </div>
          </>
        ) : (
          <>
            <div className="px-6 pt-5 pb-2">
              <h3 className="text-base font-semibold">{t('goldenReconcile.title')}</h3>
            </div>
            <div className="px-6 py-4 space-y-3">
              <p className="text-sm text-foreground">
                {t('goldenReconcile.description', { n: entries.length })}
              </p>
              <ul className="max-h-72 overflow-auto rounded border border-border divide-y divide-border">
                {rows.map((r) => (
                  <li key={r.entry.path} className="px-3 py-2 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs break-all flex-1">{r.entry.path}</span>
                      <select
                        className="text-xs bg-background border border-border rounded px-2 py-1 shrink-0"
                        disabled={busy}
                        value={r.action}
                        onChange={(ev) =>
                          setChosen((prev) => ({
                            ...prev,
                            [r.entry.path]: ev.target.value as RowChoice
                          }))
                        }
                      >
                        {r.options.map((a) => (
                          <option key={a} value={a}>
                            {t(`goldenReconcile.action.${a}`)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium shrink-0">
                        {t(`goldenReconcile.impact.${r.impact}`)}
                      </span>
                      <span className="text-xs text-muted-foreground flex-1">
                        {t(`goldenReconcile.impactHint.${r.impact}`)}
                      </span>
                      <span className="text-xs text-muted-foreground shrink-0">
                        {t(`goldenReconcile.case.${r.entry.case}`)} /{' '}
                        {t(`goldenReconcile.owner.${r.entry.owner}`)}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground bg-muted/20 px-2 py-1 rounded">
                      <span className="font-semibold text-foreground/80">{t(`goldenReconcile.action.${r.action}`)}: </span>
                      {t(`goldenReconcile.actionDescription.${r.action}`)}
                    </div>
                  </li>
                ))}
              </ul>
              {backupCount > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t('goldenReconcile.backupNote', { n: backupCount })}
                </p>
              )}
            </div>
            <div className="flex gap-2 justify-end px-6 pb-5">
              <Button variant="outline" disabled={busy} onClick={() => void handleDeferAll()}>
                {t('goldenReconcile.later')}
              </Button>
              <Button disabled={busy} onClick={() => void handleExecute()}>
                {t('goldenReconcile.execute')}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
