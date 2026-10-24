# 図の色の検査スクリプト（保存して使う）

> この章を開く作業: 図の色の検査スクリプト `figure-contrast-check.cjs` を保存して使う時

検査本体。`figure-contrast-check.cjs` として保存して使う（Node 組込モジュールのみで動作）:

```javascript
// 図の塗り/文字色の対とコントラストを検査する（round-8・Codex 指摘是正版）。
// 使い方: node figure-contrast-check.cjs [検査対象=.]   （MD ファイル / ディレクトリのどちらでも可）
// 終了値: 0=違反なし / 1=違反あり / 2=検査失敗
//
// 保証範囲の明示: 終了値 0 は「本検査が解決する範囲（style/classDef 宣言に直接書かれた
// fill/color/opacity 系の対とその実効値）に違反が無い」ことのみを意味する。class 適用
// （:::className・class 文・既定クラス）を経由した合成は解決しない。描画結果の実際の
// コントラストを保証するものではなく、目視確認は省略可能な追加確認ではない。
const fs = require("fs"), path = require("path");
const SKIP = new Set(["node_modules", ".git"]);
const NAMED = { white: "#ffffff", black: "#000000" };
const OPACITY_PROPS = new Set(["opacity", "fill-opacity", "stroke-opacity"]);
const OPACITY_FIELD = { opacity: "opacity", "fill-opacity": "fillOpacity", "stroke-opacity": "strokeOpacity" };
const IMPORTANT_RE = /^(.*?)\s*!\s*important\s*$/i;

function lum(c) {
  c = String(c).trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(NAMED, c)) c = NAMED[c];   // 継承プロパティを拾わない
  let h = c.replace(/^#/, "");
  if (h.length === 3) h = h.split("").map(x => x + x).join("");
  if (!/^[0-9a-f]{6}$/.test(h)) return null;          // 8桁(透過)・未知の色名・変数は判定不能
  const v = [0, 2, 4].map(i => {
    const n = parseInt(h.substr(i, 2), 16) / 255;
    return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function ratio(a, b) {
  const x = lum(a), y = lum(b);
  if (x === null || y === null) return null;
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
// 不透明度が 1 未満、または値を解釈できない場合は "安全側で taint"（判定不能）とする。
// ".5" のような先頭 0 省略や "50%" も受理する。
function isReducedOrUnknownOpacity(v) {
  const s = String(v).trim();
  const m = /^(\d*\.?\d+)(%)?$/.exec(s);
  if (!m) return true;
  const num = parseFloat(m[1]);
  if (Number.isNaN(num)) return true;
  return m[2] ? num < 100 : num < 1;
}
// 鍵の最終状態から不透明度 taint を判定する（opacity/fill-opacity/stroke-opacity は
// それぞれ独立したプロパティとして、!important 解決後の実効値で判定する）。
function opacityTaint(st) {
  for (const f of ["opacity", "fillOpacity", "strokeOpacity"]) {
    if (st[f] !== undefined && isReducedOrUnknownOpacity(st[f].value)) return true;
  }
  return false;
}

// "!important" 接尾辞を検出して除去する。mermaid は CSS 同様 !important を受理し、
// 通常宣言より優先する。これを無視して「最後に書かれた値」を機械的に採用すると、
// 先に !important で下げた不透明度を、後続の通常宣言が誤って解除したことになってしまう
// （Codex 指摘）。
function parseImportant(raw) {
  const m = IMPORTANT_RE.exec(raw);
  return m ? { value: m[1].trim(), important: true } : { value: raw.trim(), important: false };
}
// フィールドへの反映は CSS の優先順位を模す: !important は非 !important に絶対に負けない。
// 同じ優先度同士なら後勝ち。
function setField(st, field, parsed) {
  const cur = st[field];
  if (!cur || !cur.important || parsed.important) st[field] = parsed;
}

const target = process.argv[2] || ".";
const files = [];
try {
  if (fs.statSync(target).isDirectory()) {
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(path.join(d, e.name)); }
        else if (/\.md$/i.test(e.name)) files.push(path.join(d, e.name));
      }
    })(target);
  } else {
    files.push(target);                                // ファイル指定はそのファイルだけを見る
  }
} catch (e) { console.error("検査失敗（走査）: " + e.message); process.exit(2); }

// フェンス判定。開始は情報文字列を伴い、終了は「同種・同長以上・行末まで空白のみ」。
// 終了側を行末まで検証するのは md2html.cjs:286 と同じ規則（同 278 が開始側）。
// ブロッククォート内フェンス（"> ```mermaid"）は対象に入らないが、レンダラのトークナイザ
// （md2html.cjs 同箇所）も行頭以外のフェンスは認識しないため、検査漏れが描画される図に
// 対応することはない。
const FENCE = /^(\s*)(\x60{3,}|~{3,})(.*)$/;
const DECL = /^\s*(style|classDef)\s+(\S+)\s+(.*)$/;
const COLORISH = /^(?:#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|[A-Za-z]+)$/;

function propsOf(propsStr) {
  const out = [];
  for (const part of propsStr.split(",")) {
    const p = /^\s*([A-Za-z][A-Za-z-]*)\s*:\s*(.*?)\s*$/.exec(part);
    if (p) out.push({ name: p[1].toLowerCase(), value: p[2] });
  }
  return out;
}
// 値“全体”が色形式でなければ判定不能。部分一致で合格させない
function colorOf(v) { return COLORISH.test(v) && lum(v) !== null ? v : null; }

// 行を ";" で宣言単位に割る。ただし "..."（クォート）や []/()/{}（ノードラベル等）の
// 内側の ";" では割らない — ラベル本文に ";" と "style ... fill:" 相当の文字列が
// 偶然含まれていても宣言として誤認しないため。
function splitStatements(line) {
  const out = [];
  let depth = 0, inQuote = false, cur = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) { cur += ch; if (ch === '"') inQuote = false; continue; }
    if (ch === '"') { inQuote = true; cur += ch; continue; }
    if (ch === "[" || ch === "(" || ch === "{") { depth++; cur += ch; continue; }
    if (ch === "]" || ch === ")" || ch === "}") { if (depth > 0) depth--; cur += ch; continue; }
    if (ch === ";" && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

// state（ノード/クラス鍵ごとの合成 fill/color/opacity 系）の最終形を判定して報告する。
// 呼び出し元はフェンスが閉じた時点（1 図につき 1 回）で呼ぶ — 対象名は図ごとに
// スコープが閉じているため、複数の図で同じ名前を使い回しても互いに混線しない。
function evaluateAndReport(state) {
  let n = 0;
  for (const [key, st] of state) {
    if (!st.fill) continue;                            // 塗りが一度も出ていない鍵は対象外
    const label = key + " (fill:" + st.fill.value + (st.color ? ",color:" + st.color.value : "") + ")";
    if (!st.color) { console.log(st.lastAt + "\tPAIR_MISSING\t" + label); n++; continue; }
    if (opacityTaint(st)) {                             // 不透明性を確認できない = 実効コントラストを実測できない
      console.log(st.lastAt + "\tUNDECIDABLE(opacity)\t" + label); n++; continue;
    }
    const fv = colorOf(st.fill.value), cv = colorOf(st.color.value);
    const r = (fv && cv) ? ratio(fv, cv) : null;
    if (r === null) { console.log(st.lastAt + "\tUNDECIDABLE\t" + label); n++; }
    else if (r < 4.5) { console.log(st.lastAt + "\tLOW_CONTRAST " + r.toFixed(2) + ":1\t" + label); n++; }
  }
  return n;
}

let bad = 0, scanned = 0;
try {
  for (const f of files) {
    const lines = fs.readFileSync(f, "utf8").split(/\r?\n/);
    let open = null;                                   // {ch, len, mermaid}
    let state = null;                                   // 開いている mermaid 図 1 つ分の合成状態

    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const m = FENCE.exec(ln);
      if (m) {
        const ch = m[2][0], len = m[2].length, rest = m[3];
        if (open) {
          if (ch === open.ch && len >= open.len && /^\s*$/.test(rest)) {
            if (open.mermaid && state) { bad += evaluateAndReport(state); }
            open = null; state = null; continue;
          }
          // 同種でない/短い/行末に文字が続く = 終了フェンスではなく外側フェンスの中身
        } else if (!(ch === "\x60" && rest.includes("\x60"))) {
          open = { ch, len, mermaid: rest.trim().split(/\s+/)[0].toLowerCase() === "mermaid" };
          if (open.mermaid) state = new Map();
          continue;
        }
      }
      if (!open || !open.mermaid) continue;
      scanned++;
      if (ln.trimStart().startsWith("%%")) continue;   // mermaid のコメント行（行頭 %%）は宣言ではない
      const at = f + ":" + (i + 1);
      for (const stmt of splitStatements(ln)) {         // 宣言単位に割る（トップレベルの ";" のみ）
        const dm = DECL.exec(stmt);
        if (!dm) continue;
        const keyword = dm[1].toLowerCase(), rawNames = dm[2], propsStr = dm[3];
        const props = propsOf(propsStr);
        if (!props.length) continue;

        let dup = null;
        const seen = new Set();
        for (const p of props) { if (seen.has(p.name)) { dup = p.name; break; } seen.add(p.name); }
        if (dup) {                                     // 後勝ち規則に依存せず拒否する（同一宣言内）
          console.log(at + "\tDUP_PROP " + dup + "\t" + stmt.trim()); bad++; continue;
        }

        const fill = props.find(p => p.name === "fill");
        const color = props.find(p => p.name === "color");
        const opacityProps = props.filter(p => OPACITY_PROPS.has(p.name));
        if (!fill && !color && opacityProps.length === 0) continue;   // 対にも不透明度にも無関係な宣言は対象外

        // classDef は "classDef a,b,c fill:..." のように複数対象を一括定義できる（mermaid 仕様）。
        // 対象ごとに独立した鍵として合成する（1 つの結合鍵にすると個別上書きを見逃す）。
        const names = rawNames.split(",").map(s => s.trim()).filter(Boolean);
        for (const name of names) {
          const key = keyword + "::" + name;
          let st = state.get(key);
          if (!st) { st = {}; state.set(key, st); }
          if (fill) setField(st, "fill", parseImportant(fill.value));
          if (color) setField(st, "color", parseImportant(color.value));
          for (const op of opacityProps) setField(st, OPACITY_FIELD[op.name], parseImportant(op.value));
          st.lastAt = at;
        }
      }
    }
    if (open && open.mermaid && state) { bad += evaluateAndReport(state); }   // 未終端フェンスの救済（EOF）
  }
} catch (e) { console.error("検査失敗（読取）: " + e.message); process.exit(2); }

console.error(`検査: ${files.length} ファイル / mermaid 内 ${scanned} 行 / 違反 ${bad} 件`);
process.exit(bad ? 1 : 0);
```
