#!/bin/bash
# restart-all-gate.sh — Stop hook（DELEGATE 主軸）
#
# 役割: CCPIT が設定変更時に立てる「全体フラグ」(generation 整数) を読み、
#       自分のロード済み generation < 現 generation かつ未再起動なら、安全な完了点（ターン終了）で
#       自己 exit→`claude --resume <自分の session_id>` を促す（設定反映）。
#       - 同窓内で claude が入れ替わる → 窓位置は自動保持（DIRECT のような外部 kill 不要）。
#       - session_id は CC 自身が hook 入力で知る → CCPIT 側の pid↔sessionId 紐付け不要。
#       - 紐付け不能な waiting/busy CC も、次の Stop で自己再起動して救われる。
#
# generation 方式（Codex #3/#7 反映）: wall-clock でなく単調増加の整数で判定（race/clock-skew 回避）。
#   loaded-gen は session-launch-record.sh が SessionStart で記録。完了 = loaded-gen >= 現 generation。
#   再帰ブロック防止は stop_hook_active（sentinel 不使用 — 一度 /exit を無視すると stale 固定になる Codex 指摘ゆえ）。
# 起動形: exec form 前提（bare `.sh`/`shell:"bash"` は端末 Windows CC で不発・Phase 0 V1 実証）。
# 出力: exit 0 + JSON decision:block（公式仕様。exit 2 は使わない）。

CCPIT_DIR="$HOME/.ccpit"
FLAG="$CCPIT_DIR/.restart-all.json"
GENDIR="$CCPIT_DIR/.session-gen"

INPUT=$(cat 2>/dev/null)

# 全体フラグの generation（無し → 何もしない）
[ -f "$FLAG" ] || exit 0
GEN=$(grep -oE '"generation"[[:space:]]*:[[:space:]]*[0-9]+' "$FLAG" 2>/dev/null | head -1 | grep -oE '[0-9]+')
[ -z "$GEN" ] && exit 0
case "$GEN" in ''|*[!0-9]*) exit 0 ;; esac
[ "$GEN" -le 0 ] && exit 0

# session_id
SID=$(printf '%s' "$INPUT" \
  | grep -oE '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' \
  | head -1 \
  | sed -E 's/.*"session_id"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')
SAFE=$(printf '%s' "$SID" | tr -cd 'A-Za-z0-9_-')
[ -z "$SAFE" ] && exit 0

# 無限ループ防止補助（再帰 stop は通過）
ACTIVE=$(printf '%s' "$INPUT" | grep -oE '"stop_hook_active"[[:space:]]*:[[:space:]]*(true|false)' | head -1 | grep -oE '(true|false)')
[ "$ACTIVE" = "true" ] && exit 0

# ロード済み generation（無し → 0 = 未ロード扱い）
LOADED=0
if [ -f "$GENDIR/$SAFE" ]; then
  LOADED=$(grep -oE '[0-9]+' "$GENDIR/$SAFE" 2>/dev/null | head -1)
  [ -z "$LOADED" ] && LOADED=0
fi
case "$LOADED" in ''|*[!0-9]*) LOADED=0 ;; esac

# 完了判定 = 既に最新 generation をロード済み（実再起動で session-launch-record.sh が更新）→ 何もしない。
# Codex 指摘対応: sentinel を「generation につき一度」の完了扱いにすると、一度 /exit を無視した CC が
# 二度と促されず設定 stale で固定される。stop_hook_active（上で通過済）が同一 Stop 内の再帰ブロックを防ぐので、
# 未再起動（LOADED < GEN）の間は次ターン以降も促し続け、実再起動で LOADED が GEN に追いついた時点で自然停止する。
[ "$LOADED" -ge "$GEN" ] && exit 0

cat <<'EOF'
{
  "decision": "block",
  "reason": "CCPIT から設定変更（全体再起動要求）があります。いまは安全な完了点（ターン終了）です。クリーン引き継ぎメモ（目的・完了済み・次操作のみ。誤形式出力は引用しない）を残し、`/exit` で一度終了してから `claude --resume <このセッションID>` で再起動し、変更後の settings/hooks/skills/plugins を反映してください。（同窓内で再開されるため窓位置は保持されます。再起動するまで次のターンでも促します）"
}
EOF
exit 0
