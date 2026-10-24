/**
 * proposalDialogueLaunch — ユーザーコメントへの応答を CC にさせるための**起動経路**（設計 §3-4 導線①）。
 *
 * 本モジュールが存在する理由は 1 つ。**依頼文をシェルに通さないため**である。
 *
 * 実測した制約（`ccLaunch.ts:101`）:
 *   const claudeParts = ['claude', ...resumePart, ...args.flags.filter(f => f.length > 0)]
 *   stmts.push(claudeParts.join(' '))
 * すなわち `flags` は**空白連結**され、そのまま PowerShell の 1 行になる。ここへ長文（改行・引用符・
 * `;` を含む依頼文）や、空白を含みうる temp パスを載せると壊れる。本リポは既に `;` の混入で
 * wt 起動が割れる実害を踏んでいる（038 FB①）。
 *
 * **temp ファイルへ逃がすだけでは不十分**（Plan Codex レビュー finding#5）。
 * temp パス**そのもの**が `flags` を通れば、パスに空白や `&` が入った瞬間に同じ経路で壊れる。
 * 自分の home にたまたま空白が無いのは設計ではなく偶然であり、根拠にしない。
 *
 * よって:
 *   - 依頼文は temp ファイルへ書く
 *   - **プロンプト文字列は `injectEnv` で環境変数として渡す**
 *     （`buildStatements` が `$env:K='V'` を PowerShell の単一引用符文字列として出すため、
 *      空白・`;`・`&` を含んでも 1 つの値として安全に渡る。値中の `'` は `''` へ escape 済み）
 *   - `flags` に載せるのは **空白もシェルメタ文字も含まない固定トークン 1 個**だけ
 *     （`$env:...` は PowerShell が展開時に 1 引数として扱う）
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, dirname, resolve, parse } from 'path'
import { tmpdir } from 'os'
import { launchCc, type LaunchArgs, type PxpipeMode } from './ccLaunch'
import { buildCommentDialogueRequest, readProposalContent } from './commentOps'

/** 依頼文の本体を書き出す temp ファイル名の接頭辞（掃除の目印） */
const DIALOGUE_FILE_PREFIX = 'ccpit-proposal-dialogue-'
/** 修復依頼文の本体を書き出す temp ファイル名の接頭辞 */
const REPAIR_FILE_PREFIX = 'ccpit-proposal-repair-'

/** CC へ渡す短い参照プロンプトを載せる環境変数名 */
export const DIALOGUE_PROMPT_ENV = 'CCPIT_PROPOSAL_DIALOGUE_PROMPT'
/** 依頼文ファイルの絶対パスを載せる環境変数名（プロンプト内にも埋めるが、機械参照用に別途渡す） */
export const DIALOGUE_FILE_ENV = 'CCPIT_PROPOSAL_DIALOGUE_FILE'

/**
 * `flags` へ載せる唯一のトークン。**空白・引用符・`;`・`&` を含まないこと**が本モジュールの契約であり、
 * テストで固定する。PowerShell が実行時に環境変数を展開し、空白を含む値でも 1 引数として渡す。
 */
export const DIALOGUE_PROMPT_FLAG = `$env:${DIALOGUE_PROMPT_ENV}`

/**
 * `flags` へ載せてよいトークンの形（**実装レビュー finding#2 / critical**）。
 *
 * 当初は「生成するトークンは安全」という前提で書いていたが、**model は設定ダイアログの
 * 自由入力**であり、effort も `app-config.json` 直編集で任意値が入る。つまり
 * ユーザー入力が検証なしに PowerShell の 1 行へ流れていた。
 * `foo; calc` のような値で**別コマンドとして解釈されうる**（空白連結されるため）。
 *
 * よって flags に載る前に**ホワイトリストで弾く**。逸脱値は**黙って通さず落とす**
 * — サニタイズして通すと「指定したのに違うモデルで動く」という別の嘘になる。
 *
 * **`[` `]` を許可する理由（maintainer実機 FB 2026-08-08）**: 当初 `[A-Za-z0-9._-]` に絞ったところ、
 * 本リポの正当なモデル ID **`claude-opus-5[1m]` が拒否された**。`[1m]` は 1M コンテキスト窓を
 * 確保するための本系の正式な表記（041）であり、既存の `applyOneMContextToFlags` も同じ形を
 * flags へ載せている。つまり過剰拒否は「実在する正しい設定を無言で捨てる」実害を生む。
 * 角括弧は PowerShell の native command 引数としてはリテラルであり、注入面を広げない。
 * **空白とシェルメタ文字（`;` `&` `|` `` ` `` `$` 引用符 括弧）は引き続き拒否**する。
 */
/**
 * **先頭は英数字に限定する**（実装レビュー finding#1 / argv 注入）。
 * シェル注入だけを見ていたが、`-` 始まりの値は**下流 CLI がオプションとして解釈する**。
 * 例: `model = "--dangerously-skip-permissions"` は旧 regex を通り、値のつもりが危険フラグになる。
 * これはシェルを経由しない argv レベルの注入であり、引用符では防げない。
 */
export const SAFE_FLAG_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._[\]-]*$/

/** `--permission-mode` は自由文字列でなく既知集合に閉じる（finding#1 の suggestion） */
export const PERMISSION_MODE_VALUES = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'dontAsk',
  'bypassPermissions'
] as const
export function isSafeFlagToken(v: string): boolean {
  return SAFE_FLAG_TOKEN.test(v)
}

/** 対話 CC に渡す起動オプション（全提案共通・`app-config.json` の `skillProposals`） */
export interface DialogueLaunchOptions {
  model?: string
  effort?: string
  pxpipe?: PxpipeMode
  /** `--permission-mode`（`plan` を選ぶと CC は読み取り中心の計画モードで起動する） */
  permissionMode?: string
  /** `--dangerously-skip-permissions`（確認を出さない。既定 false） */
  skipPermissions?: boolean
}

export interface DialogueLaunchPlan {
  flags: string[]
  injectEnv: Record<string, string>
  promptFilePath: string
  prompt: string
  /** 安全でないため flags から除外した設定値（UI へ理由として返し、黙って無視しない） */
  rejected: string[]
}

/**
 * 起動計画の組み立て（**純粋関数**。ファイル I/O も spawn もしない）。
 * テストはこの戻り値に対して「flags に長文もパスも現れない」ことを固定する。
 */
export function buildDialogueLaunchPlan(input: {
  promptFilePath: string
  model?: string
  effort?: string
  permissionMode?: string
  skipPermissions?: boolean
}): DialogueLaunchPlan {
  /**
   * **起動プロンプトは ASCII のみ**（maintainer実機 FB 2026-08-08・文字化け）。
   *
   * 実測した原因: `launchCc` は起動用 `.ps1` を **BOM なし UTF-8** で書く（`ccLaunch.ts:206`）。
   * **PowerShell 5.1 は BOM の無い `.ps1` を ANSI（日本語環境では CP932）として読む**ため、
   * UTF-8 の日本語が `謠先｡医∈蟇` のように化ける。env 経由でも実体は同じ .ps1 の中なので同じく化ける。
   *
   * ccLaunch を BOM 付きに変えれば根治だが、あれは**全 CC 起動が通る共有経路**であり、
   * 並行レーン稼働中に挙動を変える риск が大きい。ここでは自分側を ASCII に閉じる。
   * **情報は失われない** — 日本語の指示本体は temp の `.md`（UTF-8）にあり、CC はそれを正しく読む。
   *
   * 恒久対応（`.ps1` の BOM 付き書き出し）はレーンが静かになったら別件で行う。
   * それまで**このプロンプトに非 ASCII を入れてはならない**（テストで固定する）。
   */
  const prompt =
    'Respond to user comments on a Skill proposal. ' +
    `Read this file and follow the instructions written in it: ${input.promptFilePath}`

  const flags: string[] = []
  const rejected: string[] = []
  // 危険側は **厳密に boolean true のときだけ**（finding#2）。
  // `app-config.json` は手編集できるので、文字列 "false" が truthy として通ると
  // 「明示的に有効化していないのに危険モードで起動する」事故になる。
  if (input.skipPermissions === true) flags.push('--dangerously-skip-permissions')
  // `default` は CLI 既定なので付与しない（launchOptions.buildFlags と同じ流儀）
  const pmode = (input.permissionMode ?? '').trim()
  if (pmode && pmode !== 'default') {
    // 既知集合に閉じる。自由文字列だと `-` 始まり等の argv 注入面が残る（finding#1）
    if ((PERMISSION_MODE_VALUES as readonly string[]).includes(pmode)) {
      flags.push('--permission-mode', pmode)
    } else {
      rejected.push(`permissionMode=${pmode}`)
    }
  }
  // 既存の流儀に合わせる（launchOptions.buildFlags と同じ形）。
  // **ただし値は必ず検証する**（finding#2: model は自由入力・effort は config 直編集で任意値が入る）。
  const effort = (input.effort ?? '').trim()
  if (effort && effort !== 'medium') {
    if (isSafeFlagToken(effort)) flags.push('--effort', effort)
    else rejected.push(`effort=${effort}`)
  }
  const model = (input.model ?? '').trim()
  if (model) {
    if (isSafeFlagToken(model)) flags.push('--model', model)
    else rejected.push(`model=${model}`)
  }
  // **長文は最後に 1 トークンだけ**。実体は env にあり、ここには変数参照しか置かない。
  flags.push(DIALOGUE_PROMPT_FLAG)

  return {
    flags,
    injectEnv: {
      [DIALOGUE_PROMPT_ENV]: prompt,
      [DIALOGUE_FILE_ENV]: input.promptFilePath
    },
    promptFilePath: input.promptFilePath,
    prompt,
    rejected
  }
}

/**
 * 修復起動計画の組み立て（純粋関数・ASCII 限定プロンプト・N3, AC4）。
 */
export function buildRepairLaunchPlan(input: {
  promptFilePath: string
  model?: string
  effort?: string
  permissionMode?: string
  skipPermissions?: boolean
}): DialogueLaunchPlan {
  // 修復専用の起動プロンプト（全 ASCII）
  const prompt =
    'Repair the formatting of a Skill proposal. ' +
    `Read this file and follow the instructions written in it: ${input.promptFilePath}`

  const flags: string[] = []
  const rejected: string[] = []
  if (input.skipPermissions === true) flags.push('--dangerously-skip-permissions')
  const pmode = (input.permissionMode ?? '').trim()
  if (pmode && pmode !== 'default') {
    if ((PERMISSION_MODE_VALUES as readonly string[]).includes(pmode)) {
      flags.push('--permission-mode', pmode)
    } else {
      rejected.push(`permissionMode=${pmode}`)
    }
  }
  const effort = (input.effort ?? '').trim()
  if (effort && effort !== 'medium') {
    if (isSafeFlagToken(effort)) flags.push('--effort', effort)
    else rejected.push(`effort=${effort}`)
  }
  const model = (input.model ?? '').trim()
  if (model) {
    if (isSafeFlagToken(model)) flags.push('--model', model)
    else rejected.push(`model=${model}`)
  }
  flags.push(DIALOGUE_PROMPT_FLAG)

  return {
    flags,
    injectEnv: {
      [DIALOGUE_PROMPT_ENV]: prompt,
      [DIALOGUE_FILE_ENV]: input.promptFilePath
    },
    promptFilePath: input.promptFilePath,
    prompt,
    rejected
  }
}

/** 文字列が印字可能 ASCII のみか（制御文字は `\u` 表記で扱い、生バイトを書かない） */
export function isPrintableAscii(s: string): boolean {
  return /^[ -~]*$/.test(s)
}

/**
 * 依頼文を置く temp ディレクトリ。**パス全体が ASCII になることを保証する**（finding#3）。
 * 既定の `tmpdir()` が非 ASCII（日本語ユーザー名等）なら、システムドライブ直下の
 * ASCII 固定パスへ退避する。ここが非 ASCII だと env 経由でも .ps1 の CP932 読みで化ける。
 */
export function asciiSafeTempDir(
  base: string = tmpdir(),
  systemDrive: string = process.env.SystemDrive || 'C:'
): string {
  const preferred = join(base, 'ccpit-proposal-dialogue')
  if (isPrintableAscii(preferred)) return preferred
  return join(systemDrive + '\\', 'ccpit-tmp', 'proposal-dialogue')
}

export interface LaunchDialogueResult {
  ok: boolean
  error?: string
  promptFilePath?: string
  shell?: string
  /** 安全でないため無視した設定値。UI が警告として出す（黙って捨てない） */
  rejectedSettings?: string[]
  /**
   * 実際に CC へ渡した起動引数（`$env:` 参照トークンは除く）。
   *
   * **「設定したのに効いていない気がする」を推測でなく即断できるようにするため**に返す
   * （maintainer FB 2026-08-08: plan モードが効いていないように見えた際、静的検査は全て白で
   * 再現できず、観測点が無いことが調査を長引かせた）。UI がそのまま表示する。
   */
  appliedFlags?: string[]
}

export interface LaunchDialogueDeps {
  /** CC を起動する cwd。依頼文が `ccpit/scripts/...` という**リポ相対**の実行を指示するため、リポ root を渡す */
  repoRoot: string
  options?: DialogueLaunchOptions
  /**
   * pxpipe 経路で確定した追加 env（実測は `ANTHROPIC_BASE_URL`）。
   * pxpipe の確保／degrade 判断は既存の `cc:launch` と同じ関数群が担い、
   * ここは**確定した env を受け取って合流させるだけ**にする（判断を二重実装しない・finding#3）。
   */
  extraEnv?: Record<string, string>
  /** テスト差し替え用 */
  launch?: typeof launchCc
  writeFile?: (path: string, content: string) => void
  now?: () => number
}

/**
 * 依頼文を temp へ書き、CC を起動する。
 *
 * **アプリは提案 MD もコメント応答も書かない**（設計 §3-4）。ここでやるのは
 * 「言われたことを正確に渡す」だけであり、書くのは CC の仕事である。
 */
export function launchProposalDialogue(
  requestId: string,
  filePath: string,
  deps: LaunchDialogueDeps
): LaunchDialogueResult {
  const write = deps.writeFile ?? ((p: string, c: string): void => writeFileSync(p, c, 'utf-8'))
  const doLaunch = deps.launch ?? launchCc
  const now = deps.now ?? ((): number => Date.now())

  let dialogueText: string
  try {
    const content = readProposalContent(filePath)
    dialogueText = buildCommentDialogueRequest(requestId, filePath, content)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  // **temp 置き場も ASCII でなければならない**（実装レビュー finding#3）。
  // ASCII 保証を「プロンプト固定文」にしか掛けていなかったが、実際には `tmpdir()` が
  // `C:\Users\日本語名\AppData\Local\Temp\...` になり得る。その瞬間 env 値へ非 ASCII が入り、
  // BOM なし .ps1 の CP932 読みで再び化ける（＝maintainerが踏んだ現象の再発）。
  // 自分の環境がたまたま ASCII なのは偶然であり、根拠にしない。
  const dir = asciiSafeTempDir()
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* 既存なら無視 */
  }
  // ファイル名は ASCII・空白なし（万一 flags 経路へ迷い込んでも壊れにくくする二重の備え）
  const safeId = requestId.replace(/[^A-Za-z0-9._-]/g, '_')
  const promptFilePath = join(dir, `${DIALOGUE_FILE_PREFIX}${safeId}-${now()}.md`)

  try {
    write(promptFilePath, dialogueText)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  const plan = buildDialogueLaunchPlan({
    promptFilePath,
    model: deps.options?.model,
    effort: deps.options?.effort,
    permissionMode: deps.options?.permissionMode,
    skipPermissions: deps.options?.skipPermissions
  })

  const args: LaunchArgs = { projectPath: deps.repoRoot, flags: plan.flags }
  // pxpipe 由来の env は依頼文の env と合流させる（キー衝突は無い: 前者は ANTHROPIC_*、後者は CCPIT_*）
  const r = doLaunch(args, { ...plan.injectEnv, ...(deps.extraEnv ?? {}) })
  const rejectedSettings = plan.rejected.length > 0 ? plan.rejected : undefined
  // 参照トークンは実引数としては依頼文なので、可視化からは外す（人が読む意味が無い）
  const appliedFlags = plan.flags.filter((f) => f !== DIALOGUE_PROMPT_FLAG)
  return r.spawned
    ? {
        ok: true,
        promptFilePath,
        shell: r.shell,
        appliedFlags,
        ...(rejectedSettings ? { rejectedSettings } : {})
      }
    : {
        ok: false,
        error: r.error ?? 'launch failed',
        promptFilePath,
        appliedFlags,
        ...(rejectedSettings ? { rejectedSettings } : {})
      }
}

/**
 * 指定ディレクトリおよびその祖先ディレクトリに Claude Code のプロジェクト設定が存在するか検査する（AC16）。
 * 対象: `.claude/settings.json` および `.claude/settings.local.json`
 *
 * @returns 検出された設定ファイルの絶対パス一覧（存在しない場合は空配列）
 */
export function detectProjectSettingsInAncestors(startDir: string): string[] {
  const found: string[] = []
  try {
    let current = resolve(startDir)
    const root = parse(current).root

    while (true) {
      const sharedSettings = join(current, '.claude', 'settings.json')
      if (existsSync(sharedSettings)) {
        found.push(sharedSettings)
      }
      const localSettings = join(current, '.claude', 'settings.local.json')
      if (existsSync(localSettings)) {
        found.push(localSettings)
      }

      if (current === root) break
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
  } catch {
    /* 走査中の例外は握り潰して安全側に空配列を返す */
  }

  return found
}

export interface LaunchRepairDeps {
  /** テスト差し替え用 cwd。省略時は dirname(filePath) */
  cwd?: string
  options?: DialogueLaunchOptions
  extraEnv?: Record<string, string>
  launch?: typeof launchCc
  writeFile?: (path: string, content: string) => void
  now?: () => number
}

export interface LaunchRepairResult extends LaunchDialogueResult {
  cwd?: string
  detectedSettings?: string[]
}

/**
 * 解析エラーの提案修復用 CC を起動する（D1, D2, D5, D6, AC1, AC3, AC4, AC13, AC14）。
 *
 * - cwd は対象ファイルのフォルダ（dirname(filePath)）。
 * - 依頼文は temp の .md に書き、起動引数には一切載せない。
 * - 起動プロンプトは ASCII 限定。
 * - 設定値はホワイトリスト検証。
 */
export function launchProposalRepair(
  filePath: string,
  repairPromptText: string,
  deps: LaunchRepairDeps = {}
): LaunchRepairResult {
  const write = deps.writeFile ?? ((p: string, c: string): void => writeFileSync(p, c, 'utf-8'))
  const doLaunch = deps.launch ?? launchCc
  const now = deps.now ?? ((): number => Date.now())

  const targetCwd = deps.cwd ?? dirname(filePath)
  const dir = asciiSafeTempDir()
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* 既存なら無視 */
  }

  const baseName = filePath.split(/[/\\]/).pop() || 'repair'
  const safeBase = baseName.replace(/[^A-Za-z0-9._-]/g, '_')
  // 同一ミリ秒・同名ファイルの衝突を防止（Codex r2 finding#4）
  const rand = Math.random().toString(36).slice(2, 8)
  const promptFilePath = join(dir, `${REPAIR_FILE_PREFIX}${safeBase}-${now()}-${rand}.md`)

  try {
    write(promptFilePath, repairPromptText)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  const plan = buildRepairLaunchPlan({
    promptFilePath,
    model: deps.options?.model,
    effort: deps.options?.effort,
    permissionMode: deps.options?.permissionMode,
    skipPermissions: deps.options?.skipPermissions
  })

  const args: LaunchArgs = { projectPath: targetCwd, flags: plan.flags }
  const r = doLaunch(args, { ...plan.injectEnv, ...(deps.extraEnv ?? {}) })
  const rejectedSettings = plan.rejected.length > 0 ? plan.rejected : undefined
  const appliedFlags = plan.flags.filter((f) => f !== DIALOGUE_PROMPT_FLAG)
  const detectedSettings = detectProjectSettingsInAncestors(targetCwd)

  return r.spawned
    ? {
        ok: true,
        promptFilePath,
        shell: r.shell,
        appliedFlags,
        cwd: targetCwd,
        detectedSettings,
        ...(rejectedSettings ? { rejectedSettings } : {})
      }
    : {
        ok: false,
        error: r.error ?? 'launch failed',
        promptFilePath,
        appliedFlags,
        cwd: targetCwd,
        detectedSettings,
        ...(rejectedSettings ? { rejectedSettings } : {})
      }
}
