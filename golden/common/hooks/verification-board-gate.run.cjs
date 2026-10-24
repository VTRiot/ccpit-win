#!/usr/bin/env node
/*
 * verification-board-gate.run.cjs — verification-board-gate.sh の足場（bash）を Node へ移した実体（CCPIT_L0_009）。
 *
 * 呼ばれ方: verification-board-gate.sh →（exec）→ verification-board-gate.cjs（入口の殻）→ 本ファイルの main()。
 *   main() は標準出力に直接書かず、出すべき Buffer（無ければ null）を返す。殻が成功した後に 1 回だけ書く。
 *
 * 判定の核は verification-board-detect.cjs（変更なし）。本ファイルは「今 block すべきか」だけを担う:
 *   mode 解決 / off / stop_hook_active / 検出核の不在 / git によるコード変更検出 / soft の sentinel（同一セッションにつき 1 回）。
 *
 * 旧 .sh と **入力から出力・副作用まで同一** であること（試験: stopGateEquivalenceVB.test.ts）。
 * そのため bash の細部を意図して写している:
 *   - `$(...)` は NUL を捨て、末尾の改行を全部落とす → 入力・検出核の出力の両方に同じ規則を適用
 *   - `grep -oE | head -1` は行単位・最初の一致 → 行で分けて最初の一致だけ見る
 *   - `git status --porcelain | grep -v '\.bak' | grep -v 'CLAUDE\.local\.md' | head -1`:
 *     除外は **行の部分一致**、採るのは除外後の **先頭の 1 行**、git の終了コードは見ない（出力があれば使う）
 *   - 検出核・git の子は、旧では EOF 済みの標準入力を継承した。ここでも標準入力を継承する（/dev/null なら /dev/null のまま。実測: pipe を渡すと fd の種別が変わる）
 *   - session_id は記号を除去する（tr -cd 'A-Za-z0-9_-'）。**空のまま**（no-session に落とさない）→ 空なら dedup しない
 *   - `${X:-d}` は空文字も既定に落とす → `env.X || d`
 *   - find -mtime +7 は経過日数の小数部を切り捨てて 7 を超える（= 8 日以上）
 *   - mkdir / find / touch の失敗は無視する（旧は 2>/dev/null）
 * fail-open の向き: どんな例外も無出力（旧も途中の失敗で block せず exit 0 だった）。
 *
 * 出力方式: exit 0 + JSON（decision: "block"）。exit 2 は使わない（公式仕様: exit 2 は stdout JSON を無視する）。
 * 引数: argv[2] = bash の $HOME（空文字でもそのまま使う）、argv[3] = $HERE。
 */
'use strict'
const fs = require('fs')
const os = require('os')
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

const DEFAULT_MODE = 'soft'
const MODES = new Set(['soft', 'strict', 'off'])

/**
 * `git -C DIR status --porcelain 2>/dev/null | grep -v '\.bak' | grep -v 'CLAUDE\.local\.md' | head -1` の値。
 * 除外後の先頭の 1 行。無ければ ''。git の終了コード・起動失敗は見ない（旧のパイプも見なかった）: stdout があればそれを使う。
 */
function firstChange(projectDir) {
  const r = cp.spawnSync('git', ['-C', projectDir, 'status', '--porcelain'], {
    stdio: ['inherit', 'pipe', 'ignore'], // 旧と同じく EOF 済みの標準入力を継承する（fd の種別が旧と同じになる）
    maxBuffer: Infinity,
    windowsHide: true
  })
  const text = r.stdout ? r.stdout.toString('latin1') : ''
  const ls = text.split('\n')
  if (ls.length > 0 && ls[ls.length - 1] === '') ls.pop() // 末尾の改行が作る空要素は行ではない
  for (const l of ls) {
    if (l.includes('.bak') || l.includes('CLAUDE.local.md')) continue
    return l
  }
  return ''
}

/**
 * 掃除: find "$GATE_DIR" -type f -name '*.seen' -mtime +7 -delete。
 * find は起点が通常ファイルでも -type f / -name / -mtime を当てて消す（起点が *.seen の古いファイルなら消える）。
 * 起点がディレクトリなら sweepSentinels（配下を辿る）。シンボリックリンクの起点は辿らない（find -P と同じ）。
 */
function sweepStart(gateDir, now) {
  let st
  try {
    st = fs.lstatSync(gateDir)
  } catch {
    return
  }
  if (st.isDirectory()) {
    sweepSentinels(gateDir, (n) => n.endsWith('.seen'), now)
    return
  }
  if (st.isFile()) {
    const base = gateDir.split(/[\\/]/).pop() || ''
    if (base.endsWith('.seen')) {
      const nowAt = now === undefined ? Date.now() : now
      if (Math.floor((nowAt - st.mtimeMs) / MS_PER_DAY) > SENTINEL_RETENTION_DAYS) {
        try {
          fs.unlinkSync(gateDir)
        } catch {
          /* 無視 */
        }
      }
    }
  }
}

/** io は試験で標準入力を差し替えるための口（本番は渡さない）。 */
function run(io) {
  const home = process.argv.length > 2 ? process.argv[2] : os.homedir()
  const env = process.env
  const CONFIG = env.VBG_CONFIG || home + '/.ccpit/app-config.json'
  const GATE_DIR = env.VBG_GATE_DIR || home + '/.ccpit/.vboard-gate'
  const DETECT = env.VBG_DETECT || home + '/.claude/hooks/verification-board-detect.cjs'
  const PROJECT_DIR = env.CLAUDE_PROJECT_DIR || '.'

  // 何を判定するより先に標準入力を読み切る（旧は最初に $(cat) で読み切った）
  const input = commandSubstitution(readAllStdin(io))
  const lines = input.toString('latin1').split('\n')

  let mode = modeFromConfig(CONFIG, 'verificationBoardMode')
  if (!MODES.has(mode)) mode = DEFAULT_MODE
  if (mode === 'off') return null

  // 内側ループ防止: 最初の true|false の 1 つだけを採る
  if (firstTrueFalse(lines) === 'true') return null

  // node 不在は入口の .sh が見る。検出核不在は fail-open（git の前）
  if (!isFile(DETECT)) return null

  // コード変更検出。無ければ通過
  if (firstChange(PROJECT_DIR) === '') return null

  // 検出核へ委譲（純粋判定）
  const r = cp.spawnSync(process.execPath, [DETECT], {
    env: { ...env, VBG_PROJECT_DIR: PROJECT_DIR, VBG_CHANGES: '1' },
    stdio: ['inherit', 'pipe', 'ignore'], // 旧と同じく EOF 済みの標準入力を継承する
    maxBuffer: Infinity,
    windowsHide: true
  })
  const out = commandSubstitution(r.stdout || Buffer.alloc(0))
  if (out.length === 0) return null

  const safeId = sanitizeId(firstQuotedValue(lines, 'session_id') || '')

  try {
    fs.mkdirSync(GATE_DIR, { recursive: true })
  } catch {
    /* 無視 */
  }
  sweepStart(GATE_DIR)

  if (safeId !== '') {
    const sentinel = GATE_DIR + '/' + safeId + '.seen'
    if (mode === 'soft' && isFile(sentinel)) return null
    if (mode === 'soft') touch(sentinel)
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
  firstChange,
  sweepStart,
  readAllStdin,
  commandSubstitution,
  firstQuotedValue,
  sweepSentinels,
  STDIN_EAGAIN_BUDGET_MS
}
