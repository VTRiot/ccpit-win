---
name: md-render
description: Fires when generating or verifying deterministic HTML from report MDs. Runs render / verify / lint / selftest / check via the bundled md2html.cjs
---

# md-render (deterministic MD→HTML renderer)

The MD is canonical; HTML is derived (HTML ⊆ MD). The renderer takes no wall clock, randomness, or environment as input and produces byte-identical HTML from the same MD (determinism).

## Trigger
- When generating HTML from a report MD
- **When you decide to create a new HTML file (not limited to reports)**
- When running `--verify` / `--lint` / `--check` (referenced from the report skill's renderer procedure)
- When converting an MD whose figures specify colors explicitly (inspect the fill / text-color pairing)
- When making the nodes of a figure (a mermaid flowchart / graph) clickable so they jump to where the details are written (the "Clickable figures" section)
- When quoting code snippets in a report (include via `include=` without transcribing, or verify against the real file via `cite=`; see the "Verifying code citations against real files" section)
- When putting graphs (matplotlib images, etc.) into a report as svg fences so readers can open them full-screen and read values (the "Figure viewer" subsection)
- When writing a procedure document that a person executes one step at a time while leaving results as they go (the "Procedure checklists" section, `checkboxes: on`)

## Output requirements (mandatory — 2026-07-17 operator instruction)

The moment you decide to produce HTML, emit **a self-contained form readable by double-clicking in a browser** within the same turn. "Leave the MD now, HTML later" is forbidden.

1. `<!DOCTYPE html>` + `<meta charset="utf-8">` (a Japanese document is unreadable without it)
2. Standalone: CSS/JS embedded. No dependence on external URLs or relative references to separate files (mermaid's three-stage fallback is permitted)
3. If there is an MD manuscript, generate from it with this renderer and pass `--verify`. **`--verify` is the first argument** — placing it after `<in.md>` makes it be interpreted as out.html, writing the HTML into a file literally named `--verify` (a known trap; actually occurred 2026-07-17)
4. Before reporting completion, read back the head of the generated artifact to mechanically confirm 1–2, and state in the report **the full path with extension plus a file:/// URL** (a form that opens by pasting into the browser address bar; a CLI environment cannot double-click — operator note 2026-07-18)
5. Always inject the three no-cache meta tags into the head (`Cache-Control: no-cache, no-store, must-revalidate` / `Pragma: no-cache` / `Expires: 0`) (operator instruction 2026-08-30: countermeasure against a stale cache being displayed after a re-render. Static fixed strings only = determinism preserved. **Over HTTP the server headers take precedence over the meta tags**, so cache control at the serving layer is separately required — the meta tags reliably take effect only for direct `file://` opening, a simple static server, and webview-type hosts)

## Usage (bundled md2html.cjs; Node built-in modules only)

```bash
R=~/.claude/skills/md-render/md2html.cjs

node "$R" <報告書.md> <報告書.html>   # 生成（固定 7 ブロック・ダークテーマ）※ 出力先必須
node "$R" <報告書.md> -               # 画面出力（標準出力へ流す。パイプ用途。'-' 明示必須）
node "$R" <報告書.md> --stdout        # 画面出力（'--stdout' オプション形式）
node "$R" --verify <報告書.md>        # 双方向検証: HTML⊆MD（捏造ゼロ）+ MD⊆HTML（欠落ゼロ）+ コード引用の実物照合（cite=/include= を書いた文書のみ）
node "$R" --lint <報告書.md>          # figures 宣言-実体一致（双方向）+ 必須マーカー検査（必須見出しは本物の見出しだけで判定）。exit 1 = block
node "$R" --selftest                  # 内蔵 golden ケースの sha256 照合（破損検出）
node "$R" --check <in.md> <out.html>  # HTML 埋込 sha256 と現 MD の鮮度照合（_index 用）
```

- **Specifying the output destination is mandatory** (when omitted, it performs no conversion, modifies no existing file, and halts with `exit 2`; this prevents the "silent non-update / stale HTML left behind" bug caused by forgetting to write it).
- **For stdout output, state `-` or `--stdout` explicitly.** Specifying file output (`<out.html>`) and stdout output together, or specifying `--stdout` more than once, is refused as a contradiction error (`exit 2`).
- **Migration from the old contract**: calls that omitted the output destination for stdout or piping purposes (`| grep`, etc.) must be updated to state `-` or `--stdout` explicitly.
- **Judge generation success by the exit code of `--check <in.md> <out.html>`** (exit 0 = the sha256 embedded in the HTML matches the current MD = fresh). **Do not make a stderr log string the contract for a success determination.**

> **Incident record and root prevention (actually occurred 2026-09-09 → revised 2026-09-10, CCPIT_062)**:
> It was run with the output destination omitted and `2>&1 | tail -5`, and "the HTML streamed to the screen, exit 0" was mistaken for success. In reality the MD had been updated while the old HTML was left in place (detected by comparing `ls` timestamps).
> A stderr warning (`[RENDER_STDOUT]`) was added at first, but because the warning is emitted before the HTML, it does not remain on screen under `2>&1 | tail` and so did not prevent the incident.
> CCPIT_062 therefore changed the CLI contract, hardening it so that **omitting the output destination is an error (exit 2) that halts immediately and emits no conversion result.** Stdout output is accepted only by an explicit `-` or `--stdout`.
>
> Guarantee scope: that the renderer itself halts on a forgotten output path as an error and prevents a stale file being left or overwritten. Preventing execution forms where the calling shell does not propagate the renderer's exit code (no pipefail, etc.) is outside this renderer's responsibility — that is carried by the `--check` exit-code convention.
- Allowed syntax is a closed set of 8 (see the report skill's "Allowed Syntax"). Unsupported syntax degrades to literal display; no content is lost. One exception: a document that declares frontmatter `checkboxes: on` renders list items starting with `[ ] ` / `[x] ` as check boxes (the "Procedure checklists" section)
- Run `--lint` only on reports newly written after the revision (grandfather migration — see the report skill). Reports that have no unsettled decision items can exempt the warning via frontmatter `decisions: none` + `decisions_reason: <reason>` (coexistence with an actual `[!DECISION]` is a contradiction warning)
- **Required headings are counted only from "genuine headings"**: `--lint` required headings (`Readers and Purpose of this Report` / `Summary of Conclusions` / `Current Position` / `Out-of-Scope Proposals (Pending)`) and the report-type determination inspect only lines read by the renderer as headings (lines starting with 1–4 `#` characters at line start followed by a space). Sample headings written inside code blocks, blockquotes (`>`), mid-line, lines lacking a space after `##`, or lines with 5 or more `#` characters do not satisfy them. Evaluated levels remain as before (`Summary of Conclusions` is H2 only, others are H2–H4). `Out-of-Scope Proposals (Pending)` previously passed if the words appeared anywhere in the body, but now requires the words in a heading (`Pending` also counts as a word, matching interactive tab and section classification)
- In environments without the renderer, HTML generation may be skipped (the canonical MD alone fulfills reporting obligations — fail-soft)

## Figure rendering

- mermaid fences → client-side rendering. Loader falls back in 3 stages: ① `./vendor/mermaid.min.js` next to the HTML ② pinned CDN ③ raw text
- **For offline viewing**: copy the bundled `vendor/` next to the HTML (the loader resolves relative to the HTML document)
- svg fences → converted to base64 data-URI img (scripts neutralized, static image)
- Numeric table columns → proportional bars + value gradient applied automatically (meaning-neutral; see diagram-craft palette)

### Figure viewer (svg fences, automatic)

A document that emits at least one svg-fence figure gets a figure viewer automatically — no declaration is needed, and the output of a document without svg figures does not change by a single byte.

- Click a figure in the body (or select it with Tab and press Enter) to open it full-screen. Wheel / `+` `-` buttons / `+` `-` keys zoom, drag / arrow keys pan, double-click doubles the zoom, `0` fits the whole figure, `Esc` closes it; a two-finger pinch zooms too.
- A crosshair follows the pointer. If the figure's SVG carries axis information (`<metadata data-mdr="axes">`, a JSON of `bbox` / `xlim` / `ylim` / `xscale` / `yscale` per axis in viewBox units, y downward), the value under the crosshair is shown in axis units; outside the axes no value is shown. Axis information affects only the viewer — not the figure's look or `--verify`.
- It stays a single HTML: the viewer is embedded and reads the figure's data URI in place; no external file or network is used.
- The paragraph immediately before the figure is shown as its title in the top bar.
- Rules for graphs: stack multi-panel figures vertically (`plt.subplots(nrows, 1)`) — side-by-side panels shrink to the body width and stay small even when zoomed. A PNG is not drawn by Markdown image syntax; put an SVG that wraps the PNG in an `<image>` into an svg fence. Do not use `bbox_inches="tight"` with `savefig` (cropping the margin shifts the axes and the values read become wrong).
- The bundled `tools/svg_figure.py` is a helper for matplotlib figures: `save_png_with_axes(fig, "fig1.png", dpi=110)` writes the PNG plus its axis information, and `python tools/svg_figure.py <template.md.tpl> <out.md>` replaces a `<<PNG fig1.png>>` line with an svg fence that includes the axis information.
- Shape of the axis information (put it in the SVG as `<metadata data-mdr="axes">`; coordinates are in viewBox units, y downward; write the JSON in ASCII only, escaping non-ASCII and `<` `>` `&` as `\uXXXX`, which `tools/svg_figure.py` does):

  ```json
  {"version": 1, "axes": [{"bbox": [74, 40, 1071, 340], "xlim": [0, 100], "ylim": [0, 230],
    "xscale": "linear", "yscale": "linear", "xlabel": "Pedal [%]", "ylabel": "MAP [kPa]", "title": "4000 rpm"}]}
  ```

  `bbox` is the axes frame as [left, top, right, bottom]; `xlim` is the values at the frame's left and right edges, `ylim` the values at the bottom and top edges (a reversed axis is written reversed); the scale is `linear` or `log` (`log` only for a positive range). An axis whose shape does not fit is dropped (the crosshair still shows, but no value). The viewer reads at most the first 64 entries of `axes` and at most 200,000 characters of JSON, so that a broken figure cannot freeze the page.

## Figure fill and text-color pairing

The renderer initializes mermaid with the **dark theme fixed**. In the dark theme the node text color defaults to a light shade (mermaid ties node text color to primaryTextColor, and in darkMode that default is light). Therefore **giving `fill` only light colors puts light text on a light background and makes it unreadable.** The default text color was chosen on the premise that a dark fill will arrive; the moment you place a light fill, that premise no longer holds.

- Whenever you state `fill` explicitly in mermaid's `style` / `classDef`, **state `color` (text color) explicitly in the same declaration** (the recommended way to write it). Do not leave it to the theme's default text color
- Follow diagram-craft's `templates/palette.md` for the palette. **Do not use colors outside the palette** (diagram-craft's prohibition; this skill makes no exception to it). If you need a different color, extend the palette on the diagram-craft side first
- Judge the contrast level by the WCAG relative luminance ratio (the AA criterion is 4.5:1 for normal text, 3:1 for large text). **Because this inspection does not determine font size, it uniformly requires the normal-text criterion of 4.5:1 at all times.** The relaxation for large text (3:1) is out of scope for this inspection (there is room for over-detection, but that is the safe side compared with a miss)
- **Merely writing the pair does not guarantee readability.** Put similar shades in `fill` and `color` and the pair is present but still unreadable. The guarantee extends only to "a declaration with an opaque fill and text color whose ratio was measured and met the criterion". `opacity` / `fill-opacity` / `stroke-opacity` are each independent properties, judged by the last value set across the whole figure (lowering below 1 partway through is cleared if it is finally returned to 1 (100%); conversely, even without ever stating it explicitly, a figure that ends with an intermediate declaration below 1 is tainted). Values that cannot be interpreted (variables, function notation, etc.) are also tainted on the safe side (undecidable)
- **Multiple declarations against the same node / class are judged by the composed final state within that figure (a single mermaid fence).** Writing them separately — `fill` on line 1, `color` on line 2 — still passes as long as the pair is complete at the end and meets the criterion. Conversely, it also detects the case where a later declaration overwrites only `color` and breaks the pair (an overwrite that does not re-declare `fill` is not thereby excluded from inspection). Node IDs / class names are **scoped per figure (per fence)**, so reusing the same name in a different figure does not cross-contaminate
- A declaration that **defines multiple targets at once**, such as `classDef a,b,c fill:...`, is composed as an independent key per target. Even if a later declaration individually overwrites only some of the bulk-defined targets, it is correctly detected as the final state of that target alone
- **Class application (`nodeId:::className` or `class nodeId className`) is not resolved.** A `classDef` and the direct `style` on the node it applies to are evaluated as separate keys. A combination where the class side has `fill` and the applied node's direct specification has only `color` (or vice versa) cannot be judged as a complete pair by this inspection — it either becomes `PAIR_MISSING` or passes through as an apparently unrelated declaration. Check such combinations visually (resolving class application is out of scope by design — the further the scope widens, the closer it gets to re-implementing mermaid's cascade rules, so it was excluded deliberately)
- When a `fill` / `color` / `opacity`-family value carries **`!important`**, it takes precedence over non-`!important` declarations just as in CSS (between two `!important` values, the later wins). Ignoring this would treat an opacity lowered earlier with `!important` as having been wrongly cleared by a later ordinary declaration
- **An exit code of `0` means only that there is no violation within the range this inspection resolves (the pairs and effective values written directly into `style`/`classDef` declarations).** Composition routed through class application (previous item) is out of scope, and it does not guarantee the actual contrast of the rendered result. The visual check (step 4 of the next section) is not an optional extra confirmation but a mandatory complement
- **SVG fences are out of scope for this rule.** In SVG the text color is also given by `fill` rather than `color`, so the same inspection cannot be applied. For SVG, visually confirm the text and background of the rendered result.

### Pre-generation inspection (acceptance criteria for the artifact)

When converting an MD whose figures specify colors explicitly, run the following **before generating the HTML**:

1. Inspect the target MD (script below)
2. If the exit code is `1`, fix the declarations and **re-inspect until the exit code is `0`**. Do not generate HTML until it is `0`
3. An exit code of `2` is not "no violations". Resolve the cause and re-run
4. After generating the HTML, open the figure in question and visually confirm the text is readable (this inspection checks declarations, not rendering)
5. Holding back generation because of this inspection is an **exception** to "emit it in the same turn once you decide to produce HTML" (output requirements). On inspection failure it is enough to report "not generated + the violating locations" in the same turn; do not force generation with an unreadable figure. This is independent of "may be skipped in environments without the renderer" (the fail-soft in the usage section) — the two act on separate axes

The inspection itself. Save it as `figure-contrast-check.cjs` and use it (works with Node built-in modules only):

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

```bash
node <保存先>/figure-contrast-check.cjs <走査ルート>   # 省略時 "."
```

- Exit codes: `0` no violations / `1` violations found / `2` inspection failed. **Do not treat empty output as grounds for a pass** (stdout can also be empty on a read failure)
- There are four detection kinds. `PAIR_MISSING` (a composed `fill` exists but no `color`) / `LOW_CONTRAST` (the ratio is below the criterion) / `DUP_PROP` (the same property is duplicated within one declaration; do not make it depend on the later-wins rule) / `UNDECIDABLE` (**the value as a whole** does not match a color format so no ratio can be produced, or the final value of `opacity`/`fill-opacity`/`stroke-opacity` is below 1 (100%) or is an uninterpretable value so the effective contrast cannot be measured. Variables, function notation, 8-digit alpha, unknown color names, and reduced opacity all land here. The only color names resolved are `white` and `black`). Treat `UNDECIDABLE` as a violation, not as pending, and change it to a specification that can be measured
- The `opacity`-family properties are judged independently of fill/color, by **the last value set** across the whole figure (fence), with `!important` taking precedence where present. Lowering below 1 partway through is cleared if it finally returns to 1 (100%); conversely, ending below 1 leaves it tainted. A leading-zero-omitted `.5` and a percentage `50%` are both interpreted
- **`!important` takes precedence just as in CSS.** For `fill`, `color`, and the `opacity` family alike, an `!important` value is not overwritten by a later non-`!important` declaration (between two `!important` values, the later wins)
- A **bulk definition of multiple targets** such as `classDef a,b,c fill:...` is composed as an independent key per target. Even when a later declaration individually overrides only some of the targets, it is correctly judged as that target's final state
- **Class application (`:::className` / `class nodeId className`) is not resolved.** The declaration on the `classDef` side and the direct `style` declaration on the applied node are evaluated as separate keys. A design where the pair is only complete across both is out of scope for this inspection (a deliberate scope limitation). Check such combinations visually. **An exit code of `0` means only that there is no violation within the resolved range; it does not guarantee the rendered contrast including class application**
- **Do not let a partial match pass.** `color:#111-invalid` is not read as `#111`; it becomes `UNDECIDABLE`
- The judgement is **restricted to the inside of mermaid fences**, and lines are split into declarations before inspection. The split occurs only on top-level occurrences of `;`, never on a `;` inside `"..."` or `[...]`/`(...)`/`{...}` (node labels, etc.) — so a label body that happens to contain `;` together with a string resembling `style ... fill:` is not misread as a declaration. Prose and explanatory code inside a `bash` fence are not picked up either
- Opening and closing fences are judged separately. A closing fence is recognized only on a line that is **the same kind, the same length or longer, and whitespace only from the marker to end of line** (the same rule as the renderer's closing determination at `md2html.cjs:286`). If the outer fence is not mermaid, the inside is not scanned at all — so a mermaid example quoted for explanation does not stop the inspection
- **A mermaid comment line (`%%` at the start of the line) is not treated as a declaration**, so an explanatory `style` example written inside a comment does not make the exit code `1`. Because mermaid comments are a line-level construct, a `%%` mid-line is not treated as a comment (in that case the value does not match a color format and becomes `UNDECIDABLE`)
- The order in which properties are written does not matter (`stroke` before `fill` is still detected)
- The only excluded directories are `node_modules` and `.git`. Do not claim absence across the whole from inspecting only part of the tree. The `.md` extension check is case-insensitive (`.MD` is included too)
- Directory symlinks are not followed (to avoid hangs from circular references). To include such a subtree, specify the real path directly
- **The judgement is per figure (per mermaid fence), looking at the final state composed from the `style` / `classDef` declarations within that same figure.** Even when a "fill-only declaration" and a "color-only declaration" are split across multiple occurrences under the same node/class name, it passes as long as the pair is complete at the end, and it is detected when a later `color`-only overwrite breaks the pair. Because node IDs / class names are scoped per figure, reusing the same name in a different figure does not cross-contaminate

### Repository-wide inventory (keep it separate from artifact inspection)

Pointing the scan root at the repository root turns it into a repository-wide inventory. **An inventory result is not an acceptance criterion for the artifact you are currently generating.** Pulling unfixed spots in unrelated existing documents into every work session expands the work without limit. Record what the repository-wide run turns up as a separate item, and fix it the next time you touch that document.

## Interactive tabs (optional)

Declare `tabs: by-h2` in the report frontmatter to render the top-level body H2 sections as a tab UI (deterministic extension — no new MD syntax). Tab labels are the H2 heading text (MD-derived); the audience / decisions / TOC / pending panels and the lead stay outside the tabs.

- **Progressive enhancement (fail-soft)**: with JS disabled, all panels render stacked and every section is readable. A fixed inline script adds `html.js` before paint, switching to tab view only when JS runs. The tab loader reads only `data-*` attributes and toggles `classList` / `aria-selected` (no `innerHTML`, no MD-derived strings injected into the DOM) — determinism and `HTML⊆MD` are preserved (hidden panels remain in the static HTML and are covered by `--verify`).
- Needs ≥2 tabbable H2 sections (`--lint` warns otherwise). Unknown `tabs` values are ignored with a lint warning.
- The tab CSS/JS is injected only for `tabs: by-h2` reports; non-tab reports stay byte-identical.
- Known limitation: anchor links (TOC / decisions panel) into an element inside an inactive tab do not auto-reveal that tab (fidelity is intact — the text is present in the HTML).

## Section anchors (sha1, all reports)

Heading ids are `sec-<sha1(normalized-heading)[:8]>` (position-independent, heading-dependent). Re-rendering keeps the id stable as long as the heading text is unchanged — so anchored comments never get lost. TOC / decision links derive from the same id, so they stay consistent automatically. Identical-text H2 headings share one id (`--lint` warns); make headings unique to avoid comment merging.

## Comments & reply-prompt (reports, default on)

Reports (detected via `isReport`: frontmatter `doc_id`/`report_id`/`audience`/`status` or a genuine heading (H2–H4; inside code blocks does not count) for "Readers and Purpose of this Report") **with a stable id (`report_id` or `doc_id`)** get a per-topic comment Composer under each body H2, plus a reply-prompt generator. Suppress with `comments: off`.

- **localStorage only** (key `ccpit-cmt:<reportId>:<sectionId>`); comments are never written into the HTML body → determinism (same MD → byte-identical) and `HTML⊆MD`/`MD⊆HTML` are preserved (the Composer is empty containers + CSS/aria labels + empty textarea → zero static text nodes; verified by an on/off `extractTextNodes` equality test).
- **reportId is MD-derived only** (`report_id`/`doc_id`); no filename fallback (a filename is MD-external and would break byte-identity). No id → comments disabled.
- **Reply prompt** = fixed-format aggregation (LLM-free) of all comments → `navigator.clipboard.writeText` one-click copy (falls back to `execCommand('copy')` + select on non-secure contexts like `file://`). Reply-body generation (by a reviewing agent / CC) is out of this renderer's scope (layer separation).
- Injected only for comment reports; non-comment docs stay byte-identical.

## Back-navigation (reports, default on)

Reports (per the `isReport` determination) always get a **"↩ back" chip for in-page anchor navigation** (fixed at bottom right) injected (operator instruction 2026-09-01). Clicking an anchor in the TOC or body pushes scrollY onto a stack (cap 50), and clicking the chip returns to the original position.

- On return, the hash is removed via `history.replaceState` (so re-clicking the same anchor navigates again). When the stack empties, the chip hides again.
- The label is CSS `::before` content (**generates no static text node**) and the button carries only `aria-label` = determinism and `HTML⊆MD` preserved (the loader `<script>` is excluded from `extractTextNodes`).
- Injected only into `isReport` documents. Non-reports stay byte-identical. No `report_id` required (independent of the comment feature).
- Clicks onto a hidden target (inside an inactive tab, etc.) and clicks already `preventDefault`ed are not pushed (bubble phase + an `offsetParent` guard). Under `@media print` the chip is not printed. Tabs are not auto-revealed (following the tab feature's known limitation — reflecting the 2026-09-01 Codex review).

## Clickable figures (optional — `figure_links:` block)

Clicking a node in a report figure (mermaid `flowchart` / `graph`) **jumps to the location where its details are described (heading, table row, list item)**, and clicking "↩ Back to figure" at the bottom right **returns to the figure's position**. A feature to let readers recall in a single action "what was this figure item about again?" (**zero new MD syntax**; a block declaration identical to `hover:` and `comments_resolved:`). **Takes effect only in documents declaring it**.

### Syntax (frontmatter)

```yaml
figure_links:
  - M7 || row: M7
  - D || heading: 済んだ段
  - C || item: M23
```

- 1 line = 1 mapping. Format is `- NodeID || Type: String` (Node ID before `||`, Type: String after). Write as an **empty-valued block** (indented `- ` lines starting on the line immediately after `figure_links:`)
- **Node ID**: The node ID from the figure's source text (`M7` in `M7["M7 English version"]`). Permitted characters are ASCII letters, digits, and `_` only (anything else is a `--lint` error). A declaration whose node ID **never appears** in any mermaid figure source in the document is a `--lint` error
- **Type** is one of the following 3. **Table rows** and **list items** are designated by "text", not by position:
  - `heading: Heading text` — Exact text match for a heading (**H2–H6**; H1 cannot be designated, whether as document title or subsequent occurrences in body). The "Readers and Purpose", "Summary of Conclusions", and "Pending Proposals (Out of Scope)" headings can also be designated
  - `row: Cell 1 text` — Exact text match for the first cell in a table body row (header rows are excluded). Example: `row: M7` for a row whose first column is `M7`
  - `item: Leading text of list item` — Exact match of list item body, or list item starting with "that text + space". Example: `item: M23` for `- M23 in all tests...` (`M2` does not pick up `M22`)
- **Normalization of matching** (identical processing on declaration side and document side): Links `[t](u)` become `t` (link parsing matches the renderer body, closing at the first `)`; if `u` contains `)`, the subsequent `)` remains as text), `**` and backticks are stripped, NFC normalized, and runs of whitespace (including full-width spaces) are collapsed to a single half-width space and trimmed. Headings, cells, and list items containing bold, code, or links can be designated by their visual text
- **The target must resolve to exactly one location**. Resolving to 0 or ≥2 locations (multiple headings with the same text, multiple table rows with identical column 1, etc.) is a `--lint` error (does not silently pick the first). Multiple nodes pointing to the **same destination** is permitted (many-to-one). Listing the same node ID in multiple declarations is forbidden
- Tables and list items are counted at their rendered positions, even inside admonitions (`> [!NOTE]`, etc.), blockquotes, or the "Readers and Purpose", "Summary of Conclusions", or "Pending Proposals (Out of Scope)" panels (for nested lists, each nested entry is a distinct item). `item` can designate both numbered and bulleted list items

### Behavior on click

- Clicking a node (or pressing Enter / Space) jumps to the target, **highlights it with border + background** (no animation under `prefers-reduced-motion`), moves focus to the target, and announces "Moved to '...'" to an offscreen `aria-live` region. If the target is inside an inactive tab, that tab is revealed before navigation
- A **"↩ Back to figure" chip** appears at the bottom right (above the existing "↩ Back" chip). Clicking it returns to the position just before clicking the node, returning focus to the clicked node. Return locations are kept in a small stack (cap 20), so if a user clicks a node in another figure after arriving at a destination, they can return one step at a time. If the return location's figure is in another tab, that tab is revealed before returning
- Highlighting and temporary `tabindex` are recomputed from the stack. Jumping twice to the same destination and returning once does not clear the remaining highlight

### Documents without declarations, invalid declarations, safety

- **Reserved key**: `figure_links` is a reserved key (previously ignored as an unknown key). **Non-empty values** (`figure_links: foo`, `figure_links: [a, b]`) are not recognized as declarations; rendering and `--lint` behave as before (no warning emitted). Empty-valued blocks without any readable lines are also not treated as declarations (rendering as before). However, if an empty value has indented child lines but contains unreadable lines, `--lint` warns of misused block syntax
- HTML for documents without declarations is **byte-identical before and after adding this feature for the same input** (verified across a large corpus of existing documents and pinned in `--selftest`). **Documents with 0 valid declarations** also inject neither CSS, JS, data island, chip, nor `id` attributes, yielding output identical to the same document without the `figure_links` line (only the source-hash-derived `data-src-sha256` attribute and footer sha differ because source differs; `--selftest` normalizes both before comparison). Only when ≥1 valid declaration exists, valid target `<tr>` and `<li>` receive `id="fl-N"` (sequential numbers), and the data island, dedicated CSS, fixed loader, and chip are injected
- **mermaid `securityLevel` is not relaxed**. The `click` syntax is not used. The loader matches SVG `g.node` (`id` is `flowchart-<nodeID>-<index>`) after mermaid finishes rendering against declarations via **exact string equality comparison** and wires up the click (does not construct regex or query selectors from declaration values). `innerHTML` is not used, and no external loads are added
- **Wiring markers are held in JS-side properties** (not attributes). Because mermaid constructs a temporary SVG inside `pre` during rendering and replaces it after converting to string, attributes are cloned but registered event listeners are lost. The loader detects this replacement via `MutationObserver` and re-wires the events
- Static inspection (`--lint`) checks **necessary conditions only** (whether node IDs appear in figure source text; does not strip comments or quotation marks). **Whether nodes can actually be clicked is verified at runtime**: declarations that could not be wired despite ≥1 rendered figure existing are indicated via `console.warn`, `<html data-fl-unwired="Node IDs...">`, and an "Unwired declarations" notice at bottom left (does not evaluate while 0 figures are rendered = offline, load failure, or pending render). Example: a node ID written only in a comment in the figure source passes `--lint`, but becomes an "Unwired declaration" at runtime. **After writing declarations, open in a browser once to confirm no notice appears**
- `--verify` (`HTML⊆MD`, `MD⊆HTML`) is invariant: messages are CSS pseudo-elements, attributes, and loader runtime strings; static text nodes do not increase. For documents with declarations, `--lint` inspects `figure_links` even if not a report type (exit 1 on error; `--verify` also treats lint errors as failures)

### Limitations

- Applies to mermaid `flowchart` / `graph` nodes (`subgraph` bounding boxes, edges, and other diagram types cannot be clicked)
- When a node ID is shared across multiple figures, wires across all figures where the ID appears (declarations are 1 set per document)
- Destinations are headings, table body rows, and list items. Table header rows, paragraphs, and code blocks cannot be designated

## Verifying code citations against real files (optional — `cite=` / `include=` / `rev=`)

When quoting code snippets in reports, transcribing by hand leads to transcription errors and line-number drifts. In fact, a quote of a code snippet that did not exist in the real file and a quote whose line numbers were offset by four lines passed because a self-audit table in the report stated "exact match." Hand-written tables do not catch these errors, so when attributes are written in the fence info string, `--verify` mechanically checks them against the real files. **Fences and documents that do not write these attributes are completely unaffected** (both HTML and `--verify` output remain identical to before).

### How to write (fence info string, following `title="..."` convention)

````text nocopy
```ts cite="src/lib/parser.ts:120-135"
（手で写した本文。実物のその範囲と行単位で完全一致していなければ --verify が失敗する）
```

```ts include="src/lib/parser.ts:120-135"
```

```ts cite="src/lib/parser.ts:120-135" rev="1a2b3c4d5e6f"
（引用した時点の commit の版と照合する）
```
````

| Attribute | Meaning |
|---|---|
| `cite="path:start-end"` | **Verification type**. The body is transcribed by hand (do not reorder lines for explanatory purposes). If it diverges from that range in the real file, `--verify` fails |
| `include="path:start-end"` | **Expansion type** (pull without transcribing). **Do not write** the body. Just specifying the range causes HTML to include the real file lines for that range. Since there is no transcription, transcription errors cannot occur. Use this as the default for citations. **Only files with source code, script, or markup extensions can be pulled** (configuration and data formats are refused; see the "File types allowed in `include=`" section). Write configuration file lines using `cite=` |
| `rev="commit"` | Inspects the real file as of that git commit version (freezing a point in time). Defaults to the current working tree when omitted. 7–40 hexadecimal digits only (`HEAD` and branch names move, so they are not allowed. Short hashes are treated as unverifiable if ambiguous or colliding with a branch/tag of the same name, so 40 digits is recommended) |

- Range is **mandatory** (1-based, inclusive on both ends). `path:line` specifies a single line. Full-file expansion is not supported. Path and range are split from the end, so the drive-letter `:` in `C:/x/y.ts:12-20` is not broken
- `cite=` and `include=` cannot be written at the same time. Writing the same attribute twice, not quoting the value with `"..."`, writing `rev=` alone, having body content when using `include=` (blank lines or whitespace-only lines are also not allowed; do not write even a single line of body), empty body when using `cite=`, containing control characters in the path, or writing them on mermaid / svg fences all fail as "invalid specification" (does not silently reinterpret)
- **Path resolution has only 1 way** (does not try candidates in sequence; avoids accidental false passes matching a different file): `~/` is the home folder. Absolute paths are used as-is. **Relative paths are resolved relative to the nearest ancestor folder holding `.git` (whether a directory or a worktree file) from the report MD (repository root)**; if `.git` does not exist, the folder containing the report is the origin. Real files in another repository are written as absolute paths. Absolute paths and `~/` may point to different files on another PC (re-running `--verify` on that PC will detect it)
- When `rev=` is attached, the repository is determined from the **real target file path** (does not diverge to another repository via symbolic links). A file that does not exist at that commit version is reported as "missing file". Past versions of files deleted from the current working tree can also be cited

### Strictness of verification (line-by-line exact match)

Only CR (newline differences) is ignored. **Trailing whitespace and indentation are compared strictly** (in environments where editors strip trailing whitespace, `cite=` will fail; use `include=` in that case). Fences written indented inside lists, etc., strip the number of leading spaces of the opening fence line from each body line before comparison (this is container indentation in Markdown, not real-file indentation; real-file indentation remains strict). BOM is stripped only from the very beginning of the file. Real files are read as UTF-8; unreadable files are treated as unverifiable. An empty line formed by a trailing newline at the end of the file does not count toward the line count.

### File types allowed in `include=` (allowlist / tool contract)

Report HTML is placed in shared locations, committed to git, and read by humans and other AIs. Because `include=` automatically inserts the file contents into the HTML by the tool, it could become a path where the author puts secrets (passwords, tokens, keys) into reports without inspecting the contents. Therefore, rather than guessing the pattern of secrets, **we define allowable file types and refuse everything else**.

**What the tool guarantees (the only guarantees)**

- **G1**: `include=` can pull **only files whose final extension is in the list below**. Inspection is case-insensitive and applies across ① the written path, ② the real target path (destination of symbolic links / junctions, resolved Windows short names), and ③ when `rev=` is used, the canonical path within the repository. Extensions not in the list (including extensionless files and dotfiles such as `.env` or `.json`) are refused **before opening the file, counting lines, or reading git blob contents**
- **G2**: `cite=` for file types not in the list is verified, but **does not output real-file lines in mismatch diagnostics**. It outputs only the author-written line, line numbers, line counts, and whether "the quote matches another range in the real file" (it emits no hints toward proximity to the real file, such as differing only in trailing whitespace)

**What is not guaranteed**

- **Content format** rather than name (when configurations reside in a file with an allowed extension; e.g. `credentials.js`, `deployment.yaml.ts`, or JSON saved as `data.ts`)
- Hard links (cannot distinguish by extension when the same content has a different name)
- Secrets written as source code inside files with allowed extensions. The "second net" in the next subsection catches these as far as possible, but this is outside the guarantee

**Allowed extensions (final extension, lowercase) and selection policy**

| Category | Extensions |
|---|---|
| Source code | `ts` `tsx` `mts` `cts` `js` `jsx` `mjs` `cjs` `py` `pyi` `go` `rs` `java` `kt` `kts` `swift` `c` `h` `cc` `cpp` `cxx` `hpp` `hh` `cs` `rb` `php` `lua` `pl` `pm` `r` `scala` `dart` `ex` `exs` `erl` `hs` `ml` `clj` `groovy` `vue` `svelte` `astro` |
| Scripts | `sh` `bash` `zsh` `ps1` `psm1` `bat` `cmd` |
| Markup / documents / styles | `md` `mdx` `html` `htm` `css` `scss` `sass` `less` |
| Interface / schema languages | `proto` `graphql` `gql` |

- **Selection policy**: Allows formats designed for writing program or markup bodies, and **refuses formats for storing values and unknown extensions (default deny)**. Refused examples: `json` `jsonc` `json5` `yaml` `yml` `toml` `ini` `cfg` `conf` `config` `properties` `env` `xml` `plist` `sql` `txt` `log` `csv` `tsv` `lock` `ipynb` `tf` `tfvars` `hcl` `gradle` `svg` `pem` `key`, and extensionless files (`Makefile`, `Dockerfile`, `.bashrc`). `.txt` is refused because outputs and data get mixed in
- **Rationale**: Among 1,538 code blocks across existing reports in this repository (approximately 780 documents with `report_id`), those labeled with a language name are overwhelmingly source code, shell, and Markdown, with `json` and `yaml` accounting for 61 (approximately 4%). The allowlist does not hinder ordinary code citations
- Output when refused is `[Unallowable file type]`, showing the reason (extension) and guidance to write via `cite=`. When you want to present configuration files, **write the lines you wish to show as the body of `cite="path:start-end"` yourself**. Verification against the real file is performed, and real-file lines are not displayed in divergence diagnostics (G2). Do not write lines containing secrets
- There is no switch (environment variable or flag) to open exceptions

### Second net: halting by name, location, and value patterns (outside contract / best-effort capture)

Even files inside the allowlist (source code) might have passwords written directly in them. Therefore, across both `include=` and `cite=`, halting is also performed via the following two stages. This is a **heuristic based on name, location, and value patterns**, not a guarantee (G1/G2). When halted, it fails as `Suspected secret` (exit code 1), and documents using `include=` do not generate HTML.

- **Halting by path (without reading content)**: Inspects both the written path and the real target path (destination of symbolic links / junctions, resolved Windows short names and case-corrected actual names). Path syntax is also restricted: colons other than drive letters (Windows Alternate Data Streams `file:stream`), `?`, `*`, `<`, `>`, `|`, `"`, and trailing dots or spaces cause failure as "invalid specification" before reading (because Windows silently drops them and points to the same file). The following forms are halted without reading contents:
  - Folder names: files under `.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, `.docker`
  - Files directly under `.ccpit` (configuration, state). `settings.json`, `settings.local.json`, `.credentials.json`, `credentials.json` directly under `.claude`. `.claude.json`
  - File names: `.env`, `.env.*`, `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`, `.htpasswd`, `.dockercfg`, `credentials*`, `secret(s)*`, private key names like `id_rsa`, and extensions `.pem`, `.key`, `.p12`, `.pfx`, `.jks`, `.keystore`, `.kdbx`, `.tfstate`, `.tfvars`, `.ppk`, `.secret`
  - Exceptions: example template files (`.env.example`, `.sample`, `.template`, `.dist`), public keys (`id_rsa.pub`), ordinary files like `skills` under `.claude`, and files under `.ccpit/proposals` are exempt
- **Halting by content (omitting that line)**: Halts if lines within the cited range contain private key blocks (including OpenPGP `PRIVATE KEY BLOCK`), HTTP `Authorization: Basic …`, AWS access key IDs, GitHub / Slack / Google / `sk-` tokens, vendor-specific prefix tokens (Docker `dckr_pat_`, npm `npm_`, GitLab `glpat-`, PyPI `pypi-`, Hugging Face `hf_`, Stripe `sk_live_`, Anthropic `sk-ant-`, SendGrid, Twilio, etc.; halted by pattern regardless of key name), Base64-encoded PEM (`LS0tLS1CRUdJTi…`), JWT, Bearer tokens, credentials embedded in URLs (`scheme://user:password@host`), XML `<password>value</password>`, separated name/value attributes (`<add key="ApiKey" value="…" />`, `{"name": "client_secret", "value": "…"}`), connection strings (`Password=`, `AccountKey=`, `SharedAccessKey=`, etc., only when value looks like a key), quoted credential assignments (including Bash `$'…'`) (`password = "…"`, `"token": "…"`, etc., where value is ≥8 characters), environment-variable style assignments (`API_KEY=…`), unquoted YAML/TOML values (`api_key: …` with ≥16 characters containing digits, or ≥20 letters with mixed case even without digits), or values on the line immediately following a key-only line (inspects the preceding key line even if citing only the value line). Inline comments behind values (`# …`) are ignored during evaluation. **When a credential key (`password`, `token`, `api_key`, etc.) line ends in a form where values continue on subsequent lines, subsequent lines are halted as part of the block regardless of value pattern** (because multiline values cannot be evaluated line-by-line). Credential key names include `password`, `secret`, `token`, `api_key`, `access_key`, `private_key`, `tls.key`, `client.key`, `signing.key`, `encryption.key`, `auth.key`, and `credential`, regardless of `.`, `_`, or `-` delimiters (same for `api.key=…`). There are 5 continuation forms: ① empty value, or YAML `|`, `>` (including digit, `+`, `-` indicators), anchor (`&name`), or tag only → indented lines below (nested configurations under that key are also halted), ② line ends with `\` (`.properties`, shell) → subsequent lines as long as lines end with `\`, ③ unclosed TOML `"""` or `'''` on the same line → up to closing line, ④ heredoc `<<WORD` → up to line with `WORD` alone (delimiter may contain punctuation), ⑤ unclosed quotes (YAML multiline quoted strings, shell multiline assignments, `$'…'`, JavaScript template literals) → up to line containing the closing quote (halts the key line as well). When closing markers for ④⑤ and ③ are not found in the file, scanning is capped at 20 lines to avoid mistaking examples in comments or prose for an unbounded block. For JSON where key and value are on separate lines, value lines (evaluated after stripping quotes and trailing commas) are also halted. **Lines inside a private key block (from `BEGIN … PRIVATE KEY` to `END … PRIVATE KEY`, or to end of file if `END` is missing) are halted even for ranges that do not include the `BEGIN` line** (block boundaries are lines where the entire line is that marker alone). Diagnostics emit only path, detected pattern kind, and line numbers within the range; **line contents are never included in output or HTML**
- There is no switch (environment variable or flag) to open exceptions. False positives on ordinary code should be handled by narrowing the cited range to avoid lines with secret-like patterns. If you still need to present that file, describe that portion by hand in prose
- Files that do not exist at the time of inspection are not even attempted to be read (preventing reading an uninspected different file if a link of the same name is created after inspection). Existing files are opened via the inspected real path, read from **the opened file handle itself**, and verified after reading that "the same real path still points to the same file (same device and inode)". If the link destination is swapped between inspection and reading (including momentarily pointing to another file during the read and reverting afterwards), it fails as `UNVERIFIABLE` (real file changed during verification), and read content is discarded. `rev=` passes the inspected repository path directly to git blob read. The snapshot mechanism that reuses real-file reads within the same process also indexes directly on the inspected path without re-resolving
- **This second net is a heuristic inspecting name, location, and value patterns, and is outside the guarantee** (guarantees are G1/G2 above). Because variations in writing are endless, secrets not matching patterns cannot be halted. Confirmed unhalted examples: short plaintext passwords, lowercase unquoted values, non-standard Base64 values like Kubernetes Secret `.dockerconfigjson` where neither key name nor value pattern is generic, and continuation lines in flow style without indentation. Configuration files (YAML, TOML, JSON, INI, `.properties`, XML, `.config`, Kubernetes manifests, etc.) cannot be pulled via `include=` (allowlist). **Do not cite files known to contain secrets, even if they have an allowed extension**
- Limitations (continued): Detection relies on name, location, and value patterns. Secrets not matching patterns cannot be halted. Identifier-like values (ASCII letters under 20 characters like `token: nextTokenFromQueue`) are not halted, but mixed-case identifiers of 20 or more characters may occasionally be falsely halted (narrow the range). **Do not cite files known to contain secrets in the first place**

### Output of `--verify`

Documents with zero declarations emit nothing. Documents with declarations emit `[VERIFY CITE OK] N citations matched their real-file ranges` along with real file paths of each citation (including full commit hash for `rev=`) if all match. If even one does not match, it emits `[VERIFY CITE FAIL]` with reasons per citation, and **exit code 1**:

| Kind | Meaning |
|---|---|
| `Content mismatch` | The range exists but lines differ. Outputs the first differing line (citation / real file). Mentions if the difference is only in trailing whitespace |
| `Range shift` | All lines of the citation match **a different range** in the real file exactly. Appends the actual range (if lines were merely added, the range to rewrite is immediately obvious) |
| `Missing file` | The real file does not exist |
| `Range exceeds real file` | The specified lines exceed the line count of the real file. Appends real file line count |
| `Invalid specification` | Unparseable range, misused attribute, `rev` is not in commit format, etc. |
| `Unallowable file type` | An unallowlisted extension file was pulled with `include=` (file is not opened). Rewrite using `cite=` |
| `Suspected secret` | Path matches a file shape that may contain secrets, or cited lines match secret patterns (section above). Line contents are omitted |
| `UNVERIFIABLE Cannot verify` | Cannot read real file, not UTF-8, `rev` commit does not exist (ambiguous short hash), cannot execute git, `rev` attached to a file outside the repository, or relative path origin cannot be resolved. **Never treated as a pass** (distinguished from "missing file" or "content mismatch" via distinct tags) |

There is no way to bypass verification (flags or environment variables). `--verify-html` / `--verify-md` (for one-way debugging) continue to skip citation verification as before.

### Behavior of expansion-type `include=`

- HTML code block contents become the lines of the real file. Bar label defaults to `path:range` if `title="..."` is omitted. The copy button also copies the real-file lines
- Expanded lines are added to the corpus in `--verify` HTML⊆MD as "declared lines derived from real files" (MD⊆HTML evaluates coverage against post-expansion lines). Static text nodes do not increase
- Documents with `include=` that fail expansion (missing file, UNVERIFIABLE, etc.) do not generate HTML (`[RENDER FAIL]`, exit code 1, output destination is not modified). Never silently outputs HTML with missing body content
- Within the same process, the real file is read only once, and that identical read is used for rendering, verification, and `--check` hashing. Does not diverge even if the real file is rewritten during execution

### When the real file changes after writing a report

- **Without `rev=` (default) = verifies against the real file in the current working tree**. If code advances and diverges, `--verify` of past reports will also fail (because citations claim "the real file is currently like this"). If lines were merely added, `Range shift` outputs the new range, making rewriting mechanical
- **Citations with `rev="<commit>"` verify against that commit version**. They will not fail even if code advances subsequently = reports do not break from subsequent modifications. Attach `rev=` to citations that should be fixed in time (accepted reports, return records). It cannot be attached when pulling uncommitted real files, so commit first and then add `rev=`
- HTML for `include=` (without `rev=`) is "a copy of the working tree at the time of citation". Because the HTML embedded hash (`data-src-sha256`) is generated from **MD + expanded lines** at that time, when the real file changes, `--check` emits STALE (signal to re-render). Citations with `rev=` are pinned in time and do not change. Hashes for documents not using `include=` remain identical to before
- Scope of determinism: Same MD produces same HTML in documents using `include=` when given "the same MD **and the same real file**" (or when the same commit can be resolved if using `rev=`)

### Limitations

- **Undeclared citations are not inspected**. When citing code, establish an operational convention to write via `include=` or `cite=` (if not written, nothing is verified as before)
- Verification is limited to "whether lines in that range match". Whether the citation is correct as evidence for the explanation is for the reader to evaluate
- `cite=` cannot omit lines mid-citation (if omission is desired, split the range into two citations or use `include=`)

## Copy button on code blocks (all documents, default on)

Ordinary code blocks (fences) get a **top bar with a label and a "Copy" button**. Clicking the button once copies only the code contents to the clipboard, ready to paste directly into a terminal (readers must not retype commands by hand — transcription errors cause incidents; 2026-09-24 operator instruction).

- **Blocks that receive it**: Ordinary fences (including inside admonitions and blockquotes). **Does not attach to mermaid / svg figures**. Blocks not meant to be pasted (sample outputs, logs, ASCII diagrams, etc.) can suppress it by adding `nocopy` (or `no-copy`) to the info string. Example: ` ```text nocopy `
- **Label**: Taken from `title="..."` in the info string if present (example: ` ```bash title="Reboot" `), otherwise the language name; if neither is present, `code`. For steps meant for humans to execute, write what the command does in `title`.
- **Copied content**: The textContent of `<code>` inside `<pre>`. HTML escapes (`&amp;`, etc.) revert to their original characters, without mixing in button or label text. **All trailing newlines are stripped** (so the final line does not execute the instant it is pasted). In-line newlines, line continuation `\`, and tabs are preserved as-is. Does not become empty inside closed `<details>` or hidden tabs (does not use innerText, which depends on rendered visibility).
- **Write path**: Inside the click handler, synchronously attempts offscreen `textarea` + `execCommand('copy')` first; only if that fails, calls `navigator.clipboard.writeText` (secure context only) within the same handler. Because both are called within the user interaction's transient activation window, even in environments where the clipboard API is denied by permissions (unprivileged iframes, etc.), activation expiration does not occur from waiting for rejection before switching. After clicking, displays "Copied" (green) for ~1.6s; if both paths fail, displays "Copy failed: select manually" (red) without altering the clipboard. On Windows, browsers convert newlines to CRLF when placing them on the clipboard.
- **Screen readers**: In addition to visual feedback, announces the outcome in words to an offscreen `aria-live` region (`role="status"`) constructed by JS at runtime: "Copied", "Could not copy. Please select code and copy manually". Adds nothing to the static HTML.
- **Appearance**: Fixed to a terminal-like dark band regardless of theme (Day / Dark) (in Day theme, "things to paste" stand out immediately). Colors reside in `--cb-*` variables on the outer `.cb` wrapper without touching `:root`. Tabbing with the keyboard shows a focus outline on the button. Long lines scroll horizontally within the block only, without horizontally shifting the entire page. Suppressed when printing.
- **Relationship to determinism and verification**: Label is `data-label` → CSS `attr()`, button text is a CSS pseudo-element, accessible name is `aria-label`, and result speech text is populated by JS at runtime = **does not add static text nodes** (`--verify` HTML⊆MD / MD⊆HTML invariants hold unchanged). CSS and loader are injected **only into documents that output one or more copyable blocks**. Documents without copy targets (including documents containing only mermaid / svg / `nocopy` blocks) have zero diff in output. The `<pre>` element's `data-lang` attribute remains the entire lowercased info string as before.
- **Environments without JS**: Buttons remain hidden until JS readiness (`html.cb-ready`). Never shows a dead button that does nothing on click; label and code remain readable.
- **Zero external dependencies**: CSS and JS are embedded in the HTML (features do not disappear in display environments that cannot read external files, e.g. claude.ai Artifacts). Click events are handled via a single delegation on document, so they apply even to `.cb` elements added to the DOM dynamically later.

## Theme toggle (optional, `theme: toggle`)

Declaring `theme: toggle` in the frontmatter renders a Day/Dark toggle (radio) at the top of the body (**zero new MD syntax**). Default is **Day**. The selection is stored in `localStorage('mdr-theme')`, and an apply-before-paint script early in the head reflects it into `data-theme` before rendering (no flash).

- The CSS states **both** `:root[data-theme="day"]` and `:root[data-theme="dark"]` explicitly (it does not depend on the attribute-less `:root` styles). `data-theme="day"` is emitted statically on the html tag.
- The toggle radios carry `aria-label="Day"/"Dark"` (the a11y canonical source) plus visual labels via CSS pseudo-elements (inside `<style>` = excluded from `extractTextNodes`). **No static text node is generated** → determinism and `HTML⊆MD` are preserved.
- CSS/JS/attributes are injected only into documents that declare `theme: toggle`; non-declaring documents stay byte-identical (an unknown `theme` value is a lint warning).
- Switching Day/Dark does not change mermaid figures — they are drawn with the dark theme fixed at renderer initialization. As long as the figure's fill and text color are stated as a pair and their measured ratio meets the criterion, in-figure readability is unaffected by the theme toggle (writing the pair alone is not enough — see "Figure fill and text-color pairing").

## Hover preview (optional, `hover:` block)

Listing `- URL || summary text` entries in a `hover:` block in the frontmatter attaches `target="_blank" rel="noopener"` and a hover card to **matching http(s) links** in the body. The summaries are **baked in from the MD/frontmatter at generation time** (the renderer performs no network access).

- The summaries go into a `<script type="application/json" class="mdr-hover-data">` data island (escaping `<`, `>`, `&` and U+2028/2029 to prevent `</script>` breakout). `extractTextNodes` excludes `<script>` → `HTML⊆MD` preserved. Because the summaries come from frontmatter and are not a body piece, they are outside the `MD⊆HTML` check.
- The loader injects the card DOM via `textContent` on hover/focus/tap (no `innerHTML`, **no runtime fetch**). The body link remains and the summary is supplementary (never a substitute for the body).
- Attachment happens only inside the AND of three conditions: `hoverMode && /^https?:\/\//.test(url) && identifier match`. Link output for non-matching, relative, and mailto links, and in non-declaring documents, stays byte-identical (a malformed `hover:` line is a lint warning).

## Comments-resolved badge (optional, `comments_resolved:` block)

Listing `- heading || response note` (two-part) or `- heading || original comment || CC response note` (three-part) entries in a `comments_resolved:` block in the frontmatter displays a "✓ resolved" badge plus the response note in that heading's comment field. This is **a separate layer from the reviewer's localStorage comments** — it is the layer where the CC (the side that responded) bakes the resolution status into the HTML.

- **Three-part (original comment embedded, read-only)**: when declared in three parts, the reviewer's original comment is **embedded read-only** (no editing UI; an escaped data island for `< > & " '` and `</script>` plus `textContent` = not modifiable). Display order is [original comment, read-only] → [✓ resolved + response note] → [re-comment]. Original comments/notes whose heading does not match are not put into the data island (preventing information exposure).
- **Copy exclusion**: in resolvedMode the reply-prompt aggregation is swapped for `REPLY_GEN_RESOLVED`/`REPLY_GEN_ATOMIC_RESOLVED`, and **localStorage comments on resolved headings are excluded from the aggregation** (preventing redundant copying of past comments). Non-resolved documents use the existing loader byte-identically.
- **Re-comment field**: resolved headings get an editing Composer under a separate key `<id>:re` (included in the aggregated copy = new comments are picked up). The original base Composer is replaced by the read-only embed (finalized comments are not editable).
- **Marking resolved on the second round and beyond (2026-09-13)**: a comment written in the re-comment field (`<id>:re`) is marked resolved the same way, with a declaration whose key is suffixed with `:re` — `- heading:re || original comment || note` (for the n-th round, n−1 occurrences of `:re`). In three-part form, `<id>:re` becomes a read-only embed + ✓ + note, and a re-comment field for the next layer `<id>:re:re` appears. In two-part form the badge and note are appended to the end of that re-comment field. A `:re` layer is rendered only when the layer one level shallower is declared in three-part form (a lint warning otherwise). `<id>:re` also enters the exclusion set and drops out of the reply aggregation. Documents with no `:re` declaration stay byte-identical. **Do not merge it into the previous round's declaration** (the re-comment field would be left unprocessed and would ride along in the aggregation every time).

- `resolvedMode = commentsMode && fm.comments_resolved.length` (**the comment feature via report_id is a prerequisite**). CSS/JS/the data island are injected only when declared; non-declaring documents stay byte-identical.
- Heading matching is done via `sec-<sha1(canon(heading))[:8]>`. The "✓ resolved" badge is a CSS pseudo-element (inside `<style>` = excluded from `extractTextNodes`). The response note is injected from a `<script type="application/json" class="mdr-resolved-data">` data island via `textContent` (no `innerHTML`, no runtime fetch, `</script>` and special characters escaped).
- **Response notes with a non-matching or duplicate key are not put into the data island** (preventing exposure of information that would remain in the HTML source even when not displayed). Non-matching keys, malformed lines, and unmet prerequisites are lint warnings.
- **Headings usable as a key = headings that carry a Composer**: body H2 (plus H3 in atomic mode), and **also the H2 of the three Composer-bearing panels (`readers and purpose` / `summary of conclusions` / `out-of-scope proposals (Pending)`)** (fixed 2026-09-06. Previously only body H2 passed into the island, so a reply to `summary of conclusions` was silently dropped with no lint warning — caused by the divergence between lint matching against all headings and render matching against bodySecs. Reconciled by adding the three panels to `renderableIds`). The decisions-needed panel has no heading-derived id, so it cannot be used as a key.
- Use: review comment → CC responds → declare `comments_resolved` in the frontmatter → regenerate to display "✓ resolved". Prevents review round-trips from being dropped.

## Atomic comments (optional, `comments: atomic`)

Declaring `comments: atomic` emits, in addition to the summary Composer at the end of each H2, **a comment Composer directly under each H3 subsection** (a two-tier H2 + H3 arrangement). You can comment directly under a topic (e.g. §11.2), avoiding the cognitive load of reading a whole large section and scrolling to its end.

- `atomicComments = commentsMode && fm.comments === 'atomic'`. **`comments: on` / the default / `off` remain H2-only as before** = existing documents stay byte-identical (a `comments: on` document containing H3/H4 is byte-identical to live as well).
- The H3 Composer generates no text nodes (the same shape as the existing Composer) = determinism and `HTML⊆MD` preserved. The `comments_resolved` resolved badge can also be attached to an H3 heading in atomic mode (coexisting with the Composer in the same field = re-commentable).
- The reply-prompt aggregation picks up H3 comments with the correct H3 heading and body range. Identically named H3 headings collide on id, so a lint warning is raised for atomic documents (make headings unique).
- **Recommended**: make `comments: atomic` the default for reports and minutes with many review round-trips (per-topic commenting).

## Procedure checklists (optional, `checkboxes: on`)

For a procedure document that a person executes one step at a time, leaving results as they go: a step that went fine needs only a tick, which lowers the writing burden.

- Declare `checkboxes: on` (and, so that the comment field sits directly under each step, `comments: atomic`) in the frontmatter, cut one H3 per step (`### Step N: …`), and end each step with a check item: a list item whose text starts with `[ ] ` (not done) or `[x] ` (done), e.g. `- [ ] Step 1 OK (the expected line appeared)`.
- **Only documents that declare `checkboxes: on` are affected.** In a document without the declaration, `- [ ] text` stays literal text exactly as before (existing acceptance-criteria lists do not silently change on regeneration). A line that has only `- [ ]` and no text is never turned into a check item.
- In a declaring document the `[ ]` / `[x]` / `[X]` marker is removed from the body and rendered as `<input type="checkbox">` (the marker never becomes a text node, and `--verify` cuts pieces by the same rule, so both `HTML⊆MD` and `MD⊆HTML` pass). The initial state is the MD's `[x]`.
- A tick the reader makes is stored in the browser's **localStorage** under the key `ccpit-chk:<report_id>:<serial number>:<first 40 characters of the text>`; the HTML itself does not change. It persists when the same file is reopened in the same browser on the same PC. A document with no `report_id` / `doc_id` stores nothing (ticks last only for that view). The id is passed in a dedicated `data-task-id` attribute, so it is stored even with `comments: off`.
- Regenerating after editing the MD does **not** carry over the tick of an item whose serial number or first 40 characters changed (items whose wording is unchanged keep theirs).
- Done items are struck through and dimmed; a "checked n / total" progress line appears above the body (a pseudo-element = no static text added). CSS and the loader are injected only into a document that actually emitted a check item.
- **`--lint` warns when the trigger fails** (non-blocking, `exit 0`): a `checkboxes:` value other than `on` (`yes`, `true`, a typo) gives "unknown checkboxes value", and `on` with no valid item (`- [ ] text` / `- [x] text`) gives "no valid check item". In both cases `[ ]` stays as literal text, so read the `--lint` warnings after generating.
- The discipline for the contents of a procedure (one action per step, pass criteria, reply format) belongs to the skill that defines it; this section covers only the rendering part and the shape to write.

## CSP (hardening, recommended)

The renderer emits only fixed inline scripts (mermaid loader, tab apply-before-paint, tab loader, comment loader, reply generator, back-navigation loader, code-copy loader, clickable-figure loader (documents declaring `figure_links` only), figure-viewer loader (documents with at least one svg fence only), checkbox loader (documents declaring `checkboxes: on` that emit at least one check item only)) and SVG only as `data:` images. A compatible policy:

`default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'sha256-<hash-per-inline-script>'`

Generate the `sha256-…` hashes from the emitted inline scripts at build/publish time (they change if the loaders change). The renderer does not emit a CSP meta tag itself (a wrong hash would break the page) — apply CSP at the serving layer.

## Bundled files

| File | Description |
|---|---|
| `md2html.cjs` | Renderer (zero dependencies, single file) |
| `vendor/mermaid.min.js` | mermaid v10.9.1 (MIT License) |
| `vendor/LICENSE-mermaid.txt` | mermaid license attribution (incl. recorded sha256) |
| `tools/svg_figure.py` | Helper that turns a matplotlib figure into an svg fence carrying axis information (see "Figure viewer"; optional — only needed when graphs are embedded) |

## Modification guard

After editing `md2html.cjs`, always run `--selftest`; if the change is intentional, recompute and update the built-in GOLDEN sha values (leaving selftest FAIL unresolved is treated as corruption). For clickable figures (`figure_links`), in addition to the fixed sha, tests that verify the relationship from both sides (`selftestFigLink`: output treated as no declaration is identical to omitting the key; diff for valid declarations consists only of id / data island / dedicated CSS, JS, and chip; all `to` targets in the data island appear exactly once in output) are also included in `--selftest`. Tests verifying citation checking (`selftestCite`: using mocked I/O without touching disk or git, pinning match, content mismatch, range shift, missing file, range overflow, trailing whitespace, rev, UNVERIFIABLE, real-file snapshots, halting before reading potentially sensitive files, and omitting secrets from diagnostics) and required headings checking (`selftestHeadings`: confirming that sample headings inside code blocks, blockquotes, or mid-line do not satisfy requirements while genuine headings do) are similarly included in `--selftest`. The figure viewer (`selftestFigView`: injection only into documents with an svg fence, no state leaking across renders, reading axis information and converting coordinates) and the check boxes (`selftestTasks`: rendering, initial state, marker absent from text nodes, bidirectional verify, determinism, no injection into undeclared documents, and the `--lint` warnings for a wrong value or no check item) are included in `--selftest` too.