/**
 * composeStatusView — 合成の進み具合（ComposeStatusDto）を、カードに出す文面と次の操作へ変換する純関数（T4・T7）。
 * ja/en の両方を返す。次の操作は 1 つに絞る（昇格画面で開く／待つ／失敗の理由を見て合成をやり直す）。
 */

import { ADOPTED_COMMIT_SHORT_LEN } from '../../../shared/composeContract'

/** none ＝ 昇格済み（終端）。合成の流れは次の操作を持たず、合成の開始ボタンを戻す */
export type ComposeNextAction = 'wait' | 'openPromotion' | 'retry' | 'reviewInCandidates' | 'revise' | 'none'

export interface ComposeStatusView {
  /** 状態の見出し */
  headline: string
  /** 補足（失敗の理由・レビュー結果・適応の一覧） */
  detail: string[]
  next: ComposeNextAction
  /** 昇格画面で選択済みにする提案の request_id（next が openPromotion のとき） */
  compositeId?: string
  /** 取り消せるか（進行中・検査中のみ） */
  cancellable: boolean
}

type Dto = {
  phase: 'running' | 'finalizing' | 'reviewing' | 'registered' | 'failed' | 'cancelled'
  skillName: string
  compositeRequestId: string
  /** 案件の作業場だけが持つ。カードの状態（composeCaseView.ts が文面を決める）。フローの段の判定に使う */
  caseView?: string
  /** 元提案の request_id（AC19: 1 本のときだけ「元提案 1 本」を添える） */
  sourceIds?: string[]
  sourceCount?: number
  /** 改訂の合成のとき、置き換える旧合成提案の ID（失敗・取り消しでも、同じ改訂をやり直せるように） */
  revises?: string
  /** 選ばなかった提案の request_id（この合成の昇格が終わるまで昇格候補から外れる） */
  excludedIds?: string[]
  /** 昇格済みの印（main が合成台帳の application から付ける。案件・旧形式の両方） */
  adopted?: { commit: string }
  result?: {
    ok: boolean
    stage?: string
    error?: string
    compositeId?: string
    adapted?: Array<{
      key: string
      sourceId: string
      relPath: string
      lang: 'ja' | 'en'
      reason: string
      preview: string
    }>
    review?: { status: string; verdict?: string; message?: string }
  }
}

export function composeStatusView(s: Dto, ja: boolean): ComposeStatusView {
  // 昇格済みは終端。選ばなかった提案も昇格の完了で外れが解けているので、その補足は足さない
  if (s.adopted) {
    return {
      headline: adoptedHeadline(s.adopted.commit, ja),
      detail: [adoptedNextLine(ja)],
      next: 'none',
      compositeId: s.result?.compositeId ?? s.compositeRequestId,
      cancellable: false
    }
  }
  const view = composeStatusViewBase(s, ja)
  // 選ばなかった提案があるときは、外れている理由と戻り方を補足に足す（失敗・取り消しでは外れていないので足さない）
  const line = excludedIdsLine(s.phase, s.excludedIds ?? [], ja)
  if (line) view.detail = [...view.detail, line]
  return view
}

/** コミットの短縮表記（7 桁） */
export function shortCommit(commit: string): string {
  return commit.slice(0, ADOPTED_COMMIT_SHORT_LEN)
}

/** 昇格済みの主文（旧形式のカードと案件のカードで同じ文面） */
export function adoptedHeadline(commit: string, ja: boolean): string {
  const c = shortCommit(commit)
  return ja
    ? `昇格しました。golden（ja・en）と手元へ入っています（golden commit ${c}）。`
    : `Promoted. It is in golden (ja and en) and your copy (golden commit ${c}).`
}

/** 昇格済みの「次に起きること」（合成の流れはここで終わり、次の提案は合成の開始ボタンから） */
export function adoptedNextLine(ja: boolean): string {
  return ja
    ? 'この合成は終わりました。次の提案は「合成して golden へ入れる」から始められます。'
    : 'This composition is finished. Start the next proposal with "Merge into the golden version (AI-assisted)".'
}

/**
 * 合成の流れがカードの主操作を持っているか（持っているときは、合成の開始ボタン composeGoldenMerge を重ねて出さない）。
 * 昇格済みは終端で主操作を持たないので、案件・旧形式とも false（開始ボタンが戻る）。
 * それ以外は従来の規則: 案件で取消・失敗以外なら持つ。または次の操作が待つ・昇格画面で開く・改訂なら持つ。
 * caseViewOf は composeCaseView.ts の deriveCaseView（循環 import を避けて引数で受ける）。
 */
export function composeFlowOwnsPrimary<
  S extends { caseId?: string; phase: string; adopted?: { commit: string } }
>(st: S | null, view: Pick<ComposeStatusView, 'next'> | null, caseViewOf: (s: S) => string): boolean {
  if (st?.adopted) return false
  const cv = st?.caseId ? caseViewOf(st) : null
  if (cv === 'adopted') return false
  const caseOwns = cv !== null && cv !== 'cancelled' && cv !== 'failed'
  return (
    caseOwns ||
    (!!view && (view.next === 'wait' || view.next === 'openPromotion' || view.next === 'revise'))
  )
}

/**
 * 選ばなかった提案が昇格候補から外れていることの補足 1 行（無ければ null）。旧形式のカードと案件のカードで共有する。
 * 失敗・取り消しでは外れていないので出さない。
 */
export function excludedIdsLine(
  phase: Dto['phase'],
  excludedIds: readonly string[],
  ja: boolean
): string | null {
  if (
    excludedIds.length === 0 ||
    !(phase === 'running' || phase === 'finalizing' || phase === 'reviewing' || phase === 'registered')
  ) {
    return null
  }
  const list = excludedIds.join(ja ? '、' : ', ')
  return ja
    ? phase === 'registered'
      ? `選ばなかった提案（${list}）は、この合成の昇格が終わる（または合成を却下する）まで昇格候補から外れています。終わると「提案が古い」として戻ります。`
      : `選ばなかった提案（${list}）は、合成が登録されると、その昇格が終わるまで昇格候補から外れます。`
    : phase === 'registered'
      ? `Unchosen proposals (${list}) are set aside until this composite is promoted (or rejected). After that they return as out of date.`
      : `Unchosen proposals (${list}) will be set aside from promotion candidates once the composite is registered, until it is promoted.`
}

function composeStatusViewBase(s: Dto, ja: boolean): ComposeStatusView {
  const L = (j: string, e: string): string => (ja ? j : e)
  switch (s.phase) {
    case 'running':
      return {
        headline: L(
          '合成中：Claude Code が作業場で合成提案を作っています。選択肢が出たら、そのウィンドウで選んでください。',
          'Composing: Claude Code is building the composed proposal in the workspace. Answer its choices in that window.'
        ),
        detail: [],
        next: 'wait',
        cancellable: true
      }
    case 'finalizing':
      return {
        headline: L(
          '検査中：書込み範囲・元提案の変更の保持・golden の変化を CCPIT が検査しています。',
          'Checking: CCPIT is verifying the write scope, preserved changes and golden drift.'
        ),
        detail: [],
        next: 'wait',
        cancellable: true
      }
    case 'reviewing':
      // 旧形式（巡を持たない作業場）では来ない想定。来たら検査中と同じ扱い（取り消せる・待つ）で、段の名前だけ変える
      return {
        headline: L(
          'レビュー中：独立レビュー（Codex）が golden との差分を審査しています。',
          'Reviewing: the independent review (Codex) is examining the changes against golden.'
        ),
        detail: [],
        next: 'wait',
        cancellable: true
      }
    case 'cancelled':
      return {
        headline: L('取り消しました。', 'Cancelled.'),
        detail: [],
        next: s.revises ? 'revise' : 'retry',
        ...(s.revises ? { compositeId: s.revises } : {}),
        cancellable: false
      }
    case 'failed':
      return {
        headline: L('合成は登録されませんでした。', 'The composition was not registered.'),
        detail: [
          `${s.result?.stage ? `[${s.result.stage}] ` : ''}${s.result?.error ?? ''}`.trim(),
          L(
            'golden・手元には何も書かれていません（範囲外へ書かれた場合は元に戻してあります）。合成をやり直してください。',
            'Nothing was written to golden or your files (anything written outside scope was reverted). Start the composition again.'
          )
        ].filter(Boolean),
        next: s.revises ? 'revise' : 'retry',
        ...(s.revises ? { compositeId: s.revises } : {}),
        cancellable: false
      }
    case 'registered': {
      const r = s.result
      const adapted = (r?.adapted ?? []).map(
        (a) =>
          `${a.sourceId} ${a.lang === 'en' ? 'en:' : ''}${a.relPath}: ${a.preview}${a.reason ? ` — ${a.reason}` : ''}`
      )
      const detail: string[] = []
      if (adapted.length > 0) {
        detail.push(
          L(
            `元提案をそのままの形では載せなかった所（あなたが選んだ適応）: ${adapted.length} 件`,
            `Adaptations you approved (not kept verbatim): ${adapted.length}`
          ),
          ...adapted
        )
      }
      const rv = r?.review
      if (rv?.status === 'ok' && rv.verdict === 'approve') {
        return {
          headline: L(
            '登録しました。独立レビューは approve です。昇格画面で承認すると golden（ja・en）と手元へ入ります。',
            'Registered. The independent review approved it. Approve it in the promotion screen to apply it to golden (ja and en) and your copy.'
          ),
          detail,
          next: 'openPromotion',
          compositeId: r?.compositeId ?? s.compositeRequestId,
          cancellable: false
        }
      }
      detail.push(
        rv
          ? rv.status === 'ok'
            ? L(
                `独立レビューは「${rv.verdict}」でした。指摘は下の「指摘を反映して改訂する」で AI が反映します。`,
                `The independent review returned "${rv.verdict}". Use "Revise with the findings" below to have the AI address them.`
              )
            : L(
                `独立レビューを実行できませんでした: ${rv.message ?? rv.status}`,
                `The independent review could not run: ${rv.message ?? rv.status}`
              )
          : L(
              '独立レビューはまだ実行されていません。Skill 候補ブラウザからレビューを実行してください。',
              'No independent review has run yet. Run it from the Skill candidate browser.'
            )
      )
      // 指摘が出た（approve 以外でレビューが走った）登録済みの合成提案は、指摘を反映して改訂できる
      const canRevise = rv?.status === 'ok' && rv.verdict !== 'approve'
      return {
        headline: canRevise
          ? L(
              '登録しました。独立レビューの指摘があるため、昇格にはまだ進めません。「指摘を反映して改訂する」で、同じ経路で再合成・再レビューできます（旧の合成提案は残り、昇格候補にはなりません）。',
              'Registered, but the independent review raised findings, so it cannot be promoted yet. "Revise with the findings" re-composes and re-reviews it through the same route (the previous composite stays, and is not a promotion candidate).'
            )
          : L(
              '登録しました。昇格には独立レビューの approve が要ります。',
              'Registered. Promotion needs an approving independent review.'
            ),
        detail,
        next: canRevise ? 'revise' : 'reviewInCandidates',
        compositeId: r?.compositeId ?? s.compositeRequestId,
        cancellable: false
      }
    }
  }
}

export type ComposeFlowStepKey = 'compose' | 'review' | 'approve'
export type ComposeFlowStepState = 'done' | 'current' | 'todo' | 'attention'

export interface ComposeFlowStep {
  key: ComposeFlowStepKey
  label: string
  state: ComposeFlowStepState
}

/**
 * 合成〜昇格の 3 段（合成 → 独立レビュー → 昇格画面で承認）のうち、いまどこかを返す。
 * 「いま全体のどこにいて、次に何を押すか」を 1 枚で見せるための表示用。状態の判定は composeStatusView と同じ根拠。
 * s が無い（まだ合成を始めていない）／取り消し済みなら、合成が current。
 */
export function composeFlowSteps(s: Dto | null, ja: boolean): ComposeFlowStep[] {
  const L = (j: string, e: string): string => (ja ? j : e)
  const labels: Record<ComposeFlowStepKey, string> = {
    compose: L('① 合成', '1. Compose'),
    review: L('② 独立レビュー', '2. Independent review'),
    approve: L('③ 昇格画面で承認', '3. Approve in promotion')
  }
  const mk = (
    compose: ComposeFlowStepState,
    review: ComposeFlowStepState,
    approve: ComposeFlowStepState
  ): ComposeFlowStep[] => [
    { key: 'compose', label: labels.compose, state: compose },
    { key: 'review', label: labels.review, state: review },
    { key: 'approve', label: labels.approve, state: approve }
  ]
  // 昇格済みは 3 段とも済み（作業場の段・案件の記録より優先する）
  if (s?.adopted) return mk('done', 'done', 'done')
  if (!s || s.phase === 'cancelled') return mk('current', 'todo', 'todo')
  if (s.phase === 'failed') return mk('attention', 'todo', 'todo')
  if (s.caseView) return caseFlowSteps(s.caseView, mk)
  if (s.phase === 'running' || s.phase === 'finalizing') return mk('current', 'todo', 'todo')
  // 旧形式で reviewing が来たら、合成は済みでレビューが現在の段
  if (s.phase === 'reviewing') return mk('done', 'current', 'todo')
  // registered
  const rv = s.result?.review
  if (rv?.status === 'ok' && rv.verdict === 'approve') return mk('done', 'done', 'current')
  if (rv?.status === 'ok') return mk('done', 'attention', 'todo')
  return mk('done', 'current', 'todo')
}

/** 案件（caseId を持つ作業場）の段。カードの状態（caseView）から決める */
function caseFlowSteps(
  caseView: string,
  mk: (a: ComposeFlowStepState, b: ComposeFlowStepState, c: ComposeFlowStepState) => ComposeFlowStep[]
): ComposeFlowStep[] {
  switch (caseView) {
    case 'reviewing':
      return mk('done', 'current', 'todo')
    case 'awaiting-approval':
    case 'awaiting-approval-base':
      return mk('done', 'done', 'current')
    case 'stopped':
    case 'answer-pending':
      return mk('done', 'attention', 'todo')
    case 'held':
      return mk('done', 'done', 'todo')
    case 'failed':
      return mk('attention', 'todo', 'todo')
    case 'adopted':
      return mk('done', 'done', 'done')
    default:
      // composing・revising・checking・cancelled
      return mk('current', 'todo', 'todo')
  }
}

/** 登録済みの適応の一覧（承認待ちの補足。旧形式のカードと案件のカードで同じ文面を使う） */
export function adaptedDetailLines(
  adaptedIn: ReadonlyArray<{ sourceId: string; relPath: string; lang: 'ja' | 'en'; reason: string; preview: string }> | undefined,
  ja: boolean
): string[] {
  const adapted = (adaptedIn ?? []).map(
    (a) =>
      `${a.sourceId} ${a.lang === 'en' ? 'en:' : ''}${a.relPath}: ${a.preview}${a.reason ? ` — ${a.reason}` : ''}`
  )
  if (adapted.length === 0) return []
  return [
    ja
      ? `元提案をそのままの形では載せなかった所（あなたが選んだ適応）: ${adapted.length} 件`
      : `Adaptations you approved (not kept verbatim): ${adapted.length}`,
    ...adapted
  ]
}

/** 同じ skill の合成の進み具合のうち、画面に出すもの（進行中があればそれ、無ければ直近の 1 件） */
export function pickStatusForSkill<
  T extends { skillName: string; startedAt: string; phase: string }
>(all: readonly T[], skillName: string): T | null {
  const mine = all
    .filter((s) => s.skillName === skillName)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  return (
    mine.find((s) => s.phase === 'running' || s.phase === 'finalizing' || s.phase === 'reviewing') ??
    mine[0] ??
    null
  )
}
