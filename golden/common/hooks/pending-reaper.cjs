#!/usr/bin/env node
/*
 * pending-reaper.cjs — Pending 刈り取り屋（台帳 #71・設計 20260925_0327_069_tradeoffs_for_maintainer.md §4）
 *
 * 目的: 「スコープ外提案（Pending）に書いた＝誰かが拾う」が成り立っていない（2026-09-25 実測: 558 行中 台帳 # あり 51）。
 *       設計レーンの CC が起動するたびに、腐った行を会話の冒頭に差し込み、「見ないで進める」をできなくする。
 *
 * 見るもの:
 *   (a) TASK_LEDGER.md の未完了行のうち、最終実測が STALE_DAYS を超える、または「未再確認」を含む行
 *   (b) _Prompt 配下の .md の「## スコープ外提案（Pending）」表の行のうち、「台帳 #N」の無い行
 *       対象文書 = mtime が CUTOFF 以降のもの ＋ 01_designai 配下の全文書（設計レーン自身の分は日付を問わない）
 *
 * 使い方:
 *   node pending-reaper.cjs            … SessionStart フック用（hookSpecificOutput.additionalContext を stdout に 1 行）。
 *                                       stdin のフックの入力の cwd から上へ辿り、台帳 _Prompt/01_designai/TASK_LEDGER.md を
 *                                       持つ最初のディレクトリを ROOT にする。見つからなければ沈黙（全体の設定に登録するため）
 *   閉じ方: 行に台帳 # か「<案件>_MILESTONES の M#」「<案件>_BOUND_PENDING の B#」を書くか、
 *           処置の表 _Prompt/01_designai/PENDING_DISPOSITIONS.md に 1 行足す（2026-10-03 069 M9）
 *   node pending-reaper.cjs --print    … 人が読む用（素のテキスト）。ROOT は今いるディレクトリから上へ辿って探す
 *   環境変数 CCPIT_ROOT で ROOT を上書き可（そのときフックは cwd が ROOT の中のときだけ出す）
 *
 * 置き場: 源はリポジトリの _Tools/pending-reaper.cjs。golden の common/hooks/ に同一の写しがあり、
 *   ~/.claude/hooks/ に配られて足場 pending-reaper.sh から起動される（L0_013 W4）。どこに置いても動くよう、
 *   ROOT はこのファイルの置き場からでなく、フックの入力の cwd から求める。
 *
 * 二重起動: 手元の登録（このファイルを直接呼ぶ 1 文字列）と golden の足場の登録が並んで走ることがある。
 *   同じ SessionStart の 2 本目は沈黙する（目印を os.tmpdir() に wx で作れた 1 本だけが出す）。
 *
 * fail の倒れる向き: 読めない・壊れている・想定外は全て沈黙 exit 0（非注入）。起動を止めない。
 */
'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const LEDGER_REL = path.join('_Prompt', '01_designai', 'TASK_LEDGER.md')
const STALE_DAYS = 30
// 二重起動を同じ SessionStart とみなす幅。並んで走る 2 本は同じ SessionStart の数百 ms 以内に動き、別の SessionStart
// （compact・resume）は分の単位で離れる。目印の更新から この幅の内の 2 本目は沈黙する
const DEDUPE_WINDOW_MS = 60 * 1000
// 古い目印を消す境。目印は空のファイルで害は無いが、溜めない
const MARKER_TTL_MS = 24 * 60 * 60 * 1000
// session_id はそのままファイル名にしない（`/`・`..`・`:`・長大な値で作成に失敗したり外へ出たりする）
const MARKER_NAME_HEX = 32
// 走査の上限。台帳のある案件ならどこでも動くので、巨大な _Prompt で SessionStart の timeout（10 秒）を
// 食い潰さないよう打ち切る。CCPIT の実測（2026-10-21）: .md 2,644 本・43 MB・0.9 秒。その約 4 倍
const MAX_SCAN_FILES = 10000
const MAX_SCAN_BYTES = 200 * 1024 * 1024
// _Prompt の下で辿る項目（フォルダ・ファイル）の数の上限。CCPIT の実測 10,734 項目の約 4 倍
const MAX_WALK_ENTRIES = 50000
const CUTOFF = new Date('2026-09-25T00:00:00+09:00') // これより前の文書の孤児行は凍結（§4-3）
const ALWAYS_LANE = '01_designai'
const MAX_ITEMS = 40
const SENTINEL = 'PENDING-REAPER-END'
// 受け皿あり（台帳の番号がある）とみなす書き方（2026-09-28 069 設計レーン追加）。
// 「台帳 #N」だけでなく「作業台帳 `…/TASK_LEDGER.md` #N」「同 #N」「#N の行で管理」も実際に使われていて、
// 旧版はこれらを受け皿の無い行と数えていた（069 の文書の 52 行の多く）。
const LINKED_RE = /台帳[^|]{0,120}?#\d+|TASK_LEDGER[^|]{0,120}?#\d+|同 *#\d+|\| *#\d+/
// 案件の現在地の文書（`<案件>_MILESTONES.md` の段 M#）と、必ず対応するリスト（`<案件>_BOUND_PENDING.md` の行 B#）も、
// 名指しできて実在する受け皿として数える（2026-10-03 069 設計レーン追加・landmine-labeling の「パス・ID で名指し」）。
// ファイル名と行の番号の両方が書いてある行だけ。片方だけでは受け皿と見ない
const LINKED_DOC_RE = /_MILESTONES(?:\.md)?[^|]{0,160}?\bM\d+[a-z]?\b|\bM\d+[a-z]?\b[^|]{0,160}?_MILESTONES|_BOUND_PENDING(?:\.md)?[^|]{0,160}?\bB\d+\b|\bB\d+\b[^|]{0,160}?_BOUND_PENDING/
// 「無し」だけの行（Pending が無いことを書いた行）は積み残しではない
const NONE_ROW_RE = /^\| *(無し|なし)(（[^|]*）)? *\|/
// 証跡の見本（試験の入力として作った報告書の形の文書）は積み残しを持たない
const SKIP_PATH_RE = /\/evidence\/|\/fixtures\//
// 処置の表（2026-10-03 069 設計レーン追加）。過去の文書の行は書き換えず、ここに「文書・行の頭・処置・根拠か受け皿」を 1 行ずつ残して閉じる。
// 処置の欄か根拠の欄が空の行は数えない（閉じたことにしない）
const DISPOSITIONS_REL = path.join('_Prompt', '01_designai', 'PENDING_DISPOSITIONS.md')

/** start から上へ辿り、台帳を持つ最初のディレクトリ。無ければ null */
function findLedgerRoot(start) {
  if (!start) return null
  let d = path.resolve(start)
  for (;;) {
    try { if (fs.statSync(path.join(d, LEDGER_REL)).isFile()) return d } catch (_) { /* 次の親へ */ }
    const up = path.dirname(d)
    if (up === d) return null
    d = up
  }
}

/** 関数を引数なしで呼んだときの ROOT（試験と --print 用）: CCPIT_ROOT か、今いるディレクトリから辿った台帳の在りか */
function defaultRoot() {
  return process.env.CCPIT_ROOT || findLedgerRoot(process.cwd())
}

function loadDispositions(root = defaultRoot()) {
  const keys = new Set()
  let t
  try { t = fs.readFileSync(path.join(root, DISPOSITIONS_REL), 'utf8') } catch (_) { return keys }
  for (const l of t.split('\n')) {
    if (!/^\| `/.test(l)) continue
    const c = l.split('|').slice(1, -1).map(s => s.trim())
    if (c.length < 4 || !c[2] || !c[3]) continue
    keys.add(`${c[0].replace(/`/g, '')}::${c[1]}`)
  }
  return keys
}
// Gemini（実装レーン）の報告の置き場は Claude Code のレーンからは読むだけ（二層の報告書分離）で、台帳の番号を書き足せない。
// ここを数えると消せない行が残り続けるので見ない。Gemini の報告の Pending は、設計レーンの検収の記録へ写して受け皿を付ける
const SKIP_PREFIX = '_Prompt/02_buildai/gemini/'

/** _Prompt の .md を集める。辿った項目の数が budget.left を超えたら止め、budget.truncated を立てる */
function walk(d, out = [], budget = { left: MAX_WALK_ENTRIES, truncated: false }) {
  let ents
  try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch (_) { return out }
  for (const e of ents) {
    if (budget.left-- <= 0) { budget.truncated = true; return out }
    const f = path.join(d, e.name)
    if (e.isDirectory()) walk(f, out, budget)
    else if (/\.md$/i.test(e.name) && !/\.bak/i.test(e.name)) out.push(f)
    if (budget.truncated) return out
  }
  return out
}

function staleLedgerRows(now, root = defaultRoot()) {
  const out = []
  let text
  try { text = fs.readFileSync(path.join(root, LEDGER_REL), 'utf8') } catch (_) { return out }
  for (const line of text.split('\n')) {
    // 欄の中の `\|`（Markdown の縦棒のエスケープ）は列の区切りではない。先に別の字へ置いてから列を切る
    // （2026-10-08 棚卸し: #49 の `\| tail -c N` で 4 列目が取れず「最終実測 不明」と出ていた）
    const masked = line.replace(/\\\|/g, '%7C')
    const m = /^\| (\d+) \| ([^|]*)\| ([^|]*)\| ([^|]*)\|/.exec(masked)
    if (!m) continue
    const [, no, state, title, seen] = m
    // 閉じた行は見ない。台帳の語彙は「済み」。「放置（再起動条件つき）」「注視」は landmine-labeling で閉じた扱い（WATCHLIST が見張る）
    // （2026-10-08 棚卸し: 旧版は completed だけを除いていたので、済みの行が 30 日経つと腐りに出ていた＝#76）
    if (/completed|closed|済み|放置|注視|クローズ/i.test(state)) continue
    const d = /(\d{4}-\d{2}-\d{2})/.exec(seen)
    const ageDays = d ? Math.floor((now - new Date(d[1])) / 86400000) : null
    const unverified = /未再確認/.test(seen)
    if ((ageDays !== null && ageDays > STALE_DAYS) || ageDays === null || unverified) {
      out.push(`#${no} [${state.trim().replace(/\*/g, '').slice(0, 14)}] ${title.trim().replace(/\*/g, '').slice(0, 60)} — 最終実測 ${d ? d[1] : '不明'}${ageDays !== null ? `（${ageDays} 日前）` : ''}${unverified ? '・未再確認' : ''}`)
    }
  }
  return out
}

/**
 * 受け皿の無い Pending 行。走査が上限（ファイル数・読んだバイト数）に達したら打ち切り、
 * 返す配列の truncated を true にする（一覧に「打ち切った」を出す）
 */
function orphanPendingRows(root = defaultRoot(), limits = { files: MAX_SCAN_FILES, bytes: MAX_SCAN_BYTES }) {
  const out = []
  out.truncated = false
  const disposed = loadDispositions(root)
  let files = 0
  let bytes = 0
  const budget = { left: limits.walkEntries ?? MAX_WALK_ENTRIES, truncated: false }
  const found = walk(path.join(root, '_Prompt'), [], budget)
  if (budget.truncated) out.truncated = true
  for (const f of found) {
    const rel = path.relative(root, f).replace(/\\/g, '/')
    const lane = rel.split('/')[1]
    if (rel.startsWith(SKIP_PREFIX) || SKIP_PATH_RE.test(rel)) continue
    let st
    try { st = fs.statSync(f) } catch (_) { continue }
    if (lane !== ALWAYS_LANE && st.mtime < CUTOFF) continue
    if (files >= limits.files || bytes + st.size > limits.bytes) { out.truncated = true; break }
    files++
    bytes += st.size
    let t
    try { t = fs.readFileSync(f, 'utf8') } catch (_) { continue }
    const m = /\n## スコープ外提案（Pending）[^\n]*\n([\s\S]*?)(?=\n## |\s*$)/.exec(t)
    if (!m) continue
    const rows = m[1].split('\n')
    for (let i = 0; i < rows.length; i++) {
      const l = rows[i]
      if (!/^\| /.test(l) || /^\| *(提案|項目|候補|---)/.test(l) || /^\|-/.test(l)) continue
      // 表の見出しの行（次の行が区切りの行）は積み残しではない（「| # | 提案 | 状態 |」などを拾っていた）
      if (/^\|[\s:|-]+\|?\s*$/.test(rows[i + 1] || '') && /-/.test(rows[i + 1] || '')) continue
      if (LINKED_RE.test(l) || LINKED_DOC_RE.test(l) || NONE_ROW_RE.test(l)) continue
      const first = l.split('|').map(s => s.trim()).filter(Boolean)[0] || ''
      if (disposed.has(`${rel}::${first.replace(/\|/g, '｜')}`)) continue
      out.push(`${path.basename(f)} :: ${first.slice(0, 70)}`)
    }
  }
  return out
}

function markerDir() {
  return process.env.PENDING_REAPER_MARKER_DIR || path.join(os.tmpdir(), 'pending-reaper')
}

/** 目印を wx で作る。作れたら true、既にあれば false、それ以外の失敗は投げる */
function createExclusive(p) {
  try {
    fs.closeSync(fs.openSync(p, 'wx'))
    return true
  } catch (e) {
    if (e && e.code === 'EEXIST') return false
    throw e
  }
}

/**
 * 同じ SessionStart で並んで走った 2 本目なら false（沈黙する）。
 * 目印 <sha256(key) の先頭>（key＝session_id、無ければ transcript_path）を使う:
 *   - 目印が無ければ wx で作れた 1 本だけが true
 *   - 目印があり、最後の更新から DEDUPE_WINDOW_MS の内なら false（同じ SessionStart の 2 本目）
 *   - それより古ければ（compact・resume の後の SessionStart）、目印の更新時刻ごとの印 <名前>.<更新時刻> を
 *     wx で作れた 1 本だけが true になり、目印の更新時刻を今に進める。並んだ 2 本は同じ更新時刻を見るので、
 *     勝者は 1 本に決まる（時刻の区切りの境目が無い）
 * key が無い・目印を置けないときは true（差し込みを優先。Claude Code のフックの入力には session_id が必ずある）
 */
function claimSession(key, nowMs) {
  if (typeof key !== 'string' || key === '') return true
  const dir = markerDir()
  try { fs.mkdirSync(dir, { recursive: true }) } catch (_) { return true }
  const name = crypto.createHash('sha256').update(key, 'utf8').digest('hex').slice(0, MARKER_NAME_HEX)
  const marker = path.join(dir, name)
  const nowSec = nowMs / 1000
  try {
    if (createExclusive(marker)) {
      fs.utimesSync(marker, nowSec, nowSec)
    } else {
      const lastMs = Math.floor(fs.statSync(marker).mtimeMs)
      const age = nowMs - lastMs
      // 幅の内（前後とも）は同じ SessionStart の 2 本目。並んだ 2 本では、後から目印を見た側の「今」が
      // 目印の時刻より少し前になりうる（各プロセスは起動時に今を取る）ので、少しの未来は同じ SessionStart に数える。
      // 幅を超えて未来にあるとき（時計の巻き戻り）は新しい SessionStart として扱い、「差し込まない」側へ倒れ続けない
      if (age > -DEDUPE_WINDOW_MS && age < DEDUPE_WINDOW_MS) return false
      if (!createExclusive(path.join(dir, `${name}.${lastMs}`))) return false
      fs.utimesSync(marker, nowSec, nowSec)
    }
  } catch (_) {
    return true
  }
  // 出すついでに古い目印を消す（失敗しても結果に影響しない）
  try {
    for (const n of fs.readdirSync(dir)) {
      const p = path.join(dir, n)
      try { if (nowMs - fs.statSync(p).mtimeMs > MARKER_TTL_MS) fs.unlinkSync(p) } catch (_) { /* 次へ */ }
    }
  } catch (_) { /* 片付けの失敗は無視 */ }
  return true
}

function buildBody(root, now) {
  const stale = staleLedgerRows(now, root)
  const orphans = orphanPendingRows(root)
  const lines = []
  lines.push(`# Pending 刈り取り屋（台帳 #71）— ${now.toISOString().slice(0, 16).replace('T', ' ')}Z 時点`)
  lines.push(`台帳の腐り（未完了・最終実測 ${STALE_DAYS} 日超 or 未再確認）: ${stale.length} 件 / 台帳 # の無い Pending 行: ${orphans.length} 件`)
  if (stale.length) { lines.push('## 台帳の腐り'); for (const s of stale.slice(0, MAX_ITEMS)) lines.push(`- ${s}`) }
  if (orphans.length) { lines.push('## 受け皿の無い Pending 行（台帳 # を付けるか、台帳に行を立てる）'); for (const s of orphans.slice(0, MAX_ITEMS)) lines.push(`- ${s}`) }
  if (orphans.truncated) lines.push(`（_Prompt の走査を上限で打ち切った: ${MAX_SCAN_FILES} 本・${MAX_SCAN_BYTES / 1024 / 1024} MB・${MAX_WALK_ENTRIES} 項目。上の Pending 行の数は全部ではない）`)
  if (!stale.length && !orphans.length) lines.push('刈り取るものなし')
  lines.push(`閉じ方: 行に台帳 # か「<案件>_MILESTONES の M#」「<案件>_BOUND_PENDING の B#」を書くか、処置の表 _Prompt/01_designai/PENDING_DISPOSITIONS.md に 1 行足す。`)
  lines.push('設計レーンは、この一覧に手を付けない場合は、その理由を最初の応答で 1 行書くこと（実装レーンは読み流してよい）。')
  lines.push(SENTINEL)
  return lines.join('\n')
}

/** 台帳を探す起点の cwd から ROOT を決める。CCPIT_ROOT があれば、cwd がその中のときだけ ROOT（従来どおり） */
function rootForCwd(cwd) {
  if (!cwd) return null
  const forced = process.env.CCPIT_ROOT
  if (forced) {
    const norm = (p) => path.resolve(p).toLowerCase()
    return norm(cwd) === norm(forced) || norm(cwd).startsWith(norm(forced) + path.sep) ? forced : null
  }
  return findLedgerRoot(cwd)
}

function main() {
  const now = new Date()
  if (process.argv.includes('--print')) {
    const root = defaultRoot()
    if (!root) { process.stderr.write('pending-reaper: 台帳（_Prompt/01_designai/TASK_LEDGER.md）が見つからない\n'); return }
    process.stdout.write(buildBody(root, now) + '\n')
    return
  }
  // SessionStart のフックとして全体の設定に登録するので、台帳のある案件の中で起動したセッションのときだけ差し込む。
  // フックの入力（stdin の JSON の cwd）が読めないときは沈黙する
  let input
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}') } catch (_) { return }
  const root = rootForCwd(typeof input.cwd === 'string' ? input.cwd : '')
  if (!root) return
  const key = typeof input.session_id === 'string' && input.session_id ? input.session_id : typeof input.transcript_path === 'string' ? input.transcript_path : ''
  if (!claimSession(key, now.getTime())) return
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: buildBody(root, now) } }) + '\n')
}

// 試験（pending-reaper.test.cjs）から require したときは走らせず、関数だけ渡す
if (require.main === module) {
  try { main() } catch (_) { /* 沈黙 exit 0 */ }
}
module.exports = { staleLedgerRows, orphanPendingRows, loadDispositions, findLedgerRoot, rootForCwd, claimSession, STALE_DAYS, DEDUPE_WINDOW_MS, MAX_SCAN_FILES }
