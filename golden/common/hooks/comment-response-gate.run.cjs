#!/usr/bin/env node
/*
 * comment-response-gate.run.cjs — comment-response-gate.sh の足場（bash）を Node へ移した実体（CCPIT_L0_009）。
 *
 * 呼ばれ方: comment-response-gate.sh →（exec）→ comment-response-gate.cjs（入口の殻）→ 本ファイルの main()。
 *   main() は標準出力に直接書かず、出すべき Buffer（無ければ null）を返す。殻が成功した後に 1 回だけ書く。
 *
 * 判定の核は comment-response-detect.cjs（変更なし）。本ファイルは「今 block すべきか」だけを担う:
 *   stop_hook_active / mode 解決 / soft の sentinel（同一セッションにつき 1 回）。
 *
 * 旧 .sh と **入力から出力・副作用まで同一** であること（試験: stopGateEquivalenceCR.test.ts）。
 * そのため bash の細部を意図して写している:
 *   - `$(...)` は NUL を捨て、末尾の改行を全部落とす → 入力・検出核の出力の両方に同じ規則を適用
 *   - `grep -q` / `grep -o | head -1` は行単位 → 行で分けて見る
 *   - stop_hook_active は **どこかの行** に true があれば通過（他の 3 本は最初の true|false の 1 つだけ）
 *   - mode は `node -e` の require（JSON 全体の解析。BOM・重複キー・型違いの扱いが旧と同じ）。os.homedir() と HOME は別物
 *   - session_id は **除去しない**（`/`・`..`・`:` をそのまま sentinel のパスに使う）。他の 3 本は記号を除去する
 *   - `${X:-d}` は空文字も既定に落とす → `env.X || d`
 *   - 検出核の場所は `$(cd "$(dirname "$0")" && pwd)`（$0 の形で変わる）→ 第 4 引数の $0 から同じ式で解く
 *   - mkdir / touch の失敗は無視する（旧は 2>/dev/null）
 * fail-open の向き: どんな例外も無出力（旧も途中の失敗で block せず exit 0 だった）。
 *
 * 出力方式: exit 0 + JSON（decision: "block"）。exit 2 は使わない（公式仕様: exit 2 は stdout JSON を無視する）。
 * 引数: argv[2] = bash の $HOME（空文字でもそのまま使う）、argv[3] = $HERE、argv[4] = $0。
 */
'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const cp = require('child_process')

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

const MODES = new Set(['soft', 'strict', 'off'])

/** `grep -q '"stop_hook_active"SP*:SP*true'`: どこかの行に true があれば真（false の後の true でも、`trueish` のように後ろが続いても） */
function anyActiveTrue(lines) {
  const re = new RegExp('"stop_hook_active"' + SP + '*:' + SP + '*true')
  for (const l of lines) if (re.test(l)) return true
  return false
}

/**
 * mode 解決: 旧は `node -e 'try{const c=require(require("os").homedir()+"/.ccpit/app-config.json");...}catch{strict}'`。
 * 同じく require を使う（BOM の除去・同じキーが 2 回あれば後勝ち・オブジェクトでない値・JSON でない・無い・ディレクトリ → すべて旧と同じ結果）。
 * 同じ process で 2 回呼ばれても古い内容を返さないよう、require のキャッシュは先に捨てる。
 */
function resolveMode(osHome) {
  try {
    const p = osHome + '/.ccpit/app-config.json'
    try {
      delete require.cache[require.resolve(p)]
    } catch {
      /* 解決できない → 下の require が投げて strict */
    }
    const m = require(p).commentResponseGateMode
    return m === 'off' || m === 'soft' || m === 'strict' ? m : 'strict'
  } catch {
    return 'strict'
  }
}

/**
 * MSYS の dirname: 末尾の区切りを除き、最後の要素を落とす。区切りが無ければ '.'。
 * 区切りは / と \ の両方（実測: MSYS の dirname 'C:\x\y.sh' は 'C:\x'。試験は Windows の \ 区切りで直接起動する）。
 */
function dirnameLikeBash(p) {
  if (p === '') return '.'
  const sep = (c) => c === '/' || c === '\\'
  let end = p.length
  while (end > 1 && sep(p[end - 1])) end--
  const s = p.slice(0, end)
  if (s.length === 1 && sep(s[0])) return s
  let i = s.length - 1
  while (i >= 0 && !sep(s[i])) i--
  if (i < 0) return '.'
  let j = i
  while (j > 0 && sep(s[j - 1])) j--
  return j === 0 ? s[0] : s.slice(0, j)
}

/**
 * UTF-8 として正しい並びは文字に、正しくないバイトは 1 バイト = 1 文字（latin1）にする。
 * 実測: 旧の bash が UTF-8 として不正なバイト列（0xff 0xfe）をファイル名に渡すと、MSYS は 'ÿþ' の名前を作った。
 */
function decodeLenient(buf) {
  let out = ''
  let i = 0
  while (i < buf.length) {
    const b = buf[i]
    let n = 0
    let cp = 0
    if (b < 0x80) {
      out += String.fromCharCode(b)
      i++
      continue
    } else if (b >= 0xc2 && b <= 0xdf) {
      n = 1
      cp = b & 0x1f
    } else if (b >= 0xe0 && b <= 0xef) {
      n = 2
      cp = b & 0x0f
    } else if (b >= 0xf0 && b <= 0xf4) {
      n = 3
      cp = b & 0x07
    } else {
      out += String.fromCharCode(b)
      i++
      continue
    }
    let ok = i + n < buf.length // 続きのバイトが n 個ある
    if (ok) {
      for (let k = 1; k <= n; k++) {
        const c = buf[i + k]
        if (c < 0x80 || c > 0xbf) ok = false
        else cp = (cp << 6) | (c & 0x3f)
      }
    }
    // 過長・サロゲート・範囲外は不正
    if (ok && ((n === 2 && (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff))) || (n === 3 && (cp < 0x10000 || cp > 0x10ffff)))) ok = false
    if (ok) {
      out += String.fromCodePoint(cp)
      i += n + 1
    } else {
      out += String.fromCharCode(b)
      i++
    }
  }
  return out
}

/**
 * session_id を sentinel のファイル名にする。旧は bash が UTF-8 のバイト列のままファイル名に渡し、MSYS が解釈した:
 *   - バイト列は UTF-8 の文字として扱われる（日本語の名前になる）→ latin1 で持っている値を UTF-8 に戻す
 *   - Windows のファイル名で使えない文字 " * : < > ? | と制御文字は、MSYS が U+F000 + 文字コード に写す
 *   - 末尾が区切り（/ か \）のパスは「ディレクトリ」を指すので、無いディレクトリへの touch は失敗し、-f も偽
 * 戻り値が null なら sentinel は使えない（-f 偽・touch 失敗と同じ扱い）。
 */
function sentinelName(sid) {
  if (/[\\/]$/.test(sid)) return null
  const s = decodeLenient(Buffer.from(sid, 'latin1'))
  return s.replace(/["*:<>?|\u0001-\u001f]/g, (ch) => String.fromCharCode(0xf000 + ch.charCodeAt(0)))
}

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** `DIR=$(cd "$(dirname "$0")" && pwd)`: cd できなければ空（検出核のパスは '/comment-response-detect.cjs' になり、存在せず空出力）。 */
function resolveDir(arg0, fallbackHere) {
  const d = dirnameLikeBash(arg0 !== undefined ? String(arg0) : String(fallbackHere) + '/x')
  const abs = path.resolve(d)
  return isDir(abs) ? abs : ''
}

/** io は試験で標準入力を差し替えるための口（本番は渡さない）。 */
function run(io) {
  const osHome = os.homedir()
  const home = process.argv.length > 2 ? process.argv[2] : osHome
  const env = process.env

  // 何を判定するより先に標準入力を読み切る（旧は最初に $(cat) で読み切った）
  const input = commandSubstitution(readAllStdin(io))
  const lines = input.toString('latin1').split('\n')

  // 内側ループ防止（mode 解決より前。旧もこの順）
  if (anyActiveTrue(lines)) return null

  const mode = resolveMode(osHome)
  if (mode === 'off') return null

  // session_id: 最初の一致の値。除去しない
  const sid = firstQuotedValue(lines, 'session_id') || ''

  const name = sentinelName(sid)
  let sdir = ''
  if (mode === 'soft') {
    sdir = env.CRG_SENTINEL_DIR || home + '/.claude/hooks/.crg-sentinels'
    if (sid !== '' && name !== null && isFile(sdir + '/' + name)) return null
  }

  // 検出核へ委譲（純粋判定）。hook 入力 JSON をそのまま流し、向こうで JSON.parse させる（所有権フィルタ）。
  const dir = resolveDir(process.argv[4], process.argv[3])
  const detect = dir + '/comment-response-detect.cjs'
  const r = cp.spawnSync(process.execPath, [detect], {
    input,
    env: { ...env, CRG_STDIN_JSON: '1' },
    stdio: ['pipe', 'pipe', 'ignore'],
    maxBuffer: Infinity,
    windowsHide: true
  })
  const out = commandSubstitution(r.stdout || Buffer.alloc(0))
  if (out.length === 0) return null

  if (mode === 'soft' && sid !== '') {
    try {
      fs.mkdirSync(sdir, { recursive: true })
    } catch {
      /* 無視 */
    }
    if (name !== null) touch(sdir + '/' + name)
  }
  return Buffer.concat([out, Buffer.from('\n')])
}

/** 出すべき Buffer（無ければ null）を返す。例外は握りつぶして null（fail-open）。 */
function main() {
  try {
    return run()
  } catch {
    return null
  }
}

module.exports = {
  main,
  run,
  anyActiveTrue,
  resolveMode,
  dirnameLikeBash,
  sentinelName,
  decodeLenient,
  resolveDir,
  readAllStdin,
  commandSubstitution,
  firstQuotedValue,
  STDIN_EAGAIN_BUDGET_MS
}
