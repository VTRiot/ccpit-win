#!/usr/bin/env python3
# stopbug-calibrate.py — オフライン較正（会話外で手動実行）。
#   ~/.claude/stopbug-observe.jsonl を集計し、停止バグの基準率・context 分布・
#   trip-wire 閾値の経験的較正材料を表示する。予測器ではなく「trip-wire 閾値較正」用。
#
# 使い方:
#   python stopbug-calibrate.py [path-to-jsonl]
#   （省略時は ~/.claude/stopbug-observe.jsonl）
#
# 出力（標準出力）:
#   - 総ターン数・総セッション数・観測期間
#   - malformed-stop 件数 / 発生率（ターン基準・セッション基準）
#   - 「セッション内で malformed が1回出た後、同セッションで追加 malformed が出る条件付き率」
#     ＝設計メモの仮説『誤形式1回以降リスク急騰』の経験的検証
#   - observed_usage_tokens（input+cache_read）の分布（malformed 時 / 非 malformed 時）

import json
import os
import sys
from collections import defaultdict


def home():
    return os.environ.get("HOME") or os.environ.get("USERPROFILE") or ""


def load(path):
    recs = []
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    recs.append(json.loads(line))
                except Exception:
                    continue
    except Exception as e:
        print("ログを読めません: %s (%s)" % (path, e))
    return recs


def ctx_total(u):
    if not isinstance(u, dict):
        return None
    vals = [u.get("input_tokens"), u.get("cache_read_input_tokens"),
            u.get("cache_creation_input_tokens")]
    nums = [v for v in vals if isinstance(v, (int, float))]
    return sum(nums) if nums else None


def pct(values, p):
    if not values:
        return None
    s = sorted(values)
    k = int(round((len(s) - 1) * p))
    return s[k]


def summarize(recs):
    n = len(recs)
    if n == 0:
        print("レコードがありません（まだ観測が溜まっていない）。")
        return
    sessions = defaultdict(list)
    for r in recs:
        sessions[r.get("session_id", "?")].append(r)
    ts = [r.get("ts") for r in recs if isinstance(r.get("ts"), (int, float))]
    span_days = ((max(ts) - min(ts)) / 86400.0) if len(ts) >= 2 else 0.0

    malformed = [r for r in recs if r.get("malformed_this_turn")]
    mf_turn_rate = len(malformed) / n
    mf_sessions = set(r.get("session_id") for r in malformed)
    sess_rate = len(mf_sessions) / len(sessions)

    # 条件付き率: malformed が1回出たセッションで、その後さらに malformed が出たか
    after_first_more = 0
    sessions_with_mf = 0
    for sid, rs in sessions.items():
        rs_sorted = sorted(rs, key=lambda x: x.get("ts") or 0)
        seen = False
        more = False
        for r in rs_sorted:
            if r.get("malformed_this_turn"):
                if seen:
                    more = True
                seen = True
        if seen:
            sessions_with_mf += 1
            if more:
                after_first_more += 1
    cond = (after_first_more / sessions_with_mf) if sessions_with_mf else None

    ctx_mf = [ctx_total(r.get("observed_usage_tokens")) for r in malformed]
    ctx_mf = [c for c in ctx_mf if c is not None]
    ctx_ok = [ctx_total(r.get("observed_usage_tokens")) for r in recs if not r.get("malformed_this_turn")]
    ctx_ok = [c for c in ctx_ok if c is not None]

    print("=== stopbug 較正サマリ ===")
    print("総ターン数        : %d" % n)
    print("総セッション数     : %d" % len(sessions))
    print("観測期間(日)       : %.1f" % span_days)
    print("malformed ターン   : %d  (ターン発生率 %.3f%%)" % (len(malformed), mf_turn_rate * 100))
    print("malformed セッション: %d / %d  (セッション発生率 %.1f%%)" % (
        len(mf_sessions), len(sessions), sess_rate * 100))
    if cond is not None:
        print("条件付き率（1回目以降に追加 malformed）: %d/%d = %.1f%%" % (
            after_first_more, sessions_with_mf, cond * 100))
        print("  → 設計仮説『誤形式1回以降リスク急騰』の経験的指標。"
              "高ければ trip-wire（1回目観測で即移行推奨）が妥当。")
    else:
        print("条件付き率: まだ malformed セッションが無く算出不能。")
    print("--- context(observed_usage_tokens 合計) 分布 ---")
    print("malformed時  median=%s p90=%s max=%s (n=%d)" % (
        pct(ctx_mf, 0.5), pct(ctx_mf, 0.9), max(ctx_mf) if ctx_mf else None, len(ctx_mf)))
    print("非malformed  median=%s p90=%s max=%s (n=%d)" % (
        pct(ctx_ok, 0.5), pct(ctx_ok, 0.9), max(ctx_ok) if ctx_ok else None, len(ctx_ok)))
    print("注: context はトークン量が根因でないため hard trigger にはしない（較正参考のみ）。")
    print()
    print("=== 推奨アクション ===")
    if len(malformed) == 0:
        print("- malformed 未観測。観測継続。trip-wire 有効化は時期尚早。")
    else:
        print("- malformed を観測済み。trip-wire（Phase 2）有効化を検討可。")
        print("  ~/.ccpit/.stopbug-config.json の TRIPWIRE_ENABLED を true にする")
        print("  （settings は変更不要。config ファイルの更新のみ）。")


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(home(), ".claude", "stopbug-observe.jsonl")
    summarize(load(path))


if __name__ == "__main__":
    main()
