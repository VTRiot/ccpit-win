#!/usr/bin/env node
/*
 * stuck-loop-detect.v4.cjs — 同一理由の停止フック発火が積み上がったことを Stop hook の `additionalContext` として出す
 *   （当該 CLI プローブ 1 試行で model の利用と 1 ターン継続を観測した形式。配信一般・用途・継続回数の保証ではない——第 5 巡 42）
 *
 * v3 → v4（2026-09-12・Codex 第 2 巡 指摘 14・15・16 を反映）:
 *   v3 は「直前の理由の連続 run」を数え、run >= THRESHOLD で出し、認識不能時の暴走を assistant 記録数の CAP で
 *   有限化していた。第 2 巡で (a) 理由切替で積算が消える（025 の「理由別に新たに 3 件」と不一致）、
 *   (b) CAP は block ごとにリセットされ単調な上限ではない、(c) 壊れた行の読み飛ばしは「出す側」にも働く、
 *   の 3 点が指摘された。v4 は次のように単純化する:
 *
 *   事象:
 *     block(key)  = type=user・content が文字列・先頭が PREFIX（既存ゲートの feedback）
 *     inject(key) = type=attachment・attachment.type=hook_additional_context・content に自分のタグ
 *     boundary    = type=user・content が文字列で PREFIX 以外（フィードバック以外の user 文字列記録。
 *                   誰が生成したかは判定しない——第 3 巡 24。配列 content の user 記録は何にも数えない）
 *     （assistant 記録は数えない）
 *   状態: key ごとの件数 count[key]。
 *     block(key)  → count[key]++、lastKey = key
 *     inject(key) → count[key] = 0（自分の通知が記録された証拠。記録された時だけ枠が復活する）
 *     boundary    → 全 count を 0、lastKey = null（エピソード終了）
 *   出す条件: lastKey があり count[lastKey] **=== THRESHOLD**（ちょうど 3 件目）、かつその 3 件の前に
 *   **エピソード境界が窓内にある**（transcript 先頭が窓内 / boundary / inject(lastKey) のいずれか）。
 *
 *   「===」の意味: inject(key) の記録が認識できない場合、count は 4, 5, … と伸びて出ない。
 *   ただしこれは **「新規 block なしに再通知しない」ことを保証しない**（第 3 巡 22）。同じ transcript 状態で
 *   核が再び呼ばれれば（通知が transcript に記録される前に次の Stop が来る等）、count は 3 のままなので再び出る。
 *   上限「1 エピソード・1 理由につき、認識できた inject(key) の回数 + 1」は、**通知が次の呼出しまでに
 *   transcript へ記録される**（プローブで観測した形状: attachment/hook_additional_context）という前提の下でのみ成立する。
 *   境界条件（第 3 巡 23）: 窓外脱落で count が 4 → 3 になっても、境界が窓内に無ければ出さない。
 *
 * 保証の前提（実装が保証しないもの・025 §4 に明記）:
 *   - 同じ Stop で核が 2 回呼ばれ、その間に inject が記録されないと 2 回出る（プローブでは 1 回の Stop に 1 記録）。
 *   - フィードバック以外の user 文字列記録（割り込み通知など、生成者を問わない）は boundary として count を消す。
 *     これは「常に抑制方向」ではない（A×4 → boundary → A×3 は出る）。境界の定義そのものである。
 *
 * 守り（読取り失敗・JSON 破損・想定外入力は「出さない」側に倒す。**事象の形が変わって認識できなくなった場合は方向を保証しない**——
 *   第 5 巡 32: 有効な JSON のまま boundary や inject が認識不能な形になれば無視され、count が 3 に達して出ることがある）:
 *   - 窓（WINDOW_BYTES・2MiB）が transcript の先頭を含まない場合、窓内に boundary か inject(lastKey) が無ければ出さない
 *     （窓外脱落を通知枠の復活にしない。同一理由を長間隔で並べた列も境界が無いので出ない）
 *   - 窓の先頭の断片行は捨てる。改行が無ければ全体を捨てる
 *   - 窓内に JSON として読めない非空行が 1 つでもあれば **沈黙**（連続性が不明な状態で出さない。v3 の読み飛ばしは
 *     inject 行や理由切替行が壊れた時に「出す側」へ倒れた——Codex 指摘 16）
 *   - decision も systemMessage も出さない。状態ファイルを持たない。読めない・想定外 → 沈黙 exit 0
 *
 * 既知の限界（受容）:
 *   - 理由の同一性は本文の sha256 先頭 12 桁。複数ゲートの集約順が変わると別 key（その列では出ない）
 *   - 人間が PREFIX で始まる本文を打つと block と数える（実用上無視できる）
 */
'use strict'

const fs = require('fs')
const crypto = require('crypto')

const WINDOW_BYTES = 2 * 1024 * 1024
const THRESHOLD = 3
const PREFIX = 'Stop hook feedback:'
const TAG_OPEN = '【反復検知 '
const TAG_CLOSE = '】'
const TAG_RE = /【反復検知 ([0-9a-f]{12})】/
// 通知 ID（第 6 巡 44・第 7 巡 48）: 出力メッセージに (nid:<乱数 12 hex>:<key>) を埋め込み、注入記録から回収して観測ログの nid と突き合わせる。
// 乱数は crypto.randomBytes（pid+時刻ではない——衝突・推測を避ける）。発信元の真正性は検証しない（KV-001 参照）。
const NID_RE = /\(nid:([0-9a-f]{12}:[0-9a-f]{12})\)/
const INJECT_TYPE = 'hook_additional_context'

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8')
    if (!raw || !raw.trim()) return null
    return JSON.parse(raw)
  } catch (e) {
    return null
  }
}

function tailText(file) {
  return tailInfo(file).text
}

// { text, truncated }。truncated = 窓が transcript の先頭を含まない
function tailInfo(file) {
  const st = fs.statSync(file)
  if (!st.isFile()) return { text: '', truncated: false, size: 0, ino: null }
  const start = st.size > WINDOW_BYTES ? st.size - WINDOW_BYTES : 0
  const len = st.size - start
  const buf = Buffer.alloc(len)
  const fd = fs.openSync(file, 'r')
  try {
    fs.readSync(fd, buf, 0, len, start)
  } finally {
    fs.closeSync(fd)
  }
  const text = buf.toString('utf8')
  if (start === 0) return { text, truncated: false, size: st.size, start: 0, ino: st.ino }
  const nl = text.indexOf('\n')
  return { text: nl < 0 ? '' : text.slice(nl + 1), truncated: true, size: st.size, start, ino: st.ino }
}

// 観測ログ（第 4 巡 36・第 5 巡 39〜41・第 6 巡 43〜44）: 呼出しごとに 1 行 JSON を追記する。判定には一切使わない（状態を持たない設計は変えない）。
//   - 既定は **無効**。SLD_LOG=<絶対パス> で有効。
//   - 書ける先は os.tmpdir() 配下か ~/.claude/hooks/logs/ 配下の *.log に限る。判定は字句ではなく **親ディレクトリの realpath** で行い
//     （ディレクトリ symlink / junction で許可先の外へ出られない）、ファイル自体は **lstat で symlink なら書かない**。open 後に fstat の
//     実体（dev/ino/size）が lstat と一致した時だけ書く（open までの差し替えを検出）——第 6 巡 43。
//   - 追記後のサイズが LOG_CAP_BYTES を超えるなら追記しない（ローテーションはしない——肥大の上限を固定する。ちょうど上限のファイルにも書かない）。
//     上限は **競合が無い場合の best effort**——容量確認と追記は直列化していないので、同時呼出しでは超え得る（第 7 巡 49）。
//   - transcript は path の sha256 先頭 12 桁（tid）と basename、および stat の ino / size を記録する（絶対パスは残さない）。
//     tid は path 由来で transcript の世代（同一 path の置換）を区別しない。世代の変化は ino の変化・size の減少で補助的に見る（第 7 巡 48）。
//     書けなくても沈黙し、出力は変えない。
//   - **KV-001（既知の脆弱性・見送り）**: この観測ログは、同一ユーザー権限の shell を持つ主体（Claude Code 自身の Bash を含む）に対して
//     改竄耐性を持たない。realpath / lstat / fstat の検査は「誤設定と単純な symlink / junction」を弾くだけで、realpath 後の親ディレクトリ
//     差し替え競合や許可先内の hard link（第 7 巡 47）、transcript ファイルの直接編集による nid 偽造（第 7 巡 48）は防がない。
//     防がない理由: それらができる主体はログ／transcript を直接編集できるので、hook 側で閉じても迂回経路は残る。整合性は
//     (c-1)/(c-2) 手順の「ログ行と transcript の突合」と commit-boundary-forensics の Bash 記録に依る。台帳: 027 既知脆弱性台帳 KV-001。
//   - 記録する項目（第 5 巡 39・第 6 巡 44: 「同一通知機会の重複」と「新規 3 件後の正当な再発火」を一意に区別できる粒度）:
//       stage（no_transcript / read）、tid、range [読取り開始バイト, size]、truncated、broken（JSON 破損で沈黙）、
//       anchored（境界が窓内）、bnd（窓内 boundary 数）、lastKey、cnt（count[lastKey]）、inj（窓内 inject(lastKey) 数）、
//       injNids（窓内で認識した inject(lastKey) の通知 ID 列）、fired、key、run、nid（この呼出しの通知 ID = 乱数:key。出た時だけ）、ino
//     逸脱判定（025 決定 2・第 7 巡 48 で判定不能条件を拡張）: 同じ tid・同じ key の fired 行が 2 行あり、後行の injNids に前行の nid が
//     **無く**、後行が truncated=false、かつ両行の ino が同じで size が単調増加なら「前の通知が認識可能な形で記録されていない」＝前提の崩れ。
//     含まれていれば注入後の新規 3 件による正当な再発火。truncated=true、ino の変化、size の減少、ログ行と transcript の突合不一致は
//     すべて **判定不能**（前提崩壊の証拠には数えない）。
const LOG_CAP_BYTES = 1024 * 1024
function logRoots() {
  const path = require('path')
  const os = require('os')
  return [os.tmpdir(), path.join(os.homedir(), '.claude', 'hooks', 'logs')].map((r) => {
    try { return fs.realpathSync(r) } catch (e) { return path.resolve(r) }
  })
}
function underRoots(abs) {
  const path = require('path')
  const low = path.resolve(abs).toLowerCase()
  return logRoots().some((r) => low.startsWith(r.toLowerCase() + path.sep))
}
function logPath() {
  const p = process.env.SLD_LOG
  if (!p) return null
  const path = require('path')
  if (!path.isAbsolute(p) || path.extname(p) !== '.log') return null
  const rp = path.resolve(p)
  return underRoots(rp) ? rp : null
}
function logCall(rec) {
  const p = logPath()
  if (!p) return
  const path = require('path')
  const line = JSON.stringify(rec) + '\n'
  const bytes = Buffer.byteLength(line, 'utf8')
  let fd = null
  try {
    const dirReal = fs.realpathSync(path.dirname(p))
    if (!underRoots(dirReal)) return
    const target = path.join(dirReal, path.basename(p))
    let st = null
    try { st = fs.lstatSync(target) } catch (e) { st = null }
    if (st && (st.isSymbolicLink() || !st.isFile())) return
    if (st && st.size + bytes > LOG_CAP_BYTES) return
    fd = fs.openSync(target, 'a')
    const fst = fs.fstatSync(fd)
    if (!fst.isFile()) return
    if (st) {
      if (fst.dev !== st.dev || fst.ino !== st.ino || fst.size !== st.size) return
    } else {
      const st2 = fs.lstatSync(target)
      if (st2.isSymbolicLink() || st2.dev !== fst.dev || st2.ino !== fst.ino || fst.size !== 0) return
    }
    fs.writeSync(fd, line)
  } catch (e) {
  } finally {
    if (fd !== null) { try { fs.closeSync(fd) } catch (e) {} }
  }
}

function hash(s) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 12)
}

function contentText(c) {
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c
      .map((x) => (typeof x === 'string' ? x : x && typeof x.text === 'string' ? x.text : ''))
      .join('\n')
  }
  return ''
}

// 1 行 → 事象（または null）
function classify(j) {
  if (!j || typeof j !== 'object') return null
  if (j.type === 'user') {
    const c = j.message && j.message.content
    if (typeof c === 'string') {
      if (c.indexOf(PREFIX) === 0) {
        const reason = c.slice(PREFIX.length).trim()
        return { k: 'block', key: hash(reason), reason }
      }
      return { k: 'boundary' }
    }
    // 配列 content（tool_result・text 配列・空配列）は block にも boundary にも数えない（第 3 巡 24）
    return null
  }
  if (j.type === 'attachment' && j.attachment && j.attachment.type === INJECT_TYPE) {
    const text = contentText(j.attachment.content)
    const m = text.match(TAG_RE)
    if (!m) return null
    const n = text.match(NID_RE)
    return { k: 'inject', key: m[1], nid: n ? n[1] : null }
  }
  return null
}

// (lines, truncated) → { d, stats }。d = { key, run, reason } または null（沈黙）。stats は観測ログ用（判定には使わない）。
// 壊れた非空行があれば d = null・stats.broken = true。
// truncated = 窓が transcript 先頭を含まない。その場合は boundary か inject(lastKey) が窓内に無ければ null。
function analyze(lines, truncated) {
  const count = new Map()
  const reasons = new Map()
  const injects = new Map()
  const injNids = new Map()
  let lastKey = null
  let anchored = !truncated
  let boundaries = 0
  let broken = false
  const anchoredKeys = new Set()
  for (const line of lines) {
    if (!line || !line.trim()) continue
    let j
    try {
      j = JSON.parse(line)
    } catch (e) {
      broken = true
      break
    }
    const ev = classify(j)
    if (!ev) continue
    if (ev.k === 'block') {
      count.set(ev.key, (count.get(ev.key) || 0) + 1)
      reasons.set(ev.key, ev.reason)
      lastKey = ev.key
    } else if (ev.k === 'inject') {
      count.set(ev.key, 0)
      anchoredKeys.add(ev.key)
      injects.set(ev.key, (injects.get(ev.key) || 0) + 1)
      if (!injNids.has(ev.key)) injNids.set(ev.key, [])
      injNids.get(ev.key).push(ev.nid)
    } else if (ev.k === 'boundary') {
      count.clear()
      lastKey = null
      anchored = true
      boundaries++
    }
  }
  const stats = {
    broken,
    anchored: anchored || (lastKey !== null && anchoredKeys.has(lastKey)),
    bnd: boundaries,
    lastKey,
    cnt: lastKey ? count.get(lastKey) || 0 : null,
    inj: lastKey ? injects.get(lastKey) || 0 : null,
    injNids: lastKey ? injNids.get(lastKey) || [] : []
  }
  if (broken || !lastKey) return { d: null, stats }
  const run = count.get(lastKey) || 0
  if (run !== THRESHOLD) return { d: null, stats }
  if (!anchored && !anchoredKeys.has(lastKey)) return { d: null, stats }
  return { d: { key: lastKey, run, reason: reasons.get(lastKey) || '' }, stats }
}

function decide(lines, truncated) {
  return analyze(lines, truncated).d
}

function message(d, nid) {
  const tag = TAG_OPEN + d.key + TAG_CLOSE + (nid ? ' (nid:' + nid + ')' : '')
  const head = d.reason.split('\n')[0].slice(0, 100)
  return [
    tag + ' 同一理由の停止フック発火が、前回の通知以降で ' + d.run + ' 件あります。',
    '対象: ' + head,
    '',
    'この反復は「解除不能である」ことを意味しません。示しているのは',
    '**あなたの前提が誤っている可能性が上がった**ことだけです。',
    '（2026-09-10 の事故では 10 回目まで「権限外」と主張し続けましたが、実際は権限内で解けました。）',
    '',
    '反論を続ける前に、前提の再導出を行ってください:',
    '  1. 要求文を逐語で引用し、何を要求しているかを 1 文で言い直す',
    '     — 事故ではゲートが一度も問うていないことに反論し続けていました',
    '  2. 自分が拒否の根拠にしている事実主張を列挙する',
    '  3. その各々を実測（コマンド実行）で確かめる',
    '     — 事故では git status 1 回で 9 ターン前に解消していました',
    '',
    '外部の欠陥を疑うのは、自分側の可能性を実測で潰した後に限ります。',
    '詳細: ~/.claude/rules/blocked-state-judgment.md'
  ].join('\n')
}

function main() {
  const ts = new Date().toISOString()
  const call = process.pid + '-' + Date.now()
  const input = readStdinJson()
  const tp = input && input.transcript_path
  if (!tp || !fs.existsSync(tp)) {
    logCall({ ts, call, stage: 'no_transcript', tid: null, transcript: null, fired: false, key: null, run: null, nid: null })
    return
  }
  const ti = tailInfo(tp)
  const a = analyze(ti.text.split('\n'), ti.truncated)
  const d = a.d
  const s = a.stats
  const nid = d ? crypto.randomBytes(6).toString('hex') + ':' + d.key : null
  logCall({
    ts, call, stage: 'read', tid: hash(require('path').resolve(tp)), transcript: require('path').basename(tp), ino: ti.ino, size: ti.size, range: [ti.start, ti.size], window: WINDOW_BYTES,
    truncated: ti.truncated, broken: s.broken, anchored: s.anchored, bnd: s.bnd, lastKey: s.lastKey, cnt: s.cnt, inj: s.inj, injNids: s.injNids,
    fired: !!d, key: d ? d.key : null, run: d ? d.run : null, nid
  })
  if (!d) return
  const out = { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: message(d, nid) } }
  process.stdout.write(JSON.stringify(out) + '\n')
}

if (require.main === module) {
  try {
    main()
  } catch (e) {
    // 停止を壊さない
  }
  process.exitCode = 0
} else {
  module.exports = { decide, analyze, classify, tailText, tailInfo, logPath, THRESHOLD, WINDOW_BYTES, LOG_CAP_BYTES }
}
