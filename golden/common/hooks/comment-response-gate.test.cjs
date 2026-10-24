#!/usr/bin/env node
// comment-response-gate.test.cjs — 検出核の単体テスト（isolated fixture・env 非依存）
// 検証の非分岐: 本テストは検出核 comment-response-detect.cjs を require で再利用する。
// 実行: node ~/.claude/hooks/comment-response-gate.test.cjs

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { check, extractCommentsResolved } = require('./comment-response-detect.cjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crg-test-'));
const mk = (name, content) => {
  const p = path.join(tmp, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  return p;
};
const fm = (body) => `---\nreport_id: t_${Math.random().toString(36).slice(2, 8)}\n${body}---\n\n# t\n`;
const GOOD3 = '  - 見出しA || 元コメント全文 || 08-05 追補節Bで対応\n';
let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log(`ok - ${name}`); };

// A. 3部形式 + 新しい HTML → 違反なし
t('A: well-formed + fresh html -> clean', () => {
  const md = mk('a/r.md', fm('comments_resolved:\n' + GOOD3));
  const html = md.replace(/\.md$/, '.html');
  fs.writeFileSync(html, '<html></html>');
  fs.utimesSync(html, new Date(), new Date(Date.now() + 5000));
  const f = check({ roots: [path.join(tmp, 'a')], sinceMs: 0 });
  assert.strictEqual(f.length, 0, JSON.stringify(f));
});

// B. 2部形式（元コメント省略）→ block
t('B: 2-part entry -> violation', () => {
  const md = mk('b/r.md', fm('comments_resolved:\n  - 見出しB || 対応したで\n'));
  const html = md.replace(/\.md$/, '.html');
  fs.writeFileSync(html, 'x');
  fs.utimesSync(html, new Date(), new Date(Date.now() + 5000));
  const f = check({ roots: [path.join(tmp, 'b')], sinceMs: 0 });
  assert.strictEqual(f.length, 1);
  assert.ok(f[0].violations.some((v) => v.includes('3部形式')));
});

// C. MD が HTML より新しい → block
t('C: stale html -> violation', () => {
  const md = mk('c/r.md', fm(''));
  const html = md.replace(/\.md$/, '.html');
  fs.writeFileSync(html, 'x');
  const old = new Date(Date.now() - 86400000);
  fs.utimesSync(html, old, old);
  const f = check({ roots: [path.join(tmp, 'c')], sinceMs: 0 });
  assert.strictEqual(f.length, 1);
  assert.ok(f[0].violations.some((v) => v.includes('古い')));
});

// D. HTML 未生成 → block
t('D: missing html -> violation', () => {
  mk('d/r.md', fm(''));
  const f = check({ roots: [path.join(tmp, 'd')], sinceMs: 0 });
  assert.strictEqual(f.length, 1);
  assert.ok(f[0].violations.some((v) => v.includes('HTML未生成')));
});

// E. frontmatter 破損（閉じ --- 無し）→ fail-open（非 block）
t('E: broken frontmatter -> fail-open', () => {
  mk('e/r.md', '---\nreport_id: x\n未閉鎖');
  const f = check({ roots: [path.join(tmp, 'e')], sinceMs: 0 });
  assert.strictEqual(f.length, 0);
});

// F. report_id 無し MD → 対象外
t('F: non-report md ignored', () => {
  mk('f/n.md', '---\ntitle: メモ\n---\nhtml無しでも対象外\n');
  const f = check({ roots: [path.join(tmp, 'f')], sinceMs: 0 });
  assert.strictEqual(f.length, 0);
});

// G. since 窓の境界: 窓より古い mtime は対象外
t('G: outside since-window ignored', () => {
  const md = mk('g/r.md', fm(''));
  const old = new Date(Date.now() - 86400000);
  fs.utimesSync(md, old, old);
  const f = check({ roots: [path.join(tmp, 'g')], sinceMs: Date.now() - 3600000 });
  assert.strictEqual(f.length, 0);
});

// H. 全角退避で || が原文に無い 4 部超（|| が元コメント内に実出現）→ 3部以上・全非空なら pass
t('H: >=3 parts all non-empty -> clean', () => {
  const md = mk('h/r.md', fm('comments_resolved:\n  - 見出し || 元コメ前半 || 元コメ後半 || 対応メモ\n'));
  const html = md.replace(/\.md$/, '.html');
  fs.writeFileSync(html, 'x');
  fs.utimesSync(html, new Date(), new Date(Date.now() + 5000));
  const f = check({ roots: [path.join(tmp, 'h')], sinceMs: 0 });
  assert.strictEqual(f.length, 0);
});

// I. 折返し継続行の連結（実報告書は 1 行 1 エントリだが、YAML 折返しにも耐える）
t('I: wrapped continuation lines', () => {
  const e = extractCommentsResolved('comments_resolved:\n  - 見出し || 元コメント\n    続き || 対応メモ\n');
  assert.strictEqual(e.length, 1);
  assert.ok(e[0].includes('続き'));
  assert.strictEqual(e[0].split('||').length, 3);
});

// J. 空部（"a ||  || c"）→ violation
t('J: empty middle part -> violation', () => {
  const md = mk('j/r.md', fm('comments_resolved:\n  - 見出し ||  || 対応メモ\n'));
  const html = md.replace(/\.md$/, '.html');
  fs.writeFileSync(html, 'x');
  fs.utimesSync(html, new Date(), new Date(Date.now() + 5000));
  const f = check({ roots: [path.join(tmp, 'j')], sinceMs: 0 });
  assert.strictEqual(f.length, 1);
});

// K. 実在しないルート → fail-open
t('K: missing root -> fail-open', () => {
  const f = check({ roots: [path.join(tmp, 'no-such-dir')], sinceMs: 0 });
  assert.strictEqual(f.length, 0);
});

// ---- 所有権フィルタ（v0.2.1・2026-08-07 追いかけっこバグ修正）------------------
// 旧実装は DEFAULT_ROOTS を当日 mtime で全走査したため、他レーンの CC が編集中の MD で
// 自セッションが永久に block された。以下は「自分のは捕まる／他人のは捕まらない」の両側を固定する。

// L. UX 維持: 自セッションが編集した違反 MD は検出される
t('L: owned な違反MDは検出される（UX維持）', () => {
  const md = mk('l/mine.md', fm(''));            // HTML 無し＝違反
  const f = check({ owned: [md], sinceMs: 0 });
  assert.strictEqual(f.length, 1, JSON.stringify(f));
  assert.ok(f[0].violations.some((v) => v.includes('HTML未生成')));
});

// M. 追いかけっこ防止: owned に無い MD は違反でも検出されない
t('M: owned でない違反MDは検出されない（追いかけっこ防止）', () => {
  const mine = mk('m/mine.md', fm(''));
  mk('m/theirs.md', fm(''));                     // 他レーンが編集中の想定（同ディレクトリ）
  const f = check({ owned: [mine], sinceMs: 0 });
  assert.strictEqual(f.length, 1);
  assert.ok(!f.some((x) => /theirs\.md$/i.test(x.file)));
});

// N. 握り潰しでない対照: 両方 owned なら両方出る
t('N: owned に含めれば両方検出（握り潰しでない）', () => {
  const a = mk('n/a.md', fm(''));
  const b = mk('n/b.md', fm(''));
  const f = check({ owned: [a, b], sinceMs: 0 });
  assert.strictEqual(f.length, 2);
});

// O. 所有権が解決できない → fail-open（沈黙）
t('O: transcript 解決不能なら沈黙（fail-open）', () => {
  const f = check({ ownershipMode: true, sessionId: 'ffffffff-ffff-ffff-ffff-ffffffffffff', sinceMs: 0 });
  assert.strictEqual(f.length, 0);
});

// P. owned 空でも従来モード（roots 全走査）へ落ちない＝追いかけっこへ退行しない
t('P: owned 空でも roots 全走査へ退行しない', () => {
  const f = check({ owned: [], sinceMs: 0 });
  assert.strictEqual(f.length, 0);
});

// Q. 所有権モードでも鮮度検査は生きている
t('Q: owned かつ HTML が新しければ clean（鮮度検査は維持）', () => {
  const md = mk('q/r.md', fm(''));
  const html = md.replace(/\.md$/, '.html');
  fs.writeFileSync(html, '<html></html>');
  fs.utimesSync(html, new Date(), new Date(Date.now() + 5000));
  const f = check({ owned: [md], sinceMs: 0 });
  assert.strictEqual(f.length, 0, JSON.stringify(f));
});

// ---- transcript 経路（Codex S2-5 指摘で追加。所有権解決の中核が未検証だった）----------
const { ownedFromTranscript, resolveTranscript, normPath } = require('./comment-response-detect.cjs');

// JSONL 1 行を組む（本番 transcript と同じ形＝message.content[].tool_use）
const jl = (name, fp) => JSON.stringify({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', name, input: fp ? { file_path: fp } : {} }] },
});

// R. 4 種の編集ツールから file_path を抽出できる
t('R: Write/Edit/MultiEdit/NotebookEdit から抽出', () => {
  const tp = mk('r/t.jsonl', [
    jl('Write', path.join(tmp, 'r', 'a.md')),
    jl('Edit', path.join(tmp, 'r', 'b.md')),
    jl('MultiEdit', path.join(tmp, 'r', 'c.md')),
    JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'NotebookEdit', input: { notebook_path: path.join(tmp, 'r', 'd.ipynb') } }] } }),
  ].join('\n'));
  const owned = ownedFromTranscript(tp);
  assert.strictEqual(owned.size, 4, [...owned].join(','));
  assert.ok(owned.has(normPath(path.join(tmp, 'r', 'a.md'))));
  assert.ok(owned.has(normPath(path.join(tmp, 'r', 'd.ipynb'))));
});

// S. 壊れた行はスキップし、健全な行は拾う（全体を捨てない）
t('S: 壊れた JSONL 行をスキップして継続', () => {
  const tp = mk('s/t.jsonl', ['{"file_path": broken json', jl('Write', path.join(tmp, 's', 'ok.md')), ''].join('\n'));
  const owned = ownedFromTranscript(tp);
  assert.strictEqual(owned.size, 1);
});

// T. 編集ツール以外（Bash/Read 等）は所有権に含めない＝偽陽性で他人を拾わない
t('T: 非編集ツールは owned に含めない', () => {
  const tp = mk('t/t.jsonl', [
    JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo x > other.md', file_path: path.join(tmp, 't', 'other.md') } }] } }),
    JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: path.join(tmp, 't', 'read.md') } }] } }),
  ].join('\n'));
  const owned = ownedFromTranscript(tp);
  assert.strictEqual(owned.size, 0);
});

// U. transcript 不在 → null（呼び出し側が fail-open へ倒す）
t('U: transcript 不在は null', () => {
  assert.strictEqual(ownedFromTranscript(path.join(tmp, 'no-such.jsonl')), null);
});

// V. transcript 経路の end-to-end: 自分が編集した MD だけが検査される
t('V: transcript 経由で owned だけ検査（end-to-end）', () => {
  const mine = mk('v/mine.md', fm(''));            // HTML 無し＝違反
  mk('v/theirs.md', fm(''));                       // 他レーン想定＝transcript に出さない
  const tp = mk('v/t.jsonl', jl('Write', mine));
  const f = check({ ownershipMode: true, transcript: tp, sinceMs: 0 });
  assert.strictEqual(f.length, 1, JSON.stringify(f));
  assert.ok(/mine\.md$/i.test(f[0].file));
});

// W. resolveTranscript: 実パス優先、不正 session_id は null
t('W: resolveTranscript は実パス優先・不正 sid は null', () => {
  const tp = mk('w/t.jsonl', jl('Write', path.join(tmp, 'w', 'x.md')));
  assert.strictEqual(resolveTranscript(tp, null), tp);
  assert.strictEqual(resolveTranscript(null, 'not-a-uuid!!'), null);
});

// ---- v0.2.2: 共有正本 hook-ownership.cjs へ委譲して塞いだ 2 つの穴の回帰テスト ----------
// いずれも「静かに取りこぼす」種類の欠陥だった。取りこぼしは沈黙するので、テストが無いと
// 気付けない（block が減っても誰も異常と思わない）。両方とも実データで実在を確認済み。

// X. subagent 転写にしか Write が無くても捕まる
//    旧実装は main 転写 1 本しか読まなかった。subagent/workflow へ委譲した瞬間に所有権が消え、
//    その報告書は永久に検査されなかった（実測: Write tool_use が subagent 転写にしか無い実例あり）。
t('X: subagent 転写だけの Write も owned になる（旧実装は取りこぼしていた）', () => {
  const md = mk('x/mine.md', fm(''));                 // HTML 無し＝違反
  const main = mk('x/sess.jsonl', '');                // main は空
  const sub = path.join(tmp, 'x', 'sess', 'subagents', 'workflows', 'wf_1');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'agent-a.jsonl'), jl('Write', md));
  const f = check({ ownershipMode: true, transcript: main, sinceMs: 0 });
  assert.strictEqual(f.length, 1, JSON.stringify(f));
  assert.ok(/mine\.md$/i.test(f[0].file));
});

// Y. `~/...` 形式の file_path が homedir へ展開される
//    旧実装は path.resolve のみだったため hook プロセスの cwd へ束縛され、絶対に一致しなかった
//    （実測: "~/.ccpit/proposals/....md" 形式の実 Write が存在する）。
t('Y: ~ 始まりの file_path は homedir へ展開される（cwd へ束縛しない）', () => {
  assert.strictEqual(normPath('~/x.md'), normPath(path.join(os.homedir(), 'x.md')));
});

// Z. 相対パスは「基準 cwd がある場合のみ」解決する
//    hook プロセスの cwd は任意なので、そこへ暗黙に束縛するのは非決定的で危険。
//    本番では hook 入力の cwd（セッションの作業ディレクトリ）を基準にする。
t('Z: 相対 file_path は基準 cwd があるときだけ解決（無ければ owned に入れない）', () => {
  const md = mk('z/rel.md', fm(''));
  assert.strictEqual(normPath('rel.md'), null);
  assert.strictEqual(normPath('rel.md', path.join(tmp, 'z')), normPath(md));
});

// AA. 所有権モードでも「解決できて 0 件」と「解決不能」で沈黙する点は同じ（fail-open の向き維持）
t('AA: 転写が空でも解決不能でも沈黙する（block へ倒さない）', () => {
  mk('aa/theirs.md', fm(''));
  const empty = mk('aa/empty.jsonl', '');
  assert.strictEqual(check({ ownershipMode: true, transcript: empty, sinceMs: 0 }).length, 0);
  assert.strictEqual(
    check({ ownershipMode: true, sessionId: 'ffffffff-ffff-ffff-ffff-ffffffffffff', sinceMs: 0 }).length,
    0
  );
  // positive control: 同じ違反 MD を owned にすれば捕まる（握り潰しでない）
  assert.strictEqual(check({ owned: [path.join(tmp, 'aa', 'theirs.md')], sinceMs: 0 }).length, 1);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass}/27 PASS`);
