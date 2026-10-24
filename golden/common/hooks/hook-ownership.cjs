#!/usr/bin/env node
/*
 * hook-ownership.cjs — Stop hook 共有の「所有権」プリミティブ（純粋・判定のみ）
 *
 * 何を解くか:
 *   共有ストア（提案プール・報告書ツリー等）を全走査する Stop hook は、**自分が一度も触っとらん
 *   他セッションの成果物**で停止を block してしまう。相手が編集を続ける限り自力で解消できず、
 *   解消しようとすると他人のファイルを書き換えることになって**追いかけっこ**になる
 *   （2026-08-07 に comment-response-gate で実発生、2026-08-21 に recommend-review-gate で再発）。
 *
 *   本モジュールは「**このセッションはこのファイルを触ったか**」という単一の事実だけを答える。
 *   事実が 1 つである以上、実装も 1 つであるべきという理由でここへ集約している
 *   （hook ごとに写経すると「同じ転写・同じ Write・同じファイルなのに hook A では捕まり B では
 *   捕まらん」という説明不能な非対称が残る）。
 *
 * fail-open の向き（**逆にするな**）:
 *   所有権が解決できない場合は「対象ゼロ」に倒す。判定不能時に block する実装は、
 *   「hook 入力が壊れとる限り永久に停止できん」という、元のバグより悪い詰みを生む。
 *   ただし「解決できて 0 件」と「解決できなかった」は**状態として区別**して返す（呼び出し側が
 *   telemetry へ出せるように）。区別できないまま沈黙すると、ゲートが静かに死んでも誰も気付かん。
 *
 * 何を所有と数えるか:
 *   ファイルを直接書くツール（EDIT_TOOLS）の file_path のみ。Bash 経由の生成（`> x.md`・tee・cp 等）は
 *   **意図的に捕捉しない**。シェル構文（変数展開・パイプ・heredoc・スクリプト経由）の静的解析は
 *   原理的に網羅不能で、中途半端な正規表現は偽陽性を生む。リスクは非対称である:
 *     偽陰性（自分のファイルを見逃す）＝ リマインダが 1 件鳴らん。
 *     偽陽性（他人のファイルを拾う）＝ **追いかけっこの再発**＝ 停止不能。
 *   よって偽陰性側へ倒す。この受容は呼び出し側の報告書へ明記すること。
 */
'use strict'
const fs = require('fs')
const path = require('path')
const os = require('os')

/** 「ファイルを直接書く」ツール。Bash 等は含めない（上記の非対称性ゆえ）。 */
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/**
 * 転写走査の上限。Stop hook は timeout 10 秒で走るため、異常な入力を掴まされても
 * 時間内に諦められるようにする。実測（単一 10.6MB 転写 = 49ms / 31.6MB = 126ms）に対し十分な余裕。
 * 超過時は部分集合で判定せず `unavailable` に倒す（部分集合だと偽陰性が静かに混入する）。
 */
const MAX_TRANSCRIPT_FILES = 512
const MAX_TOTAL_TRANSCRIPT_BYTES = 256 * 1024 * 1024

/** 所有権の解決状態。`unavailable` と `empty-owned` を混ぜない（ゲート死亡の観測点）。 */
const STATE_ACTIVE = 'active' /** 解決でき、1 件以上の編集ファイルが在る */
const STATE_EMPTY = 'empty-owned' /** 解決できたが編集ファイルが 0 件（新規セッション等） */
const STATE_UNAVAILABLE = 'unavailable' /** 転写を解決/読取できない・上限超過 */

/** session_id として受け入れる形（UUID 様）。緩めに見るが、パス片の混入は弾く。 */
const SESSION_ID_RE = /^[0-9a-fA-F-]{8,}$/

/**
 * パス比較の正準形。**両側（所有権集合・検査対象）に必ず同じ関数を通すこと。**
 *
 * 相対パスの扱いが要（2026-08-22 実測）: 実転写の file_path は絶対が大半だが、
 * `~/...`（チルダ）と `CORE\x.md` のような**相対も実在する**。
 *   - 旧実装は `path.resolve()` のみだったため、相対と `~/` を **hook プロセスの cwd** へ束縛していた。
 *     hook の cwd は任意なので、これは「静かに一致しない」＝取りこぼしを生んでいた。
 *   - よって相対は **hook 入力の `cwd`**（＝セッションの作業ディレクトリ・権威ある値）で解決する。
 *     `baseCwd` が無ければ **null**（＝所有権に数えない）。`process.cwd()` へは**絶対に束縛しない**。
 *
 * Windows は大小・区切り・8.3 短縮名・junction が揺れるので realpath で正準化してから小文字化する。
 * POSIX では**小文字化しない**（case-sensitive な別ファイルを衝突させないため）し、
 * 区切りの置換もしない（そのまま statSync できる形を保つ）。
 */
function normPath(p, baseCwd) {
  try {
    if (p === null || p === undefined) return null
    let s = String(p)
    if (s === '') return null
    if (/^~[\\/]/.test(s)) {
      s = path.join(os.homedir(), s.slice(2))
    } else if (!path.isAbsolute(s)) {
      // 相対はセッションの cwd でのみ解決する。基準が無ければ所有権に数えない。
      if (!baseCwd) return null
      s = path.resolve(String(baseCwd), s)
    }
    let r = path.resolve(s)
    try {
      // 8.3 短縮名 / junction / 大小を正準化する。未存在ファイル（削除済み等）は throw するので
      // その場合は resolve 形のまま進む（所有権集合には未存在パスも入りうる）。
      r = fs.realpathSync.native(r)
    } catch (e) {
      /* fail-open: 正準化できなくても比較は続行する */
    }
    if (process.platform === 'win32') return r.replace(/\//g, '\\').toLowerCase()
    return r
  } catch (e) {
    return null
  }
}

/**
 * session_id から **main 転写**の実体を引く（`~/.claude/projects/<slug>/<sid>.jsonl`）。
 * 旧 API 互換のため単一パスを返す。subagent まで含めた集合が要るときは resolveTranscriptSet を使う。
 */
function resolveTranscript(transcriptPath, sessionId) {
  if (transcriptPath) {
    try {
      if (fs.statSync(transcriptPath).isFile()) return transcriptPath
    } catch (e) {
      /* 実パスが死んでいれば session_id 経由へ続行 */
    }
  }
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return null
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

/**
 * ディレクトリ配下の .jsonl を再帰収集（件数上限つき）。
 *
 * 収集に失敗したら `st.degraded = true` を立てる。**ただしディレクトリが存在しない (ENOENT) のは
 * 正常系**（subagent を使っていないセッションでは subagents/ が無い）であり劣化ではない。
 * ここを区別せず全部劣化にすると、大多数の通常セッションが unavailable に倒れてゲートが死ぬ。
 */
function collectJsonl(dir, out, limit, st) {
  let ents
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    // 未存在は正常。権限エラー等（存在するのに読めない）だけを劣化として扱う。
    if (!e || e.code !== 'ENOENT') st.degraded = true
    return
  }
  for (const ent of ents) {
    if (out.length >= limit) return
    const p = path.join(dir, ent.name)
    try {
      if (ent.isDirectory()) collectJsonl(p, out, limit, st)
      else if (/\.jsonl$/i.test(ent.name)) out.push(p)
    } catch (e) {
      st.degraded = true
    }
  }
}

/**
 * 転写**群**を解決する（main ＋ subagent）。
 *
 * subagent を含める理由（2026-08-22 実測）: 現行のレイアウトでは subagent / workflow の作業は
 * main 転写に入らず `<slug>/<sid>/subagents/**​/agent-*.jsonl` へ分離される。実測で
 * 「Write tool_use が subagent 転写にしか存在しない提案」が在った。main だけを見ると、
 * subagent へ委譲した瞬間に所有権が消えて**ゲートが静かに沈黙する**。
 *
 * **部分集合で判定しない。** 収集・サイズ取得のどこかが失敗したら degraded を立て、呼び出し側は
 * unavailable（沈黙）へ倒す。理由: 一部の転写を取りこぼしたまま `active` を名乗ると、
 * 「自分が subagent で書いた提案」が owned に入らないまま**自分だけが止まる**（しかも telemetry は
 * 正常に見える）。これは本改修が潰そうとしている「静かに壊れる」クラスそのものである。
 *
 * 戻り値: { files: string[], limitExceeded: boolean, degraded: boolean }
 */
function resolveTranscriptSet(transcriptPath, sessionId) {
  const main = resolveTranscript(transcriptPath, sessionId)
  if (!main) return { files: [], limitExceeded: false, degraded: false }
  const files = [main]
  const st = { degraded: false }
  // main 転写と同名（拡張子なし）のディレクトリに subagent 転写がぶら下がる。
  const subDir = path.join(path.dirname(main), path.basename(main, '.jsonl'), 'subagents')
  collectJsonl(subDir, files, MAX_TRANSCRIPT_FILES + 1, st)
  if (files.length > MAX_TRANSCRIPT_FILES) {
    return { files: [], limitExceeded: true, degraded: false }
  }
  let total = 0
  for (const f of files) {
    try {
      total += fs.statSync(f).size
    } catch (e) {
      // 収集直後に消えた等。サイズ不明のまま総量判定を続けると上限検査が骨抜きになるので劣化扱い。
      st.degraded = true
    }
  }
  if (total > MAX_TOTAL_TRANSCRIPT_BYTES) {
    return { files: [], limitExceeded: true, degraded: false }
  }
  return { files, limitExceeded: false, degraded: st.degraded }
}

/**
 * 転写（1 本または複数）から「このセッションが編集したファイル」を集める。
 *
 * 引数が単一パスで読めない場合は **null**（＝所有権不明。呼び出し側が fail-open へ倒す）。
 * 配列の場合は読めたものだけの和を返す（1 本壊れても全体を捨てない）。
 * `detail` を渡すと parseErrors 等の劣化情報を書き込む。
 */
function ownedFromTranscript(transcriptPathOrList, baseCwd, detail) {
  const list = Array.isArray(transcriptPathOrList) ? transcriptPathOrList : [transcriptPathOrList]
  const single = !Array.isArray(transcriptPathOrList)
  const out = new Set()
  let readAny = false
  let parseErrors = 0
  let readErrors = 0
  for (const tp of list) {
    let text
    try {
      text = fs.readFileSync(tp, 'utf8')
    } catch (e) {
      // 集合モードでは「解決済みの転写が読めない」＝部分集合になる。呼び出し側が
      // unavailable へ倒せるよう記録する（黙って一部だけで判定しない）。
      readErrors++
      continue
    }
    readAny = true
    for (const line of text.split('\n')) {
      // 早期スキップ（巨大転写のコスト対策。file_path を含む行だけ parse する）
      if (line.indexOf('file_path') < 0 && line.indexOf('notebook_path') < 0) continue
      let j
      try {
        j = JSON.parse(line)
      } catch (e) {
        parseErrors++
        continue
      }
      const content = j && j.message && j.message.content
      if (!Array.isArray(content)) continue
      for (const b of content) {
        if (!b || b.type !== 'tool_use' || !EDIT_TOOLS.has(b.name)) continue
        const fp = b.input && (b.input.file_path || b.input.notebook_path)
        const n = fp ? normPath(fp, baseCwd) : null
        if (n) out.add(n)
      }
    }
  }
  if (detail) {
    detail.parseErrors = parseErrors
    detail.readErrors = readErrors
  }
  if (!readAny) return single ? null : new Set()
  return out
}

/**
 * Stop hook の stdin(JSON) から session_id / transcript_path / cwd を取る。
 *
 * bash 側の grep+sed では JSON エスケープを解釈できず Windows パスの "C:\\Users\\..." を
 * 復元できないため、ここで JSON.parse して正しく解く。壊れていれば null（fail-open）。
 * 端末から素で叩かれた場合に readFileSync(0) がブロックするのを防ぐため isTTY を先に見る。
 */
function readStdinJson() {
  try {
    if (process.stdin && process.stdin.isTTY) return null
  } catch (e) {
    /* isTTY を見られない環境でも続行 */
  }
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

/**
 * 所有権を解決して**状態つき**で返す。
 *
 * opts:
 *   owned      : string[]  明示指定（テスト用）。空配列も「対象ゼロ」の正当な指定
 *   transcript : string    転写の実パス
 *   sessionId  : string    session_id（transcript 不在時の解決元）
 *   cwd        : string    hook 入力の cwd（相対 file_path の解決基準）
 *
 * 戻り値: { state, owned:Set, transcriptFiles:number, ownedTotal:number,
 *           parseErrors:number, limitExceeded:boolean }
 */
function resolveOwnership(opts) {
  const o = opts || {}
  const baseCwd = o.cwd || null
  if (Array.isArray(o.owned)) {
    const s = new Set()
    for (const p of o.owned) {
      const n = normPath(p, baseCwd)
      if (n) s.add(n)
    }
    return {
      state: s.size ? STATE_ACTIVE : STATE_EMPTY,
      owned: s,
      transcriptFiles: 0,
      ownedTotal: s.size,
      parseErrors: 0,
      limitExceeded: false
    }
  }
  const set = resolveTranscriptSet(o.transcript, o.sessionId)
  if (set.limitExceeded || set.degraded || set.files.length === 0) {
    return {
      state: STATE_UNAVAILABLE,
      owned: new Set(),
      transcriptFiles: 0,
      ownedTotal: 0,
      parseErrors: 0,
      readErrors: 0,
      limitExceeded: set.limitExceeded,
      degraded: set.degraded
    }
  }
  const detail = { parseErrors: 0, readErrors: 0 }
  const owned = ownedFromTranscript(set.files, baseCwd, detail)
  if (detail.readErrors > 0) {
    // 解決できた転写の一部が読めなかった＝部分集合。**部分集合で判定しない**。
    // ここを active のまま通すと「自分が subagent で書いた提案」を取りこぼしたまま
    // 自分だけが止まり、しかも telemetry は正常に見える（静かに壊れる最悪の形）。
    return {
      state: STATE_UNAVAILABLE,
      owned: new Set(),
      transcriptFiles: set.files.length,
      ownedTotal: 0,
      parseErrors: detail.parseErrors,
      readErrors: detail.readErrors,
      limitExceeded: false,
      degraded: true
    }
  }
  return {
    state: owned.size ? STATE_ACTIVE : STATE_EMPTY,
    owned,
    transcriptFiles: set.files.length,
    ownedTotal: owned.size,
    parseErrors: detail.parseErrors,
    readErrors: 0,
    limitExceeded: false,
    degraded: false
  }
}

module.exports = {
  EDIT_TOOLS,
  MAX_TRANSCRIPT_FILES,
  MAX_TOTAL_TRANSCRIPT_BYTES,
  STATE_ACTIVE,
  STATE_EMPTY,
  STATE_UNAVAILABLE,
  normPath,
  resolveTranscript,
  resolveTranscriptSet,
  ownedFromTranscript,
  readStdinJson,
  resolveOwnership
}
