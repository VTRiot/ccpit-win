/**
 * composeReviewClassify — 合成提案の独立レビュー（L0_011 W1）の出力を、指摘ごとに切り出し、由来で分ける。
 *
 * 流れ: レビュアーの出力 → `parseReviewerOutput`（`[n]`・`[Hn]` のブロックへ）→ `classifyFindings`
 * （`where:` を「ファイルのラベル＋行範囲」へ引き、変更行と突き合わせて機械判定。申告と合わせて由来を確定）
 * → `buildGateFindingsText`（台帳の `findings` ＝採用ゲートに渡る集合を作る）。
 *
 * 失敗安全（ここを緩めない）: 由来が `diff`／`base` に確定するのは、機械判定と申告が一致し、かつ両方が diff か base のときだけ
 * （契約の `settleOrigin`）。食い違い・申告なし・`where:` を取り出せない・境界情報なし・持ち越しの無回答は、全部 `unclear`。
 * `unclear` は `findings` の外へ出さない（ゲートに渡る）。原文由来（base）だけを `findings` の外へ出す。
 */

import {
  settleOrigin,
  type CarriedFinding,
  type CitedRange,
  type ClassifiedFinding,
  type FileChangedRanges,
  type FindingSeverity,
  type LineRange,
  type MachineOrigin,
  type OriginCounts,
  type ParsedFinding,
  type ReviewerOrigin
} from '../../shared/composeContract'

// ---------------------------------------------------------------------------
// パース
// ---------------------------------------------------------------------------

/** 指摘のブロックの先頭行（`[1]`・`[H1]`）。行頭の空白は許す */
const BLOCK_START_RE = /^[ \t]*\[(H?\d+)\]/gim

/**
 * 項目の見出し。行頭か、1 行形式の区切り（` / `・` ／ `）の直後に置かれたものだけを項目として数える
 * （本文の途中にたまたま「title:」と書かれていても項目にしない）。箇条書きの印・太字の印は許す。
 */
const FIELD_RE =
  /(^|\n|[ \t]+[/／][ \t]+)[ \t]*(?:[-*•][ \t]+)?\**(severity|title|where|claim|impact|suggestion|origin)\**[ \t]*[:：]\**[ \t]*/gi

/** 題名が無いときの題名の最大文字数（本文の先頭行から取る） */
const FALLBACK_TITLE_MAX_CHARS = 120

function flatten(s: string): string {
  return s
    .replace(/\s*\n\s*/g, ' ')
    .replace(/^\**|\**$/g, '')
    .trim()
}

function readSeverity(v: string): FindingSeverity {
  const w = v.trim().toLowerCase().match(/^[a-z]+/)?.[0] ?? ''
  if (w === 'critical' || w === 'major' || w === 'minor') return w
  return 'unknown'
}

/** origin の値。項目が無ければ 'none'、あるが 3 語（日本語も可）のどれでもなければ 'unclear' */
function readReviewerOrigin(v: string | undefined): ReviewerOrigin {
  if (v === undefined) return 'none'
  const w = v.trim().toLowerCase()
  if (/^diff\b/.test(w) || w.startsWith('差分')) return 'diff'
  if (/^base\b/.test(w) || w.startsWith('原文')) return 'base'
  return 'unclear'
}

function parseBlock(no: string, rest: string, block: string): ParsedFinding {
  const marks: { key: string; start: number; end: number }[] = []
  FIELD_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = FIELD_RE.exec(rest))) {
    marks.push({ key: m[2].toLowerCase(), start: m.index, end: m.index + m[0].length })
  }
  const fields = new Map<string, string>()
  for (let i = 0; i < marks.length; i++) {
    const stop = i + 1 < marks.length ? marks[i + 1].start : rest.length
    const key = marks[i].key
    if (!fields.has(key)) fields.set(key, flatten(rest.slice(marks[i].end, stop)))
  }
  const firstLine = rest
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '')
  return {
    reviewerNo: no,
    carried: no.startsWith('H'),
    severity: readSeverity(fields.get('severity') ?? ''),
    title: fields.get('title') || (firstLine ?? '（題なし）').slice(0, FALLBACK_TITLE_MAX_CHARS),
    where: fields.get('where') ?? '',
    claim: fields.get('claim') ?? '',
    impact: fields.get('impact') ?? '',
    suggestion: fields.get('suggestion') ?? '',
    reviewerOrigin: readReviewerOrigin(fields.get('origin')),
    block: block.trim()
  }
}

export interface ParsedReviewerOutput {
  /** `VERDICT:` の値（小文字）。行が無ければ null */
  verdict: string | null
  summary: string
  /** 指摘のブロック。`FINDINGS: none` なら []。ブロックに分けられないときは null */
  findings: ParsedFinding[] | null
}

/** レビュアーの出力を、判定・要約・指摘のブロックへ分ける。1 行形式と複数行形式の両方を読む */
export function parseReviewerOutput(rawText: string): ParsedReviewerOutput {
  const text = rawText.replace(/\r\n/g, '\n')
  const vm = text.match(/^[ \t]*\**VERDICT\**[ \t]*[:：][ \t]*\**([A-Za-z][A-Za-z-]*)/im)
  const verdict = vm ? vm[1].toLowerCase() : null

  const findingsMarker = /^[ \t]*\**FINDINGS\**[ \t]*[:：]/im.exec(text)
  // 指摘のブロックは、`FINDINGS:` の位置に関わらず全文から探す。`FINDINGS:` より前に書かれた `[n]` を捨てて、
  // 末尾の `FINDINGS: none` だけを拾うと、差分の指摘を持つ出力が「指摘なし」として採用ゲートを通ってしまう（失敗安全）
  const body = text

  let summary = ''
  const sm = /^[ \t]*\**SUMMARY\**[ \t]*[:：][ \t]*/im.exec(text)
  if (sm) {
    const from = sm.index + sm[0].length
    let to = text.length
    if (findingsMarker && findingsMarker.index > sm.index) to = findingsMarker.index
    const blank = text.indexOf('\n\n', from)
    if (blank !== -1 && blank < to) to = blank
    summary = text.slice(from, to).trim()
  }

  const starts: { no: string; index: number; end: number }[] = []
  BLOCK_START_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = BLOCK_START_RE.exec(body))) {
    starts.push({ no: m[1].toUpperCase(), index: m.index, end: m.index + m[0].length })
  }
  if (starts.length === 0) {
    return {
      verdict,
      summary,
      findings: /FINDINGS\s*[:：]\s*none/i.test(body) ? [] : null
    }
  }
  const findings: ParsedFinding[] = []
  for (let i = 0; i < starts.length; i++) {
    const stop = i + 1 < starts.length ? starts[i + 1].index : body.length
    findings.push(parseBlock(starts[i].no, body.slice(starts[i].end, stop), body.slice(starts[i].index, stop)))
  }
  return { verdict, summary, findings }
}

/** 出力をブロックに分けられなかったとき、出力全体を 1 件の「不明」にするための指摘 */
export function wholeOutputAsUnclear(rawText: string): ParsedFinding {
  const text = rawText.trim()
  return {
    reviewerNo: '1',
    carried: false,
    severity: 'unknown',
    title: 'レビュアーの出力を指摘のブロックに分けられなかった',
    where: '',
    claim: text.slice(0, FALLBACK_TITLE_MAX_CHARS * 8),
    impact: '',
    suggestion: '',
    reviewerOrigin: 'none',
    block: text
  }
}

// ---------------------------------------------------------------------------
// `where:` の解釈
// ---------------------------------------------------------------------------

/** ファイルのラベル。`[ja]SKILL.md`・`[en]references/x.md`。区切りになる記号・括弧・節の印で終わる */
const LABEL_TOKEN_RE = /\[(?:ja|en)\][^\s,、;；:：()（）#§[\]「」"'`]+/g

/** 範囲の区切り（NFKC 後に残るもの）。`-`・`~`・`〜`・`–`・`—`・`−` */
const DASH = '[-~〜–—−]'

/** `L12`・`L12-30`・`L12-L30` */
const LINE_L_RE = new RegExp(`(?<![A-Za-z0-9])L(\\d+)(?:\\s*${DASH}\\s*L?(\\d+))?`, 'g')
/** `12 行`・`12-30 行` */
const LINE_GYO_AFTER_RE = new RegExp(`(\\d+)(?:\\s*${DASH}\\s*(\\d+))?\\s*行`, 'g')
/** `行 12`・`行12-30`・`line 12`・`lines 12-30` */
const LINE_GYO_BEFORE_RE = new RegExp(`(?:行|lines?)\\s*(\\d+)(?:\\s*${DASH}\\s*(\\d+))?`, 'gi')

/** `§3-1`・`§3-1 A`・`§ 4` */
const SECTION_MARK_RE = /§\s*(\d+(?:-\d+)*)(?:\s*([A-Z])(?![A-Za-z]))?/g
/** `## 4.`・`### 3-1 …` */
const SECTION_HASH_RE = /#{1,6}\s*(\d+(?:[-.]\d+)*)\.?/g

/** 見出し語として当てに行く最短の文字数（短い語は他の語の一部に当たりすぎる） */
const HEADING_TEXT_MIN_CHARS = 4

interface Heading {
  level: number
  text: string
  /** 1 始まり */
  line: number
  /** 次の同じ深さ以上の見出しの手前まで（両端を含む） */
  end: number
}

/** コードフェンスの外の見出しを集め、各見出しの範囲（次の同じ深さ以上の見出しの手前まで）を付ける */
export function collectHeadings(lines: string[]): Heading[] {
  const hs: Heading[] = []
  let fence: { ch: string; len: number } | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fm = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line)
    if (fm) {
      const ch = fm[1][0]
      const len = fm[1].length
      if (!fence) fence = { ch, len }
      else if (fence.ch === ch && len >= fence.len && /^[ \t]{0,3}[`~]+[ \t]*$/.test(line)) fence = null
      continue
    }
    if (fence) continue
    const hm = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/.exec(line)
    if (hm) hs.push({ level: hm[1].length, text: hm[2].normalize('NFKC'), line: i + 1, end: lines.length })
  }
  for (let i = 0; i < hs.length; i++) {
    for (let j = i + 1; j < hs.length; j++) {
      if (hs[j].level <= hs[i].level) {
        hs[i].end = hs[j].line - 1
        break
      }
    }
  }
  return hs
}

/** 見出しの本文が、節番号 `token`（`3-1`・`4`）で始まるか。`3` が `3-1` や `30` に当たらない */
function headingStartsWithNumber(text: string, token: string): boolean {
  const t = text.replace(/^§\s*/, '').replace(/^第\s*/, '')
  if (!t.startsWith(token)) return false
  const next = t.slice(token.length)
  if (/^[0-9]/.test(next)) return false
  if (/^-[0-9]/.test(next)) return false
  return true
}

function lineRangeOf(a: string, b: string | undefined): LineRange | null {
  const start = Number(a)
  const end = b === undefined ? start : Number(b)
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return null
  return { start, end }
}

/** 1 つのファイルの区間（ラベルの直後から次のラベルの手前まで）から、行範囲と節見出しの範囲を取り出す。取り出せないものがあれば ok:false */
function extractRanges(segment: string, lines: string[]): { ranges: LineRange[]; ok: boolean } {
  const ranges: LineRange[] = []
  let any = false
  let ok = true
  const addLine = (a: string, b: string | undefined): void => {
    any = true
    const r = lineRangeOf(a, b)
    // 行数を超える範囲・逆順の範囲は、申告の誤りとして「取り出せない」に倒す（失敗安全）
    if (!r || r.end > lines.length) ok = false
    else ranges.push(r)
  }
  for (const re of [LINE_L_RE, LINE_GYO_AFTER_RE, LINE_GYO_BEFORE_RE]) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(segment))) addLine(m[1], m[2])
  }
  const headings = collectHeadings(lines)
  const addHeadingRange = (h: Heading): void => {
    ranges.push({ start: h.line, end: h.end })
  }

  const sectionTokens: { token: string; letter?: string }[] = []
  SECTION_MARK_RE.lastIndex = 0
  let sm: RegExpExecArray | null
  while ((sm = SECTION_MARK_RE.exec(segment))) sectionTokens.push({ token: sm[1], letter: sm[2] })
  SECTION_HASH_RE.lastIndex = 0
  while ((sm = SECTION_HASH_RE.exec(segment))) sectionTokens.push({ token: sm[1].replace(/\./g, '-') })
  for (const st of sectionTokens) {
    any = true
    const hits = headings.filter((h) => headingStartsWithNumber(h.text, st.token))
    if (hits.length === 0) {
      ok = false
      continue
    }
    for (const h of hits) {
      let range: Heading = h
      if (st.letter) {
        const sub = headings.find(
          (x) =>
            x.line > h.line &&
            x.line <= h.end &&
            new RegExp(`^${st.letter}(?![A-Za-z0-9])`).test(x.text.replace(/^[(（]?/, ''))
        )
        // 子の見出しが見つからないときは、親の節の全体に引く（広い範囲は変更行に掛かりやすい＝失敗安全の側）
        if (sub) range = sub
      }
      addHeadingRange(range)
    }
  }

  if (!any) {
    // 行も節の番号も無いときは、見出しの語そのものが書かれていないかを見る
    const norm = segment.normalize('NFKC')
    for (const h of headings) {
      const t = h.text.replace(/^[0-9.\-§]+\s*/, '').trim()
      if (t.length >= HEADING_TEXT_MIN_CHARS && norm.includes(t)) {
        any = true
        addHeadingRange(h)
      }
    }
  }
  return { ranges, ok: ok && any }
}

function overlaps(a: LineRange, b: LineRange): boolean {
  return a.start <= b.end && b.start <= a.end
}

/**
 * `where:` を引き、変更行との突き合わせを行う。
 * - ラベルが 1 つも無い／ラベルが既知のファイルでない／境界情報が無い／範囲を取り出せない区間がある → missing
 * - すべて取り出せて、どれかが変更行に掛かる → diff
 * - すべて取り出せて、どれも掛からない → base
 */
export function resolveWhere(
  where: string,
  changedRanges: FileChangedRanges[],
  fileLines: Record<string, string[]>
): { machine: MachineOrigin; cited: CitedRange[] } {
  const w = where.normalize('NFKC')
  const tokens: { label: string; start: number; end: number }[] = []
  LABEL_TOKEN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = LABEL_TOKEN_RE.exec(w))) {
    tokens.push({ label: m[0].replace(/[.。]+$/, ''), start: m.index, end: m.index + m[0].length })
  }
  if (tokens.length === 0) return { machine: 'missing', cited: [] }

  const known = new Map(changedRanges.map((c) => [c.file, c]))
  const cited: CitedRange[] = []
  let ok = true
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    const info = known.get(t.label)
    const lines = fileLines[t.label]
    if (!info || !info.boundaryOk || !lines) {
      ok = false
      continue
    }
    const segment = w.slice(t.end, i + 1 < tokens.length ? tokens[i + 1].start : w.length)
    const ex = extractRanges(segment, lines)
    if (!ex.ok) ok = false
    for (const r of ex.ranges) {
      cited.push({ file: t.label, range: r, changed: info.ranges.some((c) => overlaps(c, r)) })
    }
  }
  if (!ok) return { machine: 'missing', cited }
  return { machine: cited.some((c) => c.changed) ? 'diff' : 'base', cited }
}

// ---------------------------------------------------------------------------
// 分類
// ---------------------------------------------------------------------------

/** 持ち越しの指摘で、レビュアーが回答しなかったものの代わりに足す指摘（由来は必ず不明） */
function unansweredCarried(c: CarriedFinding): ParsedFinding {
  return {
    reviewerNo: c.no,
    carried: true,
    severity: 'unknown',
    title: c.title,
    where: '',
    claim: `持ち越しの指摘 ${c.no} に、レビュアーが origin と where を返さなかった（元の位置: ${c.where || 'なし'}）`,
    impact: '',
    suggestion: '',
    reviewerOrigin: 'none',
    block: ''
  }
}

/**
 * 指摘を由来で分ける。台帳の `findings`（ゲートに渡る集合）での番号 `gateId` は、差分と不明だけに 1..N を出力順に振る
 * （原文由来は null）。渡した持ち越し（`carried`）でレビュアーの出力に無いものは、不明として末尾に足す。
 */
export function classifyFindings(
  parsed: ParsedFinding[],
  changedRanges: FileChangedRanges[],
  fileLines: Record<string, string[]>,
  carried: CarriedFinding[] = []
): ClassifiedFinding[] {
  const answered = new Set(parsed.filter((p) => p.carried).map((p) => p.reviewerNo))
  const all: ParsedFinding[] = [
    ...parsed,
    ...carried.filter((c) => !answered.has(c.no.toUpperCase())).map(unansweredCarried)
  ]
  let gate = 0
  return all.map((p) => {
    const { machine, cited } = p.where
      ? resolveWhere(p.where, changedRanges, fileLines)
      : { machine: 'missing' as MachineOrigin, cited: [] as CitedRange[] }
    const origin = settleOrigin(machine, p.reviewerOrigin)
    const agree = machine !== 'missing' && p.reviewerOrigin === machine
    return {
      ...p,
      machineOrigin: machine,
      origin,
      citedRanges: cited,
      agree,
      gateId: origin === 'base' ? null : String(++gate)
    }
  })
}

export function countOrigins(classified: ClassifiedFinding[]): OriginCounts {
  const c: OriginCounts = { diff: 0, base: 0, unclear: 0 }
  for (const f of classified) c[f.origin]++
  return c
}

/** 実効の verdict。差分 0 件かつ不明 0 件のときだけ approve（原文由来だけなら approve） */
export function effectiveVerdict(classified: ClassifiedFinding[]): 'approve' | 'needs-attention' {
  const c = countOrigins(classified)
  return c.diff === 0 && c.unclear === 0 ? 'approve' : 'needs-attention'
}

const ORIGIN_JA: Record<string, string> = { diff: '差分', base: '原文', unclear: '不明', none: '申告なし', missing: '取り出せず' }

function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, ' ').trim()
}

/**
 * 台帳の `findings` の本文（採用ゲートに渡る集合）。差分と不明だけを `[1]…[N]` に振り直す。
 * 各ブロックに元のレビュアー番号を残す。0 件なら `FINDINGS: none`。
 * 項目の値は 1 行へ平坦化する（値の中の行頭の `[n]` が、`extractFindingIds` の番号の列を壊さないように）。
 */
export function buildGateFindingsText(
  verdict: string,
  summary: string,
  classified: ClassifiedFinding[]
): string {
  const gate = classified.filter((f) => f.gateId !== null)
  const baseCount = classified.length - gate.length
  const out: string[] = [`VERDICT: ${verdict}`, '']
  const sum = oneLine(summary)
  out.push(
    `SUMMARY: ${sum || '（レビュアーの要約なし）'}${
      baseCount > 0 ? `（原文由来の指摘 ${baseCount} 件は受け皿へ入れ、この一覧には含めていない）` : ''
    }`
  )
  out.push('')
  if (gate.length === 0) {
    out.push('FINDINGS: none')
    return out.join('\n')
  }
  out.push('FINDINGS:')
  for (const f of gate) {
    out.push(`[${f.gateId}] severity: ${f.severity}`)
    out.push(`    title:      ${oneLine(f.title)}`)
    out.push(`    where:      ${oneLine(f.where) || '（記載なし）'}`)
    out.push(`    claim:      ${oneLine(f.claim) || '（記載なし）'}`)
    if (f.impact) out.push(`    impact:     ${oneLine(f.impact)}`)
    if (f.suggestion) out.push(`    suggestion: ${oneLine(f.suggestion)}`)
    out.push(
      `    origin:     ${ORIGIN_JA[f.origin]}（レビュアー申告: ${ORIGIN_JA[f.reviewerOrigin]}／機械判定: ${ORIGIN_JA[f.machineOrigin]}）`
    )
    out.push(`    （レビュアー番号: ${f.reviewerNo}）`)
  }
  return out.join('\n')
}
