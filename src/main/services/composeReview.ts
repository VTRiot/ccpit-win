/**
 * composeReview — 合成提案の独立レビュー（L0_011 W1）。golden との差分を主対象にして審査させ、指摘を由来で分けて台帳へ書く。
 *
 * 流れ: 合成提案 MD を読む → golden の写しとの差分（合成提案側の行番号）を出す → 依頼文を組む → レビュアーを 1 回走らせる
 *   → 出力を指摘のブロックに分ける → `where:` と変更行の突き合わせで由来を確定する（失敗安全は composeReviewClassify）
 *   → 原文由来を受け皿へ入れる → 台帳へ書く（`findings` は差分と不明だけ。原文由来は台帳の `findings` の外）。
 *
 * 台帳の書込み・レビュアーの起動・受け皿の作成は deps で受ける（試験は偽を渡す。ここは fs の読取以外の副作用を持たない）。
 * 採用ゲートの条件は変えない。ゲートが見る `findings` の集合をこの規則で作るだけ。
 */

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  ClassifiedFinding,
  ComposeReviewContext,
  ComposeReviewLedgerExtra,
  ComposeReviewOutcome,
  ComposeReviewScope,
  FileChangedRanges,
  FindingOriginRecord,
  LineRange,
  OriginCounts
} from '../../shared/composeContract'
import { diffHunks } from './composeContainment'
import { sha256Hex, toLines } from './composeHash'
import { splitFrontmatter } from './composeRegister'
import {
  buildGateFindingsText,
  classifyFindings,
  countOrigins,
  effectiveVerdict,
  parseReviewerOutput,
  wholeOutputAsUnclear
} from './composeReviewClassify'
import { buildComposeReviewRequest, type RemovedLines } from './proposalReviewRequest'
import {
  computeProposalHash,
  parseProposalMdFromRaw,
  parseProposedFilesFromSection3
} from './skillProposals'

/** golden の en が未翻訳の仮置きであることを示す語。この本文は golden の原文とは見なさず、全行を変更として扱う */
const TRANSLATION_PENDING_MARK = '[Translation Pending]'

const toPosix = (p: string): string => p.replace(/\\/g, '/')

/** ファイルのラベル。`[ja]SKILL.md`・`[en]references/x.md` */
export function fileLabel(lang: 'ja' | 'en', relPath: string): string {
  return `[${lang}]${toPosix(relPath)}`
}

export interface ChangedRangesResult {
  /** §3 の各ファイル（出現順）。§3 を読めないときは [] */
  ranges: FileChangedRanges[]
  /** ラベル → 合成提案のファイルの行 */
  fileLines: Record<string, string[]>
  /** ラベル → golden から消えた行のかたまり（依頼文で見せる。置換で消えた行も含む） */
  removed: Record<string, RemovedLines[]>
  /** §3 を読めない・ファイルが無いときの理由 */
  error: string | null
}

/** 範囲を昇順に並べ、重なる・隣り合うものを 1 つにまとめる */
function mergeRanges(rs: LineRange[]): LineRange[] {
  const sorted = [...rs].sort((a, b) => a.start - b.start)
  const out: LineRange[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r.start <= last.end + 1) last.end = Math.max(last.end, r.end)
    else out.push({ ...r })
  }
  return out
}

/**
 * 合成提案側の行番号（1 始まり・両端を含む）で、golden の写しとの差分の範囲を出す。
 * golden に無い・読めないファイル、`[Translation Pending]` の仮置きの golden は全行が変更。
 * 差分の算出に失敗したファイルは `boundaryOk:false`（そのファイルを指す指摘は由来を確定できない）。
 */
export function computeChangedRangesDetailed(
  compositeRaw: string,
  goldenDir: string,
  skillName: string
): ChangedRangesResult {
  const sf = splitFrontmatter(compositeRaw)
  const parsed = parseProposedFilesFromSection3(sf ? sf.body : compositeRaw)
  if (parsed.error) return { ranges: [], fileLines: {}, removed: {}, error: `合成提案の §3 を読めない: ${parsed.error}` }
  if (parsed.files.length === 0) return { ranges: [], fileLines: {}, removed: {}, error: '合成提案の §3 にファイルが無い' }

  const ranges: FileChangedRanges[] = []
  const fileLines: Record<string, string[]> = {}
  const removed: Record<string, RemovedLines[]> = {}
  for (const f of parsed.files) {
    const lang = f.lang === 'en' ? 'en' : 'ja'
    const label = fileLabel(lang, f.relPath)
    const lines = toLines(f.content)
    fileLines[label] = lines
    try {
      let baseLines: string[] = []
      try {
        const gold = readFileSync(join(goldenDir, lang, 'skills', skillName, toPosix(f.relPath)), 'utf-8')
        // 仮置きの本文は golden の原文ではない。偶然一致する行（空行・`---`）を「未変更」と見ないよう、全行を変更とする
        baseLines = gold.includes(TRANSLATION_PENDING_MARK) ? [] : toLines(gold)
      } catch (err) {
        // golden に無い（ENOENT）ファイルだけが「追加」＝全行が変更。権限・I/O・パスの異常などで比べる境界を
        // 取れないときは、変更行を断定できない。外側の catch で boundaryOk:false に倒す（失敗安全）
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err
        baseLines = []
      }
      const out: LineRange[] = []
      const gone: RemovedLines[] = []
      // ハンクは B（golden）上の位置。ハンクの間の行は 1 対 1 に対応するので、合成提案側の位置は B の位置 + これまでのずれ
      let delta = 0
      for (const h of diffHunks(baseLines, lines)) {
        const start0 = h.baseStart + delta // 合成提案側の 0 始まりの位置
        const len = h.srcLines.length
        delta += len - (h.baseEnd - h.baseStart)
        if (len > 0) out.push({ start: start0 + 1, end: start0 + len })
        if (h.baseEnd > h.baseStart) {
          gone.push({ afterLine: start0, lines: baseLines.slice(h.baseStart, h.baseEnd) })
          // 削除だけの所は合成提案側に指す行が無い。直前と直後の行を変更行として扱う
          // （削除を周辺の行で指摘されても、原文の指摘として受け皿へ流さない）
          if (len === 0) {
            const before = start0 >= 1 ? start0 : null
            const after = start0 + 1 <= lines.length ? start0 + 1 : null
            if (before !== null) out.push({ start: before, end: before })
            if (after !== null) out.push({ start: after, end: after })
          }
        }
      }
      ranges.push({ file: label, ranges: mergeRanges(out), boundaryOk: true, lineCount: lines.length })
      if (gone.length > 0) removed[label] = gone
    } catch {
      ranges.push({ file: label, ranges: [], boundaryOk: false, lineCount: lines.length })
    }
  }
  return { ranges, fileLines, removed, error: null }
}

/** `computeChangedRangesDetailed` の範囲だけ。§3 を読めないときは [] */
export function computeChangedRanges(
  compositeRaw: string,
  goldenDir: string,
  skillName: string
): FileChangedRanges[] {
  return computeChangedRangesDetailed(compositeRaw, goldenDir, skillName).ranges
}

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------

export type ComposeReviewerResult =
  | { ok: true; text: string }
  | { ok: false; status: ComposeReviewOutcome['status']; message: string }

/** 台帳へ書く行（`setProposalReview` の `StoredProposalReview` と同じ形） */
export interface ComposeLedgerReview {
  verdict: string
  findings: string
  reviewerId: string
  ccRebuttal: string
  reviewedAt: string
  proposalHash: string
}

export interface ComposeReviewDeps {
  /** 依頼文を 1 回だけレビュアーへ通す */
  runReviewer: (prompt: string) => Promise<ComposeReviewerResult>
  /** 台帳の行を書く（extra は台帳の行へ足す項目） */
  writeReview: (requestId: string, review: ComposeLedgerReview, extra: ComposeReviewLedgerExtra) => Promise<void>
  /** 原文由来の指摘を受け皿へ入れる（作成または追記）。入れた受け皿のパスを返す */
  upsertReceptacles: (
    base: ClassifiedFinding[],
    meta: { proposalId: string; caseId: string; round: number; skillName: string; owner: string }
  ) => Promise<string[]>
  now?: () => Date
}

const ZERO_COUNTS: OriginCounts = { diff: 0, base: 0, unclear: 0 }

function failed(status: ComposeReviewOutcome['status'], message: string): ComposeReviewOutcome {
  return { status, message, findings: [], counts: { ...ZERO_COUNTS } }
}

function originRecords(classified: ClassifiedFinding[]): FindingOriginRecord[] {
  return classified.map((f) => ({
    reviewerNo: f.reviewerNo,
    carried: f.carried,
    gateId: f.gateId,
    severity: f.severity,
    title: f.title,
    where: f.where,
    reviewerOrigin: f.reviewerOrigin,
    machineOrigin: f.machineOrigin,
    origin: f.origin,
    citedRanges: f.citedRanges,
    agree: f.agree
  }))
}

/**
 * 合成提案 1 本の独立レビューを 1 回走らせ、台帳へ書く。
 * - レビュアーが失敗したら台帳に書かず、その status で返す。
 * - 原文由来は**受け皿へ入れてから**台帳に書く。受け皿が失敗したら台帳に書かず `scope-failed` で返す（黙って消さない）。
 */
export async function reviewComposite(
  filePath: string,
  ctx: ComposeReviewContext,
  deps: ComposeReviewDeps
): Promise<ComposeReviewOutcome> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf-8')
  } catch (err) {
    return failed('scope-failed', `合成提案を読めなかった: ${err instanceof Error ? err.message : String(err)}`)
  }
  const parsedMd = parseProposalMdFromRaw(raw, filePath)
  const requestId = parsedMd.requestId
  if (!requestId) {
    return failed('proposal-id-missing', '合成提案の request_id が読み取れないためレビュー結果を記録できません')
  }
  const proposalHash = computeProposalHash(raw)

  const changed = computeChangedRangesDetailed(raw, ctx.goldenDir, ctx.skillName)
  if (changed.error) return failed('scope-failed', changed.error)

  const prompt = buildComposeReviewRequest({
    skillName: ctx.skillName,
    title: parsedMd.title,
    changedRanges: changed.ranges,
    fileLines: changed.fileLines,
    removed: changed.removed,
    history: ctx.history,
    carried: ctx.carried
  })
  const requestSha256 = sha256Hex(prompt)

  const ran = await deps.runReviewer(prompt)
  if (!ran.ok) {
    // 'ok' は失敗の理由にならない。取り違えて成功扱いにしないよう起動失敗へ倒す
    return failed(ran.status === 'ok' ? 'launch-failed' : ran.status, ran.message)
  }

  const out = parseReviewerOutput(ran.text)
  if (!out.verdict) {
    return failed('output-unusable', 'レビュアー出力に VERDICT 行が見つかりません（台帳は変更していません）')
  }
  const parsedFindings = out.findings ?? [wholeOutputAsUnclear(ran.text)]
  const classified = classifyFindings(parsedFindings, changed.ranges, changed.fileLines, ctx.carried)
  // 判定が needs-attention なのに指摘が 1 件も無い出力は矛盾している。approve にせず、不明 1 件として残す
  if (out.verdict === 'needs-attention' && classified.length === 0) {
    classified.push(
      ...classifyFindings(
        [
          {
            ...wholeOutputAsUnclear(ran.text),
            title: 'VERDICT は needs-attention だが、指摘が 1 件も無い'
          }
        ],
        changed.ranges,
        changed.fileLines
      )
    )
  }
  const counts = countOrigins(classified)
  const verdict = effectiveVerdict(classified)

  const scope: ComposeReviewScope = {
    kind: 'compose-diff',
    caseId: ctx.caseId,
    round: ctx.round,
    proposalHash,
    requestSha256,
    changedRanges: changed.ranges
  }

  const base = classified.filter((f) => f.origin === 'base')
  let refs: string[] = []
  if (base.length > 0) {
    try {
      refs = await deps.upsertReceptacles(base, {
        proposalId: requestId,
        caseId: ctx.caseId,
        round: ctx.round,
        skillName: ctx.skillName,
        owner: ctx.owner
      })
    } catch (err) {
      return {
        ...failed(
          'scope-failed',
          `原文由来の指摘を受け皿へ入れられなかった（台帳には書いていません）: ${err instanceof Error ? err.message : String(err)}`
        ),
        findings: classified,
        counts,
        scope
      }
    }
    if (refs.length === 0) {
      return {
        ...failed('scope-failed', '原文由来の指摘を受け皿へ入れたが、受け皿のパスが返らなかった（台帳には書いていません）'),
        findings: classified,
        counts,
        scope
      }
    }
  }

  const extra: ComposeReviewLedgerExtra = {
    reviewScope: scope,
    reviewerVerdict: out.verdict,
    reviewerFindings: ran.text,
    findingOrigins: originRecords(classified),
    baseFindingRefs: refs
  }
  const reviewedAt = (deps.now ?? (() => new Date()))().toISOString()
  try {
    await deps.writeReview(
      requestId,
      {
        verdict,
        findings: buildGateFindingsText(verdict, out.summary, classified),
        reviewerId: 'codex',
        ccRebuttal: '',
        reviewedAt,
        proposalHash
      },
      extra
    )
  } catch (err) {
    return {
      ...failed('scope-failed', `台帳へ書けなかった: ${err instanceof Error ? err.message : String(err)}`),
      findings: classified,
      counts,
      scope
    }
  }
  return {
    status: 'ok',
    verdict,
    reviewerVerdict: out.verdict,
    findings: classified,
    counts,
    scope
  }
}
