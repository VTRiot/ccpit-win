/**
 * hooks 登録の静的検証（electron 非依存）。fs は読むが app 等の electron API には依存しない。
 *
 * 注: 本モジュールが扱うのは「golden が期待する hook 登録（event/matcher/type/command）が
 * 実 settings.json に存在するか」の網羅検証であって、hook 実体ファイルの存在検証ではない
 * （実体は health の hooks/ 検査が担う）。実体があっても登録が無ければ hook は一切発火しない
 * （配備ドリフト）。matcher の弱化（例: golden `Bash|Edit|Write` に対し実側 `Edit|Write`）は
 * 欠落とは別区分（matcherMismatches）で検出する — コマンドが居るだけの false-green を防ぐ
 * （Marshal review finding 対応）。
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { KNOWN_TEMPLATES } from './denyValidation'
import { isWslLauncher } from './bashResolver'

/** 期待 hook 登録 1 件（matcher グループは平坦化済み）。 */
export interface ExpectedHookEntry {
  event: string
  matcher: string
  type: string
  command: string
  /** 起動形: exec form（bash -c <script>）なら true、直接形式（bare .sh）なら false。
   * golden が exec form を期待する hook を実側が bare .sh で登録した退行（端末 Windows CC で不発）を
   * 検証で潰さない（false-green 防止）ため、command 正規化後も起動形を保持して exact-match に含める。 */
  execForm: boolean
  /** exec form の script 引数が外側ダブルクォートで包まれていたか。command の同一性比較では
   * クォートを正規化して剥がすが、クォート状態自体は捨てない（Codex 再レビュー high 対応）:
   * 未クォート登録は空白入り HOME の bash word splitting で不発になるため、
   * quoteHazardSeverity が実環境の HOME と突き合わせて危険度を判定する。direct 形は false。 */
  quotedArg: boolean
  /** exec form の interpreter（登録された生の command 文字列）。direct 形は ''。
   * command の同一性比較には使わない（basename 正規化で吸収）が、既知死クラス
   * （WSL の System32\bash.exe = $HOME が別環境で hook 不発）の検出に使う（Codex round-4 high）。 */
  interpreter: string
}

export interface HooksCoverageResult {
  /** missing も matcherMismatches も無い場合のみ true（登録網羅の判定。quote hazard は含めない —
   * 未クォートの危険度は実環境の HOME に依存するため呼び出し側が quoteHazardSeverity で判定する） */
  valid: boolean
  /** コマンド自体が未登録。`<event>: <command>` 形式 */
  missing: string[]
  /** コマンドは居るが matcher（または type）が期待と不一致。弱化登録の検出 */
  matcherMismatches: string[]
  /** 登録は一致するが、golden がクォート形を期待する exec 引数を実側が未クォートで登録している hook。
   * 空白入り HOME では word splitting で不発（実 bash probe で実証済み）＝green-but-dead の芽。
   * 空白なし HOME では実行等価。severity は quoteHazardSeverity(件数, home) が決める。 */
  unquotedArgHazards: string[]
  /** 登録は一致するが、interpreter が既知死クラス（WSL の System32\bash.exe）の hook。
   * WSL bash は $HOME が別ファイルシステムに解決され hook が環境非依存で不発＝無条件 error。 */
  badInterpreterHazards: string[]
  /** 登録は一致するが、interpreter が bare（パス区切りなし・例 `bash`）の hook。
   * 端末起動 Windows CC は bare bash を解決できず「Git Bash not found」で不発（46fc171 実証・
   * deploy が実体パスを注入する理由そのもの）。手動コピー golden・注入失敗の残骸で発生する。
   * POSIX では PATH 解決で発火するため、severity は hooksCoverageStatus が platform で決める。 */
  bareInterpreterHazards: string[]
}

export interface ExpectedHooksResult {
  ok: boolean
  expected: ExpectedHookEntry[]
  error?: string
}

/** settings.json の hooks セクションから登録エントリを平坦化抽出する。 */
function flattenHookEntries(hooksSection: unknown): ExpectedHookEntry[] {
  const out: ExpectedHookEntry[] = []
  if (typeof hooksSection !== 'object' || hooksSection === null) return out
  for (const [event, groups] of Object.entries(hooksSection as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue
    for (const group of groups) {
      if (typeof group !== 'object' || group === null) continue
      const g = group as { matcher?: unknown; hooks?: unknown }
      const matcher = typeof g.matcher === 'string' ? g.matcher : ''
      if (!Array.isArray(g.hooks)) continue
      for (const h of g.hooks) {
        if (typeof h !== 'object' || h === null) continue
        const hook = h as { type?: unknown; command?: unknown; args?: unknown }
        if (typeof hook.command !== 'string') continue
        // exec form（command: bash/sh interpreter, args: ["-c", "<script>"]）は args 末尾の実スクリプトを
        // 実体コマンドとして抽出する。端末 Windows CC で bare `.sh` が不発のため golden は restart 系
        // hook を exec form で起動する（detection-gap 46fc171）。直接形式（command=script）は従来通り。
        // 起動形（execForm）は保持する — exec 期待を bare .sh で満たした退行を検証で潰さないため。
        let command = hook.command
        let execForm = false
        let quotedArg = false
        // interpreter 判定は basename 正規化（区切り \ / 両対応・小文字化・末尾 .exe 除去）後の
        // 完全一致で行う。Windows 実環境は interpreter をフルパス登録する（例:
        // C:\Users\<user>\scoop\shims\bash.exe）ため、bare 文字列比較では exec form を認識できず
        // 登録済み hook を missing と誤検知する。完全一致は維持（git-bash 等の類似名を exec 扱いしない）。
        // 【契約の限界（明示）】basename 一致はディレクトリを捨てるため「任意パスの bash 実体」を
        // exec form として受ける。既知死クラス（WSL の System32\bash.exe）は interpreter 保持 +
        // badInterpreterHazards で無条件 error に落とす（Codex round-4 high）。MSYS/Cygwin 等の
        // 非 Git Bash は $HOME 挙動が環境依存（未検証）のため受理する — 完全 allowlist 化は
        // カスタム配置の正当 Git Bash（portable 等）を偽赤化し fix037 の目的を退行させる。
        // settings 書込者による意図的偽装の検出は対象外（脅威モデルは配備ドリフト検出。
        // interpreter 実体の妥当性担保は deploy 側 resolveBashBin の既知パス限定が担う）。
        const interpreter = (command.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '')
        // exec form の認識は厳密 shape `args === ['-c', <script>]`（2 要素）に限定する。
        // bash -c の実行対象は -c 直後の第 1 引数であり、後続要素は $0,$1… の positional になる。
        // 最終要素を script とみなすと `['-c', <別cmd>, <golden風script>]` が「登録あり（緑）のまま
        // 別 cmd を実行」する偽緑になる（内部 adversarial 監査で実証）。golden・実機の正規登録は
        // 常に 2 要素なので、これ以外の shape は exec 扱いせず literal のまま fail-visible にする。
        if (
          (interpreter === 'bash' || interpreter === 'sh') &&
          Array.isArray(hook.args) &&
          hook.args.length === 2 &&
          hook.args[0] === '-c'
        ) {
          const script = hook.args[1]
          if (typeof script === 'string' && script.length > 0) {
            // 外側ダブルクォート 1 対の正規化: golden はスペース入り HOME 対策で
            // `"$HOME/.claude/hooks/x.sh"` とクォートして配布する（Codex [high]#2）が、
            // command の同一性比較ではクォートを剥がして比較する（expected/installed 両側対称）。
            // クォート状態は quotedArg として保持し、未クォート legacy 登録の危険度判定
            // （空白入り HOME で不発 = quoteHazardSeverity）に使う（Codex 再レビュー high 対応）。
            // 剥がすのは「外側 " 1 対・内部に " を含まない」場合のみ。単一クォート（'…'）は bash が
            // $HOME を展開しない壊れ登録、クォート内の前後空白は空白入りファイル名の実行（不発）で
            // あり、いずれも実行挙動が異なるため同一視せず不一致として表面化させる。
            const unquoted = /^"([^"]+)"$/.exec(script)
            command = unquoted ? unquoted[1] : script
            quotedArg = unquoted !== null
            execForm = true
          }
        }
        out.push({
          event,
          matcher,
          type: typeof hook.type === 'string' ? hook.type : '',
          command,
          execForm,
          quotedArg,
          interpreter: execForm ? hook.command : ''
        })
      }
    }
  }
  return out
}

/**
 * golden の期待 hooks（指定 template の settings.json の hooks セクション）を解決する。
 * template が未知 / golden ファイル欠落 / parse 不能 のいずれも fail-closed（ok=false）で返す。
 * これにより health は「検証不能」を緑にせず error にできる。
 */
export function resolveExpectedHooks(goldenDir: string, template: string): ExpectedHooksResult {
  if (!(KNOWN_TEMPLATES as readonly string[]).includes(template)) {
    return {
      ok: false,
      expected: [],
      error: `未知の template '${template}'（許可: ${KNOWN_TEMPLATES.join('/')}）`
    }
  }
  try {
    const settingsPath = join(goldenDir, template, 'settings.json')
    if (!existsSync(settingsPath)) {
      return { ok: false, expected: [], error: `${template}/settings.json 欠落` }
    }
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8')) as { hooks?: unknown }
    const expected = flattenHookEntries(parsed.hooks)
    if (expected.length === 0) {
      return { ok: false, expected: [], error: `${template}/settings.json に hooks 定義なし` }
    }
    return { ok: true, expected }
  } catch (e) {
    return { ok: false, expected: [], error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * hook が発火時に実在を要求する runtime 必須 skill。
 * skill-proposal-gate.sh（Stop hook）は block reason で skill-proposal-emitter の発火を
 * 要求するため、登録だけあって skill 不在だと Stop block が空振りする。
 * skills/ の個数比較は無関係 skill の追加が欠落を隠す false-green になるため、
 * 名前の membership で検証する（Marshal review R2 対応）。
 */
export const REQUIRED_RUNTIME_SKILLS = ['skill-proposal-emitter'] as const

export interface RequiredSkillsResult {
  valid: boolean
  missing: string[]
}

/** 必須 runtime skill が installed 一覧（skill 名）に全部居るか検証する。 */
export function validateRequiredSkills(
  installedSkillNames: string[],
  required: readonly string[] = REQUIRED_RUNTIME_SKILLS
): RequiredSkillsResult {
  const installedSet = new Set(installedSkillNames)
  const missing = required.filter((name) => !installedSet.has(name))
  return { valid: missing.length === 0, missing }
}

/**
 * 期待 hooks が実 settings.json の hooks に登録されているか検証する。
 * - 完全一致（event + matcher + type + command）→ 充足
 * - 同 event に command は居るが matcher / type が不一致 → matcherMismatches（弱化・変質登録）
 * - 同 event に command 自体が無い → missing
 * 実側の追加 hook（期待に無いコマンド・event）は正常運用として許容（superset OK）。
 * matcher グループの分割・並び順には依存しない。
 */
export function validateHooksCoverage(
  installedHooksSection: unknown,
  expected: ExpectedHookEntry[]
): HooksCoverageResult {
  const installed = flattenHookEntries(installedHooksSection)
  const shape = (f: boolean): string => (f ? 'exec' : 'direct')
  // exact-key は [event, matcher, type, command(クォート正規化後), execForm]。quotedArg はキーに
  // 含めない（既存実機の未クォート legacy を missing 赤に偽アラーム化しないため）が、キー一致した
  // 実側エントリのクォート状態を hazard として別報告する（green-but-dead の芽の可視化）。
  const byExactKey = new Map<string, ExpectedHookEntry[]>()
  for (const e of installed) {
    const key = JSON.stringify([e.event, e.matcher, e.type, e.command, e.execForm])
    const bucket = byExactKey.get(key)
    if (bucket) bucket.push(e)
    else byExactKey.set(key, [e])
  }
  const missing: string[] = []
  const matcherMismatches: string[] = []
  const unquotedArgHazards: string[] = []
  const badInterpreterHazards: string[] = []
  const bareInterpreterHazards: string[] = []
  // 健全 interpreter = WSL でなく、かつパス区切りを持つ（deploy 注入後の実体パス形）。
  // bare（`bash` 等）は端末 Windows CC が解決できない既知死クラス（Codex round-5 high）。
  const healthyInterpreter = (i: ExpectedHookEntry): boolean =>
    !isWslLauncher(i.interpreter) && /[\\/]/.test(i.interpreter)
  for (const exp of expected) {
    const matched = byExactKey.get(
      JSON.stringify([exp.event, exp.matcher, exp.type, exp.command, exp.execForm])
    )
    if (matched && matched.length > 0) {
      // 登録一致。健全な interpreter（非 WSL の実体パス）が 1 件も居ない場合は hazard —
      // WSL は無条件死（$HOME 別環境）、bare は Windows 死（Git Bash not found・46fc171）。
      // 重複登録に健全な interpreter が 1 件でも居れば発火は保たれるため hazard にしない
      // （Codex round-5: 抑止側は non-bare かつ non-WSL であることを要求）。
      if (exp.execForm && !matched.some(healthyInterpreter)) {
        if (matched.some((i) => isWslLauncher(i.interpreter))) {
          badInterpreterHazards.push(`${exp.event}: ${exp.command}`)
        } else {
          bareInterpreterHazards.push(`${exp.event}: ${exp.command}`)
        }
      } else if (
        exp.execForm &&
        exp.quotedArg &&
        !matched.some((i) => i.quotedArg && healthyInterpreter(i))
      ) {
        // quote hazard の抑止側は「クォート済み **かつ** 健全 interpreter」の生きた登録に限る。
        // 死んだ quoted 重複（WSL/bare の quoted）は発火しないため抑止資格が無い —
        // healthy-unquoted + dead-quoted の混在で緑になると、空白入り HOME で全登録が
        // 不発なのに ok という green-but-dead になる（Codex round-6 high）。
        // 副作用: POSIX の bare-quoted は実際は発火するが抑止資格を持たない（空白入り HOME の
        // POSIX 混在重複という極端例で偽赤方向に倒れる）。本検証器の使命上、安全側で許容。
        unquotedArgHazards.push(`${exp.event}: ${exp.command}`)
      }
      continue
    }
    const sameCommand = installed.filter(
      (i) => i.event === exp.event && i.command === exp.command
    )
    if (sameCommand.length === 0) {
      missing.push(`${exp.event}: ${exp.command}`)
    } else {
      const found = sameCommand
        .map(
          (i) =>
            `matcher '${i.matcher}'` +
            (i.type !== exp.type ? ` type '${i.type}'` : '') +
            (i.execForm !== exp.execForm ? ` 起動形 ${shape(i.execForm)}` : '')
        )
        .join(', ')
      matcherMismatches.push(
        `${exp.event}: ${exp.command}（期待 matcher '${exp.matcher}'${exp.execForm ? ' 起動形 exec' : ''} に対し実側 ${found}）`
      )
    }
  }
  return {
    valid: missing.length === 0 && matcherMismatches.length === 0,
    missing,
    matcherMismatches,
    unquotedArgHazards,
    badInterpreterHazards,
    bareInterpreterHazards
  }
}

/**
 * 未クォート legacy exec 登録（unquotedArgHazards）の実環境における危険度を判定する純関数。
 * - HOME に空白を含む環境: 未クォート `$HOME/...` は bash -c の word splitting で **不発**
 *   （実 bash probe テストで実証済み）＝security hook が死んでいるのに登録一致で緑、という
 *   green-but-dead を防ぐため 'error'（Codex adversarial 再レビュー high 対応）。
 * - HOME に空白が無い環境: クォート有無は同一実行＝実害なし。golden 再 deploy でクォート形へ
 *   更新される移行期 legacy として 'ok'（既存実機を偽アラームで赤化しない）。
 */
export function quoteHazardSeverity(hazardCount: number, home: string): 'ok' | 'error' {
  return hazardCount > 0 && /\s/.test(home) ? 'error' : 'ok'
}

export interface HooksCoverageStatus {
  status: 'ok' | 'warn' | 'error'
  detail: string
}

/**
 * hooks coverage の Health 表示（status/detail）を決める純関数（electron 非依存・テスト可能）。
 * 判定順序は worst-first で固定する:
 *   missing(error) → WSL interpreter(error・無条件) → bare interpreter(error・win32 のみ) →
 *   quote hazard が本環境で error → mismatch(warn) → legacy hazard の ok 注記 → ok。
 * hazard の error 判定を mismatch より先に置くのは、matcher/type 不一致（warn）が併存すると
 * 「既知不発」の error が warn に飲まれて隠れるため（Codex round-3 high 対応。
 * warn は error を隠してはならない）。
 */
export function hooksCoverageStatus(
  cov: HooksCoverageResult,
  home: string,
  total: number,
  activeTemplate: string,
  platform: string
): HooksCoverageStatus {
  if (cov.missing.length > 0) {
    return {
      status: 'error',
      detail: `golden hook 登録 ${cov.missing.length}/${total} 件 欠落（先頭: ${cov.missing[0]}）`
    }
  }
  if (cov.badInterpreterHazards.length > 0) {
    // WSL bash は HOME の空白有無に依らず hook 不発（$HOME が別ファイルシステム）＝無条件 error
    return {
      status: 'error',
      detail: `WSL bash（System32）で登録された hook ${cov.badInterpreterHazards.length} 件は不発（$HOME が別環境に解決）。golden 再デプロイで Git Bash 実体パスへ更新せよ（先頭: ${cov.badInterpreterHazards[0]}）`
    }
  }
  if (cov.bareInterpreterHazards.length > 0 && platform === 'win32') {
    // bare `bash` は端末起動 Windows CC が解決できず不発（46fc171「Git Bash not found」実証）。
    // deploy の実体パス注入を経ていない登録（手動コピー golden・注入失敗の残骸）＝ Windows では error。
    // POSIX は PATH 解決で発火するため素通し（Codex round-5 high 対応）。
    return {
      status: 'error',
      detail: `bare bash で登録された hook ${cov.bareInterpreterHazards.length} 件は端末起動 Windows CC で不発（Git Bash not found）。golden 再デプロイで実体パスを注入せよ（先頭: ${cov.bareInterpreterHazards[0]}）`
    }
  }
  if (quoteHazardSeverity(cov.unquotedArgHazards.length, home) === 'error') {
    const extra =
      cov.matcherMismatches.length > 0
        ? `。他に matcher/type 不一致 ${cov.matcherMismatches.length} 件`
        : ''
    return {
      status: 'error',
      detail: `未クォート exec 登録 ${cov.unquotedArgHazards.length} 件は空白入り HOME で不発（bash word splitting）。golden 再デプロイでクォート形へ更新せよ（先頭: ${cov.unquotedArgHazards[0]}）${extra}`
    }
  }
  if (cov.matcherMismatches.length > 0) {
    return {
      status: 'warn',
      detail: `登録は全件あるが matcher/type 不一致 ${cov.matcherMismatches.length} 件（先頭: ${cov.matcherMismatches[0]}）`
    }
  }
  if (cov.unquotedArgHazards.length > 0) {
    return {
      status: 'ok',
      detail: `golden 期待 ${total} 件すべて登録済（未クォート legacy ${cov.unquotedArgHazards.length} 件は本環境 HOME 空白なしで実行等価・再デプロイで解消）`
    }
  }
  return {
    status: 'ok',
    detail: `golden 期待 ${total} 件すべて登録済（template=${activeTemplate}）`
  }
}
