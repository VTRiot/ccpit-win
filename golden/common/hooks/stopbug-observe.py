#!/usr/bin/env python3
# stopbug-observe.py — Stop hook 観測本体（stopbug-observe-gate.sh から呼ばれる）
#
# 目的: 停止バグ（誤形式ツール呼び出し→自己プライミング）を harness 層で予防する。
#   真の根治＝serving 層の constrained decoding は Anthropic 側のみ。当層では
#   「外形 observable の観測ログ」＋「汚染文脈を早く切る trip-wire→移行」を担う。
#
# 設計原則（厳守）:
#   - ログるのは外形 observable のみ（文脈長 usage / 当ターン malformed 有無 /
#     tool_use 密度 / タスク外形）。モデルの内省＝作話は信用しない。
#   - 主役は trip-wire→移行。リマインダは弱い補助。凝った予測器は作らない。
#   - 低コンテキストコスト: 通常ターンは exit 0・無出力。会話に何も注入しない。
#   - fail-open 厳守: いかなる例外でも exit 0・無出力。Stop を決してブロックしない
#     （hook が壊れて Stop を妨げると停止バグより悪い＝全作業が止まる）。
#
# Phase 制:
#   Phase 1 = 観測のみ（TRIPWIRE_ENABLED=False）。malformed trip-wire は出さない。
#             ただし「時限タイマー」: 初回観測から D 日経過で 1 回だけ較正を促す inert 行。
#   Phase 2 = TRIPWIRE_ENABLED=True。malformed 観測済セッションで移行推奨を 1 回出す。
#
# malformed-stop の機械シグネチャ（実トランスクリプトで誤検知なく分離を確認）:
#   stop_reason=="end_turn" ∧ 当ターンに tool_use ブロック無し
#     ∧ text ブロックが高特異度のツール呼び出し構文に合致。

import json
import os
import re
import sys
import time

# ---- 設定（既定値。~/.ccpit/.stopbug-config.json で上書き可。可監査な定数） ----
DEFAULT_CONFIG = {
    "TRIPWIRE_ENABLED": False,   # Phase 1 = False（観測のみ）
    "HARVEST_DAYS": 7,           # 時限タイマー: 初回観測から N 日で較正を促す
    "HARVEST_MALFORMED_K": 5,    # 早期発火: malformed 観測セッションが K 件に達したら前倒し
}

LOG_NAME = "stopbug-observe.jsonl"
STATE_DIRNAME = ".stopbug-state"
CONFIG_NAME = ".stopbug-config.json"

# 高特異度の malformed 構文シグネチャ（小さく可監査に固定）。
# 実データ: 本文 text ブロックに `<invoke name="Skill">` `<parameter name="skill">`
# 等が「完全な開始タグ」として残り、tool_use が生成されず stop_reason=end_turn で停止する。
# 誤検知対策（Codex#3）: 散文での断片引用（`<invoke name=` のみ等）を弾くため、
#   引用値 "..." と閉じ `>` まで揃った「完全タグ」を要求する。
_RE_INVOKE = re.compile(r'<\s*(?:antml:)?invoke\s+name\s*=\s*"[^"]+"\s*>', re.IGNORECASE)
_RE_PARAM = re.compile(r'<\s*(?:antml:)?parameter\s+name\s*=\s*"[^"]+"\s*>', re.IGNORECASE)
_RE_FUNCCALLS = re.compile(r"<\s*(?:antml:)?function_calls\s*>", re.IGNORECASE)


def _home():
    return os.environ.get("HOME") or os.environ.get("USERPROFILE") or ""


def _claude_dir():
    return os.path.join(_home(), ".claude")


def _ccpit_dir():
    return os.path.join(_home(), ".ccpit")


def _load_config():
    cfg = dict(DEFAULT_CONFIG)
    try:
        p = os.path.join(_ccpit_dir(), CONFIG_NAME)
        with open(p, "r", encoding="utf-8") as fh:
            user = json.load(fh)
        if isinstance(user, dict):
            for k in DEFAULT_CONFIG:
                if k in user:
                    cfg[k] = user[k]
    except Exception:
        pass
    return cfg


def _looks_malformed(text):
    """text ブロックが誤形式ツール呼び出し構文を含むか（高特異度）。

    誤検知対策（Codex）: 完全な invoke 開始タグ `<invoke name="...">` を**必要条件**にし、
    さらに完全な parameter タグ or function_calls ラッパの共起を要求する。
    これにより `function_calls` 等を散文で単発引用しただけのケースを弾く
    （実 malformed は必ず invoke を伴う）。
    """
    if not text:
        return False
    if not _RE_INVOKE.search(text):
        return False
    return bool(_RE_PARAM.search(text) or _RE_FUNCCALLS.search(text))


def _read_transcript_tail(path, max_bytes=1048576, max_records=4000):
    """JSONL の末尾最大 max_bytes だけを読み、最新 max_records 件をパース（fail-open）。

    巨大トランスクリプト（数 MB）でも末尾のみ読むことでメモリ/レイテンシを有界化し、
    Stop hook が「ハングしたように見える」リスクを避ける（Codex）。最後のターンは
    末尾に来るため末尾走査で十分。
    """
    recs = []
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as fh:
            if size > max_bytes:
                fh.seek(size - max_bytes)
                fh.readline()  # 先頭の途中行は捨てる
            data = fh.read()
    except Exception:
        return recs
    try:
        text = data.decode("utf-8", "replace")
    except Exception:
        return recs
    for line in text.splitlines()[-max_records:]:
        line = line.strip()
        if not line:
            continue
        try:
            recs.append(json.loads(line))
        except Exception:
            continue
    return recs


def _last_assistant_turn(recs):
    """末尾の assistant ターン群を返す。requestId 優先、無ければ末尾連続 assistant。"""
    last_idx = None
    for i in range(len(recs) - 1, -1, -1):
        if isinstance(recs[i], dict) and recs[i].get("type") == "assistant":
            last_idx = i
            break
    if last_idx is None:
        return []
    last = recs[last_idx]
    rid = last.get("requestId") or (last.get("message") or {}).get("id")
    group = []
    if rid:
        for r in recs:
            if not isinstance(r, dict) or r.get("type") != "assistant":
                continue
            r_rid = r.get("requestId") or (r.get("message") or {}).get("id")
            if r_rid == rid:
                group.append(r)
    if not group:
        # requestId 欠落: 末尾から連続する assistant レコードを束ねる
        i = last_idx
        while i >= 0 and isinstance(recs[i], dict) and recs[i].get("type") == "assistant":
            group.append(recs[i])
            i -= 1
        group.reverse()
    return group


def _analyze_turn(group):
    """ターン群から observable を算出。"""
    stop_reason = None
    has_tool_use = False
    malformed = False
    tool_use_count = 0
    usage = {}
    for r in group:
        msg = r.get("message") or {}
        if msg.get("stop_reason"):
            stop_reason = msg.get("stop_reason")
        u = msg.get("usage")
        if isinstance(u, dict):
            usage = u
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        for b in content:
            if not isinstance(b, dict):
                continue
            bt = b.get("type")
            if bt == "tool_use":
                has_tool_use = True
                tool_use_count += 1
            elif bt == "text":
                if _looks_malformed(b.get("text") or ""):
                    malformed = True
    malformed_stop = (
        stop_reason == "end_turn" and not has_tool_use and malformed
    )
    observed = {
        "input_tokens": usage.get("input_tokens"),
        "cache_read_input_tokens": usage.get("cache_read_input_tokens"),
        "cache_creation_input_tokens": usage.get("cache_creation_input_tokens"),
    }
    return {
        "stop_reason": stop_reason,
        "turn_tooluse_count": tool_use_count,
        "malformed_this_turn": bool(malformed_stop),
        "observed_usage_tokens": observed,
    }


def _safe_makedirs(d):
    try:
        os.makedirs(d, exist_ok=True)
    except Exception:
        pass


def _append_log(record):
    try:
        p = os.path.join(_claude_dir(), LOG_NAME)
        line = json.dumps(record, ensure_ascii=False) + "\n"
        with open(p, "a", encoding="utf-8") as fh:
            fh.write(line)
    except Exception:
        pass


def _state_dir():
    return os.path.join(_ccpit_dir(), STATE_DIRNAME)


def _touch(path, content=""):
    try:
        _safe_makedirs(os.path.dirname(path))
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(content)
        return True
    except Exception:
        return False


def _exists(path):
    try:
        return os.path.exists(path)
    except Exception:
        return False


def _read_text(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except Exception:
        return None


def _emit_block(reason):
    """Stop hook の block 出力（UTF-8 bytes 直接）。出力後 exit 0。"""
    payload = json.dumps(
        {"decision": "block", "reason": reason},
        ensure_ascii=False, separators=(",", ":"),
    ) + "\n"
    try:
        sys.stdout.buffer.write(payload.encode("utf-8"))
        sys.stdout.buffer.flush()
    except Exception:
        try:
            sys.stdout.write(payload)
        except Exception:
            pass
    sys.exit(0)


def main():
    raw = sys.stdin.read()
    try:
        data = json.loads(raw)
    except Exception:
        return
    if not isinstance(data, dict):
        return

    # 再入防止: Stop hook が block→継続→再 Stop のループを避ける。
    if data.get("stop_hook_active") is True:
        return

    session_id = str(data.get("session_id") or "unknown")
    transcript_path = data.get("transcript_path") or ""
    cwd = data.get("cwd") or ""

    cfg = _load_config()
    sdir = _state_dir()
    _safe_makedirs(sdir)

    # --- transcript 走査（fail-open） ---
    analysis = {
        "stop_reason": None,
        "turn_tooluse_count": 0,
        "malformed_this_turn": False,
        "observed_usage_tokens": {},
    }
    slug = None
    try:
        recs = _read_transcript_tail(transcript_path) if transcript_path else []
        group = _last_assistant_turn(recs)
        if group:
            analysis = _analyze_turn(group)
        for r in recs:
            if isinstance(r, dict) and r.get("slug"):
                slug = r.get("slug")
                break
    except Exception:
        pass

    # --- per-session 状態の正本（O(1)） ---
    sess_malformed_flag = os.path.join(sdir, "%s.malformed" % session_id)
    malformed_seen = _exists(sess_malformed_flag)
    if analysis["malformed_this_turn"] and not malformed_seen:
        _touch(sess_malformed_flag, str(int(time.time())))
        malformed_seen = True
        # malformed 観測セッション数カウンタ（早期発火用）
        cnt_path = os.path.join(sdir, ".malformed-count")
        try:
            cur = int(_read_text(cnt_path) or "0")
        except Exception:
            cur = 0
        _touch(cnt_path, str(cur + 1))

    # --- 初回観測時刻（時限タイマー基準。golden 非管理パスに永続） ---
    first_log_path = os.path.join(sdir, ".first-log")
    now = int(time.time())
    if not _exists(first_log_path):
        _touch(first_log_path, str(now))

    # --- 観測ログ追記（較正専用・fail-open） ---
    _append_log({
        "ts": now,
        "session_id": session_id,
        "cwd": cwd,
        "slug": slug,
        "observed_usage_tokens": analysis["observed_usage_tokens"],
        "turn_tooluse_count": analysis["turn_tooluse_count"],
        "stop_reason": analysis["stop_reason"],
        "malformed_this_turn": analysis["malformed_this_turn"],
        "malformed_seen_session": malformed_seen,
    })

    # --- (Phase 2) malformed trip-wire: 移行推奨を 1 回（reason はツール構文を含めない） ---
    # TRIPWIRE_ENABLED は厳格に bool True のみ有効（"false"/"0" 等の文字列で誤有効化しない, Codex）。
    if cfg.get("TRIPWIRE_ENABLED") is True and malformed_seen:
        tripped = os.path.join(sdir, "%s.tripped" % session_id)
        # sentinel の永続化に成功した時のみ emit（書込失敗時は沈黙＝再発火を防ぐ, Codex）。
        if not _exists(tripped) and _touch(tripped, str(now)):
            _emit_block(
                "停止バグの兆候（誤形式出力）を当セッションで観測した。"
                "クリーンな引き継ぎメモ（目的・完了済み・次操作のみ）を残し、"
                "セッションを移行して汚染文脈を切ることを推奨する。詳細は stopbug-guard。"
            )

    # --- (Phase 1+) 時限タイマー: 初回観測から D 日 or malformed K 件で較正を 1 回促す ---
    harvested = os.path.join(sdir, ".harvested")
    if not _exists(harvested):
        try:
            first_ts = int(_read_text(first_log_path) or str(now))
        except Exception:
            first_ts = now
        days = float(cfg.get("HARVEST_DAYS", 7))
        try:
            mcount = int(_read_text(os.path.join(sdir, ".malformed-count")) or "0")
        except Exception:
            mcount = 0
        due_time = (now - first_ts) >= int(days * 86400)
        due_count = mcount >= int(cfg.get("HARVEST_MALFORMED_K", 5))
        # sentinel の永続化に成功した時のみ emit（書込失敗時は沈黙＝毎ターン再発火を防ぐ, Codex）。
        if (due_time or due_count) and _touch(harvested, str(now)):
            _emit_block(
                "停止バグ観測データが収集期間に達した。"
                "stopbug-calibrate を実行して閾値を較正し、trip-wire（Phase 2）の"
                "有効化を検討してほしい。"
            )


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        # fail-open: 何があっても Stop をブロックしない
        pass
    sys.exit(0)
