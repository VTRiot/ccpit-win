#!/bin/bash
# restart-request-gate.sh — CCPIT 一括再起動の代行(DELEGATE)経路 Stop hook
#
# 役割: CCPIT が設置した「再起動要求フラグ」を Stop（ターン終了）時に検知し、検知したら
#       block して「安全な完了点なので exit→`claude --resume` で自己再起動し設定を反映せよ」と促す。
#       稼働中(busy)・待機中(waiting)の CC は CCPIT から直接 kill せず、この hook で CC 自身が
#       安全な完了点（end_turn 後の Stop）に自己再起動することでタスク中断を避ける。
#
# 出力方式: exit 0 + JSON（decision: "block"）。※ exit 2 は stdout JSON を無視するため使わない（公式仕様）。
#
# フラグ: ~/.ccpit/.restart-requests/<session_id>.json （CCPIT main の sessionRestart が設置）。
#         検知したら consume（削除）してから一度だけ block する。
#         consume 済み + stop_hook_active による無限ループ防止で「要求につき一度」を担保する。

REQ_DIR="$HOME/.ccpit/.restart-requests"

INPUT=$(cat)

# --- session_id を抽出（公式スキーマ記載。skill-proposal-gate と同じ grep/sed 流儀） ---
SESSION_ID=$(echo "$INPUT" \
  | grep -oE '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' \
  | head -1 \
  | sed -E 's/.*"session_id"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')
# ファイル名安全化（UUID はハイフン保持。欠落時は何もできないので通過）。
SAFE_ID=$(printf '%s' "$SESSION_ID" | tr -cd 'A-Za-z0-9_-')
[ -z "$SAFE_ID" ] && exit 0

FLAG="$REQ_DIR/${SAFE_ID}.json"

# フラグが無ければ通過（再起動要求なし）。
[ -f "$FLAG" ] || exit 0

# --- stop_hook_active（無限ループ防止の補助）。true なら通過 ---
ACTIVE=$(echo "$INPUT" \
  | grep -oE '"stop_hook_active"[[:space:]]*:[[:space:]]*(true|false)' \
  | head -1 \
  | grep -oE '(true|false)')
if [ "$ACTIVE" = "true" ]; then
  exit 0
fi

# consume: 先に削除してから block（次 Stop 以降は素通り＝要求につき一度）。
rm -f "$FLAG" 2>/dev/null

cat <<'EOF'
{
  "decision": "block",
  "reason": "CCPIT から設定反映のための再起動要求があります。いまは安全な完了点（ターン終了）です。クリーン引き継ぎメモ（目的・完了済み・次操作のみ。誤形式出力は引用しない）を残し、`/exit` で一度終了してから `claude --resume <このセッションID>` で再起動し、変更後の settings/hooks/skills/plugins を反映してください。（再起動要求フラグは consume 済み＝この要求につき一度だけ）"
}
EOF
exit 0
