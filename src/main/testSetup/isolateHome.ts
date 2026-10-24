import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, parse, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll } from 'vitest'

/**
 * 試験ファイルごとに、その import より前に走る。
 * 1) このプロセスのホームを偽ホーム（一時フォルダ）へ差し替え、製品コードの既定の場所（homedir() 由来）を本物から切り離す
 * 2) 本物のデータへの書き込みを止めて記録する関門を有効にし、node の子プロセスにも継承させる
 * 3) ファイルの前後で、ホームが偽ホームのままであることと、関門に記録が無いことを確かめる（あれば、そのファイルを失敗にする）
 */
type Guard = {
  installWriteGuard: (o: { realHome: string; logPath: string }) => unknown
  isInstalled: () => boolean
  logSize: (p: string) => number
  readViolations: (p: string, from: number) => string[]
}

const sandboxHome = process.env.CCPIT_TEST_SANDBOX_HOME
const realHome = process.env.CCPIT_TEST_REAL_HOME
const logDir = process.env.CCPIT_GUARD_LOG_DIR
if (!sandboxHome || !realHome || !logDir) {
  throw new Error(
    '[ccpit-test-isolation] globalSetup が走っていません（vitest.config.ts の globalSetup を確認）'
  )
}
// 記録は worker（プロセス）ごとに別ファイル。子の node は環境変数で同じ記録先を継承する
const logPath = join(logDir, `${process.pid}.jsonl`)
process.env.CCPIT_GUARD_LOG = logPath

const nodeRequire = createRequire(import.meta.url)
const guardPath = fileURLToPath(new URL('./realDataWriteGuard.cjs', import.meta.url))
const guard = nodeRequire(guardPath) as Guard

const parsed = parse(sandboxHome)
process.env.USERPROFILE = sandboxHome
process.env.HOME = sandboxHome
process.env.HOMEDRIVE = parsed.root.replace(/[\\/]$/, '')
process.env.HOMEPATH = sandboxHome.slice(parsed.root.length - 1)
process.env.APPDATA = join(sandboxHome, 'AppData', 'Roaming')
process.env.LOCALAPPDATA = join(sandboxHome, 'AppData', 'Local')
process.env.XDG_CONFIG_HOME = join(sandboxHome, '.config')
for (const d of [process.env.APPDATA, process.env.LOCALAPPDATA, process.env.XDG_CONFIG_HOME]) {
  mkdirSync(d, { recursive: true })
}
// 一時領域も偽ホームの下へ（CCPIT_L0_004 W1）。os.tmpdir() は呼ぶたびに TEMP/TMP/TMPDIR を読む。
// 子プロセス（git・契約実行ツール）にも継承される
const sandboxTmp = process.env.CCPIT_TEST_SANDBOX_TMP || join(sandboxHome, 'Temp')
mkdirSync(sandboxTmp, { recursive: true })
process.env.TEMP = sandboxTmp
process.env.TMP = sandboxTmp
process.env.TMPDIR = sandboxTmp

guard.installWriteGuard({ realHome, logPath })

const preload = `--require "${guardPath.replace(/\\/g, '/')}"`
if (!(process.env.NODE_OPTIONS ?? '').includes(preload)) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} ${preload}`.trim()
}

function assertHomeIsSandbox(where: string): void {
  const same = (a: string, b: string): boolean =>
    resolve(a).toLowerCase() === resolve(b).toLowerCase()
  if (!same(homedir(), sandboxHome as string)) {
    throw new Error(
      `[ccpit-test-isolation] ${where}: os.homedir() が偽ホームではありません（${homedir()}）。試験が USERPROFILE/HOME を戻し忘れたか、os をモックしています`
    )
  }
}

let logOffsetAtStart = 0
beforeAll(() => {
  assertHomeIsSandbox('beforeAll')
  if (!guard.isInstalled()) {
    throw new Error('[ccpit-test-isolation] 書き込み関門がこの worker に入っていません')
  }
  logOffsetAtStart = guard.logSize(logPath)
})
afterAll(() => {
  assertHomeIsSandbox('afterAll')
  const violations = guard.readViolations(logPath, logOffsetAtStart)
  if (violations.length > 0) {
    throw new Error(
      `[ccpit-test-isolation] 本物のデータへの書き込み試行を ${violations.length} 件止めました:\n${violations.slice(0, 10).join('\n')}`
    )
  }
})
