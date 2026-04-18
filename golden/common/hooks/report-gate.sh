#!/bin/bash
# report-gate.sh — 報告書出し忘れ防止 Stop hook
#
# 出力方式: exit 0 + JSON（decision: "block"）
# ※ exit 2 は stdout JSON を無視するため使用しない（公式仕様）
#
# 判定ロジック:
#   1. git diff で未コミットのコード変更があるか確認（.bak / CLAUDE.local.md は除外）
#   2. コード変更がなければ → exit 0（通過）
#   3. コード変更があれば → _Prompt/_frombuilderai/ に今日の日付の MD があるか確認
#   4. あれば → exit 0（通過）
#   5. なければ → exit 0 + JSON block（ブロック）

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"

CHANGES=$(git -C "$PROJECT_DIR" diff --name-only HEAD 2>/dev/null \
  | grep -v '\.bak' \
  | grep -v 'CLAUDE\.local\.md' \
  | head -1)

if [ -z "$CHANGES" ]; then
  exit 0
fi

TODAY=$(date +%Y%m%d)

# プロジェクトによってディレクトリ名が異なるため（_frombuilderai / 01_FromBuilderAi 等）、
# _Prompt/ 配下で *frombuilderai* にマッチするディレクトリを glob 検出する。
REPORT_DIRS=$(find "${PROJECT_DIR}/_Prompt" -maxdepth 1 -type d -iname "*frombuilderai*" 2>/dev/null)

if [ -n "$REPORT_DIRS" ]; then
  FOUND=$(echo "$REPORT_DIRS" | while read -r d; do
    find "$d" -maxdepth 1 -name "${TODAY}_*" -type f 2>/dev/null
  done | head -1)
  if [ -n "$FOUND" ]; then
    exit 0
  fi
fi

cat <<EOF
{
  "decision": "block",
  "reason": "コード変更が検出されましたが、報告書MDが _Prompt/_frombuilderai/ に出力されていません。テスタブル実装シーケンス Step D（報告書MD作成）を完了してから停止してください。ファイル名: ${TODAY}_HHMM_内容の要約.md"
}
EOF
exit 0
