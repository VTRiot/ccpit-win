---
version: "1.0.0"
language: "ja"
purpose: "Doctor Pack（DP）reference guide for claude.ai diagnostic assistant"
---

# DP（Doctor Pack）診断ガイド

本ガイドは、CCPIT（Protocol Interlock Tower）の診断アシスタントが DP（Doctor Pack）を使用して CC（Claude Code）環境の障害診断を行う際の詳細リファレンスです。

---

## 1. MANX Protocol の安全設計概要

MANX Protocol は CC の推論品質を保証するために、2 つの独立した安全層を持ちます。

### 1-1. Senior TT（Main Function）— 規律層

CC の推論品質を保証するシステム本体です。

構成要素:
- **CLAUDE.md**（P1）: CC の身分証明書 + インターロック表
- **rules/**（P2）: 短い行動規範
- **skills/**（P3）: 詳細手順書

特性:
- CC が内面化して従うべきルール
- 遵守が強く期待されるが、仕組み上は逸脱が可能
- compaction（コンテキスト圧縮）により遵守率が劣化する可能性がある

### 1-2. Junior TT（Safety Mechanism）— 強制層

settings.json ベースの最下層防護です。規律層が全て破綻しても機能する最終防壁です。

構成要素:
- **deny**: 絶対禁止リスト。該当操作を無条件で阻止
- **hooks**: イベント駆動ガードレール。条件付きでブロック/許可
- **auth**: ルール変更時の本人確認

特性:
- システムプロンプト層で強制適用。CC の判断や意図に関係なく逸脱不可能
- CLAUDE.md が compaction で劣化しても影響を受けない
- CC 自身が settings.json を変更することは deny で阻止されている

---

## 2. deny の役割と典型的な問題パターン

### 2-1. deny とは

settings.json 内に定義される絶対禁止リストです。CC がどのような状態にあっても、deny に記載された操作は物理的にブロックされます。

### 2-2. deny の典型的な問題パターン

| パターン | 症状 | 原因 |
|---------|------|------|
| 無効な構文 | deny が効かない（サイレントフェイル） | `file_path=` 構文の使用、glob パターンの誤り等 |
| 過剰な deny | 正当な操作までブロックされる | deny に入れるべきでない操作（ユーザーが許可する場面がある操作）を入れた |
| エスケープ不足 | settings.json 全体がパースエラー | Windows パス内の `\` が未エスケープ（`C:\` → `C:\\` が必要） |
| 迂回経路 | deny を回避してアクセスできる | Read は deny しているが Bash(cat) は未設定等 |

### 2-3. deny 構文の注意事項

- `file_path=` 構文は無効。glob パターンのみ受け付ける
- `*` は 1 階層のみ、`**/*` が全階層マッチ
- Read と Bash(cat) は独立ツール。両方に deny が必要
- JSON 内の `C:\)` は `C:\\)` にダブルエスケープが必要

---

## 3. hooks の役割と故障モード

### 3-1. hooks とは

settings.json 内に定義されるイベント駆動のシェルスクリプトです。CC のライフサイクルイベント（Stop / PreToolUse 等）で自動発火します。

### 3-2. hooks と deny の違い

| 特性 | deny | hooks |
|------|------|-------|
| 検知対象 | CC が禁止操作を実行しようとしたとき | CC がイベントを通過するとき |
| 不作為の検知 | 不可 | **可能**（CC は必ず停止する → Stop hook が発動） |
| 判定ロジック | パターンマッチ（固定） | シェルスクリプト（任意ロジック） |

### 3-3. 代表的な hooks

| hook 名 | イベント | 目的 |
|---------|---------|------|
| report-gate | Stop | CC 停止時に報告書 MD の存在を確認。コード変更ありかつ報告書なしならブロック |
| settings-guard | PreToolUse (Edit\|Write) | settings.json への Edit/Write を deny との二重防壁でブロック |

### 3-4. hooks の故障モード

| 故障モード | 症状 | 診断方法 |
|-----------|------|---------|
| スクリプト不在 | hook が発火しない | `$HOME/.claude/hooks/` 内のファイル存在確認 |
| 実行権限不足 | hook がエラーで停止 | `chmod +x` 確認（DP の Hooks セクションに mode 表示あり） |
| exit code 誤り | hook の判定結果が無視される | exit 2 は stdout JSON を無視する。exit 0 + JSON が正しい |
| パス記法誤り | hook が見つからない | settings.json 内のパスに `\` を使用していないか確認。forward slash のみ |
| settings.json 定義欠落 | hook 自体が登録されていない | settings.json の hooks セクション確認 |

---

## 4. Diff Summary のリスクスコア

DP（Doctor Pack）に含まれる Diff Summary は、最新スナップショットとの差分をリスクレベルで分類します。

| リスク | 対象 | 意味 |
|--------|------|------|
| **High** | settings.json / hooks スクリプトの変更 | Junior TT（最下層防護）に影響。最優先で確認 |
| **Medium** | rules/ / skills/ の変更 | Senior TT（規律層）に影響。推論品質に関わる |
| **Low** | その他のファイル変更 | 直接的な安全影響は小さい |

**High-Risk Changes が存在する場合、最優先で確認してください。** Junior TT の変更は、規律層が全て破綻した際の最終防壁に影響します。

---

## 5. 診断の手順

以下の順序で診断してください:

### Step 1: 症状の確認

DP の Symptom セクションからユーザーの報告内容を把握する。

### Step 2: deny 確認

Deny Rules セクションを確認:
- deny ルールの構文は有効か
- 過剰な deny がないか
- 必要な deny が欠けていないか

### Step 3: hooks 確認

Hooks セクションを確認:
- settings.json に hooks 定義が存在するか
- スクリプトファイルが存在するか
- 実行権限があるか（mode に実行ビットがあるか）

### Step 4: Diff 確認

Diff Summary を確認:
- High-Risk Changes があるか → 最優先で分析
- 症状と時間的に相関する変更があるか
- 意図しない変更（改ざんの可能性）がないか

### Step 5: 結論

上記の分析結果を統合し:
- 原因の特定（どの層に問題があるか）
- 修正手順の提示（優先度付き）
- 再発防止策の提案

---

## 6. settings.json を CC が変更できない旨の明記

**重要:** CC（Claude Code）は settings.json を変更できません。

- settings.json は deny で CC 自身による編集が禁止されている
- hooks（settings-guard）でさらに二重防壁が設置されている
- settings.json の修正が必要な場合、**ユーザーが手動で編集する必要がある**

診断結果に settings.json の修正が含まれる場合、修正内容を具体的に提示し、ユーザー自身に手動編集を依頼してください。

---

## 7. 典型的な障害シナリオと対応パターン

### 7-1. skill が発火しない

**症状:** CC が特定の skill を呼び出さずにタスクを進めてしまう。

**考えられる原因:**
- skill の YAML description がカテゴリ限定的（「バグ調査」→「現状調査はバグ調査ではない」と判断してスキップ）
- skill ファイルが存在しない、またはパスが間違っている
- compaction により CLAUDE.md のインターロック表が劣化

**対応:**
1. skill ファイルの存在を確認
2. YAML description を行為ベースに修正（「〜する際に発火する」）
3. インターロック表がCLAUDE.md に存在するか確認

### 7-2. 報告書が出力されない（report-gate ブロック）

**症状:** CC が作業完了時に停止できない（report-gate hook がブロックしている）。

**考えられる原因:**
- CC がコード変更後に報告書 MD を出力し忘れた
- report-gate.sh のスクリプトが正しく動作していない
- hook の exit code が誤っている

**対応:**
1. report-gate の hook 定義を確認（settings.json 内）
2. report-gate.sh の存在と実行権限を確認
3. CC に報告書 MD の出力を促す

### 7-3. settings.json のパースエラーで全 deny が無効化

**症状:** deny ルールが全く効かない。CC が禁止操作を実行できてしまう。

**考えられる原因:**
- JSON 構文エラー（Windows パスの `\` 未エスケープ等）
- 1 件のエラーで settings.json 全体がスキップされる

**対応:**
1. settings.json を JSON バリデーターで検証
2. Windows パスの `\` が `\\` にエスケープされているか確認
3. 修正後、deny の実発火テストで有効性を検証
