---
name: md-render
description: 報告書 MD から決定論 HTML を生成・検証する際に発火する。md2html.cjs（同梱）で render / verify / lint / selftest / check を実行する
---

# md-render（決定論 MD→HTML レンダラ）

正本は MD、HTML は派生（HTML ⊆ MD）。レンダラは壁時計・乱数・環境を入力にせず、同一 MD から byte 一致の HTML を生成する（決定論）。

## 作業別の道案内（先に読む）

詳しい規則は本ファイルと同じフォルダの `chapters/` にある。**次の作業に入る前に、該当する章を開いて読む**。本体を読んだだけで済ませない。

| いまの作業 | 先に開く章 |
|---|---|
| 表を書く。数の列がある。セルの中に縦棒を書く | `chapters/tables.md` |
| 成果物（CSV など、オーナーが使うファイル）の置き場所を報告書に載せる | `chapters/outputs.md` |
| 図（mermaid / svg）を書く。オフラインで図を見せる。グラフを載せる（縦に並べる・押すと開くビューアで値を読ませる） | `chapters/figures.md` |
| 図に色（`fill`）を付ける。配色を明示した MD を HTML にする | `chapters/figure-colors.md`（検査スクリプトの本文は `chapters/figure-colors-script.md`） |
| 図のノードを押して詳細へ飛べるようにする（押せる図・`figure_links:`） | `chapters/clickable-figures.md` |
| コマンドやコードをコピーさせるブロックを書く（コピーボタン・`nocopy`・`title`） | `chapters/code-blocks.md` |
| ファイルのコード片を報告書に引用する（`cite=` / `include=` / `rev=`） | `chapters/code-quotes.md` |
| レビューコメントに応える（コメント機能 & 返信プロンプト・対応済みバッジ・Atomic）。見出しを付ける（セクションアンカー） | `chapters/review-comments.md` |
| 人が 1 手ずつ実行して結果を残す手順書を書く（手ごとのコメント欄・チェック欄 `checkboxes: on`） | `chapters/review-comments.md`（「手順書のチェック欄」） |
| タブ・テーマ・ホバー・戻りナビを使う（インタラクティブ・タブ） | `chapters/opt-in-display.md` |
| 生成した HTML を配る。CSP を付ける | `chapters/delivery.md` |
| `md2html.cjs` を編集する（改変ガード） | `chapters/maintaining.md` |

## 発火条件
- 報告書 MD から HTML を生成する時
- **HTML ファイルを新規作成すると決めた時（報告書に限らない）**
- `--verify` / `--lint` / `--check` を実行する時（report skill のレンダラ手順から参照される）
- 図に配色を明示した MD を HTML 化する時（塗りと文字色の対を検査する）
- 図（mermaid の flowchart / graph）のノードを押して、詳細の書いてある場所へ飛べるようにする時（「押せる図」節）
- 報告書にコード片を引用する時（手で写さず `include=` で引くか、`cite=` で実物と照合する。「コード引用の実物照合」節）

- 表を書く時（セル内の `|`・数の列。「表を書く」の章）
- 報告書に成果物（CSV など）の置き場所を載せる時（「成果物の欄」の章）

## 出力要件（強制・2026-07-17 運用者指示）

HTML を作ると決めた時点で、**ブラウザでダブルクリックだけで読める完結形**を同ターンで出す。「MD だけ置いて HTML は後で」を禁止する。

1. `<!DOCTYPE html>` + `<meta charset="utf-8">`（日本語文書で欠けたら読めない）
2. スタンドアロン: CSS/JS は埋め込み。外部 URL・別ファイル相対参照に依存しない（mermaid の三段フォールバックは許容）
3. MD 原稿があるなら本レンダラで生成し `--verify` を通す。**`--verify` は第 1 引数**（`<in.md>` の後ろに置くと out.html と解釈され `--verify` という名のファイルに HTML が書かれる既知の罠 — 2026-07-17 実発生）
4. 完了報告の前に生成物の先頭を読み戻して 1–2 を機械確認し、報告には**拡張子付きフルパス＋ file:/// URL**（ブラウザのアドレスバーに貼るだけで開く形。CLI 環境はダブルクリック不可 — 2026-07-18 運用者指摘）を明記する
5. head に no-cache メタ 3 点（`Cache-Control: no-cache, no-store, must-revalidate` / `Pragma: no-cache` / `Expires: 0`）を常時注入する（2026-08-30 運用者指示: 再レンダ後に旧キャッシュが表示される陳腐化対策。静的固定文字列のみ＝決定論維持。**HTTP 配信時はサーバヘッダが meta より優先される**ため、配信層でのキャッシュ制御も別途必要 — meta が確実に効くのは file:// 直開き・単純静的サーバ・webview 系）

## 使い方（同梱 md2html.cjs、Node 組込モジュールのみで動作）

```bash
R=~/.claude/skills/md-render/md2html.cjs

node "$R" <報告書.md> <報告書.html>   # 生成（固定 7 ブロック・ダークテーマ）※ 出力先必須
node "$R" <報告書.md> -               # 画面出力（標準出力へ流す。パイプ用途。'-' 明示必須）
node "$R" <報告書.md> --stdout        # 画面出力（'--stdout' オプション形式）
node "$R" --verify <報告書.md>        # 双方向検証: HTML⊆MD（捏造ゼロ）+ MD⊆HTML（欠落ゼロ）+ コード引用の実物照合（cite=/include= を書いた文書のみ）
node "$R" --lint <報告書.md>          # figures 宣言-実体一致（双方向）+ 必須マーカー検査（必須見出しは本物の見出しだけで判定）+ 表の列数の食い違い + 成果物の宣言（outputs:）。exit 1 = block
node "$R" --selftest                  # 内蔵 golden ケースの sha256 照合（破損検出）
node "$R" --check <in.md> <out.html>  # HTML 埋込 sha256 と現 MD の鮮度照合（_index 用）
```

- **出力先の指定は必須**（省略時は変換を実行せず、既存ファイルを変更せず、`exit 2` でエラー停止する。書き忘れによる「静かな不更新・旧HTML残置」を防止）
- **画面出力（標準出力）用途は `-` または `--stdout` を明示する**。ファイル出力（`<out.html>`）と画面出力の同時指定や、`--stdout` の重複指定は矛盾エラー（`exit 2`）として拒否される
- **旧契約からの移行**: 画面出力やパイプ（`| grep` 等）を用途として出力先を省略していた呼び出しは、出力先に `-` または `--stdout` を明示する形へ更新する
- **生成の成否は `--check <in.md> <out.html>` の終了値で判定する**（exit 0 ＝ HTML 埋込 sha256 と現 MD が一致＝鮮度 OK）。**stderr のログ文字列を成功判定の契約にしない**

> **事故記録と根本防止（2026-09-09 実発生 → 2026-09-10 改定 CCPIT_062）**:
> 出力先を省略したまま `2>&1 | tail -5` で実行し、「HTML が画面に流れた・exit 0」で成功と誤認。実際は MD 更新済みなのに旧 HTML が残置されていた（`ls` のタイムスタンプ照合で検知）。
> 当初 stderr 警告（`[RENDER_STDOUT]`）を追加したが、警告は HTML より先に出るため `2>&1 | tail` 等では画面に残らず、事故防止にはならなかった。
> そこで CCPIT_062 により CLI 契約を変更し、**出力先省略はエラー（exit 2）として即時停止し、変換結果を出力しない**契約へ強化した。画面出力は `-` または `--stdout` の明示指定でのみ受理される。
>
> 保証範囲: レンダラ自身が書き忘れをエラーとして停止し旧ファイルの残置・上書きを防ぐこと。呼び出し側のシェルがレンダラの終了コードを伝播しない実行形（pipefail なし等）の防止は本レンダラの責務外であり、`--check` の終了値判定規約が担う。
- 対応構文は 8 種に閉じる（report skill「使用構文」参照）。未対応構文はリテラル表示に退化し内容は失われない。例外として frontmatter `checkboxes: on` を宣言した文書だけ、リスト項目の先頭 `[ ] ` / `[x] ` をチェック欄として描く（「手順書のチェック欄」の章。`checkboxes:` の値の誤記や該当項目なしは `--lint` が警告する）
- `--lint` は改定後の新規報告書にのみ実行する（grandfather 移行措置 — report skill 参照）。未決の判断事項が無い報告書は frontmatter `decisions: none` ＋ `decisions_reason: <理由>` で警告を免除できる（実体 `[!DECISION]` との共存は矛盾警告）
- **必須見出しは「本物の見出し」だけで数える**: `--lint` の必須見出し（`本報告書の読者と目的`・`結論の概要`・`現在地`・`スコープ外提案（Pending）`）と、報告書型かどうかの判定は、レンダラが見出しとして読んだ行（行頭の `#` が 1〜4 個＋空白で始まる行）だけを見る。コードブロックの中・引用（`>`）の中・行の途中・`##` の後ろに空白が無い行・`#` が 5 個以上の行に書いた見本の見出しでは満たされない。判定するレベルは従来どおり（`結論の概要` は H2 のみ、ほかは H2〜H4）。`スコープ外提案（Pending）` は従来「その語が本文のどこかにあれば合格」だったが、見出しに語があることを求める（`ペンディング` も語として数える。タブ化・節の分類と同じ語）
- レンダラ不在環境では HTML 生成を省略してよい（正本 MD のみで報告義務は完結する fail-soft）

## 検査を回す順番

1. 生成: `node "$R" <報告書.md> <報告書.html>`（出力先は必須）
2. `node "$R" --verify <報告書.md>` を通す（HTML⊆MD と MD⊆HTML の両方向）
3. `node "$R" --lint <報告書.md>` で警告・エラーを読む（exit 1 は block）
4. `node "$R" --check <報告書.md> <報告書.html>` の終了値で鮮度を確かめる
5. 報告には拡張子付きフルパスと file:/// URL を書く（出力要件 4）

報告書の frontmatter の `figures:` は必須: 図が無ければ `figures: none` と `figures_reason: <理由>`、図があれば図種を `figures: [flow]` のように宣言する。無いと `--lint` が error（exit 1）になり、`--verify` も失敗する。

## 同梱物

| ファイル | 説明 |
|---|---|
| `md2html.cjs` | レンダラ本体（依存ゼロ・単一ファイル） |
| `vendor/mermaid.min.js` | mermaid v10.9.1（MIT License） |
| `vendor/LICENSE-mermaid.txt` | mermaid のライセンス表記（sha256 記録込み） |
| `tools/svg_figure.py` | matplotlib の図を軸の情報つきの svg フェンスにする道具（`chapters/figures.md`） |


## 章を開き忘れていないか

冒頭の道案内の表のどれかに当たる作業なのに、該当の章をまだ開いていなければ、いま開く。
