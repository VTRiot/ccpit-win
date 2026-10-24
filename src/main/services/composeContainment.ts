/**
 * composeContainment — 合成提案が、元提案の変更をすべて含んでいるかの機械検査（Plan r10 §4-4 項 6・Codex r3 [1]・r4 [1]・r5 [1]）。
 *
 * 行の集合の比較ではなく、**位置を見る三者照合**:
 *   基準 = 今の golden の対応ファイル B、一方 = 元提案のファイル S、もう一方 = 合成提案のファイル C。
 *   B→S の差分をハンク（追加・削除・置換。移動は削除と追加の組）の列として取り、各ハンクを B 上の位置（前後の文脈行つき）で C へ照らす。
 *   ハンクが指す箇所で、C が S と同じ結果になっているときだけ満たす。
 *   - 前後の文脈行（ハンクの直前・直後の B の行）が C でも残っていること。変わっていたら「文脈が変わった」＝満たさない
 *   - 置換・削除で消えるはずの B の行が、C に（文脈の間に）残っていないこと
 *   - 追加される行（置換後の行）が、C の同じ文脈の間にひとまとまりで現れること（他の元提案の追加が同じ場所に混ざるのは許す）
 *   同じ行が別の位置にあるだけでは満たさない（重複行の一方だけの削除・行の移動を見逃さない）。
 * 新規依存は増やさず、Myers の O(ND) 差分を自前で持つ。
 */

import { sha256Hex, toLines } from './composeHash'

/** 編集距離がこれを超える差分は追わない（満たさない側に倒す）。実在の SKILL.md・md2html.cjs の合成は数百の桁 */
const MAX_EDIT_DISTANCE = 3000

export interface Hunk {
  /** 基準 B の [baseStart, baseEnd) が srcLines に置き換わる。baseStart==baseEnd は純粋な挿入 */
  baseStart: number
  baseEnd: number
  srcLines: string[]
}

/** Myers の O(ND) 差分。戻りは、a の各行が b のどの行に対応するか（無ければ -1）と、b の各行が a のどの行に対応するか */
export function alignLines(a: string[], b: string[]): { aToB: Int32Array; bToA: Int32Array } {
  const n = a.length
  const m = b.length
  const aToB = new Int32Array(n).fill(-1)
  const bToA = new Int32Array(m).fill(-1)
  // 先頭と末尾の一致を先に取り除く（ほとんどのファイルは大半が同じ）
  let pre = 0
  while (pre < n && pre < m && a[pre] === b[pre]) {
    aToB[pre] = pre
    bToA[pre] = pre
    pre++
  }
  let sufA = n
  let sufB = m
  while (sufA > pre && sufB > pre && a[sufA - 1] === b[sufB - 1]) {
    sufA--
    sufB--
    aToB[sufA] = sufB
    bToA[sufB] = sufA
  }
  const N = sufA - pre
  const M = sufB - pre
  if (N === 0 || M === 0) return { aToB, bToA }

  const max = N + M
  const offset = max + 2
  const v = new Int32Array(2 * max + 6)
  // 各ラウンドの直前の V のうち、そのラウンドが読む範囲 [-d-1, d+1] だけを残す（メモリを D の 2 乗に抑える）
  const trace: Array<{ lo: number; arr: Int32Array }> = []
  let found = false
  let overflow = false
  for (let d = 0; d <= max && !found; d++) {
    if (d > MAX_EDIT_DISTANCE) {
      overflow = true
      break
    }
    trace.push({ lo: -d - 1, arr: v.slice(offset - d - 1, offset + d + 2) })
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1]
      else x = v[offset + k - 1] + 1
      let y = x - k
      while (x < N && y < M && a[pre + x] === b[pre + y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= N && y >= M) {
        found = true
        break
      }
    }
  }
  // 差が大きすぎて追いきれないときは、中間を「一致なし」のままにする（満たさない側に倒れる＝安全側）
  if (overflow) return { aToB, bToA }
  // 後ろ向きにたどって一致を復元する
  let x = N
  let y = M
  for (let d = trace.length - 1; d > 0; d--) {
    const t = trace[d]
    const at = (k: number): number => t.arr[k - t.lo]
    const k = x - y
    let prevK: number
    if (k === -d || (k !== d && at(k - 1) < at(k + 1))) prevK = k + 1
    else prevK = k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      x--
      y--
      aToB[pre + x] = pre + y
      bToA[pre + y] = pre + x
    }
    x = prevX
    y = prevY
  }
  // d=0 の対角線（先頭からの一致）
  while (x > 0 && y > 0) {
    x--
    y--
    aToB[pre + x] = pre + y
    bToA[pre + y] = pre + x
  }
  return { aToB, bToA }
}

/** B→S の差分をハンクの列にする */
export function diffHunks(base: string[], other: string[]): Hunk[] {
  const { aToB } = alignLines(base, other)
  const hunks: Hunk[] = []
  let bi = 0 // base の位置
  let oi = 0 // other の位置
  while (bi < base.length || oi < other.length) {
    if (bi < base.length && aToB[bi] === oi && oi < other.length) {
      bi++
      oi++
      continue
    }
    const hs = bi
    const os = oi
    // 次の一致まで進める（base 側は aToB が -1 の行、other 側は一致先に達するまで）
    let nextMatchBase = bi
    while (nextMatchBase < base.length && aToB[nextMatchBase] === -1) nextMatchBase++
    const nextMatchOther = nextMatchBase < base.length ? aToB[nextMatchBase] : other.length
    bi = nextMatchBase
    oi = nextMatchOther
    hunks.push({ baseStart: hs, baseEnd: bi, srcLines: other.slice(os, oi) })
    if (hs === bi && os === oi) break // 安全弁（無限ループ防止）
  }
  return hunks
}

function containsBlock(hay: string[], from: number, to: number, block: string[]): boolean {
  if (block.length === 0) return true
  for (let i = from; i + block.length <= to; i++) {
    let ok = true
    for (let j = 0; j < block.length; j++) {
      if (hay[i + j] !== block[j]) {
        ok = false
        break
      }
    }
    if (ok) return true
  }
  return false
}

export interface UnsatisfiedHunk {
  sourceId: string
  lang: 'ja' | 'en'
  relPath: string
  baseStart: number
  baseEnd: number
  reason:
    | 'file-missing'
    | 'context-changed'
    | 'removed-line-remains'
    | 'added-lines-missing'
    | 'line-missing'
  /** 画面に出す要約（元提案が行おうとした変更の頭の数行） */
  preview: string
  /** 適応の宣言・承認の鍵 */
  key: string
  /** この欠落の内容のハッシュ（鍵は位置だけで内容を束縛しないため。改訂での選択の引き継ぎが照合に使う） */
  hunkSha: string
}

export interface ContainmentSourceFile {
  relPath: string
  lang: 'ja' | 'en'
  content: string
  /** 今の golden の対応ファイル。無ければ null（新規ファイル） */
  baseContent: string | null
}

export interface ContainmentSource {
  requestId: string
  files: ContainmentSourceFile[]
  /** 元提案の base が今の golden と違う（差分の取り方が使えない）。全行を対象にする */
  diverged?: boolean
}

export interface ContainmentComposite {
  relPath: string
  lang: 'ja' | 'en'
  content: string
}

export const adaptationKey = (
  sourceId: string,
  lang: 'ja' | 'en',
  relPath: string,
  start: number,
  end: number
): string => `${sourceId}|${lang}:${relPath}|${start}-${end}`

const previewOf = (lines: string[], removed: string[]): string => {
  const head = (xs: string[]): string =>
    xs
      .slice(0, 3)
      .map((l) => l.slice(0, 80))
      .join(' / ')
  const parts: string[] = []
  if (removed.length) parts.push(`削除: ${head(removed)}`)
  if (lines.length) parts.push(`追加: ${head(lines)}`)
  return parts.join(' ／ ') || '(空の変更)'
}

/** 元提案の変更が合成提案に含まれているかを検査する。満たさないハンクを返す */
export function checkSourceContainment(input: {
  sources: ContainmentSource[]
  composite: ContainmentComposite[]
}): { ok: boolean; unsatisfied: UnsatisfiedHunk[] } {
  const unsat: UnsatisfiedHunk[] = []
  const compByKey = new Map(
    input.composite.map((c) => [`${c.lang}:${c.relPath.replace(/\\/g, '/')}`, c])
  )

  for (const src of input.sources) {
    for (const f of src.files) {
      const rel = f.relPath.replace(/\\/g, '/')
      const comp = compByKey.get(`${f.lang}:${rel}`)
      const S = toLines(f.content)
      const B = f.baseContent === null ? [] : toLines(f.baseContent)
      if (f.baseContent !== null && !src.diverged && B.join('\n') === S.join('\n')) continue // 変更なし
      if (!comp) {
        unsat.push({
          sourceId: src.requestId,
          lang: f.lang,
          relPath: rel,
          baseStart: 0,
          baseEnd: 0,
          reason: 'file-missing',
          preview: `ファイル ${f.lang === 'en' ? 'en:' : ''}${rel} が合成提案に無い`,
          key: adaptationKey(src.requestId, f.lang, rel, 0, 0),
          hunkSha: sha256Hex(`file-missing\n${S.join('\n')}`)
        })
        continue
      }
      const C = toLines(comp.content)

      if (src.diverged) {
        // base が今の golden と違う: 差分が使えないので、元提案の空でない全行が合成提案に順序どおり現れることを要求する
        // 欠落が多数でも、オーナーに見せる単位は「このファイルについて古い提案をどう扱うか」の 1 件（0-0）にまとめる
        // （行ごとに 300 件の適応を並べても判断できない）。宣言と選択の記録が要る点は変わらない
        let cursor = 0
        const missing: string[] = []
        S.forEach((line) => {
          if (line.trim() === '') return
          let found = -1
          for (let i = cursor; i < C.length; i++) {
            if (C[i] === line) {
              found = i
              break
            }
          }
          if (found === -1) missing.push(line)
          else cursor = found + 1
        })
        if (missing.length > 0) {
          unsat.push({
            sourceId: src.requestId,
            lang: f.lang,
            relPath: rel,
            baseStart: 0,
            baseEnd: 0,
            reason: 'line-missing',
            preview: `古い提案（base が今の golden と違う）の ${missing.length} 行が合成提案に無い。例: ${previewOf(missing.slice(0, 3), [])}`,
            key: adaptationKey(src.requestId, f.lang, rel, 0, 0),
            hunkSha: sha256Hex(`line-missing\n${missing.join('\n')}`)
          })
        }
        continue
      }

      const hunks = diffHunks(B, S)
      const { aToB: baseToC } = alignLines(B, C)
      for (const h of hunks) {
        const preview = previewOf(h.srcLines, B.slice(h.baseStart, h.baseEnd))
        const key = adaptationKey(src.requestId, f.lang, rel, h.baseStart, h.baseEnd)
        const hunkSha = sha256Hex(
          `hunk\n${B.slice(h.baseStart, h.baseEnd).join('\n')}\n---\n${h.srcLines.join('\n')}`
        )
        const push = (reason: UnsatisfiedHunk['reason']): void => {
          unsat.push({
            sourceId: src.requestId,
            lang: f.lang,
            relPath: rel,
            baseStart: h.baseStart,
            baseEnd: h.baseEnd,
            reason,
            preview,
            key,
            hunkSha
          })
        }
        // 前後の文脈行（基準 B の h の直前・直後の行）が C にも残っていること
        let pa = -1
        if (h.baseStart > 0) {
          const m = baseToC[h.baseStart - 1]
          if (m === -1) {
            push('context-changed')
            continue
          }
          pa = m
        }
        let pb = C.length
        if (h.baseEnd < B.length) {
          const m = baseToC[h.baseEnd]
          if (m === -1) {
            push('context-changed')
            continue
          }
          pb = m
        }
        if (pa >= pb) {
          push('context-changed')
          continue
        }
        // 消えるはずの B の行が、C の文脈の間に残っていない
        let remains = false
        for (let x = h.baseStart; x < h.baseEnd; x++) {
          if (baseToC[x] !== -1) {
            remains = true
            break
          }
        }
        if (remains) {
          push('removed-line-remains')
          continue
        }
        // 追加される行が、C の文脈の間にひとまとまりで現れる
        if (!containsBlock(C, pa + 1, pb, h.srcLines)) {
          push('added-lines-missing')
        }
      }
    }
  }
  return { ok: unsat.length === 0, unsatisfied: unsat }
}

export interface AdaptationKeyEntry {
  sourceId: string
  lang: 'ja' | 'en'
  relPath: string
  key: string
  /** 元提案がこの位置で行おうとする変更の頭の数行 */
  preview: string
  /** base が今の golden と違う元提案の、ファイル単位の鍵（0-0） */
  diverged: boolean
}

/**
 * 元提案ごとの「適応の鍵」の一覧。合成を始める前に、元提案と今の golden だけから決まる（合成提案に依らない）。
 * 合成 CC は、そのままの形で載せられなかった変更の鍵を、ここから**そのまま**写して `adapted_hunks` に宣言する（鍵を推測させない）。
 */
export function listAdaptationKeys(sources: ContainmentSource[]): AdaptationKeyEntry[] {
  const out: AdaptationKeyEntry[] = []
  for (const src of sources) {
    for (const f of src.files) {
      const rel = f.relPath.replace(/\\/g, '/')
      const S = toLines(f.content)
      const B = f.baseContent === null ? [] : toLines(f.baseContent)
      if (f.baseContent !== null && !src.diverged && B.join('\n') === S.join('\n')) continue
      if (src.diverged || f.baseContent === null) {
        out.push({
          sourceId: src.requestId,
          lang: f.lang,
          relPath: rel,
          key: adaptationKey(src.requestId, f.lang, rel, 0, 0),
          preview: src.diverged
            ? '古い提案（base が今の golden と違う）。ファイル単位の鍵。golden が既に反映している等で載せない行があるときに宣言する'
            : '新規ファイル（golden に無い）',
          diverged: !!src.diverged
        })
        continue
      }
      // 合成がこのファイルを丸ごと落としたときに検査が要求する鍵（file-missing）。ハンク鍵と別に、ファイル単位の 0-0 を必ず出す
      out.push({
        sourceId: src.requestId,
        lang: f.lang,
        relPath: rel,
        key: adaptationKey(src.requestId, f.lang, rel, 0, 0),
        preview:
          'このファイルを合成提案に載せない（§3 に書かない）とき、またはファイル先頭への追加を載せなかったときの鍵',
        diverged: false
      })
      for (const h of diffHunks(B, S)) {
        if (h.baseStart === 0 && h.baseEnd === 0) continue // ファイル先頭への挿入は、上のファイル単位の鍵と同じ 0-0
        out.push({
          sourceId: src.requestId,
          lang: f.lang,
          relPath: rel,
          key: adaptationKey(src.requestId, f.lang, rel, h.baseStart, h.baseEnd),
          preview: previewOf(h.srcLines, B.slice(h.baseStart, h.baseEnd)),
          diverged: false
        })
      }
    }
  }
  return out
}

// ---- 適応の宣言（frontmatter `adapted_hunks`）と、オーナーの選択の記録（台帳 `ackedAdaptations`） ----

export interface AdaptedHunk {
  key: string
  reason: string
}

/**
 * `adapted_hunks: <sourceId>|<lang>:<relPath>|<start>-<end>|<reason>;…`（`;` と `|` は理由に使わない）。
 * 形の崩れた項目は捨てる（宣言として数えない）
 */
export function parseAdaptedHunks(raw: string | undefined): AdaptedHunk[] {
  const out: AdaptedHunk[] = []
  for (const item of (raw || '').split(';')) {
    const parts = item.split('|')
    if (parts.length < 4) continue
    const [sourceId, fileSpec, range, ...rest] = parts.map((s) => s.trim())
    const m = /^(ja|en):(.+)$/.exec(fileSpec)
    const r = /^(\d+)-(\d+)$/.exec(range)
    if (!sourceId || !m || !r) continue
    out.push({
      key: adaptationKey(
        sourceId,
        m[1] as 'ja' | 'en',
        m[2].replace(/\\/g, '/'),
        Number(r[1]),
        Number(r[2])
      ),
      reason: rest.join('|')
    })
  }
  return out
}

export type ContainmentVerdict =
  | { ok: true; adaptedAccepted: string[] }
  | { ok: false; undeclared: UnsatisfiedHunk[]; declaredNotAcked: UnsatisfiedHunk[] }

/** 満たさないハンクを、宣言（adapted_hunks）と選択の記録（acked）に照らして合否を決める */
export function judgeContainment(
  unsatisfied: UnsatisfiedHunk[],
  adapted: AdaptedHunk[],
  acked: readonly string[]
): ContainmentVerdict {
  const declared = new Set(adapted.map((a) => a.key))
  const ack = new Set(acked)
  const undeclared = unsatisfied.filter((u) => !declared.has(u.key))
  const declaredNotAcked = unsatisfied.filter((u) => declared.has(u.key) && !ack.has(u.key))
  if (undeclared.length === 0 && declaredNotAcked.length === 0) {
    return { ok: true, adaptedAccepted: unsatisfied.map((u) => u.key) }
  }
  return { ok: false, undeclared, declaredNotAcked }
}
