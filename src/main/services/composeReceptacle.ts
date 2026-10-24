/**
 * composeReceptacle — 合成のレビューで「原文由来」と確定した指摘の受け皿（CCPIT_L0_011 W4）。
 *
 * 合成提案が触っていない golden の原文への指摘は、その提案の採否とは別の課題なので、提案プールの外
 * （`<ccpitDir>/base-findings/<skill>/`）の専用フォルダに 1 指摘 1 ファイルで残す。候補の走査（提案プール）には混ざらない。
 * 同じ skill・同じ正規化キー（`findingKey(where, title)`）で open のものがあれば、そこへ追記する。
 *
 * 守ること:
 * - 受け皿を消す関数は作らない。ファイルを動かすのは追記と closeReceptacle（status を closed にする）だけ
 * - 書込みは tmp→rename。skill 名はパスの部品なので検査する。closeReceptacle は baseDir の外のパスを拒否する
 * - 持ち主（owner）は空にしない（空なら RECEPTACLE_DEFAULT_OWNER）
 *
 * ロックは取らない: 呼び手は合成の finalize（1 件ずつ直列）だけで、upsertBaseFindings は同期の関数として契約されている。
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  RECEPTACLE_DEFAULT_OWNER,
  findingKey,
  type ClassifiedFinding,
  type ReceptacleClosedHow,
  type ReceptacleEntry,
  type ReceptacleFrontmatter,
  type ReceptacleSummary
} from '../../shared/composeContract'

/** skill 名（パスの部品）。先頭は英数字、64 字まで。`/` `\` `..` を含まない */
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/** 要旨のハッシュをファイル名に入れる桁数（8 桁＝同じ秒・同じ skill で別の要旨が当たる確率は無視できる。当たっても連番で避ける） */
const KEY_HASH_CHARS = 8
const CLOSED_HOWS: readonly ReceptacleClosedHow[] = ['fixed', 'accepted', 'merged']
/** 同じ秒・同じ要旨のファイル名が既にあるときの連番の上限（実際には closed 後に即再作成した場合しか当たらない） */
const FILENAME_SUFFIX_MAX = 100

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** ファイル名の時刻（ローカル時刻。ファイルを実際に作った時刻） */
function stamp(now: Date): string {
  return `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}_${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** frontmatter の値。素直に読めるものは素のまま、そうでなければ JSON の二重引用（YAML の二重引用と同じ綴り）で書く */
function yamlScalar(v: string): string {
  const s = oneLine(v)
  const plain =
    s !== '' &&
    !/^[\s"'#[\]{}&*!|>%@`,?:-]/.test(s) &&
    !s.includes(': ') &&
    !s.includes(' #') &&
    !s.endsWith(':') &&
    !/^(true|false|null|yes|no|on|off|~)$/i.test(s) &&
    !/^[0-9.+-]+$/.test(s)
  return plain ? s : JSON.stringify(s)
}

function parseScalar(raw: string): string {
  const t = raw.trim()
  if (t.startsWith('"')) {
    try {
      const v = JSON.parse(t) as unknown
      if (typeof v === 'string') return v
    } catch {
      /* 素のまま返す */
    }
  }
  return t
}

interface ParsedReceptacle {
  /** frontmatter の行（順序を保つ）。raw は書かれたままの値 */
  fm: Array<{ key: string; raw: string }>
  body: string
}

function parseReceptacleText(text: string): ParsedReceptacle | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(text)
  if (!m) return null
  const fm: Array<{ key: string; raw: string }> = []
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    fm.push({ key: line.slice(0, i).trim(), raw: line.slice(i + 1).trim() })
  }
  return { fm, body: m[2] ?? '' }
}

function fmGet(p: ParsedReceptacle, key: string): string | undefined {
  const e = p.fm.find((x) => x.key === key)
  return e === undefined ? undefined : parseScalar(e.raw)
}

function composeText(p: ParsedReceptacle): string {
  const head = p.fm.map((e) => `${e.key}: ${e.raw}`).join('\n')
  return `---\n${head}\n---\n${p.body}`
}

/** 原子的に書く（tmp→rename）。途中で止まっても元のファイルは壊れない */
function writeAtomic(filePath: string, text: string): void {
  const tmp = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  writeFileSync(tmp, text, 'utf-8')
  renameSync(tmp, filePath)
}

/** 根拠の 1 行: 「`[ja]SKILL.md L10-20`（変更行に掛からない）」を、引いた範囲ごとに並べる */
export function describeFindingBasis(f: ClassifiedFinding): string {
  if (f.citedRanges.length === 0) return '比べた範囲なし（where から範囲を取り出せなかった）'
  return f.citedRanges
    .map(
      (c) =>
        `\`${c.file} L${c.range.start}-${c.range.end}\`（${c.changed ? '変更行に掛かる' : '変更行に掛からない'}）`
    )
    .join('、')
}

function formatEntry(e: ReceptacleEntry, index: number): string {
  return [
    `### 記録 ${index}（${oneLine(e.reviewerNo)}）`,
    '',
    `- レビュー番号: ${oneLine(e.reviewerNo)}`,
    `- 要旨: ${oneLine(e.title)}`,
    `- where: ${oneLine(e.where)}`,
    `- severity: ${e.severity}`,
    `- 提案 ID: ${oneLine(e.proposalId)}`,
    `- 案件 ID: ${oneLine(e.caseId)}`,
    `- 巡: 第 ${e.round} 巡`,
    `- 根拠: ${oneLine(e.basis)}`,
    `- 記録時刻: ${e.recordedAt}`,
    ''
  ].join('\n')
}

function countEntries(body: string): number {
  return (body.match(/^### /gm) ?? []).length
}

function skillDirOf(baseDir: string, skillName: string): string {
  return join(baseDir, skillName)
}

function listMdFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .sort()
  } catch {
    return []
  }
}

/**
 * 既存のパス p が、baseDir の実パス（シンボリックリンク・ジャンクションを解決した後）の配下のどこにあるか。
 * 字句上は baseDir の中でも、リンクで外を指していれば null（呼び手は外として扱う）。それ以外は baseDir からの相対の部品
 */
function realRelParts(baseDir: string, p: string): string[] | null {
  try {
    const rel = relative(realpathSync(baseDir), realpathSync(p))
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
    return rel.split(sep)
  } catch {
    return null
  }
}

/** 持ち主が空・無いなら既定にする（手で消された・壊れた受け皿でも、持ち主を空のままにしない） */
function withOwner(fm: Array<{ key: string; raw: string }>): Array<{ key: string; raw: string }> {
  const i = fm.findIndex((e) => e.key === 'owner')
  const blank = i < 0 || oneLine(parseScalar(fm[i].raw)) === ''
  if (!blank) return fm
  const fixed = { key: 'owner', raw: yamlScalar(RECEPTACLE_DEFAULT_OWNER) }
  return i < 0 ? [...fm, fixed] : fm.map((e, j) => (j === i ? fixed : e))
}

function readReceptacle(filePath: string): ParsedReceptacle | null {
  try {
    const p = parseReceptacleText(readFileSync(filePath, 'utf-8'))
    if (!p) return null
    if (fmGet(p, 'kind') !== 'base-finding') return null
    const status = fmGet(p, 'status')
    if (status !== 'open' && status !== 'closed') return null
    if (!fmGet(p, 'normalized_key') || !fmGet(p, 'skill')) return null
    return p
  } catch {
    return null
  }
}

export interface UpsertBaseFindingsInput {
  skillName: string
  /** 受け皿の持ち主（元提案の author／issuer）。空なら RECEPTACLE_DEFAULT_OWNER */
  owner: string
  proposalId: string
  caseId: string
  round: number
  /** 分類済みの指摘。origin が 'base' のものだけを受け皿へ入れる（混在のレビューを渡してよい） */
  findings: ClassifiedFinding[]
  now?: Date
}

/**
 * 原文由来の指摘を受け皿へ入れる。同じ skill・同じ正規化キーの open の受け皿があれば追記、無ければ新規に作る。
 * 戻り値は触った受け皿のパス（重複なし・入れた順）。baseDir は `<ccpitDir>/base-findings`。
 */
export function upsertBaseFindings(baseDir: string, input: UpsertBaseFindingsInput): string[] {
  if (!SKILL_NAME_RE.test(input.skillName)) {
    throw new Error(
      `受け皿: skill 名がパスの部品として不正です: ${JSON.stringify(input.skillName)}`
    )
  }
  const now = input.now ?? new Date()
  const recordedAt = now.toISOString()
  const owner = oneLine(input.owner ?? '') || RECEPTACLE_DEFAULT_OWNER
  const dir = skillDirOf(baseDir, input.skillName)
  const touched: string[] = []
  // skill のフォルダが既にあるなら、リンクで baseDir の外を指していないこと（外へ書かない）
  if (existsSync(dir) && existsSync(baseDir) && realRelParts(baseDir, dir)?.length !== 1) {
    throw new Error(`受け皿: skill のフォルダが受け皿のフォルダの外を指しています: ${dir}`)
  }

  for (const f of input.findings) {
    if (f.origin !== 'base') continue
    const key = findingKey(f.where, f.title)
    const entry: ReceptacleEntry = {
      reviewerNo: f.reviewerNo,
      title: f.title,
      where: f.where,
      severity: f.severity,
      proposalId: input.proposalId,
      caseId: input.caseId,
      round: input.round,
      basis: describeFindingBasis(f),
      recordedAt
    }

    // 同じ要旨の open があれば追記（作成順で最初のもの）
    let target: string | null = null
    for (const name of listMdFiles(dir)) {
      const p = join(dir, name)
      const parsed = readReceptacle(p)
      if (
        parsed &&
        fmGet(parsed, 'status') === 'open' &&
        fmGet(parsed, 'normalized_key') === key &&
        realRelParts(baseDir, p)?.length === 2 // ファイルがリンクで外を指していない
      ) {
        target = p
        break
      }
    }

    if (target !== null) {
      const parsed = readReceptacle(target)!
      const body =
        parsed.body.endsWith('\n') || parsed.body === '' ? parsed.body : `${parsed.body}\n`
      const next: ParsedReceptacle = {
        fm: withOwner(parsed.fm),
        body: `${body}\n${formatEntry(entry, countEntries(parsed.body) + 1)}`
      }
      writeAtomic(target, composeText(next))
    } else {
      mkdirSync(dir, { recursive: true })
      const hash = createHash('sha256').update(key, 'utf-8').digest('hex').slice(0, KEY_HASH_CHARS)
      const base = `${stamp(now)}_${hash}`
      let name = `${base}.md`
      for (let n = 2; existsSync(join(dir, name)); n++) {
        if (n > FILENAME_SUFFIX_MAX)
          throw new Error(`受け皿: ファイル名の衝突が解けません: ${base}`)
        name = `${base}_${n}.md`
      }
      target = join(dir, name)
      const fm: ReceptacleFrontmatter = {
        kind: 'base-finding',
        created_by: 'ccpit-compose',
        created_at: recordedAt,
        owner,
        skill: input.skillName,
        status: 'open',
        normalized_key: key,
        title: oneLine(f.title)
      }
      const text: ParsedReceptacle = {
        fm: [
          { key: 'kind', raw: fm.kind },
          { key: 'created_by', raw: fm.created_by },
          { key: 'created_at', raw: fm.created_at },
          { key: 'owner', raw: yamlScalar(fm.owner) },
          { key: 'skill', raw: yamlScalar(fm.skill) },
          { key: 'status', raw: fm.status },
          { key: 'normalized_key', raw: yamlScalar(fm.normalized_key) },
          { key: 'title', raw: yamlScalar(fm.title) }
        ],
        body: `\n# 原文への指摘: ${oneLine(f.title)}\n\n合成提案のレビューで、提案が触っていない golden の原文への指摘と確定したもの。提案の採否とは別に、原文の課題として扱う。\n\n## 記録\n\n${formatEntry(entry, 1)}`
      }
      writeAtomic(target, composeText(text))
    }
    if (!touched.includes(target)) touched.push(target)
  }
  return touched
}

/** 受け皿の一覧。壊れたファイルは飛ばす。closed も返す（status で分かる）。skillName を渡すとその skill だけ */
export function listReceptacles(baseDir: string, skillName?: string): ReceptacleSummary[] {
  let skills: string[]
  if (skillName !== undefined) {
    if (!SKILL_NAME_RE.test(skillName)) return []
    skills = [skillName]
  } else {
    try {
      skills = readdirSync(baseDir).filter((d) => SKILL_NAME_RE.test(d))
    } catch {
      return []
    }
  }
  const out: ReceptacleSummary[] = []
  for (const sk of skills) {
    const dir = skillDirOf(baseDir, sk)
    for (const name of listMdFiles(dir)) {
      const p = join(dir, name)
      const parsed = readReceptacle(p)
      if (!parsed || realRelParts(baseDir, p)?.length !== 2) continue
      const closedHow = fmGet(parsed, 'closed_how')
      out.push({
        path: p,
        skill: fmGet(parsed, 'skill') ?? sk,
        status: fmGet(parsed, 'status') === 'closed' ? 'closed' : 'open',
        owner: oneLine(fmGet(parsed, 'owner') ?? '') || RECEPTACLE_DEFAULT_OWNER,
        title: fmGet(parsed, 'title') ?? '',
        normalizedKey: fmGet(parsed, 'normalized_key') ?? '',
        createdAt: fmGet(parsed, 'created_at') ?? '',
        ...(closedHow && (CLOSED_HOWS as readonly string[]).includes(closedHow)
          ? { closedHow: closedHow as ReceptacleClosedHow }
          : {}),
        entryCount: countEntries(parsed.body)
      })
    }
  }
  return out.sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.path < b.path ? -1 : 1
  )
}

/**
 * 受け皿を閉じる（status: closed・closed_how・closed_at を書く）。受け皿を消す関数は作らない。
 * filePath が baseDir の直下 2 階層（`<skill>/<ファイル>.md`）の中にあるときだけ受け付ける。
 */
export function closeReceptacle(
  baseDir: string,
  filePath: string,
  how: ReceptacleClosedHow,
  now: Date = new Date()
): { ok: true } | { ok: false; error: string } {
  if (!(CLOSED_HOWS as readonly string[]).includes(how)) {
    return { ok: false, error: `閉じ方が不正です: ${JSON.stringify(how)}` }
  }
  const rel = relative(resolve(baseDir), resolve(filePath))
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, error: '受け皿のフォルダの外のパスは閉じられません' }
  }
  const parts = rel.split(sep)
  if (parts.length !== 2 || !SKILL_NAME_RE.test(parts[0]) || !parts[1].endsWith('.md')) {
    return { ok: false, error: '受け皿のパスの形が違います（<skill>/<ファイル>.md の 2 階層だけ）' }
  }
  const abs = join(resolve(baseDir), parts[0], parts[1])
  if (!existsSync(abs)) return { ok: false, error: '受け皿が見つかりません' }
  // 字句上は中でも、リンクで baseDir の外を指すものは閉じない（外のファイルを書き換えない）
  if (realRelParts(baseDir, abs)?.length !== 2) {
    return { ok: false, error: '受け皿のフォルダの外を指すリンクは閉じられません' }
  }
  const parsed = readReceptacle(abs)
  if (!parsed) return { ok: false, error: '受け皿として読めないファイルです' }
  if (fmGet(parsed, 'status') === 'closed') return { ok: false, error: 'すでに閉じています' }
  // status は元の位置のまま closed にし、closed_how・closed_at を末尾に足す（既存の closed_* は置き換える）
  const rebuilt: Array<{ key: string; raw: string }> = []
  for (const e of withOwner(parsed.fm)) {
    if (e.key === 'closed_how' || e.key === 'closed_at') continue
    rebuilt.push(e.key === 'status' ? { key: 'status', raw: 'closed' } : e)
  }
  rebuilt.push({ key: 'closed_how', raw: how }, { key: 'closed_at', raw: now.toISOString() })
  writeAtomic(abs, composeText({ fm: rebuilt, body: parsed.body }))
  return { ok: true }
}
