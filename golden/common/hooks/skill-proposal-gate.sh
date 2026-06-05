#!/bin/bash
# skill-proposal-gate.sh — skill-proposal-emitter 自動発火ループ Stop hook（CCPIT Part B / A1+B1）
#
# 役割: セッション終了で「Skill 化候補の提案 MD（候補が無ければ該当なし）」を出すよう促す。
#       report-gate（コード変更時のみ）とは発火条件を分離し、調査のみセッションでも発火する。
#
# 出力方式: exit 0 + JSON（decision: "block"）。※ exit 2 は stdout JSON を無視するため使わない（公式仕様）。
#
# 発火モード（~/.ccpit/app-config.json の "emissionMode"。未設定/不明 → 既定 soft）:
#   soft  (既定): セッションにつき一度だけ block。
#   strict      : 提案/該当なしが出るまで新 stop（=各ターン終了）毎に block。ノイズ大。
#   off         : 何もしない（opt-in 運用）。
#
# 【セッション1回の実装根拠】
#   Claude Code の Stop hook は「各ターン終了」毎に発火する（公式 hooks-guide）。
#   stop_hook_active は hooks-guide の例にあるが公式 reference の入力スキーマには未記載で、
#   これ単独では「セッション1回」を保証できない（保証されてもターン毎にしかならない）。
#   公式スキーマに記載され セッション内で安定な session_id をキーにしたセンチネルで「セッション1回」を担保する。
#   stop_hook_active は（存在すれば）無限ループ防止の補助として併用する。

CONFIG="$HOME/.ccpit/app-config.json"
GATE_DIR="$HOME/.ccpit/.proposal-gate"
DEFAULT_MODE="soft"
# センチネル保持日数（housekeeping。古いセッションの空マーカーが無限に溜まるのを防ぐだけの値）。
SENTINEL_RETENTION_DAYS=7

INPUT=$(cat)

# --- emissionMode を解決（jq 非依存。report-gate と同じ grep/sed 流儀） ---
MODE=""
if [ -f "$CONFIG" ]; then
  MODE=$(grep -oE '"emissionMode"[[:space:]]*:[[:space:]]*"[^"]*"' "$CONFIG" 2>/dev/null \
    | head -1 \
    | sed -E 's/.*"emissionMode"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')
fi
case "$MODE" in
  soft|strict|off) : ;;
  *) MODE="$DEFAULT_MODE" ;;
esac

# off は即通過
if [ "$MODE" = "off" ]; then
  exit 0
fi

# --- stop_hook_active（補助の無限ループ防止）。存在し true なら通過 ---
ACTIVE=$(echo "$INPUT" \
  | grep -oE '"stop_hook_active"[[:space:]]*:[[:space:]]*(true|false)' \
  | head -1 \
  | grep -oE '(true|false)')
if [ "$ACTIVE" = "true" ]; then
  exit 0
fi

# --- session_id を抽出（公式スキーマ記載。セッション識別子） ---
SESSION_ID=$(echo "$INPUT" \
  | grep -oE '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' \
  | head -1 \
  | sed -E 's/.*"session_id"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')
# ファイル名に使える文字へ正規化。欠落時は固定名（その場合 soft はプロセス横断で実質1回）。
SAFE_ID=$(printf '%s' "$SESSION_ID" | tr -cd 'A-Za-z0-9_-')
[ -z "$SAFE_ID" ] && SAFE_ID="no-session"
SENTINEL="$GATE_DIR/${SAFE_ID}.seen"

mkdir -p "$GATE_DIR" 2>/dev/null
# housekeeping: 古いセンチネルを掃除（失敗は無視）
find "$GATE_DIR" -name '*.seen' -type f -mtime +${SENTINEL_RETENTION_DAYS} -delete 2>/dev/null

# soft: このセッションで既にリマインド済みなら通過（センチネル存在）
if [ "$MODE" = "soft" ] && [ -f "$SENTINEL" ]; then
  exit 0
fi

# soft の初回リマインドはセンチネルを先に作る（次 stop 以降は素通り＝セッション1回を保証）
if [ "$MODE" = "soft" ]; then
  touch "$SENTINEL" 2>/dev/null
fi

# block（soft 初回 / strict）
cat <<'EOF'
{
  "decision": "block",
  "reason": "このセッションで skill-proposal-emitter による提案 MD がまだ出ていません。skill-proposal-emitter を発火し、Skill 化が有益な候補があれば提案 MD を、無ければ『該当なし』(adoption_label: reject) を ~/.ccpit/proposals/ に出力してから停止してください。（提案ループの起点＝センシング。emissionMode で抑制可: soft=セッション1回 / strict=毎ターン / off=無効）"
}
EOF
exit 0
