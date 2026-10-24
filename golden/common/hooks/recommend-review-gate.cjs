#!/usr/bin/env node
/*
 * recommend-review-gate.cjs — recommend-review-gate.sh の足場（bash）を Node へ移した実体。
 *
 * なぜ分けたか（CCPIT_L0_006）:
 *   旧 .sh は grep / head / sed / tr / find / mkdir / touch / cat とコマンド置換で子プロセスを約 25 回起こしていた。
 *   MSYS ではプロセス生成が機械全体でほぼ直列で、同時に走る Stop hook が増えると 1 回 5 秒が 17 秒に伸びる。
 *   入口の .sh は fork ゼロの薄い殻に縮め、旧の足場の判断をここへ **同じ意味で** 写した。
 *
 * 判定の核は recommend-review-detect.cjs（変更なし）。本ファイルは「今 block すべきか」だけを担う:
 *   mode 解決 / off / stop_hook_active / 検出核の不在 / soft の sentinel（同一セッション×同一未レビュー集合で 1 回）。
 *
 * 旧 .sh と **入力から出力・副作用まで同一** であること（試験: recommendReviewGateEquivalence.test.ts）。
 * そのため bash の細部を意図して写している:
 *   - `$(...)` は末尾の改行を全部落とし、NUL を捨てる → 入力・検出核の出力の両方に同じ規則を適用
 *   - `grep -oE | head -1` は行単位・最初の一致 → 行で分けて最初の一致だけ見る
 *   - `[[:space:]]` は ASCII の空白類。JS の \s（Unicode 空白を含む）は使わない
 *   - `${X:-d}` は空文字も既定に落とす → `env.X || d`
 *   - `find -mtime +7` は経過日数の小数部を切り捨てて 7 を超える（= 8 日以上）
 *   - mkdir / find / touch の失敗は無視する（旧は 2>/dev/null）
 * fail-open の向き: どんな例外も無出力・exit 0（旧も途中の失敗で block せず exit 0 だった）。
 *
 * 出力方式: exit 0 + JSON（decision: "block"）。exit 2 は使わない（公式仕様: exit 2 は stdout JSON を無視する）。
 * 引数: argv[2] = bash の $HOME（空文字でもそのまま使う。旧の `$HOME/.ccpit/...` と同じ素材から既定パスを作る）。
 */
'use strict'
const fs = require('fs')
const os = require('os')
const cp = require('child_process')

const DEFAULT_MODE = 'soft'
const SENTINEL_RETENTION_DAYS = 7
const MS_PER_DAY = 86400 * 1000
/** POSIX の [[:space:]]（C ロケール）。JS の \s は Unicode 空白・BOM を含むので使わない。 */
const SP = '[ \\t\\n\\v\\f\\r]'
const MODES = new Set(['soft', 'strict', 'off'])

/**
 * 標準入力が一時的に読めない（EAGAIN）ときに待つ上限。Stop hook の timeout は 10 秒（settings の登録）なので、その半分。
 * 旧の `cat` は read エラーで終わって手元の分を入力とした。無期限に待つとホストが非ブロッキング stdin を渡したとき hook が固まる。
 */
const STDIN_EAGAIN_BUDGET_MS = 5000
const STDIN_EAGAIN_POLL_MS = 5
const nowMs = () => Date.now()
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/**
 * 標準入力を EOF まで読む（何を判定するより先に。旧は最初に $(cat) で読み切った）。
 * readSync / now / sleep は試験で差し替えられる（EAGAIN の注入）。
 */
function readAllStdin(io) {
  const readSync = (io && io.readSync) || ((buf) => fs.readSync(0, buf, 0, buf.length, null))
  const now = (io && io.now) || nowMs
  const sleep = (io && io.sleep) || sleepMs
  const chunks = []
  const buf = Buffer.alloc(1 << 16)
  let waitedSince = null
  for (;;) {
    let n
    try {
      n = readSync(buf)
    } catch (e) {
      if (e && e.code === 'EAGAIN') {
        if (waitedSince === null) waitedSince = now()
        if (now() - waitedSince >= STDIN_EAGAIN_BUDGET_MS) break // 待ちきれない: 読めた分を入力とする（fail-open）
        sleep(STDIN_EAGAIN_POLL_MS)
        continue
      }
      break // EOF / EBADF など: そこまでを入力とする
    }
    waitedSince = null
    if (n === 0) break
    chunks.push(Buffer.from(buf.subarray(0, n)))
  }
  return Buffer.concat(chunks)
}

/**
 * bash の `$(...)` と同じ値規則: NUL を捨て、末尾の改行（連続）を全部落とす。
 * MSYS の bash は、末尾の改行が CRLF のとき CR も一緒に落とす（実測: 'a\r\nb\r\n\r\n' → 'a\r\nb'、
 * 改行を伴わない末尾の CR は残る）。旧と同じバイト列を検出核へ渡すため、この癖も写す。
 */
function commandSubstitution(buf) {
  const b = buf.includes(0) ? Buffer.from(buf.filter((x) => x !== 0)) : buf
  let end = b.length
  while (end > 0 && b[end - 1] === 0x0a) {
    end--
    if (end > 0 && b[end - 1] === 0x0d) end--
  }
  return b.subarray(0, end)
}

const isFile = (p) => {
  try {
    return fs.statSync(p).isFile() // [ -f ] と同じくシンボリックリンクを辿る
  } catch {
    return false
  }
}

/** `grep -oE '"key"SP*:SP*"[^"]*"' | head -1` の値。行単位で最初の一致。無ければ null。 */
function firstQuotedValue(lines, key) {
  const re = new RegExp('"' + key + '"' + SP + '*:' + SP + '*"([^"]*)"')
  for (const l of lines) {
    const m = re.exec(l)
    if (m) return m[1]
  }
  return null
}

/**
 * GNU grep 3.0（MSYS 同梱）のバイナリ検知の単位。実測（NUL の位置を変えて grep -oE を当てた）:
 * NUL が先頭 65535 バイト以内なら全体をバイナリ扱い、65536 以降なら NUL を含む 64KiB の塊より前の一致は通常に出る。
 */
const GREP_BUFFER_BYTES = 65536
/** バイナリ扱いで一致が出るとき grep が stdout に出す "Binary file ... matches"。値としては常に不正。 */
const GREP_BINARY_MATCH = '\u0000binary-file-matches'

/**
 * `grep -oE '"key"SP*:SP*"[^"]*"' FILE | head -1` の値（捕捉群）。
 * 返り値: 文字列 = 値 / null = 一致なし / GREP_BINARY_MATCH = バイナリ扱いの一致メッセージ。
 */
function grepFirstValue(buf, key) {
  const nul = buf.indexOf(0)
  let clean = buf
  let rest = Buffer.alloc(0)
  if (nul >= 0) {
    let cleanLen = nul < GREP_BUFFER_BYTES ? 0 : Math.floor(nul / GREP_BUFFER_BYTES) * GREP_BUFFER_BYTES
    // 塊の境目をまたぐ行は次の塊（NUL を含む側）へ持ち越される
    if (cleanLen > 0) cleanLen = buf.lastIndexOf(0x0a, cleanLen - 1) + 1
    clean = buf.subarray(0, cleanLen)
    rest = buf.subarray(cleanLen)
  }
  const v = firstQuotedValue(clean.toString('latin1').split('\n'), key)
  if (v !== null) return v
  if (rest.length > 0 && firstQuotedValue(rest.toString('latin1').split('\n'), key) !== null) return GREP_BINARY_MATCH
  return null
}

/** mode 解決。recommendReviewMode 優先 → 空なら emissionMode → 非空の不正値・無指定は既定 soft。 */
function resolveMode(configPath) {
  let mode = ''
  if (isFile(configPath)) {
    let buf = null
    try {
      buf = fs.readFileSync(configPath)
    } catch {
      /* 読めない → grep が失敗して空 */
    }
    if (buf) {
      mode = grepFirstValue(buf, 'recommendReviewMode') || ''
      if (mode === '') mode = grepFirstValue(buf, 'emissionMode') || ''
    }
  }
  return MODES.has(mode) ? mode : DEFAULT_MODE
}

/**
 * find "$dir" -type f -name '*.seen' -mtime +RETENTION -delete と同じ範囲を消す（失敗は無視）。
 * find は経過時間を **秒未満まで** 見て「24 時間単位に切り捨てた日数が RETENTION を超える」= 8 日以上で一致する
 * （実測: mtime を 8 日前の 0.99 秒後に置くと、find が走る時刻の小数部しだいで消えたり残ったりした）。
 * よって秒に丸めず、ミリ秒の経過で同じ式を当てる。now は試験で差し替えられる。
 */
function sweepOldSentinels(dir, now) {
  const nowAt = now === undefined ? Date.now() : now
  const walk = (d) => {
    let ents
    try {
      ents = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      const full = d + '/' + e.name
      if (e.isDirectory()) {
        walk(full) // シンボリックリンクの dir は isDirectory() が偽 = 辿らない（find -P と同じ）
      } else if (e.isFile() && e.name.endsWith('.seen')) {
        try {
          const ageDays = Math.floor((nowAt - fs.lstatSync(full).mtimeMs) / MS_PER_DAY)
          if (ageDays > SENTINEL_RETENTION_DAYS) fs.unlinkSync(full)
        } catch {
          /* 無視 */
        }
      }
    }
  }
  let root
  try {
    root = fs.lstatSync(dir)
  } catch {
    return
  }
  if (root.isDirectory()) walk(dir)
}

/** touch: 在れば mtime 更新、無ければ作る（壊れたシンボリックリンクは先を作る）。失敗は無視。 */
function touch(p) {
  const now = new Date()
  try {
    fs.utimesSync(p, now, now)
  } catch {
    try {
      fs.closeSync(fs.openSync(p, 'a'))
    } catch {
      /* 無視 */
    }
  }
}

function main() {
  const home = process.argv.length > 2 ? process.argv[2] : os.homedir()
  const env = process.env
  const CONFIG = env.RRG_CONFIG || home + '/.ccpit/app-config.json'
  const GATE_DIR = env.RRG_GATE_DIR || home + '/.ccpit/.recommend-review-gate'
  const DETECT = env.RRG_DETECT || home + '/.claude/hooks/recommend-review-detect.cjs'

  const input = commandSubstitution(readAllStdin())
  const lines = input.toString('latin1').split('\n')

  const mode = resolveMode(CONFIG)
  if (mode === 'off') return

  if (firstActive(lines) === 'true') return

  if (!isFile(DETECT)) return

  // 検出核へ委譲（純粋判定）。hook 入力 JSON をそのまま流し、向こうで JSON.parse させる（所有権フィルタ）。
  const r = cp.spawnSync(process.execPath, [DETECT], {
    input,
    env: { ...env, RRG_STDIN_JSON: '1' },
    stdio: ['pipe', 'pipe', 'ignore'],
    maxBuffer: Infinity,
    windowsHide: true
  })
  const out = commandSubstitution(r.stdout || Buffer.alloc(0))
  if (out.length === 0) return

  const sessionId = firstQuotedValue(lines, 'session_id') || ''
  const safeId = sessionId.replace(/[^A-Za-z0-9_-]/g, '')
  const fp = extractFingerprint(out.toString('latin1').split('\n'))
  const safeFp = fp.replace(/[^A-Za-z0-9]/g, '')

  try {
    fs.mkdirSync(GATE_DIR, { recursive: true })
  } catch {
    /* 無視 */
  }
  sweepOldSentinels(GATE_DIR)

  if (safeId !== '') {
    const sentinel = GATE_DIR + '/' + safeId + '_' + safeFp + '.seen'
    if (mode === 'soft' && isFile(sentinel)) return
    if (mode === 'soft') touch(sentinel)
  }

  process.stdout.write(Buffer.concat([out, Buffer.from('\n')]))
}

/** `"stop_hook_active"SP*:SP*(true|false)` の最初の一致の true/false。 */
function firstActive(lines) {
  const re = new RegExp('"stop_hook_active"' + SP + '*:' + SP + '*(true|false)')
  for (const l of lines) {
    const m = re.exec(l)
    if (m) return m[1]
  }
  return ''
}

// fingerprint: 旧は grep の一致文字列に sed の置換（コロン以降の引用符の中身を取る式）を当てていた。2 段とも旧と同じ式で写す。
function extractFingerprint(lines) {
  const grep = new RegExp('"fingerprint"' + SP + '*:' + SP + '*"[^"]*"')
  const sed = new RegExp('^.*:' + SP + '*"([^"]*)".*$')
  for (const l of lines) {
    const m = grep.exec(l)
    if (m) {
      const s = sed.exec(m[0])
      return s ? s[1] : m[0]
    }
  }
  return ''
}

if (require.main === module) {
  process.stdout.on('error', () => {})
  try {
    main()
  } catch {
    /* fail-open: 無出力・exit 0 */
  }
  process.exitCode = 0
}

// 試験用（単体の境界試験: EAGAIN の注入・秒未満の掃除）。hook としては上の main だけが走る。
module.exports = { readAllStdin, sweepOldSentinels, commandSubstitution, STDIN_EAGAIN_BUDGET_MS }
