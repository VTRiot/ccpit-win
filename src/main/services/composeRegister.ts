/**
 * composeRegister — 合成 CC が作業場に出した合成提案を、CCPIT が検査して登録する（Plan r10 §4-2・§4-4）。
 *
 * 流れ（`finalizeCompose`）:
 *   1. 範囲外書込みの検査: 起動前後の目録の差分（composeInventory）。違反があれば CAS で戻し、**登録しない**
 *   2. 合成提案 MD の検査: パーサ契約（§3 の全ファイル・ja の SKILL.md 必須）・request_id・supersedes・
 *      ファイルの削除/改名を求める元提案は理由つきで止める（fail-closed）
 *   3. golden が合成の後に動いていないか（スナップショットの再計測）。動いていれば拒否
 *   4. `base_hash`・`companion_base_hashes`・`compose_snapshot` を**機械計測の値で上書き**する（CC が書いた値は信用しない）
 *   5. 元提案の変更が合成提案に含まれるか（位置を見る三者照合）＋適応の宣言と選択の記録
 *   6. スナップショットを `compose-registry/<id>/snapshot.json` へ不変の写しとして保存し、提案を `~/.ccpit/proposals/` へ登録し、
 *      合成台帳へ書く（skill 単位の排他の下で）
 *   レビュー（Codex）と昇格画面への移動は呼び出し側（ipc）が行う。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import {
  checkSourceContainment,
  judgeContainment,
  listAdaptationKeys,
  parseAdaptedHunks,
  type AdaptationKeyEntry,
  type ContainmentComposite,
  type ContainmentSource,
  type UnsatisfiedHunk
} from './composeContainment'
import { contentHash, sha256Hex } from './composeHash'
import {
  diffInventory,
  isViolation,
  restoreViolations,
  takeInventory,
  type InventoryChange,
  type RestoreReport
} from './composeInventory'
import {
  readMergeLedger,
  registrySnapshotPath,
  serializeSnapshot,
  updateMergeLedger,
  withSkillLock,
  type ComposePaths,
  type MergeEntry
} from './composeLedger'
import {
  GoldenReadError,
  measureSnapshot,
  type ComposeWorkspace,
  type GoldenReader,
  type GuardState
} from './composeWorkspace'
import type { FileLockDeps } from './composeFileLock'
import { parseProposedFilesFromSection3, type ProposalFile } from './skillProposals'

// ---- frontmatter（フラットな key: value のみ） ----

export function splitFrontmatter(
  content: string
): { fm: string; body: string; eol: string } | null {
  const m = /^---(\r?\n)([\s\S]*?)\r?\n---(\r?\n)([\s\S]*)$/.exec(content)
  if (!m) return null
  return { fm: m[2], body: m[4], eol: m[1] }
}

export function readFm(content: string): Record<string, string> {
  const s = splitFrontmatter(content)
  const out: Record<string, string> = {}
  if (!s) return out
  for (const line of s.fm.split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i === -1) continue
    out[line.slice(0, i).trim()] = line
      .slice(i + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '')
  }
  return out
}

/** frontmatter のキーを置き換える（無ければ末尾に足す）。値が null ならそのキーを消す。本文は 1 バイトも変えない */
export function rewriteFrontmatter(
  content: string,
  updates: Record<string, string | null>
): string {
  const s = splitFrontmatter(content)
  if (!s) throw new Error('frontmatter が無い')
  const lines = s.fm.split(/\r?\n/)
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of lines) {
    const i = line.indexOf(':')
    const key = i === -1 ? '' : line.slice(0, i).trim()
    if (key && Object.prototype.hasOwnProperty.call(updates, key)) {
      seen.add(key)
      const v = updates[key]
      if (v !== null) out.push(`${key}: ${v}`)
      continue
    }
    out.push(line)
  }
  for (const [k, v] of Object.entries(updates)) {
    if (!seen.has(k) && v !== null) out.push(`${k}: ${v}`)
  }
  return `---${s.eol}${out.join(s.eol)}${s.eol}---${s.eol}${s.body}`
}

/** ファイルの削除・改名を求める元提案か（本件の対象外。合成を始めず理由つきで止める） */
export function detectUnsupportedSource(raw: string): string | null {
  const fm = readFm(raw)
  for (const key of [
    'delete_files',
    'deleted_files',
    'rename_files',
    'renamed_files',
    'move_files'
  ]) {
    if (fm[key]) return `frontmatter の ${key} でファイルの削除・改名を求めている`
  }
  const m = /(?:^|\r?\n)###[ \t]+(deleted?|removed?|renam(?:e|ed)|mv|move)[ \t]*:[^\r\n]*/i.exec(
    raw
  )
  if (m) return `§3 の見出し「${m[0].trim()}」でファイルの削除・改名を求めている`
  return null
}

// ---- 登録 ----

export interface ComposeSource {
  requestId: string
  filePath: string
  skillName: string
}

export interface AdaptedListItem {
  key: string
  sourceId: string
  relPath: string
  lang: 'ja' | 'en'
  reason: string
  preview: string
}

export type RegisterStage =
  | 'guard'
  | 'parse'
  | 'unsupported-source'
  | 'golden-moved'
  | 'golden-read'
  | 'containment'
  | 'conflict'

export type RegisterResult =
  | {
      ok: true
      compositeId: string
      filePath: string
      entry: MergeEntry
      adapted: AdaptedListItem[]
    }
  | {
      ok: false
      stage: Exclude<RegisterStage, 'guard'>
      error: string
      unsatisfied?: UnsatisfiedHunk[]
    }

export interface RegisterInput {
  paths: ComposePaths
  workspace: Pick<ComposeWorkspace, 'dir' | 'outDir' | 'snapshotText' | 'snapshotSha'>
  reader: GoldenReader
  proposalsDir: string
  /** 合成 CC が作業場の out/ に出した合成提案 MD の絶対パス */
  compositeFile: string
  sources: ComposeSource[]
  /** CC が AskUserQuestion の回答として報告した、オーナーが選んだ適応の鍵 */
  ackedAdaptations: string[]
  /** 改訂ルート: 置き換える旧合成提案の ID（作業場の meta から渡す。CC が書いた値は使わない） */
  revises?: string
  /** 選ばなかった提案の request_id（作業場の meta から渡す。台帳の `excluded` に写す。元提案と重なるものは捨てる） */
  excluded?: string[]
  now?: () => Date
  lockDeps?: FileLockDeps
}

const toPosix = (p: string): string => p.replace(/\\/g, '/')

function stampOf(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel !== '' && !rel.startsWith('..') && !/^[A-Za-z]:/.test(rel) && !rel.startsWith('/')
}

/** 元提案の base が今の golden と違うか（差分の取り方が使えない）。SKILL.md が golden と同じ、または base_hash が一致すれば違わない */
function isDiverged(
  fm: Record<string, string>,
  files: ProposalFile[],
  reader: GoldenReader,
  skill: string
): boolean {
  const gold = reader.read('ja', skill, 'SKILL.md')
  if (gold === null) return false
  const goldHash = contentHash('SKILL.md', gold)
  const mine = files.find((f) => f.lang !== 'en' && f.relPath === 'SKILL.md')
  if (mine && contentHash('SKILL.md', Buffer.from(mine.content, 'utf-8')) === goldHash) return false
  const base = (fm['base_hash'] || '').trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(base)) return true
  if (base === goldHash) return false
  const crlf = Buffer.from(
    gold.toString('latin1').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'),
    'latin1'
  )
  return base !== sha256Hex(crlf)
}

/** 元提案の MD を、含有検査の入力（各ファイルと今の golden の対応ファイル）にする */
export function buildContainmentSources(
  sources: ComposeSource[],
  rawById: Map<string, string>,
  reader: GoldenReader,
  skill: string
): { sources: ContainmentSource[] } | { error: string } {
  const out: ContainmentSource[] = []
  for (const s of sources) {
    const raw = rawById.get(s.requestId)!
    const sf = splitFrontmatter(raw)
    const sp = parseProposedFilesFromSection3(sf ? sf.body : raw, s.filePath)
    if (sp.error) return { error: `元提案 ${s.requestId} の §3 が読めない: ${sp.error}` }
    out.push({
      requestId: s.requestId,
      diverged: isDiverged(readFm(raw), sp.files, reader, skill),
      files: sp.files.map((f) => {
        const lang = f.lang === 'en' ? 'en' : 'ja'
        const gold = reader.read(lang, skill, toPosix(f.relPath))
        return {
          relPath: toPosix(f.relPath),
          lang,
          content: f.content,
          baseContent: gold === null ? null : gold.toString('utf-8')
        }
      })
    })
  }
  return { sources: out }
}

/** 合成を始める前に、元提案ごとの適応の鍵を一覧にする（作業場へ出す）。読めない元提案があれば error */
export function listSourceAdaptationKeys(
  sources: ComposeSource[],
  reader: GoldenReader,
  skill: string
): { keys: AdaptationKeyEntry[] } | { error: string } {
  const raw = new Map<string, string>()
  for (const s of sources) {
    try {
      raw.set(s.requestId, readFileSync(s.filePath, 'utf-8'))
    } catch {
      return { error: `元提案 ${s.requestId} の MD を読めません: ${s.filePath}` }
    }
  }
  const built = buildContainmentSources(sources, raw, reader, skill)
  if ('error' in built) return built
  return { keys: listAdaptationKeys(built.sources) }
}

/**
 * 改訂の登録の前提と、選択の引き継ぎ。
 * 前提: 旧エントリが registered・未改訂・同じ skill・元提案の集合が同じ。
 * 引き継ぎ（鍵は位置だけで内容を束縛しないため、次の 3 つがすべて成り立つ鍵だけ）:
 *   (i) 作業場のスナップショットが旧と同じ（golden が動いていない）
 *   (ii) 鍵が旧エントリの ackedAdaptations に在る
 *   (iii) そのハンクの内容ハッシュが、旧合成を同じ元提案・同じ golden で検査したときの同じ鍵のハンクと一致する
 */
function prepareRevision(
  i: RegisterInput,
  sources: ContainmentSource[],
  unsatisfied: UnsatisfiedHunk[],
  skill: string,
  srcIds: string[],
  srcRaw: Map<string, string>
): { carried: string[] } | { error: string } {
  const id = i.revises as string
  const old = readMergeLedger(i.paths.mergesPath).entries[id]
  if (!old) return { error: `改訂元の合成提案「${id}」が合成台帳に無い` }
  if (old.status !== 'registered')
    return { error: `改訂元の合成提案「${id}」の状態が registered でない (${old.status})` }
  if (old.revisedBy) return { error: `改訂元の合成提案「${id}」は既に ${old.revisedBy} に改訂されている` }
  if (old.skillName !== skill) return { error: `改訂元の合成提案「${id}」は別の skill 宛て` }
  const oldIds = old.sources.map((s) => s.requestId).sort()
  if (oldIds.length !== srcIds.length || oldIds.some((x, k) => x !== srcIds[k]))
    return { error: `改訂の元提案の集合が、改訂元「${id}」と違う` }
  if (old.snapshotSha256 !== i.workspace.snapshotSha) return { carried: [] }
  // 元提案が旧の登録後に変わっていれば、旧の検査と同じ入力でなくなる（鍵が同じでも別の変更）。引き継がない
  for (const rec of old.sources) {
    const raw = srcRaw.get(rec.requestId)
    if (raw === undefined || sha256Hex(raw.replace(/\r\n/g, '\n')) !== rec.sha256) return { carried: [] }
  }
  const file = readdirSafe(i.proposalsDir).find((n) => n.endsWith(`_${id}.md`))
  if (!file) return { carried: [] }
  let oldRaw: string
  try {
    oldRaw = readFileSync(join(i.proposalsDir, file), 'utf-8')
  } catch {
    return { carried: [] }
  }
  if (sha256Hex(oldRaw.replace(/\r\n/g, '\n')) !== old.proposalSha256) return { carried: [] }
  const sp = splitFrontmatter(oldRaw)
  const parsed = parseProposedFilesFromSection3(sp ? sp.body : oldRaw, file)
  if (parsed.error || parsed.files.length === 0) return { carried: [] }
  const oldCheck = checkSourceContainment({
    sources,
    composite: parsed.files.map((f) => ({
      relPath: toPosix(f.relPath),
      lang: f.lang === 'en' ? 'en' : 'ja',
      content: f.content
    }))
  })
  const oldByKey = new Map(oldCheck.unsatisfied.map((u) => [u.key, u.hunkSha]))
  const carried = [
    ...new Set(
      unsatisfied
        .filter((u) => old.ackedAdaptations.includes(u.key) && oldByKey.get(u.key) === u.hunkSha)
        .map((u) => u.key)
    )
  ]
  return { carried }
}

/**
 * 合成提案の登録。golden を git から読めなかったとき（`GoldenReadError`）は、書込みの段（6）に進む前に
 * `golden-read` として返す。「golden に無い」（`null`）と取り違えて `containment`・`golden-moved` に化けない。
 * 段 0〜5 は読み取りだけなので、止まったときスナップショットの写し・提案ファイル・台帳に何も残らない。
 */
export async function registerComposite(i: RegisterInput): Promise<RegisterResult> {
  try {
    // await が要る（外すと async の例外が、この try をすり抜けて呼び出し側へ抜ける）
    return await registerCompositeInner(i)
  } catch (err) {
    if (err instanceof GoldenReadError) {
      return { ok: false, stage: 'golden-read', error: err.message }
    }
    throw err
  }
}

async function registerCompositeInner(i: RegisterInput): Promise<RegisterResult> {
  const fail = (
    stage: Exclude<RegisterStage, 'guard'>,
    error: string,
    unsatisfied?: UnsatisfiedHunk[]
  ): RegisterResult => ({
    ok: false,
    stage,
    error,
    ...(unsatisfied ? { unsatisfied } : {})
  })
  const now = (i.now ?? ((): Date => new Date()))()

  // 0. 合成提案は作業場の out/ の中のファイルだけ（任意のファイルを登録させない）
  if (!existsSync(i.compositeFile) || !isInside(i.workspace.outDir, i.compositeFile)) {
    return fail('parse', `合成提案 MD が作業場の out/ に無い: ${i.compositeFile}`)
  }
  if (i.sources.length === 0) return fail('parse', '元提案が 0 件')
  const skill = i.sources[0].skillName
  if (i.sources.some((s) => s.skillName !== skill))
    return fail('conflict', '元提案が同じ skill 宛てでない')

  // 1. 元提案の検査（削除・改名は対象外）と、登録後の改変検出のための sha256
  const srcRaw = new Map<string, string>()
  for (const s of i.sources) {
    if (!existsSync(s.filePath))
      return fail('parse', `元提案 ${s.requestId} の MD が見つからない: ${s.filePath}`)
    const raw = readFileSync(s.filePath, 'utf-8')
    srcRaw.set(s.requestId, raw)
    const unsupported = detectUnsupportedSource(raw)
    if (unsupported) {
      return fail(
        'unsupported-source',
        `元提案 ${s.requestId} は合成できない（本件の対象外）: ${unsupported}`
      )
    }
  }

  // 2. 合成提案 MD の検査
  const compRaw = readFileSync(i.compositeFile, 'utf-8')
  const fmSplit = splitFrontmatter(compRaw)
  if (!fmSplit) return fail('parse', '合成提案 MD に frontmatter が無い')
  const compFm = readFm(compRaw)
  const compositeId = (compFm['request_id'] || '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$/.test(compositeId))
    return fail('parse', `request_id が不正: ${compositeId || '(無し)'}`)
  if (i.sources.some((s) => s.requestId === compositeId))
    return fail('conflict', '合成提案の request_id が元提案と同じ')
  const ledger = readMergeLedger(i.paths.mergesPath)
  if (ledger.entries[compositeId])
    return fail('conflict', `request_id「${compositeId}」は合成台帳に既にある`)
  if (existsSync(i.proposalsDir)) {
    const dup = readdirSafe(i.proposalsDir).find(
      (n) => n.endsWith(`_${compositeId}.md`) || n === `${compositeId}.md`
    )
    if (dup)
      return fail('conflict', `request_id「${compositeId}」の提案が提案プールに既にある (${dup})`)
  }
  const supersedes = [
    ...new Set(
      (compFm['supersedes'] || '')
        .split(/[;,]/)
        .map((x) => x.trim())
        .filter(Boolean)
    )
  ].sort()
  const srcIds = i.sources.map((s) => s.requestId).sort()
  if (supersedes.length !== srcIds.length || supersedes.some((x, k) => x !== srcIds[k])) {
    return fail(
      'parse',
      `supersedes が元提案の集合と一致しない（supersedes: ${supersedes.join(';') || '(無し)'} / 元提案: ${srcIds.join(';')}）`
    )
  }
  const target = (compFm['target'] || '').replace(/\\/g, '/')
  const tm = /skills\/([^/]+)\/SKILL\.md$/i.exec(target)
  if (!tm || tm[1] !== skill)
    return fail('parse', `target が skills/${skill}/SKILL.md でない: ${target || '(無し)'}`)

  const parsed = parseProposedFilesFromSection3(fmSplit.body, i.compositeFile)
  if (parsed.error) return fail('parse', `合成提案の §3 の構文エラー: ${parsed.error}`)
  if (parsed.files.length === 0) return fail('parse', '合成提案の §3 にファイルが無い')
  const compFiles = parsed.files

  // 3. golden が合成の後に動いていないか（スナップショットの再計測）
  const nowDoc = measureSnapshot(i.reader, skill)
  const nowText = serializeSnapshot(nowDoc)
  if (sha256Hex(nowText) !== i.workspace.snapshotSha || nowText !== i.workspace.snapshotText) {
    return fail(
      'golden-moved',
      'golden が合成を始めた後に動いた（または作業場のスナップショットが書き換えられた）。合成をやり直す'
    )
  }

  // 4. 機械計測の値（base_hash・companion_base_hashes・compose_snapshot）
  const goldSkillMd = i.reader.read('ja', skill, 'SKILL.md')
  const companion: string[] = []
  for (const f of compFiles) {
    const rel = toPosix(f.relPath)
    const lang = f.lang === 'en' ? 'en' : 'ja'
    if (lang === 'ja' && rel === 'SKILL.md') continue
    const gold = i.reader.read(lang, skill, rel)
    if (gold === null) continue // golden に無い付随ファイルは追加（申告は要らない）
    const mine = contentHash(rel, Buffer.from(f.content, 'utf-8'))
    const g = contentHash(rel, gold)
    if (mine === g) continue
    companion.push(`${lang === 'en' ? 'en:' : ''}${rel}=${g}`)
  }
  companion.sort()
  const measured: Record<string, string | null> = {
    base_hash: goldSkillMd ? contentHash('SKILL.md', goldSkillMd) : null,
    companion_base_hashes: companion.length > 0 ? companion.join(';') : null,
    compose_snapshot: i.workspace.snapshotSha,
    supersedes: srcIds.join(';'),
    adoption_label: 'recommend'
  }

  // 5. 元提案の変更が合成提案に含まれるか
  const compositeFilesForCheck: ContainmentComposite[] = compFiles.map((f) => ({
    relPath: toPosix(f.relPath),
    lang: f.lang === 'en' ? 'en' : 'ja',
    content: f.content
  }))
  const built = buildContainmentSources(i.sources, srcRaw, i.reader, skill)
  if ('error' in built) return fail('parse', built.error)
  const containmentSources = built.sources
  const check = checkSourceContainment({
    sources: containmentSources,
    composite: compositeFilesForCheck
  })
  // 改訂: 旧合成の検査と照らし、旧で選択済み・同じ鍵・同じ内容・同じ golden の適応だけを選択済みとして引き継ぐ
  let carried: string[] = []
  if (i.revises) {
    const rev = prepareRevision(i, containmentSources, check.unsatisfied, skill, srcIds, srcRaw)
    if ('error' in rev) return fail('conflict', rev.error)
    carried = rev.carried
  }
  const effectiveAcks = [...new Set([...i.ackedAdaptations, ...carried])]
  const verdict = judgeContainment(
    check.unsatisfied,
    parseAdaptedHunks(compFm['adapted_hunks']),
    effectiveAcks
  )
  if (!verdict.ok) {
    const parts: string[] = []
    if (verdict.undeclared.length)
      parts.push(
        `宣言の無い欠落 ${verdict.undeclared.length} 件（${verdict.undeclared
          .slice(0, 6)
          .map((u) => `鍵 ${u.key} : ${u.preview.slice(0, 120)}`)
          .join(' ／ ')}）`
      )
    if (verdict.declaredNotAcked.length)
      parts.push(
        `宣言はあるがオーナーの選択の記録が無い ${verdict.declaredNotAcked.length} 件（${verdict.declaredNotAcked
          .slice(0, 6)
          .map((u) => `鍵 ${u.key}`)
          .join(' ／ ')}）`
      )
    return fail('containment', `元提案の変更が合成提案に含まれていない: ${parts.join('、')}`, [
      ...verdict.undeclared,
      ...verdict.declaredNotAcked
    ])
  }
  const adaptedFm = new Map(
    parseAdaptedHunks(compFm['adapted_hunks']).map((a) => [a.key, a.reason])
  )
  const adapted: AdaptedListItem[] = check.unsatisfied.map((u) => ({
    key: u.key,
    sourceId: u.sourceId,
    relPath: u.relPath,
    lang: u.lang,
    reason: adaptedFm.get(u.key) ?? '',
    preview: u.preview
  }))

  // 6. 登録（skill 単位の排他の下で）。スナップショットの不変の写し → 提案プール → 台帳 の順
  const finalText = rewriteFrontmatter(compRaw, measured)
  const proposalSha256 = sha256Hex(finalText.replace(/\r\n/g, '\n'))
  const filePath = join(i.proposalsDir, `${stampOf(now)}_${compositeId}.md`)
  // 選ばなかった提案: 元提案と合成提案自身を除き、昇順・重複なしにする（`sources` とは別の集合）。形の不正な ID は捨てる。
  // 改訂のときは meta の値を使わず、下のロックの中で台帳の旧エントリのものに置き換える（作業場の meta は CC が触れる場所のため）
  const excludedIds = [...new Set(i.excluded ?? [])]
    // 選べた提案の request_id をそのまま保つ（形・長さで捨てない。捨てると、選ばなかったはずの提案が競合の母数に残る）。
    // 台帳の鍵・照合に使うだけで解釈しないので、空（選べた提案には無い）だけを捨てる
    .filter((x) => typeof x === 'string' && x.length > 0)
    .filter((x) => !srcIds.includes(x) && x !== compositeId)
    .sort()
  const entry: MergeEntry = {
    compositeId,
    skillName: skill,
    sources: i.sources.map((s) => ({
      requestId: s.requestId,
      sha256: sha256Hex(srcRaw.get(s.requestId)!.replace(/\r\n/g, '\n')),
      filePath: s.filePath,
      skillName: s.skillName
    })),
    proposalSha256,
    snapshotSha256: i.workspace.snapshotSha,
    containmentOk: true,
    // 台帳に残すのは、実際に受理した適応の鍵だけ（CC が余分に書いた鍵を「オーナーが選んだ適応」として残さない）
    ackedAdaptations: [...new Set(check.unsatisfied.map((u) => u.key))]
      .filter((k) => effectiveAcks.includes(k))
      .sort(),
    status: 'registered',
    registeredAt: now.toISOString(),
    ...(i.revises ? { revises: i.revises } : {}),
    ...(excludedIds.length > 0 ? { excluded: excludedIds } : {})
  }
  return withSkillLock(
    i.paths,
    skill,
    async (): Promise<RegisterResult> => {
      if (i.revises) {
        const cur = readMergeLedger(i.paths.mergesPath).entries[i.revises]
        if (!cur || cur.status !== 'registered' || cur.revisedBy) {
          return fail('conflict', `改訂元の合成提案「${i.revises}」は、既に改訂された・適用された・台帳に無い`)
        }
        // 選ばなかった提案は旧エントリのものを引き継ぐ（引き継がないと、旧が revisedBy になった瞬間に競合の母数へ戻る）
        const carriedExcluded = (Array.isArray(cur.excluded) ? cur.excluded : []).filter(
          (x) => !srcIds.includes(x) && x !== compositeId
        )
        if (carriedExcluded.length > 0) entry.excluded = [...new Set(carriedExcluded)].sort()
        else delete entry.excluded
      }
      const snapDest = registrySnapshotPath(i.paths, compositeId)
      mkdirSync(dirname(snapDest), { recursive: true })
      writeFileSync(snapDest, i.workspace.snapshotText, 'utf-8')
      if (sha256Hex(readFileSync(snapDest, 'utf-8')) !== i.workspace.snapshotSha) {
        return fail('golden-moved', 'スナップショットの写しの sha256 が一致しない（書込みの失敗）')
      }
      mkdirSync(i.proposalsDir, { recursive: true })
      const tmp = `${filePath}.tmp-${process.pid}`
      writeFileSync(tmp, finalText, 'utf-8')
      renameSync(tmp, filePath)
      await updateMergeLedger(
        i.paths.mergesPath,
        (l) => {
          l.entries[compositeId] = entry
          if (i.revises && l.entries[i.revises]) l.entries[i.revises].revisedBy = compositeId
        },
        i.lockDeps
      )
      return { ok: true, compositeId, filePath, entry, adapted }
    },
    i.lockDeps
  )
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

// ---- 終了後の検査＋登録 ----

export type FinalizeResult =
  | RegisterResult
  | {
      ok: false
      stage: 'guard'
      error: string
      violations: InventoryChange[]
      restore: RestoreReport
    }

const CHANGE_LABEL: Record<string, string> = {
  modified: '変更',
  created: '新規作成',
  deleted: '削除',
  'type-changed': '種別の変更',
  'link-changed': 'リンクの変更'
}

/** 範囲外書込みの失敗文: 違反したパス（最大 5 件）と、戻した/戻せなかった内訳をパスつきで示す */
export function describeGuardFailure(violations: InventoryChange[], restore: RestoreReport): string {
  const norm = (p: string): string => p.replace(/\\/g, '/')
  const head = violations
    .slice(0, 5)
    .map((v) => `${norm(v.path)}（${CHANGE_LABEL[v.change] ?? v.change}）`)
  const rest = violations.length - head.length
  const kept: string[] = [
    ...restore.skipped.map((s) => `${norm(s.path)}（${s.reason}）`),
    ...restore.manual.map((m) => `${norm(m.path)}（${CHANGE_LABEL[m.change] ?? m.change}・自動では戻さない）`)
  ]
  const keptHead = kept.slice(0, 5)
  const parts = [
    `合成 CC が書いてはならない場所に変更がある（${violations.length} 件）。登録しない。`,
    `違反: ${head.join(' ／ ')}${rest > 0 ? ` ／ ほか ${rest} 件` : ''}`,
    `戻した ${restore.restored.length} 件${
      restore.restored.length
        ? `: ${restore.restored.slice(0, 5).map(norm).join(' ／ ')}${restore.restored.length > 5 ? ` ／ ほか ${restore.restored.length - 5} 件` : ''}`
        : ''
    }`,
    `戻さず残した ${kept.length} 件${
      kept.length ? `: ${keptHead.join(' ／ ')}${kept.length > 5 ? ` ／ ほか ${kept.length - 5} 件` : ''}` : ''
    }`
  ]
  return parts.join('。')
}

/** 合成 CC の終了後: 範囲外書込みを測って（違反があれば登録しない。golden-apply・overlay・登録簿のみ戻す）、無ければ検査して登録する */
export async function finalizeCompose(
  i: RegisterInput & { guard: GuardState }
): Promise<FinalizeResult> {
  const after = takeInventory(i.guard.roots)
  const changes = diffInventory(i.guard.before, after)
  const violations = changes.filter(isViolation)
  if (violations.length > 0) {
    const restore = restoreViolations(changes, i.guard.baseline)
    return {
      ok: false,
      stage: 'guard',
      error: describeGuardFailure(violations, restore),
      violations,
      restore
    }
  }
  return registerComposite(i)
}
