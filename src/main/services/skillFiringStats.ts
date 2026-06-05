/**
 * skillFiringStats — Skill 発火統計の集計（Part B Phase 1 / 構想4-A = フィードバックセンサ可視化）。
 *
 * データソース（調査 A で確定した唯一の機械ソース）:
 *   ~/.claude/projects/<project-slug>/<sessionId>.jsonl のセッショントランスクリプト。
 *   各行は JSON レコードで、message.content[] に `{"type":"tool_use","name":"Skill",
 *   "input":{"skill":"<name>"}}` が含まれる。レコード直下に timestamp / cwd / sessionId。
 *
 * 射程限定（判断2 の観測限界。UI でも明示する）:
 *   - 捕捉できるのは **CC が Skill ツールを明示的に呼んだ発火** のみ。
 *   - CLAUDE.md 常時注入型・hook 由来・訓練知識は独立レコードにならず **測定対象外**。
 *   よって本集計は「明示 Skill ツール発火」の母集団に限定される（全発火ではない）。
 *
 * 読み取り専用: JSONL を読むだけ。書込・無効化・skill 操作は一切しない。
 * 性能: per-file キャッシュ（mtimeMs + size をキーに、変更ファイルのみ再パース）。
 * 本モジュールは Electron Main プロセスのサービス（AI 体制非依存）。
 */

import { readFile, readdir, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

/** 1 発火レコード（集計の中間表現）。 */
interface FiringRecord {
  skill: string
  timestamp: string // ISO（無ければ ''）
  project: string // cwd（無ければ ''）
}

export interface SkillFiringStat {
  skill: string
  count: number
  /** 最終発火日時 ISO。timestamp が一つも取れなければ null */
  lastFiredAt: string | null
  /** PRJ(cwd) 別発火回数（多い順） */
  byProject: { project: string; count: number }[]
}

export interface FiringStatsResult {
  stats: SkillFiringStat[] // count 降順
  totalFirings: number
  filesScanned: number
  /** 射程限定の注記（UI 明示用、判断2） */
  scopeNote: string
}

/** ~/.claude/projects */
export function getDefaultProjectsRoot(): string {
  return join(homedir(), '.claude', 'projects')
}

// --- per-file キャッシュ（main プロセス常駐。mtime/size 変化で再パース） ---
interface FileCacheEntry {
  mtimeMs: number
  size: number
  records: FiringRecord[]
}
const fileCache = new Map<string, FileCacheEntry>()

/** JSONL 1 ファイルから Skill 発火レコードを抽出（破損行は skip）。 */
function extractFiringsFromJsonl(content: string): FiringRecord[] {
  const out: FiringRecord[] = []
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    let rec: unknown
    try {
      rec = JSON.parse(t)
    } catch {
      continue // 破損行 skip
    }
    if (rec === null || typeof rec !== 'object') continue
    const r = rec as {
      message?: { content?: unknown }
      timestamp?: unknown
      cwd?: unknown
    }
    const content2 = r.message?.content
    if (!Array.isArray(content2)) continue
    const timestamp = typeof r.timestamp === 'string' ? r.timestamp : ''
    const project = typeof r.cwd === 'string' ? r.cwd : ''
    for (const item of content2) {
      if (
        item !== null &&
        typeof item === 'object' &&
        (item as { type?: unknown }).type === 'tool_use' &&
        (item as { name?: unknown }).name === 'Skill'
      ) {
        const input = (item as { input?: unknown }).input
        const skill =
          input !== null && typeof input === 'object'
            ? ((input as { skill?: unknown }).skill as string | undefined)
            : undefined
        if (typeof skill === 'string' && skill.length > 0) {
          out.push({ skill, timestamp, project })
        }
      }
    }
  }
  return out
}

/** mtime/size キャッシュ越しに 1 ファイルの発火レコードを得る。 */
async function getFileFirings(filePath: string): Promise<FiringRecord[]> {
  let st: { mtimeMs: number; size: number }
  try {
    st = await stat(filePath)
  } catch {
    return []
  }
  const cached = fileCache.get(filePath)
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.records
  }
  let records: FiringRecord[] = []
  try {
    records = extractFiringsFromJsonl(await readFile(filePath, 'utf-8'))
  } catch {
    records = []
  }
  fileCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, records })
  return records
}

const SCOPE_NOTE_JA =
  '明示的な Skill ツール発火のみ捕捉。CLAUDE.md 常時注入型・hook 由来・訓練知識は測定対象外（全発火ではない）。'
const SCOPE_NOTE_EN =
  'Only explicit Skill-tool firings are captured. CLAUDE.md always-injected, hook-driven, and training-derived activations are out of scope (this is not all activations).'

export interface ComputeFiringStatsOptions {
  projectsRoot?: string
  lang?: 'ja' | 'en'
}

/**
 * 全 JSONL を走査して Skill 別発火統計を集計する（読み取り専用、on-demand + per-file キャッシュ）。
 */
export async function computeFiringStats(
  opts: ComputeFiringStatsOptions = {}
): Promise<FiringStatsResult> {
  const root = opts.projectsRoot ?? getDefaultProjectsRoot()
  const scopeNote = opts.lang === 'en' ? SCOPE_NOTE_EN : SCOPE_NOTE_JA
  if (!existsSync(root)) {
    return { stats: [], totalFirings: 0, filesScanned: 0, scopeNote }
  }

  // projects/<slug>/<session>.jsonl を収集
  const jsonlFiles: string[] = []
  let projectDirs: string[] = []
  try {
    const entries = await readdir(root, { withFileTypes: true })
    projectDirs = entries.filter((e) => e.isDirectory()).map((e) => join(root, e.name))
  } catch {
    projectDirs = []
  }
  for (const dir of projectDirs) {
    try {
      const files = await readdir(dir)
      for (const f of files) {
        if (f.toLowerCase().endsWith('.jsonl')) jsonlFiles.push(join(dir, f))
      }
    } catch {
      // 読めないディレクトリは skip
    }
  }

  // 集計
  const bySkill = new Map<
    string,
    { count: number; lastFiredAt: string | null; byProject: Map<string, number> }
  >()
  let totalFirings = 0
  for (const fp of jsonlFiles) {
    const firings = await getFileFirings(fp)
    for (const fr of firings) {
      totalFirings++
      let agg = bySkill.get(fr.skill)
      if (!agg) {
        agg = { count: 0, lastFiredAt: null, byProject: new Map() }
        bySkill.set(fr.skill, agg)
      }
      agg.count++
      if (fr.timestamp && (agg.lastFiredAt === null || fr.timestamp > agg.lastFiredAt)) {
        agg.lastFiredAt = fr.timestamp
      }
      if (fr.project) agg.byProject.set(fr.project, (agg.byProject.get(fr.project) ?? 0) + 1)
    }
  }

  const stats: SkillFiringStat[] = [...bySkill.entries()]
    .map(([skill, agg]) => ({
      skill,
      count: agg.count,
      lastFiredAt: agg.lastFiredAt,
      byProject: [...agg.byProject.entries()]
        .map(([project, count]) => ({ project, count }))
        .sort((a, b) => b.count - a.count)
    }))
    .sort((a, b) => b.count - a.count || a.skill.localeCompare(b.skill))

  return { stats, totalFirings, filesScanned: jsonlFiles.length, scopeNote }
}

/** テスト用: per-file キャッシュをクリアする。 */
export function clearFiringStatsCache(): void {
  fileCache.clear()
}
