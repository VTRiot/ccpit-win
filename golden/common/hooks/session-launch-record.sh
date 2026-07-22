#!/bin/bash
# session-launch-record.sh — SessionStart hook
#
# 役割: このセッションが「どの settings generation をロードして起動したか」を記録する。
#       起動（startup）/再開（resume）いずれの SessionStart でも、その時点の現 generation を
#       記録する。よって resume 直後は最新 generation を持ち、restart-all-gate が再発火しない。
#       Stop hook(restart-all-gate) が「loaded-gen < 現 generation」で自己再起動を判定する基準値。
#
# 起動形: exec form 前提（settings.json で {"command":"<bash>","args":["<this>"]}）。
#         bare `.sh`/`shell:"bash"` は端末 Windows CC で不発（Phase 0 V1 実証）。

CCPIT_DIR="$HOME/.ccpit"
FLAG="$CCPIT_DIR/.restart-all.json"
GENDIR="$CCPIT_DIR/.session-gen"

INPUT=$(cat 2>/dev/null)
SID=$(printf '%s' "$INPUT" \
  | grep -oE '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' \
  | head -1 \
  | sed -E 's/.*"session_id"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')
SAFE=$(printf '%s' "$SID" | tr -cd 'A-Za-z0-9_-')
[ -z "$SAFE" ] && exit 0

# 現 generation を読む（全体フラグ無し → 0）
GEN=0
if [ -f "$FLAG" ]; then
  GEN=$(grep -oE '"generation"[[:space:]]*:[[:space:]]*[0-9]+' "$FLAG" 2>/dev/null | head -1 | grep -oE '[0-9]+')
  [ -z "$GEN" ] && GEN=0
fi

mkdir -p "$GENDIR" 2>/dev/null
printf '%s' "$GEN" > "$GENDIR/$SAFE" 2>/dev/null
exit 0
