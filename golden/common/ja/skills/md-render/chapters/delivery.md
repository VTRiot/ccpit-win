# HTML を配る（CSP）

> この章を開く作業: 生成した HTML を配信・共有する時。CSP を付ける時

## CSP（ハードニング・推奨）

レンダラが出力するのは固定インライン script（mermaid ローダ・タブ apply-before-paint・タブローダ・コメントローダ・返信生成・戻りナビローダ・コードコピーローダ・押せる図のローダ（`figure_links` を宣言した文書のみ））のみ、SVG は `data:` 画像のみ。整合するポリシー:

`default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'sha256-<各インライン script のハッシュ>'`

`sha256-…` は出力された各インライン script からビルド/公開時に生成する（ローダ変更で値が変わる）。レンダラ自身は CSP meta を出力しない（ハッシュ誤りでページが壊れるため）— CSP は配信層で適用する。
