#!/bin/bash
# report-gate.sh — 報告書出し忘れ防止 Stop hook
# CCPIT v1.1 Phase E-1: PIKES r1 §9-5 空隙補充ルール対応
#
# 出力方式: exit 0 + JSON（decision: "block"）
# ※ exit 2 は stdout JSON を無視するため使用しない（公式仕様）
#
# 判定ロジック:
#   1. git status --porcelain で未コミットのコード変更があるか確認
#      （追跡済み変更 + 未追跡ファイル両方を検出。.bak / CLAUDE.local.md は除外）
#   2. コード変更がなければ → exit 0（通過）
#   3. コード変更があれば → 報告書 MD を 2 段階で探索:
#      A. 空隙補充ルール (PIKES r1 §9-5): 今日付け MD の frontmatter から
#         output_dir フィールド抽出 → 指定ディレクトリで再 find
#      B. glob フォールバック: _Prompt 配下を再帰的に *frombuilderai* / *buildai*
#         でディレクトリ検出 → 各候補で今日付けファイル find
#   4. 見つかれば exit 0、なければ decision: block

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"

# 追跡済みファイルの変更 + 未追跡ファイル（新規作成）の両方を検出
CHANGES=$(git -C "$PROJECT_DIR" status --porcelain 2>/dev/null \
  | grep -v '\.bak' \
  | grep -v 'CLAUDE\.local\.md' \
  | head -1)

if [ -z "$CHANGES" ]; then
  exit 0
fi

TODAY_8=$(date +%Y%m%d)
TODAY_6=$(date +%y%m%d)

# === A. 空隙補充ルール (PIKES r1 §9-5): output_dir 抽出 → 抽出先で find ===
# 今日付けの MD から frontmatter output_dir フィールドを抽出し、
# 明示されたディレクトリで報告書を探索する (瑞 ZGB Art.1(2) 転写)。
# ファイル名先頭の日付は 8 桁 (YYYYMMDD) / 6 桁 (YYMMDD) 両対応 (CCDG2 既存規約 + 指示書例)。
EXTRACTED_FOUND=""
if [ -d "${PROJECT_DIR}/_Prompt" ]; then
  EXTRACTED_FOUND=$(find "${PROJECT_DIR}/_Prompt" \
      \( -name "${TODAY_8}_*.md" -o -name "${TODAY_6}_*.md" \) -type f 2>/dev/null \
    | while IFS= read -r md; do
        [ -z "$md" ] && continue
        OD=$(grep -E '^output_dir:' "$md" 2>/dev/null \
          | head -1 \
          | sed -E 's/^output_dir:[[:space:]]*//; s/[[:space:]]*#.*$//; s/[[:space:]]*$//; s/^["'"'"']//; s/["'"'"']$//')
        [ -z "$OD" ] && continue
        case "$OD" in
          /*) TARGET_DIR="$OD" ;;
          *)  TARGET_DIR="${PROJECT_DIR}/${OD}" ;;
        esac
        find "$TARGET_DIR" -maxdepth 1 \
          \( -name "${TODAY_8}_*" -o -name "${TODAY_6}_*" \) -type f 2>/dev/null
      done \
    | head -1)
fi

if [ -n "$EXTRACTED_FOUND" ]; then
  exit 0
fi

# === B. glob フォールバック (旧 *frombuilderai* / 新 *buildai* 両対応、深い階層) ===
# プロジェクトによってディレクトリ名が異なるため、_Prompt/ 配下を再帰的に検索する。
# Phase E-1 拡張: 旧命名 *frombuilderai* + 新命名 *buildai* を OR で両対応化。
REPORT_DIRS=$(find "${PROJECT_DIR}/_Prompt" -type d \
  \( -iname "*frombuilderai*" -o -iname "*buildai*" \) 2>/dev/null)

if [ -n "$REPORT_DIRS" ]; then
  FOUND=$(echo "$REPORT_DIRS" | while read -r d; do
    [ -z "$d" ] && continue
    find "$d" -maxdepth 1 \
      \( -name "${TODAY_8}_*" -o -name "${TODAY_6}_*" \) -type f 2>/dev/null
  done | head -1)
  if [ -n "$FOUND" ]; then
    exit 0
  fi
fi

cat <<EOF
{
  "decision": "block",
  "reason": "コード変更が検出されましたが、報告書MDが見つかりません。次のいずれかで対応してください: (a) 報告書 frontmatter に 'output_dir: <パス>' を明示し、そのディレクトリに ${TODAY_8}_*.md または ${TODAY_6}_*.md を配置 (PIKES r1 §9-5 空隙補充ルール), (b) _Prompt/ 配下の *frombuilderai* または *buildai* を含むディレクトリに ${TODAY_8}_HHMM_内容の要約.md を配置。テスタブル実装シーケンス Step D（報告書MD作成）を完了してから停止してください。"
}
EOF
exit 0
