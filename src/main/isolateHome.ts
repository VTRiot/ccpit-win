import { app, session } from 'electron'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  ISOLATED_GOLDEN_REPO_ENV_VAR,
  ISOLATION_ENV_VAR,
  ISOLATION_EXIT_CODE,
  checkIsolatedGoldenRepo,
  REAL_HOME_ENV_VAR,
  applyIsolation,
  detectPreApplyDrift,
  planIsolation,
  realish,
  verifyIsolation
} from './isolation'
import {
  installChildProcessGuard,
  installNetGuard,
  installWebRequestGuard,
  type ChildProcessLike,
  type NetLike
} from './isolationGuards'

/**
 * 隔離起動の入口。**index.ts の最初の import** として読まれ、どの製品モジュールより先に評価される
 * （appConfig.ts・projects.ts 等は、読込時に `.ccpit` の場所を定数で確定するため）。
 *
 * 環境変数 CCPIT_ISOLATED_HOME が**未設定なら何もしない**（普段の起動は今までと同じ）。
 * 設定済みで不正なら、本物のホームへ落ちずに終了コード 3 で起動を拒否する。
 * launcher（scripts/dev-isolated.cjs）は scripts/isolation-bootstrap.cjs を先に走らせて同じ表を適用済みにし、
 * ここではその食い違いを検出する。
 */

function refuse(reason: string): never {
  process.stderr.write(`[CCPIT-Isolation] REFUSED: ${reason}\n`)
  process.exit(ISOLATION_EXIT_CODE)
}

const explicit = process.env[ISOLATION_ENV_VAR]
const realHome = process.env[REAL_HOME_ENV_VAR] || homedir()
const plan = planIsolation({ explicit, realHome, canonicalize: realish })

if (plan.mode === 'refused') refuse(plan.reason)

if (plan.mode === 'on') {
  const bootstrapped = process.env.CCPIT_ISOLATION_BOOTSTRAPPED
  if (bootstrapped === undefined) {
    // launcher（scripts/dev-isolated.cjs）を経由しない手動起動: `--user-data-dir` も書込み関門も無いので、
    // Chromium が本物の既定 userData に空のフォルダを作りうる（中身は書かない）。
    console.warn(
      '[CCPIT-Isolation] WARNING: launcher を経由していません（--user-data-dir・書込み関門なし）。隔離の確かめには scripts/dev-isolated.cjs を使ってください'
    )
  } else {
    if (realish(bootstrapped).toLowerCase() !== plan.root.toLowerCase()) {
      refuse(`bootstrap の root（${bootstrapped}）と製品側の root（${plan.root}）が違います`)
    }
    const drift = detectPreApplyDrift(plan, { app })
    if (drift.length > 0) refuse(drift.join(' / '))
  }

  applyIsolation(plan, { env: process.env, app, mkdirSync, homedir })
  const errs = verifyIsolation(plan, { app, homedir })
  if (errs.length > 0) refuse(errs.join(' / '))

  // golden のリポジトリの複製（CCPIT_L0_004 W8）: 設定されていて不正なら起動を拒否する。
  // 未設定なら起動は続け、golden のリポジトリを使う操作だけが findRepoRootDir() で止まる。
  const goldenRepo = process.env[ISOLATED_GOLDEN_REPO_ENV_VAR]
  if (goldenRepo !== undefined) {
    const v = checkIsolatedGoldenRepo(goldenRepo, plan.root, { canonicalize: realish, exists: existsSync })
    if (!v.ok) refuse(v.reason)
  }

  const eventsFile = join(plan.root, 'isolation-events.jsonl')
  const log = (ev: Record<string, unknown>): void => {
    try {
      appendFileSync(eventsFile, JSON.stringify(ev) + '\n')
    } catch {
      /* 記録できなくても隔離自体は続ける（標準出力にも残す） */
    }
    if (ev.denied === true) console.log(`[CCPIT-Isolation] denied ${JSON.stringify(ev)}`)
  }

  installChildProcessGuard(
    process.getBuiltinModule('node:child_process') as unknown as ChildProcessLike,
    log
  )
  installNetGuard(process.getBuiltinModule('node:net') as unknown as NetLike, log)

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  const exempt: string[] = []
  try {
    if (rendererUrl) exempt.push(new URL(rendererUrl).origin)
  } catch {
    /* 不正な URL は exempt にしない */
  }
  app.on('session-created', (s) => installWebRequestGuard(s, log, exempt))
  void app.whenReady().then(() => installWebRequestGuard(session.defaultSession, log, exempt))

  console.log(
    `[CCPIT-Isolation] active root=${plan.root} home=${app.getPath('home')} userData=${app.getPath('userData')}`
  )
}
