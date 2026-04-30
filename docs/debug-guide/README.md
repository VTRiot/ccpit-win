# CCPIT デバッグ手引書（024〜028 機能群）

> Living Document（後続 CC が更新する規約は本ファイル末尾を参照）。
> 初版: 2026-04-30（指示書 029）。

## 目的

CCPIT の指示書 024〜028 で実装された機能群（CC 起動ボタン、DetectLink、プロトコルバッジ、自動マーキング、Edit Marker UI、Favorite、Feature Flag）について、不具合発生時の調査・修正手順を体系化したドキュメント。

機能の正式仕様は FSA r4（`_Prompt/06_FunctionDevelopment/Launch_DeteckLink_260430/FSA_FunctionSpecAnchor/FSA_CCLaunch_DetectLink_ProtocolBadge_r4.md`）を最優先で参照すること。本手引書は **故障モード（症状） → 原因候補 → 確認手順 → 修正担当ファイル → 関連 vitest ケース** のテーブル化を目的とし、FSA を置き換えるものではない。

## 想定読者

1. **未来の CC**（不具合調査セッション） — 028 までの文脈を持たない別セッションが、何が壊れているかを推理して直す
2. **未来の設計 AI**（改修方針判断） — 故障パターンから設計方針を立てる
3. **らいお自身**（実機ドッグフーディング中の自己ガイド） — 制御設計バックグラウンドで FMA 思想に馴染んでいる

## 読み方（不具合発生時のフロー）

1. まず [機能群別の章](#機能群別の章) から該当機能を特定
2. 各章の **故障モード一覧（FM-XX）** から症状が一致するものを探す
3. 症状一致 FM の **確認手順** を上から順に実行（ファイル:行番号、grep キーワード、vitest ケース番号が含まれる）
4. 修正担当ファイルを特定し、**修正時の注意** を必ず読んでから着手
5. 一致する FM がない場合は、新規 FM として該当章末尾に追記し、`06_design_history.md` の「過去にない新しい故障モード」へ転記 → 後続 CC へ引き継ぎ

## 機能群別の章

| ファイル | 対象機能 | 由来指示書 |
|---|---|---|
| [01_feature_a_cc_launch.md](./01_feature_a_cc_launch.md) | CC 起動ボタン + 起動オプションメニュー | 024 |
| [02_feature_b_detect_link.md](./02_feature_b_detect_link.md) | DetectLink + Remove from List | 024 |
| [03_feature_c_protocol_badge.md](./03_feature_c_protocol_badge.md) | プロトコルバッジ + 自動マーキング + Re-scan / Edit Marker UI | 024 + 026 + 028 |
| [04_feature_d_favorite_reserved.md](./04_feature_d_favorite_reserved.md) | Favorite 星マーク + 予約フィールド | 024 |
| [05_feature_flag.md](./05_feature_flag.md) | Feature Flag 基盤（6 個） | 024 + 026 |
| [06_design_history.md](./06_design_history.md) | 設計変遷史（FSA r1〜r4）+ 設計バグ記録 + CCDG2 特殊性 | 024〜028 |

## FMA フォーマット（Failure Mode Analysis）

らいおの制御設計バックグラウンド由来。各故障モードは以下のテンプレートで記述する:

```markdown
#### FM-{機能ID}-{番号}: {症状の短い名前}

- 症状（ユーザー観察可能な現象）: ...
- 影響範囲: 全 PJ / 特定 PJ / 特定条件
- 既知の発生事例: 027/028 で起きた具体例（該当すれば）

##### 原因候補
- 候補 1: ...
- 候補 2: ...

##### 確認手順（CC のデバッグ手順、上から順に実行）
1. {何を見るか}: 期待値 vs 実測値の比較
2. {何を grep するか}: コードのこの行を読む
3. {何をテストするか}: vitest 該当ケース番号

##### 修正担当ファイル
- 主担当: services/protocol/autoMarker.ts:XX-YY
- 副担当: lib/protocolBadge.ts:XX-YY 等

##### 関連 vitest ケース
- Case {番号}: テスト名と検証内容

##### 過去の修正履歴
- 該当タスクで修正された場合のみ記載

##### 修正時の注意
- 副作用警戒、既存マーカー保護原則、Feature Flag との整合性 等
```

### FMA ID 体系

- **FM-A-XX**: 機能 A（CC 起動ボタン）
- **FM-B-XX**: 機能 B（DetectLink + Remove）
- **FM-C-XX**: 機能 C（プロトコルバッジ + Edit Marker）
- **FM-D-XX**: 機能 D（Favorite + 予約フィールド）
- **FM-FF-XX**: Feature Flag 基盤
- **FM-NEW-XX**: 過去にない新しい故障モード（一時 ID。確定時に該当機能の連番へ昇格）

### 推論ベース記述の作法（ロビンの遺産を継承）

027 調査レポート（CC ロビンの作品）の構造を踏襲する:

- **事実 + 引用 + 推論ステップ + 不確実性** を区別して書く
- 観察事実（ファイル内容、git log、実測値）と推論（原因仮説）を混ぜない
- 推測ベースの故障モードを書く際は **「推測です」と明示**
- 「採用しなかった選択肢」も記録する（重要な原因候補が複数あるとき、どれを棄却したか）

### 描写的読み × 規範的読み（028 系統 E でロビンが言語化）

修正担当者は現状コードを **描写的（descriptive）** に読むだけでなく、**規範的（prescriptive）** にも読む:

- 描写的: 「このコードは現状こう動いている」
- 規範的: 「**この現象が起きた以上、設計のここが脆かった**。本来こうあるべきだった」

修正時の注意セクションでは、可能な限り規範的読みの示唆を入れる。これにより同種ミスの再発を防ぐ。

## Living Document ルール（後続 CC への規約）

本手引書は **継続的に育てる** 文書である。後続 CC は以下の規約に従って更新すること:

1. **新機能追加時** — 関連する章に故障モードを追記。最低 1 件は記述（実装直後は推測ベース許容、ただし「推測です」明示）
2. **新たに発見された故障モード** — 該当章の故障モード一覧に追記。FM ID は連番で。発見状況・推論プロセス・棄却した代替仮説を記録する
3. **修正履歴は時系列で残す** — 過去の修正を消さない。「過去の修正履歴」セクションに追記して積み上げる
4. **設計変更時** — `06_design_history.md` の変遷史にエントリ追加。FSA リビジョンが上がった場合は r1〜r4 の差分テーブルに行を追加
5. **回帰故障モード** — 過去に修正した問題が再発した場合、新規 FM ではなく既存 FM の「過去の修正履歴」に「再発」として追記し、回帰理由を分析
6. **更新時のメタデータ** — 各章末尾に「更新履歴」セクションがある場合はそこに 1 行追記（`YYYY-MM-DD` + 概要）

### 後続 CC への警告（過去の設計バグ）

`06_design_history.md` の「設計バグの記録」セクションには、**同種のミスを再発させない警告** が記録されている。新機能を実装する前に必ず読むこと:

- **r3 設計バグ**: グローバル `~/.claude/` を判定材料に含めた論理的不整合（全 PJ 共通ソースで特定 PJ を判定する論理矛盾）→ 028 で修正
- **旧 STATUS_COLORS バッジ削除忘れ**: 024 で新 ProtocolBadge 追加時、旧バッジを削除する明示記述が指示書になく、両方並列描画 → 028 で修正

これらは **FSA テンプレートの欠陥** と **「ついでに修正禁止」原則の運用境界** の両方が絡む。新機能と既存機能の関係を「追加 / 置換 / 共存 / 段階廃止」のいずれかに必ず明示してから着手すること。

## 参照元

- **FSA r4**: `_Prompt/06_FunctionDevelopment/Launch_DeteckLink_260430/FSA_FunctionSpecAnchor/FSA_CCLaunch_DetectLink_ProtocolBadge_r4.md`
- 024 完了報告: `_Prompt/06_FunctionDevelopment/Launch_DeteckLink_260430/02_BuildAi/20260430_0305_024_完了報告.md`
- 026 完了報告: `_Prompt/06_FunctionDevelopment/03_CCDG2Diag_AndEditMarker_260430/02_BuildAi/20260430_0643_026_完了報告.md`
- 027 調査レポート: `_Prompt/06_FunctionDevelopment/04_Diag_CCDG2State_DoubleBadge_260430/02_BuildAi/20260430_0835_027_調査レポート.md`
- 028 完了報告: `_Prompt/06_FunctionDevelopment/05_AlgRefine_BadgeFix_Inference_260430/02_BuildAi/20260430_1006_028_完了報告.md`
- vitest テストケース: `ccpit/src/main/services/protocol/__tests__/autoMarker.test.ts`（31 ケース）

## 用語

| 用語 | 定義 |
|---|---|
| **FMA** | Failure Mode Analysis（故障モード解析）。らいおの制御設計バックグラウンド由来の中核思想 |
| **FM-XX** | Failure Mode の番号。本手引書での故障モード参照 ID |
| **CCPIT** | Claude Code Protocol Interlock Tower（製品名） |
| **CCPIT | CCPIT の開発コードネーム（内部） |
| **CC** | Claude Code（実装 AI） |
| **FSA** | Function Spec Anchor |
| **Self-host** | CCDG2 が CCPIT 自身を開発する環境構造 |
| **半端 MANX** | CCDG2 のように、PJ 直下に MANX 構成を持たないが MANX として運用されている状態 |
| **Living Document** | 機能追加・改修のたびに継続更新される文書 |
| **描写的読み** | データを「過去の事実」として読む姿勢 |
| **規範的読み** | データを「だからどう設計すべきだったか」として裏返して読む姿勢 |
