---
name: stopbug-guard
description: 停止バグ（誤形式ツール呼び出し→自己プライミング）の予防規律。stopbug-observe hook が trip-wire（移行推奨）/ 時限タイマー（較正促し）を出した時、または重処理の直前の最小の気の引き締めとして発火する。
---

# stopbug-guard — 停止バグ予防の規律手順

## 発火条件
- Stop hook `stopbug-observe` が **移行推奨**（当セッションで誤形式を観測）を出した時。
- Stop hook が **較正促し**（観測データが収集期間に到達）を出した時。
- 重い処理（多ファイル編集・長い生成）の**直前**の、最小の気の引き締めとして。

## 前提（なぜ）
誤形式ツール呼び出しは履歴に "お手本" として残り後続を引っ張る（自己プライミング）。
真の根治＝serving 層の constrained decoding は Anthropic 側のみ。当層の最強かつ最安の手は
**汚染文脈を早く切る＝セッション移行**。リマインダは弱い補助に過ぎない。
機械観測は hook が、回復規律は [[priming-loop-recovery]] が、移行動線は [[cc-state-declaration]] が担う。
本 skill はそれらを結ぶ手順だけを置く。

## 手順 A — 移行推奨（trip-wire）を受けた時
1. いま安全な完了点である。**追加の重処理を始めない**。
2. クリーン引き継ぎメモを書く（目的・完了済み・次操作のみ）。
   - 誤形式出力は**絶対に引用しない**（再プライミングを避ける）。
3. `/exit` で終了し、`claude --resume <セッションID>` で再開する（[[cc-state-declaration]]）。
   - 新セッションが最確実。`/clear` ＋引き継ぎメモでも可。
4. 移行後、引き継ぎメモから作業を再開する。

## 手順 B — 較正促し（時限タイマー）を受けた時
1. 会話外で `python ~/.claude/hooks/stopbug-calibrate.py` を実行する。
2. malformed の基準率・条件付き率（誤形式1回以降に追加が出る率）を確認する。
3. trip-wire（Phase 2）有効化が妥当なら `~/.ccpit/.stopbug-config.json` の
   `TRIPWIRE_ENABLED` を true にする（settings 変更は不要、config 更新のみ）。

## 手順 C — 重処理の直前（最小・弱い補助）
- 1 行だけ気を引き締める：「いまツール呼び出しを正しい形式で1つずつ出す」。
- これ以上の長い自己説教はしない（コンテキストを膨らませない）。本命は手順 A の移行。

## 禁止
- hook の reason やメモにツール呼び出し構文（`invoke` / `parameter` / `function_calls`）を再現しない。
- 「もっと賢く予測しよう」と凝った予測器を足さない。lever は移行。

## 参照
- [[priming-loop-recovery]] — 誤形式連続時の回復プロトコル（本 skill の上位規律）。
- [[cc-state-declaration]] — 安全な完了点での自己再起動・移行動線。
- 観測本体: `~/.claude/hooks/stopbug-observe.py`、較正: `stopbug-calibrate.py`。
