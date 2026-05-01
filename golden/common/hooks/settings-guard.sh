#!/bin/bash
# settings-guard.sh — settings.json 保護 PreToolUse hook
#
# 出力方式: exit 0 + JSON（hookSpecificOutput）
# ※ PreToolUse は hookSpecificOutput.permissionDecision を使用する

INPUT=$(cat)

FILE_PATH=$(echo "$INPUT" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' \
  | head -1 | sed 's/"file_path"[[:space:]]*:[[:space:]]*"//' | sed 's/"$//')

if echo "$FILE_PATH" | grep -qE '(settings\.json|settings\.local\.json)'; then
  if echo "$FILE_PATH" | grep -qE '\.claude'; then
    cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "settings.json の編集は禁止されています（hooks 二重防壁）。ルール変更が必要な場合はユーザー（人間）に直接依頼してください。"
  }
}
EOF
    exit 0
  fi
fi

exit 0
