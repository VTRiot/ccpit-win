import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  symlinkSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * bash.exe の在りかは製品コード（resolveBashBin）がホーム配下の scoop から探すため、ホームを偽ホームに
 * 差し替えると見つからず、フックの回帰試験が黙って skip になる。実ホームの scoop を偽ホームへ junction で
 * 見せる（読むだけ。scoop は書き込み関門の保護根の外）。実ホームに scoop が無ければ何もしない。
 * CCPIT_TEST_NO_BASH_LINK=1 は「見つからなくなったら気づけること」を確かめる実験専用の口。
 */
function linkRealScoop(realHome: string, sandboxHome: string): string | null {
  if (process.env.CCPIT_TEST_NO_BASH_LINK === '1') return null
  const realScoop = join(realHome, 'scoop')
  if (!existsSync(realScoop)) return null
  const link = join(sandboxHome, 'scoop')
  symlinkSync(realScoop, link, 'junction')
  return link
}

/** junction だけを外す（実体の scoop は消さない）。リンクでなければ何もしない。 */
function unlinkIfLink(link: string | null): void {
  if (!link) return
  try {
    if (lstatSync(link).isSymbolicLink()) rmdirSync(link)
  } catch {
    // 既に無ければ何もしない
  }
}

/**
 * 全試験の前に 1 回（vitest のメインプロセス）。試験が使う「偽ホーム」と、書き込み関門の記録フォルダを作り、
 * 環境変数で fork へ渡す。実ホームは CCPIT_GUARD_REAL_HOME があればそれ（見立てを使う確かめ用）、無ければ実際のホーム。
 * 製品モジュールは import しない（読込時に確定する定数を、ホーム差し替えの前に確定させないため）。
 */
export default function setup(): () => void {
  const realHome = process.env.CCPIT_GUARD_REAL_HOME || homedir()
  const sandboxHome = mkdtempSync(join(tmpdir(), 'ccpit-test-home-'))
  const logDir = mkdtempSync(join(tmpdir(), 'ccpit-test-guardlog-'))
  // 試験の一時領域（CCPIT_L0_004 W1・範囲外の発見 4）: 試験が os.tmpdir() に作る物を、偽ホームの下に閉じ込める。
  // 偽ホームごと teardown で消えるので、本物の一時領域に ccpit_catchup_* などが溜まらない
  const sandboxTmp = join(sandboxHome, 'Temp')
  mkdirSync(sandboxTmp, { recursive: true })

  process.env.CCPIT_TEST_SANDBOX_HOME = sandboxHome
  process.env.CCPIT_TEST_SANDBOX_TMP = sandboxTmp
  process.env.CCPIT_TEST_REAL_HOME = realHome
  process.env.CCPIT_GUARD_REAL_HOME = realHome
  process.env.CCPIT_GUARD_LOG_DIR = logDir
  const scoopLink = linkRealScoop(realHome, sandboxHome)

  return function teardown(): void {
    unlinkIfLink(scoopLink)
    const lines: string[] = []
    for (const f of readdirSync(logDir)) {
      lines.push(...readFileSync(join(logDir, f), 'utf-8').split('\n').filter(Boolean))
    }
    rmSync(sandboxHome, { recursive: true, force: true })
    if (lines.length > 0) {
      console.error(
        `[ccpit-test-isolation] 本物のデータへの書き込み試行を ${lines.length} 件止めました（記録: ${logDir}）`
      )
      for (const l of lines.slice(0, 20)) console.error(`  ${l}`)
      process.exitCode = 1
      return
    }
    rmSync(logDir, { recursive: true, force: true })
  }
}
