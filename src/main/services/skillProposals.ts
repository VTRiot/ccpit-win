/**
 * skillProposals — Skill 化候補（提案 MD）の一覧・パース・状態管理（Part B Phase 1 / 構想3 = 候補ブラウザ）。
 *
 * 役割:
 * - skill-proposal-emitter が `_SkillProposals/<ts>_<id>.md` に出した提案 MD を読み、
 *   候補ブラウザ用にパース（サマリ/評価軸/採用ラベル/レビューボックス）。
 * - 提案の状態（候補/採用済/却下/保留）を CCPIT 側ストア `~/.ccpit/proposal-states.json` で管理
 *   （提案 MD 自体は書き換えない）。
 * - レビュアー（codex 等の第二レビュアー）の findings を CCPIT 側ストア `~/.ccpit/proposal-reviews.json` で管理
 *   （同じく提案 MD を書き換えず、list 時に requestId で MD §5（pending）へマージ上書きして表示）。
 * - 既出/採用済み可視化: 採用レジストリ（skillProvenance）と突合し、target skill が既に採用済みか
 *   （= 重複防止の本筋、CCPIT 側）を判定。
 *
 * 採用 apply 自体は既存 settings:applyChange（kind:skill）経路を再利用する（本モジュールは apply しない）。
 * パーサは ja/en 両 emitter 出力に対応（section 番号 + 言語非依存のフィールドキーで抽出）。
 * 本モジュールは Electron Main プロセスのサービス（AI 体制非依存）。
 */

import { readFile, writeFile, mkdir, readdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join, basename, dirname } from 'path'
import { homedir } from 'os'
import { readAdoptedRegistry, getDefaultProvenancePaths, type ProvenancePaths } from './skillProvenance'

export type ProposalState = 'candidate' | 'adopted' | 'rejected' | 'held'
const VALID_PROPOSAL_STATES: ProposalState[] = ['candidate', 'adopted', 'rejected', 'held']

export interface ProposalAxisScore {
  /** 軸名（emitter の言語に依存。例: 再現性 / Reproducibility） */
  axis: string
  /** 0-5 スコア。数値化できなければ null */
  score: number | null
  /** 根拠 */
  rationale: string
}

export interface ProposalReviewBox {
  verdict: string
  findings: string
  reviewerId: string
  ccRebuttal: string
}

/** パース済み提案（状態・可視化フラグ込み）。 */
export interface ProposalSummary {
  filePath: string
  requestId: string
  /** ~/.claude/skills/<name>/SKILL.md（提案 frontmatter の target） */
  target: string
  /** target から導出した skill 名 */
  skillName: string
  /** 生成時の出自プロジェクト（cwd 絶対パス）。欠落時は ''（後方互換フェイルセーフ） */
  sourceProject: string
  adoptionLabel: string // 'recommend' | 'reject' | その他
  title: string
  what: string
  why: string
  how: string
  axes: ProposalAxisScore[]
  reviewBox: ProposalReviewBox
  /** パース不能・必須欠落時のエラー（一覧では警告表示。null=正常） */
  parseError: string | null
  // --- 状態・可視化（list 時に付与） ---
  state: ProposalState
  /** target skill 名が採用レジストリに存在（既に採用済み） */
  alreadyAdopted: boolean
}

export interface ProposalStorePaths {
  /** ~/.ccpit/proposal-states.json */
  statesPath: string
  /** ~/.ccpit/proposal-reviews.json（レビュアー（codex 等）の findings を保持。提案 MD は書き換えない） */
  reviewsPath: string
}

export function getDefaultProposalStorePaths(): ProposalStorePaths {
  return {
    statesPath: join(homedir(), '.ccpit', 'proposal-states.json'),
    reviewsPath: join(homedir(), '.ccpit', 'proposal-reviews.json')
  }
}

/**
 * 提案プールの既定フォルダ（集約先）。`~/.ccpit/proposals/`。
 * emitter の出力先と一致させ、候補ブラウザの起動時デフォルトに使う（横断採用のため cwd 非依存）。
 */
export function getDefaultProposalsFolder(): string {
  return join(homedir(), '.ccpit', 'proposals')
}

// --- frontmatter / section helpers（flat key:value、言語非依存） ---

/** flat な key:value frontmatter をパースする（proposalCodexGate の adoption_label 抽出でも再利用）。 */
export function parseFlatFrontmatter(
  md: string
): { data: Record<string, string>; body: string } | null {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!m) return null
  const data: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/)
    if (!kv) continue
    let v = kv[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    data[kv[1]] = v
  }
  return { data, body: m[2] }
}

/** "## N." 見出し以降、次の "## M." 見出し（または末尾）までの本文を返す。無ければ null。 */
function sliceSection(body: string, n: number): string | null {
  const re = new RegExp(`(?:^|\\n)##\\s*${n}\\.[^\\n]*\\r?\\n([\\s\\S]*?)(?=\\n##\\s*\\d+\\.|$)`)
  const m = re.exec(body)
  return m ? m[1] : null
}

/** "- key: value" 形式のリスト項目を {key→value} で返す（key は trim、大小区別なし参照用に lower も）。 */
function parseListKv(section: string): { raw: { key: string; value: string }[] } {
  const raw: { key: string; value: string }[] = []
  for (const line of section.split(/\r?\n/)) {
    const m = line.match(/^\s*[-*]\s*([^:：]+)[:：]\s*(.*)$/)
    if (m) raw.push({ key: m[1].trim(), value: m[2].trim() })
  }
  return { raw }
}

function findValue(
  items: { key: string; value: string }[],
  ...keys: string[]
): string {
  const lowered = keys.map((k) => k.toLowerCase())
  for (const it of items) {
    if (lowered.includes(it.key.toLowerCase())) return it.value
  }
  return ''
}

/** "4 — 根拠" / "4 - 根拠" / "4" から {score, rationale} を分離。 */
function parseAxisValue(value: string): { score: number | null; rationale: string } {
  const m = value.match(/^\s*(\d+)\s*(?:[—\-–]\s*)?(.*)$/)
  if (!m) return { score: null, rationale: value.trim() }
  return { score: Number(m[1]), rationale: m[2].trim() }
}

// 評価軸スコアの許容範囲（emitter SKILL.md §2「各軸 0〜5」由来。マジックナンバー禁止のため定数化）。
const AXIS_SCORE_MIN = 0
const AXIS_SCORE_MAX = 5

/**
 * 根拠が定型句（emitter テンプレの `<FILL: 根拠>` / `<FILL: 0-5>` 等の未記入プレースホルダ）か。
 * `FILL` トークン、または `<...>` 形の山括弧プレースホルダを定型句とみなす。
 */
function isPlaceholder(rationale: string): boolean {
  const v = rationale.trim()
  return /FILL/i.test(v) || /^<.*>$/.test(v)
}

/**
 * A2 評価軸ゲート（FSA §5-a）: 空欄（score===null）・範囲外・定型句の評価軸を弾く。
 * emitter SKILL.md:58「空欄・定型句は CCPIT の品質ゲートで弾かれる」契約の CCPIT 側実装。
 * 弾く提案は捨てず parseError として返し、候補ブラウザで理由表示する（呼び出し側）。
 * 戻り値: 問題なければ null、問題があれば理由文字列。
 */
function validateAxes(axes: ProposalAxisScore[]): string | null {
  if (axes.length === 0) return '評価軸が空です（## 2. 評価軸 が未記入）'
  for (const a of axes) {
    if (a.score === null) return `評価軸 '${a.axis}' のスコアが空欄または非数値です`
    if (a.score < AXIS_SCORE_MIN || a.score > AXIS_SCORE_MAX)
      return `評価軸 '${a.axis}' のスコアが範囲外（${AXIS_SCORE_MIN}-${AXIS_SCORE_MAX}）です`
    if (a.rationale.trim() === '' || isPlaceholder(a.rationale))
      return `評価軸 '${a.axis}' の根拠が空欄または定型句(FILL)です`
  }
  return null
}

/** 提案 MD 1 本をパース（状態・フラグは含まない）。 */
export async function parseProposalMd(
  filePath: string
): Promise<Omit<ProposalSummary, 'state' | 'alreadyAdopted'>> {
  const raw = await readFile(filePath, 'utf-8')
  const fm = parseFlatFrontmatter(raw)
  const base = {
    filePath,
    requestId: '',
    target: '',
    skillName: '',
    sourceProject: '',
    adoptionLabel: '',
    title: '',
    what: '',
    why: '',
    how: '',
    axes: [] as ProposalAxisScore[],
    reviewBox: { verdict: '', findings: '', reviewerId: '', ccRebuttal: '' },
    parseError: null as string | null
  }
  if (!fm) {
    return { ...base, parseError: 'frontmatter not found' }
  }
  const target = fm.data.target ?? ''
  const skillName = target ? basename(dirname(target.replace(/\\/g, '/'))) : ''
  // Summary (## 1.)
  const sec1 = sliceSection(fm.body, 1)
  let title = '',
    what = '',
    why = '',
    how = ''
  if (sec1) {
    const { raw: items } = parseListKv(sec1)
    title = findValue(items, 'タイトル', 'Title')
    what = findValue(items, 'What')
    why = findValue(items, 'Why')
    how = findValue(items, 'How')
  }
  if (!title) title = fm.data.purpose ?? skillName ?? '(untitled)'
  // Axes (## 2.)
  const sec2 = sliceSection(fm.body, 2)
  const axes: ProposalAxisScore[] = []
  if (sec2) {
    for (const it of parseListKv(sec2).raw) {
      const { score, rationale } = parseAxisValue(it.value)
      axes.push({ axis: it.key, score, rationale })
    }
  }
  // Review box (## 5.) — キーは ja/en 共通の英語
  const sec5 = sliceSection(fm.body, 5)
  const reviewBox = { verdict: '', findings: '', reviewerId: '', ccRebuttal: '' }
  if (sec5) {
    const items = parseListKv(sec5).raw
    reviewBox.verdict = findValue(items, 'review_verdict')
    reviewBox.findings = findValue(items, 'findings')
    reviewBox.reviewerId = findValue(items, 'reviewer_id')
    reviewBox.ccRebuttal = findValue(items, 'cc_rebuttal')
  }
  // A2 評価軸ゲート（FSA §5-a）。ただし adoption_label: reject（該当なし＝採用候補が無い）は
  // 評価対象が存在しないため軸検査をスキップする（偽スコアを emitter に書かせない＝真実選好）。
  const isNoCandidate = fm.data.adoption_label === 'reject'
  const parseError =
    fm.data.kind !== 'skill'
      ? `kind is '${fm.data.kind ?? '(none)'}', expected 'skill'`
      : !target
        ? 'target missing'
        : isNoCandidate
          ? null
          : validateAxes(axes)
  return {
    ...base,
    requestId: fm.data.request_id ?? '',
    target,
    skillName,
    sourceProject: fm.data.source_project ?? '',
    adoptionLabel: fm.data.adoption_label ?? '',
    title,
    what,
    why,
    how,
    axes,
    reviewBox,
    parseError
  }
}

// --- 状態ストア（proposal-states.json） ---

type StateMap = Record<string, ProposalState>

export async function readProposalStates(
  paths: ProposalStorePaths = getDefaultProposalStorePaths()
): Promise<StateMap> {
  if (!existsSync(paths.statesPath)) return {}
  try {
    const raw = await readFile(paths.statesPath, 'utf-8')
    if (raw.trim() === '') return {}
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: StateMap = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string' && (VALID_PROPOSAL_STATES as string[]).includes(v)) {
        out[k] = v as ProposalState
      }
    }
    return out
  } catch {
    return {} // フェイルセーフ: 破損時は全て候補扱い
  }
}

export async function setProposalState(
  requestId: string,
  state: ProposalState,
  paths: ProposalStorePaths = getDefaultProposalStorePaths()
): Promise<void> {
  if (!VALID_PROPOSAL_STATES.includes(state)) {
    throw new Error(`invalid proposal state: ${state}`)
  }
  const map = await readProposalStates(paths)
  map[requestId] = state
  await mkdir(dirname(paths.statesPath), { recursive: true })
  await writeFile(paths.statesPath, JSON.stringify(map, null, 2), 'utf-8')
}

// --- レビューストア（proposal-reviews.json） ---

/**
 * 保存されるレビュー 1 件。レビューボックス契約（C1）の 4 フィールド + 記録時刻。
 * reviewerId は抽象（codex / らいこ / LocalLLM 等を差し替え可能に汎用文字列で保持）。
 */
export type StoredProposalReview = ProposalReviewBox & {
  /** ISO 8601。レビュー記録時刻（実時刻、推定丸め禁止） */
  reviewedAt: string
}

type ReviewMap = Record<string, StoredProposalReview>

/** 1 エントリが妥当な review か（フェイルセーフ用の最小バリデーション）。 */
function coerceStoredReview(v: unknown): StoredProposalReview | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const s = (k: string): string => (typeof o[k] === 'string' ? (o[k] as string) : '')
  return {
    verdict: s('verdict'),
    findings: s('findings'),
    reviewerId: s('reviewerId'),
    ccRebuttal: s('ccRebuttal'),
    reviewedAt: s('reviewedAt')
  }
}

export async function readProposalReviews(
  paths: ProposalStorePaths = getDefaultProposalStorePaths()
): Promise<ReviewMap> {
  if (!existsSync(paths.reviewsPath)) return {}
  try {
    const raw = await readFile(paths.reviewsPath, 'utf-8')
    if (raw.trim() === '') return {}
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: ReviewMap = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const r = coerceStoredReview(v)
      if (r) out[k] = r
    }
    return out
  } catch {
    return {} // フェイルセーフ: 破損時はレビュー無し（= MD §5 pending に縮退）
  }
}

export async function setProposalReview(
  requestId: string,
  review: StoredProposalReview,
  paths: ProposalStorePaths = getDefaultProposalStorePaths()
): Promise<void> {
  if (!requestId) throw new Error('setProposalReview: requestId is required')
  const map = await readProposalReviews(paths)
  map[requestId] = review
  await mkdir(dirname(paths.reviewsPath), { recursive: true })
  await writeFile(paths.reviewsPath, JSON.stringify(map, null, 2), 'utf-8')
}

// --- 一覧（状態・可視化フラグ込み） ---

export interface ListProposalsOptions {
  storePaths?: ProposalStorePaths
  provenancePaths?: ProvenancePaths
}

/** 指定フォルダの提案 MD を全件パースし、状態と「既に採用済み」フラグを付与して返す。 */
export async function listProposals(
  folder: string,
  opts: ListProposalsOptions = {}
): Promise<ProposalSummary[]> {
  if (!existsSync(folder)) return []
  const entries = await readdir(folder, { withFileTypes: true })
  const mdFiles = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
    .map((e) => join(folder, e.name))

  const resolvedStorePaths = opts.storePaths ?? getDefaultProposalStorePaths()
  const states = await readProposalStates(resolvedStorePaths)
  const reviews = await readProposalReviews(resolvedStorePaths)
  let adoptedNames = new Set<string>()
  try {
    const reg = await readAdoptedRegistry(opts.provenancePaths ?? getDefaultProvenancePaths())
    adoptedNames = new Set(reg.map((e) => e.name))
  } catch {
    adoptedNames = new Set() // レジストリ破損時は可視化フラグなしで続行
  }

  const out: ProposalSummary[] = []
  for (const fp of mdFiles) {
    try {
      const parsed = await parseProposalMd(fp)
      // レビューストアに当該 requestId の review があれば、MD §5（pending）を store 値で上書き（store が正）。
      const stored = parsed.requestId ? reviews[parsed.requestId] : undefined
      out.push({
        ...parsed,
        reviewBox: stored
          ? {
              verdict: stored.verdict,
              findings: stored.findings,
              reviewerId: stored.reviewerId,
              ccRebuttal: stored.ccRebuttal
            }
          : parsed.reviewBox,
        state: states[parsed.requestId] ?? 'candidate',
        alreadyAdopted: parsed.skillName ? adoptedNames.has(parsed.skillName) : false
      })
    } catch (err) {
      // 1 本の読込失敗で一覧全体を落とさない
      out.push({
        filePath: fp,
        requestId: '',
        target: '',
        skillName: '',
        sourceProject: '',
        adoptionLabel: '',
        title: basename(fp),
        what: '',
        why: '',
        how: '',
        axes: [],
        reviewBox: { verdict: '', findings: '', reviewerId: '', ccRebuttal: '' },
        parseError: err instanceof Error ? err.message : String(err),
        state: 'candidate',
        alreadyAdopted: false
      })
    }
  }
  // 採用推奨を上に、次に候補→保留→却下→採用済の順で見やすく
  const stateRank: Record<ProposalState, number> = {
    candidate: 0,
    held: 1,
    rejected: 2,
    adopted: 3
  }
  out.sort((a, b) => {
    if (a.state !== b.state) return stateRank[a.state] - stateRank[b.state]
    if (a.adoptionLabel !== b.adoptionLabel) {
      return a.adoptionLabel === 'recommend' ? -1 : b.adoptionLabel === 'recommend' ? 1 : 0
    }
    return a.filePath.localeCompare(b.filePath)
  })
  return out
}
