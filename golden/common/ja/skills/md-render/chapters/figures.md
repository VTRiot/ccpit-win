# 図の描画（mermaid / svg）

> この章を開く作業: 図（mermaid / svg）を書く時。オフライン表示が要る時。グラフ（matplotlib などの画像）を報告書に載せる時

## 図の描画

- mermaid フェンス → クライアント側描画。ローダは ①同ディレクトリ `./vendor/mermaid.min.js` ②pinned CDN ③原文表示 の三段フォールバック
- **オフライン表示が必要な場合**: 同梱の `vendor/` を HTML と同じディレクトリへコピーする（ローダは HTML 基準の相対パスで探す）
- svg フェンス → base64 data URI の img に変換（script 無害化・静的画像）

## 図のビューア（svg の図を押すと開く）

svg フェンスの図を 1 つでも出力した文書には、図のビューアが自動で入る（宣言は要らない。図の無い文書の出力は変わらない）。

- 本文の図を押す（または Tab で選んで Enter）と全画面で開く。ホイール・＋－ボタン・＋－キーで拡大縮小、ドラッグ・矢印キーで移動、ダブルクリックで 2 倍、0 キーで全体、Esc で閉じる。2 本指でつまんでも拡大縮小できる
- 十字カーソルが付く。図の SVG に軸の情報があれば、カーソルの位置の値を軸の単位で表示する（軸の外では値を出さない）
- 単一 HTML のまま動く。ビューアは HTML に埋め込まれ、図の data URI をその場で読む。外部ファイル・ネットワークを使わない
- 図の直前の段落を、図の名前として上の帯に出す（`図 N: …` の段落を図の直前に置く書き方と合う）

### グラフを載せるときの決まり

- **複数の段を持つ図は縦に並べる**（`plt.subplots(nrows, 1)`）。横に並べると本文の幅に縮んで読めず、ビューアで拡大しても 1 段ずつが小さい。縦に並べた各段に軸の名前と目盛りの数字を付ける（`sharex=True` でも `ax.tick_params(labelbottom=True)`）
- 画像（PNG）は Markdown の画像記法では描かれない。PNG を `<image>` に入れた SVG を svg フェンスに置く。同梱の `tools/svg_figure.py` がこれを作る
- 値を読ませたいグラフは、軸の情報を SVG に入れる。matplotlib なら `tools/svg_figure.py` の `save_png_with_axes(fig, "fig1.png", dpi=110)` で保存すると、PNG と軸の情報（`fig1.png.axes.json`）ができる。報告書の雛形の行 `<<PNG fig1.png>>` を `python tools/svg_figure.py <雛形.md.tpl> <出力.md>` で svg フェンスに置き換えると、軸の情報も入る
- `savefig` に `bbox_inches="tight"` を使わない（余白を切ると軸の位置がずれ、読む値が狂う）。`save_png_with_axes` はこの引数を受け付けない

### 軸の情報の形

SVG の中に `<metadata data-mdr="axes">` を置き、中身を次の JSON にする。（例の `xlabel` は「踏み量 [%]」を ASCII で書いたもの）座標は SVG の viewBox の単位（PNG なら画素）で、y は下向き。

```json
{"version": 1, "axes": [{"bbox": [74, 40, 1071, 340], "xlim": [0, 100], "ylim": [0, 230],
  "xscale": "linear", "yscale": "linear", "xlabel": "\u8e0f\u307f\u91cf [%]", "ylabel": "MAP [kPa]", "title": "4000 rpm"}]}
```

- `bbox` は軸の枠の [左, 上, 右, 下]。`xlim` は枠の左端と右端の値、`ylim` は下端と上端の値（逆向きの軸はそのまま逆に書く）
- 目盛りは `linear` か `log`（`log` は範囲が正のときだけ）。形が合わない軸は捨てられる（カーソルは出るが値は出ない）
- ビューアが見るのは `axes` の先頭 64 要素まで、JSON は 20 万字まで（壊れた図でページが固まらないため）。超えた分・超えた図の軸の情報は読まない
- XML の中に置くので、JSON は ASCII だけで書く（ASCII 以外の文字と `<` `>` `&` は `\uXXXX` のエスケープにする。`tools/svg_figure.py` がそうする）。文字数の上限はブラウザの数え方（UTF-16）で効くので、ASCII だけにしておくと作る側と同じに数えられる
- 軸の情報はビューアの読み取りにだけ使う。図の見た目と `--verify` には影響しない
