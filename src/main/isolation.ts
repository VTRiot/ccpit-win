import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, parse, resolve, sep, join } from 'node:path'

/**
 * 開発版を「本物のホーム・本物の常駐」から切り離して起動するための、electron 非依存の純関数群。
 * 副作用（環境変数・Electron のパス）は isolateHome.ts だけが、ここの関数を通して行う。
 *
 * 隔離は**明示したときだけ**効く。環境変数が未設定なら何も変えない。
 * 設定済みなのに不正（空・相対・本物のホームや保護根と重なる等）なら、本物のホームへ
 * 黙って落ちずに起動を拒否する（fail-closed）。
 */

export const ISOLATION_ENV_VAR = 'CCPIT_ISOLATED_HOME'
/** launcher が本物のホームを渡す環境変数。書込み関門（realDataWriteGuard.cjs）と共通。 */
export const REAL_HOME_ENV_VAR = 'CCPIT_GUARD_REAL_HOME'
export const ISOLATION_EXIT_CODE = 3
export const ISOLATION_BLOCK_REASON =
  '隔離起動中のため実行しません（本物の Claude Code のセッション・常駐の仕組みに触れないため）'

/**
 * 隔離 root が重なってはならない本物の保護根（ホームからの相対）。
 * 書込み関門 testSetup/realDataWriteGuard.cjs の rootsForRealHome と同じ内容で、
 * 一致は isolation.test.ts が固定する。
 */
export const PROTECTED_ROOT_PARTS: readonly (readonly string[])[] = [
  ['.ccpit'],
  ['.claude'],
  ['.claude.json'],
  ['.config', 'ccpit'],
  ['AppData', 'Roaming', 'ccpit']
]

export type CanonicalizeFn = (p: string) => string

/**
 * 存在する最も近い祖先を実パスへ解決し、残りを連結する（junction・symlink・8.3 名の再解析対策）。
 * scripts/isolation-bootstrap.cjs の realish と同じ手順で、一致は isolation.test.ts が固定する。
 */
export function realish(p: string): string {
  const abs = resolve(p)
  const tail: string[] = []
  let cur = abs
  for (;;) {
    try {
      const real = realpathSync.native(cur)
      return tail.length ? join(real, ...tail.reverse()) : real
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return abs
      tail.push(basename(cur))
      cur = parent
    }
  }
}

export type IsolationPlan =
  | { mode: 'off' }
  | {
      mode: 'on'
      root: string
      env: Record<string, string>
      electronPaths: Record<string, string>
    }
  | { mode: 'refused'; reason: string }

function fold(p: string): string {
  const r = resolve(p)
  return process.platform === 'win32' ? r.toLowerCase() : r
}

function isSameOrUnder(target: string, base: string): boolean {
  const t = fold(target)
  const b = fold(base)
  return t === b || t.startsWith(b.endsWith(sep) ? b : b + sep)
}

function overlaps(a: string, b: string): boolean {
  return isSameOrUnder(a, b) || isSameOrUnder(b, a)
}

export function protectedRootsOf(realHome: string): string[] {
  return PROTECTED_ROOT_PARTS.map((parts) => join(realHome, ...parts))
}

/** 隔離 root 配下に作るホーム系の環境変数（子プロセスにも継承される）。 */
export function isolationEnvTable(root: string): Record<string, string> {
  const parsed = parse(root)
  return {
    USERPROFILE: root,
    HOME: root,
    HOMEDRIVE: parsed.root.replace(/[\\/]$/, ''),
    HOMEPATH: root.slice(parsed.root.length - 1),
    APPDATA: join(root, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(root, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(root, '.config')
  }
}

/** Electron の app.setPath に渡す表。sessionData・logs・crashDumps は userData から派生する既定値を明示する。 */
export function isolationElectronPaths(root: string): Record<string, string> {
  const userData = join(root, 'AppData', 'Roaming', 'ccpit')
  return {
    home: root,
    appData: join(root, 'AppData', 'Roaming'),
    userData,
    sessionData: userData,
    logs: join(userData, 'logs'),
    crashDumps: join(userData, 'Crashpad'),
    desktop: join(root, 'Desktop'),
    documents: join(root, 'Documents'),
    downloads: join(root, 'Downloads')
  }
}

/** 作成しておくディレクトリ（root 自身と、表の各値）。 */
export function isolationDirsToCreate(root: string): string[] {
  const dirs = new Set<string>([root])
  for (const v of Object.values(isolationElectronPaths(root))) dirs.add(v)
  for (const k of ['APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME'])
    dirs.add(isolationEnvTable(root)[k])
  return [...dirs]
}

function segmentProblem(raw: string): string | null {
  // Windows は末尾のドット・空白を黙って削る。別の場所を指しうるので受け付けない
  for (const seg of raw.split(/[\\/]+/)) {
    if (seg.length > 0 && /[. ]$/.test(seg) && seg !== '.' && seg !== '..') {
      return `パスの区切りの末尾がドットまたは空白です（${JSON.stringify(seg)}）`
    }
  }
  return null
}

export interface PlanInput {
  /** 環境変数の値。未設定のときだけ undefined を渡す（空文字は「設定済みで空」＝拒否）。 */
  explicit: string | undefined
  realHome: string
  /** 実パスへの解決（junction・symlink・8.3 名）。既定は resolve のみ。実行時は実パス解決を注入する */
  canonicalize?: CanonicalizeFn
}

export function planIsolation(input: PlanInput): IsolationPlan {
  const { explicit, realHome } = input
  if (explicit === undefined) return { mode: 'off' }
  const canon = input.canonicalize ?? ((p: string): string => resolve(p))

  if (explicit.trim() === '') {
    return {
      mode: 'refused',
      reason: `${ISOLATION_ENV_VAR} が空です（設定するなら絶対パスを入れてください）`
    }
  }
  if (/^\\\\(?!\?\\)/.test(explicit) || /^\/\//.test(explicit)) {
    return { mode: 'refused', reason: 'UNC パスは隔離 root に使えません' }
  }
  const stripped = explicit.replace(/^\\\\\?\\/, '')
  if (!isAbsolute(stripped)) {
    return { mode: 'refused', reason: `絶対パスではありません: ${explicit}` }
  }
  const prob = segmentProblem(stripped)
  if (prob) return { mode: 'refused', reason: prob }

  const root = canon(stripped)
  const home = canon(realHome)
  if (fold(root) === fold(parse(root).root)) {
    return { mode: 'refused', reason: 'ドライブの直下そのものは隔離 root に使えません' }
  }
  if (isSameOrUnder(home, root)) {
    return { mode: 'refused', reason: `本物のホームそのもの、またはその祖先です: ${root}` }
  }
  // 保護根そのものが junction で別の場所を向いている環境に備え、保護根も実パス解決してから比べる
  for (const prot of protectedRootsOf(home).map((p) => canon(p))) {
    if (overlaps(root, prot)) {
      return { mode: 'refused', reason: `本物の保護根と重なります: ${prot}` }
    }
  }
  // 実パス解決の前後どちらかで重なれば拒否する（junction で保護根へ再解析される経路）
  const rawResolved = resolve(stripped)
  for (const prot of protectedRootsOf(realHome)) {
    if (overlaps(rawResolved, prot)) {
      return { mode: 'refused', reason: `本物の保護根と重なります: ${prot}` }
    }
  }
  return {
    mode: 'on',
    root,
    env: isolationEnvTable(root),
    electronPaths: isolationElectronPaths(root)
  }
}

/**
 * 隔離中に Golden 昇格が対象にする golden のリポジトリ（CCPIT_L0_004 W8）。launcher が隔離 root の中に作った複製を指す。
 * 隔離中は、この値だけを使う。cwd・アプリのパスからの通常の探索には落とさない（落ちると本物の CCPIT を動かす）。
 */
export const ISOLATED_GOLDEN_REPO_ENV_VAR = 'CCPIT_ISOLATED_GOLDEN_REPO'

export type IsolatedGoldenRepoVerdict = { ok: true; repo: string } | { ok: false; reason: string }

export interface GoldenRepoCheckDeps {
  canonicalize?: CanonicalizeFn
  /** 存在の確認。試験で差し替える */
  exists: (p: string) => boolean
}

/**
 * 隔離中の golden のリポジトリの値を確かめる純関数。
 * 未設定・空・相対・隔離 root の外（実パス解決の前後どちらでも）・`.git` か `ccpit/golden` が無い、のいずれでも拒否する。
 */
export function checkIsolatedGoldenRepo(
  value: string | undefined,
  root: string,
  deps: GoldenRepoCheckDeps
): IsolatedGoldenRepoVerdict {
  const canon = deps.canonicalize ?? ((p: string): string => resolve(p))
  if (value === undefined) {
    return {
      ok: false,
      reason: `隔離起動中ですが ${ISOLATED_GOLDEN_REPO_ENV_VAR} が未設定です（本物のリポジトリを対象にしないため、golden のリポジトリを使う操作は実行しません）`
    }
  }
  if (value.trim() === '') return { ok: false, reason: `${ISOLATED_GOLDEN_REPO_ENV_VAR} が空です` }
  if (!isAbsolute(value)) return { ok: false, reason: `${ISOLATED_GOLDEN_REPO_ENV_VAR} が絶対パスではありません: ${value}` }
  const repo = canon(value)
  const rootCanon = canon(root)
  // 隔離 root そのものは不可（root の中の下位のフォルダであること）
  if (!isSameOrUnder(repo, rootCanon) || fold(repo) === fold(rootCanon) || !isSameOrUnder(resolve(value), resolve(root))) {
    return { ok: false, reason: `${ISOLATED_GOLDEN_REPO_ENV_VAR} が隔離 root の中ではありません: ${repo}` }
  }
  if (!deps.exists(join(repo, '.git')) || !deps.exists(join(repo, 'ccpit', 'golden'))) {
    return { ok: false, reason: `${ISOLATED_GOLDEN_REPO_ENV_VAR} に .git と ccpit/golden がありません: ${repo}` }
  }
  return { ok: true, repo }
}

export interface IsolationApp {
  setPath(name: string, p: string): void
  getPath(name: string): string
}

export interface ApplyDeps {
  env: NodeJS.ProcessEnv
  app: IsolationApp
  mkdirSync: (p: string, opts: { recursive: true }) => unknown
  homedir: () => string
}

export interface IsolationState {
  active: boolean
  root: string | null
  skipped: string[]
  blocked: string[]
}

let state: IsolationState = { active: false, root: null, skipped: [], blocked: [] }

export function isIsolatedLaunch(): boolean {
  return state.active
}

export function getIsolationStatus(): IsolationState {
  return { ...state, skipped: [...state.skipped], blocked: [...state.blocked] }
}

/** 隔離中に「起動しなかった」自動処理の名前を残す（ログ・報告用）。 */
export function noteSkipped(name: string): void {
  if (!state.skipped.includes(name)) state.skipped.push(name)
}

/** 隔離中に拒否した実行の名前を残す。 */
export function noteBlocked(name: string): void {
  if (!state.blocked.includes(name)) state.blocked.push(name)
}

/** 起動時の常駐の自動処理（モデルカタログ取得・中継復活・Watchdog）を走らせてよいか。隔離中は false。 */
export function shouldRunResidentStartup(): boolean {
  return !state.active
}

/** 試験用。 */
export function resetIsolationForTest(): void {
  state = { active: false, root: null, skipped: [], blocked: [] }
}

/** 試験用。applyIsolation を通さずに状態だけ立てる。 */
export function setIsolatedForTest(root: string): void {
  state = { active: true, root, skipped: [], blocked: [] }
}

/**
 * plan を適用する。off のときは**何も書き換えない**。
 * on のとき: ディレクトリを作り、環境変数と Electron のパスを表どおりに設定し、状態を立てる。
 */
export function applyIsolation(plan: IsolationPlan, deps: ApplyDeps): IsolationState {
  if (plan.mode !== 'on') return getIsolationStatus()
  for (const d of isolationDirsToCreate(plan.root)) deps.mkdirSync(d, { recursive: true })
  for (const [k, v] of Object.entries(plan.env)) deps.env[k] = v
  for (const [k, v] of Object.entries(plan.electronPaths)) deps.app.setPath(k, v)
  state = { active: true, root: plan.root, skipped: [], blocked: [] }
  return getIsolationStatus()
}

/** 適用後の自己検査。不一致の説明を返す（空なら合格）。 */
export function verifyIsolation(
  plan: IsolationPlan,
  deps: Pick<ApplyDeps, 'app' | 'homedir'>
): string[] {
  if (plan.mode !== 'on') return []
  const errs: string[] = []
  const under = (p: string): boolean => isSameOrUnder(p, plan.root)
  const hd = deps.homedir()
  if (!under(hd)) errs.push(`os.homedir() が隔離 root 配下ではありません: ${hd}`)
  for (const [k, expected] of Object.entries(plan.electronPaths)) {
    const actual = deps.app.getPath(k)
    if (!under(actual)) errs.push(`app.getPath('${k}') が隔離 root 配下ではありません: ${actual}`)
    else if (fold(actual) !== fold(expected))
      errs.push(`app.getPath('${k}') が表と違います: ${actual}`)
  }
  return errs
}

/** bootstrap が先に適用済みのとき、製品側の表と食い違っていないかを調べる（二重実装の乖離を実行時に検出）。 */
export function detectPreApplyDrift(plan: IsolationPlan, deps: Pick<ApplyDeps, 'app'>): string[] {
  if (plan.mode !== 'on') return []
  const errs: string[] = []
  for (const [k, expected] of Object.entries(plan.electronPaths)) {
    const actual = deps.app.getPath(k)
    if (fold(actual) !== fold(expected))
      errs.push(`bootstrap の ${k} が製品側の表と違います: ${actual}`)
  }
  return errs
}
