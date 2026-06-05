/**
 * enforcementStats — Enforcement 発火統計の集計（Part B Phase 2a / UX 目標 #6）。
 *
 * データソース（B6 と同じ唯一の機械ソース）:
 *   ~/.claude/projects/<project-slug>/<sessionId>.jsonl のセッショントランスクリプト。
 *
 * 集計対象 = 監査（_Research/..._Audit.md §3）+ 指示書で countable と確定した型のうち、
 * 本サービスは 4 型を JSONL 単一パスで集計する:
 *   - hooks(Stop)    : `type=system, subtype=stop_hook_summary` を 1 Stop サイクル。hook 別ランキング = hookInfos[].command の実スクリプト名。
 *   - rules層B       : 上記のうち hookErrors[] 非空（or preventedContinuation）を「rule 発火＝ブロック」。帰属 = durationMs 欠落 hook。
 *   - deny           : message.content[] の `tool_result(is_error) && /Permission .* has been denied/` を 1 発火。
 *                       2 系列に近似分離: tool_form(=settings.json deny, "Permission to use ...") / action_form(=rule/policy 自己拒否, "Permission for this action ...")。
 *   - marshal-review : `name=Bash` tool_use の codex-companion **起動サブコマンド**を 1 発火。
 *                       実レビュー起動（adversarial-review=marshal-review / task・review=codex-review）のみ計数し、
 *                       status/result/cancel/setup/--help 等の付帯操作は計数しない。ランキングはサブコマンド別（何が走ったか）。
 * skill 型は本サービスでは扱わない。UI(skill タブ)が B6 リッチ IPC（skillFiringStatsCompute）を直接使う（単一真実源）。
 * rules層A（常時注入）は離散発火が定義不能ゆえ独立計数せず、参考値 note のみ返す（UI は参考値バナーで表現）。
 *
 * 射程限定（観測限界。各型の scopeNote に明示し UI に出す。偽の数字を出さない）:
 *   - deny: tool_use を生成させず弾いた拒否は JSONL 非記録ゆえ数えていない。2 系列分離は文面形態による近似。
 *           二重計上回避のため message.content の tool_result のみ数え、兄弟フィールド toolUseResult は数えない。
 *   - marshal: SKILL.md の再帰で 1 タスク最大 3 起動 → 起動回数 ≠ レビュータスク回数。付帯操作（status 等）は計数外。
 *   - hooks(Stop): 旧 `hook_blocking_error` は stop_hook_summary の部分集合ゆえ対象外（二重計上回避）。
 *
 * 読み取り専用: JSONL を読むだけ。書込・無効化・enforcement 実行・skill 操作は一切しない。
 * 性能: per-file キャッシュ（mtimeMs + size をキーに、変更ファイルのみ再パース）。B6 と同型を内部実装（B6 改変回避）。
 * 本モジュールは Electron Main プロセスのサービス（AI 体制非依存）。
 */

import { readFile, readdir, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { getDefaultProjectsRoot } from './skillFiringStats'

/** 型別の集計結果（total と降順ランキングと射程注記）。 */
export interface EnforcementTypeStat {
  total: number
  /** 降順ランキング（key = hook 名 / tool 名 / 理由 / サブコマンド等、型ごとに意味が異なる） */
  ranking: { key: string; count: number }[]
  scopeNote: string
}

/** deny は由来別の 2 系列で表示する（混ぜない）。 */
export interface DenyStat {
  /** settings.json deny 由来（tool_form: "Permission to use <tool> ..."） */
  settingsJson: EnforcementTypeStat
  /** rule・policy 自己拒否（action_form: "Permission for this action ... Reason: ..."） */
  rulePolicy: EnforcementTypeStat
  /** deny 共通の射程注記 */
  scopeNote: string
}

export interface EnforcementStatsResult {
  hooksStop: EnforcementTypeStat
  rulesB: EnforcementTypeStat
  deny: DenyStat
  marshal: EnforcementTypeStat
  /** rules層A: 独立計数せず参考値 note のみ（UI は参考値バナー） */
  rulesLayerA: { note: string }
  filesScanned: number
}

export interface ComputeEnforcementStatsOptions {
  projectsRoot?: string
  lang?: 'ja' | 'en'
}

// --- 射程注記（ja/en） ---
const NOTE = {
  hooksStop: {
    ja: 'stop_hook_summary を 1 Stop サイクルとして集計。ランキングは hook 別（実スクリプト名）。旧 hook_blocking_error は summary の部分集合ゆえ対象外（二重計上回避）。',
    en: 'Counts each stop_hook_summary as one Stop cycle. Ranking is per hook (actual script name). The legacy hook_blocking_error is a subset of the summary and is excluded (avoids double counting).'
  },
  rulesB: {
    ja: 'hookErrors 非空（or preventedContinuation）の Stop を「rule 発火＝ブロック」として集計。帰属はブロック hook（durationMs 欠落）。PreToolUse 系 hook 化 rule（settings-guard 等）は構造レコードを残さず測定対象外。',
    en: 'Counts Stop cycles with non-empty hookErrors (or preventedContinuation) as rule firings (blocks). Attribution uses the blocking hook (missing durationMs). PreToolUse-style hook-ified rules (e.g. settings-guard) leave no structured record and are out of scope.'
  },
  deny: {
    ja: 'tool_result(is_error) かつ「Permission … has been denied」を 1 発火として集計（兄弟 toolUseResult は二重計上回避で除外）。2 系列は文面形態（tool_form / action_form）による近似分離。tool_use を生成させず弾いた拒否は JSONL 非記録ゆえ数えていない。',
    en: 'Counts each tool_result(is_error) matching "Permission … has been denied" as one firing (the sibling toolUseResult is excluded to avoid double counting). The two series are an approximate split by message form (tool_form / action_form). Denials that blocked before a tool_use was emitted are not recorded in JSONL and are not counted.'
  },
  marshal: {
    ja: 'codex-companion の実レビュー起動サブコマンドを 1 発火として集計。adversarial-review=marshal-review / task・review=codex-review として区別表示。status・result・cancel・setup・--help 等の付帯操作は計数しない。SKILL.md の再帰で 1 タスク最大 3 起動のため、起動回数 ≠ レビュータスク回数。',
    en: 'Counts each codex-companion review-launch subcommand as one firing. Distinguished as adversarial-review=marshal-review / task,review=codex-review. Ancillary operations (status, result, cancel, setup, --help, etc.) are not counted. Because the SKILL.md recurses up to 3 launches per task, launch count ≠ review-task count.'
  },
  rulesLayerA: {
    ja: 'rules層A（CLAUDE.md インターロック等の常時注入）は毎ターン合成注入で transcript 非永続。離散発火が定義できないため計数対象外（独立タブ化せず、偽の数字を出さない）。',
    en: 'rules layer A (always-injected interlocks such as CLAUDE.md) is synthesized every turn and not persisted to the transcript. Its discrete firings are undefinable, so it is not counted (no dedicated tab; we do not show fabricated numbers).'
  }
} as const

const pick = (n: { ja: string; en: string }, lang?: 'ja' | 'en'): string =>
  lang === 'en' ? n.en : n.ja

const DENY_RE = /Permission .* has been denied/
const DENY_TOOL_FORM_RE = /Permission to use\s+([^\s]+)/
const DENY_REASON_RE = /Reason:\s*(.+?)(?:\.\.| If you have| If you believe|$)/s

// codex-companion 起動サブコマンド抽出（command 内のどこに現れてもよい。最初の 1 件）。
// 先頭ダッシュは 0 個以上（-*）。adversarial-review/task 等の非ダッシュ語と --help 等を共に捕捉する。
const MARSHAL_SUB_RE = /codex-companion\.mjs["']?\s+(-*[A-Za-z][\w-]*)/

/**
 * codex-companion の Bash command を「実レビュー起動サブコマンド」に分類する。
 * 実起動（adversarial-review / task / review）のみ非 null を返し、付帯操作（status 等）は null（計数しない）。
 */
function classifyMarshal(cmd: string): string | null {
  const sub = cmd.match(MARSHAL_SUB_RE)?.[1]
  if (sub === 'adversarial-review') return 'adversarial-review (marshal-review)'
  if (sub === 'task' || sub === 'review') return `${sub} (codex-review)`
  return null // status / result / cancel / task-resume-candidate / setup / --help / 未分類 は起動でないため計数しない
}

/**
 * hook command を実行されるスクリプト名で表示する。
 * node/tsx ランナー経由（例 `node "<path>/stop-review-gate-hook.mjs"`）は引数スクリプトの basename を採る。
 * .sh 等の直接実行は従来どおり basename。スクリプト引数を特定できない変則形はランナー名にフォールバック（捏造しない）。
 */
function hookDisplayName(cmd: string): string {
  const toks = cmd.trim().split(/\s+/)
  const first = toks[0] ?? cmd
  const firstBase = (first.split(/[\\/]/).pop() || first).replace(/^["']|["']$/g, '')
  if (/^(node|node\.exe|tsx)$/i.test(firstBase)) {
    for (const t of toks.slice(1)) {
      const unq = t.replace(/^["']|["']$/g, '')
      if (/\.(mjs|cjs|js|ts)$/i.test(unq)) {
        const base = unq.split(/[\\/]/).pop()
        if (base) return base
      }
    }
    return firstBase // スクリプト引数を特定できなければランナー名にフォールバック
  }
  return firstBase
}

// --- per-file キャッシュ（main 常駐。mtime/size 変化で再パース） ---
interface FileCacheEntry {
  mtimeMs: number
  size: number
  records: EnfRecord[]
}
const fileCache = new Map<string, FileCacheEntry>()

/** 1 ファイルから抽出する enforcement レコード（型タグ付き中間表現）。 */
type EnfRecord =
  | { kind: 'stop'; commands: string[]; blocked: boolean; blockCommands: string[] }
  | { kind: 'deny'; toolForm: boolean; rankKey: string }
  | { kind: 'marshal'; sub: string }

/** stop_hook_summary レコードから hooks(Stop)/rules層B 情報を抽出。 */
function parseStopRecord(rec: {
  hookInfos?: unknown
  hookErrors?: unknown
  preventedContinuation?: unknown
}): EnfRecord {
  const commands: string[] = []
  const blockCommands: string[] = []
  const infos = Array.isArray(rec.hookInfos) ? rec.hookInfos : []
  for (const h of infos) {
    if (h === null || typeof h !== 'object') continue
    const cmd = (h as { command?: unknown }).command
    if (typeof cmd !== 'string' || cmd.length === 0) continue
    commands.push(cmd)
    // ブロック hook は durationMs 欠落（完走しなかった）= 帰属シグナル
    if ((h as { durationMs?: unknown }).durationMs === undefined) blockCommands.push(cmd)
  }
  const hookErrors = Array.isArray(rec.hookErrors) ? rec.hookErrors : []
  const blocked = hookErrors.length > 0 || rec.preventedContinuation === true
  return { kind: 'stop', commands, blocked, blockCommands }
}

/** JSONL 1 ファイルから 4 型の発火レコードを抽出（破損行 skip）。 */
function extractFromJsonl(content: string): EnfRecord[] {
  const out: EnfRecord[] = []
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
      type?: unknown
      subtype?: unknown
      cwd?: unknown
      hookInfos?: unknown
      hookErrors?: unknown
      preventedContinuation?: unknown
      message?: { content?: unknown }
    }

    // hooks(Stop) / rules層B
    if (r.type === 'system' && r.subtype === 'stop_hook_summary') {
      out.push(parseStopRecord(r))
      continue
    }

    const content2 = r.message?.content
    if (!Array.isArray(content2)) continue

    for (const item of content2) {
      if (item !== null && typeof item === 'object') {
        const it = item as {
          type?: unknown
          name?: unknown
          content?: unknown
          is_error?: unknown
          input?: unknown
        }

        // deny: tool_result(is_error) かつ Permission ... denied（message.content のみ＝二重計上回避）
        if (it.type === 'tool_result' && it.is_error === true) {
          const text = typeof it.content === 'string' ? it.content : ''
          if (DENY_RE.test(text)) {
            const toolForm = DENY_TOOL_FORM_RE.test(text)
            let rankKey: string
            if (toolForm) {
              const m = text.match(DENY_TOOL_FORM_RE)
              rankKey = m?.[1] ?? '(tool)'
            } else {
              const m = text.match(DENY_REASON_RE)
              rankKey = (m?.[1] ?? '(reason)').trim().slice(0, 60)
            }
            out.push({ kind: 'deny', toolForm, rankKey })
          }
        }

        // marshal-review: Bash tool_use の codex-companion 起動サブコマンド（実レビュー起動のみ）
        if (it.type === 'tool_use' && it.name === 'Bash') {
          const input = it.input
          const cmd =
            input !== null && typeof input === 'object'
              ? ((input as { command?: unknown }).command as string | undefined)
              : undefined
          if (typeof cmd === 'string' && cmd.includes('codex-companion')) {
            const sub = classifyMarshal(cmd)
            if (sub) out.push({ kind: 'marshal', sub })
          }
        }
      }
    }
  }
  return out
}

/** mtime/size キャッシュ越しに 1 ファイルの enforcement レコードを得る。 */
async function getFileRecords(filePath: string): Promise<EnfRecord[]> {
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
  let records: EnfRecord[] = []
  try {
    records = extractFromJsonl(await readFile(filePath, 'utf-8'))
  } catch {
    records = []
  }
  fileCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, records })
  return records
}

/** Map<key,count> を降順ランキング配列へ。 */
function toRanking(m: Map<string, number>): { key: string; count: number }[] {
  return [...m.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
}

/** ~/.claude/projects 配下の *.jsonl を収集（B6 と同型）。 */
async function collectJsonlFiles(root: string): Promise<string[]> {
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
  return jsonlFiles
}

/**
 * 全 JSONL を走査して enforcement 4 型（hooks/rulesB/deny/marshal）の発火統計を集計する
 * （読み取り専用、on-demand + per-file キャッシュ）。skill 型は UI が B6 リッチ IPC を直接使う。
 */
export async function computeEnforcementStats(
  opts: ComputeEnforcementStatsOptions = {}
): Promise<EnforcementStatsResult> {
  const root = opts.projectsRoot ?? getDefaultProjectsRoot()
  const lang = opts.lang

  const empty = (note: string): EnforcementTypeStat => ({ total: 0, ranking: [], scopeNote: note })
  if (!existsSync(root)) {
    return {
      hooksStop: empty(pick(NOTE.hooksStop, lang)),
      rulesB: empty(pick(NOTE.rulesB, lang)),
      deny: {
        settingsJson: empty(pick(NOTE.deny, lang)),
        rulePolicy: empty(pick(NOTE.deny, lang)),
        scopeNote: pick(NOTE.deny, lang)
      },
      marshal: empty(pick(NOTE.marshal, lang)),
      rulesLayerA: { note: pick(NOTE.rulesLayerA, lang) },
      filesScanned: 0
    }
  }

  const jsonlFiles = await collectJsonlFiles(root)

  // --- 単一パス集計（hooks/rulesB/deny/marshal） ---
  let hooksStopTotal = 0
  const hooksByCmd = new Map<string, number>()
  let rulesBTotal = 0
  const rulesBByHook = new Map<string, number>()
  let denyToolTotal = 0
  const denyToolByKey = new Map<string, number>()
  let denyActionTotal = 0
  const denyActionByKey = new Map<string, number>()
  let marshalTotal = 0
  const marshalBySub = new Map<string, number>()

  for (const fp of jsonlFiles) {
    const records = await getFileRecords(fp)
    for (const rec of records) {
      if (rec.kind === 'stop') {
        hooksStopTotal++
        for (const cmd of rec.commands) {
          const k = hookDisplayName(cmd)
          hooksByCmd.set(k, (hooksByCmd.get(k) ?? 0) + 1)
        }
        if (rec.blocked) {
          rulesBTotal++
          const attrib = rec.blockCommands.length > 0 ? rec.blockCommands : ['(unattributed)']
          for (const cmd of attrib) {
            const k = cmd === '(unattributed)' ? cmd : hookDisplayName(cmd)
            rulesBByHook.set(k, (rulesBByHook.get(k) ?? 0) + 1)
          }
        }
      } else if (rec.kind === 'deny') {
        if (rec.toolForm) {
          denyToolTotal++
          denyToolByKey.set(rec.rankKey, (denyToolByKey.get(rec.rankKey) ?? 0) + 1)
        } else {
          denyActionTotal++
          denyActionByKey.set(rec.rankKey, (denyActionByKey.get(rec.rankKey) ?? 0) + 1)
        }
      } else {
        // marshal（実レビュー起動サブコマンド別）
        marshalTotal++
        marshalBySub.set(rec.sub, (marshalBySub.get(rec.sub) ?? 0) + 1)
      }
    }
  }

  return {
    hooksStop: {
      total: hooksStopTotal,
      ranking: toRanking(hooksByCmd),
      scopeNote: pick(NOTE.hooksStop, lang)
    },
    rulesB: {
      total: rulesBTotal,
      ranking: toRanking(rulesBByHook),
      scopeNote: pick(NOTE.rulesB, lang)
    },
    deny: {
      settingsJson: {
        total: denyToolTotal,
        ranking: toRanking(denyToolByKey),
        scopeNote: pick(NOTE.deny, lang)
      },
      rulePolicy: {
        total: denyActionTotal,
        ranking: toRanking(denyActionByKey),
        scopeNote: pick(NOTE.deny, lang)
      },
      scopeNote: pick(NOTE.deny, lang)
    },
    marshal: {
      total: marshalTotal,
      ranking: toRanking(marshalBySub),
      scopeNote: pick(NOTE.marshal, lang)
    },
    rulesLayerA: { note: pick(NOTE.rulesLayerA, lang) },
    filesScanned: jsonlFiles.length
  }
}

/** テスト用: per-file キャッシュをクリアする。 */
export function clearEnforcementStatsCache(): void {
  fileCache.clear()
}
