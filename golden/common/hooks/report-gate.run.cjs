#!/usr/bin/env node
/*
 * report-gate.run.cjs — report-gate.sh の足場（bash）を Node へ移した実体（CCPIT_L0_015）。
 *
 * 構造:
 *   report-gate.sh      入口の薄い殻。node と完全な殻 .cjs（と実体）があれば exec node、無ければ旧の bash 本体（凍結）。
 *   report-gate.cjs     入口の殻（固定・約 40 行）。本ファイルを require して main() を呼び、返された Buffer を 1 回だけ書く。
 *   report-gate.run.cjs 本ファイル。足場の判断: mode 解決 → 検出核の存在確認 → 検出核を子プロセスで起動 → 出力の整形（旧 .sh の写し）。
 *   report-detect.cjs   判定本体（検出核）。この案件では 1 バイトも変えない。require して同じプロセスで動かさず、旧と同じく
 *                       子プロセスとして起こす（標準出力・終了・時間予算・標準エラーの意味を旧と同じに保つ。案 A）。
 *
 * 旧 .sh は $(cat)・$(cd $(dirname))・$(node -e)・$(printf|node) の bash のサブシェルと Node の 2 回起動で、
 * MSYS ではプロセス生成が機械全体でほぼ直列で、Stop hook が同時に走ると 1 回が数倍に伸びた。足場の判断を 1 つの Node にまとめる。
 *
 * 旧 .sh と入力から出力まで同一であること（試験: stopGateEquivalenceRG.test.ts）。bash と node の細部を意図して写している:
 *   - `INPUT=$(cat)` と `OUT=$(...)` は NUL を捨て、末尾の改行を全部落とす（MSYS は CRLF の CR も） → commandSubstitution
 *   - mode は `node -e 'require(設定のパス)'` と同じ解決（cwd 基準・拡張子の扱い・BOM・.js は実行される）。strict と off の 2 値だけ
 *     （soft・大小違い・真偽値・欠落・読めない・壊れている → strict）。off は MODE が完全に "off" のときだけ（旧は標準出力に
 *     余計な物が出れば一致しなかった）。→ 通常の .json（絶対または ./）だけ createRequire(cwd) でこのプロセスの中で読み、
 *     それ以外（.js など＝コードが走りうる設定）は旧と同じ node -e の子プロセスで読む（副作用を子に閉じ込める。CI1-1）
 *   - 検出核の不在（[ -f ] が偽）→ 無出力・終了 0。検出核が非 0 で終わっても、出力があれば流して終了 0
 *   - 検出核へ渡す標準入力は処理済みの INPUT（末尾の LF が除かれ、CR は残る）、環境変数 RG_STDIN_JSON=1 は足場が必ず与える
 *   - 検出核の出力は上限なしで取る（旧の $(...) に上限は無い。maxBuffer: Infinity）
 *   - 出力が空（改行だけを含む）なら無出力。非空なら末尾の改行 1 つで返す（printf '%s\n'）
 *
 * 不変条件（変えない）:
 *   - mode は strict と off の 2 値のみ（soft を採らない）。
 *   - stop_hook_active による無条件バイパスを入れない（true でも検出核へ渡して判定する。入れると「2 回停止すれば通る」＝ゲートが死ぬ）。
 *   - block 条件を広げない・検出力を落とさない（判定は検出核が決め、足場は流すだけ）。
 *   - fail-open: 検出核の不在・起動失敗・出力なしは通過（無出力・終了 0）。
 * main() は標準出力に直接書かず、出すべき Buffer（無ければ null）を返す。書くのは殻の 1 回だけ。
 * 例外は握りつぶさない: 入口の BOOT が保持した標準入力で旧の bash 本体を呼び直す（出し忘れを止める義務を黙って落とさない。Plan §3.3）。
 * 引数: argv[2] = bash の $HOME（空文字でもそのまま使う）／argv[6] = 設定のパス／argv[7] = 検出核のパス
 *       （どちらも入口の .sh が旧と同じ素材 RG_CONFIG・RG_DETECT の :- 既定から組んで渡す。MSYS の引数変換を通した形）。
 *
 * 出力方式: exit 0 + JSON（decision: "block"）。exit 2 は使わない（公式仕様: exit 2 は stdout JSON を無視する）。
 */
'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createRequire } = require('module')
const { spawnSync } = require('child_process')

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

/**
 * mode を解く 1 行（旧 .sh の `node -e '…'` と逐語で同一。RG_CONFIG_PATH を require して reportGateMode を strict|off に丸める）。
 * 旧 .sh は設定を別の node（子プロセス）で require した。設定が .js なら実行され、その副作用（標準出力・標準エラー・process.exit・
 * fs などの書き換え）は子の中に閉じた。
 */
const MODE_SCRIPT =
  'try{const c=require(process.env.RG_CONFIG_PATH);const m=c.reportGateMode;process.stdout.write(m==="off"||m==="strict"?m:"strict")}catch(e){process.stdout.write("strict")}'

/**
 * 設定を「このプロセスの中で」読んでよいか。require が JSON.parse しか走らせないと言い切れる形だけ true（迷えば false＝子で解く）:
 *   絶対パスまたは ./ 形（裸の名前はモジュール名扱いで解決が変わる）／末尾が区切りでない／stat が通常ファイル（ディレクトリは
 *   index.js や package.json の main を実行しうる）／実体（シンボリックリンクを辿った先）の名前が小文字の .json で終わり、
 *   先頭がドット以外（.json だけの名前は拡張子なし＝JS 扱いで実行される。.JSON も未登録の拡張子＝JS 扱い）。
 * 設定が .js/.cjs/.mjs/.node/拡張子なしなどのとき、コードがこのプロセスの fs や process を書き換えて、後続の検出（検出核の存在確認など）を
 * 黙って通過に変えうる（CI1-1）。そういう設定は旧と同じく子の node で読む。
 */
function isPlainJsonConfig(configPath) {
  try {
    if (typeof configPath !== 'string' || configPath === '') return false
    if (!(path.isAbsolute(configPath) || configPath.startsWith('./'))) return false
    if (/[\\/]$/.test(configPath)) return false
    if (!fs.statSync(configPath).isFile()) return false
    return /^[^.][\s\S]*\.json$/.test(path.basename(fs.realpathSync(configPath)))
  } catch {
    return false
  }
}

/** 旧の MODE（stdout の Buffer）を子の node で得る。旧: MODE=$(RG_CONFIG_PATH="$CONFIG" node -e '…' 2>/dev/null)。起動に失敗すれば空（＝strict）。 */
function modeStdoutViaChild(configPath) {
  let r
  try {
    r = spawnSync(process.execPath, ['-e', MODE_SCRIPT], {
      env: Object.assign({}, process.env, { RG_CONFIG_PATH: configPath }),
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: Infinity,
      windowsHide: true
    })
  } catch {
    return Buffer.alloc(0)
  }
  return r && Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.alloc(0)
}

/** 同じプロセスで JSON を読む（isPlainJsonConfig が真のときだけ）。MODE_SCRIPT と同じ丸め。 */
function modeStdoutInProcess(configPath) {
  let m
  try {
    const req = createRequire(path.join(process.cwd(), '[eval]'))
    const v = req(configPath).reportGateMode
    m = v === 'off' || v === 'strict' ? v : 'strict'
  } catch {
    m = 'strict'
  }
  return Buffer.from(m)
}

/**
 * mode が off か。旧: MODE=$(RG_CONFIG_PATH=… node -e '<MODE_SCRIPT>' 2>/dev/null) して [ -z "$MODE" ] && MODE=strict、[ "$MODE" = "off" ] && exit 0。
 * 旧の MODE は「設定の読み込み中に標準出力へ出た物 + off|strict」を $(...) に通した値。完全に "off" のときだけ off。
 * 設定が通常の .json ならこのプロセスで読む（速い経路＝本番の設定 ~/.ccpit/app-config.json）。それ以外は旧と同じく子の node で読む。
 */
function isOffMode(configPath) {
  const out = isPlainJsonConfig(configPath) ? modeStdoutInProcess(configPath) : modeStdoutViaChild(configPath)
  return commandSubstitution(out).toString('latin1') === 'off'
}

/**
 * 検出核を子プロセスで起こして標準出力を取る。旧: OUT=$(printf '%s' "$INPUT" | RG_STDIN_JSON=1 node "$DETECT" 2>/dev/null)。
 * 起動に失敗しても、検出核が非 0 で終わっても、出力があればそれを使う（旧は終了コードを見ない）。標準エラーは捨てる。
 */
function runDetect(detectPath, input) {
  let r
  try {
    r = spawnSync(process.execPath, [detectPath], {
      input,
      env: Object.assign({}, process.env, { RG_STDIN_JSON: '1' }),
      stdio: ['pipe', 'pipe', 'ignore'],
      maxBuffer: Infinity,
      windowsHide: true
    })
  } catch {
    return Buffer.alloc(0)
  }
  return r && Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.alloc(0)
}

/**
 * 判断の本体。block を出すなら出力の Buffer、通すなら null。
 * input は `INPUT=$(cat)` 相当に整えた標準入力。configPath・detectPath は入口の .sh が組んだ物。
 */
function decide(configPath, detectPath, input) {
  if (isOffMode(configPath)) return null // off は検出核を起こさない
  if (!isFile(detectPath)) return null // 検出核が無い（ディレクトリ含む）→ fail-open
  const out = commandSubstitution(runDetect(detectPath, input))
  if (out.length === 0) return null
  return Buffer.concat([out, Buffer.from('\n')])
}

/** 入口。opts: { argv, io, input }（試験用。input を渡すと標準入力を読まず、それを `$(cat)` の元にする）。 */
function main(opts) {
  const o = opts || {}
  const argv = o.argv || process.argv
  const home = argv[2] === undefined ? os.homedir() : argv[2]
  const here = argv[3] === undefined ? __dirname : argv[3]
  const configPath = argv[6] !== undefined ? argv[6] : process.env.RG_CONFIG || home + '/.ccpit/app-config.json'
  const detectPath = argv[7] !== undefined ? argv[7] : process.env.RG_DETECT || here + '/report-detect.cjs'
  const raw = o.input !== undefined ? o.input : readAllStdin(o.io) // 何を判定するより先に読み切る
  return decide(configPath, detectPath, commandSubstitution(raw))
}

module.exports = {
  main,
  decide,
  isOffMode,
  isPlainJsonConfig,
  runDetect,
  readAllStdin,
  commandSubstitution,
  isFile,
  STDIN_EAGAIN_BUDGET_MS
}
