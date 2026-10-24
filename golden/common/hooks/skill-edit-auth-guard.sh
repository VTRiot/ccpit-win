#!/bin/bash
# skill-edit-auth-guard.sh — skill ファイル(知見資産) 保護 PreToolUse hook
#
# 親: 009r3 Plan (Option C). CCPIT 本体が skill-target apply 非対応のため、
#     真の password-gate は CCPIT 側 CCPIT 拡張完了まで保留。本 hook は
#     その前提整備として「CC による ~/.claude/skills/**/SKILL.md 直接編集」を
#     deny-only で物理ブロックする(hook 単独マーカー方式は CC 偽造可=偽ガード
#     のため不採用)。既存 settings-guard.sh とは独立(本ファイル単独で
#     ロールバック可能)。settings-guard.sh は一切変更しない。
#
# 出力方式: exit 0 + JSON(hookSpecificOutput)
# ※ PreToolUse は hookSpecificOutput.permissionDecision を使用する
#   (settings-guard.sh と同一方式)

INPUT=$(cat)

FILE_PATH=$(echo "$INPUT" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' \
  | head -1 | sed 's/"file_path"[[:space:]]*:[[:space:]]*"//' | sed 's/"$//')

# パス区切り正規化: JSON 内 Windows パスは "\\" 二重エスケープ。
# 連続するバックスラッシュ/スラッシュを単一 "/" に畳んでから判定する。
NORM=$(printf '%s' "$FILE_PATH" | tr '\\' '/' | tr -s '/')

# 一致条件: ~/.claude/skills/<skill 名>/SKILL.md (末尾完全一致)
# - SKILL.md のみ保護(補助 .md は初版対象外)
# - "SKILL.md.bak.*" は末尾 "SKILL.md$" 不一致のため自然に除外
if echo "$NORM" | grep -qE '\.claude/skills/[^/]+/SKILL\.md$'; then
  cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "skill ファイル(知見資産)の CC 直接編集は禁止です。変更は CCPIT skill-change 経由でパスワード認証のうえ適用してください(CCPIT 拡張で対応予定、CCPIT へ申し送り済)。暫定で人手反映が必要な場合は maintainer に直接依頼してください。"
  }
}
EOF
  exit 0
fi

exit 0
