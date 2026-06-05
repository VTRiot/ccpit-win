---
name: skill-proposal-emitter
description: セッション終了時に、そのセッションで踏んだ WorkFlow のうち Skill 化が有益な候補を「完成版 SKILL.md + 採用推奨/棄却ラベル + 評価軸スコア」の提案 MD として出力するために発火する。CCPIT の候補ブラウザから人間が ほぼ手数0 で採用できる形式。
---

# skill-proposal-emitter — Skill 化候補 提案 MD 出力 skill

## 0. このスキルの役割

CC（あなた）はそのセッションで有用な WorkFlow を踏むことがある。それを「使い捨て」にせず、Skill 化が有益な候補を**提案 MD** として残す。人間は CCPIT の候補ブラウザから一覧で見て、レビューゲート → パスワード認証 → 採用（kind:skill apply）の操作で ほぼ手数0 で採用できる。

これは Part B「Skill 採用・フィードバックパイプライン」の起点（提案 = センシング）である。提案フォーマットは CCPIT の kind:skill apply 入力と整合させてあるため、採用 = ほぼそのまま `~/.claude/skills/<name>/SKILL.md` へ適用される。

## 1. 発火条件

- セッション終了時（提案 Stop hook が要求する。`skill-proposal-gate.sh`）。
- 調査のみ・短いセッションでも発火してよい。価値ある WorkFlow を踏まなかった場合は「該当なし」を構造化して出す（§5）。

## 2. 出力プロトコル

### 2-1. 配置先

```
~/.ccpit/proposals/<timestamp>_<request-id>.md
```

- `~/.ccpit/proposals/` = CCPIT の集約提案プール（userData。全プロジェクト横断で 1 箇所に集約）。
  採用先が `~/.claude/skills/`（グローバル）ゆえ、提案プールも cwd 非依存に集約する。
- `<timestamp>` = `YYYYMMDD_HHMM`（実際にファイルを生成した時刻。推定・丸め禁止）。
- `<request-id>` = kebab-case の短い識別子（提案する skill 名に対応させると分かりやすい。例: `pdf-extract-flow`）。
- ディレクトリが無ければ作成する（`mkdir -p ~/.ccpit/proposals`）。
- **1 候補 = 1 ファイル**。複数候補があれば複数ファイルを出す。
- 出自（生成時の作業ディレクトリ）は frontmatter の `source_project` に記録する（§2-2）。

### 2-2. ファイル形式

```markdown
---
request_id: <FILL: ファイル名の request-id と一致>
created_at: <FILL: ISO 8601, 例 2026-05-29T16:58:00+09:00>
purpose: <FILL: 1 行。何を Skill 化する提案か>
target: ~/.claude/skills/<FILL: skill 名>/SKILL.md
status: pending
kind: skill
adoption_label: <FILL: recommend | reject>
source_project: <FILL: 生成時の作業ディレクトリの絶対パス。例 C:\path\to\your\project>
---

## 1. サマリ

- タイトル: <FILL: 候補 skill の一言タイトル>
- What: <FILL: この skill が何をするか 1〜2 行>
- Why: <FILL: なぜ Skill 化が有益か 1〜2 行>
- How: <FILL: どう使う / いつ発火するか 1〜2 行>

## 2. 評価軸

各軸 0〜5 のスコアと根拠を**必ず**埋める（空欄・定型句は CCPIT の品質ゲートで弾かれる）。

- 再現性: <FILL: 0-5> — <FILL: 根拠>
- 汎用性: <FILL: 0-5> — <FILL: 根拠>
- Context節約効果: <FILL: 0-5> — <FILL: 根拠>
- 既存Skill重複・統一可能性: <FILL: 0-5> — <FILL: 根拠（重複あれば統一案も）>
- 本質的UX向上への寄与: <FILL: 0-5> — <FILL: 根拠>

## 3. 変更後の完成版

採用時にこのブロックの中身がそのまま `target` の SKILL.md として書き込まれる。
**外側フェンスは内側の最長バッククォート連よりも 1 個以上長くする**
（内側の最長が N 連なら外側は N+1 個以上。最低 3 個。固定 4 ではない。CommonMark のフェンス規約。
CCPIT のパーサは「開き N 個 → 閉じ N 個以上」で対応する）。
例: SKILL.md 本文が 3 連フェンス（```）を含むなら外側は 4 連（````）。4 連を含むなら外側は 5 連。

````markdown
---
name: <FILL: skill 名（target と一致）>
description: <FILL: 発火条件を含む説明>
---

<FILL: 完成版 SKILL.md の全文。手順・例を含む（内側のコード例も可）>
````

## 4. 採用推奨 / 棄却の判定と理由

- 判定: <FILL: recommend | reject（frontmatter の adoption_label と一致）>
- 理由: <FILL: §2 の評価軸を踏まえた判定理由。reject でも消さず必ず理由を残す>

## 5. レビューボックス

レビュアー（人間 / 将来のレビュアーAI）が記入する欄。提案時は空（pending）で出す。

- review_verdict: pending
- findings:
- reviewer_id:
- cc_rebuttal:
```

### 2-3. 重要な作成手順

1. そのセッションで踏んだ WorkFlow を棚卸しし、Skill 化が有益な候補を**本気で全部**挙げる。
2. **既存 Skill の確認**: 評価軸「既存Skill重複・統一可能性」を埋める前に、`~/.claude/skills/` の既存 Skill 一覧を Read で確認する（既存を見ずに「重複なし」と書かない。重複評価の実効性のため）。
3. 各候補に評価軸スコア（§2）を付ける。価値が低くても**棄却理由を付けて**出す（消さない）。
4. **重複候補の扱い**: 明らかに既存 Skill と重複する候補は `recommend` せず、`reject` の理由に重複先と統一可否を明示する（毎セッション発火で同じ WorkFlow が重複提案として溜まるのを軽減。なお重複防止の本筋は CCPIT 候補ブラウザの既出/採用済み可視化が担う）。
5. 「## 3.」の完成版 SKILL.md は、採用後そのまま動く品質で書く（手順・発火条件・例）。
6. 外側フェンスを内側の最長バッククォート連 +1 以上にする（内側が N 連なら外側 N+1。固定 4 ではない。§2-2 参照）。
7. frontmatter は**フラットな key: value のみ**（ネスト不可。CCPIT のパーサ制約）。

## 3. 評価軸の定義

| 軸 | 意味 |
|---|---|
| 再現性 | 同じ状況で再び使える手順か（一回性でないか） |
| 汎用性 | 他 PRJ・他文脈にも効くか |
| Context節約効果 | Skill 化で都度の指示・説明を省けるか |
| 既存Skill重複・統一可能性 | 既存 skill と重複しないか、統一できないか |
| 本質的UX向上への寄与 | ユーザーにとって本質的な UX 向上につながるか |

この 5 軸は CC 自己評価（本 skill）と将来のレビュアーAI 評価の**共通基盤**。同じ軸の上で棄却理由とレビュー観点を扱う。

## 4. 配布対応の制約

提案 MD には以下を**混入させない**:

- ユーザー個人の固有名詞（人名・会社名・PJ コードネーム・製品名）
- AI セッションの命名（過去セッション名・CC 自身の名前）
- 内部開発コードネーム

`purpose` / サマリ / 完成版 SKILL.md は、当該の技術的内容のみで書く。

## 5. 候補ゼロ時の扱い

価値ある WorkFlow を踏まなかったセッションでも、**消さずに記録を残す**。
1 ファイルを出し、frontmatter を `adoption_label: reject` とし、本文「## 1. サマリ」に
「このセッションに Skill 化候補なし」、「## 4.」に**軸ごとの簡潔な理由**を書く。
（「## 3.」の完成版は空の skill 雛形でよい。状態管理は CCPIT 側が行う。）

## 6. CCPIT 側との連携

人間は CCPIT を起動 → 左ペインの「Skill 候補ブラウザ」を開く。CCPIT は既定で `~/.ccpit/proposals/` の提案を一覧表示（タイトル/What/Why/How + ラベル + 評価軸スコア + 出自プロジェクト）し、候補選択 → レビューゲート（レビューボックス確認）→ パスワード認証 → 採用（kind:skill apply、自動バックアップ・検証・失敗時自動ロールバック）→ 状態（候補/採用済/却下/保留）を管理する。

採用された skill が golden 配布 skill と同名の場合、CCPIT は採用を拒否する（恒久シャドウ防止）。同名にしないこと。

## 7. 完了確認

提案 MD を出力したら、CC は会話中で以下を伝える:

- 提案ファイルパス（複数なら全部）
- 各候補のタイトルと採用推奨/棄却ラベル
- 「CCPIT の候補ブラウザから採用してください」という案内

CC は `~/.claude/skills/` を**直接編集しない**。採用は CCPIT の認証付き apply 経路を通す（安全アーキテクチャの根幹）。
