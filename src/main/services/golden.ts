import { readdir, readFile, copyFile, mkdir, writeFile, chmod, rm } from 'fs/promises'
import { join, relative } from 'path'
import { existsSync } from 'fs'
import { app } from 'electron'
import { getConfig, setConfig, getParcFermeDir } from './appConfig'
import { KNOWN_TEMPLATES, resolveExpectedDeny } from './denyValidation'
import { resolveBashBin } from './bashResolver'
import {
  buildManifest,
  getManifestPath,
  hashFileAt,
  hashSourceMap,
  normalizeRelPath,
  makeBackupPath,
  pruneBackups,
  stripBackupExecBit,
  toGoldenBytes,
  writeManifest
} from './goldenManifest'
import { readOverlayIndex, resolveOverlay, type OverlayResolution } from './goldenOverlay'
import { randomBytes, timingSafeEqual } from 'crypto'
import { writeFileAtomic } from './atomicFile'
import {
  composeSettings,
  computeApprovalToken,
  parseRecord,
  renderLayersMarkdown,
  SETTINGS_LAYERS_LIST_FILENAME,
  SETTINGS_LAYERS_RECORD_FILENAME,
  type SettingsLayerRecord,
  type SettingsLayersPreview,
  type SettingsLayersPreviewResult
} from './settingsLayers'
import { readBytesOrNull, readLocalSettingsBytes } from './settingsLayersIo'

const GOLDEN_DIR = app.isPackaged
  ? join(process.resourcesPath, 'golden')
  : join(__dirname, '../../golden')

// PIKES r1 §4-3 + 提案 3 (CCPIT v1.1 Phase E-4): deny マージ用 SSoT ファイル名
const DENY_BASE_FILENAME = 'settings.deny-base.json'
const DENY_EXTRA_FILENAME = 'settings.deny-extra.json'

/** common/ 配下の言語依存ディレクトリを返す（app-config.language に従う） */
export function getCommonLangDir(): string {
  const lang = getConfig().language
  return join(GOLDEN_DIR, 'common', lang)
}

/**
 * golden の en 側（common/en/）の物理パス。`rel` は配置先ルート相対（`skills/<name>/<相対パス>`）。
 * 提案が `en:` 見出しで運ぶファイルの現行値を読むために使う（app-config.language には依らない）。
 */
export function getGoldenEnPath(rel: string): string {
  return join(GOLDEN_DIR, 'common', 'en', ...rel.replace(/\\/g, '/').split('/'))
}

/** common/hooks（言語非依存） */
export function getCommonHooksDir(): string {
  return join(GOLDEN_DIR, 'common', 'hooks')
}

/**
 * common/scripts（言語非依存・node 起動の配布スクリプト → ~/.claude/scripts/）。
 * hooks/ と違い settings.json から自動発火せず、skill 本文が `node ~/.claude/scripts/<name>.cjs` で
 * 明示起動する道具（例: レビュー台帳の正規書込経路）。exec ビットは不要。
 */
export function getCommonScriptsDir(): string {
  return join(GOLDEN_DIR, 'common', 'scripts')
}

/**
 * PIKES r1 (Phase E-4): settings.deny-base.json / settings.deny-extra.json は
 * deploy 時に deny 配列にマージされる「素材ファイル」であり、~/.claude/ 直配置は不要。
 * mergedFiles / previewDeploy の対象から除外する。
 */
function isDenySourceFile(relPath: string): boolean {
  const basename = relPath.split(/[\\/]/).pop() ?? ''
  return basename === DENY_BASE_FILENAME || basename === DENY_EXTRA_FILENAME
}

/** 再帰的にディレクトリ内の全ファイルパスを取得 */
async function walkDir(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const paths: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      paths.push(...(await walkDir(full)))
    } else {
      paths.push(full)
    }
  }
  return paths
}

/** 再帰的にサブディレクトリの相対パスを収集 */
async function walkDirs(dir: string, base: string): Promise<string[]> {
  if (!existsSync(dir)) return []
  const entries = await readdir(dir, { withFileTypes: true })
  const dirs: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const full = join(dir, entry.name)
      const rel = relative(base, full)
      dirs.push(rel)
      dirs.push(...(await walkDirs(full, base)))
    }
  }
  return dirs
}

/** 利用可能なテンプレート一覧を返す */
export async function listTemplates(): Promise<string[]> {
  const entries = await readdir(GOLDEN_DIR, { withFileTypes: true })
  return entries
    .filter((e) => e.isDirectory() && e.name !== 'common')
    .map((e) => e.name)
}

/**
 * golden が配布する全 skill 名（重複排除）。判断H の同名採用ガード用。
 * GOLDEN_DIR 配下の skills/<name>/SKILL.md（各階層）から <name> を集める
 * （common/{lang}/skills/... とテンプレート/skills/... の和集合。保守的に「golden が出しうる名前」全部）。
 */
export async function listGoldenSkillNames(): Promise<string[]> {
  if (!existsSync(GOLDEN_DIR)) return []
  const names = new Set<string>()
  for (const f of await walkDir(GOLDEN_DIR)) {
    const norm = f.replace(/\\/g, '/')
    const m = norm.match(/\/skills\/([^/]+)\/SKILL\.md$/i)
    if (m) names.add(m[1])
  }
  return [...names]
}

/** common/{lang} + common/hooks + common/scripts + 指定テンプレートをマージした展開プレビューを返す */
export async function previewDeploy(
  templateName: string
): Promise<{ relativePath: string; source: 'common' | string }[]> {
  const commonLangDir = getCommonLangDir()
  const commonHooksDir = getCommonHooksDir()
  const commonScriptsDir = getCommonScriptsDir()
  const templateDir = join(GOLDEN_DIR, templateName)
  const result: { relativePath: string; source: 'common' | string }[] = []
  const seen = new Set<string>()

  // テンプレート優先（同名ファイルは common を上書き）
  if (existsSync(templateDir)) {
    const files = await walkDir(templateDir)
    for (const f of files) {
      const rel = relative(templateDir, f)
      if (rel.endsWith('.gitkeep')) continue
      if (isDenySourceFile(rel)) continue // Phase E-4: deny マージ素材は配置対象外
      seen.add(rel)
      result.push({ relativePath: rel, source: templateName })
    }
  }

  // 言語依存ファイル（common/{lang}/ 配下を common 相対として扱う）
  if (existsSync(commonLangDir)) {
    const files = await walkDir(commonLangDir)
    for (const f of files) {
      const rel = relative(commonLangDir, f)
      if (rel.endsWith('.gitkeep')) continue
      if (isDenySourceFile(rel)) continue // Phase E-4
      if (seen.has(rel)) continue
      seen.add(rel)
      result.push({ relativePath: rel, source: 'common' })
    }
  }

  // 言語非依存の hooks（common/hooks/*.sh → hooks/*.sh）
  if (existsSync(commonHooksDir)) {
    const files = await walkDir(commonHooksDir)
    for (const f of files) {
      const rel = join('hooks', relative(commonHooksDir, f))
      if (rel.endsWith('.gitkeep')) continue
      if (seen.has(rel)) continue
      seen.add(rel)
      result.push({ relativePath: rel, source: 'common' })
    }
  }

  // 言語非依存の配布スクリプト（common/scripts/*.cjs → scripts/*.cjs）
  if (existsSync(commonScriptsDir)) {
    const files = await walkDir(commonScriptsDir)
    for (const f of files) {
      const rel = join('scripts', relative(commonScriptsDir, f))
      if (rel.endsWith('.gitkeep')) continue
      if (seen.has(rel)) continue
      seen.add(rel)
      result.push({ relativePath: rel, source: 'common' })
    }
  }

  // .gitkeep のみのディレクトリ（rules/, skills/ 等）もプレビューに含める
  const dirsSeen = new Set<string>()
  const dirSources: [string, 'common' | string][] = [
    [templateDir, templateName],
    [commonLangDir, 'common'],
  ]
  for (const [src, label] of dirSources) {
    if (!existsSync(src)) continue
    for (const rel of await walkDirs(src, src)) {
      if (dirsSeen.has(rel)) continue
      dirsSeen.add(rel)
      result.push({ relativePath: rel + '/', source: label })
    }
  }
  // hooks ディレクトリ自体
  if (existsSync(commonHooksDir) && !dirsSeen.has('hooks')) {
    dirsSeen.add('hooks')
    result.push({ relativePath: 'hooks/', source: 'common' })
  }
  // scripts ディレクトリ自体
  if (existsSync(commonScriptsDir) && !dirsSeen.has('scripts')) {
    dirsSeen.add('scripts')
    result.push({ relativePath: 'scripts/', source: 'common' })
  }

  // ADR 0002: 逆向き反映が有効な rel は、実際に配られる供給元が overlay になる。
  // ここを黙っていると「同梱の内容が配られる」と読めるプレビューになり、実配置と食い違う
  // （プレビューが嘘をつく）。走査そのものは上の 3 ルートのままで、供給元表示だけ差し替える。
  const { active } = await resolveGoldenFiles(templateName)
  if (active.length > 0) {
    const overlaid = new Set(active)
    for (const row of result) {
      if (overlaid.has(normalizeRelPath(row.relativePath))) row.source = 'overlay'
    }
  }

  return result
}

/**
 * 同梱 golden（overlay を重ねる**前**）を `relativePath → sourceAbsPath` で返す。
 *
 * マージ順: `common/{lang}` → `common/hooks` → `common/scripts` → template（template が上書き）。
 *
 * `deploy()` と起動時照合（`runStartupReconcile`）の**両方がこの 1 箇所を使う**。
 * 集合がずれると「配置したのに照合対象外」「照合するのに配置されない」が生まれ、
 * manifest の記録と実体が静かに乖離するため、構築ロジックを二重化しない。
 *
 * ADR 0002: 逆向き反映（overlay）はこの結果に**後段で重ねる**（`collectGoldenFiles`）。
 * 重ねる前の集合をここから取れることが overlay の失効判定に要る
 * — 重ねた後の値と突き合わせても常に自分自身と一致して失効しなくなるため。
 */
export async function collectBundledGoldenFiles(
  templateName: string
): Promise<Map<string, string>> {
  const commonLangDir = getCommonLangDir()
  const commonHooksDir = getCommonHooksDir()
  const commonScriptsDir = getCommonScriptsDir()
  const templateDir = join(GOLDEN_DIR, templateName)

  const mergedFiles = new Map<string, string>() // relativePath → sourceAbsPath

  if (existsSync(commonLangDir)) {
    for (const f of await walkDir(commonLangDir)) {
      const rel = relative(commonLangDir, f)
      if (rel.endsWith('.gitkeep')) continue
      if (isDenySourceFile(rel)) continue // Phase E-4: deny マージ素材は配置対象外
      mergedFiles.set(rel, f)
    }
  }

  if (existsSync(commonHooksDir)) {
    for (const f of await walkDir(commonHooksDir)) {
      const rel = join('hooks', relative(commonHooksDir, f))
      if (rel.endsWith('.gitkeep')) continue
      mergedFiles.set(rel, f)
    }
  }

  if (existsSync(commonScriptsDir)) {
    for (const f of await walkDir(commonScriptsDir)) {
      const rel = join('scripts', relative(commonScriptsDir, f))
      if (rel.endsWith('.gitkeep')) continue
      mergedFiles.set(rel, f)
    }
  }

  if (existsSync(templateDir)) {
    for (const f of await walkDir(templateDir)) {
      const rel = relative(templateDir, f)
      if (rel.endsWith('.gitkeep')) continue
      if (isDenySourceFile(rel)) continue // Phase E-4
      mergedFiles.set(rel, f)
    }
  }

  return mergedFiles
}

/**
 * 配置対象の golden を `relativePath → sourceAbsPath` で返す（**overlay 適用後**）。
 *
 * `collectBundledGoldenFiles()` の結果に、ユーザーが逆向き反映した内容（ADR 0002）を重ねる。
 * `deploy()` と起動時照合の両方がこの 1 箇所を使う、という従来の不変条件はそのまま
 * — 構築は依然 `collectBundledGoldenFiles` の 1 箇所で、ここは純関数 `resolveOverlay` の合成段。
 *
 * 重ねる条件（置換専用・上流優先・実体検証）は `goldenOverlay.resolveOverlay` を参照。
 */
export async function collectGoldenFiles(templateName: string): Promise<Map<string, string>> {
  return (await resolveGoldenFiles(templateName)).merged
}

/**
 * `collectGoldenFiles` と同じ合成を、overlay の内訳付きで返す。
 *
 * 起動時照合は「失効した overlay の rel」を知る必要がある
 * （無確認適用から外すため。ADR 0002 の二重防御その 2）。
 */
export async function resolveGoldenFiles(templateName: string): Promise<OverlayResolution> {
  const bundled = await collectBundledGoldenFiles(templateName)
  const parcFermeDir = getParcFermeDir()
  const index = await readOverlayIndex(parcFermeDir)
  return resolveOverlay(bundled, index, parcFermeDir)
}

export interface DeployResult {
  deployed: string[]
  backedUp: string[]
  errors: string[]
}

// ---------------------------------------------------------------------------
// settings.json の 2 階建て（L0_013）: 下見と本番が同じ planSettingsDeploy() を呼ぶ

/** 承認の印の鍵。プロセス起動ごとの乱数で、プロセスの外へ出さない・保存しない（RFC 2104: 出力長 32 バイト以上） */
const SETTINGS_APPROVAL_KEY = randomBytes(32)
/** プロセス内で配り直しを同時に 2 つ走らせない */
let deployInFlight = false

/** 書く直前の読み直しで手元が変わっていたとき（何も書かずに拒否する） */
class SettingsChangedError extends Error {}

interface SettingsPlan {
  settingsPath: string
  recordPath: string
  listPath: string
  localBytes: Buffer | null
  composed: Record<string, unknown>
  preview: SettingsLayersPreview
  nextRecord: Omit<SettingsLayerRecord, 'recordedAt'>
  approvalToken: string
}

type SettingsPlanResult = { kind: 'none' } | { kind: 'abort'; reason: string } | ({ kind: 'plan' } & SettingsPlan)

export function getSettingsLayersRecordPath(parcFermeDir: string): string {
  return join(parcFermeDir, SETTINGS_LAYERS_RECORD_FILENAME)
}

async function planSettingsDeploy(
  templateName: string,
  bashPath: string,
  expectedDeny: string[],
  mergedFiles: Map<string, string>
): Promise<SettingsPlanResult> {
  const srcPath = mergedFiles.get('settings.json')
  if (!srcPath) return { kind: 'none' }
  const settingsPath = join(app.getPath('home'), '.claude', 'settings.json')
  const parcFermeDir = getParcFermeDir()
  const recordPath = getSettingsLayersRecordPath(parcFermeDir)
  const listPath = join(parcFermeDir, SETTINGS_LAYERS_LIST_FILENAME)
  const templateBytes = await readFile(srcPath)
  const localBytes = await readLocalSettingsBytes(settingsPath)
  const recordBytes = await readBytesOrNull(recordPath)
  const result = composeSettings({
    templateName,
    localBytes,
    templateText: templateBytes.toString('utf-8'),
    expectedDeny,
    record: parseRecord(recordBytes, templateName),
    bashPath,
    home: app.getPath('home')
  })
  if (!result.ok) return { kind: 'abort', reason: result.abortReason }
  const approvalToken = computeApprovalToken(SETTINGS_APPROVAL_KEY, {
    templateName,
    localBytes,
    recordBytes,
    templateBytes,
    expectedDeny,
    approvalItems: result.preview.approvalItems,
    bashPath,
    settingsPath,
    recordPath,
    composed: result.composed
  })
  return {
    kind: 'plan',
    settingsPath,
    recordPath,
    listPath,
    localBytes,
    composed: result.composed,
    preview: result.preview,
    nextRecord: result.nextRecord,
    approvalToken
  }
}

function tokenMatches(given: string | undefined, expected: string): boolean {
  if (typeof given !== 'string') return false
  const a = Buffer.from(given, 'utf-8')
  const b = Buffer.from(expected, 'utf-8')
  return a.length === b.length && timingSafeEqual(a, b)
}

function sameBytes(a: Buffer | null, b: Buffer | null): boolean {
  if (a === null || b === null) return a === b
  return a.equals(b)
}

/** 配り直しの下見（settings.json の層ごとの差と承認が要る項目）。何も書かない */
export async function previewSettingsLayers(templateName: string): Promise<SettingsLayersPreviewResult> {
  if (!(KNOWN_TEMPLATES as readonly string[]).includes(templateName)) {
    return { preview: null, errors: [`未知の template '${templateName}'`] }
  }
  const expectedDeny = resolveExpectedDeny(GOLDEN_DIR, templateName)
  if (!expectedDeny.ok) {
    return { preview: null, errors: [`golden deny 期待リスト解決失敗（${expectedDeny.error}）`] }
  }
  const bash = resolveBashBin()
  if (!bash.path) return { preview: null, errors: ['bash.exe を解決できない'] }
  try {
    const plan = await planSettingsDeploy(
      templateName,
      bash.path,
      expectedDeny.expected,
      await collectGoldenFiles(templateName)
    )
    if (plan.kind === 'none') return { preview: null, errors: [] }
    if (plan.kind === 'abort') return { preview: null, errors: [`配り直しを中止する: ${plan.reason}`] }
    return {
      preview: plan.preview,
      approvalToken: plan.preview.approvalItems.length > 0 ? plan.approvalToken : undefined,
      errors: []
    }
  } catch (err) {
    return { preview: null, errors: [`settings.json の下見に失敗: ${err instanceof Error ? err.message : String(err)}`] }
  }
}

export interface DeployOptions {
  /** 下見が返した承認の印。(ii) があるとき、これが今の計画の印と一致しなければ何も書かない */
  settingsApproval?: string
}

/** Golden テンプレートを ~/.claude/ に展開する */
export async function deploy(
  templateName: string,
  password: string,
  opts: DeployOptions = {}
): Promise<DeployResult> {
  if (deployInFlight) {
    return { deployed: [], backedUp: [], errors: ['配り直しが既に実行中のため受け付けない'] }
  }
  deployInFlight = true
  try {
    return await deployUnlocked(templateName, password, opts)
  } finally {
    deployInFlight = false
  }
}

async function deployUnlocked(
  templateName: string,
  password: string,
  opts: DeployOptions
): Promise<DeployResult> {
  // Marshal F4: 未知 template を書込/永続化前に reject（health coverage の fail-closed 前提）。
  if (!(KNOWN_TEMPLATES as readonly string[]).includes(templateName)) {
    return {
      deployed: [],
      backedUp: [],
      errors: [`未知の template '${templateName}'（許可: ${KNOWN_TEMPLATES.join('/')}）`]
    }
  }
  // Marshal F5: golden の期待 deny を「書込前」に fail-closed 解決する。base/extra が欠落/parse
  // 不能なら backup/write/config 永続化を一切せず deploy を中止（deny 無しの settings.json を
  // 書く fail-open を防ぐ）。health の事後検証と同じ resolveExpectedDeny を共有。
  const expectedDeny = resolveExpectedDeny(GOLDEN_DIR, templateName)
  if (!expectedDeny.ok) {
    return {
      deployed: [],
      backedUp: [],
      errors: [`golden deny 期待リスト解決失敗で deploy 中止（${expectedDeny.error}）`]
    }
  }
  const userHome = app.getPath('home')
  // 起動形 order: hook は exec form（command:"bash"）で配備し、deploy 時に bash 実体パスを注入して
  // 端末 Windows CC でも確実に発火させる（46fc171 Phase 0 V1 実機実証）。解決不能なら fail-closed で
  // deploy 中止 — 壊れた security hook（settings-guard 等）を出さないため（bare `.sh` は不発、bare
  // `bash` は「Git Bash not found」で失敗し、full-path bash.exe の exec form のみ確実に発火する）。
  const bash = resolveBashBin()
  if (!bash.path) {
    return {
      deployed: [],
      backedUp: [],
      errors: [
        'bash.exe を解決できず deploy 中止（hook の exec form 起動に必須。Git for Windows もしくは scoop git をインストールせよ）'
      ]
    }
  }
  const targetDir = join(userHome, '.claude')
  const commonLangDir = getCommonLangDir()
  const commonHooksDir = getCommonHooksDir()
  const commonScriptsDir = getCommonScriptsDir()
  const templateDir = join(GOLDEN_DIR, templateName)

  const result: DeployResult = { deployed: [], backedUp: [], errors: [] }

  // マージ順: common/{lang} → common/hooks → common/scripts → template（template が上書き）
  // 集合の定義は collectGoldenFiles() が単一の出所（起動時照合と共有する）
  const mergedFiles = await collectGoldenFiles(templateName)

  // 1回の deploy = 1世代。退避パスの時刻を配置全体で共有し、世代の境目をファイル間で揃える。
  const deployAt = new Date()
  // 書けたファイルの「書いた直後の読み戻し指紋」（台帳の postHash）。書けなかった行は載らない
  const postHashes = new Map<string, string>()

  // settings.json は 2 階建ての合成（L0_013）。手元の層を外す・書き換える項目 (ii) があれば、下見の印と一致しない限り
  // 何も書かない（.bak・配置・setConfig・manifest・記録のどれも動かさない）。承認の判定と書く直前の読み直しを
  // ほかのファイルを書く前に済ませるため、settings.json を最初に書く。
  let plan: SettingsPlanResult
  try {
    plan = await planSettingsDeploy(templateName, bash.path, expectedDeny.expected, mergedFiles)
  } catch (err) {
    return {
      deployed: [],
      backedUp: [],
      errors: [`settings.json の計画に失敗し配り直しを中止（${err instanceof Error ? err.message : String(err)}）`]
    }
  }
  if (plan.kind === 'abort') {
    return { deployed: [], backedUp: [], errors: [`配り直しを中止する: ${plan.reason}`] }
  }
  if (plan.kind === 'plan' && plan.preview.approvalItems.length > 0) {
    if (!tokenMatches(opts.settingsApproval, plan.approvalToken)) {
      return {
        deployed: [],
        backedUp: [],
        errors: [
          `settings.json の手元の層を外す・書き換える項目が ${plan.preview.approvalItems.length} 件あり、この下見に結び付いた承認が無いため書かない（下見をやり直して承認する）`
        ]
      }
    }
  }
  if (plan.kind === 'plan') {
    const p = plan
    const toWrite: Record<string, unknown> = JSON.parse(JSON.stringify(p.composed))
    if (p.preview.passwordReplaced && toWrite.auth && typeof toWrite.auth === 'object') {
      ;(toWrite.auth as Record<string, unknown>).password = password
    }
    // .bak は計画のときに読んだバイトから先に書き、書く直前の読み直しで同じと確かめた直後に置換する
    // （比較と置換の間に挟まる処理を無くし、割り込みの窓を最小にする。CC やエディタはロックを取らないので
    // 排他ロックでは塞げない。残る窓は報告書の残る危険に書く）。違っていたら .bak も消して何も残さない。
    const bakPath = p.localBytes !== null ? makeBackupPath(p.settingsPath, deployAt) : null
    let bakCreated = false
    try {
      if (bakPath !== null) {
        await writeFile(bakPath, p.localBytes as Buffer, { flag: 'wx' }) // 既存の .bak は上書きしない
        bakCreated = true
        await stripBackupExecBit(bakPath)
      }
      await writeFileAtomic(p.settingsPath, JSON.stringify(toWrite, null, 2), {
        beforeRename: async () => {
          const now = await readLocalSettingsBytes(p.settingsPath)
          if (!sameBytes(now, p.localBytes)) throw new SettingsChangedError()
        }
      })
    } catch (err) {
      // settings.json を置き換えられなかったら、ほかのファイル・setConfig・manifest・記録のどれも動かさずに返す
      // （settings.json だけ旧版のまま他が配られ「golden 配備済み」と記録される半端な状態を作らない）。
      // この配り直しで作った .bak だけを消す（既にあった .bak には触らない）。消せなければそのパスを知らせる。
      const errors = [
        err instanceof SettingsChangedError
          ? '下見の後に手元の settings.json が変わったため何も書かない（下見をやり直す）'
          : `settings.json を書けなかったため配り直しを中止する（ほかのファイルも配らない）: ${err instanceof Error ? err.message : String(err)}`
      ]
      if (bakCreated && bakPath !== null) {
        try {
          await rm(bakPath, { force: true })
        } catch (rmErr) {
          errors.push(
            `この配り直しで作った退避 ${bakPath} を消せなかった（手で消してよい。中身は配り直し前の settings.json）: ${rmErr instanceof Error ? rmErr.message : String(rmErr)}`
          )
        }
      }
      return { deployed: [], backedUp: [], errors }
    }
    result.deployed.push('settings.json')
    if (bakPath !== null) {
      result.backedUp.push(bakPath)
      await pruneBackups(p.settingsPath)
    }
    const recordedAt = deployAt.toISOString()
    try {
      const record: SettingsLayerRecord = { ...p.nextRecord, recordedAt }
      await writeFileAtomic(p.recordPath, JSON.stringify(record, null, 2))
      await writeFileAtomic(p.listPath, renderLayersMarkdown(p.preview, recordedAt))
    } catch (err) {
      result.errors.push(
        `settings.json の層の記録を書けなかった（次の配り直しは古い記録で判定され、承認の側に倒れる）: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  for (const [rel, srcPath] of mergedFiles) {
    if (rel === 'settings.json') continue // 上で合成して書いた
    const destPath = join(targetDir, rel)
    const destDir = join(destPath, '..')

    try {
      await mkdir(destDir, { recursive: true })

      // 既存ファイルのバックアップ（§9.8 / D2: 退避形式を goldenManifest 側へ一本化する）。
      // 退避パスの命名は従来と同形式のまま、実行ビット除去と世代刈り込みが付く。
      if (existsSync(destPath)) {
        const bakPath = makeBackupPath(destPath, deployAt)
        await copyFile(destPath, bakPath)
        await stripBackupExecBit(bakPath)
        await pruneBackups(destPath)
        result.backedUp.push(bakPath)
      }

      // settings.json は上で 2 階建ての合成（password 注入・deny の union・bash 実体の注入を含む）として書いた。
      // 配るのは git に記録された版と同じ改行（テキストは LF）。作業ツリーが autocrlf で CRLF になっていても
      // 配置先へ CRLF を持ち込まない。変える必要が無いファイルは従来どおり複写する（モードも保つ）。
      const sourceBytes = await readFile(srcPath)
      const payload = toGoldenBytes(rel, sourceBytes)
      if (payload === sourceBytes) {
        await copyFile(srcPath, destPath)
      } else {
        await writeFile(destPath, payload)
      }
      // 書いた直後に読み戻した指紋。読み戻せなかったファイルは載せない（不明）
      const postHash = await hashFileAt(destPath)
      if (postHash !== null) postHashes.set(normalizeRelPath(rel), postHash)

      // hooks/*.sh は実行権限を付与（MANX hooks Phase 1）。scripts/*.cjs は node 明示起動ゆえ付与しない。
      const relNorm = rel.replace(/\\/g, '/')
      if (relNorm.startsWith('hooks/') && relNorm.endsWith('.sh')) {
        await chmod(destPath, 0o755)
      }

      result.deployed.push(rel)
    } catch (err) {
      result.errors.push(`${rel}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // .gitkeep のみのディレクトリ（rules/, skills/ 等）も作成
  const dirsToCreate = new Set<string>()
  for (const src of [commonLangDir, templateDir]) {
    if (existsSync(src)) {
      for (const rel of await walkDirs(src, src)) {
        dirsToCreate.add(rel)
      }
    }
  }
  if (existsSync(commonHooksDir)) {
    dirsToCreate.add('hooks')
  }
  if (existsSync(commonScriptsDir)) {
    dirsToCreate.add('scripts')
  }
  for (const rel of dirsToCreate) {
    const destDir = join(targetDir, rel)
    if (!existsSync(destDir)) {
      await mkdir(destDir, { recursive: true })
      result.deployed.push(rel + '/')
    }
  }

  // Fresh Start 完了 — deploySource を 'golden' に固定し pitReference をクリア。
  // deployedTemplate を記録（Marshal F2: health coverage が実デプロイ template の deny を検証するため）。
  setConfig({ deploySource: 'golden', pitReference: undefined, deployedTemplate: templateName })

  // §9 配線 P0: 配置した内容の manifest を記録する。次回起動の三方向照合はこれを G_old として使う。
  // 配置自体は既に完了しているので manifest 生成の失敗で deploy を失敗扱いにはしないが、
  // silent success にもしない — errors に積んで可視化する（記録漏れは次回照合の誤判定に直結する）。
  try {
    const { map: goldenHashes, unreadable } = await hashSourceMap(mergedFiles)
    if (unreadable.length > 0) {
      result.errors.push(
        `manifest: golden 同梱物をハッシュできず記録から漏れた（${unreadable.length}件: ${unreadable.slice(0, 5).join(', ')}）`
      )
    }
    // exec ビットは配置時に chmod した集合と同一（hooks/*.sh）。
    const execPaths = new Set(
      [...goldenHashes.keys()].filter((p) => p.startsWith('hooks/') && p.endsWith('.sh'))
    )
    const manifest = buildManifest({ template: templateName, goldenHashes, execPaths, postHashes })
    await writeManifest(getManifestPath(getParcFermeDir()), manifest)
  } catch (err) {
    result.errors.push(`manifest 記録失敗: ${err instanceof Error ? err.message : String(err)}`)
  }

  return result
}

/** ~/.claude/settings.json の存在確認 */
export async function checkExisting(): Promise<{
  exists: boolean
  hasSettings: boolean
  hasClaude: boolean
}> {
  const userHome = app.getPath('home')
  const claudeDir = join(userHome, '.claude')
  const settingsPath = join(claudeDir, 'settings.json')
  const claudeMdPath = join(claudeDir, 'CLAUDE.md')

  return {
    exists: existsSync(claudeDir),
    hasSettings: existsSync(settingsPath),
    hasClaude: existsSync(claudeMdPath),
  }
}

/**
 * 同梱 golden のルート（CCPIT_064: 相談パケットに「配布元がどこか」を書くため）。
 * dev ではリポジトリの `ccpit/golden`（＝配布正本そのもの）、packaged では `resourcesPath/golden`。
 */
export function getGoldenDir(): string {
  return GOLDEN_DIR
}
