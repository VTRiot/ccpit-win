#!/bin/bash
# stopbug-observe-gate.sh — Stop hook 薄いラッパ（settings-guard.sh/.py の二層パターン踏襲）。
# stdin の hook 入力 JSON を python 本体 stopbug-observe.py に渡すだけ。
# python 不在・本体失敗を含むいかなる場合も fail-open（exit 0・無出力）で
# Stop を決してブロックしない（hook が Stop を妨げると全作業が止まる＝停止バグより悪い）。

INPUT=$(cat 2>/dev/null)
DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"

PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
done

# python 不在 → degraded（観測できないが Stop は通す）
if [ -z "$PY" ]; then exit 0; fi

printf '%s' "$INPUT" | "$PY" "$DIR/stopbug-observe.py" 2>/dev/null
exit 0
