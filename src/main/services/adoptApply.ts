import { readFile } from 'fs/promises'
import {
  computeProposalHash,
  evaluateAdoptGateFromRaw,
  setProposalState,
  type FindingsAckPayload,
  type ProposalStorePaths
} from './skillProposals'
import {
  parseChangeRequestFromRaw,
  applyChange,
  type ApplyResult,
  type ApplyOptions,
  type SettingsPaths
} from './settingsChange'

/**
 * 採用適用の単一ゲート（proposal 採用・cc-request 適用の共通経路）。
 *
 * marshal 実装レビュー（bv8ym3jik）+ 設計レビュー（task-mrzg88lt）反映:
 * - high#1: file を1回読み、同一 raw から1回だけ parse した request を gate/apply が共有する
 *   （再 parse 禁止＝parser/gate の解釈差ゼロ）。
 * - 中核: `kind:'skill'` は**経路不問で**採用ゲート（evaluateAdoptGateFromRaw）を通す。renderer の
 *   object 捏造・任意ファイル選択で採用ゲート（hash 照合/重複 fail-closed/terminal-state）を
 *   バイパスさせない。`kind:'settings'` は gate 非対象（従来どおり）。
 * - medium#2: expectedHash 指定時（Inbox プレビュー経路）は apply 時 content が preview 時と一致するかを
 *   照合し、preview→apply TOCTOU を塞ぐ（content-changed）。
 * - low#4: readFile 失敗は fail-closed（read-error）。
 */
export type GatedApplyResult =
  | (ApplyResult & { appliedRequestId?: string })
  | {
      success: false
      reason:
        | 'read-error'
        | 'content-changed'
        | 'review-required'
        | 'terminal-state'
        | 'findings-ack-required'
        // ユーザーコメント系（`user_comment_dialogue_plan.md`）。**break-glass では免除されない**
        | 'comments-unanswered'
        | 'comments-broken'
        | 'comments-ack-required'
      /** コメント系ブロックの人間向け説明（UI がそのまま出せる） */
      commentDetail?: string
    }

export interface GatedApplyDeps {
  applyOpts?: ApplyOptions
  settingsPaths?: SettingsPaths
  storePaths?: ProposalStorePaths
  /**
   * 指摘を承知したうえで採用することを示すペイロード（降格ラベル、または推奨のまま
   * 据え置いた `deferred` を含む提案が対象）。**採用要求ごとに渡す非永続の値**で、未指定＝fail-closed。
   * 台帳へ永続化しないのは、提案改稿・再レビュー時の invalidation 条件が新たな穴になるため。
   * boolean でなく 3 値なのは、ack が「いま画面に出ている内容」に対するものであることを
   * 採用ゲート側が再計算して照合できるようにするため（stale ack の流用防止）。
   */
  findingsAck?: FindingsAckPayload
  /**
   * コメント応答側の ack。**`findingsAck` とは次元を分けて渡す**（r39#1）。
   * 全体一致で照合すると、コメントが stale 化しただけで既存の `deferred` ack まで
   * 巻き添え失効する。ここも非永続・未指定＝fail-closed で、値の正しさは採用ゲートが
   * 現 content から再計算して照合する（findingsAck の 3 値束縛には一切影響しない）。
   */
  commentsAck?: { proposalHashAtAck?: string; commentsKey?: string }
}

export async function gatedApplyFromFile(
  filePath: string,
  password: string,
  override: boolean,
  expectedHash: string | undefined,
  requirePreview: boolean,
  deps: GatedApplyDeps = {}
): Promise<GatedApplyResult> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf-8')
  } catch {
    return { success: false, reason: 'read-error' }
  }
  // medium#2（round2/3 強化）: preview→apply TOCTOU。経路の意図は呼び出し側 main が requirePreview で明示する
  // （undefined sentinel に routing 判定を負わせない＝Electron IPC の実行時 undefined 混入を排除）。
  // - requirePreview=true（Inbox=settings:applyChange 経路）: previewHash 必須。IPC 引数は実行時値のため
  //   非文字列(undefined 含む)・空文字・不一致は全て fail-closed（content-changed）。
  // - requirePreview=false（adopt 経路・main が undefined を定数注入）: 承認 content 照合が守るため preview 照合しない。
  //   ただし明示 hash が文字列で渡れば防御的に照合する。
  if (requirePreview) {
    if (
      typeof expectedHash !== 'string' ||
      expectedHash === '' ||
      computeProposalHash(raw) !== expectedHash
    ) {
      return { success: false, reason: 'content-changed' }
    }
  } else if (
    typeof expectedHash === 'string' &&
    expectedHash !== '' &&
    computeProposalHash(raw) !== expectedHash
  ) {
    return { success: false, reason: 'content-changed' }
  }
  // high#1: gate 判定と applyChange が同一 request を共有（1-parse・再 parse 禁止）
  const request = parseChangeRequestFromRaw(raw, filePath)
  // codex round2: adopt 経路（requirePreview=false）は skill 提案専用。settings kind が紛れると
  // adopt gate（kind:'skill' のみ評価）も Inbox の preview 照合も通らず無ゲートで applyChange に
  // 到達するため、適用前に fail-closed で拒否する（list 側 kind 検証と対で IPC 直叩きも塞ぐ）。
  if (!requirePreview && request.kind !== 'skill') {
    return { success: false, reason: 'kind-target-mismatch' }
  }
  if (request.kind === 'skill') {
    const gate = await evaluateAdoptGateFromRaw(raw, filePath, override, deps.storePaths, {
      ...(deps.findingsAck ? { findingsAck: deps.findingsAck } : {}),
      ...(deps.commentsAck ? { commentsAck: deps.commentsAck } : {})
    })
    if (gate.blocked) {
      return {
        success: false,
        reason: gate.reason ?? 'review-required',
        ...(gate.commentDetail ? { commentDetail: gate.commentDetail } : {})
      }
    }
  }
  const result = await applyChange(request, password, deps.settingsPaths, deps.applyOpts)
  // 適用した request（＝現ファイル content）の request_id を返す。呼び出し側はこの id で状態確定でき、
  // renderer の stale スナップショット由来 request_id による state ずれを塞ぐ（marshal round4）。
  return { ...result, appliedRequestId: request.frontmatter.request_id }
}

/**
 * proposal 採用の main 集約経路。gatedApplyFromFile で採用適用し、成功時は
 * 「実際に適用した request_id」で採用状態を atomic に確定する。
 * renderer が list スナップショットの stale requestId で状態を書くと、list→採用の間にファイルが
 * 差し替わった場合に「適用した提案が candidate のまま／未適用の提案が terminal-state」になる state 不整合が起きる。
 * 状態確定を main の適用 request_id に一元化してこれを根治する（marshal round4 finding）。
 */
export async function adoptProposalFromFile(
  filePath: string,
  password: string,
  override: boolean,
  deps: GatedApplyDeps = {},
  expectedHash?: string
): Promise<GatedApplyResult> {
  const r = await gatedApplyFromFile(filePath, password, override, expectedHash, false, deps)
  if (r.success && 'appliedRequestId' in r && r.appliedRequestId) {
    // apply→state は別ストアで真の atomic 不能。durable な採用真実は applyChange が書く
    // provenance(adopted-skills.json)。proposal-states.json は UI 補助の派生状態。
    // ここで throw すると「適用済みなのに失敗報告」→再試行で二重採用を招くため、state 書込失敗は
    // 握りつぶし採用成功を覆さない。二重採用は alreadyAdopted(provenance)＋同名衝突ガードが防ぐ（marshal round5 finding#1）。
    try {
      await setProposalState(r.appliedRequestId, 'adopted', deps.storePaths)
    } catch {
      /* state finalize 失敗は採用成否を覆さない（provenance が durable 真実） */
    }
  }
  return r
}
