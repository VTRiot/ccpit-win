#!/usr/bin/env node
/*
 * skill-proposal-gate.run.cjs — skill-proposal-gate.sh の足場（bash）を Node へ移した実体（CCPIT_L0_009）。
 *
 * 構造:
 *   skill-proposal-gate.sh       入口の薄い殻。node と完全な殻 .cjs（と実体）があれば exec node、無ければ旧の bash 本体（凍結）。
 *   skill-proposal-gate.cjs      入口の殻（固定・約 30 行）。本ファイルを require して main() を呼び、返された Buffer を 1 回だけ書く。
 *   skill-proposal-gate.run.cjs  本ファイル。「今 block すべきか」の判断（旧 .sh の足場の写し）。
 *
 * 旧 .sh は grep / head / sed / tr / find / mkdir / touch / cat とコマンド置換で子プロセスを何回も起こしていた。
 * MSYS ではプロセス生成が機械全体でほぼ直列で、Stop hook が同時に走ると 1 回が数倍に伸びる。判断を 1 つの Node に移す。
 *
 * 旧 .sh と入力から出力・副作用まで同一であること（試験: stopGateEquivalenceSP.test.ts）。bash の細部を意図して写している:
 *   - `$(...)` は NUL を捨て、末尾の改行を全部落とす（MSYS は CRLF の CR も） → commandSubstitution
 *   - `grep -oE | head -1` は行単位・最初の一致 → firstQuotedValue / firstTrueFalse
 *   - `[[:space:]]` は ASCII の空白類（JS の \s は使わない）
 *   - `tr -cd 'A-Za-z0-9_-'` → sanitizeId。除去後に空なら固定名 `no-session`（skill-proposal のみ。session-summary は空のまま）
 *   - `find -mtime +7 -delete` は 8 日以上（秒未満まで見て日数を切り捨て） → sweepSentinels
 *   - mkdir / find / touch の失敗は無視する（旧は 2>/dev/null）
 * fail-open の向き: どんな例外も無出力（main は null を返す）。
 *
 * 出力方式: exit 0 + JSON（decision: "block"）。exit 2 は使わない（公式仕様: exit 2 は stdout JSON を無視する）。
 * main() は標準出力に直接書かず、出すべき Buffer（無ければ null）を返す。書くのは殻の 1 回だけ。
 * 引数: argv[2] = bash の $HOME（空文字でもそのまま使う。旧の `$HOME/.ccpit/...` と同じ素材から既定パスを作る）。
 *
 * 発火モード（~/.ccpit/app-config.json の "emissionMode"。未設定/不明 → 既定 soft）: soft=セッションにつき一度だけ block /
 * strict=毎ターン / off=何もしない。soft の「1 回」は session_id をキーにしたセンチネル（~/.ccpit/.proposal-gate/<id>.seen）で担保する。
 */
'use strict'
const fs = require('fs')
const os = require('os')

// >>> stop-gate-primitives BEGIN (4 本の足場で逐語に同一。parity 試験が sha256 を照合する。直すときは 4 本とも同時に)
const MS_PER_DAY = 86400 * 1000

/** POSIX の [[:space:]]（C ロケール）。JS の \s は Unicode 空白・BOM を含むので使わない。 */
const SP = '[ \\t\\n\\v\\f\\r]'

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

/** 掃除の保持日数（find -mtime +7 の 7）。 */
const SENTINEL_RETENTION_DAYS = 7

/**
 * find "$dir" -type f <名前の条件> -mtime +7 -delete と同じ範囲を消す（失敗は無視）。
 * nameOk(name) が真の通常ファイルだけが対象（シンボリックリンクは -type f が偽なので対象外）。
 * find は経過時間を秒未満まで見て「24 時間単位に切り捨てた日数が 7 を超える」= 8 日以上で一致する。now は試験で差し替えられる。
 * dir 自体がシンボリックリンクなら辿らない（find -P と同じ）。
 */
function sweepSentinels(dir, nameOk, now) {
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
        walk(full)
      } else if (e.isFile() && nameOk(e.name)) {
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

/**
 * [ -f "$CONFIG" ] && grep -oE '"KEY"SP*:SP*"[^"]*"' "$CONFIG" | head -1 | sed ... の値。
 * 無い・読めない・一致なし = ''。バイナリ扱いの一致メッセージはそのまま返る（呼び出し側の case で不正値として既定に落ちる）。
 */
function modeFromConfig(configPath, key) {
  if (!isFile(configPath)) return ''
  let buf
  try {
    buf = fs.readFileSync(configPath)
  } catch {
    return ''
  }
  return grepFirstValue(buf, key) || ''
}

/** echo "$INPUT" | grep -oE '"stop_hook_active"SP*:SP*(true|false)' | head -1 | grep -oE '(true|false)' の値（無ければ ''）。 */
function firstTrueFalse(lines) {
  const re = new RegExp('"stop_hook_active"' + SP + '*:' + SP + '*(true|false)')
  for (const l of lines) {
    const m = re.exec(l)
    if (m) return m[1]
  }
  return ''
}

/** tr -cd 'A-Za-z0-9_-' */
function sanitizeId(s) {
  return s.replace(/[^A-Za-z0-9_-]/g, '')
}
// <<< stop-gate-primitives END

const BLOCK_SP = "{\n  \"decision\": \"block\",\n  \"reason\": \"このセッションで skill-proposal-emitter による提案 MD がまだ出ていません。skill-proposal-emitter を発火し、Skill 化が有益な候補があれば提案 MD を、無ければ『該当なし』(adoption_label: reject) を ~/.ccpit/proposals/ に出力してから停止してください。（提案ループの起点＝センシング。emissionMode で抑制可: soft=セッション1回 / strict=毎ターン / off=無効）\"\n}\n"

const DEFAULT_MODE = 'soft'
const MODES = new Set(['soft', 'strict', 'off'])

/** emissionMode を解決する。soft|strict|off 以外（未設定・空・大文字・前後空白・バイナリ扱いの一致メッセージ）は soft。 */
function resolveMode(configPath) {
  const m = modeFromConfig(configPath, 'emissionMode')
  return MODES.has(m) ? m : DEFAULT_MODE
}

/**
 * 判断の本体。block すべきなら出力の Buffer、通すなら null。副作用（mkdir・掃除・センチネルの touch）は旧と同じ順序で行う。
 * home は bash の $HOME（空文字でもそのまま）。input は `$(cat)` 相当に整えた標準入力。now は掃除の基準時刻（試験用）。
 */
function decide(home, input, now) {
  const CONFIG = home + '/.ccpit/app-config.json'
  const GATE_DIR = home + '/.ccpit/.proposal-gate'

  const mode = resolveMode(CONFIG)
  if (mode === 'off') return null

  // stop_hook_active（補助の無限ループ防止）。最初の `true|false` が true なら通過
  const lines = input.toString('latin1').split('\n')
  if (firstTrueFalse(lines) === 'true') return null

  // session_id（記号を除去。欠落・除去後に空なら固定名）
  const sid = firstQuotedValue(lines, 'session_id')
  const safe = sanitizeId(sid === null ? '' : sid) || 'no-session'
  const sentinel = GATE_DIR + '/' + safe + '.seen'

  try {
    fs.mkdirSync(GATE_DIR, { recursive: true })
  } catch {
    /* 旧は 2>/dev/null */
  }
  sweepSentinels(GATE_DIR, (n) => n.endsWith('.seen'), now)

  // soft: このセッションで既にリマインド済みなら通過
  if (mode === 'soft' && isFile(sentinel)) return null
  // soft の初回はセンチネルを先に作る（次 stop 以降は素通り＝セッション 1 回）
  if (mode === 'soft') touch(sentinel)

  return Buffer.from(BLOCK_SP, 'utf8')
}

/** 入口。例外は全て握りつぶして null（fail-open）。opts: { argv, io, now }（試験用）。 */
function main(opts) {
  try {
    const o = opts || {}
    const argv = o.argv || process.argv
    const home = argv[2] === undefined ? os.homedir() : argv[2]
    const input = commandSubstitution(readAllStdin(o.io)) // 何を判定するより先に読み切る
    return decide(home, input, o.now)
  } catch {
    return null
  }
}

module.exports = {
  main,
  decide,
  resolveMode,
  BLOCK_SP,
  readAllStdin,
  commandSubstitution,
  firstQuotedValue,
  grepFirstValue,
  modeFromConfig,
  firstTrueFalse,
  sanitizeId,
  sweepSentinels,
  touch,
  isFile,
  STDIN_EAGAIN_BUDGET_MS
}
