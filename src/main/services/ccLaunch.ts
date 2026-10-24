import { spawn } from 'child_process'
import { existsSync, lstatSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join, normalize } from 'path'
import { ISOLATION_BLOCK_REASON, isIsolatedLaunch, noteBlocked } from '../isolation'

/** wt 経路の launch 用 temp .ps1 の接頭辞と TTL（FB①: これより古いものを best-effort 掃除）。 */
const LAUNCH_SCRIPT_PREFIX = 'ccpit-launch-'
const LAUNCH_SCRIPT_TTL_MS = 6 * 60 * 60 * 1000 // 6h

function getPathDirs(): string[] {
  const env = process.env.PATH || process.env.Path || ''
  const sep = process.platform === 'win32' ? ';' : ':'
  return env.split(sep).filter(Boolean)
}

export function whichExe(name: string): string | null {
  const dirs = getPathDirs()
  for (const dir of dirs) {
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
    // 037 Phase 2-C: WindowsApps "App Execution Alias" は reparse point (symlink) で
    // existsSync が false を返す（内部 stat が EACCES を発生させる）。lstat で symlink
    // 判定して救済する。これがないと wt.exe を検出できず powershell.exe フォールバックに
    // 落ち、Electron GUI app からの spawn で新規ウィンドウが生成されない。
    try {
      const st = lstatSync(candidate)
      if (st.isSymbolicLink()) return candidate
    } catch {
      /* not present, try next dir */
    }
  }
  return null
}

/**
 * cc:launch の pxpipe 経路指定（038 Feature A/B）。
 * - auto : per-project pxpipeEnabled トグルに従う（既定・従来挙動）
 * - force: 常に pxpipe 経由（Fable ボタン・三瀬谷特別行の Plug ON。projects.json 未登録
 *          パスは getPxpipeEnabled が常に false を返すため auto では拾えない）
 * - off  : 常に素起動（特別行の Plug OFF）
 */
export type PxpipeMode = 'auto' | 'force' | 'off'

export interface LaunchArgs {
  projectPath: string
  flags: string[]
  /**
   * 指定時、`claude --resume <sessionId>` で既存セッションを resume 起動する
   * （exit→resume の resume 側）。
   * resume は settings/hooks/skills/plugins をリロードするため設定反映の正攻法。
   */
  resumeSessionId?: string
  /**
   * 042: renderer が `-r` を出す根拠（値と所有 PJ）。主プロセスは「証明の無い / 起動先 PJ と
   * 一致しない `-r`」を strip する（stripUnprovenResume）。renderer 側の判定
   * （launchOptions.shouldEmitResume）と二層で守る。
   */
  resumeBinding?: { value: string; projectPath: string }
  /**
   * 038 Feature B / FB①: 端末の背景色（例 '#160b2e'）。OSC 11 エスケープで設定する
   * （launch-ccpit-misetani.ps1 と同一機構＝実績あり）。当初 `wt --tabColor` を想定したが、
   * FB① 実測で wt が commandline 中の `;`（pxpipe 注入由来）をタブ区切りに分割し起動失敗する
   * ことが判明したため、色は powershell コマンド側の OSC 11 に統一した（wt/ps 両経路で有効。
   * OSC 11 は legacy conhost では no-op）。
   */
  tabColor?: string
}

export interface LaunchResult {
  shell: string
  spawned: boolean
  error?: string
}

export interface LaunchSpec {
  shell: 'wt.exe' | 'powershell.exe'
  command: string
  args: string[]
  /**
   * FB①: wt 経路のみ。spawn 前に書き出す launch 用 .ps1（path と内容）。
   * wt.exe は commandline 中の `;` をタブ/ペイン区切りとして分割するため、pxpipe 注入の
   * `$env:...='...';` を含むコマンドを `-Command` で渡すと後半が別タブ扱いになり起動失敗する。
   * statements を .ps1 に書き `-File` で渡すことで wt commandline から `;` を排除する
   * （FB① 実測: 生 `;` / `\;` / backtick / 改行いずれも不可、`.ps1`+`-File` のみ透過）。
   */
  scriptFile?: { path: string; content: string }
}

/**
 * 042: Windows パス同一判定。renderer 側 `launchOptions.samePath` と同一規則の意図的な複製
 * （main は renderer を import できないため。preload の型複製と同じ流儀）。片方を直すときは
 * 両方直すこと。realpath 解決を行わない理由は renderer 側 samePath の doc を参照。
 */
export function samePathMain(a: string, b: string): boolean {
  const norm = (p: string): string =>
    p.trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  const na = norm(a)
  const nb = norm(b)
  return na !== '' && na === nb
}

/**
 * 042 backstop（多層防御の第 2 層）: 「所有 PJ の証明が無い / 起動先 PJ と一致しない」`-r` を
 * flags から除去する。
 *
 * なぜ主プロセスにも置くか（設計レビュア指摘 [2]）: 実際に spawn するのは主プロセスであり、
 * 不変条件は spawn 境界で成立していなければ意味がない。renderer 側の判定は UX（なぜ落ちたかを
 * その場で見せる）であって不変条件の強制点ではない。将来 flags を自前で組む renderer 経路が
 * 増えても、証明を伴わない `-r` はここで必ず落ちる。
 *
 * 本 strip は「発火したらどこかにコード不具合がある」背もたれであり、平常運転では発火しない
 * （renderer が先に出さない）。ユーザーへの説明は popover の注記が担う。
 */
export function stripUnprovenResume(
  flags: string[],
  projectPath: string,
  binding?: { value: string; projectPath: string }
): string[] {
  const isProven = (value: string | undefined): boolean =>
    typeof value === 'string' &&
    value.trim() !== '' &&
    !!binding &&
    binding.value.trim() === value.trim() &&
    samePathMain(binding.projectPath, projectPath)

  const out: string[] = []
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i]
    // 実装レビュア指摘 [2]: `--resume=<id>` の等号記法も同じ判定に掛ける。renderer は分離形しか
    // 出さないが、本 backstop は「renderer を経由しない経路」に対する防壁なので記法で漏らさない。
    const eq = /^(--resume|-r)=(.*)$/.exec(f)
    if (eq) {
      if (isProven(eq[2])) out.push(f)
      continue
    }
    if (f !== '-r' && f !== '--resume') {
      out.push(f)
      continue
    }
    const value = flags[i + 1]
    // 実装レビュア指摘 [3]: 次要素が flag 形（先頭 `-`）なら「値」ではない。値として食うと
    // 無関係な flag（例 `--verbose`）まで巻き込んで消してしまうため、flag は消費しない。
    const valueIsFlag = typeof value === 'string' && value.startsWith('-')
    if (!valueIsFlag && isProven(value)) {
      out.push(f, value as string)
      i++
      continue
    }
    // 証明が無い場合は flag を捨てる。値らしき次要素も一緒に捨てる（孤児として残さない）。
    if (!valueIsFlag && typeof value === 'string') i++
  }
  return out
}

/**
 * 起動する powershell の statements を組み立てる（順序: cwd 確定 → 背景色 → env 注入 → claude）。
 * - cwd: `Set-Location -LiteralPath ... -ErrorAction Stop`。wt の `-d` は `[` `]` を含むパスを黙って
 *   捨て既定 cwd（System32\WindowsPowerShell\v1.0）で起動するため、wt/ps どちらの経路でも
 *   shell 自身が cwd を確定する。失敗時は後続（claude）を実行させない。
 * FB①: 従来の `;` 連結 1 本字列でなく statement 配列で持つ。wt 経路は改行区切りで .ps1 化し、
 * ps フォールバック経路は cmd が `;` を分割しないため `; ` 連結の -Command で渡す。
 * - 色: OSC 11 背景（launch-ccpit-misetani.ps1 と同一機構・wt/ps 両経路で有効・conhost で no-op）。
 * - env: `$env:K='V'`（process スコープ＝-NoExit セッションの自己 resume に透過。値内 ' は '' escape）。
 */
function buildStatements(args: LaunchArgs, injectEnv?: Record<string, string>): string[] {
  const stmts: string[] = []
  stmts.push(`Set-Location -LiteralPath '${normalize(args.projectPath).replace(/'/g, "''")}' -ErrorAction Stop`)
  if (args.tabColor) {
    stmts.push(`Write-Host ([char]27 + ']11;${args.tabColor}' + [char]7) -NoNewline`)
  }
  if (injectEnv) {
    for (const [k, v] of Object.entries(injectEnv)) {
      stmts.push(`$env:${k}='${v.replace(/'/g, "''")}'`)
    }
  }
  const resumePart = args.resumeSessionId ? ['--resume', args.resumeSessionId] : []
  // 042: 証明の無い resume は spawn 境界で落とす（stripUnprovenResume の doc 参照）。
  // 実装レビュア指摘 [2]: resumeSessionId 由来の `--resume` も**同じ関門を通す**。ここを素通しに
  // すると「不変条件は spawn 境界で成立している」という主張が嘘になる（本欄は現時点 production
  // 未使用だが、将来使う経路にも証明を要求する）。
  const guardedFlags = stripUnprovenResume(
    [...resumePart, ...args.flags.filter((f) => f.length > 0)],
    args.projectPath,
    args.resumeBinding
  )
  const claudeParts = ['claude', ...guardedFlags]
  stmts.push(claudeParts.join(' '))
  return stmts
}

/**
 * 037 Phase 2-C: spawn 引数の組み立てを純関数化。Electron GUI app からの spawn では
 * `detached + stdio:ignore` でも新規コンソールウィンドウが生成されないため、cmd.exe の
 * `start` 経由で起動して独立ウィンドウを確実に作る。`start` の第 1 引数は空タイトル `""`
 * が必須（パス文字列をタイトルと誤解しないため）。
 * FB①: wt 経路は temp .ps1 + `-File`（ps1Path を呼び出し側が用意）。純関数維持のためファイル
 * 書き出しは launchCc が担い、本関数は path と内容（scriptFile）を返すのみ。
 */
export function buildLaunchSpec(
  args: LaunchArgs,
  exePaths: { wt: string | null; ps: string | null },
  injectEnv?: Record<string, string>,
  ps1Path?: string
): LaunchSpec | { error: string } {
  const projectPath = normalize(args.projectPath)
  const stmts = buildStatements(args, injectEnv)

  if (exePaths.wt) {
    // 037 Phase 2-C: wt.exe は GUI アプリで自前ウィンドウを生成するため cmd /c start を経由せず
    // 直接 spawn する。FB①: `;` 分割回避のため statements を .ps1 に書き `-File` で渡す
    // （wt commandline に `;` を一切出さない）。cwd は `-d` と .ps1 先頭の Set-Location の二重で確定する。
    if (!ps1Path) {
      return { error: 'wt launch requires ps1Path (internal)' }
    }
    return {
      shell: 'wt.exe',
      command: exePaths.wt,
      args: ['-d', projectPath, 'powershell.exe', '-NoExit', '-File', ps1Path],
      scriptFile: { path: ps1Path, content: stmts.join('\r\n') + '\r\n' }
    }
  }

  if (exePaths.ps) {
    // ps フォールバックは cmd /c start 経由。cmd は `;` をコマンド区切りにしないため
    // statements を `; ` 連結の -Command で渡せる（wt のような分割は起きない）。
    return {
      shell: 'powershell.exe',
      command: 'cmd.exe',
      args: ['/c', 'start', '""', '/D', projectPath, exePaths.ps, '-NoExit', '-Command', stmts.join('; ')]
    }
  }

  return { error: 'No shell found (wt.exe or powershell.exe)' }
}

/** FB①: wt 経路の launch 用 .ps1 の一意な temp パスを生成する。 */
function newLaunchScriptPath(): string {
  const name = `${LAUNCH_SCRIPT_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ps1`
  return join(tmpdir(), name)
}

/**
 * FB①: 古い launch 用 .ps1 を best-effort 掃除する。self-delete しない設計（self-resume が
 * 同セッションで走るため .ps1 の寿命に依存させない）ので、TTL で溜まりを防ぐ。
 */
function cleanupStaleLaunchScripts(): void {
  const dir = tmpdir()
  const now = Date.now()
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const f of entries) {
    if (!f.startsWith(LAUNCH_SCRIPT_PREFIX) || !f.endsWith('.ps1')) continue
    const p = join(dir, f)
    try {
      if (now - statSync(p).mtimeMs > LAUNCH_SCRIPT_TTL_MS) unlinkSync(p)
    } catch {
      /* best-effort */
    }
  }
}

/**
 * CC を指定 PJ のカレントディレクトリで起動する。
 * シェル選定: wt.exe（Windows Terminal）優先、なければ powershell.exe。
 * spawn は detached + stdio:ignore で fire-and-forget。
 * FB①: wt 経路は temp .ps1 を書き出してから `-File` で spawn する（wt の `;` 分割回避）。
 */
export function launchCc(args: LaunchArgs, injectEnv?: Record<string, string>): LaunchResult {
  if (isIsolatedLaunch()) {
    noteBlocked('ccLaunch.launchCc')
    return { shell: '', spawned: false, error: ISOLATION_BLOCK_REASON }
  }
  const projectPath = normalize(args.projectPath)
  if (!existsSync(projectPath)) {
    return { shell: '', spawned: false, error: `Project path not found: ${projectPath}` }
  }

  const wt = whichExe('wt.exe')
  const ps = whichExe('powershell.exe')
  // wt 経路のときだけ .ps1 path を用意する（ps フォールバックは -Command 直渡し）。
  const ps1Path = wt ? newLaunchScriptPath() : undefined

  const spec = buildLaunchSpec(args, { wt, ps }, injectEnv, ps1Path)
  if ('error' in spec) {
    return { shell: '', spawned: false, error: spec.error }
  }

  try {
    if (spec.scriptFile) {
      cleanupStaleLaunchScripts()
      // BOM 必須: Windows PowerShell 5.1 は BOM なし .ps1 をシステム ANSI コードページ（日本語環境では CP932）で読む。
      // 非 ASCII パス（例「藏」= E8 97 8F）の末尾バイトが閉じ ' を食い ParserError になる。
      writeFileSync(spec.scriptFile.path, '\uFEFF' + spec.scriptFile.content, 'utf8')
    }
    const child = spawn(spec.command, spec.args, {
      detached: true,
      stdio: 'ignore',
      shell: false
    })
    child.unref()
    return { shell: spec.shell, spawned: true }
  } catch (e) {
    return {
      shell: spec.shell,
      spawned: false,
      error: e instanceof Error ? e.message : String(e)
    }
  }
}
