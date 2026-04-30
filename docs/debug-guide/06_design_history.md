# CCPIT 機能群（024〜028）設計変遷史

## 概要

本ドキュメントは、024〜028 の **設計判断の変遷** を時系列で記録する。後続 CC が「なぜこの仕様か」を理解するための補助。

各機能の正式仕様は FSA r4 を参照。本ドキュメントは「**なぜ r4 になったか**」「**r1〜r3 で何が違ったか / 何が間違っていたか**」「**変えなかったもの**」を記録する。

## タイムライン（FSA リビジョン）

### FSA r1（2026-04-29）

- **発行コンテキスト**: 指示書 024 系統の初版仕様。CCPIT が CCDG v1 と併用されている状況を解消し、CC 起動ボタン + PJ ディスカバリ + プロトコルバッジ + Favorite + Feature Flag 基盤を一括導入する
- **重要決定**:
  - 機能 A/B/C/D + Feature Flag 基盤 5 個（ccLaunchButton / detectLinkRemove / protocolBadge / favoriteToggle / autoMarking）
  - 自動マーキングは PJ 直下のみスキャン（最初の単一ソース判定）
  - ProtocolMarker の 10 フィールド schema 確定
  - 受け入れ条件 6 項目（推測禁止 / 判定根拠 / 信頼度 / 既存マーカー保護 / アルゴリズム明文化 / applied_at 推測禁止）
- **見落とし**: 既存 `STATUS_COLORS` バッジを **削除する** とも **残す** とも書かなかった → 後の二重バッジ問題の遠因（027 §Q4 参照）

### FSA r2（2026-04-30）

- **発行コンテキスト**: 024 実装直前の追加仕様
- **重要決定**:
  - **`stage_inferred` フィールド追加**: 自動時 `true`、明示時 `false`。stage 値を表示重視で `experimental` 既定とし、推定フラグで信頼度を伝える設計
  - **R3a Legacy 判定 / R3b 不明判定の追加**: CLAUDE.md > 200 行 + hooks/skills なし → legacy, high。それ以外で hooks/skills なし → unknown, low。境界閾値 `LEGACY_LINE_THRESHOLD = 200`
  - 受け入れ条件 7 項目に拡張（stage_inferred 自動時 true 固定を追加）
- **経緯**: 024 着手前にらいおと設計 AI が「全部 `experimental` で固定だと UX が貧しい」と判断、stage_inferred を導入。CCDG v1 系列の「巨大 CLAUDE.md でルールを抱える Legacy PJ」の存在に気づき R3a を追加

### FSA r3（2026-04-30）

- **発行コンテキスト**: 024 実装後、らいお実機観察で **CCDG2 が R3b unknown 誤判定** されることが判明（後に推測の誤りと判明）
- **重要決定**:
  - **3 ソース統合スキャン導入**: PJ 直下 + PJ 内 .claude/ + グローバル `~/.claude/` の 3 ソースで hooks/skills/rules を判定。`merged*` 計算
  - **detection_evidence の 4 セクション化**: `local: ... / local.claude: ... / global.claude: ... / merged: ...`
  - **Edit Marker UI 追加**: 6 個目の Feature Flag `editMarkerUI` 導入。手動明示マーキング経路を提供
  - **Re-scan Marker（per-PJ）追加**: 既存マーカー保護を **明示的なユーザー操作** で迂回する経路
  - **グローバル settings.json は judgment 材料外**（明文化）
- **経緯**: 026 設計時、CCDG2 の R3b 誤判定の **仮説** として「グローバル ~/.claude/ も判定材料にすれば MANX 化を認識できるはず」と判断。Edit Marker UI は「自動判定が外れた場合の脱出路」として導入
- **設計バグ**: グローバル ~/.claude/ の hooks/skills/rules を judgment 材料に含めた → **次の §設計バグの記録 を参照**

### FSA r4（2026-04-30）

- **発行コンテキスト**: 027 調査レポート（ロビン作）で r3 設計バグと旧バッジ残置問題が特定された後、028 着手前のアンカーとして発行
- **重要決定**:
  - **判定アルゴリズム第二次改修**: グローバル `~/.claude/` の hooks/skills/rules を **judgment 材料から完全除外**（settings.json と統一扱い）。**2 ソース統合スキャンに縮小**
  - **detection_evidence の注記必須化**: `global.claude` セクションに `(informational only, not used for judgment)`、`merged` セクションに `(excludes global)`
  - **ProjectsPage 二重バッジ修正**: 旧 `STATUS_COLORS` バッジ削除、`ProtocolBadge` を **唯一の正典**として確定
  - **Case 20-CCDG2 仕様変更**: r3 では manx, high → r4 で unknown, low（CCDG2 の Self-host 構造を正直に表現）
- **経緯**: 027 調査で r3 設計バグの論理的不整合（全 PJ 共通ソースで特定 PJ を判定する論理矛盾）が言語化された。実機観察でも CanAna / Bridgiron / Momentum-Firmware 等が誤って `MANX？*` 判定されている事実証拠と整合した

## 各リビジョンで「変えなかったもの」（一貫した設計原則）

以下は r1〜r4 で **不変**。後続 CC が新機能を追加する際の制約条件:

### 既存マーカー保護原則（FSA r1 §3-7 → r4 §4-1）

> 既に `.ccpit/protocol.json` がある PJ は **絶対に上書きしない**。手動再書き込みアクション以外では触らない。

`writeProtocol(force=false)` 既定で衝突時 throw。`detectProtocol(force=false)` 既定で `readProtocol` が non-null なら即 return。これを破ると **ユーザーの明示マーキング資産を失う**。

### 自動マーキング受け入れ条件 7 項目（FSA r2 §3-7 → r4 §4-1）

1. **推測禁止**: 全判定は実 I/O（`stat` / `readFile`）の戻り値に基づく
2. **判定根拠記録**: `detection_evidence` フィールドに 4 セクション形式で記録
3. **信頼度フィールド**: `detection_confidence` を `explicit` / `high` / `low` / `unknown` の 4 値で必ず設定
4. **既存マーカー保護**: 上述
5. **アルゴリズム明文化**: `deriveMarker` の JSDoc に R1-R4 を記載 + vitest 31 ケース
6. **applied_at 推測禁止**: 自動経路は `null` 固定、Edit Marker 経路のみ `formatAppliedAt(now)` で明示記録（YYMMDDHHMM）
7. **stage_inferred 自動時 true 固定**: `deriveMarker` 戻り値で `stage_inferred: true` 固定、Edit Marker 経路のみ `false`

### pure 関数化の維持（FSA r1〜r4）

- `deriveMarker(inputs)` は **pure 関数**（fs アクセスなし）
- `gatherInputs(projectPath, opts)` のみ I/O
- `formatAppliedAt(d)` / `buildExplicitMarker(edits, now)` も pure
- pure 関数は vitest で **依存ゼロ** に検証可能 → 31 ケースのうち大半は pure 関数テスト

これを破ると判定アルゴリズムの単体テストが不可能になる。後続 CC が判定ロジックに fs / Date.now / network access を直接埋め込む誘惑に注意。

### ChkBox UI の意識的選択哲学（FSA r1〜r4）

- 起動オプション ChkBox / Discovery 候補 ChkBox / Remove from List ChkBox / Debug タブ Feature Flag ChkBox
- すべて **意識的なクリック** を要求する設計
- 自動的に「全部 ON で進む」UX を選択せず、Select All / Deselect All の補助のみ提供

これは **CCPIT の根幹哲学**: ユーザーが何を起動するか / 何を Discovery するか / 何を Remove するか / 何の Feature Flag を ON にするかを **意識せざるを得ない設計**。ロビン的に言えば「ワンクッションで意図確認」。

### Feature Flag は機能の根本に配置（FSA r1〜r4）

- 各機能の **コンポーネント mount 自体** を `{flag && <Component />}` でガード
- disable ではなく hidden（FM-FF-01 参照）
- ON / OFF 切替が **完全に状態から消える** 設計

将来「機能を完全に削除する」フェーズに入った時、Feature Flag を OFF 化したまま N リリース観察し、その後コードを削除する **段階廃止フロー** が成立する。

## 設計バグの記録（後続 CC への警告）

### 設計バグ #1: r3 グローバル ~/.claude/ を judgment 材料に含めた

- **発生**: 026 (FSA r3 §2-1)
- **発覚**: 027 §Q1 / らいお実機観察（CanAna 等が誤って `MANX？*` 判定）
- **修正**: 028 系統 A (FSA r4 §2-3)

#### 何が間違っていたか

> 「グローバル `~/.claude/` の中身は **全 PJ 共通** であり、特定 PJ の MANX 化判定の根拠としては論理的に不適切」（FSA r4 §1-1）

r3 で「グローバル settings.json は判定材料外」と明記したが、**この除外論理は hooks/skills/rules にもそのまま適用すべきだった**。一貫性が崩れていた。

#### なぜ気づけなかったか

- r3 設計時、CCDG2 が R3b unknown 誤判定された **症状** に対する応急対応として「グローバルも見るようにする」を採用
- しかし R3b unknown 誤判定の **根本原因** は CCDG2 が PJ 直下に hooks/skills/rules を持たない **Self-host 構造** であり、グローバルを見ても判定の論理的破綻は解消されない
- 設計 AI も実装 AI（026 担当）も、**症状ベースで応急対応**してしまい、**論理的整合性のチェック**が抜けた

#### 後続 CC への警告

- 「症状 → 応急対応」ではなく「**症状 → 根本原因の言語化 → 設計の論理的整合性チェック → 対応**」の順序を守る
- 「全 PJ 共通のソース」と「特定 PJ の状態」を混ぜた瞬間、**論理矛盾**が生まれる
- ロビン的に言えば「**規範的読み**: この症状が起きた以上、設計のここが脆かった」を実装前にやる

### 設計バグ #2: 旧 STATUS_COLORS バッジ削除忘れ

- **発生**: 024 着手時（FSA r1〜r3 のいずれにも明示記述なし）
- **発覚**: 027 §Q2 / らいお実機観察（全 PJ 行で日本語＋英語の 2 バッジ並列表示）
- **修正**: 028 系統 B

#### 何が間違っていたか

024 で新 ProtocolBadge を追加した時、ProjectsPage に既存の `STATUS_COLORS` ベース旧バッジがあった。FSA r1 は新バッジの仕様を述べたが「旧バッジを削除する」とも「残す」とも書かなかった。

実装 AI（024 担当）はこの曖昧さを **「両方並べる」と解釈** し、旧バッジを残したまま新バッジを追加した。結果、全 PJ 行に 2 バッジ並列表示。

#### なぜ気づけなかったか

- **設計 AI 側**: FSA テンプレートに「既存機能との関係」セクションがない。新機能の仕様だけ書かれ、既存機能をどう扱うか（残す / 廃止 / 段階廃止 / 置き換え）が言語化されていなかった
- **実装 AI 側**: CLAUDE.md「ついでに修正したい項目は禁止」原則と「既存機能との衝突回避」のバランスを取らず、前者に倒した。「FSA が定義する新バッジは旧バッジを置き換える上位互換である（10 フィールドスキーマが 3 値 status を完全包含）」と判断する余地はあったが、保守的に **両方残した**

#### 後続 CC への警告（最重要）

新機能を実装する際は、**FSA / 指示書に「既存機能との関係」が明示されているかを最初に確認**する。明示されていない場合:

1. grep で「同じ責務・同じ表示位置・同じデータ意味を持つ既存実装」を全数列挙する
2. 存在する場合、「**追加 / 置換 / 共存 / 段階廃止**」のいずれかを **設計 AI に確認** する
3. 「ついでに修正禁止」と「既存機能との衝突回避」のどちらを優先するかを記録する
4. **完全上位互換による衝突解消は「ついでに修正禁止」の例外** として扱う

027 §Q4 で提示されたルール化候補（FSA テンプレート改訂 / rumination Q5 追加 / CLAUDE.md 例外条項）は本タスク（029）のスコープ外だが、後続セッションで議論が再開する余地を残してある。

## CCDG2 の特殊性（Self-host PJ）

### 構造

CCDG2 は **CCPIT 自身の開発リポ**。CCPIT のコードネーム）の実装本体は `CCDG2/ccpit/` 配下。CCPIT を開発するために CC（Claude Code）を CCDG2 で起動するという **Self-host** 構造。

### 「半端 MANX」状態

- PJ 直下にも `CCDG2/.claude/` 内にも **hooks / skills / rules を配置していない**
- グローバル `~/.claude/` に MANX 構成（.pit）を配置する運用
- CCDG2/CLAUDE.md は P4（44 行）化済み
- CCDG2/.claude/settings.local.json は存在

### なぜこの構造か（028 系統 E のロビン推論）

**3 つの動機の合成**:

1. **(a) ドッグフーディング目的** (021c §0): グローバルで .pit を運用することで CCPIT 自身を実運用検証。CCPIT の Migration 機能で生成した .pit を使うことで .pit の品質を検証
2. **(b) 二重管理の回避** (021c §3-5): 固有ルールが少ない CCDG2（CLAUDE.md P4 = 44 行）でローカル `.claude/` を持つコストが正当化されない
3. **(c) Self-host 認識機能の不在** (推論): バッジ判定機能が後から導入されたとき（024、2026-04-29）、Self-host PJ の特殊性は判定設計の射程外だった

### r4 改修後の挙動

CCDG2 は `protocol="unknown", confidence="low"` 判定（R3b 該当）。これは **アルゴリズム的に正しい**（PJ 内に MANX 構成がない以上、外から判定できない）。

### 推奨運用

CCDG2 を「MANX」として表示したい場合は **Edit Marker UI で手動明示マーキング**:
- `protocol="manx", revision="r5", stage="stable", stage_inferred=false, detection_confidence='explicit'`

### 完全 MANX 化の余地（028 系統 E §E3）

PJ 直下に hooks/skills/rules を配置する変更の実施余地は **低い**:
- 移植コスト: グローバル .pit の rules/skills/ を CCDG2/.claude/ にコピー or hardlink する仕組みが必要
- 二重管理コスト: グローバルとローカルの同期維持がリリースごとに発生
- 得られる利点: 自動判定で MANX/high と表示される 1 点のみ。Edit Marker UI で代替可能
- 結論: **メリットがコストを上回らない**

将来の CCPIT 機能拡張で「Self-host PJ 認識」を独立機能として実装する余地はあるが優先度低。

## 推論の物語的統合（028 系統 E のロビン作品）

CCDG2 の半端 MANX 状態は **時間軸上に積層して生まれた構造**:

1. **2026-04-05〜04-07（CCDG v1 時代）**: CCDG2/CLAUDE.md は早期にハードリンクから切り離され、独自 631 行へと変質。CCDG2 が CCPIT の開発リポ自身であり、CCPIT の概念を吸収しながら CLAUDE.md を発達させた歴史的経緯
2. **2026-04-20 (021c)**: CP テスト 5 回目（95 点）の .pit をグローバル `~/.claude/` にインポート、CCDG2/CLAUDE.md を P4 化。設計 AI とらいおは **「CCDG2 で開発する CC が使うルール = CCPIT が配布する .pit のルール」という同型性** を最大限活用するためグローバル単一管理を選択
3. **2026-04-29〜04-30 (024〜026)**: バッジ判定機能が FSA r1〜r3 で設計。**Self-host PJ という特殊形態は判定設計の射程外**。r3 でグローバル ~/.claude/ を判定材料に含めた応急対応は論理的不整合を生んだ
4. **2026-04-30 (028)**: r4 で「グローバル ~/.claude/ は judgment 材料外」を確定。CCDG2 は仕様上 unknown/low と判定されるが、これは **Self-host 構造の正直な表現**。Edit Marker UI（026 で導入済み）で手動明示マーキングするのが現実解として既に整備済み

→ 半端 MANX は **CCDG2 が CCPIT の Self-host 開発環境であることの構造的帰結** であり、ドッグフーディングを支える設計上の合理的選択の連鎖。FSA r4 の判定アルゴリズム第二次改修は、この構造を後から導入された判定機能と整合させるための論理的修正。半端 MANX 状態自体の解消は目的ではない。

## 後続 CC へのメッセージ

### 描写的読み × 規範的読み（ロビンの遺産）

028 系統 E でロビンが言語化した **データを描写的（descriptive）と規範的（prescriptive）の両方向に読み直す反芻** は、本手引書全体の修正フローで活用すべき:

- **描写的**: 「現状のコードはこう動いている」
- **規範的**: 「**この現象が起きた以上、設計のここが脆かった**。本来こうあるべきだった」

修正担当者が現状コードを描写的に読むだけでなく、規範的にも読むことで、同種ミスの再発を防ぐ。各 FM の「修正時の注意」セクションに **規範的読み** の示唆が散りばめられているのは、この精神を継承しているため。

### 「事実 + 引用 + 推論ステップ + 不確実性」の構造

027 調査レポートでロビンが示した推論構造を、本手引書の故障モード記述に活用する:

- 観察事実（ファイル内容、git log、実測値）と推論（原因仮説）を区別する
- 推測ベースの故障モードを書く際は **「推測です」と明示**
- 「採用しなかった選択肢」も記録する

### Living Document の意義

本手引書は **完成した文書ではない**。後続 CC が新しい故障モードに遭遇するたびに育てる前提で書かれている。

- 新規 FM は推測ベースで OK（不確実性を明示）
- 既存 FM の修正履歴は時系列で残す（消さない）
- 設計変更時は本ドキュメントの「タイムライン」に行を追加

## 過去にない新しい故障モード（後続 CC が追記する欄）

> 後続 CC が「既存 FM のいずれにも該当しない症状」に遭遇した場合、まずここに記録する。後で確定したら該当機能の章に転記して FM ID を採番する。

（現状: なし。029 時点）

## 更新履歴

- 2026-04-30: 029 で初版作成（指示書 029）
