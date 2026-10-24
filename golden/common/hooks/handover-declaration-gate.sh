#!/bin/bash
# handover-declaration-gate.sh — 「発注の型」宣言義務化 Stop hook（bash 足場）
#
# 責務分離（testable-stop-hook-gate-authoring §1）:
#   本ファイル = 「今 block すべきか」: stop_hook_active 再入抑止・mode 解決（off/soft/strict）・soft の
#   セッション 1 回 sentinel。判定本体 = handover-declaration-detect.cjs（純粋検出核）。検出核が完成
#   block-JSON を出すので、本足場は printf するのみ（JSON エスケープ事故ゼロ）。
#
# 独立ゲート（CCPIT_071）: 兄弟ゲート paste-delimiter-gate.sh / opaque-approval-gate.sh には一切相乗り
#   しない。設定キーも別（handoverDeclarationGateMode）。既存ゲートを off にしても本ゲートは止まらない。
#
# 出力方式: exit 0 + JSON（decision: "block"）。exit 2 は使わない。
# mode 正本: ~/.ccpit/app-config.json の handoverDeclarationGateMode（無指定・破損時は strict）。

INPUT=$(cat)
DIR=$(cd "$(dirname "$0")" && pwd)
CONFIG="${HDG_CONFIG:-$HOME/.ccpit/app-config.json}"
DETECT="${HDG_DETECT:-$DIR/handover-declaration-detect.cjs}"
SDIR="${HDG_SENTINEL_DIR:-$HOME/.claude/hooks/.hdg-sentinels}"

printf '%s' "$INPUT" | grep -q '"stop_hook_active"[[:space:]]*:[[:space:]]*true' && exit 0

MODE=""
if [ -f "$CONFIG" ]; then
  MODE=$(grep -oE '"handoverDeclarationGateMode"[[:space:]]*:[[:space:]]*"[^"]*"' "$CONFIG" 2>/dev/null \
    | head -1 | sed -E 's/.*"handoverDeclarationGateMode"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')
fi
case "$MODE" in soft|strict|off) : ;; *) MODE=strict ;; esac
[ "$MODE" = "off" ] && exit 0

command -v node >/dev/null 2>&1 || exit 0
[ -f "$DETECT" ] || exit 0

SID=$(printf '%s' "$INPUT" | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
SAFE_ID=$(printf '%s' "$SID" | tr -cd 'A-Za-z0-9_-')

if [ "$MODE" = "soft" ] && [ -n "$SAFE_ID" ] && [ -f "$SDIR/$SAFE_ID" ]; then
  exit 0
fi

OUT=$(printf '%s' "$INPUT" | HDG_STDIN_JSON=1 node "$DETECT" 2>/dev/null)
if [ -n "$OUT" ]; then
  if [ "$MODE" = "soft" ] && [ -n "$SAFE_ID" ]; then
    mkdir -p "$SDIR" 2>/dev/null
    touch "$SDIR/$SAFE_ID" 2>/dev/null
  fi
  printf '%s\n' "$OUT"
fi
exit 0
