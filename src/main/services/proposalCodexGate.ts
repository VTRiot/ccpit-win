/**
 * proposalCodexGate — 推奨バッジ（adoption_label: recommend）付き SkillProposal の
 * Codex レビュー強制ゲート（v1.6.0 / maintainer裁定 2026-07-13）。
 *
 * 原則:
 * - **Codex プラグイン検出時のみ発動**。未導入環境では従来どおり動く（強制失敗にしない）。
 *   検出は marshalLauncher.resolveCompanion を再利用（semver 最大解決・不在は null＝absence）。
 * - **レビュー実行そのものは本モジュールでは行わない**: codex-companion の adversarial-review は
 *   git リポ必須で、提案プール ~/.ccpit/proposals/（非リポ）には物理的に不成立
 *   （dev_log 260611_1149_marshal-review-skill-r2 実証）。レビュー記録は既存のレビューボックス
 *   契約 C1（~/.ccpit/proposal-reviews.json、外部レビュアーが書く）を正とし、本ゲートは
 *   採用チョークポイント（settingsChange.applyChange）で「記録の存在」を fail-closed に強制する。
 * - **棄却権**: How の決定権は CC にあり、説明責任（cc_rebuttal への棄却理由記録）を果たせば
 *   レビュー指摘を棄却できる。この扱いはmaintainer裁定原文の逐語（CC_REBUTTAL_RIGHT_CLAUSE）として
 *   レビュー投入プロンプト（buildCodexReviewPrompt）に組み込む。棄却理由は候補ブラウザの
 *   レビューボックス（cc_rebuttal）でmaintainerが視認できる。
 * - **なりすまし防御はスコープ外**: レビューストアは同一ユーザーが書込可能なローカル信頼境界内。
 *   reviewerId の照合（/codex/i 部分一致）は「codex を名乗る記録の存在」の検出であり、
 *   悪意ある偽装への防御ではない（CCPIT の他ゲートと同じローカル前提）。
 *
 * Electron 非依存（パスは引数で上書き可・テスト容易性のため）。
 */

import { resolveCompanion, defaultCodexCacheDir } from './marshalLauncher'
import {
  readProposalReviews,
  getDefaultProposalStorePaths,
  parseFlatFrontmatter,
  type ProposalStorePaths
} from './skillProposals'

/** Codex プラグインの検出結果。 */
export interface CodexPluginPresence {
  present: boolean
  /** 検出時のみ。resolveCompanion の semver 最大版 */
  version?: string
}

/** Codex プラグイン（codex-companion.mjs）の存在検出。不在は present:false（エラーではない）。 */
export function detectCodexPlugin(
  codexCacheDir: string = defaultCodexCacheDir()
): CodexPluginPresence {
  const r = resolveCompanion(codexCacheDir)
  return r ? { present: true, version: r.version } : { present: false }
}

export type CodexGateBlockReason =
  | 'request-id-missing'
  | 'codex-review-missing'
  | 'reviewer-not-codex'

/** ゲート判定（UI 表示と applyChange 強制の両方で使う単一ソース）。 */
export interface CodexGateDecision {
  codexPresent: boolean
  codexVersion?: string
  /** recommend × Codex 検出 → Codex レビュー必須 */
  required: boolean
  /** requestId に対する codex レビュー記録（verdict 非空・reviewer が codex）が存在する */
  reviewed: boolean
  reviewerId?: string
  verdict?: string
  /** 棄却理由（説明責任）。maintainer可視化のため decision に同乗させる */
  ccRebuttal?: string
  /** false のとき採用をブロックする（required かつ未レビュー） */
  satisfied: boolean
  blockReason?: CodexGateBlockReason
}

export interface EvaluateCodexGateInput {
  adoptionLabel: string
  requestId: string
  /** テスト上書き用。既定 ~/.claude/plugins/cache/openai-codex/codex */
  codexCacheDir?: string
  /** テスト上書き用。既定 ~/.ccpit/proposal-{states,reviews}.json */
  storePaths?: ProposalStorePaths
}

/**
 * 推奨バッジ提案の Codex レビューゲートを判定する。
 * 発動条件（required）が立たない限り必ず satisfied:true（未導入環境・非推奨提案は従来どおり）。
 */
export async function evaluateProposalCodexGate(
  input: EvaluateCodexGateInput
): Promise<CodexGateDecision> {
  const presence = detectCodexPlugin(input.codexCacheDir ?? defaultCodexCacheDir())
  const required = presence.present && input.adoptionLabel === 'recommend'
  const base = { codexPresent: presence.present, codexVersion: presence.version, required }
  if (!required) {
    return { ...base, reviewed: false, satisfied: true }
  }
  if (!input.requestId) {
    // request_id が無いとレビュー記録を照合できない。fail-closed（提案側の修正を促す）。
    return { ...base, reviewed: false, satisfied: false, blockReason: 'request-id-missing' }
  }
  const reviews = await readProposalReviews(input.storePaths ?? getDefaultProposalStorePaths())
  const review = reviews[input.requestId]
  if (!review || review.verdict.trim() === '') {
    return { ...base, reviewed: false, satisfied: false, blockReason: 'codex-review-missing' }
  }
  if (!/codex/i.test(review.reviewerId)) {
    // 記録はあるが codex 以外（らいこ / LocalLLM 等）のレビュー。maintainer裁定は「Codex レビュー」を
    // 明示するため、codex 検出環境では codex 名義の記録を要求する。
    return {
      ...base,
      reviewed: false,
      satisfied: false,
      blockReason: 'reviewer-not-codex',
      reviewerId: review.reviewerId,
      verdict: review.verdict,
      ccRebuttal: review.ccRebuttal
    }
  }
  return {
    ...base,
    reviewed: true,
    satisfied: true,
    reviewerId: review.reviewerId,
    verdict: review.verdict,
    ccRebuttal: review.ccRebuttal
  }
}

/** 提案 MD（rawMarkdown）の frontmatter から adoption_label を取り出す（無ければ ''）。 */
export function extractAdoptionLabel(rawMarkdown: string): string {
  const fm = parseFlatFrontmatter(rawMarkdown)
  return fm?.data.adoption_label ?? ''
}

/**
 * maintainer裁定原文（2026-07-13・逐語保持）。この文言・この扱いを崩さないこと（発注 v16-final-polish WS2）。
 * レビュー投入プロンプトへ必ず組み込む。
 */
export const CC_REBUTTAL_RIGHT_CLAUSE =
  'Howの決定権はCC(あなた）にあります。貴方は、maintainerに対してレビュー指摘の棄却の妥当性の説明責任を果たすことで、レビューの指摘を棄却する権利を有しています。'

export interface BuildReviewPromptInput {
  filePath: string
  requestId: string
  skillName: string
  title: string
  /** テスト上書き用。既定 ~/.ccpit/proposal-reviews.json */
  storePaths?: ProposalStorePaths
}

/**
 * Codex レビュー投入プロンプトを生成する（候補ブラウザの「レビュー依頼プロンプトをコピー」用）。
 * CC セッションに貼ると、CC が Codex レビューを実施し、結果を契約 C1 ストアへ記録する想定。
 * 棄却権の扱い（maintainer裁定原文）を逐語で含む。
 */
export function buildCodexReviewPrompt(input: BuildReviewPromptInput): string {
  const reviewsPath = (input.storePaths ?? getDefaultProposalStorePaths()).reviewsPath
  return `以下の Skill 提案（推奨バッジ付き）への独立 Codex レビューを実施し、結果を記録してください。

- 提案ファイル: ${input.filePath}
- request_id: ${input.requestId}
- skill 名: ${input.skillName}
- タイトル: ${input.title}

レビュー観点: 発火条件の過不足 / 手順の再現性 / 副作用・安全性 / 既存 skill との重複。

レビューの扱い（maintainer裁定 2026-07-13・逐語）:
「${CC_REBUTTAL_RIGHT_CLAUSE}」

手順:
1. Codex（プラグイン / CLI）で上記の提案ファイルをレビューし、findings を得る
2. 指摘は原則、提案内容へ反映する。反映しない（棄却する）指摘は、棄却理由を cc_rebuttal に記録して説明責任を果たす（棄却理由は CCPIT 候補ブラウザのレビューボックスでmaintainerが視認する）
3. レビュー結果を ${reviewsPath} に request_id をキーとして記録する:
   {"${input.requestId}": {"verdict": "<approve 等>", "findings": "<指摘の要約>", "reviewerId": "codex@<version>", "ccRebuttal": "<棄却した指摘と理由。無ければ空文字>", "reviewedAt": "<ISO 8601>"}}
   ※ reviewerId は 'codex' を含む文字列にすること（採用ゲートの照合条件）
4. CCPIT の Skill 候補ブラウザを再読込すると、レビュー済みとして採用ゲートが解錠される
`
}
