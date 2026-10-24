/**
 * composeLedger — 合成提案の台帳 `~/.ccpit/proposal-merges.json` と、昇格の前後の検査（葉モジュール。goldenPromotion から import される）。
 *
 * Plan r10 §4-2・§4-4:
 * - 合成台帳: 合成提案ごとに、元提案（sources）・登録時の提案 MD の sha256・状態・選択の記録（ackedAdaptations）・適用記録を持つ。
 *   書込みは CCPIT だけ。プロセス間ロック＋世代＋tmp+rename（composeFileLock）
 * - 競合母数からの除外（supersedes）は「有効」の条件がすべて成り立つときだけ（isCompositeActive）
 * - 昇格の前（契約ツールを起動する前）: 登録後に不変の写し（compose-registry）だけを読み、golden の全ファイルを測り直す（composePreflight）
 * - 昇格の後: 適用記録を先に書き、元提案・合成提案を adopted にし、台帳を applied にする。途中で失敗しても、
 *   golden の実測が正本なので、実測で検証してから追い付き更新する（冪等）
 * - skill 単位の排他: 同じ skill の合成の起動・登録・昇格後の更新は直列にする
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { atomicJsonUpdate, withFileLock, type FileLockDeps } from './composeFileLock'
import { contentHash, sha256Hex } from './composeHash'

export type MergeStatus = 'registered' | 'applied_pending_states' | 'applied'

export interface MergeSourceRecord {
  requestId: string
  /** 登録時の元提案 MD の sha256（改変の検出） */
  sha256: string
  filePath: string
  skillName: string
}

export interface MergeApplication {
  /** 契約ツールが作った golden のコミット */
  commit: string
  /** 適用した対象ファイルと、golden 上の期待 sha256 */
  files: Array<{ lang: 'ja' | 'en'; relPath: string; sha256: string }>
  /** adopted にする request ID（合成提案＋元提案） */
  requestIds: string[]
  /** 台帳内で単調増加する世代 */
  generation: number
  appliedAt: string
}

export interface MergeEntry {
  compositeId: string
  skillName: string
  sources: MergeSourceRecord[]
  /** 登録時の合成提案 MD の sha256（`computeProposalHash` と同じ規則＝LF 正規化後） */
  proposalSha256: string
  /** frontmatter `compose_snapshot`（snapshot.json の sha256） */
  snapshotSha256: string
  /** 元提案の変更が合成提案に含まれる検査（checkSourceContainment＋適応の選択）を通った */
  containmentOk: boolean
  /** オーナーが選んだ適応の鍵 */
  ackedAdaptations: string[]
  status: MergeStatus
  registeredAt: string
  application?: MergeApplication
  /** 改訂ルート: この合成提案が改訂した旧合成提案の ID */
  revises?: string
  /** 改訂ルート: この合成提案を改訂した新合成提案の ID（旧の提案状態は変えない。旧は approve でないので昇格候補にならない） */
  revisedBy?: string
  /**
   * 選ばなかった提案（合成を始めたとき、元提案に選べたが選ばなかったもの）の request_id。`sources` とは別の集合
   * （`supersedes` との一致検査 b を壊さないため混ぜない）。この合成が昇格を完了するまで（または却下されるまで）、
   * 昇格候補の競合の母数から外れる。提案ファイルと提案の状態は書き換えない（導出は deriveComposeHolds）
   */
  excluded?: string[]
}

export interface MergeLedger {
  version: 1
  /** 書込みのたびに増える */
  generation: number
  entries: Record<string, MergeEntry>
}

export interface ComposePaths {
  /** `~/.ccpit` */
  ccpitDir: string
  mergesPath: string
  registryDir: string
  workspacesDir: string
  locksDir: string
}

export function getComposePaths(ccpitDir: string = join(homedir(), '.ccpit')): ComposePaths {
  return {
    ccpitDir,
    mergesPath: join(ccpitDir, 'proposal-merges.json'),
    registryDir: join(ccpitDir, 'compose-registry'),
    workspacesDir: join(ccpitDir, 'compose'),
    locksDir: join(ccpitDir, 'compose', '.locks')
  }
}

const emptyLedger = (): MergeLedger => ({ version: 1, generation: 0, entries: {} })

function normalizeLedger(raw: unknown): MergeLedger {
  const l = emptyLedger()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return l
  const r = raw as Partial<MergeLedger>
  if (typeof r.generation === 'number') l.generation = r.generation
  if (r.entries && typeof r.entries === 'object' && !Array.isArray(r.entries))
    l.entries = { ...(r.entries as Record<string, MergeEntry>) }
  return l
}

export function readMergeLedger(mergesPath: string): MergeLedger {
  if (!existsSync(mergesPath)) return emptyLedger()
  try {
    const raw = readFileSync(mergesPath, 'utf-8')
    return raw.trim() === '' ? emptyLedger() : normalizeLedger(JSON.parse(raw))
  } catch {
    return emptyLedger()
  }
}

/** 台帳を更新する（プロセス間ロック＋書込み直前の再確認＋tmp+rename。世代を 1 進める） */
export async function updateMergeLedger(
  mergesPath: string,
  mutate: (l: MergeLedger) => void,
  deps: FileLockDeps = {}
): Promise<MergeLedger> {
  return atomicJsonUpdate<MergeLedger>(
    mergesPath,
    (cur) => {
      const l = normalizeLedger(cur)
      mutate(l)
      l.generation += 1
      return l
    },
    emptyLedger,
    deps
  )
}

/** skill 単位の排他（プロセス間）。同じ skill の合成の起動・登録・昇格後の更新が互いの状態を上書きしない */
export async function withSkillLock<T>(
  paths: ComposePaths,
  skillName: string,
  fn: () => Promise<T> | T,
  deps: FileLockDeps = {}
): Promise<T> {
  const safe = skillName.replace(/[^A-Za-z0-9._-]/g, '_')
  return withFileLock(join(paths.locksDir, `${safe}.lock`), fn, deps)
}

// ---- 競合母数からの除外（scanProposalCandidates） ----

/** frontmatter `supersedes: id;id` を集合にする */
export function parseSupersedes(raw: string | undefined): string[] {
  return (raw || '')
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export interface CompositeActiveInput {
  entry: MergeEntry | undefined
  /** 候補走査で読んだ合成提案 MD の sha256（`PromotionItem.proposalHash`） */
  proposalSha256: string
  supersedes: string[]
  skillName: string
}

/**
 * 合成提案が「有効」か（Plan §4-4 の条件 a〜c。d＝レビュー approve の拘束・e＝base が今の golden と一致は、候補走査が
 * 既にその提案を候補にしている事実と `diffState === 'modified'` で呼び出し側が確かめる）。1 つでも欠ければ無効。
 */
export function isCompositeActive(i: CompositeActiveInput): { active: boolean; failed: string[] } {
  const failed: string[] = []
  const e = i.entry
  if (!e || e.status !== 'registered' || e.proposalSha256 !== i.proposalSha256)
    failed.push('a:登録済みで提案 MD の sha256 が台帳と一致')
  const a = [...new Set(i.supersedes)].sort()
  const b = e ? e.sources.map((s) => s.requestId).sort() : []
  if (!e || a.length !== b.length || a.some((x, idx) => x !== b[idx]))
    failed.push('b:supersedes の集合が台帳の sources と一致')
  if (!e || e.skillName !== i.skillName || e.sources.some((s) => s.skillName !== i.skillName))
    failed.push('c:元提案がすべて同じ skill 宛て')
  if (e && !e.containmentOk) failed.push('f:元提案の変更が合成提案に含まれる検査を通っていない')
  // 改訂済みの旧合成は、新しい合成提案に置き換えられている。後から旧が approve になっても有効にしない
  if (e && e.revisedBy) failed.push(`g:${e.revisedBy} に改訂済み`)
  return { active: failed.length === 0, failed }
}

// ---- 合成が握っている提案（元提案・選ばなかった提案）の導出 ----

export type ComposeHoldRole = 'source' | 'excluded'

export interface ComposeHold {
  compositeId: string
  skillName: string
  role: ComposeHoldRole
}

/**
 * 合成台帳と提案の状態から、「いま合成提案が握っている提案」を毎回導く（書込み無し）。
 * 握られた提案は、合成提案が昇格を完了するまで個別には昇格できない。
 *
 * 握る条件（`revisedBy` のあるエントリは新しい合成提案に置き換えられたので見ない）:
 * - `applied_pending_states`: 反映は成功したが状態更新が未完了＝昇格の完了ではない。握り続ける。
 *   このとき合成提案の状態が rejected でも解かない（golden は既に進んでいる。追い付き更新が adopted に直して applied にする）
 * - `registered`: 合成提案の状態が rejected でない間（未設定・adopted・その他）
 * 解く条件は、肯定的な証拠がある 2 つだけ: `applied`（昇格の完了）／合成提案が rejected（却下・破棄）。
 * 合成提案のファイルが無い・壊れている・registered のまま adopted（golden への反映が確認できない）といった異常は、
 * 解く証拠にならないので握り続ける（昇格させない側）。握りを解く操作は「却下」か「合成を破棄」。
 * 壊れた台帳の行（entry が null・sources が配列でない）は飛ばすが、例外にはしない。
 * 戻りの鍵は (skill, request_id)（holdKey／lookupHold）。
 */
/** 握りの鍵は (skill, request_id)。壊れた台帳で別 skill に同じ request_id が現れても、互いの握りを隠さない */
export const holdKey = (skillName: string, requestId: string): string => `${skillName}\u0000${requestId}`

/** 導出した握りから、その skill の提案 1 件の握りを引く */
export function lookupHold(
  holds: ReadonlyMap<string, ComposeHold>,
  skillName: string,
  requestId: string | undefined
): ComposeHold | undefined {
  return requestId ? holds.get(holdKey(skillName, requestId)) : undefined
}

/**
 * request_id だけで握りを引く（skill を問わない・fail-closed）。承認の主処理は、画面から渡る候補の skillName を信用せず
 * これを使う。同じ request_id が別 skill にもあれば、どれか 1 つの握りで止める（握る側に倒す）
 */
export function lookupHoldAnySkill(
  holds: ReadonlyMap<string, ComposeHold>,
  requestId: string | undefined
): ComposeHold | undefined {
  if (!requestId) return undefined
  for (const h of holds.values()) {
    if (holds.get(holdKey(h.skillName, requestId)) === h) return h
  }
  return undefined
}

export function deriveComposeHolds(
  entries: Record<string, MergeEntry>,
  states: Record<string, string | undefined>
): Map<string, ComposeHold> {
  const out = new Map<string, ComposeHold>()
  const live = Object.values(entries ?? {}).filter(
    (e) =>
      !!e &&
      typeof e.compositeId === 'string' &&
      !e.revisedBy &&
      (e.status === 'applied_pending_states' ||
        (e.status === 'registered' && states[e.compositeId] !== 'rejected'))
  )
  // 元提案として握られているものを、全エントリを通して優先する（同じ ID が別エントリの excluded と source に現れる壊れた台帳でも、
  // 登録順に依らず元提案側を取る）。2 段に分けて導く
  for (const role of ['source', 'excluded'] as const) {
    for (const e of live) {
      const ids = role === 'source' ? (Array.isArray(e.sources) ? e.sources.map((s) => s?.requestId) : []) : Array.isArray(e.excluded) ? e.excluded : []
      for (const id of ids) {
        if (typeof id !== 'string' || !id) continue
        const key = holdKey(e.skillName, id)
        if (out.has(key)) continue
        out.set(key, { compositeId: e.compositeId, skillName: e.skillName, role })
      }
    }
  }
  return out
}

// ---- 昇格の前の再照合 ----

export interface SnapshotFile {
  lang: 'ja' | 'en'
  /** skill フォルダからの相対パス */
  relPath: string
  sha256: string
}

export interface SnapshotDoc {
  skillName: string
  files: SnapshotFile[]
}

/** snapshot.json の本文（決定的に文字列化する。sha256 を compose_snapshot とする） */
export function serializeSnapshot(doc: SnapshotDoc): string {
  const files = [...doc.files].sort((x, y) =>
    `${x.lang}:${x.relPath}`.localeCompare(`${y.lang}:${y.relPath}`)
  )
  return JSON.stringify({ skillName: doc.skillName, files }, null, 2) + '\n'
}

export function registrySnapshotPath(paths: ComposePaths, compositeId: string): string {
  return join(paths.registryDir, compositeId.replace(/[^A-Za-z0-9._-]/g, '_'), 'snapshot.json')
}

export interface PreflightInput {
  paths: ComposePaths
  compositeId: string
  /** 昇格の直前に読み直した合成提案 MD の sha256 */
  proposalSha256: string
  /** 合成提案 frontmatter の compose_snapshot */
  composeSnapshot: string | undefined
  /** golden の現行ファイル（無ければ null）。ja/en を引く */
  readGolden: (lang: 'ja' | 'en', skillName: string, relPath: string) => Buffer | null
  /** 元提案の現在の状態（rejected は不可） */
  readState: (requestId: string) => string | undefined
}

/**
 * 昇格の適用前（契約ツールを起動する前）の再照合。登録後に不変の写し（compose-registry）だけを読み、
 * 作業場の snapshot.json は見ない。1 つでも違えば適用を始めない。
 */
export function composePreflight(i: PreflightInput): { ok: true } | { ok: false; error: string } {
  const entry = readMergeLedger(i.paths.mergesPath).entries[i.compositeId]
  if (!entry)
    return {
      ok: false,
      error: `合成台帳に「${i.compositeId}」が無い（CCPIT の登録を通っていない合成提案は昇格できない）`
    }
  if (entry.status !== 'registered')
    return { ok: false, error: `合成提案の状態が registered でない (${entry.status})` }
  if (entry.revisedBy)
    return {
      ok: false,
      error: `この合成提案は ${entry.revisedBy} に改訂済みのため昇格できない（新しい方を昇格する）`
    }
  if (entry.proposalSha256 !== i.proposalSha256) {
    return {
      ok: false,
      error: '合成提案 MD が登録後に変わっている（台帳の sha256 と違う）。登録からやり直す'
    }
  }
  if (!entry.containmentOk)
    return { ok: false, error: '元提案の変更が合成提案に含まれる検査を通っていない' }
  for (const s of entry.sources) {
    if (!existsSync(s.filePath))
      return { ok: false, error: `元提案 ${s.requestId} の MD が見つからない` }
    const cur = sha256Hex(readFileSync(s.filePath, 'utf-8').replace(/\r\n/g, '\n'))
    if (cur !== s.sha256)
      return { ok: false, error: `元提案 ${s.requestId} が登録後に変わっている。合成からやり直す` }
    if (i.readState(s.requestId) === 'rejected')
      return { ok: false, error: `元提案 ${s.requestId} は却下されている。合成からやり直す` }
  }
  const snapPath = registrySnapshotPath(i.paths, i.compositeId)
  if (!existsSync(snapPath))
    return { ok: false, error: '登録済みのスナップショット（compose-registry）が無い' }
  const snapText = readFileSync(snapPath, 'utf-8')
  const snapSha = sha256Hex(snapText)
  if (
    snapSha !== (i.composeSnapshot || '').trim().toLowerCase() ||
    snapSha !== entry.snapshotSha256
  ) {
    return {
      ok: false,
      error: '登録済みスナップショットの sha256 が compose_snapshot と違う（写しが書き換えられた）'
    }
  }
  let doc: SnapshotDoc
  try {
    doc = JSON.parse(snapText) as SnapshotDoc
  } catch {
    return { ok: false, error: '登録済みスナップショットが読めない' }
  }
  for (const f of doc.files) {
    const buf = i.readGolden(f.lang, doc.skillName, f.relPath)
    const cur = buf === null ? 'ABSENT' : contentHash(f.relPath, buf)
    if (cur !== f.sha256) {
      return {
        ok: false,
        error: `golden が合成の後に動いた: ${f.lang === 'en' ? 'en:' : ''}${f.relPath}（合成提案が触れないファイルを含む。合成をやり直す）`
      }
    }
  }
  return { ok: true }
}

// ---- 昇格の後（状態の更新と追い付き） ----

export interface PostPromotionDeps {
  paths: ComposePaths
  setState: (requestId: string, state: 'adopted') => Promise<void>
  now?: () => string
  lockDeps?: FileLockDeps
}

/**
 * 昇格に成功した合成提案の後処理: 適用記録を台帳へ書く（applied_pending_states）→ 元提案・合成提案を adopted → applied。
 * 各手は冪等。途中で例外が起きても、台帳に適用記録が残るので `composeCatchUp` が golden の実測で検証して続きを行う。
 */
export async function composePostPromotion(
  d: PostPromotionDeps,
  i: { compositeId: string; commit: string; files: SnapshotFile[] }
): Promise<{ ok: boolean; error?: string }> {
  const nowIso = (d.now ?? ((): string => new Date().toISOString()))()
  const cur = readMergeLedger(d.paths.mergesPath).entries[i.compositeId]
  if (!cur) return { ok: false, error: `合成台帳に「${i.compositeId}」が無い` }
  return withSkillLock(
    d.paths,
    cur.skillName,
    async () => {
      const requestIds = [i.compositeId, ...cur.sources.map((s) => s.requestId)]
      await updateMergeLedger(
        d.paths.mergesPath,
        (l) => {
          const e = l.entries[i.compositeId]
          if (!e) return
          e.status = 'applied_pending_states'
          e.application = {
            commit: i.commit,
            files: i.files.map((f) => ({ lang: f.lang, relPath: f.relPath, sha256: f.sha256 })),
            requestIds,
            generation: l.generation + 1,
            appliedAt: nowIso
          }
        },
        d.lockDeps
      )
      try {
        for (const id of requestIds) await d.setState(id, 'adopted')
      } catch (err) {
        return {
          ok: false,
          error: `状態の更新が途中で止まった（台帳に適用記録を残した。次の追い付き更新で続きを行う）: ${err instanceof Error ? err.message : String(err)}`
        }
      }
      await updateMergeLedger(
        d.paths.mergesPath,
        (l) => {
          const e = l.entries[i.compositeId]
          if (e) e.status = 'applied'
        },
        d.lockDeps
      )
      return { ok: true }
    },
    d.lockDeps
  )
}

export interface CatchUpDeps extends PostPromotionDeps {
  /** golden の実測: 記録されたコミットが golden の履歴に在り、対象ファイルの sha256 が期待値と一致するか */
  verifyApplied: (app: MergeApplication, skillName: string) => Promise<boolean>
}

export interface CatchUpResult {
  completed: string[]
  /** 検証が通らず adopted にしなかったもの（理由つき） */
  held: Array<{ compositeId: string; reason: string }>
}

/** 台帳が applied_pending_states のものを、golden の実測で検証してから追い付き更新する（冪等） */
export async function composeCatchUp(d: CatchUpDeps): Promise<CatchUpResult> {
  const out: CatchUpResult = { completed: [], held: [] }
  const ledger = readMergeLedger(d.paths.mergesPath)
  for (const e of Object.values(ledger.entries)) {
    if (e.status !== 'applied_pending_states' || !e.application) continue
    let ok = false
    try {
      ok = await d.verifyApplied(e.application, e.skillName)
    } catch {
      ok = false
    }
    if (!ok) {
      out.held.push({
        compositeId: e.compositeId,
        reason: 'golden の実測（コミット・対象ファイルの sha256）が揃わないため adopted にしない'
      })
      continue
    }
    await withSkillLock(
      d.paths,
      e.skillName,
      async () => {
        for (const id of e.application!.requestIds) await d.setState(id, 'adopted')
        await updateMergeLedger(
          d.paths.mergesPath,
          (l) => {
            const x = l.entries[e.compositeId]
            if (x) x.status = 'applied'
          },
          d.lockDeps
        )
      },
      d.lockDeps
    )
    out.completed.push(e.compositeId)
  }
  return out
}
