# 表示の宣言（タブ・テーマ・ホバー・戻りナビ）

> この章を開く作業: frontmatter にタブ・テーマ・ホバーを宣言する時。戻りナビの挙動を知りたい時

## インタラクティブ・タブ（任意）

報告書 frontmatter に `tabs: by-h2` を宣言すると、本文のトップレベル H2 セクション群をタブ UI で描画する（決定論レンダラ拡張・**新 MD 構文ゼロ**）。タブラベルは H2 見出しテキスト（MD 由来）。読者と目的 / 要判断一覧 / TOC / Pending パネルと lead はタブの外に残る。

- **プログレッシブエンハンスメント（fail-soft）**: JS 無効時は全パネルが縦に並び全節が読める。head の固定インライン script が描画前に `html.js` を付与し、JS 実行時のみタブ表示へ切替。タブローダは `data-*` のみ読み `classList` / `aria-selected` を操作（`innerHTML` 不使用・MD 由来文字列を DOM 注入しない）— 決定論と `HTML⊆MD` を維持（非表示パネルも静的 HTML に残り `--verify` が被覆）。
- タブ化対象の H2 が 2 件以上必要（不足なら `--lint` が警告）。未知の `tabs` 値は無視し lint 警告。
- タブ CSS/JS は `tabs: by-h2` 報告書にのみ注入。非タブ報告書は byte 不変。
- 既知の制約: アンカー（TOC / 要判断一覧）から非アクティブタブ内要素への遷移はタブを自動展開しない（忠実性は無傷 — テキストは HTML に存在）。


## 戻りナビ（報告書・既定 on）

報告書（`isReport` 判定）には**ページ内アンカー遷移の「↩ 戻る」チップ**（右下固定）を毎回注入する（2026-09-01 運用者指示）。目次・本文のアンカークリック時に scrollY をスタック（上限 50）へ積み、チップクリックで元の位置へ復帰する。

- 復帰時は `history.replaceState` で hash を除去（同一アンカーを再クリックしても再遷移できる）。スタックが空になるとチップは非表示に戻る。
- ラベルは CSS `::before` content（**静的テキストノード非生成**）、ボタンは `aria-label` のみ ＝ 決定論・`HTML⊆MD` 維持（ローダ `<script>` は `extractTextNodes` 除外）。
- `isReport` 文書にのみ注入。非報告書は byte 不変。`report_id` 不要（コメント機能と独立）。
- 非表示ターゲット（非アクティブタブ内など）へのクリックと `preventDefault` 済みクリックは積まない（bubble phase + `offsetParent` ガード）。`@media print` でチップは印刷に出さない。タブの自動展開はしない（タブ機能の既知の制約に従う — 2026-09-01 Codex レビュー反映）。


## テーマ切替（任意・`theme: toggle`）

frontmatter に `theme: toggle` を宣言すると Day/Dark トグル（ラジオ）を本文先頭に描画する（**新 MD 構文ゼロ**）。既定 **Day**。選択は `localStorage('mdr-theme')` に保存し、head 早期の apply-before-paint script が描画前に `data-theme` を反映（無フラッシュ）。

- CSS は `:root[data-theme="day"]` / `:root[data-theme="dark"]` を**両方明示**（無属性 `:root` のスタイルに依存しない）。html タグに `data-theme="day"` を静的出力。
- トグルのラジオは `aria-label="Day"/"Dark"`（a11y 正本）＋ CSS 擬似要素の視覚ラベル（`<style>` 内＝`extractTextNodes` 除外）。**静的テキストノードを生成しない** → 決定論・`HTML⊆MD` を維持。
- `theme: toggle` 宣言文書にのみ CSS/JS/属性を注入。非宣言文書は byte 不変（未知 `theme` 値は lint 警告）。
- Day/Dark を切り替えても mermaid 図はレンダラ初期化時の dark テーマで描かれる。図の塗りと文字色を対で明示し、その比を実測して基準を満たしていれば、図内の可読性はテーマ切替の影響を受けない（対を書いただけでは足りない — 「図の塗りと文字色の対」節）。


## ホバープレビュー（任意・`hover:` ブロック）

frontmatter に `hover:` ブロックで `- URL || 要約文` を列挙すると、本文中の**一致する http(s) リンク**に `target="_blank" rel="noopener"` とホバーカードを付与する。要約は **生成時に MD/frontmatter から焼き込む**（レンダラは通信しない）。

- 要約は `<script type="application/json" class="mdr-hover-data">` データ島へ（`<` `>` `&` と U+2028/2029 をエスケープし `</script>` breakout 防止）。`extractTextNodes` が `<script>` 除外 → `HTML⊆MD` 維持。要約は frontmatter 由来で body piece でないため `MD⊆HTML` 検査対象外。
- ローダは hover/focus/tap でカード DOM を `textContent` 投入（`innerHTML` 不使用・**実行時 fetch なし**）。本文リンクは残し要約は補助（本文の代替にしない）。
- 付与は `hoverMode && /^https?:\/\//.test(url) && 識別子一致` の三条件 AND 内のみ。非一致・相対・mailto・非宣言文書のリンク出力は byte 不変（壊れた `hover:` 行は lint 警告）。
