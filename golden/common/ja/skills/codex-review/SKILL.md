---
name: codex-review
description: 汎用の独立 Codex 第二レビュアー。marshal-review が発火しない領域（実装前の計画/設計レビュー、Skill 採用候補レビュー、working-tree 差分でない成果物）で発火する。同一タスクで marshal-review が発火する（実装変更がある）場合は、二重 Codex 実行を避けるため取り下げる。候補レビュー時は findings を CCPIT のレビューボックス契約に記録する。
---

# codex-review — 独立 Codex 第二レビュアー（汎用）

## 0. このスキルの役割

成果物や判断に対し **Codex の独立した第二意見**を助言として得る。最終権限は持たない。最終ゲートは常に人間。本スキルは Skill 機構経由で発火するため、Codex companion を Bash 直接呼びする場合と違い、活動が発火統計／フィードバックループに乗る。

`marshal-review` を補完する、軽量な隙間埋めの層である。`marshal-review` は実装変更（rule/code/bundle）があるたびに **git working tree に対する Codex adversarial-review** を回す強制ゲート。本スキルはその強制ゲートが届かない領域を担う。

## 1. 発火条件 — と marshal-review との調停

独立した Codex 第二意見が価値を生み、**かつ** `marshal-review` が同一タスクをカバーしていない時に発火する。典型的な文脈:

- (a) **計画/設計レビュー** — 実装着手*前*に plan / design 文書を pressure-test する（コード変更がまだ無いので `marshal-review` は発火しない）。
- (b) **Skill 採用候補レビュー** — 候補の提案 SKILL.md 内容（working-tree 差分でないテキスト成果物）をレビューし、結果を CCPIT のレビューボックスに記録する（§3-A）。
- (c) その他、独立レビューに値すると判断した、working-tree 差分でない成果物。

**調停（二重実行をするな）:** 現タスクで `marshal-review` が発火する／発火すると既に分かっている（= 実装変更がある: rule / code / 報告書 bundle）場合、**取り下げる**: 本スキルを回さない。その場合は `marshal-review` が既に独立 Codex レビューを提供しており、両方回すのは冗長な二重 Codex 実行になる。取り下げ判断は報告書／会話に明示せよ。沈黙スキップ禁止。`marshal-review` がカバーするか迷う時は、強制ゲートである `marshal-review` を優先し本スキルを退かせる。

候補レビューが衝突しない理由: 候補は*提案*段階（まだ skill ファイルを編集していない）なので `marshal-review` は発火しない。実際の skill 変更は後段の*採用*時（CCPIT の認証付き apply）で起き、そこで `marshal-review` が発火しうる — 経路が分離しているため二重実行にならない。

**コスト二段（コスト関門）:** 候補レビューでは、一次フィルタを通過した候補 — `adoption_label: recommend` かつ `review_verdict: pending` — のみ Codex を呼ぶ。レビュー済み・reject ラベルの候補に Codex を使うな。

## 2. Codex 呼び出し（参考 — 最良の呼び方は実行時に判断）

Codex companion スクリプトのパスはバージョンで変動するため動的に解決する（`marshal-review` と同イディオム）:

```
~/.claude/plugins/cache/**/codex-companion.mjs
```

- 1 件ヒット: それを採用。
- 複数ヒット: **semver 最大**を採用（例: `1.0.4` と `1.0.5` なら後者）。旧バージョン残置事故を防ぐ。
- 0 件ヒット: Codex プラグイン未配備とみなし、人間レビューへ縮退（§4）。

Bash で直接呼ぶ（disable-model-invocation 回避の既知手）。read-only（`--write` なし）:

```
node "<解決した codex-companion.mjs>" task "<レビュープロンプト>"
```

本スキルは **提供されたテキスト成果物**（plan / design 文書、または候補の §1-§3 SKILL.md）をレビューするため `task` サブコマンドを使う。git working-tree 差分のケースは `marshal-review` の `adversarial-review` の役目。成果物テキストをプロンプトに埋め込み、verdict + findings を返すよう Codex に求める。

レビュー観点はドライに具体的に:

- 候補レビュー: *本質的な UX 向上か。類似する既存 skill と統一可能か。*
- 計画/設計レビュー: *隠れた仮定は。検討されていない代替案は。要件カバレッジ／副作用は。*

## 3. findings の記録

### 3-A. 候補レビュー → CCPIT レビューボックス

Codex stdout を `verdict`（例: `approve` / `needs-attention`）と `findings` に整理し、CCPIT のレビューストアに upsert する。**提案 MD は書き換えない**。CCPIT が list 時に `request_id` をキーに本ストアをレビューボックスへマージする。

ストア: `~/.ccpit/proposal-reviews.json`

```json
{
  "<request_id>": {
    "verdict": "needs-attention",
    "findings": "<簡潔な reviewer findings、単一ブロック>",
    "reviewerId": "codex",
    "ccRebuttal": "<findings への反論／応答があれば>",
    "reviewedAt": "<ISO 8601、記録の実時刻 — 推定／丸め禁止>"
  }
}
```

- まずファイルを読む（無い／空なら `{}` 扱い）→ 当該 `request_id` キーを 1 件セット → オブジェクト全体を pretty JSON で書き戻す。reader はフェイルセーフ（破損時は「レビュー無し」= MD の pending ボックスに縮退）だが、書く側は妥当な JSON を書け。
- findings と自分の反論（§4）の両方を記録する。採用／却下の最終判断は人間が CCPIT のパスワードゲートで行う。

### 3-B. 計画/設計レビュー → その場で提示・記録

findings をユーザーに提示し、当該 plan/報告書に記録する。候補レビューボックスは書かない（`request_id` が無いため）。

## 4. レビュアー抽象化・縮退・最終権限

- **レビュアー抽象化:** `reviewerId` は自由文字列で、レビュアーエンジンを差し替え可能（既定 `codex`。別のレビュアー AI やローカル LLM でもよい）。Codex を本体にハードコードするな。
- **縮退:** Codex 不在／応答不能（§2 の 0 件、CLI 欠落、認証/ネットワーク失敗）の場合、**ブロックしない**。レビューは `pending` のまま（人間レビュー）にし、不在を記録 — 事由 + タイムスタンプ + 取った代替行動。本体は特定 AI 体制から独立を保つ。「if applicable」型の沈黙スキップ禁止。
- **最終権限は人間。** 本スキルは助言者。自動採用するな、Codex を最終審にするな。誤った reviewer verdict が無検証で通ってはならない。

## 5. 配布制約

レビュープロンプト・findings・記録物のいずれにも入れない:

- ユーザーの個人的固有名詞（人名・社名・プロジェクトコードネーム・製品名）、
- AI セッション命名や内部開発コードネーム。

技術的内容のみに留めること。
