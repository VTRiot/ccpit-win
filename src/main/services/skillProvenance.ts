/**
 * skillProvenance — 採用 skill の出自管理 + 緊急避難 override（Part B Phase 1 / 判断H）。
 *
 * 役割:
 * - 採用レジストリ (~/.ccpit/adopted-skills.json): どの skill がユーザー採用由来かを記録。
 *   用途は (a) ケース2 検出（先行 user skill に golden が後から同名配布）と
 *   (b) 緊急避難ライフサイクル判定。**deploy 上書きガードではない**
 *   （同名採用は基本禁止＝採用時バリデーションで弾くため、非同名は deploy additive で元々無傷）。
 * - 緊急避難 override (~/.ccpit/emergency-overrides.json): golden バグ時のみ Doctor Analysis 動線で
 *   許可される「同名一時上書き」のスコープ付きマーカー。skill 名 + golden 版/hash + 理由 + 失効 + Dr 決定 id。
 *
 * Codex レビュー反映:
 * - #2 フェイルクローズ: emergency overrides を確定できない（不在/破損）ときは「有効な override なし」と
 *   みなす＝同名禁止が効く（安全側に倒す）。
 * - #3 スコープ化: override は skill 名・golden 版・失効・Dr 決定 id にスコープ。
 * - #4 版前進で自動失効: currentGoldenVersion が override の対象バグ版を超えたら無効。
 *
 * 本モジュールは Electron Main プロセスのサービス（AI 体制非依存）。
 */

import { readFile, writeFile, mkdir, rename } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { homedir } from 'os'

/** 採用レジストリの 1 エントリ。 */
export interface AdoptedSkillEntry {
  /** skill 名（~/.claude/skills/<name>/SKILL.md の <name>） */
  name: string
  /** 採用時の target 絶対パス */
  target: string
  /** 採用した SKILL.md 本文の sha256（整合確認・ケース2 同一性判定用） */
  hash: string
  /** 採用時刻 ISO 8601 */
  adoptedAt: string
  /** 出自種別 */
  source: 'adopted' | 'emergency'
  /** 採用時点で観測した golden バージョン（あれば。ケース2/失効判定の参考） */
  goldenVersionAtAdoption?: string
}

/** 緊急避難 override マーカー（golden バグ時のみ Dr 動線で生成）。 */
export interface EmergencyOverride {
  /** 上書き対象の golden skill 名 */
  name: string
  /** 対象とする golden の（バグのある）バージョン */
  goldenVersion: string
  /** 対象 golden skill の hash（あれば、より厳密なスコープ） */
  goldenHash?: string
  /** 緊急避難の理由（人間可読） */
  reason: string
  /** 失効時刻 ISO 8601（無ければ時間失効なし。版前進失効は別途） */
  expiresAt?: string
  /** Doctor Analysis の決定 id（生成元の追跡） */
  drDecisionId: string
  /** 生成時刻 ISO 8601 */
  createdAt: string
}

export interface ProvenancePaths {
  /** ~/.ccpit/adopted-skills.json */
  adoptedRegistryPath: string
  /** ~/.ccpit/emergency-overrides.json */
  emergencyOverridesPath: string
}

export function getDefaultProvenancePaths(): ProvenancePaths {
  const dir = join(homedir(), '.ccpit')
  return {
    adoptedRegistryPath: join(dir, 'adopted-skills.json'),
    emergencyOverridesPath: join(dir, 'emergency-overrides.json')
  }
}

/** SKILL.md 本文の sha256 hex。 */
export function hashSkillBody(body: string): string {
  return createHash('sha256').update(body, 'utf-8').digest('hex')
}

/**
 * golden バージョン比較。`a` が `b` より新しいなら正、同じなら 0、古いなら負。
 * `1.4.0` 形式をドット区切りで数値比較。数値化できない区画は文字列比較にフォールバック。
 */
export function compareGoldenVersion(a: string, b: string): number {
  const pa = a.split('.')
  const pb = b.split('.')
  const n = Math.max(pa.length, pb.length)
  for (let i = 0; i < n; i++) {
    const sa = pa[i] ?? '0'
    const sb = pb[i] ?? '0'
    const na = Number(sa)
    const nb = Number(sb)
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      if (na !== nb) return na - nb
    } else {
      const c = sa.localeCompare(sb)
      if (c !== 0) return c
    }
  }
  return 0
}

/**
 * 採用レジストリを読む。不在なら []。
 * **破損時は throw**（呼び出し側＝ケース2 検出がフェイルクローズできるように）。
 */
export async function readAdoptedRegistry(
  paths: ProvenancePaths = getDefaultProvenancePaths()
): Promise<AdoptedSkillEntry[]> {
  if (!existsSync(paths.adoptedRegistryPath)) return []
  const raw = await readFile(paths.adoptedRegistryPath, 'utf-8')
  if (raw.trim() === '') return []
  const parsed = JSON.parse(raw) as unknown // throw on corrupt
  if (!Array.isArray(parsed)) {
    throw new Error('adopted-skills.json is not an array')
  }
  return parsed as AdoptedSkillEntry[]
}

/**
 * 採用レジストリに 1 件 upsert（name キーで置換、無ければ追加）。
 * 採用 apply 成功時に呼ぶ。apply 本体を破損レジストリでブロックしないため、
 * 既存ファイルが破損していたら `.corrupt-<ts>` に退避してから新規作成する（データを黙って失わない）。
 */
export async function upsertAdoptedSkill(
  entry: AdoptedSkillEntry,
  paths: ProvenancePaths = getDefaultProvenancePaths()
): Promise<void> {
  await mkdir(join(paths.adoptedRegistryPath, '..'), { recursive: true })
  let list: AdoptedSkillEntry[] = []
  try {
    list = await readAdoptedRegistry(paths)
  } catch {
    // 破損: 退避して新規開始（黙って消さない）
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    try {
      await rename(paths.adoptedRegistryPath, `${paths.adoptedRegistryPath}.corrupt-${ts}`)
    } catch {
      // 退避失敗時もブロックしない
    }
    list = []
  }
  const next = list.filter((e) => e.name !== entry.name)
  next.push(entry)
  await writeFile(paths.adoptedRegistryPath, JSON.stringify(next, null, 2), 'utf-8')
}

/**
 * 緊急 override を読む。**フェイルクローズ**: 不在・空・破損いずれも [] を返す
 * （「有効な override なし」＝同名禁止が効く安全側）。
 */
export async function readEmergencyOverrides(
  paths: ProvenancePaths = getDefaultProvenancePaths()
): Promise<EmergencyOverride[]> {
  if (!existsSync(paths.emergencyOverridesPath)) return []
  try {
    const raw = await readFile(paths.emergencyOverridesPath, 'utf-8')
    if (raw.trim() === '') return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed as EmergencyOverride[]
  } catch {
    return []
  }
}

/**
 * 指定 skill 名に対する有効な緊急 override が存在するか。
 * - スコープ: name 一致（Codex#3）
 * - 時間失効: expiresAt < now なら無効（Codex#3）
 * - 版前進失効: currentGoldenVersion が override.goldenVersion より新しいなら無効（Codex#4）
 * 判定材料が無い（override 不在）なら false ＝ 同名禁止が効く（フェイルクローズ、Codex#2）。
 */
export function isEmergencyOverrideValid(
  name: string,
  overrides: EmergencyOverride[],
  opts: { now?: string; currentGoldenVersion?: string } = {}
): boolean {
  const now = opts.now ?? new Date().toISOString()
  for (const ov of overrides) {
    if (ov.name !== name) continue
    if (ov.expiresAt && now > ov.expiresAt) continue // 時間失効
    if (
      opts.currentGoldenVersion &&
      compareGoldenVersion(opts.currentGoldenVersion, ov.goldenVersion) > 0
    ) {
      continue // 版前進失効（Codex#4）
    }
    return true
  }
  return false
}

/**
 * 緊急 override を作成（skill 名キーで upsert、1 名 1 件）。Doctor Analysis 動線からのみ呼ぶ想定。
 * 破損ファイルは退避して新規開始（既存 valid を黙って失わない）。`drDecisionId`/`reason` 必須でスコープを担保。
 */
export async function createEmergencyOverride(
  override: EmergencyOverride,
  paths: ProvenancePaths = getDefaultProvenancePaths()
): Promise<void> {
  if (!override.name || !override.drDecisionId || !override.reason || !override.goldenVersion) {
    throw new Error('emergency override requires name, goldenVersion, reason, drDecisionId')
  }
  await mkdir(join(paths.emergencyOverridesPath, '..'), { recursive: true })
  let list: EmergencyOverride[] = []
  if (existsSync(paths.emergencyOverridesPath)) {
    try {
      const raw = await readFile(paths.emergencyOverridesPath, 'utf-8')
      const parsed = raw.trim() === '' ? [] : (JSON.parse(raw) as unknown)
      if (Array.isArray(parsed)) list = parsed as EmergencyOverride[]
      else throw new Error('not array')
    } catch {
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      try {
        await rename(paths.emergencyOverridesPath, `${paths.emergencyOverridesPath}.corrupt-${ts}`)
      } catch {
        /* 退避失敗もブロックしない */
      }
      list = []
    }
  }
  const next = list.filter((o) => o.name !== override.name)
  next.push(override)
  await writeFile(paths.emergencyOverridesPath, JSON.stringify(next, null, 2), 'utf-8')
}

/** 緊急 override を skill 名で削除（golden Fix 後の Dr 削除導線）。 */
export async function removeEmergencyOverride(
  name: string,
  paths: ProvenancePaths = getDefaultProvenancePaths()
): Promise<void> {
  const list = await readEmergencyOverrides(paths)
  const next = list.filter((o) => o.name !== name)
  if (next.length === list.length) return // 無ければ何もしない
  await mkdir(join(paths.emergencyOverridesPath, '..'), { recursive: true })
  await writeFile(paths.emergencyOverridesPath, JSON.stringify(next, null, 2), 'utf-8')
}

/**
 * 陳腐化した override（時間失効 or 版前進失効）を列挙する。
 * Doctor Analysis の「緊急避難版はもう不要 → 削除推奨」判定に使う。
 */
export async function listObsoleteOverrides(
  opts: { now?: string; currentGoldenVersion?: string } = {},
  paths: ProvenancePaths = getDefaultProvenancePaths()
): Promise<EmergencyOverride[]> {
  const list = await readEmergencyOverrides(paths)
  const now = opts.now ?? new Date().toISOString()
  return list.filter((ov) => {
    const expired = !!ov.expiresAt && now > ov.expiresAt
    const advanced =
      !!opts.currentGoldenVersion &&
      compareGoldenVersion(opts.currentGoldenVersion, ov.goldenVersion) > 0
    return expired || advanced
  })
}
