#!/bin/bash
# file-url-backtick-gate.sh — 裸の file:/// URL 禁止 Stop hook（bash 足場）
#
# 責務分離（testable-stop-hook-gate-authoring §1）: 本ファイル = 「今 block すべきか」。
# 判定本体 = file-url-backtick-detect.cjs。出力方式: exit 0 + JSON。exit 2 は使わない。
# mode 正本: ~/.ccpit/app-config.json の fileUrlBacktickGateMode（無指定・破損時は strict）。

INPUT=$(cat)
DIR=$(cd "$(dirname "$0")" && pwd)
CONFIG="${FUBG_CONFIG:-$HOME/.ccpit/app-config.json}"
DETECT="${FUBG_DETECT:-$DIR/file-url-backtick-detect.cjs}"
SDIR="${FUBG_SENTINEL_DIR:-$HOME/.claude/hooks/.fubg-sentinels}"

printf '%s' "$INPUT" | grep -q '"stop_hook_active"[[:space:]]*:[[:space:]]*true' && exit 0

MODE=""
if [ -f "$CONFIG" ]; then
  MODE=$(grep -oE '"fileUrlBacktickGateMode"[[:space:]]*:[[:space:]]*"[^"]*"' "$CONFIG" 2>/dev/null \
    | head -1 | sed -E 's/.*"fileUrlBacktickGateMode"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')
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

OUT=$(printf '%s' "$INPUT" | FUBG_STDIN_JSON=1 node "$DETECT" 2>/dev/null)
if [ -n "$OUT" ]; then
  if [ "$MODE" = "soft" ] && [ -n "$SAFE_ID" ]; then
    mkdir -p "$SDIR" 2>/dev/null
    touch "$SDIR/$SAFE_ID" 2>/dev/null
  fi
  printf '%s\n' "$OUT"
fi
exit 0
