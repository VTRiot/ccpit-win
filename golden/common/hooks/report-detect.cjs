#!/usr/bin/env node
/*
 * report-detect.cjs — 報告書出し忘れ防止ゲートの「検出核」（純粋判定）
 *
 * 責務分離（testable-stop-hook-gate-authoring §1 の node 核）:
 *   本ファイル = 「何を言うべきか」。block 対象があれば完成 block-JSON を JSON.stringify で
 *   stdout に出す。無ければ何も出さない（＝非 block）。「今 block すべきか」（mode / off）は
 *   report-gate.sh（bash 足場）の責務。
 *
 * 直した不具合（2026-08-08）: 旧実装は CLAUDE_PROJECT_DIR を唯一のルートとして
 *   変更検出と報告書探索を行っていたため、
 *     P1 別リポで実務＋報告書、起点リポが dirty → 永久 block
 *     P2 B 段が maxdepth 1 で、`<報告エリア>/<案件дир>/YYYYMMDD_*.md` を見つけられない
 *     P3 日付がディレクトリ名側にあるケース（`20260808_案件/instruction.md`）を拾えない
 *   の 3 経路で「報告書を書いた者を止める」誤ブロックを生んでいた。
 *
 * 中核的不変条件 I1:
 *   本実装は **block する条件を一切広げない**。広げるのは「報告書が在ると認める条件」だけ。
 *   ゆえに「報告書がどこにも無い」ケースの検出力は不変で、新たに通るのは
 *   「このセッションが実際に今日付け報告書を書いていた」ケースだけである。
 *
 *   注記（2026-09-29 CCPIT_075）: projectDir で「無帰属の候補でも報告書と認める」という
 *   旧来の緩さ（T23 が固定）は、`owned` が **unknown（transcript 不読）または known-empty
 *   （読めたが当セッションは何も書いていない）** のときに限って残す。`owned` が
 *   known-nonempty（当セッションが何か書いている）のときは、自分の帰属ある候補を
 *   優先し、無ければ「見つからない」側へ倒す——これは I1 が守る「block しない」方向を
 *   狭めるのではなく、「自分が直せないものを理由に止めない」という同じ原則を
 *   report 探索段（B/A 段）にも C 段（viewingLayerGaps）と同じ規律で揃えたものである。
 *
 * 追補（2026-08-11 AC-2・maintainer承認）: 報告書 MD 検出時に「audience:」行と「準拠Skill:（または
 *   該当Skillなし）」行の**存在**を要求する監査面ゲート（kind: 'md-header'）を追加。I1 の枠外へ
 *   意図的に足した新 block 面で、解除条件は「行が存在すること」のみ（内容判定なし・明示 waiver 行で
 *   通る）。信頼境界と鮮度の設計判断は mdHeaderGaps の注記を参照。
 *
 * 追補（2026-09-29 CCPIT_075・maintainer承認）: 共有ツリーの多レーン運用で、他レーンの未追跡ファイルが
 *   changed 判定に混ざる／他レーンのヘッダ無し .md を projectDir が無条件受理する、の 2 経路で
 *   「自分が直せないものを理由に止められる」誤ブロックを是正。F1: 変更検出を「git の変更 ∩ 当セッ
 *   ション帰属」に絞る（帰属判定不能は削除エントリに限り保守的に attributed とみなす）。F2:
 *   report-detectの探索（B/A段）を owned＞mtime＞（projectDirかつownedが真に空のときのみ）無帰属、
 *   の3段優先順位に統一。F3: md-headerゲートの対象をisAttributed（owned または mtime）な候補に限る。
 *   詳細は実装計画 `_Prompt/02_buildai/20260929_0543_075_report-gate-attribution/`。
 *
 * fail の倒れる向き:
 *   transcript 不読 / git 失敗 / _Prompt 不在 / frontmatter 破損 → いずれも
 *   「ルートを増やさない・報告書を見つけない」＝**旧実装と同じ挙動**へ倒す。黙って全通しにしない。
 *   （判定不能で沈黙するのは node 不在・検出核不在のときだけで、それは bash 足場の責務）
 *
 * env 注入（テスタビリティ・§3）:
 *   RG_STDIN_JSON   定義されていれば stdin(hook 入力 JSON) から session_id/transcript_path/cwd を取る
 *   RG_PROJECT_DIR  プロジェクトルート上書き（既定 CLAUDE_PROJECT_DIR → stdin.cwd → '.'）
 *   RG_ROOTS        ルート集合を ';' 区切りで上書き（テスト用。指定時 transcript 由来の導出はしない）
 *   RG_TRANSCRIPT / RG_SESSION_ID   transcript の解決元
 *   RG_TODAY_8 / RG_TODAY_6         日付上書き（YYYYMMDD / YYMMDD）
 *   RG_CHANGES_RAW  `git status --porcelain -z` 相当の生文字列を注入（git を呼ばない）
 *   RG_SESSION_START_MS  セッション開始 epoch ms 上書き
 */
'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFileSync } = require('child_process')

const NUL = String.fromCharCode(0)
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const MAX_TRANSCRIPT_BYTES = 256 * 1024 * 1024
const MAX_ROOTS = 8
const MAX_WALK_UP = 12
const MAX_DEPTH = 6
const MAX_FILES = 40000 // 全ルート合計の走査ファイル上限
const REPORT_AREA_RE = /(frombuilderai|buildai)/i
const GIT_TIMEOUT_MS = 5000
// 探索の時間予算。Stop hook は 9 本並列・timeout 10 秒なので、報告書探索は 4 秒で切り上げる。
// 上限に触れたら「不完全な探索結果で block しない」向きへ倒す（下記 check() 参照）。
const SEARCH_BUDGET_MS = 4000

// ---------------------------------------------------------------- utilities

/**
 * パス比較の正規化。
 *
 * 大小を畳むか否かを**推測しない**。OS 名で決めるのは誤り（macOS には case-sensitive な APFS が実在）、
 * 大小入替 probe を 1 プロセス 1 値で使い回すのも誤り（ルートごとに FS が違いうる）。
 * どちらも「FS がどう振る舞うか」を当てにいく方式で、当て方を層で足しても穴は残る。
 *
 * そこで**ファイルシステム自身に正解を答えさせる**: `realpath` は Windows なら
 * ディスク上の実際の綴りを返し、case-sensitive FS なら大小違いを別物のまま返す。
 * symlink / junction も実体へ寄るので、同一ファイルの別表記が正しく一致する。
 * 実在しないパスは解決できないので `path.resolve` の結果をそのまま使う
 * （比較相手が実在するなら不一致でよい＝帰属を主張できないだけで、安全側に倒れる）。
 */
function normPath(p) {
  let abs
  try {
    abs = path.resolve(String(p))
  } catch (e) {
    return null
  }
  try {
    return fs.realpathSync.native(abs)
  } catch (e) {
    return abs
  }
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

function resolveToday(o, env) {
  const t8 = o.today8 || env.RG_TODAY_8
  const t6 = o.today6 || env.RG_TODAY_6
  if (t8 && t6) return { t8, t6 }
  const d = new Date(typeof o.nowMs === 'number' ? o.nowMs : Date.now())
  const y = d.getFullYear()
  const mo = pad2(d.getMonth() + 1)
  const da = pad2(d.getDate())
  return { t8: `${y}${mo}${da}`, t6: `${String(y).slice(2)}${mo}${da}` }
}

function isDirSafe(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch (e) {
    return false
  }
}

function existsSafe(p) {
  try {
    fs.statSync(p)
    return true
  } catch (e) {
    return false
  }
}

function mtimeMs(p) {
  try {
    return fs.statSync(p).mtimeMs
  } catch (e) {
    return null
  }
}

function newBudget(o) {
  const ms = typeof o.searchBudgetMs === 'number' ? o.searchBudgetMs : SEARCH_BUDGET_MS
  // 実時計を使う（o.nowMs はテストの日付固定用であり、締切の基準にしてはならない）
  return { deadline: Date.now() + ms, files: 0, dirs: 0, exhausted: false }
}

/**
 * 深さ・件数・**時間**の 3 つで上限をかけた走査。onFile が true を返した時点で即打ち切る
 * （典型ケースでは最初の 1 件で止まるので、`maxdepth` 撤廃のコストを吸収できる）。
 * 読めない枝は黙って飛ばす。上限に触れたら ctx.exhausted を立てる。
 * 戻り値: onFile が true を返して打ち切ったか。
 */
function walkStream(root, maxDepth, ctx, onFile) {
  let stopped = false
  function walk(dir, depth) {
    if (stopped || ctx.exhausted || depth > maxDepth) return
    if (++ctx.dirs % 64 === 0 && Date.now() > ctx.deadline) {
      ctx.exhausted = true
      return
    }
    let ents
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true })
    } catch (e) {
      return
    }
    for (const e of ents) {
      if (stopped || ctx.exhausted) return
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        walk(p, depth + 1)
        continue
      }
      if (++ctx.files > MAX_FILES) {
        ctx.exhausted = true
        return
      }
      if (onFile(p)) {
        stopped = true
        return
      }
    }
  }
  if (Date.now() > ctx.deadline) {
    ctx.exhausted = true
    return false
  }
  walk(root, 0)
  return stopped
}

// -------------------------------------------------- git status --porcelain -z

/**
 * porcelain -z を解析する。
 * 実採取（git 2.52）で確認したレイアウト:
 *   通常   : "XY <path>"
 *   rename : "R  <new>" の**次の NUL フィールドが status 接頭辞を持たない裸の旧パス**
 *            （旧パス側から 3 文字剥がすとパスが壊れる）
 *   未追跡ディレクトリは "?? dir/" と畳まれる（中身は列挙されない）
 * 戻り値: [{ xy, paths: [..] }]
 */
function parsePorcelainZ(raw) {
  const entries = []
  if (!raw) return entries
  const fields = String(raw).split(NUL)
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]
    if (!f) continue
    const xy = f.slice(0, 2)
    const paths = [f.slice(3)]
    // rename/copy は index 側（`R `/`C `）だけでなく **worktree 側（` R`/` C`・`RM` 等）**にも出る。
    // 片側しか見ないと旧パスフィールドを独立エントリとして誤解析し、
    // 「旧実装なら rename 行ごと除外されていた `.bak` 絡みの変更」が非除外として残る
    // ＝**新だけ block** ＝ I1 違反になる（Codex 実装レビュー[1]）。
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') {
      const orig = fields[i + 1]
      if (typeof orig === 'string' && orig !== '') {
        paths.push(orig) // 裸のパス。slice しない
        i++
      }
    }
    entries.push({ xy, paths })
  }
  return entries
}

/**
 * 旧実装の `grep -v '\.bak' | grep -v 'CLAUDE\.local\.md'` と**同一の除外集合**にする。
 * 旧実装は行単位の部分一致で、rename 行は "R old -> new" の 1 行＝両側を含んでいた。
 * よって「エントリのいずれかのパスが部分一致したら除外」が等価。
 * 位置限定（basename のみ・末尾のみ）へは変えない＝ block 条件を動かさない。
 */
function isExcludedEntry(e) {
  return e.paths.some((p) => p.indexOf('.bak') >= 0 || p.indexOf('CLAUDE.local.md') >= 0)
}

function gitPorcelainZ(root) {
  try {
    return execFileSync('git', ['-C', root, 'status', '--porcelain', '-z'], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch (e) {
    // 旧実装は `2>/dev/null` で失敗時に空を得て通過していた。向きを変えない。
    return ''
  }
}

// ------------------------------------------------------------- transcript

/**
 * transcript(JSONL) を 1 度だけ読み、
 *   owned   : 自セッションが Write/Edit 系で触ったファイル集合（正規化済み）
 *   startMs : セッション開始 epoch ms（先頭から最初に見つかった timestamp）
 * を返す。読めない/壊れている場合は { owned:null, startMs:null }＝帰属不明。
 */
function scanTranscript(transcriptPath) {
  const empty = { owned: null, startMs: null }
  let st
  try {
    st = fs.statSync(transcriptPath)
  } catch (e) {
    return empty
  }
  if (st.size > MAX_TRANSCRIPT_BYTES) return empty
  let text
  try {
    text = fs.readFileSync(transcriptPath, 'utf8')
  } catch (e) {
    return empty
  }
  // owned: 比較用の正規化キー（realpath 解決済み） / ownedRaw: **原文のまま**（ルート遡上＝fs 操作用）。
  // 正規化キーを fs 操作へ流用しない。realpath は実在するパスしか解決できず、
  // 実在しないものは resolve 結果へフォールバックするため、両者は必ずしも一致しない。
  const owned = new Set()
  const ownedRaw = []
  let startMs = null
  for (const line of text.split('\n')) {
    if (!line) continue
    const hasPath = line.indexOf('file_path') >= 0 || line.indexOf('notebook_path') >= 0
    // 先頭付近は timestamp を拾うために parse する。以降は file_path を含む行だけ（コスト対策）。
    if (!hasPath && startMs !== null) continue
    let j
    try {
      j = JSON.parse(line)
    } catch (e) {
      continue
    }
    if (startMs === null && j && typeof j.timestamp === 'string') {
      const t = Date.parse(j.timestamp)
      if (!Number.isNaN(t)) startMs = t
    }
    if (!hasPath) continue
    const content = j && j.message && j.message.content
    if (!Array.isArray(content)) continue
    for (const b of content) {
      if (!b || b.type !== 'tool_use' || !EDIT_TOOLS.has(b.name)) continue
      const fp = b.input && (b.input.file_path || b.input.notebook_path)
      const n = fp ? normPath(fp) : null
      if (n && !owned.has(n)) {
        owned.add(n)
        ownedRaw.push(fp)
      }
    }
  }
  return { owned, ownedRaw, startMs }
}

/** session_id から transcript の実体を引く（~/.claude/projects/<slug>/<sid>.jsonl）。 */
function resolveTranscript(transcriptPath, sessionId) {
  if (transcriptPath) {
    try {
      if (fs.statSync(transcriptPath).isFile()) return transcriptPath
    } catch (e) {
      /* 続行 */
    }
  }
  if (!sessionId || !/^[0-9a-fA-F-]{8,}$/.test(sessionId)) return null
  const base = path.join(os.homedir(), '.claude', 'projects')
  let dirs
  try {
    dirs = fs.readdirSync(base)
  } catch (e) {
    return null
  }
  for (const d of dirs) {
    const p = path.join(base, d, sessionId + '.jsonl')
    try {
      if (fs.statSync(p).isFile()) return p
    } catch (e) {
      /* 次へ */
    }
  }
  return null
}

// ------------------------------------------------------------------ roots

/**
 * ファイルパスから「リポジトリ/文書ルート」らしき最寄り祖先へ遡上する。
 *
 * 返すのは **`.git` または `_Prompt` を子として持つディレクトリ**であって、`_Prompt` 自身ではない。
 * 後段が `root/_Prompt` を探索するため、`_Prompt` 自身を返すと `_Prompt/_Prompt` を探して
 * 追加ルート側の報告書を丸ごと見落とす（Codex 第4巡[1]）。T28 で固定している。
 * `.git` は worktree では**ファイル**なので dir/file を問わない（実採取で確認）。
 * 見つからなければ null（＝ルートを増やさない＝安全側）。
 */
function ascendToRoot(filePath) {
  let dir
  try {
    dir = path.dirname(path.resolve(filePath))
  } catch (e) {
    return null
  }
  for (let i = 0; i < MAX_WALK_UP; i++) {
    if (existsSafe(path.join(dir, '.git')) || isDirSafe(path.join(dir, '_Prompt'))) return dir
    const parent = path.dirname(dir)
    if (!parent || parent === dir) return null
    dir = parent
  }
  return null
}

/**
 * projectDir ＋ transcript 由来ルートの重複排除済み配列（projectDir が必ず先頭）。
 * 引数 `paths` は**原文のパス**を渡すこと（比較用の正規化キーを渡してはならない。
 * 正規化キーは realpath 解決済み or フォールバック値であり、fs 操作の入力として等価ではない）。
 */
function resolveRoots(projectDir, paths) {
  const roots = [projectDir]
  const seen = new Set([normPath(projectDir)])
  if (paths) {
    for (const p of paths) {
      if (roots.length >= MAX_ROOTS) break
      const r = ascendToRoot(p)
      if (!r) continue
      const n = normPath(r)
      if (!n || seen.has(n)) continue
      seen.add(n)
      roots.push(r)
    }
  }
  return roots
}

// --------------------------------------------------------- report discovery

function startsWithToday(name, today) {
  return name.startsWith(today.t8 + '_') || name.startsWith(today.t6 + '_')
}

function hasFrontmatter(file) {
  try {
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(8)
    const n = fs.readSync(fd, buf, 0, 8, 0)
    fs.closeSync(fd)
    return n >= 3 && buf.slice(0, 3).toString('utf8') === '---'
  } catch (e) {
    return false
  }
}

function readFmField(file, key) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    return ''
  }
  const m = text.match(new RegExp('^' + key + ':[ \\t]*(.*)$', 'm'))
  if (!m) return ''
  return m[1]
    .replace(/\s*#.*$/, '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim()
}

/**
 * セッション帰属。owned に在る、または mtime がセッション開始以降。
 * owned だけでは Bash / 生成スクリプト / cp / rename で作られた正当な報告書を弾いてしまう
 * （＝直している当の誤ブロックの再発）ため OR で mtime を足す。
 * 帰属情報が無い（transcript 不読）ときは false に倒れるが、そのとき追加ルート自体が
 * 存在しないため本判定は評価されない。
 */
function isAttributed(file, owned, sessionStartMs) {
  const n = normPath(file)
  if (owned && n && owned.has(n)) return true
  if (typeof sessionStartMs === 'number') {
    const m = mtimeMs(file)
    if (m !== null && m >= sessionStartMs) return true
  }
  return false
}

/**
 * F1（2026-09-29 CCPIT_075）用の帰属判定。isAttributed() とは **意図的に逆向き**の
 * fail 方向を持つ（設計判断は report-detect.cjs 冒頭コメント・実装計画の §4-2a 参照）:
 *
 *   isAttributed()        : 判定不能 → 「自分のものではない」（報告書候補の採否に使う）
 *   isChangeAttributed()  : 判定不能 → 「自分の変更である」（変更検出の絞り込みに使う）
 *
 * 理由: 前者で判定不能を「自分のもの」に倒すと他レーンの成果物を自分の報告書と誤認する
 * （本件のバグの再発）。後者で判定不能を「自分のものではない」に倒すと、削除だけを行った
 * セッションが「変更なし」と誤判定され I1（自分の変更＋報告書なしは block）が弱まる。
 *
 * git エントリの path は `-C root` 相対（または既に絶対）なので、比較・stat の前に
 * root に対して解決する。rename エントリは複数 path を持つ（新旧両方）ため、
 * いずれか 1 つでも attributed と判定できれば true を返す。全 path が stat 不能
 * （＝純粋な削除。rename の場合は新パスが実在するのでここに該当しない）なら、
 * 自分のものか他レーンのものか区別する手段が無いため保守的に true（attributed）を返す。
 */
function isChangeAttributed(entry, root, owned, sessionStartMs) {
  // 保守的な「判定不能 → attributed」フォールバックは**削除ステータス（xy に 'D'）のときだけ**
  // 適用する（実装時の自己検証で訂正）。追加・変更（`??`/`M`/`A` 等）のエントリが指す path が
  // stat 不能なのは実運用では起こらない異常系であり、ここへ同じフォールバックを適用すると
  // 「他レーンの未追跡ファイルが git 上は dirty だが実体を伴わない」ような合成ケースまで
  // 一律 attributed になってしまい、F1 の絞り込みが効かなくなる。
  const isDeleteStatus = entry.xy && (entry.xy[0] === 'D' || entry.xy[1] === 'D')
  let anyExists = false
  for (const p of entry.paths) {
    const abs = path.isAbsolute(p) ? p : path.resolve(root, p)
    const n = normPath(abs)
    if (owned && n && owned.has(n)) return true
    const m = mtimeMs(abs)
    if (m !== null) {
      anyExists = true
      if (typeof sessionStartMs === 'number' && m >= sessionStartMs) return true
    }
  }
  if (!anyExists && isDeleteStatus) return true // 純粋な削除・判定不能 → 保守的に attributed とみなす
  return false
}

function inReportArea(file, promptDir) {
  const rel = path.relative(promptDir, file)
  return rel.split(/[\\/]/).some((seg) => REPORT_AREA_RE.test(seg))
}

/** 帰属クラス（優先順位）。owned が最優先、mtime のみが次点、無帰属が最下位。 */
function attrClass(f, owned, sessionStartMs) {
  const n = normPath(f)
  if (owned && n && owned.has(n)) return 2 // owned
  if (isAttributed(f, owned, sessionStartMs)) return 1 // mtime のみ
  return 0 // 無帰属
}

/**
 * 1 ルート内で「今日付け報告書が在る」と認められるかを判定する（2026-09-29 CCPIT_075・F2）。
 *
 * B 段・stage A とも 3 段優先順位: ① owned 一致（最優先） ② owned に無いが mtime 帰属
 * ③ **projectDir かつ owned が unknown（null）または known-empty（size===0）のときに限り**、
 * 無帰属の候補も可（T23 が固定する現行の意図的な緩さを温存）。
 * P3 分岐だけは①②の 2 段のみ（legacy fallback 無し。T18/T20 の「緩すぎない」締めを維持）。
 *
 * 早期 exit は「① owned 一致が見つかった時点」のみ。②③は見つけても走査を継続し、
 * より優先度の高い①を見逃さない（予算枯渇で打ち切られても、その時点で保持している
 * ②③の hit はそのまま採用する＝見つけていた手がかりを捨てない）。
 */
function rootHasReport(root, isProjectDir, today, owned, sessionStartMs, ctx) {
  const promptDir = path.join(root, '_Prompt')
  if (!isDirSafe(promptDir)) return null
  const legacyFallbackAllowed = isProjectDir && (owned === null || owned.size === 0)

  let ownedHit = null
  let mtimeHit = null
  let anyHit = null
  const aPointerCandidates = []

  walkStream(promptDir, MAX_DEPTH, ctx, (f) => {
    const bn = path.basename(f)
    const todayNamed = startsWithToday(bn, today)
    if (todayNamed && /\.md$/i.test(f)) aPointerCandidates.push(f)
    if (!inReportArea(f, promptDir)) return false

    if (todayNamed) {
      const cls = attrClass(f, owned, sessionStartMs)
      if (cls === 2) {
        ownedHit = { stage: 'B', file: f }
        return true // 唯一の early exit
      }
      if (cls === 1 && !mtimeHit) mtimeHit = { stage: 'B', file: f }
      if (cls === 0 && !anyHit) anyHit = { stage: 'B', file: f }
      return false
    }
    // P3: 日付がディレクトリ名側。緩めすぎると README / テンプレ / 生成途中 HTML を
    // 報告書と誤認するため、.md ＋ frontmatter ＋ セッション帰属を要求する（.html 単独は不可）。
    // legacy fallback は対象外（無帰属の P3 候補は捨てる）。
    if (!/\.md$/i.test(f)) return false
    if (!startsWithToday(path.basename(path.dirname(f)), today)) return false
    if (!hasFrontmatter(f)) return false
    const clsP3 = attrClass(f, owned, sessionStartMs)
    if (clsP3 === 2) {
      ownedHit = { stage: 'B-P3', file: f }
      return true
    }
    if (clsP3 === 1 && !mtimeHit) mtimeHit = { stage: 'B-P3', file: f }
    return false
  })
  if (ownedHit) return ownedHit
  // B 段だけでは owned 一致が無くても、**stage A に owned 一致があれば B 段の mtimeHit/anyHit を
  // 上回る**必要がある（例: 自分の報告書が「output_dir 経由の自己参照ポインタ」でしか到達できない
  // ディレクトリに在り、B 段の報告エリアには他レーンの mtime-attributed な候補しか無いケース）。
  // そのため mtimeHit/anyHit は即 return せず、stage A を評価してから最終判定する。

  // --- stage A: pointer/target のペア単位で帰属クラスを決める ---
  for (const f of aPointerCandidates) {
    const od = readFmField(f, 'output_dir')
    if (!od) continue
    const targetDir = path.isAbsolute(od) ? od : path.join(root, od)
    let names
    try {
      names = fs.readdirSync(targetDir, { withFileTypes: true })
    } catch (e) {
      continue
    }
    const pointerCls = attrClass(f, owned, sessionStartMs)
    for (const ent of names) {
      if (ent.isDirectory()) continue
      if (!startsWithToday(ent.name, today)) continue
      const target = path.join(targetDir, ent.name)
      const targetCls = attrClass(target, owned, sessionStartMs)
      const pairCls = Math.max(pointerCls, targetCls)
      if (pairCls === 2) {
        ownedHit = { stage: 'A', file: target, pointer: f }
        break
      }
      if (pairCls === 1 && !mtimeHit) mtimeHit = { stage: 'A', file: target, pointer: f }
      if (pairCls === 0 && !anyHit) anyHit = { stage: 'A', file: target, pointer: f }
    }
    if (ownedHit) break
  }
  if (ownedHit) return ownedHit
  if (mtimeHit) return mtimeHit
  if (legacyFallbackAllowed && anyHit) return anyHit
  return null
}

// ------------------------------------------- 報告書 MD ヘッダ行の存在（AC-2）

/*
 * mdHeaderGaps — 検出済み報告書 MD に対する「監査面」ゲート（2026-08-11 AC-2・maintainer承認）。
 *
 * 要求するのは「audience:」行と「準拠Skill:（または 該当Skillなし）」行の**存在**のみ。
 * 内容は判定しない。ゆえに明示棄却 waiver（例: `準拠Skill: なし（maintainer棄却指示 2026-08-11）`）は
 * 行が存在する時点で通る＝「行が存在すること」だけが block 解除条件。
 *
 * 設計判断（review-gate-integrity-traps の 3 罠への明示的な位置取り）:
 *   罠1 意味論: 本ゲートは承認ゲートでない（verdict allowlist は存在しない）。「書いたか」を強制し
 *     「正しいか」は問わない。ここへ内容判定を後付けしないこと（waiver 仕様が壊れる）。
 *   罠2 鮮度: 判定は Stop 時点で対象 md を 1 回 readFileSync した raw に対して行う（single-read）。
 *     単一ユーザー・ローカル・同一層のため CAS / 再読込束ねは scope out（適用層が別に無い）。
 *   罠3 信頼境界: 報告書自身の宣言＝ self-attest を判定に使う。真正性（実際に準拠したか）は
 *     証明しない。これは意図的な許容であり、真正性はmaintainerの人監査で閉じる
 *     （2026-08-11 の準拠虚偽表記を人監査が検出済み＝監査線が実働している前提の設計）。
 *     外部権威ストア・署名・書込権限分離は単一ユーザー境界のため scope out（本注記が明示）。
 *
 * fail の倒れる向き: md 以外が gate を満たした場合・md が読めない場合は null（＝判定対象なし・
 * block しない）。「報告書 MD 検出時」以外へ block 面を広げない。
 * 戻り値: 欠落ラベルの配列（空 = 充足）／ null = 対象外・判定不能。
 */
const HEADER_AUDIENCE_RE = /^[ \t]*audience[ \t]*[:：]/im
const HEADER_SKILL_RE = /^[ \t]*(?:準拠Skill[ \t]*[:：]|該当Skillなし)/im

function mdHeaderGaps(file) {
  if (!/\.md$/i.test(String(file))) return null
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    return null
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1) // 先頭 BOM は行頭判定の前に剥ぐ
  const missing = []
  if (!HEADER_AUDIENCE_RE.test(text)) missing.push('「audience:」行')
  if (!HEADER_SKILL_RE.test(text)) missing.push('「準拠Skill:（または 該当Skillなし）」行')
  return missing
}

// ------------------------------------------------- C 段（maintainer閲覧層ゲート）

/**
 * 旧実装と**同一の適用範囲**を保つ（projectDir のみ・今日付け名の .md のみ）。
 * ルートを広げると新規 block 面が生まれ I1 に反するため、意図的に広げない。
 *
 * owned（当セッションが Edit/Write/NotebookEdit で触ったパスの正規化集合）で対象を絞る。
 * 同一リポジトリを複数レーンの CC が同時に回すとき、他レーンが落とした今日付け MD で
 * 自分の Stop が止まる誤発火を防ぐ（2026-09-04）。判定は**狭まる方向のみ**で新規 block 面は
 * 生まれないため I1 と整合する。owned が空集合なら「当セッションは何も書いていない」＝
 * 閲覧層の義務も無い、と解釈して gap 0 を返す。
 *
 * 交換条件（既知・意図的）: bash リダイレクト（cat > x.md）やサブエージェント経由で書かれた
 * MD は owned に載らないため検査対象から外れる。多レーン運用では誤発火の害が上回るため許容する。
 */
function viewingLayerGaps(projectDir, today, ctx, owned) {
  const promptDir = path.join(projectDir, '_Prompt')
  if (!existsSafe(path.join(projectDir, 'CORE', 'PROTOCOL.md')) || !isDirSafe(promptDir)) return []
  if (!owned || owned.size === 0) return [] // 帰属先が無い → 自分の義務は無い
  const c = ctx || newBudget({})
  const gaps = []
  walkStream(promptDir, MAX_DEPTH, c, (f) => {
    if (!/\.md$/i.test(f)) return false
    if (!startsWithToday(path.basename(f), today)) return false
    if (!owned.has(normPath(f))) return false // 他レーンが書いた MD は自分の義務ではない
    const html = f.replace(/\.md$/i, '.html')
    const hm = mtimeMs(html)
    const mm = mtimeMs(f)
    if (hm !== null && mm !== null && !(mm > hm)) return false // html が在り md が新しくない
    let text = ''
    try {
      text = fs.readFileSync(f, 'utf8')
    } catch (e) {
      /* 読めなければ gap 扱い */
    }
    if (/file:\/\/\/[^\s"]*\.html/.test(text)) return false
    gaps.push(f)
    return false // 全件集める（早期 exit しない）
  })
  return gaps
}

// ------------------------------------------------------------------ check

function check(opts) {
  const o = opts || {}
  const env = o.env || {}
  const projectDir = o.projectDir || '.'
  const today = resolveToday(o, env)

  // 1) 帰属情報（transcript 1 回読み）— F1（2026-09-29 CCPIT_075）が変更検出の時点で
  //    必要とするため、旧来の手順 2) から 1) の前へ移した。
  //    owned    = 比較用の正規化集合 / ownedRaw = 原文パス（ルート遡上＝fs 操作に使う）
  let owned = o.owned ? new Set([...o.owned].map(normPath).filter(Boolean)) : null
  let ownedRaw = o.owned ? [...o.owned] : null
  let sessionStartMs = typeof o.sessionStartMs === 'number' ? o.sessionStartMs : null
  if (!owned || sessionStartMs === null) {
    const tp = resolveTranscript(o.transcript, o.sessionId)
    if (tp) {
      const scanned = scanTranscript(tp)
      if (!owned) {
        owned = scanned.owned
        ownedRaw = scanned.ownedRaw
      }
      if (sessionStartMs === null) sessionStartMs = scanned.startMs
    }
  }

  // 2) 変更検出（ルートは projectDir のみ＝旧実装のまま。I1 を守る）
  //    F1（2026-09-29 CCPIT_075）: owned が判明している（=== null でない）ときは
  //    「git の変更 ∩ 当セッション帰属」に絞る（isChangeAttributed。削除は保守的に attributed 側）。
  //    owned が null（transcript 真に不読）のときは、現行どおり無条件で見る（安全側フォールバック）。
  const raw = typeof o.changesRaw === 'string' ? o.changesRaw : gitPorcelainZ(projectDir)
  const entries = parsePorcelainZ(raw).filter((e) => !isExcludedEntry(e))
  const changed =
    owned === null
      ? entries.length > 0
      : entries.some((e) => isChangeAttributed(e, projectDir, owned, sessionStartMs))
  if (!changed) return { block: false, why: 'no-changes' }

  // 3) ルート集合
  const roots =
    Array.isArray(o.roots) && o.roots.length ? o.roots : resolveRoots(projectDir, ownedRaw)

  // 4) 報告書探索（時間・件数の予算つき。早期 exit あり）
  const ctx = newBudget(o)
  let found = null
  const pdNorm = normPath(projectDir)
  for (const r of roots) {
    found = rootHasReport(r, normPath(r) === pdNorm, today, owned, sessionStartMs, ctx)
    if (found || ctx.exhausted) break
  }
  // 探索を最後までやれていないなら、**不完全な結果で block しない**（倒れる向きの明示）。
  // 根拠: hook が timeout しても結果は「出力なし＝非 block」であり、そこと挙動を揃える。
  // 沈黙はせず stderr に残す（黙って全通しにしない）。
  if (!found && ctx.exhausted) {
    try {
      process.stderr.write(
        `[report-gate] 探索予算超過のため判定を見送り（files=${ctx.files} dirs=${ctx.dirs}）\n`
      )
    } catch (e) {}
    return { block: false, why: 'budget-exhausted', roots, budget: ctx }
  }
  if (!found) {
    return {
      block: true,
      kind: 'no-report',
      roots,
      reason:
        'コード変更が検出されましたが、今日付けの報告書 MD が見つかりません。探索したルート: ' +
        roots.map((r) => String(r).replace(/\\/g, '/')).join(' , ') +
        ' 。各ルートの _Prompt 配下で (a) frontmatter に output_dir: を書いた今日付け MD と、その先の今日付けファイル、' +
        'または (b) 報告エリア（ディレクトリ名に buildai / frombuilderai を含む）配下の ' +
        today.t8 +
        '_* で始まる成果物（サブディレクトリ可・拡張子は問わないが報告書 MD が本則）を探しています。' +
        '別リポジトリに報告書を置く場合は、そのリポジトリのファイルを本セッションで編集していれば探索対象に入ります。' +
        'テスタブル実装シーケンス Step D（報告書 MD 作成）を完了してから停止してください。' +
        '（本ゲートが不要な状況であれば、人間が ~/.ccpit/app-config.json の "reportGateMode" を "off" にすることで無効化できます）'
    }
  }

  // 4.5) 報告書 MD ヘッダ行の存在（AC-2 2026-08-11・監査面）
  //      stage A はポインタ md 側の記載でも可（説明責任の md がどちらかに在ればよい）
  //      F3（2026-09-29 CCPIT_075）: 対象は isAttributed（owned または mtime）を満たす
  //      候補にだけ絞る。無帰属（legacy fallback で受理された他レーンの候補）は対象外——
  //      自分が直せない他人のファイルのヘッダ欠落を理由に止めない。
  const hdrCandidates = []
  if (
    found.file &&
    /\.md$/i.test(String(found.file)) &&
    isAttributed(found.file, owned, sessionStartMs)
  )
    hdrCandidates.push(found.file)
  if (
    found.pointer &&
    /\.md$/i.test(String(found.pointer)) &&
    isAttributed(found.pointer, owned, sessionStartMs)
  )
    hdrCandidates.push(found.pointer)
  if (hdrCandidates.length) {
    let hdrOk = false
    let hdrWorst = null
    for (const f of hdrCandidates) {
      const miss = mdHeaderGaps(f)
      if (miss === null || miss.length === 0) {
        hdrOk = true
        break
      }
      if (!hdrWorst || miss.length < hdrWorst.miss.length) hdrWorst = { file: f, miss }
    }
    if (!hdrOk && hdrWorst) {
      return {
        block: true,
        kind: 'md-header',
        roots,
        found,
        header: hdrWorst,
        reason:
          '報告書 MD は検出済みですが、必須ヘッダ行が欠けています: ' +
          String(hdrWorst.file).replace(/\\/g, '/') +
          ' に ' +
          hdrWorst.miss.join(' と ') +
          ' がありません。報告書冒頭（frontmatter 内でも本文冒頭でも可）に「audience: <宛先>」と「準拠Skill: <Skill名>」' +
          '（該当が無ければ「準拠Skill: 該当Skillなし」。maintainerが棄却済みなら「準拠Skill: なし（maintainer棄却指示 YYYY-MM-DD）」等の明示棄却でも可）' +
          'の行を追記してから停止してください。本ゲートは行の存在のみを確認し内容は判定しません（監査面の強制であり真正性証明ではありません）。'
      }
    }
  }

  // 5) C 段（projectDir のみ・当セッションが書いた MD のみ＝多レーン誤発火の遮断）
  const gaps = viewingLayerGaps(projectDir, today, ctx, owned)
  if (gaps.length && !ctx.exhausted) {
    return {
      block: true,
      kind: 'viewing-layer',
      roots,
      gaps,
      reason:
        '報告書 MD は検出済みですが、閲覧層(CORE/PROTOCOL.md 規約)が未充足です。未充足の今日付け MD: ' +
        gaps.map((g) => String(g).replace(/\\/g, '/')).join(' | ') +
        ' 。各 MD について (a) node ' +
        os.homedir().replace(/\\/g, '/') +
        '/.claude/skills/md-render/md2html.cjs <MD> <同基名.html> の 2 引数で生成する' +
        '(第 2 引数省略時は stdout のみでファイルは作られない。--verify PASS 推奨、MD 更新時は HTML 再生成)、' +
        'または (b) 既存 HTML を指す file:///...html アドレスを本文に記載してください。' +
        '加えて hook は応答本文を検査できません: 最終応答の末尾に主対象 1 件の file:/// アドレス' +
        '(encodeURI 済み・コード表記)を貼ってから停止してください。'
    }
  }

  return { block: false, why: 'report-found', found, roots }
}

// ------------------------------------------------------------------- main

function readStdinJson() {
  let raw
  try {
    raw = fs.readFileSync(0, 'utf8')
  } catch (e) {
    return null
  }
  if (!raw || !raw.trim()) return null
  try {
    const j = JSON.parse(raw)
    return {
      sessionId: j.session_id || null,
      transcript: j.transcript_path || null,
      cwd: j.cwd || null
    }
  } catch (e) {
    return null
  }
}

function envOpts(env) {
  const o = { env }
  let stdin = null
  if (env.RG_STDIN_JSON !== undefined) stdin = readStdinJson()
  o.projectDir =
    env.RG_PROJECT_DIR || env.CLAUDE_PROJECT_DIR || (stdin && stdin.cwd) || '.'
  if (env.RG_ROOTS) o.roots = env.RG_ROOTS.split(';').filter(Boolean)
  o.transcript = env.RG_TRANSCRIPT || (stdin && stdin.transcript) || null
  o.sessionId = env.RG_SESSION_ID || (stdin && stdin.sessionId) || null
  if (env.RG_CHANGES_RAW !== undefined) o.changesRaw = env.RG_CHANGES_RAW
  if (env.RG_SESSION_START_MS) o.sessionStartMs = Number(env.RG_SESSION_START_MS)
  return o
}

function main() {
  const dryRun = process.argv.includes('--dry-run')
  const opts = envOpts(process.env)
  let verdict
  try {
    verdict = check(opts)
  } catch (e) {
    // 判定そのものが壊れたら旧実装と同じ「見つからない側」ではなく沈黙に倒す。
    // ここで block すると「壊れている限り永久に停止できない」詰みを生むため。
    try {
      process.stderr.write('[report-gate] 判定に失敗（沈黙でスキップ）: ' + e.message + '\n')
    } catch (e2) {}
    return
  }
  if (dryRun) {
    console.log(JSON.stringify(verdict, null, 2))
    return
  }
  if (!verdict.block) return // 沈黙 = 非 block
  process.stdout.write(JSON.stringify({ decision: 'block', reason: verdict.reason }) + '\n')
}

module.exports = {
  check,
  parsePorcelainZ,
  isExcludedEntry,
  scanTranscript,
  resolveTranscript,
  ascendToRoot,
  resolveRoots,
  rootHasReport,
  viewingLayerGaps,
  mdHeaderGaps,
  isAttributed,
  isChangeAttributed,
  attrClass,
  normPath,
  NUL
}

if (require.main === module) main()
