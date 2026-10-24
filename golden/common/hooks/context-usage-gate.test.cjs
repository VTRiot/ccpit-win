'use strict';
// context-usage-gate.test.cjs — CCPIT 049 検出核＋ラッパの単体/統合テスト
// 実行: node context-usage-gate.test.cjs（副作用は os.tmpdir() 配下の使い捨てディレクトリのみ）
// 検証対象: AC2(セッション1回)/AC3(decision 不出力)/AC4(3系統 fail-open)/AC6(isSidechain 除外)/
//           K1(跨ぎ=上位のみ・全記録)/Codex[1][2][3][4][5]/実装レビュー I2(非 regular file)・I3(output_tokens 非算入)

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const HOOKS = __dirname.replace(/\\/g, '/');
const DETECT = HOOKS + '/context-usage-detect.cjs';
const GATE = HOOKS + '/context-usage-gate.sh';
const BASH = process.env.CUG_TEST_BASH || 'bash';

const ROOT = path.join(os.tmpdir(), 'cug-test-' + process.pid);
const STATE = path.join(ROOT, 'state');
fs.mkdirSync(STATE, { recursive: true });

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

function asstLine(inTok, cc, cr, sidechain) {
  const o = {
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: { usage: { input_tokens: inTok, cache_creation_input_tokens: cc, cache_read_input_tokens: cr, output_tokens: 100 } },
  };
  if (sidechain) o.isSidechain = true;
  return JSON.stringify(o);
}
function userLine() { return JSON.stringify({ type: 'user', message: { content: 'x' } }); }

function writeTranscript(name, lines) {
  const p = path.join(ROOT, name + '.jsonl');
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}
function writeConfig(name, content) {
  const p = path.join(ROOT, name + '.json');
  fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  return p;
}

function runDetect(stdinObj, opts) {
  const env = Object.assign({}, process.env, {
    CUG_CONFIG: (opts && opts.config) || path.join(ROOT, 'no-such-config.json'),
    CUG_STATE_DIR: (opts && opts.stateDir) || STATE,
  });
  const r = spawnSync(process.execPath, [DETECT], {
    input: typeof stdinObj === 'string' ? stdinObj : JSON.stringify(stdinObj),
    env, encoding: 'utf8', timeout: 15000,
  });
  return { out: r.stdout || '', err: r.stderr || '', status: r.status };
}

function readState(sid) {
  try { return JSON.parse(fs.readFileSync(path.join(STATE, 'context-usage-' + sid + '.json'), 'utf8')); }
  catch { return null; }
}

// ---------- 核の単体 ----------
console.log('== detect core ==');

const T_LOW = writeTranscript('low', [userLine(), asstLine(10000, 200000, 290000, false)]);          // 500K
const T_W1 = writeTranscript('w1', [userLine(), asstLine(12000, 300000, 500000, false)]);            // 812K
const T_W2 = writeTranscript('w2', [userLine(), asstLine(12000, 400000, 500000, false)]);            // 912K
const T_SIDE = writeTranscript('side', [
  asstLine(10000, 200000, 290000, false),                                                            // 500K (非 sidechain)
  asstLine(50000, 400000, 500000, true),                                                             // 950K (sidechain・除外対象)
  userLine(),
]);
const T_GARBAGE = writeTranscript('garbage', [
  userLine(), asstLine(12000, 300000, 500000, false), 'not-json-garbage', '{broken json', '',
]);

let r;

r = runDetect({ session_id: 's-low', transcript_path: T_LOW });
ok(r.status === 0 && r.out === '', 't1 閾値未満は無出力', JSON.stringify(r.out));

r = runDetect({ session_id: 's-w1', transcript_path: T_W1 });
{
  let obj = null; try { obj = JSON.parse(r.out); } catch {}
  ok(r.status === 0 && obj && typeof obj.systemMessage === 'string' && Object.keys(obj).length === 1,
    't2 812K で systemMessage 単一キー出力', r.out);
  ok(obj && obj.systemMessage.includes('\u{1F7E3}') && obj.systemMessage.includes('812K') && obj.systemMessage.includes('800K'),
    't2b 文面に 🟣・実測値・閾値', r.out);
  ok(!r.out.includes('decision'), 't2c decision 語彙が出力に無い (AC3)', r.out);
  const st = readState('s-w1');
  ok(st && Array.isArray(st.fired) && st.fired.length === 1 && st.fired[0] === 800000, 't2d 状態に 800000 記録', JSON.stringify(st));
}

r = runDetect({ session_id: 's-w1', transcript_path: T_W1 });
ok(r.status === 0 && r.out === '', 't3 同一セッション再実行は無出力 (AC2)', r.out);

r = runDetect({ session_id: 's-both', transcript_path: T_W2 });
{
  let obj = null; try { obj = JSON.parse(r.out); } catch {}
  ok(obj && obj.systemMessage.includes('\u{1F534}') && obj.systemMessage.includes('912K') && obj.systemMessage.includes('900K'),
    't4 両閾値跨ぎは上位のみ表示 (K1)', r.out);
  ok(obj && !obj.systemMessage.includes('800K'), 't4b 下位閾値の文面は混ざらん', r.out);
  const st = readState('s-both');
  ok(st && st.fired.slice().sort().join(',') === '800000,900000', 't4c 跨いだ全閾値を記録 (K1)', JSON.stringify(st));
}

r = runDetect({ session_id: 's-both', transcript_path: T_W2 });
ok(r.status === 0 && r.out === '', 't5 跨ぎ後の再実行も無出力', r.out);

r = runDetect({ session_id: 's-side', transcript_path: T_SIDE });
ok(r.status === 0 && r.out === '', 't6 sidechain 950K は除外され非 sidechain 500K で判定 (AC6)', r.out);

r = runDetect({ session_id: 's-active', transcript_path: T_W2, stop_hook_active: true });
ok(r.status === 0 && r.out === '', 't7 stop_hook_active は即通過', r.out);

r = runDetect({ session_id: '../evil', transcript_path: T_W2 });
ok(r.status === 0 && r.out === '', 't8 不正 session_id は警告スキップ (Codex[1])', r.out);

r = runDetect({ session_id: 's-nofile', transcript_path: path.join(ROOT, 'no-such.jsonl') });
ok(r.status === 0 && r.out === '', 't9 transcript 不在は fail-open (AC4)', r.out);

r = runDetect({ session_id: 's-dirpath', transcript_path: ROOT });
ok(r.status === 0 && r.out === '', 't9b transcript が非 regular file（ディレクトリ）は fail-open (I2)', r.out);

{
  const cfg = writeConfig('broken', 'not json {{{');
  r = runDetect({ session_id: 's-cfgbroken', transcript_path: T_W1 }, { config: cfg });
  ok(r.status === 0 && r.out.includes('800K'), 't10 設定破損は既定へフォールバック (AC4/Codex[5])', r.out);
}
{
  const cfg = writeConfig('inverted', { contextUsage: { warn1: 900000, warn2: 800000 } });
  r = runDetect({ session_id: 's-cfginv', transcript_path: T_W1 }, { config: cfg });
  ok(r.status === 0 && r.out.includes('800K'), 't11 warn1>=warn2 は既定へフォールバック (Codex[5])', r.out);
}

r = runDetect({ session_id: 's-garbage', transcript_path: T_GARBAGE });
ok(r.status === 0 && r.out.includes('812K'), 't12 破損行スキップで最終有効行を採用 (AC4)', r.out);

{
  const cfg = writeConfig('custom', { contextUsage: { warn1: 100000, warn2: 200000 } });
  const t = writeTranscript('c150', [asstLine(10000, 60000, 80000, false)]); // 150K
  r = runDetect({ session_id: 's-custom', transcript_path: t }, { config: cfg });
  ok(r.out.includes('150K') && r.out.includes('100K') && r.out.includes('\u{1F7E3}'),
    't13 設定閾値の反映 (W-4 連動)', r.out);
}

{
  const t = writeTranscript('exact', [asstLine(0, 300000, 500000, false)]); // ちょうど 800000
  r = runDetect({ session_id: 's-exact', transcript_path: t });
  ok(r.status === 0 && r.out === '', 't14 閾値ちょうどは「超」でない（strict >）', r.out);
}

r = runDetect('not-json-at-all');
ok(r.status === 0 && r.out === '', 't15 stdin 非 JSON は fail-open', r.out);

{
  const big = JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(),
    message: { usage: { input_tokens: 10000, cache_creation_input_tokens: 200000, cache_read_input_tokens: 290000, output_tokens: 999999 } } });
  const t = writeTranscript('outtok', [userLine(), big]); // input 側 500K・output 側約 1M
  r = runDetect({ session_id: 's-outtok', transcript_path: t });
  ok(r.status === 0 && r.out === '', 't16 output_tokens は非算入（500K + output 999999 でも無警告）(I3)', r.out);
}

// ---------- ラッパの形状 allowlist（スタブ detect 差し替え） ----------
console.log('== wrapper allowlist ==');

const WDIR = path.join(ROOT, 'wrap');
fs.mkdirSync(WDIR, { recursive: true });
const gateCopy = path.join(WDIR, 'context-usage-gate.sh');
fs.copyFileSync(GATE, gateCopy);
const stub = path.join(WDIR, 'context-usage-detect.cjs');
const gatePosix = gateCopy.replace(/\\/g, '/');

function runGate(stdinText, env) {
  const r = spawnSync(BASH, [gatePosix], {
    input: stdinText, encoding: 'utf8', timeout: 20000,
    env: Object.assign({}, process.env, env || {}),
  });
  return { out: r.stdout || '', status: r.status };
}

fs.writeFileSync(stub, 'process.stdout.write("oops not json")');
r = runGate('{}');
ok(r.status === 0 && r.out === '', 'w1 非 JSON debris は破棄 (Codex[2])', r.out);

fs.writeFileSync(stub, 'process.stdout.write(JSON.stringify({systemMessage:"ok"})+"\\nextra")');
r = runGate('{}');
ok(r.status === 0 && r.out === '', 'w2 複数行は破棄', r.out);

fs.writeFileSync(stub, 'process.stdout.write(JSON.stringify({decision:"block",systemMessage:"x"}))');
r = runGate('{}');
ok(r.status === 0 && r.out === '', 'w3 decision 含み JSON は破棄 (AC3)', r.out);

fs.writeFileSync(stub, 'process.stdout.write(JSON.stringify({systemMessage:"ok \\"quoted\\" \\\\ done"}))');
r = runGate('{}');
ok(r.status === 0 && r.out.trim() === '{"systemMessage":"ok \\"quoted\\" \\\\ done"}', 'w4 正当な単一行はエスケープ込みで通過', r.out);

fs.writeFileSync(stub, 'console.error("boom"); process.stdout.write("partial{"); process.exit(1)');
r = runGate('{}');
ok(r.status === 0 && r.out === '', 'w5 本体異常終了でも exit 0・無出力 (AC4)', r.out);

// ---------- 実 2 層統合（本物の detect + 本物の gate） ----------
console.log('== integration ==');
{
  const stdinJson = JSON.stringify({ session_id: 's-integ', transcript_path: T_W1.replace(/\\/g, '/') });
  const r2 = spawnSync(BASH, [GATE.replace(/\\/g, '/')], {
    input: stdinJson, encoding: 'utf8', timeout: 20000,
    env: Object.assign({}, process.env, { CUG_STATE_DIR: STATE, CUG_CONFIG: path.join(ROOT, 'no-such-config.json') }),
  });
  const out = (r2.stdout || '').trim();
  let obj = null; try { obj = JSON.parse(out); } catch {}
  ok(r2.status === 0 && obj && obj.systemMessage.includes('812K') && obj.systemMessage.includes('\u{1F7E3}'),
    'i1 実 2 層で 812K 警告が形状ゲートを通過（絵文字・全角ダッシュ込み）', out);
  const r3 = spawnSync(BASH, [GATE.replace(/\\/g, '/')], {
    input: stdinJson, encoding: 'utf8', timeout: 20000,
    env: Object.assign({}, process.env, { CUG_STATE_DIR: STATE, CUG_CONFIG: path.join(ROOT, 'no-such-config.json') }),
  });
  ok(r3.status === 0 && (r3.stdout || '') === '', 'i2 実 2 層の再実行は無出力 (AC2)', r3.stdout);
}

// ---------- 後始末と結果 ----------
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
console.log('---');
console.log('pass=' + pass + ' fail=' + fail);
process.exit(fail === 0 ? 0 : 1);
