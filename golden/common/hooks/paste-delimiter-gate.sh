#!/bin/bash
# paste-delimiter-gate.sh — 貼り付け文の区切り義務化 Stop hook（bash 足場）
#
# 責務分離（testable-stop-hook-gate-authoring §1）:
#   本ファイル = 「今 block すべきか」: stop_hook_active 再入抑止・mode 解決（off/soft/strict）・soft の
#   セッション 1 回 sentinel。判定本体 = paste-delimiter-detect.cjs（純粋検出核）。検出核が完成 block-JSON を
#   出すので、本足場は printf するのみ（JSON エスケープ事故ゼロ）。
#
# 出力方式: exit 0 + JSON（decision: "block"）。exit 2 は使わない。
# mode 正本: ~/.ccpit/app-config.json の pasteDelimiterGateMode（無指定・破損時は strict）。
#   「同じ是正を 5 回言わされた」案件なので既定は strict（毎ターン検査）。

INPUT=$(cat)
DIR=$(cd "$(dirname "$0")" && pwd)
CONFIG="${PDG_CONFIG:-$HOME/.ccpit/app-config.json}"
DETECT="${PDG_DETECT:-$DIR/paste-delimiter-detect.cjs}"
SDIR="${PDG_SENTINEL_DIR:-$HOME/.claude/hooks/.pdg-sentinels}"

printf '%s' "$INPUT" | grep -q '"stop_hook_active"[[:space:]]*:[[:space:]]*true' && exit 0

MODE=""
if [ -f "$CONFIG" ]; then
  MODE=$(grep -oE '"pasteDelimiterGateMode"[[:space:]]*:[[:space:]]*"[^"]*"' "$CONFIG" 2>/dev/null \
    | head -1 | sed -E 's/.*"pasteDelimiterGateMode"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')
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

OUT=$(printf '%s' "$INPUT" | PDG_STDIN_JSON=1 node "$DETECT" 2>/dev/null)
if [ -n "$OUT" ]; then
  if [ "$MODE" = "soft" ] && [ -n "$SAFE_ID" ]; then
    mkdir -p "$SDIR" 2>/dev/null
    touch "$SDIR/$SAFE_ID" 2>/dev/null
  fi
  printf '%s\n' "$OUT"
fi
exit 0
