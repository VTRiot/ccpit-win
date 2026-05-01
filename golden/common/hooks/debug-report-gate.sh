#!/bin/bash
# debug-report-gate.sh — debug-toolkit skill の強制インターロック Stop hook
#
# 出力方式: exit 0 + JSON（decision: "block"）
# ※ exit 2 は stdout JSON を無視するため使用しない（公式仕様）
#
# 判定ロジック:
#   1. プロジェクト配下の _Prompt/_DebugReports/ または _Prompt/01_FromBuilderAi/_DebugReports/ を探す
#   2. 該当ディレクトリ配下に debug-report-*.md があるか確認
#   3. なければ → exit 0（debug-toolkit が発火していない、または既に完了済み）
#   4. あれば、各ファイルのフロントマターで status をチェック
#      - status: completed → スキップ
#      - status: in_progress または status なし → 必須セクションが埋まっているか検証
#   5. 必須セクションが空 → exit 0 + JSON block + reason
#
# 必須セクション:
#   ## 1. 観察事実
#   ## 2. 使用した型
#   ## 3. 仮説候補
#   ## 4. 検証経過
#   ## 5. 真因と対処
#   ## 6. 型カタログへの還元判定
#
# §6 で "B"（新規型発見）が選択された場合は §7 も必須にする。

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"

# debug-report ファイルを探す
REPORT_FILES=$(find "$PROJECT_DIR/_Prompt" -type f -name "debug-report*.md" 2>/dev/null)

if [ -z "$REPORT_FILES" ]; then
  exit 0
fi

# 必須セクションのリスト
REQUIRED_SECTIONS=(
  "## 1. 観察事実"
  "## 2. 使用した型"
  "## 3. 仮説候補"
  "## 4. 検証経過"
  "## 5. 真因と対処"
  "## 6. 型カタログへの還元判定"
)

# 進行中の debug-report について必須セクションをチェック
BLOCK_REASONS=""

while IFS= read -r REPORT_FILE; do
  # status: completed ならスキップ
  if grep -qE '^status:\s*completed' "$REPORT_FILE" 2>/dev/null; then
    continue
  fi

  # 必須セクションごとに、見出し直後のコンテンツが空でないかチェック
  for SECTION in "${REQUIRED_SECTIONS[@]}"; do
    # 見出しの存在を確認
    if ! grep -qF "$SECTION" "$REPORT_FILE" 2>/dev/null; then
      BLOCK_REASONS="${BLOCK_REASONS}- ${REPORT_FILE}: '${SECTION}' 見出しが見つかりません\n"
      continue
    fi

    # 見出しの直後から次の見出しまでの内容を抽出して、空でないか確認
    # awk で見出しから次の見出しまでを取り出し、コメント・空行・テンプレートプレースホルダ を除いた行が
    # 1 行以上あるかをチェックする
    CONTENT=$(awk -v section="$SECTION" '
      $0 ~ "^" section "(\\b|$)" { in_section=1; next }
      in_section && /^## / { in_section=0 }
      in_section { print }
    ' "$REPORT_FILE" | grep -vE '^>|^$|^（ここに記述）|^\s*-\s*\[\s*\]|^---' | head -5)

    if [ -z "$CONTENT" ]; then
      BLOCK_REASONS="${BLOCK_REASONS}- ${REPORT_FILE}: '${SECTION}' セクションが空です\n"
    fi
  done

  # §6 で "B" 選択時は §7 も必須
  if grep -qE '^\s*-\s*\[x\]\s*\*\*B\*\*' "$REPORT_FILE" 2>/dev/null; then
    SECTION_7="## 7. 新規型の提案"
    CONTENT_7=$(awk -v section="$SECTION_7" '
      $0 ~ "^" section "(\\b|$)" { in_section=1; next }
      in_section && /^## / { in_section=0 }
      in_section { print }
    ' "$REPORT_FILE" | grep -vE '^>|^$|^（ここに記述）|^\s*-\s*\[\s*\]|^---' | head -5)

    if [ -z "$CONTENT_7" ]; then
      BLOCK_REASONS="${BLOCK_REASONS}- ${REPORT_FILE}: §6 で「B」を選択したのに §7 新規型の提案が空です\n"
    fi
  fi
done <<< "$REPORT_FILES"

# 空セクションがあればブロック
if [ -n "$BLOCK_REASONS" ]; then
  cat <<EOF
{
  "decision": "block",
  "reason": "debug-report の必須セクションが空欄のまま完了宣言を出そうとしています。debug-toolkit skill §1-2 強制インターロックにより、以下のセクションを埋めてから停止してください:\n${BLOCK_REASONS}\n完了する場合は、debug-report のフロントマターを 'status: completed' に変更してから停止してください。"
}
EOF
  exit 0
fi

exit 0
