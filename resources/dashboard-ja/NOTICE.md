# dashboard-ja — third-party notices and provenance

This directory contains the Japanese-overlay wrapper for the pxpipe dashboard, bundled with CCPIT.

## What runs here

`serve-ja.mjs` is a transparent HTTP proxy. It forwards every request (all methods, including POST)
from its own port to the upstream pxpipe dashboard, and injects a translation overlay into full-page
HTML responses only. The upstream proxy is **not modified and not bundled** — CCPIT fetches it at
runtime with `npx`.

The three runtime files must stay in the same directory: `serve-ja.mjs` resolves `i18n-overlay.js`
and `dict.ja.json` relative to its own location.

## Network behaviour

**By default this bundle makes no outbound network connections.** It only proxies to the pxpipe
dashboard on loopback.

The overlay can annotate the "estimated saved" figure with a yen equivalent, which requires an
exchange-rate lookup against a third-party service (`api.frankfurter.dev`). That lookup is
**opt-in and off by default**: `serve-ja.mjs` reads `PXPIPE_JA_YEN_RATE` (default off) and injects
the resulting flag as `window.__PXPIPE_JA_OPTS`; the overlay only performs the request when the flag
is on. In CCPIT the switch is `pxpipe.jaDashboard.yenRate` in the app config (default `false`).

Only the exchange rate is requested — no usage figures, token counts, or costs are ever sent.

This opt-in gate is the one intentional difference between this bundled copy and the standalone
version of the wrapper: the standalone one performs the lookup whenever the overlay is in Japanese
mode. The gate was added because shipping the wrapper inside an installer changes the blast radius
from one developer machine to every user who installs the app, and a distributed product should not
contact a third party unless its user asked for it.

## Attribution

| File | Origin | License |
|---|---|---|
| `serve-ja.mjs` | Original work, part of CCPIT. Uses only the Node.js standard library; contains no upstream code. | MIT (same as CCPIT) |
| `i18n-overlay.js` | Original work, part of CCPIT. Contains no upstream code. | MIT (same as CCPIT) |
| `dict.ja.json` | Translation dictionary. **Its keys are verbatim copies of English UI strings from the upstream project**; the values are original Japanese translations. | Keys derive from `pxpipe-proxy` (MIT) — see `LICENSE.pxpipe-proxy.txt` |

`LICENSE.pxpipe-proxy.txt` reproduces the full MIT license text and copyright notice of the upstream
project, as required by that license, because `dict.ja.json` embeds upstream strings verbatim.

Upstream project: `pxpipe-proxy` — https://github.com/teamchong/pxpipe

## Version coupling

`dict.ja.json` carries the upstream version it was written against in its `_meta.target` field.
CCPIT pins the upstream package version it launches. **These two must agree**: a unit test asserts
that `_meta.target` contains the pinned package specifier, so raising the pin fails the build until
the dictionary is reviewed against the new upstream UI strings.

A dictionary miss is fail-open: an untranslated string is simply shown in English. A stale dictionary
therefore degrades the translation, it does not break the dashboard.

## Updating these files

1. Replace the three runtime files with the new versions (byte-for-byte).
2. Update `_meta.target` in `dict.ja.json` if the upstream target version changed, and update the
   pinned package specifier in the app source to match.
3. Refresh the expected SHA-256 values in `src/main/services/__tests__/pxpipeJaDashboard.test.ts`.
   The test prints the actual hashes when it fails, so the failure output tells you what to paste.

The hashes exist so that an accidental rewrite (a formatter, an editor, a partial copy) cannot change
what ships without someone noticing. Updating them should always be a deliberate act.

---

## 日本語

このフォルダは、pxpipe ダッシュボードに日本語表示を重ねるラッパーです。CCPIT に同梱されています。

`serve-ja.mjs` は透過プロキシで、上流 pxpipe ダッシュボードへ全メソッドをそのまま中継し、
フルページ HTML にだけ翻訳オーバーレイを注入します。**上流本体は改変も同梱もしていません**
（実行時に `npx` で取得します）。3 ファイルは同じフォルダに置いてください
（`serve-ja.mjs` が自分の隣から他の 2 つを読みます）。

`serve-ja.mjs` と `i18n-overlay.js` は CCPIT のオリジナル（上流コードを含まない・MIT）。
`dict.ja.json` は**キーが上流の英語 UI 文字列の逐語コピー**なので、上流の MIT ライセンス全文と
著作権表示を `LICENSE.pxpipe-proxy.txt` として同梱しています。

辞書が上流の版とずれた場合、未知のキーは英語のまま表示されます（fail-open）。
表示が古くなるだけで、ダッシュボードが壊れることはありません。
