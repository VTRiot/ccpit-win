#!/usr/bin/env node
'use strict';
// context-usage-detect.cjs — コンテキスト使用量 advisory 検出核（CCPIT 049 W-1/W-2/W-3/W-5）
//
// 出力契約（context-usage-gate.sh の形状 allowlist と対になっとる）:
//   警告時のみ stdout に単一行 {"systemMessage":"…"} を出す。それ以外は常に無出力・exit 0。
//   decision キーはこのファイルのどこにも現れない（advisory 専用・停止を構造的にブロックしない）。
//   いかなる内部失敗も fail-open（読めない/書けない/壊れとる → 黙って通す）。
//
// 設計裁定の焼き込み（§5④ CODEX_REVIEW_PLAN_20260902.md / PLAN_REVIEW K1〜K6）:
//   [1] session_id は allowlist 検証 ^[A-Za-z0-9_-]{1,64}$。不合格は警告スキップ（ハッシュ化はせん）。
//   [3] 状態ファイルは tmp 書き→rename の原子的更新（lockfile は棄却済み）。
//   [4] 状態の永続化に成功した場合のみ警告を出す（書けない環境で毎ターン再警告になるのを構造的に防ぐ）。
//   [5] 設定は防御的読取: 破損・型不一致・warn1>=warn2 は既定 800000/900000 へ all-or-nothing フォールバック。
//   K1  1 ターンで複数閾値を跨いだら上位のみ表示・跨いだ全閾値を発火済み記録（後から下位が鳴る珍事を防ぐ）。
//   K5  Compact 後の再超過はセッション 1 回制ゆえ再警告せん（仕様・報告書に運用注意として記載）。
//   K6  分母（窓サイズ）は表示せず、超えた閾値を文面に含める（例: 812K — 800K 閾値超）。
// 実装レビュー裁定の焼き込み（§5⑥ CODEX_REVIEW_IMPL_20260904.md）:
//   I2  transcript は st.isFile() を確認してから読む（FIFO・デバイス等の非 regular file 防御）。
//   I3  使用量は input+cache_creation+cache_read のみ。output_tokens は**仕様として非算入**
//       （/context 表示との一致を SoT とする・出力分は次ターン input へ折り込まれ二重計上になるため）。
//
// テスト注入（本番未設定・context-usage-gate.test.cjs 用。既存検出核の env 注入慣行に従う）:
//   CUG_CONFIG    … app-config.json のパスを差し替え
//   CUG_STATE_DIR … 状態ファイル置き場を差し替え（既定 ~/.claude/tmp）
//   CUG_DEBUG=1   … ~/.claude/tmp/context-usage-debug.log へ読取内訳を追記（stdout には出さん）。
//                   可視性・transcript 鮮度プローブ（Codex[6]）はこのログと /context 表示の突合で実測する。
//                   記録: (b) 鮮度 = 採用行 timestamp / ファイル mtime・size / 走査 mode（full|tail|fallback-full）
//                         (c) 行選択 = 採用行 uuid / 飛ばした sidechain assistant-usage 行数

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_W1 = 800000;
const DEFAULT_W2 = 900000;
const TAIL_BYTES = 4 * 1024 * 1024; // 通常ケースは末尾近傍に最終 assistant 行がある前提の tail 読み

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function readThresholds() {
  const def = { w1: DEFAULT_W1, w2: DEFAULT_W2 };
  try {
    const p = process.env.CUG_CONFIG || path.join(os.homedir(), '.ccpit', 'app-config.json');
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    const cu = cfg && cfg.contextUsage;
    const a = cu ? cu.warn1 : undefined;
    const b = cu ? cu.warn2 : undefined;
    if (Number.isInteger(a) && Number.isInteger(b) && a > 0 && b > 0 && a < b) {
      return { w1: a, w2: b };
    }
    return def; // 部分的に正しくても既定へ（w1>=w2 の混成状態を作らんため）
  } catch { return def; }
}

function stateDir() {
  return process.env.CUG_STATE_DIR || path.join(os.homedir(), '.claude', 'tmp');
}

function readFired(stPath) {
  try {
    const st = JSON.parse(fs.readFileSync(stPath, 'utf8'));
    if (st && Array.isArray(st.fired)) {
      return st.fired.filter((n) => Number.isInteger(n) && n > 0);
    }
  } catch { /* 破損・不在は未発火扱い */ }
  return [];
}

function writeStateAtomic(stPath, fired) {
  const tmp = stPath + '.tmp' + process.pid;
  try {
    fs.mkdirSync(path.dirname(stPath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ fired, updated: new Date().toISOString() }));
    fs.renameSync(tmp, stPath); // NTFS 同一ディレクトリの置換 rename（Codex[3]）
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* 残骸掃除も fail-open */ }
    return false;
  }
}

function scanLast(text) {
  // Codex[6] プローブ: 行選択の証跡（(b) 鮮度 / (c) sidechain 混在時の選択）を CUG_DEBUG ログ用に採る。
  // 走査順・採用規則は従来と同一。プローブは観測のみで選択へ影響せん。
  const probe = { sidechainSkipped: 0, ts: null, uuid: null };
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line[0] !== '{') continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type === 'assistant' && obj.message && obj.message.usage) {
      if (obj.isSidechain === true) { probe.sidechainSkipped++; continue; } // AC6 除外＋(c) 証跡
      probe.ts = typeof obj.timestamp === 'string' ? obj.timestamp : null; // (b) Stop 時刻との突合用
      probe.uuid = typeof obj.uuid === 'string' ? obj.uuid : null;
      const u = obj.message.usage;
      // I3: output_tokens は非算入（/context 一致・次ターン input へ折込まれ二重計上になる）
      return { ctx: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0), probe };
    }
  }
  return { ctx: null, probe };
}

function lastAssistantCtx(tp) {
  const st = fs.statSync(tp);
  const meta = (r, mode) => {
    r.probe.mode = mode; // full | tail | fallback-full
    r.probe.size = st.size; // (b) Stop 時点のファイルサイズ
    r.probe.mtime = new Date(st.mtimeMs).toISOString(); // (b) 最終書き込み時刻
    return r;
  };
  if (!st.isFile()) return meta(scanLast(''), 'not-file'); // I2: FIFO・デバイス等は読まん（fail-open）
  if (st.size <= TAIL_BYTES) return meta(scanLast(fs.readFileSync(tp, 'utf8')), 'full');
  const fd = fs.openSync(tp, 'r');
  let text = '';
  try {
    const buf = Buffer.alloc(TAIL_BYTES);
    const n = fs.readSync(fd, buf, 0, TAIL_BYTES, st.size - TAIL_BYTES);
    text = buf.toString('utf8', 0, n);
  } finally { fs.closeSync(fd); }
  const nl = text.indexOf('\n');
  const got = scanLast(nl >= 0 ? text.slice(nl + 1) : ''); // 先頭の欠け行は捨てる（UTF-8 断面も同時に解消）
  if (got.ctx != null) return meta(got, 'tail');
  // 稀: 巨大 tool_result 行で最終 assistant 行が tail 窓から押し出された場合の全走査フォールバック
  return meta(scanLast(fs.readFileSync(tp, 'utf8')), 'fallback-full');
}

function debugLog(rec) {
  if (process.env.CUG_DEBUG !== '1') return;
  try {
    const p = path.join(os.homedir(), '.claude', 'tmp', 'context-usage-debug.log');
    fs.appendFileSync(p, JSON.stringify(rec) + '\n');
  } catch { /* デバッグ経路の失敗も本体へ波及させん */ }
}

function main() {
  const raw = readStdin();
  let inp;
  try { inp = JSON.parse(raw); } catch { return; }
  if (!inp || typeof inp !== 'object') return;
  if (inp.stop_hook_active === true) return; // 再入時に advisory を重ねん（多数派 hook の慣行）
  const sid = typeof inp.session_id === 'string' ? inp.session_id : '';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(sid)) return; // [1]
  const tp = typeof inp.transcript_path === 'string' ? inp.transcript_path : '';
  if (!tp) return;

  let ctx, probe;
  try { const r = lastAssistantCtx(tp); ctx = r.ctx; probe = r.probe; } catch { return; }
  if (!Number.isFinite(ctx) || ctx <= 0) {
    debugLog({ t: new Date().toISOString(), sid, ctx, probe }); // (b) の失敗系こそ証跡に残す
    return;
  }

  const { w1, w2 } = readThresholds(); // [5]
  const stPath = path.join(stateDir(), 'context-usage-' + sid + '.json');
  const fired = readFired(stPath);
  const crossed = [w1, w2].filter((t) => ctx > t && !fired.includes(t));
  debugLog({ t: new Date().toISOString(), sid, ctx, w1, w2, fired, crossed, probe });
  if (crossed.length === 0) return;

  if (!writeStateAtomic(stPath, fired.concat(crossed))) return; // [4] 永続化成功時のみ警告

  const top = Math.max.apply(null, crossed); // K1: 上位のみ表示
  const sym = top >= w2 ? '\u{1F534}' : '\u{1F7E3}'; // 🔴 / 🟣（W-3 記号既定・色非依存）
  const kv = Math.round(ctx / 1000) + 'K';
  const kt = Math.round(top / 1000) + 'K';
  const tail = top >= w2
    ? '/compact を強く検討（実行判断はmaintainer）'
    : '/compact の検討を（実行判断はmaintainer）';
  const msg = sym + ' コンテキスト ' + kv + ' — ' + kt + ' 閾値超。' + tail;
  process.stdout.write(JSON.stringify({ systemMessage: msg })); // W-5: 検討を促すのみ・命令形なし
}

try { main(); } catch { /* fail-open */ }
