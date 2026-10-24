'use strict'
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type -- node の --require で子プロセスにも読ませるため、型注釈を書けない素の CJS でなければならない */

/**
 * 本物のデータ（実ホームの .ccpit / .claude ほか）への書き込みを、書く側のプロセスの中で止めて記録する関門。
 *
 * 誰が書いたかはプロセスの中で決まる（この関門を持つプロセス＝試験のプロセスと、その node の子）。
 * 外のプロセス（CCPIT のアプリ・中継・ほかのレーンのフック）は関門を持たないので、何を書いても巻き込まない。
 *
 * 保護根は環境変数 CCPIT_GUARD_REAL_HOME（実ホーム。無ければ os.homedir()）から機械的に作る。
 * 本物か見立て（一時フォルダ）かでコードは分岐しない。
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const Module = require('module')
const { fileURLToPath } = require('url')

const STATE_KEY = Symbol.for('ccpit.realDataWriteGuard.state')

/** [名前, 保護根と照合する引数の位置, open 系のフラグ位置]。cb 版・Sync 版・promises 版を同じ表から包む。 */
const API_TABLE = [
  ['writeFile', [0]],
  ['appendFile', [0]],
  ['truncate', [0]],
  ['rename', [0, 1]],
  ['copyFile', [1]],
  ['cp', [1]],
  ['mkdir', [0]],
  ['mkdtemp', [0]],
  ['mkdtempDisposable', [0]],
  ['rm', [0]],
  ['rmdir', [0]],
  ['unlink', [0]],
  ['symlink', [1]],
  ['link', [1]],
  ['utimes', [0]],
  ['lutimes', [0]],
  ['chmod', [0]],
  ['lchmod', [0]],
  ['chown', [0]],
  ['lchown', [0]],
  ['open', [0], 1]
]

function getState() {
  if (!globalThis[STATE_KEY]) {
    globalThis[STATE_KEY] = {
      config: { roots: [], realRoots: [], logPath: null },
      wrappers: new Map(),
      patched: false,
      originalAppendFileSync: fs.appendFileSync
    }
  }
  return globalThis[STATE_KEY]
}

function rootsForRealHome(realHome) {
  const j = (...p) => path.join(realHome, ...p)
  return [
    j('.ccpit'),
    j('.claude'),
    j('.claude.json'),
    j('.config', 'ccpit'),
    j('AppData', 'Roaming', 'ccpit')
  ]
}

function norm(p) {
  let r = path.resolve(p)
  if (process.platform === 'win32') r = r.replace(/^\\\\\?\\/, '').toLowerCase()
  return r
}

function isUnder(target, root) {
  const t = norm(target)
  const r = norm(root)
  return t === r || t.startsWith(r.endsWith(path.sep) ? r : r + path.sep)
}

/**
 * 対象（まだ無くてもよい）を、最も近い既存の祖先の実パス（junction・シンボリックリンク・8.3 名を解決）に直す。
 * 結果はキャッシュしない: 後から junction・シンボリックリンクに置き換えられた経路を見逃さないため。
 */
function realish(p) {
  const abs = path.resolve(p)
  const tail = []
  let cur = abs
  for (;;) {
    let real = null
    try {
      real = fs.realpathSync.native(cur)
    } catch {
      real = null
    }
    if (real) return tail.length ? path.join(real, ...tail.reverse()) : real
    const parent = path.dirname(cur)
    if (parent === cur) return abs
    tail.push(path.basename(cur))
    cur = parent
  }
}

function underAny(target, roots) {
  for (const root of roots) if (isUnder(target, root)) return true
  return false
}

function toPath(x) {
  if (typeof x === 'string') return x
  if (Buffer.isBuffer(x)) return x.toString('utf-8')
  if (x && typeof x === 'object' && typeof x.href === 'string' && x.protocol === 'file:') {
    try {
      return fileURLToPath(x)
    } catch {
      return null
    }
  }
  return null
}

function isWriteFlag(flags) {
  if (typeof flags === 'number') {
    const c = fs.constants
    return (flags & (c.O_WRONLY | c.O_RDWR | c.O_APPEND | c.O_CREAT | c.O_TRUNC)) !== 0
  }
  return typeof flags === 'string' && /[wa+]/.test(flags)
}

function makeViolation(state, op, target) {
  const err = new Error(
    `[realDataWriteGuard] 本物のデータへの書き込みを止めました: ${op} ${target}`
  )
  err.code = 'ECCPITGUARD'
  const { logPath } = state.config
  if (logPath) {
    try {
      const stack = String(err.stack || '')
        .split('\n')
        .slice(2, 6)
        .map((s) => s.trim())
        .join(' <- ')
      state.originalAppendFileSync(
        logPath,
        JSON.stringify({ t: new Date().toISOString(), pid: process.pid, op, target, stack }) + '\n'
      )
    } catch (logErr) {
      // 記録できなくても止めることは必ず行う。記録の失敗は標準エラーへ出す（読まれれば気づける）
      try {
        process.stderr.write(
          `[realDataWriteGuard] 記録の書き込みに失敗: ${String(logErr)} / ${op} ${target}\n`
        )
      } catch {
        // 標準エラーも使えない場合は、投げるエラーで試験が失敗することに頼る
      }
    }
  }
  return err
}

/**
 * 明示の例外（CCPIT_L0_004 W8）: 隔離した自動の通しの「ビルドの段」で、ビルドの道具が設定を読むために
 * 一時に書いて消すファイルだけを通す。環境変数 CCPIT_GUARD_TRANSIENT_ALLOW（JSON の配列
 * [{ "dir": 完全なディレクトリ, "basename": ファイル名の正規表現（^…$ で固定） }]）があるときだけ働く。
 * 親ディレクトリの完全一致と、ファイル名の完全一致の両方を要求する（配下のフォルダや別名は通さない）。
 * 通した書込みは CCPIT_GUARD_TRANSIENT_LOG に残す。試験・普段の起動では設定されないので、何も変わらない。
 */
function transientAllowList() {
  const raw = process.env.CCPIT_GUARD_TRANSIENT_ALLOW
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr
      .filter((e) => e && typeof e.dir === 'string' && path.isAbsolute(e.dir) && typeof e.basename === 'string')
      .filter((e) => e.basename.startsWith('^') && e.basename.endsWith('$'))
      .map((e) => ({ dir: norm(e.dir), re: new RegExp(e.basename) }))
  } catch {
    return []
  }
}

function isTransientAllowed(state, op, p) {
  const list = transientAllowList()
  if (list.length === 0) return false
  const dir = norm(path.dirname(p))
  const base = path.basename(p)
  let hit = list.some((e) => e.dir === dir && e.re.test(base))
  if (hit) {
    // 文字列のパスだけでなく実体でも確かめる。既にある symlink / junction（その名前で別の場所を指す物）や、
    // 親の経路が別の場所へ解決される物は通さない（Codex 実装レビュー 1 巡目の high: 例外の名前の symlink で保護根へ書ける）
    try {
      if (fs.lstatSync(p).isSymbolicLink()) hit = false
    } catch {
      // まだ無いファイルは、親の経路の実体だけを確かめる
    }
    if (hit && norm(realish(p)) !== norm(p)) hit = false
  }
  if (hit && process.env.CCPIT_GUARD_TRANSIENT_LOG) {
    try {
      state.originalAppendFileSync(
        process.env.CCPIT_GUARD_TRANSIENT_LOG,
        JSON.stringify({ t: new Date().toISOString(), pid: process.pid, op, target: p }) + '\n'
      )
    } catch {
      // 記録できなくても判定は変えない
    }
  }
  return hit
}

function check(state, op, positions, flagPos, args) {
  const { roots, realRoots } = state.config
  if (roots.length === 0) return null
  if (flagPos !== undefined && !isWriteFlag(args[flagPos])) return null
  for (const pos of positions) {
    const p = toPath(args[pos])
    if (p === null) continue
    let blocked = underAny(p, roots) || underAny(p, realRoots)
    if (!blocked) {
      // 実パス解決は 1 回だけ（毎回の fs 呼び出しに乗るため、無駄に重ねない）
      const real = realish(p)
      blocked = underAny(real, realRoots) || underAny(real, roots)
    }
    if (blocked && !isTransientAllowed(state, op, p)) return makeViolation(state, op, p)
  }
  return null
}

function wrap(state, holder, holderName, prop, kind, positions, flagPos) {
  const orig = holder[prop]
  if (typeof orig !== 'function') return
  let wrapper
  if (kind === 'sync') {
    wrapper = function (...args) {
      const err = check(state, `${holderName}.${prop}`, positions, flagPos, args)
      if (err) throw err
      return orig.apply(this, args)
    }
  } else if (kind === 'promise') {
    wrapper = function (...args) {
      const err = check(state, `${holderName}.${prop}`, positions, flagPos, args)
      if (err) return Promise.reject(err)
      return orig.apply(this, args)
    }
  } else {
    wrapper = function (...args) {
      const err = check(state, `${holderName}.${prop}`, positions, flagPos, args)
      if (err) {
        const cb = args[args.length - 1]
        if (typeof cb === 'function') {
          process.nextTick(cb, err)
          return undefined
        }
        throw err
      }
      return orig.apply(this, args)
    }
  }
  state.wrappers.set(`${holderName}.${prop}`, { holder, prop, orig, wrapper })
  holder[prop] = wrapper
}

function ensurePatched(state) {
  if (state.patched) return
  for (const [name, positions, flagPos] of API_TABLE) {
    wrap(state, fs, 'fs', name, 'cb', positions, flagPos)
    wrap(state, fs, 'fs', `${name}Sync`, 'sync', positions, flagPos)
    wrap(state, fs.promises, 'fs.promises', name, 'promise', positions, flagPos)
  }
  wrap(state, fs, 'fs', 'createWriteStream', 'sync', [0])
  state.patched = true
  Module.syncBuiltinESMExports()
}

/**
 * 関門を有効にする（冪等。包みは 1 回だけ入れ、設定だけを差し替える）。
 * @param {{ realHome?: string, roots?: string[], logPath?: string|null }} [opts]
 * @returns {{ config: object, restore: () => void }} restore で直前の設定へ戻す
 */
function installWriteGuard(opts = {}) {
  const state = getState()
  const prev = state.config
  const realHome = opts.realHome || process.env.CCPIT_GUARD_REAL_HOME || os.homedir()
  // 追加の保護根（CCPIT_L0_004 W8）: 隔離した自動の通しで、本物の CCPIT のリポジトリを守る。
  // 足すだけで、本物のホームの保護根は減らさない（関門を弱めない）
  const extraRoots = (process.env.CCPIT_GUARD_EXTRA_ROOTS || '')
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && path.isAbsolute(s))
  const roots = opts.roots || [...rootsForRealHome(realHome), ...extraRoots]
  state.config = {
    roots,
    realRoots: roots.map(realish),
    logPath: opts.logPath !== undefined ? opts.logPath : process.env.CCPIT_GUARD_LOG || null
  }
  ensurePatched(state)
  return {
    config: state.config,
    restore() {
      state.config = prev
    }
  }
}

function logSize(logPath) {
  try {
    return fs.statSync(logPath).size
  } catch {
    return 0
  }
}

function readViolations(logPath, fromOffset = 0) {
  try {
    return fs
      .readFileSync(logPath)
      .subarray(fromOffset)
      .toString('utf-8')
      .split('\n')
      .filter(Boolean)
  } catch {
    return []
  }
}

/** 関門の網羅を試験するための口（包みを 1 つ外す／戻す）。 */
const testing = {
  wrappedKeys() {
    return [...getState().wrappers.keys()]
  },
  unwrap(key) {
    const w = getState().wrappers.get(key)
    if (w) w.holder[w.prop] = w.orig
    Module.syncBuiltinESMExports()
  },
  rewrap(key) {
    const w = getState().wrappers.get(key)
    if (w) w.holder[w.prop] = w.wrapper
    Module.syncBuiltinESMExports()
  }
}

function isInstalled() {
  return getState().patched
}

module.exports = {
  installWriteGuard,
  isInstalled,
  rootsForRealHome,
  isUnder,
  realish,
  logSize,
  readViolations,
  API_TABLE,
  testing
}

// node の --require で子プロセスに読ませたときは、環境変数だけで自動的に有効になる
if (process.env.CCPIT_GUARD_REAL_HOME && !getState().patched) installWriteGuard()
