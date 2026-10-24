/**
 * composeFakeDriver — 隔離した開発版で、合成の画面を各状態まで流すための「台本どおりに動く偽」（CCPIT_L0_011 §7）。
 *
 * 偽にするのは 3 つだけ: 最初の合成の Claude Code（launchCc の代わり）・窓を出さない改訂 AI・独立レビュアー。
 * どれも本物の Codex も Claude も呼ばない。作業場へ合成提案と `out/READY.json` を書くだけで、検査・登録・台帳・画面は本物が動く。
 * 最初の合成は、本物と同じ依頼ファイルから固有の値を読み、着手の合図 `out/STARTED.json` も書く（L0_012。台本で外せる）。
 *
 * ## 隔離起動のときだけ効く
 * `isolated`（既定は isIsolatedLaunch()）が true、かつ環境変数 COMPOSE_FAKE_SCENARIO_ENV が台本 JSON のパスのときだけ
 * ドライバを返す。隔離でなければ環境変数があっても null（本番で偽が効く経路を作らない）。台本が読めない・形が違うときも null。
 *
 * ## 巡の決め方（runReviewer・launchHeadless）
 * 台本の `rounds[].round` は「その巡の合成提案」に対する値（delayMs・section1・editEn は改訂の巡 n の生成、
 * reviewerText は巡 n の合成提案へのレビュー）。巡 n は次の順で決める:
 *  1. launchHeadless: 作業場 meta.json の数値の `round`（巡の実行側が書く）
 *  2. 依頼文の「第 n 巡」「round n」の記述
 *  3. 呼ばれた回数（runReviewer は 1 回目＝巡 1。launchHeadless は 1 回目＝巡 2。最初の合成が巡 1 のため）
 * 台本に該当の巡が無いときは最後の項目を使う。項目が 1 つも無いレビューは approve・指摘なしを返す。
 *
 * ## 合成提案の作り方
 * 既存の試験 `composeLaunch.test.ts` の fakeCc と同じ形: 作業場の `sources/<id>.md` の §3 の全文を読み、
 * `golden/` の写しを土台に、frontmatter（request_id・supersedes・target ほか）と §3 を持つ提案 MD を `out/<合成の ID>.md` に書く。
 * 元提案が 1 本ならその §3 をそのまま運ぶ。2 本以上は行単位の和（片方にしか無い行を足す）で、衝突を解く合成ではない
 * （適応が要る台本は `compositeFiles` で全文を直接指定する）。改訂の巡は、`previous/` の旧合成提案を土台にする。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  COMPOSE_FAKE_SCENARIO_ENV,
  COMPOSE_LAUNCH_NONCE_HEX_LEN,
  COMPOSE_STARTED_FILE,
  type Section1Row
} from '../../shared/composeContract'
import { isIsolatedLaunch } from '../isolation'
import { DIALOGUE_FILE_ENV } from './proposalDialogueLaunch'
import type { BackstageCcResult } from './backstageCc'
import type { LaunchArgs, LaunchResult, launchCc } from './ccLaunch'
import { sha256Hex } from './composeHash'
import type {
  StartComposeRevisionHeadlessArgs,
  StartComposeRevisionHeadlessResult
} from './composeHeadlessLaunch'
import { splitFrontmatter } from './composeRegister'
import { buildSection1DecisionTable } from './goldenMergeConsult'
import { parseProposedFilesFromSection3 } from './skillProposals'

// ---- 台本 ----

export interface ComposeFakeRound {
  /** 巡の番号（1 始まり） */
  round: number
  /** 改訂の巡 n の生成にかかる時間（ミリ秒）。巡 1 では使わない（firstCompose.delayMs） */
  delayMs: number
  /** 巡 n の合成提案へのレビューが返す本文（VERDICT・FINDINGS を含む、本物のレビュアーと同じ形の文字列） */
  reviewerText: string
  /** 改訂の巡 n の §1「前回の指摘の採否」の表 */
  section1?: Section1Row[]
  /** 改訂の巡 n で en の SKILL.md を置き換える全文（無ければ土台のまま） */
  editEn?: string
  /** 巡 n のレビューが返るまでの待ち（ミリ秒。画面で「レビュー中」を見るため。省略は待たない） */
  reviewDelayMs?: number
}

export interface ComposeFakeFirstCompose {
  delayMs: number
  /** out/acks.json に書く適応の鍵。'all' は作業場の adaptation-keys.json の全鍵。省略は書かない */
  acks?: string[] | 'all'
  /** 提案 frontmatter の adapted_hunks（省略は空） */
  adaptedHunks?: string
  /**
   * L0_012: 着手の合図。match（既定）＝依頼文の値をそのまま写す（本物の合成 CC と同じ）／mismatch＝違う値を書く／
   * none＝書かない。試験で「合図が無い」「違う値」の経路を作るため
   */
  startSignal?: 'match' | 'mismatch' | 'none'
  /**
   * 着手の合図を書くまでの待ち（ミリ秒。省略は 0）。本物は READY より前に書くので、delayMs 以下にする
   * （大きくすると READY の後になり、段が running を過ぎているので画面には出ない）
   */
  startSignalDelayMs?: number
  /** 合成開始の IPC の復帰を遅らせる（ミリ秒。画面で「準備中」を見るため。ipc.ts が偽ドライバのときだけ使う） */
  startIpcDelayMs?: number
}

export interface ComposeFakeScenario {
  rounds: ComposeFakeRound[]
  firstCompose: ComposeFakeFirstCompose
  /** 合成提案の §3 の全文を直接指定する（キーは ja の相対パス、または `en:<相対パス>`）。指定すると元提案からは作らない */
  compositeFiles?: Record<string, string>
  /** true ならレビューの巡を呼ばれた回数で決める（依頼文の記述を見ない） */
  reviewByCallOrder?: boolean
}

export interface ComposeFakeDriver {
  scenario: ComposeFakeScenario
  /** 最初の合成の launchCc の代わり。spawned:true を返し、delayMs 後に作業場へ合成提案と READY を書く */
  launch: typeof launchCc
  /** startComposeRevisionHeadless の代わり。同じく作業場に書く */
  launchHeadless: (args: StartComposeRevisionHeadlessArgs) => StartComposeRevisionHeadlessResult
  /** 独立レビュアーの代わり。巡ごとの台本の本文を返す */
  runReviewer: (prompt: string) => Promise<{ ok: true; text: string }>
  /** 予約された書込み（delayMs 後の合成提案と READY）がすべて終わるまで待つ。試験用 */
  settled: () => Promise<void>
  /** 呼ばれた回数と、書込みの失敗。signalSkipped＝依頼ファイルが渡されず、着手の合図を書けなかった回数 */
  stats: { launch: number; headless: number; reviewer: number; errors: string[]; signalSkipped: number }
}

// ---- 読み込み ----

function isRow(x: unknown): x is Section1Row {
  if (typeof x !== 'object' || x === null) return false
  const r = x as Record<string, unknown>
  return (
    typeof r.prevNo === 'string' &&
    (r.origin === 'diff' || r.origin === 'base' || r.origin === 'unresolved') &&
    (r.decision === 'adopted' || r.decision === 'rejected' || r.decision === 'not-applied') &&
    typeof r.reason === 'string'
  )
}

function parseScenario(raw: unknown): ComposeFakeScenario | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const fc = o.firstCompose as Record<string, unknown> | undefined
  if (!fc || typeof fc.delayMs !== 'number' || fc.delayMs < 0) return null
  if (!Array.isArray(o.rounds)) return null
  const rounds: ComposeFakeRound[] = []
  for (const r of o.rounds) {
    if (typeof r !== 'object' || r === null) return null
    const x = r as Record<string, unknown>
    if (typeof x.round !== 'number' || !Number.isInteger(x.round) || x.round < 1) return null
    if (typeof x.delayMs !== 'number' || x.delayMs < 0) return null
    if (typeof x.reviewerText !== 'string') return null
    if (x.section1 !== undefined && !(Array.isArray(x.section1) && x.section1.every(isRow))) return null
    if (x.editEn !== undefined && typeof x.editEn !== 'string') return null
    if (x.reviewDelayMs !== undefined && (typeof x.reviewDelayMs !== 'number' || x.reviewDelayMs < 0)) return null
    rounds.push({
      round: x.round,
      delayMs: x.delayMs,
      reviewerText: x.reviewerText,
      ...(x.section1 ? { section1: x.section1 as Section1Row[] } : {}),
      ...(typeof x.editEn === 'string' ? { editEn: x.editEn } : {}),
      ...(typeof x.reviewDelayMs === 'number' ? { reviewDelayMs: x.reviewDelayMs } : {})
    })
  }
  const acks = fc.acks
  if (acks !== undefined && acks !== 'all' && !(Array.isArray(acks) && acks.every((a) => typeof a === 'string')))
    return null
  const sig = fc.startSignal
  if (sig !== undefined && sig !== 'match' && sig !== 'mismatch' && sig !== 'none') return null
  const nonNegative = (v: unknown): boolean => v === undefined || (typeof v === 'number' && v >= 0)
  if (!nonNegative(fc.startSignalDelayMs) || !nonNegative(fc.startIpcDelayMs)) return null
  const cf = o.compositeFiles
  if (cf !== undefined) {
    if (typeof cf !== 'object' || cf === null) return null
    if (!Object.values(cf).every((v) => typeof v === 'string')) return null
  }
  return {
    rounds,
    firstCompose: {
      delayMs: fc.delayMs,
      ...(acks !== undefined ? { acks: acks as string[] | 'all' } : {}),
      ...(typeof fc.adaptedHunks === 'string' ? { adaptedHunks: fc.adaptedHunks } : {}),
      ...(sig !== undefined ? { startSignal: sig as 'match' | 'mismatch' | 'none' } : {}),
      ...(typeof fc.startSignalDelayMs === 'number' ? { startSignalDelayMs: fc.startSignalDelayMs } : {}),
      ...(typeof fc.startIpcDelayMs === 'number' ? { startIpcDelayMs: fc.startIpcDelayMs } : {})
    },
    ...(cf ? { compositeFiles: cf as Record<string, string> } : {}),
    ...(o.reviewByCallOrder === true ? { reviewByCallOrder: true } : {})
  }
}

/**
 * 隔離起動で、かつ環境変数が台本 JSON のパスを指すときだけドライバを返す。それ以外は null。
 * `isolated` の既定は isIsolatedLaunch()（呼んだ時点の値）。
 */
export function loadComposeFakeDriver(
  env: NodeJS.ProcessEnv = process.env,
  isolated: boolean = isIsolatedLaunch()
): ComposeFakeDriver | null {
  if (!isolated) return null
  const path = env[COMPOSE_FAKE_SCENARIO_ENV]
  if (!path) return null
  let scenario: ComposeFakeScenario | null = null
  try {
    scenario = parseScenario(JSON.parse(readFileSync(path, 'utf-8')))
  } catch {
    return null
  }
  return scenario ? createComposeFakeDriver(scenario) : null
}

// ---- 合成提案の組み立て ----

interface FileEntry {
  lang: 'ja' | 'en'
  relPath: string
  content: string
}

const fileKey = (f: { lang: 'ja' | 'en'; relPath: string }): string => `${f.lang}:${f.relPath}`

function withTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s : `${s}\n`
}

function readSection3(path: string): FileEntry[] {
  const raw = readFileSync(path, 'utf-8')
  const sp = splitFrontmatter(raw)
  if (!sp) return []
  const parsed = parseProposedFilesFromSection3(sp.body, path)
  return parsed.files.map((f) => ({
    lang: f.lang === 'en' ? 'en' : 'ja',
    relPath: f.relPath,
    content: f.content
  }))
}

/** 行単位の和: base の行に、add にあって base に無い行を末尾へ足す（衝突を解く合成ではない） */
function unionLines(base: string, add: string): string {
  const have = new Set(base.split('\n'))
  const extra = add.split('\n').filter((l) => l !== '' && !have.has(l))
  return extra.length === 0 ? base : `${withTrailingNewline(base)}${extra.join('\n')}\n`
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch {
    return null
  }
}

interface FakeMeta {
  skillName: string
  compositeRequestId: string
  sources: Array<{ requestId: string }>
  round?: number
}

function buildFiles(
  dir: string,
  meta: FakeMeta,
  scenario: ComposeFakeScenario,
  opts: { fromPrevious: boolean; editEn?: string }
): FileEntry[] {
  const map = new Map<string, FileEntry>()
  if (scenario.compositeFiles) {
    for (const [k, content] of Object.entries(scenario.compositeFiles)) {
      const en = k.startsWith('en:')
      map.set(`${en ? 'en' : 'ja'}:${en ? k.slice(3) : k}`, {
        lang: en ? 'en' : 'ja',
        relPath: en ? k.slice(3) : k,
        content: withTrailingNewline(content)
      })
    }
  } else {
    // 土台: 改訂なら旧合成提案、最初の合成なら元提案
    let basePaths: string[] = []
    const prevDir = join(dir, 'previous')
    if (opts.fromPrevious && existsSync(prevDir)) {
      basePaths = readdirSync(prevDir)
        .filter((n) => n.endsWith('.md') && n !== 'review-findings.md')
        .sort()
        .map((n) => join(prevDir, n))
    }
    if (basePaths.length === 0) {
      basePaths = meta.sources.map((s) =>
        join(dir, 'sources', `${s.requestId.replace(/[^A-Za-z0-9._-]/g, '_')}.md`)
      )
    }
    for (const p of basePaths) {
      for (const f of readSection3(p)) {
        const k = fileKey(f)
        const cur = map.get(k)
        map.set(k, cur ? { ...cur, content: unionLines(cur.content, f.content) } : { ...f })
      }
    }
    if (!map.has('ja:SKILL.md')) {
      const gold = join(dir, 'golden', 'ja', 'skills', meta.skillName, 'SKILL.md')
      if (existsSync(gold)) {
        map.set('ja:SKILL.md', { lang: 'ja', relPath: 'SKILL.md', content: readFileSync(gold, 'utf-8') })
      }
    }
  }
  if (opts.editEn !== undefined) {
    map.set('en:SKILL.md', { lang: 'en', relPath: 'SKILL.md', content: withTrailingNewline(opts.editEn) })
  }
  // ja の SKILL.md を先頭に、あとは相対パス順
  return [...map.values()].sort((a, b) => {
    const ra = a.lang === 'ja' && a.relPath === 'SKILL.md' ? 0 : 1
    const rb = b.lang === 'ja' && b.relPath === 'SKILL.md' ? 0 : 1
    return ra - rb || fileKey(a).localeCompare(fileKey(b))
  })
}

function renderComposite(
  meta: FakeMeta,
  snapshotSha: string,
  files: FileEntry[],
  extra: { section1?: Section1Row[]; adaptedHunks?: string }
): string {
  const supersedes = meta.sources.map((s) => s.requestId).join(';')
  const sec3 = files
    .map((f) => {
      const head = f.lang === 'en' ? `en:${f.relPath}` : f.relPath
      return `### ${head}\n\`\`\`markdown\n${f.content}\n\`\`\`\n`
    })
    .join('\n')
  return [
    '---',
    `request_id: ${meta.compositeRequestId}`,
    'kind: skill',
    'status: pending',
    'adoption_label: recommend',
    `title: ${meta.compositeRequestId}`,
    `target: ~/.claude/skills/${meta.skillName}/SKILL.md`,
    `supersedes: ${supersedes}`,
    `compose_snapshot: ${snapshotSha}`,
    `adapted_hunks: ${extra.adaptedHunks ?? ''}`,
    '---',
    '## 1. サマリ',
    '',
    `- タイトル: ${meta.compositeRequestId}（偽の合成 CC が台本から作成）`,
    ...(extra.section1 ? ['', buildSection1DecisionTable(extra.section1)] : []),
    '',
    '## 3. 変更後の完成版',
    '',
    sec3
  ].join('\n')
}

/** 作業場へ合成提案と READY を書く（READY は最後。本物の合成 CC と同じ順） */
function writeComposition(
  dir: string,
  scenario: ComposeFakeScenario,
  opts: {
    fromPrevious: boolean
    editEn?: string
    section1?: Section1Row[]
    acks?: string[] | 'all'
    adaptedHunks?: string
  }
): void {
  const meta = readJson<FakeMeta>(join(dir, 'meta.json'))
  if (!meta) throw new Error('作業場の meta.json が読めません')
  const snapshotText = readFileSync(join(dir, 'snapshot.json'), 'utf-8')
  const files = buildFiles(dir, meta, scenario, opts)
  const out = join(dir, 'out')
  mkdirSync(out, { recursive: true })
  const rel = `out/${meta.compositeRequestId}.md`
  writeFileSync(
    join(dir, rel),
    renderComposite(meta, sha256Hex(snapshotText), files, {
      section1: opts.section1,
      adaptedHunks: opts.adaptedHunks
    }),
    'utf-8'
  )
  if (opts.acks !== undefined) {
    const keys =
      opts.acks === 'all'
        ? (readJson<{ keys?: Array<{ key: string }> }>(join(dir, 'adaptation-keys.json'))?.keys ?? []).map(
            (k) => k.key
          )
        : opts.acks
    writeFileSync(join(out, 'acks.json'), JSON.stringify({ ackedAdaptations: keys }), 'utf-8')
  }
  writeFileSync(join(out, 'READY.json'), JSON.stringify({ compositeFile: rel }), 'utf-8')
}

// ---- 着手の合図（L0_012） ----

/** 依頼文の節「最初にすること」の `{"launchNonce": "<値>"}` から値を取り出す（本物の合成 CC が読むのと同じ文字列） */
export function readNonceFromRequest(requestFile: string): string | null {
  let text = ''
  try {
    text = readFileSync(requestFile, 'utf-8')
  } catch {
    return null
  }
  const re = new RegExp(`"launchNonce":\\s*"([0-9a-f]{${COMPOSE_LAUNCH_NONCE_HEX_LEN}})"`)
  const m = re.exec(text)
  return m ? m[1] : null
}

/** 同じ桁数で、必ず違う値（試験の mismatch 用。各桁を 16 進で 1 つずらす） */
function mismatchOf(nonce: string): string {
  return [...nonce].map((c) => ((parseInt(c, 16) + 1) % 16).toString(16)).join('')
}

/** 本物の合成 CC と同じ場所・同じ形で合図を書く */
function writeStartSignal(dir: string, launchNonce: string): void {
  const p = join(dir, COMPOSE_STARTED_FILE)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, JSON.stringify({ launchNonce }), 'utf-8')
}

// ---- 巡の決め方 ----

/** 依頼文の「第 n 巡」「round n」から巡を読む。無ければ null */
export function detectRoundFromText(text: string): number | null {
  const m = /第\s*(\d+)\s*巡|\bround\s*[:=]?\s*(\d+)/i.exec(text)
  if (!m) return null
  const n = Number(m[1] ?? m[2])
  return Number.isInteger(n) && n >= 1 ? n : null
}

function pickRound(rounds: ComposeFakeRound[], n: number): ComposeFakeRound | undefined {
  return rounds.find((r) => r.round === n) ?? rounds[rounds.length - 1]
}

/** 台本に項目が無いときのレビュー（approve・指摘なし） */
export const FAKE_DEFAULT_REVIEW_TEXT = 'VERDICT: approve\nFINDINGS: none'

// ---- ドライバ ----

export function createComposeFakeDriver(scenario: ComposeFakeScenario): ComposeFakeDriver {
  const stats: ComposeFakeDriver['stats'] = { launch: 0, headless: 0, reviewer: 0, errors: [], signalSkipped: 0 }
  const pending = new Set<Promise<void>>()

  const schedule = (delayMs: number, work: () => void): Promise<void> => {
    const p = new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          work()
        } catch (e) {
          stats.errors.push(e instanceof Error ? e.message : String(e))
        }
        resolve()
      }, delayMs)
      t.unref?.()
    })
    pending.add(p)
    void p.then(() => pending.delete(p))
    return p
  }

  const launch = ((args: LaunchArgs, env?: Record<string, string>): LaunchResult => {
    stats.launch += 1
    const dir = args.projectPath
    // 着手の合図: 本物の合成 CC と同じ依頼ファイル（起動の環境変数が指す）から値を読み、同じ場所に書く
    const fc = scenario.firstCompose
    const mode = fc.startSignal ?? 'match'
    if (mode !== 'none') {
      const requestFile = env?.[DIALOGUE_FILE_ENV]
      const nonce = requestFile ? readNonceFromRequest(requestFile) : null
      if (nonce === null) {
        stats.signalSkipped += 1
      } else {
        const value = mode === 'match' ? nonce : mismatchOf(nonce)
        void schedule(fc.startSignalDelayMs ?? 0, () => writeStartSignal(dir, value))
      }
    }
    void schedule(scenario.firstCompose.delayMs, () =>
      writeComposition(dir, scenario, {
        fromPrevious: false,
        acks: scenario.firstCompose.acks,
        adaptedHunks: scenario.firstCompose.adaptedHunks
      })
    )
    return { shell: 'fake', spawned: true }
  }) as typeof launchCc

  const launchHeadless = (args: StartComposeRevisionHeadlessArgs): StartComposeRevisionHeadlessResult => {
    stats.headless += 1
    const dir = args.workspaceDir
    const meta = readJson<FakeMeta>(join(dir, 'meta.json'))
    const round =
      (typeof meta?.round === 'number' ? meta.round : null) ??
      detectRoundFromText(args.promptText) ??
      stats.headless + 1
    const r = pickRound(scenario.rounds, round)
    const delayMs = r?.delayMs ?? 0
    const done = schedule(delayMs, () =>
      writeComposition(dir, scenario, {
        fromPrevious: true,
        editEn: r?.editEn,
        section1: r?.section1
      })
    ).then(
      (): BackstageCcResult => ({
        ok: stats.errors.length === 0,
        resultText: 'READY',
        ...(stats.errors.length > 0 ? { error: stats.errors[stats.errors.length - 1] } : {}),
        durationMs: delayMs,
        runId: 'fake-revision'
      })
    )
    return { started: true, done }
  }

  const runReviewer = async (prompt: string): Promise<{ ok: true; text: string }> => {
    stats.reviewer += 1
    // 依頼文は skill の本文を文脈として全文運ぶので、本文中の「round 1」「第 2 巡」を拾って取り違えうる。
    // 台本に reviewByCallOrder があれば呼ばれた回数（1 回目＝巡 1）を使う
    const round = scenario.reviewByCallOrder ? stats.reviewer : (detectRoundFromText(prompt) ?? stats.reviewer)
    const item = pickRound(scenario.rounds, round)
    if (item?.reviewDelayMs) await new Promise((r) => setTimeout(r, item.reviewDelayMs))
    return { ok: true, text: item?.reviewerText ?? FAKE_DEFAULT_REVIEW_TEXT }
  }

  return {
    scenario,
    launch,
    launchHeadless,
    runReviewer,
    settled: async () => {
      while (pending.size > 0) await Promise.all([...pending])
    },
    stats
  }
}
