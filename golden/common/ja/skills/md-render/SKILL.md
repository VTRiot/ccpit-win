---
name: md-render
description: 報告書 MD から決定論 HTML を生成・検証する際に発火する。md2html.cjs（同梱）で render / verify / lint / selftest / check を実行する
---

# md-render（決定論 MD→HTML レンダラ）

正本は MD、HTML は派生（HTML ⊆ MD）。レンダラは壁時計・乱数・環境を入力にせず、同一 MD から byte 一致の HTML を生成する（決定論）。

## 発火条件
- 報告書 MD から HTML を生成する時
- `--verify` / `--lint` / `--check` を実行する時（report skill のレンダラ手順から参照される）

## 使い方（同梱 md2html.cjs、Node 組込モジュールのみで動作）

```bash
R=~/.claude/skills/md-render/md2html.cjs

node "$R" <報告書.md> <報告書.html>   # 生成（固定 7 ブロック・ダークテーマ）
node "$R" --verify <報告書.md>        # 双方向検証: HTML⊆MD（捏造ゼロ）+ MD⊆HTML（欠落ゼロ）
node "$R" --lint <報告書.md>          # figures 宣言-実体一致（双方向）+ 必須マーカー検査。exit 1 = block
node "$R" --selftest                  # 内蔵 golden ケースの sha256 照合（破損検出）
node "$R" --check <in.md> <out.html>  # HTML 埋込 sha256 と現 MD の鮮度照合（_index 用）
```

- 対応構文は 8 種に閉じる（report skill「使用構文」参照）。未対応構文はリテラル表示に退化し内容は失われない
- `--lint` は改定後の新規報告書にのみ実行する（grandfather 移行措置 — report skill 参照）
- レンダラ不在環境では HTML 生成を省略してよい（正本 MD のみで報告義務は完結する fail-soft）

## 図の描画

- mermaid フェンス → クライアント側描画。ローダは ①同ディレクトリ `./vendor/mermaid.min.js` ②pinned CDN ③原文表示 の三段フォールバック
- **オフライン表示が必要な場合**: 同梱の `vendor/` を HTML と同じディレクトリへコピーする（ローダは HTML 基準の相対パスで探す）
- svg フェンス → base64 data URI の img に変換（script 無害化・静的画像）
- 表の数値列 → 比例バー + 値依存グラデ自動付与（意味中立。diagram-craft palette 参照）

## インタラクティブ・タブ（任意）

報告書 frontmatter に `tabs: by-h2` を宣言すると、本文のトップレベル H2 セクション群をタブ UI で描画する（決定論レンダラ拡張・**新 MD 構文ゼロ**）。タブラベルは H2 見出しテキスト（MD 由来）。読者と目的 / 要判断一覧 / TOC / Pending パネルと lead はタブの外に残る。

- **プログレッシブエンハンスメント（fail-soft）**: JS 無効時は全パネルが縦に並び全節が読める。head の固定インライン script が描画前に `html.js` を付与し、JS 実行時のみタブ表示へ切替。タブローダは `data-*` のみ読み `classList` / `aria-selected` を操作（`innerHTML` 不使用・MD 由来文字列を DOM 注入しない）— 決定論と `HTML⊆MD` を維持（非表示パネルも静的 HTML に残り `--verify` が被覆）。
- タブ化対象の H2 が 2 件以上必要（不足なら `--lint` が警告）。未知の `tabs` 値は無視し lint 警告。
- タブ CSS/JS は `tabs: by-h2` 報告書にのみ注入。非タブ報告書は byte 不変。
- 既知の制約: アンカー（TOC / 要判断一覧）から非アクティブタブ内要素への遷移はタブを自動展開しない（忠実性は無傷 — テキストは HTML に存在）。

## セクションアンカー（sha1・全報告書）

見出し id は `sec-<sha1(正規化見出し)[:8]>`（位置非依存・見出し依存）。再レンダリングしても見出しが同じなら id 不変 → アンカー付きコメントが迷子にならない。TOC・要判断リンクは同じ id 由来で自動整合。同一テキストの H2 は id を共有（`--lint` が警告）→ コメント合流を避けるため見出しは一意にする。

## コメント機能 & 返信プロンプト（報告書・既定 on）

報告書（`isReport` 判定: frontmatter `doc_id`/`report_id`/`audience`/`status` か「読者と目的」セクション）で**安定 id（`report_id` か `doc_id`）がある**場合、各本文 H2 直下にトピック別コメント Composer と返信プロンプト生成を付与する。`comments: off` で抑止。

- **localStorage のみ**（キー `ccpit-cmt:<reportId>:<sectionId>`）。コメントは HTML 本体に焼き込まない → 決定論（`同一MD→byte一致`）と `HTML⊆MD`/`MD⊆HTML` を維持（Composer は空コンテナ + CSS/aria ラベル + 空 textarea ＝静的テキストノードゼロ。on/off の `extractTextNodes` 一致テストで検証）。
- **reportId は MD 由来のみ**（`report_id`/`doc_id`）。ファイル名 fallback なし（ファイル名は MD 外で byte 一致を壊す）。id 不在ならコメント無効。
- **返信プロンプト** = 全コメントの固定整形集約（LLM 不使用）→ `navigator.clipboard.writeText` ワンクリックコピー（`file://` 等の非 secure context は `execCommand('copy')`+select にフォールバック）。返信本文生成（レビュー担当 / CC）は本レンダラの責務外（層分離）。
- コメント報告書にのみ注入。非コメント文書は byte 不変。

## CSP（ハードニング・推奨）

レンダラが出力するのは固定インライン script（mermaid ローダ・タブ apply-before-paint・タブローダ・コメントローダ・返信生成）のみ、SVG は `data:` 画像のみ。整合するポリシー:

`default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'sha256-<各インライン script のハッシュ>'`

`sha256-…` は出力された各インライン script からビルド/公開時に生成する（ローダ変更で値が変わる）。レンダラ自身は CSP meta を出力しない（ハッシュ誤りでページが壊れるため）— CSP は配信層で適用する。

## 同梱物

| ファイル | 説明 |
|---|---|
| `md2html.cjs` | レンダラ本体（依存ゼロ・単一ファイル） |
| `vendor/mermaid.min.js` | mermaid v10.9.1（MIT License） |
| `vendor/LICENSE-mermaid.txt` | mermaid のライセンス表記（sha256 記録込み） |

## 改変ガード

`md2html.cjs` を編集した場合は必ず `--selftest` を実行し、意図した変更なら内蔵 GOLDEN sha を再計算して更新する（selftest FAIL の放置は破損とみなす）。
