---
name: md-render
description: Fires when generating or verifying deterministic HTML from report MDs. Runs render / verify / lint / selftest / check via the bundled md2html.cjs
---

# md-render (deterministic MD→HTML renderer)

The MD is canonical; HTML is derived (HTML ⊆ MD). The renderer takes no wall clock, randomness, or environment as input and produces byte-identical HTML from the same MD (determinism).

## Trigger
- When generating HTML from a report MD
- When running `--verify` / `--lint` / `--check` (referenced from the report skill's renderer procedure)

## Usage (bundled md2html.cjs; Node built-in modules only)

```bash
R=~/.claude/skills/md-render/md2html.cjs

node "$R" <report.md> <report.html>   # render (fixed 7 blocks, dark theme)
node "$R" --verify <report.md>        # bidirectional: HTML⊆MD (zero fabrication) + MD⊆HTML (zero omission)
node "$R" --lint <report.md>          # figures declaration-reality (bidirectional) + required markers. exit 1 = block
node "$R" --selftest                  # sha256 check of built-in golden cases (corruption detection)
node "$R" --check <in.md> <out.html>  # freshness check of embedded sha256 vs current MD (for _index)
```

- Allowed syntax is a closed set of 8 (see the report skill's "Allowed Syntax"). Unsupported syntax degrades to literal display; no content is lost
- Run `--lint` only on reports newly written after the revision (grandfather migration — see the report skill)
- In environments without the renderer, HTML generation may be skipped (the canonical MD alone fulfills reporting obligations — fail-soft)

## Figure rendering

- mermaid fences → client-side rendering. Loader falls back in 3 stages: ① `./vendor/mermaid.min.js` next to the HTML ② pinned CDN ③ raw text
- **For offline viewing**: copy the bundled `vendor/` next to the HTML (the loader resolves relative to the HTML document)
- svg fences → converted to base64 data-URI img (scripts neutralized, static image)
- Numeric table columns → proportional bars + value gradient applied automatically (meaning-neutral; see diagram-craft palette)

## Interactive tabs (optional)

Declare `tabs: by-h2` in the report frontmatter to render the top-level body H2 sections as a tab UI (deterministic extension — no new MD syntax). Tab labels are the H2 heading text (MD-derived); the audience / decisions / TOC / pending panels and the lead stay outside the tabs.

- **Progressive enhancement (fail-soft)**: with JS disabled, all panels render stacked and every section is readable. A fixed inline script adds `html.js` before paint, switching to tab view only when JS runs. The tab loader reads only `data-*` attributes and toggles `classList` / `aria-selected` (no `innerHTML`, no MD-derived strings injected into the DOM) — determinism and `HTML⊆MD` are preserved (hidden panels remain in the static HTML and are covered by `--verify`).
- Needs ≥2 tabbable H2 sections (`--lint` warns otherwise). Unknown `tabs` values are ignored with a lint warning.
- The tab CSS/JS is injected only for `tabs: by-h2` reports; non-tab reports stay byte-identical.
- Known limitation: anchor links (TOC / decisions panel) into an element inside an inactive tab do not auto-reveal that tab (fidelity is intact — the text is present in the HTML).

## Section anchors (sha1, all reports)

Heading ids are `sec-<sha1(normalized-heading)[:8]>` (position-independent, heading-dependent). Re-rendering keeps the id stable as long as the heading text is unchanged — so anchored comments never get lost. TOC / decision links derive from the same id, so they stay consistent automatically. Identical-text H2 headings share one id (`--lint` warns); make headings unique to avoid comment merging.

## Comments & reply-prompt (reports, default on)

Reports (detected via `isReport`: frontmatter `doc_id`/`report_id`/`audience`/`status` or a "読者と目的" section) **with a stable id (`report_id` or `doc_id`)** get a per-topic comment Composer under each body H2, plus a reply-prompt generator. Suppress with `comments: off`.

- **localStorage only** (key `ccpit-cmt:<reportId>:<sectionId>`); comments are never written into the HTML body → determinism (`同一MD→byte一致`) and `HTML⊆MD`/`MD⊆HTML` are preserved (the Composer is empty containers + CSS/aria labels + empty textarea → zero static text nodes; verified by an on/off `extractTextNodes` equality test).
- **reportId is MD-derived only** (`report_id`/`doc_id`); no filename fallback (a filename is MD-external and would break byte-identity). No id → comments disabled.
- **Reply prompt** = fixed-format aggregation (LLM-free) of all comments → `navigator.clipboard.writeText` one-click copy (falls back to `execCommand('copy')` + select on non-secure contexts like `file://`). Reply-body generation (by a reviewing agent / CC) is out of this renderer's scope (layer separation).
- Injected only for comment reports; non-comment docs stay byte-identical.

## CSP (hardening, recommended)

The renderer emits only fixed inline scripts (mermaid loader, tab apply-before-paint, tab loader, comment loader, reply generator) and SVG only as `data:` images. A compatible policy:

`default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'sha256-<hash-per-inline-script>'`

Generate the `sha256-…` hashes from the emitted inline scripts at build/publish time (they change if the loaders change). The renderer does not emit a CSP meta tag itself (a wrong hash would break the page) — apply CSP at the serving layer.

## Bundled files

| File | Description |
|---|---|
| `md2html.cjs` | Renderer (zero dependencies, single file) |
| `vendor/mermaid.min.js` | mermaid v10.9.1 (MIT License) |
| `vendor/LICENSE-mermaid.txt` | mermaid license attribution (incl. recorded sha256) |

## Modification guard

After editing `md2html.cjs`, always run `--selftest`; if the change is intentional, recompute and update the built-in GOLDEN sha values (leaving selftest FAIL unresolved is treated as corruption).
