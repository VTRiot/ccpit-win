/**
 * CC固有ID 台帳の読取。戸籍係 hook（cc-identity-register.sh・SessionStart）が
 * ~/.ccpit/.cc-id/<session_id>.json に発番した 16進10桁の ccId を集約する。
 *
 * 書込は hook（bash）が担い、本モジュールは読取専用（electron 非依存・fs/os のみ）。
 * CCES 発行時に project(cwd) 配下の CC の ccId を併記して、Juiz の「自分がどの CC と
 * 紐づくか」の追跡を成立させる（HandOver Vol.2-7 §3-4 指示元自己識別義務と対）。
 * 壊れた/不正レコードは黙って除外する（fail-soft：台帳の一部破損で全体を落とさない）。
 */
import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export interface CcIdentity {
  /** 16進10桁の CC固有ID */
  ccId: string
  /** 発番キー（CC セッションID） */
  sessionId: string
  /** 起動時 cwd（あれば。CCES の project 紐付けに使う） */
  cwd?: string
  /** 発番時刻（ISO 8601・あれば） */
  registeredAt?: string
}

/** 既定の台帳ディレクトリ ~/.ccpit/.cc-id（テストは dir 引数で差し替え可能） */
export function defaultCcIdDir(): string {
  return join(homedir(), '.ccpit', '.cc-id')
}

/** 16進10桁の ccId か（fail-safe 検証） */
function isValidCcId(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{10}$/.test(v)
}

/**
 * cwd を正規化（プラットフォーム非依存）して比較キーにする。`\` と `/` の連続を単一 `/` に畳み、
 * 末尾 `/` を除き、小文字化する。path.normalize は OS 依存（POSIX では `\` が通常文字で吸収されない）
 * ゆえ使わない → 3-OS（MANX / Macau / ASAMA）で slash/backslash 差を不変に吸収する（Codex 2巡目対応）。
 */
function canonCwd(cwd: string): string {
  return cwd.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
}

function parseRecord(path: string): CcIdentity | null {
  try {
    const j = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
    if (!isValidCcId(j.ccId)) return null
    if (typeof j.sessionId !== 'string' || j.sessionId.length === 0) return null
    return {
      ccId: j.ccId,
      sessionId: j.sessionId,
      cwd: typeof j.cwd === 'string' && j.cwd.length > 0 ? j.cwd : undefined,
      registeredAt: typeof j.registeredAt === 'string' ? j.registeredAt : undefined
    }
  } catch {
    return null
  }
}

/** 全 CC固有ID を集約（台帳ビュー）。不正レコードは除外。 */
export function listCcIdentities(dir: string = defaultCcIdDir()): CcIdentity[] {
  if (!existsSync(dir)) return []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: CcIdentity[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const rec = parseRecord(join(dir, name))
    if (rec) out.push(rec)
  }
  return out
}

/** session_id から CC固有ID を引く（未登録 / 不正なら null）。 */
export function lookupCcId(sessionId: string, dir: string = defaultCcIdDir()): CcIdentity | null {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '')
  if (safe.length === 0) return null
  const path = join(dir, `${safe}.json`)
  if (!existsSync(path)) return null
  return parseRecord(path)
}

/** 指定 cwd（projectPath）に登録された CC固有ID を引く（CCES 用・cwd 正規化一致）。 */
export function ccIdentitiesForCwd(cwd: string, dir: string = defaultCcIdDir()): CcIdentity[] {
  if (typeof cwd !== 'string' || cwd.length === 0) return []
  const target = canonCwd(cwd)
  return listCcIdentities(dir).filter((c) => c.cwd != null && canonCwd(c.cwd) === target)
}
