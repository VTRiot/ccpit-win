/**
 * proposalReviewRunner — 提案 1 件を独立レビュアーへ通し、結果をレビュー台帳へ upsert する実行系。
 *
 * 発注 20260805_1631_proposal-review-harvest §B-1「Codex レビューボタン」の main 側実体。
 *
 * 設計の要点:
 * - 依頼文は `prepareProposalReviewRequest` の戻り値**だけ**を使う（B-3 のコピー導線と同一ソース）。
 * - レビュアーは **read-only sandbox** で動かす。companion の `task` は
 *   `sandbox: request.write ? "workspace-write" : "read-only"` であり、**`--write` を渡さないこと**が
 *   read-only の成立条件。よって argv に `--write` を含めないことをテストで固定する。
 * - **隔離 cwd**: 外部エージェントは cwd 起点でプロンプト外のローカルファイルを自己探索しうるため、
 *   一時ディレクトリを作りそこを cwd にする。プロンプトは引数でなく `--prompt-file` で渡す
 *   （Windows の引数長・引用崩れ対策も兼ねる）。
 * - **失敗時は台帳に一切書かない**（発注 §B-4「台帳非破壊」）。
 * - companion 解決・spawn は `marshalLauncher` の既存実装を再利用する（車輪の再発明禁止）。
 */

import { mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  resolveCompanion,
  defaultCodexCacheDir,
  makeDefaultSpawn,
  type SpawnFn
} from './marshalLauncher'
import { prepareProposalReviewRequest } from './proposalReviewRequest'
import {
  setProposalReview,
  readProposalReviews,
  type ProposalStorePaths,
  type StoredProposalReview
} from './skillProposals'

/** 提案レビューのタイムアウト。marshal（差分レビュー）より短い想定だが同オーダー。 */
export const PROPOSAL_REVIEW_TIMEOUT_MS = 600_000

/** レビュアー実行系の可用性。UI のボタン活性判定に使う（不在時は不能化＋理由表示）。 */
export interface ReviewerAvailability {
  available: boolean
  /** 解決できた companion のバージョン（available=true のとき） */
  version?: string
  /** 不能化の理由キー（UI が文言へ写像する） */
  reason?: 'reviewer-unavailable'
  /** 人間可読の補足（探索先など） */
  detail?: string
}

/**
 * レビュアーが使えるか。**不在なら false を返すだけで、決してブロックも素通しもしない**
 * （UI 側がボタンを不能化して理由を出す。不在時に「レビュー済み扱い」で先へ進めない）。
 */
export function getReviewerAvailability(codexCacheDir?: string): ReviewerAvailability {
  const dir = codexCacheDir ?? defaultCodexCacheDir()
  const resolved = resolveCompanion(dir)
  if (!resolved) {
    return {
      available: false,
      reason: 'reviewer-unavailable',
      detail: `レビュアー companion が見つかりません（探索先: ${dir}）`
    }
  }
  return { available: true, version: resolved.version }
}

/** レビュー実行の結果。 */
export type ProposalReviewOutcome =
  | {
      status: 'ok'
      requestId: string
      verdict: string
      findings: string
      proposalHash: string
    }
  | {
      status: 'reviewer-unavailable' | 'proposal-id-missing' | 'launch-failed' | 'output-unusable'
      /** 人間可読の理由（UI 表示用） */
      message: string
    }

export interface RunProposalReviewDeps {
  spawnFn?: SpawnFn
  codexCacheDir?: string
  storePaths?: ProposalStorePaths
  /** テスト用: 実時刻の注入 */
  now?: () => string
}

/**
 * companion へ渡す引数を組む。**`--write` を含めない**ことが read-only sandbox の成立条件。
 * 単体で export しているのは、その不変条件をテストで直接固定するため。
 */
export function buildReviewerArgs(scratchDir: string, promptFile: string): string[] {
  return ['task', '--json', '--cwd', scratchDir, '--prompt-file', promptFile]
}

/** companion の JSON 出力から本文を取り出す。 */
export function extractReviewerText(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const o = parsed as Record<string, unknown>
      if (typeof o.rawOutput === 'string' && o.rawOutput.trim() !== '') return o.rawOutput
    }
  } catch {
    /* JSON でなければ下へ */
  }
  return null
}

/** レビュアー本文から VERDICT 行を拾う（見つからなければ空文字）。 */
export function extractVerdict(text: string): string {
  const m = text.match(/^\s*VERDICT:\s*([A-Za-z][A-Za-z-]*)/m)
  return m ? m[1].trim().toLowerCase() : ''
}

/** `runReviewerWithPrompt` の入力（`RunProposalReviewDeps` の spawn 関連だけ） */
export type RunReviewerOptions = Pick<RunProposalReviewDeps, 'spawnFn' | 'codexCacheDir'>

/** `runReviewerWithPrompt` の結果。台帳へは書かない（書くのは呼び出し側） */
export type ReviewerRunResult =
  | { ok: true; text: string }
  | {
      ok: false
      status: 'reviewer-unavailable' | 'launch-failed' | 'output-unusable'
      /** 人間可読の理由（UI 表示用） */
      message: string
    }

/**
 * 依頼文をレビュアー（codex companion）へ通し、本文を返す。**台帳には一切触れない**。
 * `runProposalReview`（通常の提案）と合成提案のレビュー（L0_011）が共有する。read-only sandbox・隔離 cwd・
 * `--prompt-file` の渡し方はここに 1 本化している。
 */
export async function runReviewerWithPrompt(
  prompt: string,
  opts: RunReviewerOptions = {}
): Promise<ReviewerRunResult> {
  const resolved = resolveCompanion(opts.codexCacheDir ?? defaultCodexCacheDir())
  if (!resolved) {
    return { ok: false, status: 'reviewer-unavailable', message: 'レビュアー companion の解決に失敗しました' }
  }
  // 隔離 scratch。サニタイズ済みプロンプトだけを置き、そこを cwd にする。
  const scratchDir = await mkdtemp(join(tmpdir(), 'ccpit-proposal-review-'))
  const promptFile = join(scratchDir, 'review_prompt.txt')
  try {
    await writeFile(promptFile, prompt, 'utf-8')
    const spawnFn = opts.spawnFn ?? makeDefaultSpawn(PROPOSAL_REVIEW_TIMEOUT_MS)
    const args = buildReviewerArgs(scratchDir, promptFile)
    const spawned = await spawnFn(resolved.entry, args)
    if (spawned.status !== 0) {
      return {
        ok: false,
        status: 'launch-failed',
        message: `レビュアーが異常終了しました（exit=${spawned.status ?? 'null'}）: ${
          (spawned.stderr || '').slice(0, 400)
        }`
      }
    }
    const text = extractReviewerText(spawned.stdout)
    if (!text) {
      return {
        ok: false,
        status: 'output-unusable',
        message: 'レビュアー出力を解釈できませんでした（台帳は変更していません）'
      }
    }
    return { ok: true, text }
  } finally {
    await rm(scratchDir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * 提案 1 件をレビュアーへ通して台帳へ upsert する。
 * 失敗時は台帳に触れない（非破壊）。
 */
export async function runProposalReview(
  filePath: string,
  deps: RunProposalReviewDeps = {}
): Promise<ProposalReviewOutcome> {
  const availability = getReviewerAvailability(deps.codexCacheDir)
  if (!availability.available) {
    return { status: 'reviewer-unavailable', message: availability.detail ?? 'レビュアー不在' }
  }
  const resolved = resolveCompanion(deps.codexCacheDir ?? defaultCodexCacheDir())
  if (!resolved) {
    return { status: 'reviewer-unavailable', message: 'レビュアー companion の解決に失敗しました' }
  }

  const prepared = await prepareProposalReviewRequest(filePath)
  if (!prepared.requestId) {
    // request_id が無いと台帳のキーが決まらない＝レビュー結果を紐付けられない。
    return {
      status: 'proposal-id-missing',
      message: '提案の request_id が読み取れないためレビュー結果を記録できません'
    }
  }

  const ran = await runReviewerWithPrompt(prepared.prompt, deps)
  if (!ran.ok) return { status: ran.status, message: ran.message }
  const text = ran.text
  const verdict = extractVerdict(text)
  if (!verdict) {
    return {
      status: 'output-unusable',
      message: 'レビュアー出力に VERDICT 行が見つかりません（台帳は変更していません）'
    }
  }
  // 既存の ccRebuttal は**実機実測で発見した破壊バグの是正**として持ち越す。
  // ccRebuttal は「CC が findings をどう裁定したか」の記録であり、レビュアー実行経路が
  // 空文字で潰してよい値ではない（未知フィールドは非破壊マージが守るが、既知フィールドは
  // 明示的に書くため守られない）。再レビューで陳腐化しても、破棄より保持のほうが監査上まし。
  // 新しい findings に対する裁定は、CC が改めて上書きする。
  const existing = (await readProposalReviews(deps.storePaths))[prepared.requestId]
  const review: StoredProposalReview = {
    verdict,
    findings: text,
    reviewerId: 'codex',
    ccRebuttal: existing?.ccRebuttal ?? '',
    // 実時刻（推定・丸め禁止）
    reviewedAt: (deps.now ?? (() => new Date().toISOString()))(),
    // レビューした content そのものの hash。採用ゲートのハッシュ束縛が
    // 「古い verdict の使い回し」を拒否できる状態を維持する（発注 §B-1）。
    proposalHash: prepared.proposalHash
  }
  await setProposalReview(prepared.requestId, review, deps.storePaths)
  return {
    status: 'ok',
    requestId: prepared.requestId,
    verdict,
    findings: text,
    proposalHash: prepared.proposalHash
  }
}
