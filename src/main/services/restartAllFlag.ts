/**
 * restartAllFlag — DELEGATE 全体フラグ（settings generation）の writer/reader
 *
 * CCPIT「全 CC 再起動」ボタンが generation を +1 する。各 CC の Stop hook(restart-all-gate.sh) が
 * 「loaded-gen < 現 generation」で自己 exit→resume する。pid↔sessionId 紐付け不要。
 *
 * Codex 反映:
 *  #3 lost-update race → in-process 直列化(promise chain) + atomic write(temp→rename)。
 *     parse 不能(破損)は 1 にリセットせず error を返す（newer file を潰さない）。missing は 0=初回。
 *  #4 Windows rename は同一ディレクトリ temp + リトライ + 失敗 surface。
 */

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'

export function defaultFlagPath(): string {
  return join(homedir(), '.ccpit', '.restart-all.json')
}

type GenRead = { ok: true; gen: number } | { ok: false; error: string }

/** 現 generation を厳密に読む。missing→0(初回)、破損→error(リセットしない)。 */
function readGenStrict(file: string): GenRead {
  if (!existsSync(file)) return { ok: true, gen: 0 }
  let raw: string
  try {
    raw = readFileSync(file, 'utf-8')
  } catch (e) {
    return { ok: false, error: `flag 読込失敗: ${e instanceof Error ? e.message : String(e)}` }
  }
  let j: unknown
  try {
    j = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'flag ファイルが parse 不能（破損）。手動確認が必要' }
  }
  const g = (j as { generation?: unknown })?.generation
  if (typeof g === 'number' && Number.isInteger(g) && g >= 0) return { ok: true, gen: g }
  return { ok: false, error: 'flag の generation フィールドが不正' }
}

/** 同一ディレクトリ temp + rename で atomic 書込（Windows の rename 上書き失敗をリトライ）。 */
function atomicWriteJson(file: string, obj: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp.${process.pid}.${process.hrtime.bigint().toString(36)}`
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf-8')
  try {
    renameSync(tmp, file)
  } catch {
    // Windows: 既存 target があると rename が失敗し得る → unlink してリトライ
    try {
      if (existsSync(file)) unlinkSync(file)
      renameSync(tmp, file)
    } catch (e) {
      // 最終フォールバック: 直接書込（tmp は掃除）
      try {
        writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf-8')
      } finally {
        try {
          if (existsSync(tmp)) unlinkSync(tmp)
        } catch {
          /* best effort */
        }
      }
      void e
    }
  }
}

/** non-strict read（health/表示用）。失敗時は 0。 */
export function readRestartGeneration(file: string = defaultFlagPath()): number {
  const r = readGenStrict(file)
  return r.ok ? r.gen : 0
}

export type BumpResult = { ok: true; generation: number } | { ok: false; error: string }

// in-process 直列化（多重クリック・連打の lost-update を防ぐ。CCPIT は単一インスタンス）。
let chain: Promise<unknown> = Promise.resolve()

/** generation を +1 して atomic 書込。直列化済み。破損/書込失敗は ok:false を返す（surface）。 */
export function bumpRestartGeneration(opts?: { file?: string }): Promise<BumpResult> {
  const file = opts?.file ?? defaultFlagPath()
  const run = (): BumpResult => {
    const r = readGenStrict(file)
    if (!r.ok) return { ok: false, error: r.error }
    const next = r.gen + 1
    try {
      atomicWriteJson(file, { generation: next })
      return { ok: true, generation: next }
    } catch (e) {
      return { ok: false, error: `flag 書込失敗: ${e instanceof Error ? e.message : String(e)}` }
    }
  }
  const p = chain.then(run, run)
  chain = p.then(
    () => undefined,
    () => undefined
  )
  return p
}
