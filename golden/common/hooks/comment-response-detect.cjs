#!/usr/bin/env node
// comment-response-detect.cjs — report-html-required v0.2.0 検出核（純粋判定）
//
// 責務分離（testable-stop-hook-gate-authoring 定型）:
//   本ファイル = 「何を言うべきか」。違反があれば完成 block-JSON を stdout に出す。
//   なければ何も出さない。「今 block すべきか」(off/soft/strict・stop_hook_active・
//   sentinel) は comment-response-gate.sh（bash 足場）の責務。
//
// 判定対象: report_id を frontmatter に持つ報告書 MD のうち、
//   **自セッションが Write/Edit した**もの（所有権フィルタ・v0.2.1 で追加）かつ
//   今セッション帯（既定=今日 0:00 以降に mtime 更新）に触られたもの。
//
// 所有権フィルタ（2026-08-07・追いかけっこバグ修正）:
//   旧実装は DEFAULT_ROOTS を当日 mtime で全走査したため、**他レーンの CC が編集中の
//   MD で自セッションが block される**（相手が編集を続ける限り永久に止まる）事故が発生した。
//   ルール正本 report-html-required は「報告書 MD を*生成・編集したら*」＝自分が触った
//   ものを対象とする規定であり、全走査は文言と実装の乖離だった。
//   そこで transcript（自セッションの JSONL）から Write/Edit 系ツールの file_path を
//   集め、その集合に限って検査する。他人のファイルは構造的に対象外になる。
//   (1) 同名 HTML が存在し MD より新しいこと（鮮度の近似検査。厳密な内容ハッシュ
//       検証は md-render --check / audit.cjs の責務であり、本 hook は最後の背もたれ）
//   (2) comments_resolved: がある場合、各エントリが 3 部形式
//       「見出し || 元コメント || 対応メモ」で、3 部とも非空であること
//
// env 注入（テスタビリティ）:
//   CRG_ROOTS          走査ルート（; 区切り）※所有権フィルタ未指定時のみ有効
//   CRG_SINCE_EPOCH_MS この epoch ms 以降に触られた MD のみ対象
//   CRG_MAX_DEPTH      走査深さ（既定 4）
//   CRG_OWNED_FILES    自セッションが編集したファイル（; 区切り）。**定義されていれば**
//                      （空文字でも）所有権フィルタが有効になり roots 走査は行わない
//   CRG_TRANSCRIPT     transcript JSONL の実パス（所有権の解決元）
//   CRG_SESSION_ID     session_id。CRG_TRANSCRIPT 不在時に
//                      ~/.claude/projects/<slug>/<sid>.jsonl から解決する
//
// fail-open: 読めない・パースできないものは「違反なし」側に倒す（cry-wolf 回避）。
//   所有権が解決できない場合も同様に沈黙する（他人のファイルで止めるより無害）。

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

// v0.2.1 で**空にした**。旧実装はここに他プロジェクトの `_Prompt` を列挙しており、
// それが「自分が触っていないファイルで block される」追いかけっこの発生源だった。
// 本番は所有権モード（gate.sh が session_id/transcript_path を渡す）で走るためここへ到達せず、
// テストは roots を明示指定する。空にしておけば、env なしの直接実行が誤って
// 他レーンを走査する経路が**構造的に消える**（安全側＝何も検査しない）。
const DEFAULT_ROOTS = [];

function startOfTodayMs(nowMs) {
  const d = new Date(typeof nowMs === 'number' ? nowMs : Date.now());
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function listMdFiles(root, maxDepth) {
  const out = [];
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of names) {
      const p = path.join(dir, ent.name);
      try {
        if (ent.isDirectory()) walk(p, depth + 1);
        else if (/\.md$/i.test(ent.name) && !/\.bak/i.test(ent.name)) out.push(p);
      } catch (e) { /* fail-open */ }
    }
  }
  walk(root, 0);
  return out;
}

// ---- 所有権フィルタ（v0.2.1 → v0.2.2 で共有正本へ委譲）--------------------
// 2026-08-22: 所有権判定は「このセッションはこのファイルを触ったか」という**単一の事実**への
// 問いであり、事実が 1 つなら実装も 1 つであるべき。hook ごとに写経すると「同じ転写・同じ Write・
// 同じファイルなのに hook A では捕まり B では捕まらん」という説明不能な非対称が残る。
// よって hook-ownership.cjs へ集約した。本ファイルは委譲するだけで、判定本体
// （checkFile / extractCommentsResolved / check）は無改変。
//
// この委譲で v0.2.1 の実測済みの穴 2 件が同時に塞がる:
//   (1) subagent 転写（<sid>/subagents/**）を読まず、subagent が書いたファイルを取りこぼしていた
//   (2) file_path が "~/..." や相対（"CORE\x.md" 等・実在）だと path.resolve が hook プロセスの
//       cwd へ束縛され、絶対に一致しなかった
const ownership = require('./hook-ownership.cjs');
const normPath = ownership.normPath;

// 以下 3 つは共有正本 hook-ownership.cjs へ委譲する（同名で再エクスポートし呼び出し側は無改変）。
// EDIT_TOOLS の限定（Bash 経由の生成を捕捉しない）方針は共有正本側へ引き継いでいる。理由も同じ:
//   偽陰性（自分の報告書を見逃す）＝軽微。偽陽性（他人のファイルを拾う）＝**追いかけっこの再発**＝重大。
const EDIT_TOOLS = ownership.EDIT_TOOLS;
// transcript JSONL から「自セッションが編集したファイル」を集める。
// 単一パスが読めない場合は null（＝所有権不明）を返し、呼び出し側で fail-open させる。
const ownedFromTranscript = ownership.ownedFromTranscript;
// Stop hook の stdin(JSON) から session_id / transcript_path / cwd を取る。
const readStdinJson = ownership.readStdinJson;
// session_id から transcript の実体を引く（~/.claude/projects/<slug>/<sid>.jsonl）。
const resolveTranscript = ownership.resolveTranscript;

function parseFrontmatter(text) {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return null;
  return text.slice(3, end);
}

// comments_resolved: ブロックを抽出。折返し継続行は前エントリへ連結。
// 戻り値: ブロック無し → null / 有り → エントリ文字列の配列
function extractCommentsResolved(fmText) {
  const lines = fmText.split(/\r?\n/);
  let seen = false, inBlock = false, current = null;
  const entries = [];
  for (const line of lines) {
    if (/^comments_resolved:\s*$/.test(line)) { seen = true; inBlock = true; continue; }
    if (inBlock) {
      if (/^\S/.test(line)) { inBlock = false; continue; } // 次のトップレベルキー
      const m = line.match(/^\s+-\s+(.*)$/);
      if (m) { if (current !== null) entries.push(current); current = m[1]; }
      else if (current !== null && line.trim() !== '') current += ' ' + line.trim();
    }
  }
  if (current !== null) entries.push(current);
  return seen ? entries : null;
}

function checkFile(mdPath, sinceMs) {
  let stat;
  try { stat = fs.statSync(mdPath); } catch (e) { return []; }
  if (stat.mtimeMs < sinceMs) return [];
  let text;
  try { text = fs.readFileSync(mdPath, 'utf8'); } catch (e) { return []; }
  const fm = parseFrontmatter(text);
  if (!fm) return [];                        // frontmatter 無し/壊れ → fail-open
  if (!/^report_id:/m.test(fm)) return [];   // 報告書シグナル無し
  const v = [];
  const htmlPath = mdPath.replace(/\.md$/i, '.html');
  let hstat = null;
  try { hstat = fs.statSync(htmlPath); } catch (e) { /* 無し */ }
  if (!hstat) v.push('HTML未生成');
  else if (hstat.mtimeMs < stat.mtimeMs) v.push('HTMLがMDより古い(再生成要)');
  const entries = extractCommentsResolved(fm);
  if (entries) {
    for (const e of entries) {
      const parts = e.split('||').map((s) => s.trim());
      if (parts.length < 3 || parts.slice(0, 3).some((p) => !p)) {
        v.push('comments_resolved 3部形式違反(見出し || 元コメント || 対応メモ)');
        break;
      }
    }
  }
  return v;
}

// 所有権集合を決める。戻り値:
//   Set   → 所有権フィルタ有効（この集合だけを検査）
//   null  → フィルタ無効（従来どおり roots 走査。テスト・明示 roots 指定時）
function resolveOwned(o) {
  // 解決は共有正本へ委譲する（main + subagent 転写の和・~ 展開・相対の cwd 解決を含む）。
  // 解決不能／上限超過は state=unavailable で owned は空 Set ＝ fail-open（沈黙）。
  if (Array.isArray(o.owned)) {
    // 空配列 = 「対象ゼロ」も正当な指定
    return ownership.resolveOwnership({ owned: o.owned, cwd: o.cwd || null }).owned;
  }
  if (o.ownershipMode || o.transcript || o.sessionId) {
    return ownership.resolveOwnership({
      transcript: o.transcript,
      sessionId: o.sessionId,
      cwd: o.cwd || null
    }).owned;
  }
  return null;
}

function check(opts) {
  const o = opts || {};
  const sinceMs = typeof o.sinceMs === 'number' ? o.sinceMs : startOfTodayMs();
  const maxDepth = typeof o.maxDepth === 'number' ? o.maxDepth : 4;
  const findings = [];
  // 呼び出し側が解決済みなら再解決しない。dry-run 表示と本判定が**同じ集合**を見ることを
  // 構造で保証するため（二重解決すると、間に転写が伸びた場合に表示と判定が乖離する）。
  const owned = o.resolvedOwned !== undefined ? o.resolvedOwned : resolveOwned(o);

  if (owned) {
    // 所有権モード（本番既定）: 自セッションが編集した MD だけを見る。
    // 他レーンが編集中のファイルは集合に入らないため、追いかけっこが構造的に起きない。
    for (const p of owned) {
      if (!/\.md$/i.test(p) || /\.bak/i.test(p)) continue;
      const violations = checkFile(p, sinceMs);
      if (violations.length) findings.push({ file: p, violations });
    }
    return findings;
  }

  // 従来モード（roots 走査）: テストおよび明示 roots 指定時のみ。
  const roots = o.roots && o.roots.length ? o.roots : DEFAULT_ROOTS;
  for (const root of roots) {
    for (const md of listMdFiles(root, maxDepth)) {
      const violations = checkFile(md, sinceMs);
      if (violations.length) findings.push({ file: md, violations });
    }
  }
  return findings;
}

function envOpts() {
  const o = {};
  if (process.env.CRG_ROOTS) o.roots = process.env.CRG_ROOTS.split(';').filter(Boolean);
  if (process.env.CRG_SINCE_EPOCH_MS) o.sinceMs = Number(process.env.CRG_SINCE_EPOCH_MS);
  if (process.env.CRG_MAX_DEPTH) o.maxDepth = Number(process.env.CRG_MAX_DEPTH);
  // 定義されていれば（空文字でも）所有権フィルタ有効。空 = 対象ゼロ = fail-open。
  if (process.env.CRG_OWNED_FILES !== undefined) {
    o.owned = process.env.CRG_OWNED_FILES.split(';').filter(Boolean);
  }
  // 「定義されていること」自体が所有権モードのスイッチ。値が空（session_id を拾えなかった）
  // でもフィルタは有効のままにし、従来モード（全走査＝追いかけっこ）へは絶対に落とさない。
  // 相対 file_path の解決基準。本番は hook 入力の cwd を使う（下の stdin 経路で上書きされる）。
  if (process.env.CRG_CWD !== undefined) o.cwd = process.env.CRG_CWD || null;
  if (process.env.CRG_TRANSCRIPT !== undefined || process.env.CRG_SESSION_ID !== undefined) {
    o.ownershipMode = true;
    o.transcript = process.env.CRG_TRANSCRIPT || null;
    o.sessionId = process.env.CRG_SESSION_ID || null;
  }
  // 本番経路: bash 足場が stdin(hook 入力 JSON) をそのまま渡す。env 明示（テスト）が優先。
  if (process.env.CRG_STDIN_JSON !== undefined && !o.ownershipMode) {
    o.ownershipMode = true;                       // 読めなくても所有権モードは維持（全走査へ落とさない）
    const s = readStdinJson();
    o.transcript = (s && s.transcript) || null;
    o.sessionId = (s && s.sessionId) || null;
    if (o.cwd === undefined) o.cwd = (s && s.cwd) || null;
    if (!o.transcript && !o.sessionId) {
      // 設定異常と通常の fail-open を区別する（Codex S3-6）。block はしない
      // ——ここで止めると「hook 入力が壊れている限り永久に停止できない」新たな詰みを生むため。
      try { process.stderr.write('[crg] hook 入力から session_id/transcript_path を取得できず（検査を沈黙でスキップ）\n'); } catch (e) {}
    }
  }
  return o;
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const opts = envOpts();
  // **所有権は 1 回だけ解決する。** 以前は check() 内と dry-run 表示用で二重に解決しており、
  // 間に転写が伸びると「表示した件数」と「判定に使った件数」が食い違いえた
  // （観測が本番を観測していない状態）。解決結果を渡して構造的に同一化する。
  opts.resolvedOwned = resolveOwned(opts);
  const findings = check(opts);
  if (dryRun) {
    // 所有権モードが効いているか（＝gate が静かに無効化されていないか）を観測可能にする
    const owned = opts.resolvedOwned;
    console.log(owned
      ? `[所有権モード] 自セッション編集ファイル: ${owned.size} 件（うち .md を検査）`
      : '[従来モード] roots 走査（所有権フィルタ未指定）');
    for (const f of findings) console.log(`${f.file}\n  - ${f.violations.join('\n  - ')}`);
    console.log(findings.length ? `NG: ${findings.length} 件` : 'OK: 違反なし');
    return;
  }
  if (!findings.length) return; // 沈黙 = 非 block
  const list = findings
    .map((f) => `${f.file.replace(/\\/g, '/')} [${f.violations.join(' / ')}]`)
    .join(' | ');
  const reason =
    `report-html-required v0.2.0 違反: ${list}。対処してから停止せよ: ` +
    `(1) node ~/.claude/skills/md-render/md2html.cjs <MD> <同名.html> で再生成し ` +
    `node ~/.claude/skills/md-render/md2html.cjs --verify <MD> を PASS させる。 ` +
    `(2) レビュアーコメントへ対応した場合は frontmatter comments_resolved: に ` +
    `「- 見出し || 元コメント(一字一句) || 対応メモ(どの節・どの変更で応えたか)」の 3 部形式で記録する。` +
    `元コメントの要約・言い換え・省略は禁止。`;
  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
}

module.exports = {
  check, checkFile, extractCommentsResolved, startOfTodayMs, DEFAULT_ROOTS,
  normPath, ownedFromTranscript, resolveTranscript, resolveOwned,
};
if (require.main === module) main();
