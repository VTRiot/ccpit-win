import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { runBackstageCc, SAFE_VALUE_RE, type BackstageCcResult } from './backstageCc'
import { emitBgccActivity } from './bgccActivityBus'
import { getParcFermeDir } from './appConfig'

/**
 * 裏CC定石（Backstage CC Pattern）第一利用者（040）: モデルプリセット一覧の動的取得・キャッシュ。
 *
 * R-7注記: 本モジュールは `~/.ccpit/model-catalog.json`（本ファイル固有のキャッシュ）にのみ
 * 書き込む。`appConfig.pxpipe.fableModel` / `pxpipe.models`（Fable起動ボタン専用の経路）へは
 * 一切書き込まない（039 FB⑥ が定めた「両フィールドは必ず併せて更新」という不変条件を、
 * 「触らない」ことで構造的に守る。appConfig.ts の pxpipe フィールド定義付近に将来拡張者向けの
 * 警告コメントを別途配置している）。
 */

export type ModelTier = 'current' | 'legacy' | 'deprecated' | 'limited'

export interface ModelCatalogEntry {
  id: string
  displayName?: string
  tier: ModelTier
}

export interface ModelCatalog {
  fetchedAt: string
  /** データ取得経路（provenance）。stale/freshは保存せず isStale() で都度算出する。 */
  source: 'official' | 'env'
  models: ModelCatalogEntry[]
}

/** R-3 目安値（24h）。 */
export const MODEL_CATALOG_TTL_MS = 24 * 60 * 60 * 1000

const MODEL_CATALOG_FILE = join(getParcFermeDir(), 'model-catalog.json')

const VALID_TIERS: readonly ModelTier[] = ['current', 'legacy', 'deprecated', 'limited']

/**
 * R-0実測で確認した「公式Doc経路」プロンプト。tier分類はページ自身の見出し/ラベルに従わせ、
 * 不明な場合は安全側（legacy）に倒すよう明示指示する（軽微指摘#2: env経路のcurrent固定とは
 * 異なり、こちらはページ側にdeprecated/limitedが実在するため誤って"current"を出させない防御）。
 */
const OFFICIAL_DOCS_PROMPT =
  'Use your web fetch tool to fetch https://docs.claude.com/en/docs/about-claude/models/overview ' +
  '(follow any redirect). From the page, list every Claude model. For each, classify "tier" using ' +
  'the page\'s own section headings/labels: "current" (actively recommended latest-generation models), ' +
  '"legacy" (older/superseded models still listed), "deprecated" (marked deprecated/retiring), or ' +
  '"limited" (marked limited/invite-only availability). If a model\'s tier is unclear from the page, ' +
  'default it to "legacy" (do not guess "current"). Output ONLY a JSON array: ' +
  '[{"id":"<exact model id>","display_name":"<display name>","tier":"<tier>"}]. No prose, no markdown ' +
  'fences, no explanation — the entire response must be valid JSON.'

/** R-0実測で確認した「env自己申告経路」プロンプト。ツール不要（allowedTools無し）。 */
const ENV_SELFREPORT_PROMPT =
  'Output ONLY a JSON array of objects for every Claude model you have been told about in your ' +
  'current session context (system prompt / environment info), each object shaped ' +
  '{"id":"<exact model id string>","display_name":"<display name>"}. No prose, no markdown code ' +
  'fences — the entire response must be valid JSON.'

/** id の長さ上限。実在モデルIDは40字前後のため、汚染データの肥大混入を弾く安全側の上限。 */
const MAX_MODEL_ID_LEN = 128

/**
 * `.result` の厳密JSON配列を ModelCatalogEntry[] へ検証しながら変換する純関数。
 * id が string でない項目は捨てる。tier は既知の4値以外・欠落は 'legacy' へ安全側デフォルト
 * （プロンプト側にも同じ指示をしているが、応答の構造不正に対する二重の防御）。
 * 変換後0件になった場合は失敗（null）として次段フォールバックへ委ねる。
 *
 * FB01内部レビュー: id は WebFetch（外部Web）+ LLM 抽出由来の信頼境界越え入力であり、採用後は
 * renderer のプリセット→通常起動の `--model` としてクオート無しのシェル連結（ccLaunch）へ到達
 * する。裏CC引数側と同じ SAFE_VALUE_RE + 長さ上限で文字集合を検証し、非適合 id は破棄する
 * （defense-in-depth。検証非対称の解消）。
 */
export function parseModelEntries(resultText: string): ModelCatalogEntry[] | null {
  let raw: unknown
  try {
    raw = JSON.parse(resultText)
  } catch {
    return null
  }
  if (!Array.isArray(raw)) return null
  const entries: ModelCatalogEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const obj = item as Record<string, unknown>
    if (typeof obj.id !== 'string' || obj.id.trim() === '') continue
    const id = obj.id.trim()
    if (id.length > MAX_MODEL_ID_LEN || !SAFE_VALUE_RE.test(id)) continue
    const entry: ModelCatalogEntry = { id, tier: 'legacy' }
    const displayName = obj.display_name ?? obj.displayName
    if (typeof displayName === 'string') entry.displayName = displayName
    if (typeof obj.tier === 'string' && (VALID_TIERS as readonly string[]).includes(obj.tier)) {
      entry.tier = obj.tier as ModelTier
    }
    entries.push(entry)
  }
  return entries.length > 0 ? entries : null
}

export type CatalogOutcome =
  | { kind: 'fresh'; source: 'official' | 'env'; models: ModelCatalogEntry[] }
  | { kind: 'existing'; catalog: ModelCatalog }
  | { kind: 'none' }

/**
 * R-1三段fallbackの選択核（純関数・selectPort と同流儀でテスト可能）。
 * P1成功 > P2成功 > 既存キャッシュ据え置き（stale-ok） > 無し、の優先順位。
 * P2（env経路）成功時は全件 tier:'current' に強制する（R-0実測: env経路は現行モデルのみを
 * 返す性質のため。軽微指摘#2: 将来env応答にlegacyが混入した場合の誤分類リスクは残存—
 * 再検証ポイントとして報告書に明記）。
 */
export function selectCatalogOutcome(
  p1Entries: ModelCatalogEntry[] | null,
  p2Entries: ModelCatalogEntry[] | null,
  existing: ModelCatalog | null
): CatalogOutcome {
  if (p1Entries) return { kind: 'fresh', source: 'official', models: p1Entries }
  if (p2Entries) {
    return {
      kind: 'fresh',
      source: 'env',
      models: p2Entries.map((e) => ({ ...e, tier: 'current' as const }))
    }
  }
  if (existing) return { kind: 'existing', catalog: existing }
  return { kind: 'none' }
}

export function readCatalogSync(): ModelCatalog | null {
  if (!existsSync(MODEL_CATALOG_FILE)) return null
  try {
    const parsed = JSON.parse(readFileSync(MODEL_CATALOG_FILE, 'utf-8')) as Partial<ModelCatalog>
    if (typeof parsed.fetchedAt !== 'string' || !Array.isArray(parsed.models)) return null
    if (parsed.source !== 'official' && parsed.source !== 'env') return null
    return {
      fetchedAt: parsed.fetchedAt,
      source: parsed.source,
      models: parsed.models as ModelCatalogEntry[]
    }
  } catch {
    return null
  }
}

export function writeCatalogSync(catalog: ModelCatalog): void {
  const dir = getParcFermeDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(MODEL_CATALOG_FILE, JSON.stringify(catalog, null, 2), 'utf-8')
}

/** 純関数（TTL判定）。fetchedAt が壊れている/存在しない場合は stale 扱い（安全側）。 */
export function isStale(
  catalog: ModelCatalog | null,
  ttlMs: number = MODEL_CATALOG_TTL_MS
): boolean {
  if (!catalog) return true
  const fetchedAtMs = Date.parse(catalog.fetchedAt)
  if (Number.isNaN(fetchedAtMs)) return true
  return Date.now() - fetchedAtMs > ttlMs
}

function extractEntries(result: BackstageCcResult): ModelCatalogEntry[] | null {
  if (!result.ok || !result.resultText) return null
  return parseModelEntries(result.resultText)
}

/**
 * FB01 F3: シングルフライト。起動時トリガと手動更新ボタンが同時に走っても、実行中の
 * fetch があればその Promise を共有し、BG-CC プロセスを同時最大1に抑える。
 * （プロセスを跨ぐ多重起動—dev再起動等—は対象外。）
 * FB02 注記: 手動クリックが実行中の startup run に相乗りした場合、manual の start イベントは
 * 出ない（renderer 側が手動更新操作でローカルにパネルを開いて補完する — SettingsDialog）。
 */
let inflightFetch: Promise<ModelCatalog | null> | null = null

export function fetchModelCatalog(opts: {
  trigger: 'manual' | 'startup'
}): Promise<ModelCatalog | null> {
  if (inflightFetch) return inflightFetch
  inflightFetch = doFetchModelCatalog(opts).finally(() => {
    inflightFetch = null
  })
  return inflightFetch
}

/**
 * R-1三段fallbackの実行本体。P1（公式Doc）→ 失敗時のみP2（env自己申告）→ 両方失敗なら
 * 既存キャッシュ据え置き、の順で await する非同期シェル。決定ロジック自体は
 * selectCatalogOutcome（純関数）に委譲する。
 */
async function doFetchModelCatalog(opts: {
  trigger: 'manual' | 'startup'
}): Promise<ModelCatalog | null> {
  const existing = readCatalogSync()

  const p1 = await runBackstageCc({
    prompt: OFFICIAL_DOCS_PROMPT,
    allowedTools: ['WebFetch', 'WebSearch'],
    source: 'modelCatalog',
    phase: 'P1 official docs',
    trigger: opts.trigger
  })
  const p1Entries = extractEntries(p1)

  let p2Entries: ModelCatalogEntry[] | null = null
  if (!p1Entries) {
    const p2 = await runBackstageCc({
      prompt: ENV_SELFREPORT_PROMPT,
      source: 'modelCatalog',
      phase: 'P2 env self-report',
      trigger: opts.trigger
    })
    p2Entries = extractEntries(p2)
  }

  const outcome = selectCatalogOutcome(p1Entries, p2Entries, existing)
  const result = ((): ModelCatalog | null => {
    if (outcome.kind === 'fresh') {
      const catalog: ModelCatalog = {
        fetchedAt: new Date().toISOString(),
        source: outcome.source,
        models: outcome.models
      }
      try {
        writeCatalogSync(catalog)
      } catch {
        // FB01内部レビュー: キャッシュ書込失敗（ディスク満杯・~/.ccpit 権限異常等）で reject させ
        // ない。取得結果自体は有効なので返す（次回起動は stale 扱いで再取得される）。
      }
      return catalog
    }
    if (outcome.kind === 'existing') return outcome.catalog
    return null
  })()

  // FB02 A2: カタログ更新全体の summary イベント。パネルの「失敗時のみ自動オープン」は
  // run 単位ではなくこの summary で駆動する（P1 失敗→P2 成功の正常系フォールバックで
  // パネルが開いてしまう誤爆を防ぐ）。
  emitBgccActivity({
    runId: randomUUID(),
    source: 'modelCatalog',
    seq: 0,
    ts: new Date().toISOString(),
    phase: 'summary',
    trigger: opts.trigger,
    ...(outcome.kind === 'fresh'
      ? {
          kind: 'result' as const,
          text: `モデルカタログ更新完了（source=${outcome.source}, ${outcome.models.length} models）`,
          meta: { ok: true }
        }
      : outcome.kind === 'existing'
        ? {
            kind: 'error' as const,
            text: 'モデルカタログ更新失敗（P1/P2 とも失敗・既存キャッシュを保持して表示継続）',
            meta: { ok: false }
          }
        : {
            kind: 'error' as const,
            text: 'モデルカタログ更新失敗（キャッシュ無し・静的プリセットのみで継続）',
            meta: { ok: false }
          })
  })

  return result
}

/**
 * FB02 F9: モデルカタログキャッシュの削除（デバッグ・検収用）。model-catalog.json のみを消す
 * （bgcc-logs / app-config.json には触れない）。次回起動時に TTL 切れ扱いで自動再取得される。
 */
export function clearCatalogCache(): { ok: boolean; existed: boolean; error?: string } {
  try {
    if (!existsSync(MODEL_CATALOG_FILE)) return { ok: true, existed: false }
    unlinkSync(MODEL_CATALOG_FILE)
    return { ok: true, existed: true }
  } catch (e) {
    return { ok: false, existed: true, error: e instanceof Error ? e.message : String(e) }
  }
}

/** app起動時トリガ（R-3）。TTL切れの場合のみ fire-and-forget でBG取得する。 */
export function maybeRefreshOnStartup(): void {
  const existing = readCatalogSync()
  if (!isStale(existing)) return
  // FB02: spawn は常時 hidden 化したため backstageCc.hidden の読み取りは不要になった
  //（キーは renderer のパネル自動オープン抑止としてのみ生きる — appConfig.ts 参照）。
  // FB01内部レビュー: fire-and-forget 経路の rejection は unhandledRejection として main の
  // エラーダイアログに化けるため必ず握る（失敗時は三段fallback済み・起動を妨げない）。
  fetchModelCatalog({ trigger: 'startup' }).catch(() => {
    /* best-effort */
  })
}
