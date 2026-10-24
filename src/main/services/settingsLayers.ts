import { createHash, createHmac } from 'crypto'

/**
 * `~/.claude/settings.json` の 2 階建ての合成（L0_013）。
 *
 * 1 階＝golden の層: ひな形 T に由来する hook の登録・期待 deny・ひな形が持つ最上位キー。配り直しのたびに T の今の版。
 * 2 階＝手元の層: 手元 L にあって golden の層に属さないもの。配り直しても残る（黙って消さない・書き換えない）。
 *
 * 層の帰属は前回 golden が配った記録 R（`settings-layers.json`）で決める。R が読めないときは
 * 「T にあるものを golden」とみなし、T に無いものは消さずに残す（消さない側）。
 *
 * R は同じ利用者の別のプロセスが書き換えられる（完全性を保つ鍵の置き場が無い）。そのため
 * R だけを根拠に L の物を黙って消す道は作らない: 「外す」（場合 3）は必ず承認の対象にする。
 * R が黙って起こせるのは「golden の層の中身を T の中身に置き換える」（場合 1）だけ。
 *
 * Electron に依存しない純関数。下見と本番の配り直しが同じ関数・同じ入力で同じ結果を見る。
 * `auth` の値は下見の型・記録・一覧に一切載せない（キー名だけ）。
 */

export const SETTINGS_LAYERS_RECORD_VERSION = 1
export const SETTINGS_LAYERS_RECORD_FILENAME = 'settings-layers.json'
export const SETTINGS_LAYERS_LIST_FILENAME = 'settings-layers.md'

/** スクリプトとして扱う拡張子（これで終わる語をスクリプトの語とみなす） */
const SCRIPT_EXTENSIONS = ['.sh', '.bash', '.cjs', '.js', '.mjs', '.py', '.ps1', '.ts']
const SCRIPT_EXT_IN_TEXT = /\.(sh|bash|cjs|js|mjs|py|ps1|ts)\b/i
/** 最上位のうち、キー単位でなく専用の規則で合成する入れ物 */
const STRUCTURED_TOP_KEYS = new Set(['hooks', 'permissions', 'auth'])
const DENY_KEY = 'deny'
const PASSWORD_KEY = 'password'
/** N(x) の中で群の matcher を持つ欄（登録の項目自身のキーと衝突しない名前） */
const GROUP_MATCHER_FIELD = '@groupMatcher'

// ---------------------------------------------------------------------------
// 正規化

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 入れ子の object のキーを再帰的に昇順にした JSON 文字列（配列の順は保つ） */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value))
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value).sort()) {
      if (value[k] === undefined) continue
      out[k] = sortDeep(value[k])
    }
    return out
  }
  return value
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex')
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function basenameOf(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] ?? p
}

function stripOuterQuotes(s: string): string {
  if (s.length >= 2) {
    const a = s[0]
    const b = s[s.length - 1]
    if ((a === '"' || a === "'") && a === b) return s.slice(1, -1)
  }
  return s
}

function replaceHome(s: string, home: string): string {
  if (!home) return s
  const forms = new Set([home.replace(/\\/g, '/'), home.replace(/\//g, '\\')])
  let out = s
  for (const f of forms) {
    if (!f) continue
    out = out.replace(new RegExp(escapeRegExp(f), 'gi'), '$HOME')
  }
  return out
}

/**
 * 語の正規形。引用符を 1 組外す → 実 HOME を `$HOME` → 空白を含まない語に限り `\` を `/` に揃える。
 * 空白を含む語（`bash -c "…"` の文字列など）はシェルの文字列で `\` が意味を持ちうるので揃えない（違うと見る側）。
 */
export function normalizeWord(raw: string, home: string): string {
  let s = replaceHome(stripOuterQuotes(raw), home)
  if (!/\s/.test(s)) {
    s = replaceHome(s.replace(/\\/g, '/'), home)
  }
  return s
}

function normalizeCommand(raw: string, home: string): string {
  const w = normalizeWord(raw, home)
  const base = basenameOf(w).toLowerCase()
  if (base === 'bash' || base === 'bash.exe') return 'bash'
  if (base === 'node' || base === 'node.exe') return 'node'
  return w
}

/**
 * 登録 1 項目のスクリプト名。取れない（項目が object でない・スクリプトの語が無い・
 * 空白を含む語の中に拡張子が現れる＝確実に取れない）ときは null（識別不能＝手元に残す）。
 */
export function scriptNameOf(item: unknown, home: string): string | null {
  if (!isPlainObject(item)) return null
  const words: string[] = []
  if (typeof item.command === 'string') words.push(item.command)
  if (Array.isArray(item.args)) {
    for (const a of item.args) if (typeof a === 'string') words.push(a)
  }
  let last: string | null = null
  for (const raw of words) {
    const w = normalizeWord(raw, home)
    if (/\s/.test(w)) {
      if (SCRIPT_EXT_IN_TEXT.test(w)) return null
      continue
    }
    const lower = w.toLowerCase()
    if (SCRIPT_EXTENSIONS.some((ext) => lower.endsWith(ext))) last = w
  }
  return last === null ? null : basenameOf(last)
}

/** スクリプト名から最後の拡張子を除いた名前（`away-gate-hook.cjs` → `away-gate-hook`） */
export function stemOf(script: string): string {
  const i = script.lastIndexOf('.')
  return i > 0 ? script.slice(0, i) : script
}

/** 文字列がスクリプトの stem を「名前の区切り＋stem＋拡張子」の形で含むか（`report-gate` は `debug-report-gate.sh` に当たらない） */
function mentionsStem(text: string, stem: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegExp(stem)}\\.[A-Za-z0-9]+`).test(text)
}

/** 登録の中身の正規化 N(x)。秘密と機械差（bash/node の実体・実 HOME・区切り・引用符・キー順）だけを除く */
export function normalizeRegistration(item: unknown, groupMatcher: unknown, home: string): string {
  const matcher = groupMatcher === undefined ? '' : groupMatcher
  if (!isPlainObject(item)) return canonicalJson({ [GROUP_MATCHER_FIELD]: matcher, item })
  const o: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(item)) {
    if (k === 'command' && typeof v === 'string') o.command = normalizeCommand(v, home)
    else if (k === 'args' && Array.isArray(v))
      o.args = v.map((a) => (typeof a === 'string' ? normalizeWord(a, home) : a))
    else o[k] = v
  }
  if (!('timeout' in o)) o.timeout = null
  o[GROUP_MATCHER_FIELD] = matcher
  return canonicalJson(o)
}

/** 最上位キー（と permissions・auth の下のキー）の値の正規化の指紋 */
export function keyValueHash(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}

// ---------------------------------------------------------------------------
// 記録 R

export type KeyScope = 'top' | 'permissions' | 'auth'

export interface SettingsLayerRecord {
  version: number
  template: string
  recordedAt: string
  hooks: { event: string; script: string; n?: string }[]
  deny: string[]
  /** auth の下のキーは値を比べない（n は null） */
  keys: { scope: KeyScope; name: string; n: string | null }[]
}

export type RecordStatus =
  | 'ok'
  | 'missing'
  | 'empty'
  | 'invalid-json'
  | 'version-mismatch'
  | 'invalid-shape'
  | 'template-mismatch'

export interface RecordReadResult {
  status: RecordStatus
  record?: SettingsLayerRecord
}

/** 記録の生バイトを読む。ok 以外は「記録なし」（消さない側）として扱われる */
export function parseRecord(bytes: Buffer | null, templateName: string): RecordReadResult {
  if (bytes === null) return { status: 'missing' }
  const text = bytes.toString('utf-8')
  if (text.trim() === '') return { status: 'empty' }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { status: 'invalid-json' }
  }
  if (!isPlainObject(raw)) return { status: 'invalid-shape' }
  if (raw.version !== SETTINGS_LAYERS_RECORD_VERSION) {
    return { status: typeof raw.version === 'number' ? 'version-mismatch' : 'invalid-shape' }
  }
  const okHooks =
    Array.isArray(raw.hooks) &&
    raw.hooks.every(
      (h) =>
        isPlainObject(h) &&
        typeof h.event === 'string' &&
        typeof h.script === 'string' &&
        (h.n === undefined || typeof h.n === 'string')
    )
  const okDeny = Array.isArray(raw.deny) && raw.deny.every((d) => typeof d === 'string')
  const okKeys =
    Array.isArray(raw.keys) &&
    raw.keys.every(
      (k) =>
        isPlainObject(k) &&
        (k.scope === 'top' || k.scope === 'permissions' || k.scope === 'auth') &&
        typeof k.name === 'string' &&
        (k.n === null || typeof k.n === 'string')
    )
  if (typeof raw.template !== 'string' || !okHooks || !okDeny || !okKeys) {
    return { status: 'invalid-shape' }
  }
  const record = raw as unknown as SettingsLayerRecord
  if (record.template !== templateName) return { status: 'template-mismatch' }
  return { status: 'ok', record }
}

// ---------------------------------------------------------------------------
// 下見の型（auth の値を持たない）

export type HookChange =
  | 'unchanged'
  | 'updated'
  | 'added'
  | 'readded'
  | 'removed'
  | 'moved-to-golden'
  | 'replaced-local-change'
  | 'kept'

export type HookMark =
  | 'duplicate'
  | 'golden-removed-local-changed-kept'
  | 'no-record'
  | 'no-record-same-as-template'
  | 'may-overlap-golden'
  | 'unidentifiable'

export interface HookRow {
  layer: 'golden' | 'local'
  event: string
  matcher: string
  /** 識別不能な手元の登録は null */
  script: string | null
  change: HookChange
  marks: HookMark[]
}

export type ApprovalCase =
  | 'local-changed-overwritten' // 場合 1′
  | 'local-to-golden' // 場合 5
  | 'golden-removed' // 場合 3
  | 'duplicate-mismatch' // 重複のどれも golden の形と合わない
  | 'unreadable' // 読めない部分

export interface ApprovalItem {
  kind: 'hook' | 'key' | 'unreadable'
  case: ApprovalCase
  /** hook: `<event>/<script>`・key: `permissions.allow` 等・unreadable: 場所 */
  target: string
  /** unreadable のときの理由（`invalid-json` 等の機械語） */
  reason?: string
}

export interface KeyRow {
  scope: KeyScope
  name: string
  layer: 'golden' | 'local'
  change:
    | 'unchanged'
    | 'updated'
    | 'added'
    | 'removed'
    | 'moved-to-golden'
    | 'replaced-local-change'
    | 'kept'
}

export interface DenySummary {
  golden: number
  local: number
  /** 手元の同じ行を 1 行に畳んだ件数（「減らさない」の唯一の例外） */
  folded: number
  localLines: string[]
  /** 前回 golden の層だったが今回のひな形に無く、手元の層として残った行 */
  leftGolden: string[]
}

export interface SettingsLayersPreview {
  template: string
  record: { status: RecordStatus }
  local: 'absent' | 'present' | 'unreadable'
  hooks: HookRow[]
  deny: DenySummary
  keys: KeyRow[]
  approvalItems: ApprovalItem[]
  /** `auth.password` は配り直しで入力した値に置き換わる（承認の項目ではない明示の例外） */
  passwordReplaced: boolean
}

/** IPC `golden:previewSettingsLayers` の戻り */
export interface SettingsLayersPreviewResult {
  preview: SettingsLayersPreview | null
  /** (ii) が 1 件以上のときだけ。配り直しの第 3 引数で返す */
  approvalToken?: string
  errors: string[]
}

export interface ComposeInput {
  templateName: string
  localBytes: Buffer | null
  templateText: string
  expectedDeny: string[]
  record: RecordReadResult
  bashPath: string
  home: string
}

export type ComposeResult =
  | {
      ok: true
      /** password 注入前の合成結果 */
      composed: Record<string, unknown>
      preview: SettingsLayersPreview
      /** 配り直しが通ったときに書く記録（recordedAt は書く側が入れる） */
      nextRecord: Omit<SettingsLayerRecord, 'recordedAt'>
    }
  | { ok: false; abortReason: string }

// ---------------------------------------------------------------------------
// 合成

interface Reg {
  event: string
  groupIndex: number
  itemIndex: number
  item: unknown
  matcher: string
  script: string | null
  id: string | null
  n: string
}

function regId(event: string, script: string): string {
  return `${event}\u0000${script}`
}

function matcherText(m: unknown): string {
  return typeof m === 'string' ? m : m === undefined ? '' : canonicalJson(m)
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

function uniqueInOrder(lines: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const l of lines) {
    if (seen.has(l)) continue
    seen.add(l)
    out.push(l)
  }
  return out
}

/**
 * bash の実体パスを golden の層の群にだけ掛ける（手元の層の `command:"bash"` は書き換えない）。
 * 規則は `bashResolver.injectResolvedBash` と同じ（type が command で command が "bash" の項目）。
 * あちらは `ccLaunch` を経て重い依存を引くので、Electron 非依存の本モジュールでは同じ規則を群の配列に掛ける。
 */
function injectBashIntoGolden(groups: unknown[], bashPath: string): void {
  for (const grp of groups) {
    const hooks = (grp as { hooks?: unknown })?.hooks
    if (!Array.isArray(hooks)) continue
    for (const h of hooks) {
      const hk = h as { type?: unknown; command?: unknown }
      if (hk && hk.type === 'command' && hk.command === 'bash') hk.command = bashPath
    }
  }
}

export function composeSettings(input: ComposeInput): ComposeResult {
  const { home } = input
  // --- ひな形 T
  let T: unknown
  try {
    T = JSON.parse(input.templateText)
  } catch {
    return { ok: false, abortReason: 'ひな形の settings.json が JSON として読めない' }
  }
  if (!isPlainObject(T))
    return { ok: false, abortReason: 'ひな形の settings.json が object でない' }
  const tHooks = T.hooks === undefined ? {} : T.hooks
  if (!isPlainObject(tHooks)) return { ok: false, abortReason: 'ひな形の hooks が object でない' }
  const tRegs: Reg[] = []
  for (const [event, groups] of Object.entries(tHooks)) {
    if (!Array.isArray(groups))
      return { ok: false, abortReason: `ひな形の hooks.${event} が配列でない` }
    groups.forEach((g, gi) => {
      if (!isPlainObject(g) || !Array.isArray(g.hooks)) return
      g.hooks.forEach((item, hj) => {
        const script = scriptNameOf(item, home)
        tRegs.push({
          event,
          groupIndex: gi,
          itemIndex: hj,
          item,
          matcher: matcherText(g.matcher),
          script,
          id: script === null ? null : regId(event, script),
          n: normalizeRegistration(item, g.matcher, home)
        })
      })
    })
    for (const g of groups) {
      if (!isPlainObject(g) || !Array.isArray(g.hooks)) {
        return { ok: false, abortReason: `ひな形の hooks.${event} に hooks 配列の無い群がある` }
      }
    }
  }
  const tById = new Map<string, Reg>()
  for (const r of tRegs) {
    if (r.id === null) {
      return {
        ok: false,
        abortReason: `ひな形の hooks.${r.event} にスクリプト名の取れない登録がある`
      }
    }
    if (tById.has(r.id)) {
      return {
        ok: false,
        abortReason: `ひな形に同じ登録（${r.event}・${r.script}）が 2 つ以上ある（どれを golden の層にするか決められない）`
      }
    }
    tById.set(r.id, r)
  }
  // 「golden の登録と重なるかもしれない」の印に使う: event ごとの golden のスクリプト名の stem（拡張子を除いた名前）。
  // 手元の `x.cjs` を node で直接呼ぶ登録と golden の足場 `x.sh` は識別子が違う（別の登録）が、同じ見張り役が
  // 二重に動きうる。合成の規則は変えず、下見と一覧で知らせるだけ（L0_013 W4）
  const tStemsByEvent = new Map<string, Set<string>>()
  for (const r of tRegs) {
    const set = tStemsByEvent.get(r.event) ?? new Set<string>()
    set.add(stemOf(r.script as string))
    tStemsByEvent.set(r.event, set)
  }

  // --- 記録 R
  const rOk = input.record.status === 'ok' && input.record.record !== undefined
  const R = rOk ? (input.record.record as SettingsLayerRecord) : undefined
  const rHooks = new Map<string, string | undefined>()
  if (R) for (const h of R.hooks) rHooks.set(regId(h.event, h.script), h.n)
  const rKeys = new Map<string, string | null>()
  if (R) for (const k of R.keys) rKeys.set(`${k.scope}\u0000${k.name}`, k.n)

  // --- 手元 L
  const approvalItems: ApprovalItem[] = []
  let L: Record<string, unknown> | null = null
  let localState: SettingsLayersPreview['local'] = 'absent'
  if (input.localBytes !== null) {
    localState = 'present'
    let parsed: unknown
    let reason: string | null = null
    try {
      parsed = JSON.parse(input.localBytes.toString('utf-8'))
      if (!isPlainObject(parsed)) reason = 'not-object'
    } catch {
      reason = 'invalid-json'
    }
    if (reason !== null) {
      localState = 'unreadable'
      approvalItems.push({
        kind: 'unreadable',
        case: 'unreadable',
        target: 'settings.json',
        reason
      })
    } else {
      L = parsed as Record<string, unknown>
    }
  }

  // 手元の hooks（読める部分だけ）
  const lRegs: Reg[] = []
  /** 読める群: event → [群の index, 群] */
  const lGroups = new Map<string, { index: number; group: Record<string, unknown> }[]>()
  const lEventOrder: string[] = []
  if (L && L.hooks !== undefined) {
    if (!isPlainObject(L.hooks)) {
      approvalItems.push({
        kind: 'unreadable',
        case: 'unreadable',
        target: 'hooks',
        reason: 'not-object'
      })
    } else {
      for (const [event, groups] of Object.entries(L.hooks)) {
        lEventOrder.push(event)
        if (!Array.isArray(groups)) {
          approvalItems.push({
            kind: 'unreadable',
            case: 'unreadable',
            target: `hooks.${event}`,
            reason: 'not-array'
          })
          continue
        }
        const readable: { index: number; group: Record<string, unknown> }[] = []
        groups.forEach((g, gi) => {
          if (!isPlainObject(g) || !Array.isArray(g.hooks)) {
            approvalItems.push({
              kind: 'unreadable',
              case: 'unreadable',
              target: `hooks.${event}[${gi}]`,
              reason: isPlainObject(g) ? 'no-hooks-array' : 'not-object'
            })
            return
          }
          readable.push({ index: gi, group: g })
          g.hooks.forEach((item, hj) => {
            const script = scriptNameOf(item, home)
            lRegs.push({
              event,
              groupIndex: gi,
              itemIndex: hj,
              item,
              matcher: matcherText(g.matcher),
              script,
              id: script === null ? null : regId(event, script),
              n: normalizeRegistration(item, g.matcher, home)
            })
          })
        })
        lGroups.set(event, readable)
      }
    }
  }

  // 手元の登録ごとの行き先: claimed（golden の層の 1 つとして T の中身に置き換わる）・removed（場合 3）・kept
  const disposition = new Map<Reg, 'claimed' | 'removed' | 'kept'>()
  const marks = new Map<Reg, HookMark[]>()
  const addMark = (r: Reg, m: HookMark): void => {
    const list = marks.get(r) ?? []
    if (!list.includes(m)) list.push(m)
    marks.set(r, list)
  }
  const lById = new Map<string, Reg[]>()
  for (const r of lRegs) {
    disposition.set(r, 'kept')
    const stems = tStemsByEvent.get(r.event)
    if (r.id === null) {
      addMark(r, 'unidentifiable')
      const text = canonicalJson(r.item)
      for (const s of stems ?? []) if (mentionsStem(text, s)) addMark(r, 'may-overlap-golden')
      continue
    }
    if (stems && !tById.has(r.id) && stems.has(stemOf(r.script as string))) addMark(r, 'may-overlap-golden')
    const list = lById.get(r.id) ?? []
    list.push(r)
    lById.set(r.id, list)
  }

  const goldenChange = new Map<string, HookChange>()
  for (const [id, t] of tById) {
    const regs = lById.get(id) ?? []
    const target = `${t.event}/${t.script}`
    const inR = rHooks.has(id)
    // 基準 B: R が ok なら R の N（無ければ比較不能 undefined）。R が ok でなければ T の N
    const B: string | undefined = rOk ? rHooks.get(id) : t.n
    if (regs.length === 0) {
      goldenChange.set(id, rOk && inR ? 'readded' : 'added')
      continue
    }
    if (rOk && !inR) {
      // 場合 5: 手元 → golden（中身が同じでも層が変わるので承認）
      const pick = regs.find((r) => r.n === t.n) ?? (regs.length === 1 ? regs[0] : undefined)
      if (pick) {
        disposition.set(pick, 'claimed')
        goldenChange.set(id, 'moved-to-golden')
        approvalItems.push({ kind: 'hook', case: 'local-to-golden', target })
      } else {
        goldenChange.set(id, 'added')
        approvalItems.push({ kind: 'hook', case: 'duplicate-mismatch', target })
      }
    } else {
      const byB = B === undefined ? undefined : regs.find((r) => r.n === B)
      const byT = regs.find((r) => r.n === t.n)
      if (byB) {
        disposition.set(byB, 'claimed')
        goldenChange.set(id, byB.n === t.n ? 'unchanged' : 'updated')
      } else if (byT) {
        disposition.set(byT, 'claimed') // 場合 1″: 手元が既に T の形（何も消えない）
        goldenChange.set(id, 'unchanged')
      } else if (regs.length === 1) {
        disposition.set(regs[0], 'claimed') // 場合 1′
        goldenChange.set(id, 'replaced-local-change')
        approvalItems.push({ kind: 'hook', case: 'local-changed-overwritten', target })
      } else {
        goldenChange.set(id, 'added')
        approvalItems.push({ kind: 'hook', case: 'duplicate-mismatch', target })
      }
    }
    for (const r of regs) {
      if (disposition.get(r) !== 'claimed') addMark(r, 'duplicate')
    }
  }

  const removedRows: HookRow[] = []
  for (const [id, regs] of lById) {
    if (tById.has(id)) continue
    if (rOk && rHooks.has(id)) {
      const rn = rHooks.get(id)
      const pick = rn === undefined ? undefined : regs.find((r) => r.n === rn)
      if (pick) {
        disposition.set(pick, 'removed')
        approvalItems.push({
          kind: 'hook',
          case: 'golden-removed',
          target: `${pick.event}/${pick.script}`
        })
        removedRows.push({
          layer: 'golden',
          event: pick.event,
          matcher: pick.matcher,
          script: pick.script,
          change: 'removed',
          marks: []
        })
      }
      for (const r of regs) {
        if (r !== pick) addMark(r, 'golden-removed-local-changed-kept')
      }
    } else if (!rOk) {
      for (const r of regs) addMark(r, 'no-record')
    }
    if (regs.length > 1)
      for (const r of regs) if (disposition.get(r) === 'kept') addMark(r, 'duplicate')
  }

  // --- hooks の組み立て: event ごとに T の群 → L の残った登録（L の群の形と順のまま）
  const goldenHooks = deepClone(tHooks) as Record<string, unknown[]>
  const composedHooks: Record<string, unknown[]> = {}
  const events = [...Object.keys(tHooks), ...lEventOrder.filter((e) => !(e in tHooks))]
  for (const event of events) {
    const groups: unknown[] = []
    if (event in goldenHooks) {
      const g = goldenHooks[event]
      injectBashIntoGolden(g, input.bashPath)
      groups.push(...g)
    }
    for (const { index, group } of lGroups.get(event) ?? []) {
      const items = group.hooks as unknown[]
      const keptItems = items.filter((_, hj) => {
        const reg = lRegs.find(
          (r) => r.event === event && r.groupIndex === index && r.itemIndex === hj
        )
        return reg !== undefined && disposition.get(reg) === 'kept'
      })
      if (keptItems.length === 0) continue
      groups.push({ ...deepClone(group), hooks: deepClone(keptItems) })
    }
    if (groups.length > 0) composedHooks[event] = groups
  }

  const hookRows: HookRow[] = []
  for (const t of tRegs) {
    const id = t.id as string
    const regs = lById.get(id) ?? []
    const rowMarks: HookMark[] = []
    if (!rOk && regs.some((r) => disposition.get(r) === 'claimed' && r.n === t.n)) {
      rowMarks.push('no-record-same-as-template')
    }
    hookRows.push({
      layer: 'golden',
      event: t.event,
      matcher: t.matcher,
      script: t.script,
      change: goldenChange.get(id) ?? 'unchanged',
      marks: rowMarks
    })
  }
  hookRows.push(...removedRows)
  for (const r of lRegs) {
    if (disposition.get(r) !== 'kept') continue
    hookRows.push({
      layer: 'local',
      event: r.event,
      matcher: r.matcher,
      script: r.script,
      change: 'kept',
      marks: marks.get(r) ?? []
    })
  }

  // --- deny（行ごと。減らさない。同じ行の畳み込みだけが例外）
  const tPerm = isPlainObject(T.permissions) ? T.permissions : {}
  const tDeny = Array.isArray(tPerm.deny)
    ? tPerm.deny.filter((d): d is string => typeof d === 'string')
    : []
  const goldenDeny = uniqueInOrder([...input.expectedDeny, ...tDeny])
  let lPerm: Record<string, unknown> = {}
  const lDeny: string[] = []
  if (L && L.permissions !== undefined) {
    if (!isPlainObject(L.permissions)) {
      approvalItems.push({
        kind: 'unreadable',
        case: 'unreadable',
        target: 'permissions',
        reason: 'not-object'
      })
    } else {
      lPerm = L.permissions
      if (lPerm.deny !== undefined) {
        if (!Array.isArray(lPerm.deny)) {
          approvalItems.push({
            kind: 'unreadable',
            case: 'unreadable',
            target: 'permissions.deny',
            reason: 'not-array'
          })
        } else {
          lPerm.deny.forEach((d, i) => {
            if (typeof d === 'string') lDeny.push(d)
            else
              approvalItems.push({
                kind: 'unreadable',
                case: 'unreadable',
                target: `permissions.deny[${i}]`,
                reason: 'not-string'
              })
          })
        }
      }
    }
  }
  const goldenSet = new Set(goldenDeny)
  const localDenyUnique = uniqueInOrder(lDeny)
  const localDeny = localDenyUnique.filter((d) => !goldenSet.has(d))
  const denyResult = [...goldenDeny, ...localDeny]
  const leftGolden = R ? R.deny.filter((d) => !goldenSet.has(d) && localDenyUnique.includes(d)) : []

  // --- キー（最上位・permissions.<名前>・auth.<名前>）
  let lAuth: Record<string, unknown> = {}
  if (L && L.auth !== undefined) {
    if (!isPlainObject(L.auth)) {
      approvalItems.push({
        kind: 'unreadable',
        case: 'unreadable',
        target: 'auth',
        reason: 'not-object'
      })
    } else {
      lAuth = L.auth
    }
  }
  const tAuth = isPlainObject(T.auth) ? T.auth : undefined
  // auth.password が golden の層なのはひな形が auth を持つときだけ（そのとき値は配り直しの入力で置き換わる）。
  // ひな形が auth を持たなければ手元の auth は丸ごと手元の層として残す。
  const passwordIsGolden = tAuth !== undefined && PASSWORD_KEY in tAuth
  const scopes: {
    scope: KeyScope
    t: Record<string, unknown>
    l: Record<string, unknown>
    skip: Set<string>
  }[] = [
    { scope: 'top', t: T, l: L ?? {}, skip: STRUCTURED_TOP_KEYS },
    { scope: 'permissions', t: tPerm, l: lPerm, skip: new Set([DENY_KEY]) },
    {
      scope: 'auth',
      t: tAuth ?? {},
      l: lAuth,
      skip: passwordIsGolden ? new Set([PASSWORD_KEY]) : new Set()
    }
  ]
  const keyRows: KeyRow[] = []
  const composedScopes: Record<KeyScope, Record<string, unknown>> = {
    top: {},
    permissions: {},
    auth: {}
  }
  const nextKeys: SettingsLayerRecord['keys'] = []
  for (const { scope, t, l, skip } of scopes) {
    const out = composedScopes[scope]
    const label = (name: string): string => (scope === 'top' ? name : `${scope}.${name}`)
    for (const name of Object.keys(t)) {
      if (skip.has(name)) continue
      const tv = t[name]
      const nt = keyValueHash(tv)
      nextKeys.push({ scope, name, n: scope === 'auth' ? null : nt })
      const rk = `${scope}\u0000${name}`
      const inR = rKeys.has(rk)
      const B: string | null | undefined = rOk ? rKeys.get(rk) : nt
      out[name] = deepClone(tv)
      if (!Object.prototype.hasOwnProperty.call(l, name)) {
        keyRows.push({ scope, name, layer: 'golden', change: 'added' })
        continue
      }
      const nl = keyValueHash(l[name])
      if (rOk && !inR) {
        approvalItems.push({ kind: 'key', case: 'local-to-golden', target: label(name) })
        keyRows.push({ scope, name, layer: 'golden', change: 'moved-to-golden' })
      } else if (typeof B === 'string' && nl === B) {
        keyRows.push({ scope, name, layer: 'golden', change: nl === nt ? 'unchanged' : 'updated' })
      } else if (nl === nt) {
        keyRows.push({ scope, name, layer: 'golden', change: 'unchanged' })
      } else {
        approvalItems.push({ kind: 'key', case: 'local-changed-overwritten', target: label(name) })
        keyRows.push({ scope, name, layer: 'golden', change: 'replaced-local-change' })
      }
    }
    for (const name of Object.keys(l)) {
      if (skip.has(name) || Object.prototype.hasOwnProperty.call(t, name)) continue
      const rk = `${scope}\u0000${name}`
      const rn = rOk ? rKeys.get(rk) : undefined
      if (typeof rn === 'string' && keyValueHash(l[name]) === rn) {
        approvalItems.push({ kind: 'key', case: 'golden-removed', target: label(name) })
        keyRows.push({ scope, name, layer: 'golden', change: 'removed' })
        continue
      }
      out[name] = deepClone(l[name])
      keyRows.push({ scope, name, layer: 'local', change: 'kept' })
    }
  }

  // --- 最上位の組み立て（T の順 → L にだけあるキーの L の順）
  const composed: Record<string, unknown> = {}
  const topOrder = [...Object.keys(T), ...Object.keys(L ?? {}).filter((k) => !(k in T))]
  for (const k of topOrder) {
    if (k === 'hooks') {
      if (Object.keys(composedHooks).length > 0 || 'hooks' in T) composed.hooks = composedHooks
    } else if (k === 'permissions') {
      composed.permissions = orderLike(tPerm, { ...composedScopes.permissions, deny: denyResult })
    } else if (k === 'auth') {
      if (tAuth !== undefined || Object.keys(composedScopes.auth).length > 0) {
        const a: Record<string, unknown> = { ...composedScopes.auth }
        if (passwordIsGolden)
          a[PASSWORD_KEY] = deepClone((tAuth as Record<string, unknown>)[PASSWORD_KEY])
        composed.auth = orderLike(tAuth ?? lAuth, a)
      }
    } else if (k in composedScopes.top) {
      composed[k] = composedScopes.top[k]
    }
  }
  if (!('permissions' in composed) && denyResult.length > 0) {
    composed.permissions = { ...composedScopes.permissions, deny: denyResult }
  }

  const preview: SettingsLayersPreview = {
    template: input.templateName,
    record: { status: input.record.status },
    local: localState,
    hooks: hookRows,
    deny: {
      golden: goldenDeny.length,
      local: localDeny.length,
      folded: lDeny.length - localDenyUnique.length,
      localLines: localDeny,
      leftGolden
    },
    keys: keyRows,
    approvalItems,
    passwordReplaced: passwordIsGolden
  }

  const nextRecord: Omit<SettingsLayerRecord, 'recordedAt'> = {
    version: SETTINGS_LAYERS_RECORD_VERSION,
    template: input.templateName,
    hooks: tRegs.map((r) => ({ event: r.event, script: r.script as string, n: r.n })),
    deny: goldenDeny,
    keys: nextKeys
  }
  return { ok: true, composed, preview, nextRecord }
}

/** model のキーの順を保ち、model に無いキーを values の順で後ろに足す */
function orderLike(
  model: Record<string, unknown>,
  values: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(model)) if (k in values) out[k] = values[k]
  for (const k of Object.keys(values)) if (!(k in out)) out[k] = values[k]
  return out
}

// ---------------------------------------------------------------------------
// 承認の印

export interface ApprovalTokenFields {
  templateName: string
  localBytes: Buffer | null
  recordBytes: Buffer | null
  templateBytes: Buffer
  expectedDeny: string[]
  approvalItems: ApprovalItem[]
  bashPath: string
  settingsPath: string
  recordPath: string
  composed: Record<string, unknown>
}

/** 欄を長さ付きで連結し、欄の境目をずらした別の組み合わせが同じ入力にならないようにする */
function lengthPrefixed(parts: (Buffer | null)[]): Buffer {
  const chunks: Buffer[] = []
  for (const p of parts) {
    const head = Buffer.alloc(9)
    if (p === null) {
      head.writeUInt8(0, 0)
      chunks.push(head)
      continue
    }
    head.writeUInt8(1, 0)
    head.writeBigUInt64BE(BigInt(p.length), 1)
    chunks.push(head, p)
  }
  return Buffer.concat(chunks)
}

/** 下見の結果に結び付いた承認の印（HMAC-SHA256・鍵はプロセスの外に出さない） */
export function computeApprovalToken(key: Buffer, f: ApprovalTokenFields): string {
  const u = (s: string): Buffer => Buffer.from(s, 'utf-8')
  const payload = lengthPrefixed([
    u(f.templateName),
    f.localBytes,
    f.recordBytes,
    f.templateBytes,
    u(canonicalJson(f.expectedDeny)),
    u(canonicalJson(f.approvalItems)),
    u(f.bashPath),
    u(f.settingsPath),
    u(f.recordPath),
    u(sha256Hex(canonicalJson(f.composed)))
  ])
  return createHmac('sha256', key).update(payload).digest('hex')
}

// ---------------------------------------------------------------------------
// 一覧ファイル（maintainerが読む。値は書かない）

const CHANGE_LABEL: Record<HookChange, string> = {
  unchanged: 'そのまま',
  updated: 'ひな形の新しい中身',
  added: '追加',
  readded: '追加（手元で消されていた）',
  removed: '外した（承認済み）',
  'moved-to-golden': '手元から golden へ移した（承認済み）',
  'replaced-local-change': '手元の変更をひな形の中身に戻した（承認済み）',
  kept: '残した'
}

const MARK_LABEL: Record<HookMark, string> = {
  duplicate: '重複',
  'golden-removed-local-changed-kept': 'golden は削除・手元で変更あり・残した',
  'no-record': '記録なし',
  'no-record-same-as-template': '記録なし・ひな形と同じ形なので golden の層とした',
  'may-overlap-golden': 'golden の登録と重なるかもしれない（二重に動く恐れ）',
  unidentifiable: '識別できない'
}

function cell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

export function renderLayersMarkdown(preview: SettingsLayersPreview, recordedAt: string): string {
  const lines: string[] = []
  lines.push('# settings.json の層の一覧')
  lines.push('')
  lines.push(`- ひな形: ${preview.template}`)
  lines.push(`- 配り直した時刻: ${recordedAt}`)
  lines.push(
    `- 前回の記録: ${preview.record.status === 'ok' ? 'あり' : `なし（理由: ${preview.record.status}）`}`
  )
  lines.push('')
  lines.push('## hook の登録')
  lines.push('')
  lines.push('| 層 | event | matcher | スクリプト名 | 今回 | 印 |')
  lines.push('|---|---|---|---|---|---|')
  for (const r of preview.hooks) {
    lines.push(
      `| ${r.layer === 'golden' ? 'golden' : '手元'} | ${cell(r.event)} | ${cell(r.matcher)} | ${cell(
        r.script ?? '（識別できない）'
      )} | ${CHANGE_LABEL[r.change]} | ${r.marks.map((m) => MARK_LABEL[m]).join('・')} |`
    )
  }
  lines.push('')
  lines.push('## deny')
  lines.push('')
  lines.push(`- golden の層: ${preview.deny.golden} 行`)
  lines.push(`- 手元の層: ${preview.deny.local} 行`)
  lines.push(`- 手元の同じ行を畳んだ数: ${preview.deny.folded}`)
  if (preview.deny.leftGolden.length > 0) {
    lines.push(`- golden から外れて手元に残った行: ${preview.deny.leftGolden.length} 行`)
  }
  if (preview.deny.localLines.length > 0) {
    lines.push('')
    lines.push('手元の層の行:')
    lines.push('')
    for (const d of preview.deny.localLines) lines.push(`- \`${d.replace(/`/g, "'")}\``)
  }
  lines.push('')
  lines.push('## 最上位キー（名前だけ。値は書かない）')
  lines.push('')
  const name = (k: KeyRow): string => (k.scope === 'top' ? k.name : `${k.scope}.${k.name}`)
  const golden = preview.keys
    .filter((k) => k.layer === 'golden' && k.change !== 'removed')
    .map(name)
  const local = preview.keys.filter((k) => k.layer === 'local').map(name)
  lines.push(`- golden の層: ${golden.length > 0 ? golden.join('・') : '（なし）'}`)
  lines.push(`- 手元の層: ${local.length > 0 ? local.join('・') : '（なし）'}`)
  lines.push('')
  return lines.join('\n')
}
