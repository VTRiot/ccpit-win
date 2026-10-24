#!/bin/bash
# debug-report-gate.sh — debug-toolkit skill の強制インターロック Stop hook
#
# 出力方式: exit 0 + JSON（decision: "block"）
# ※ exit 2 は stdout JSON を無視するため使用しない（公式仕様）
#
# 判定ロジック:
#   1. プロジェクト配下の _Prompt/_DebugReports/ または _Prompt/{01_FromBuilderAi,02_buildai}/_DebugReports/ を探す
#      (find -type f で深い階層も探索するため、新命名 02_buildai/ も追加コード変更なしで対応)
#   2. 該当ディレクトリ配下に debug-report-*.md があるか確認
#   3. なければ → exit 0（debug-toolkit が発火していない、または既に完了済み）
#   4. あれば、各ファイルのフロントマターで status をチェック
#      - status: completed → スキップ
#      - status: in_progress または status なし → 必須セクションが埋まっているか検証
#   5. 必須セクションが空 → exit 0 + JSON block + reason
#
# 必須セクション（見出しの行の頭がこの文字列で、その後ろ（空白は読み飛ばす）が行の終わり・「【」「（」「(」なら一致。
# ひな形の「【必須】」などの後ろの文字は許す。日本語のひな形と英語のひな形（golden の en）のどちらの見出しでもよい）:
#   ## 1. 観察事実 ／ ## 1. Observed Facts
#   ## 2. 使用した型 ／ ## 2. Pattern in Use
#   ## 3. 仮説候補 ／ ## 3. Hypothesis Candidates
#   ## 4. 検証経過 ／ ## 4. Verification Process
#   ## 5. 真因と対処 ／ ## 5. Root Cause and Resolution
#   ## 6. 型カタログへの還元判定 ／ ## 6. Reduction to the Pattern Catalog
#
# §6 で "B"（新規型発見）が選択された場合は §7 も必須にする。
#
# 見出しはコードブロック（``` か ~~~ で囲んだ部分）の外の行だけを数える。
# 2026-09-28 069 M3: 以前は (1) 見出しの照合 "(\b|$)" が awk では単語の境界にならず、ひな形どおりの
# 「## 1. 観察事実【必須】」を見出しと認めず、埋めた報告書でも「セクションが空です」で止めていた
# (2) コードブロックの中の「## 」を見出しに数えていた (3) CRLF の報告書を読めなかった
# (4) 英語のひな形の見出しを知らず、英語の報告書を「見出しが見つかりません」で止めていた
# (5) status: completed と §6 の「B」をファイルのどこからでも拾っていた（今はフロントマターと §6 の中だけ）
# (6) status を前方一致で見ていた（completed-but-not も完了扱い）(7) grep に \s を使っていた（macOS の grep で働く保証がない）
# (8) 報告書のパスをエスケープせずに JSON に入れていた（Windows の C:\... で JSON が壊れ、止めるべきときに止まらない）
# (9) find の出力を改行で分けていた（改行を含むファイル名の報告書を検査できない）
# (10) 同じ必須の見出しが 2 つ以上あると中身を連結していた（今は §1〜§6 と、B のときの §7 のどれも、見出しが
# 複数あれば止める・check_section）。
# ファイル名の境界: ファイル名は NUL 区切りで 1 件ずつ読み、理由に入れるときは制御文字と UTF-8 として正しくない
# バイトを取り除いてから JSON にエスケープする（safe_name・json_escape）。

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"

# debug-report ファイルは下の while で探す（find -print0 で NUL 区切り。改行や " を含むファイル名でも 1 件として読む）

# 必須セクションのリスト（「日本語|英語」。どちらの見出しでも一致）
REQUIRED_SECTIONS=(
  "## 1. 観察事実|## 1. Observed Facts"
  "## 2. 使用した型|## 2. Pattern in Use"
  "## 3. 仮説候補|## 3. Hypothesis Candidates"
  "## 4. 検証経過|## 4. Verification Process"
  "## 5. 真因と対処|## 5. Root Cause and Resolution"
  "## 6. 型カタログへの還元判定|## 6. Reduction to the Pattern Catalog"
)
SECTION_6="## 6. 型カタログへの還元判定|## 6. Reduction to the Pattern Catalog"
SECTION_7="## 7. 新規型の提案|## 7. New Pattern Proposal"

# 見出し section（「|」で区切った候補のどれか）の節の中身を出す。見出しがコードブロックの外にあれば、
# 最初に __SECTION_FOUND__ の 1 行を出す。skip_code=1 のときは、コードブロックの行（フェンスの行と中身）を出さない。
# コードブロックの規則は CommonMark（行頭の空白 0〜3 個＋同じ文字 3 個以上・閉じは同じ文字で開き以上の数・
# 後ろは空白だけ）。awk の実装差（mawk・BWK awk）に備え、正規表現の {n,m} を使わない。
SECTION_AWK='
function lead(s,   n) { n = 0; while (n < 3 && substr(s, 1, 1) == " ") { s = substr(s, 2); n++ } return s }
function runlen(s, c,   n) { n = 0; while (substr(s, n + 1, 1) == c) n++; return n }
# 見出しの文字列の後ろ（空白を読み飛ばした後）に許すのは、行の終わり・「【」「（」「(」だけ（ひな形の
# 「【必須】」「（§6 で…）」「 (mandatory …)」の形）。「## 4. 検証経過の参考ログ」「## 5. Root Cause and
# Resolution Notes」のような別の見出しを必須の節と数えない。
# マルチバイトの「【」「（」は index() で見る（mawk はバイト単位・GNU awk は文字単位だが、どちらでも先頭一致は同じ）
function tail_ok(r) {
  while (substr(r, 1, 1) == " " || substr(r, 1, 1) == "\t") r = substr(r, 2)
  if (r == "" || substr(r, 1, 1) == "(") return 1
  return index(r, "【") == 1 || index(r, "（") == 1
}
function is_target(s,   i, n) {
  for (i = 1; i <= nalt; i++) {
    n = length(alts[i])
    if (substr(s, 1, n) == alts[i] && tail_ok(substr(s, n + 1))) return 1
  }
  return 0
}
BEGIN { nalt = split(section, alts, "|") }
{
  sub(/\r$/, "")
  t = lead($0)
  c = substr(t, 1, 1)
  code = 0
  if (fence_char == "") {
    if (c == "`" || c == "~") {
      n = runlen(t, c)
      if (n >= 3 && !(c == "`" && index(substr(t, n + 1), "`") > 0)) {
        fence_char = c; fence_len = n; code = 1
      }
    }
    if (!code && substr(t, 1, 3) == "## ") {
      in_section = 0
      if (is_target(t)) { in_section = 1; print "__SECTION_FOUND__"; next }
    }
  } else {
    code = 1
    if (c == fence_char) {
      n = runlen(t, c)
      if (n >= fence_len && substr(t, n + 1) ~ /^[ \t]*$/) { fence_char = ""; fence_len = 0 }
    }
  }
  if (in_section && !(skip_code && code)) print
}'

# フロントマター（1 行目の --- から次の --- まで）の行だけを出す
FRONTMATTER_AWK='
{ sub(/\r$/, "") }
NR == 1 { if ($0 == "---") { in_fm = 1; next } else { exit } }
in_fm && $0 == "---" { exit }
in_fm { print }'

# JSON の文字列の中身としてエスケープする（\ と " と改行・CR・タブ）。
# Windows の CLAUDE_PROJECT_DIR（C:\...）や、" を含むファイル名で JSON が壊れ、止めるべきときに止まらなくなるのを防ぐ
json_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\t'/\\t}
  s=${s//$'\r'/\\r}
  s=${s//$'\n'/\\n}
  printf '%s' "$s"
}

# 理由に入れるパスを、JSON の中に置ける文字だけにする: 制御文字（0x01〜0x1F・0x7F）を取り除き、
# UTF-8 として正しくないバイトを落とす（iconv -c）。iconv が無い環境では、表示できる ASCII 以外を ? にする
safe_name() {
  local s
  s=$(printf '%s' "$1" | LC_ALL=C tr -d '\001-\037\177')
  if command -v iconv >/dev/null 2>&1; then
    printf '%s' "$s" | iconv -f UTF-8 -t UTF-8 -c 2>/dev/null
  else
    printf '%s' "$s" | LC_ALL=C tr -c '\040-\176' '?'
  fi
}

# 理由の 1 行を足す（改行は本物の改行で持ち、出すときに json_escape する）
add_reason() {
  BLOCK_REASONS="${BLOCK_REASONS}- $(safe_name "$1"): $2"$'\n'
}

# 節の中身から、コメント・空行・テンプレートプレースホルダを除いた行
# （grep の正規表現は POSIX の [[:space:]] で書く。\s は macOS の grep で働く保証がない）
meaningful_lines() {
  grep -vE '^__SECTION_FOUND__$|^>|^$|^（ここに記述）|^[[:space:]]*-[[:space:]]*\[[[:space:]]*\]|^---' | head -5
}

# 必須の節 1 つを確かめる: 見出しがコードブロックの外にちょうど 1 つあり（0 は見出しが無い、2 つ以上は節の中身が
# 連結されて空の節を見逃しうるので止める）、中身に意味のある行が 1 行以上あること。
# $1 報告書 $2 見出し（「日本語|英語」） $3 見出しが無いときの理由・$4 空のときの理由（省略時は既定の文）
check_section() {
  local text label count missing empty
  text=$(awk -v section="$2" "$SECTION_AWK" "$1" 2>/dev/null)
  label="${2//|/' / '}"
  missing="'${label}' 見出しが見つかりません"
  empty="'${label}' セクションが空です"
  [ -n "$3" ] && missing=$3
  [ -n "$4" ] && empty=$4
  count=$(printf '%s\n' "$text" | grep -cx '__SECTION_FOUND__')
  if [ "$count" -eq 0 ]; then
    add_reason "$1" "$missing"
    return
  fi
  if [ "$count" -gt 1 ]; then
    add_reason "$1" "'${label}' 見出しが ${count} つあります（1 つにしてください）"
    return
  fi
  if [ -z "$(printf '%s\n' "$text" | meaningful_lines)" ]; then
    add_reason "$1" "$empty"
  fi
}

# 進行中の debug-report について必須セクションをチェック
BLOCK_REASONS=""

while IFS= read -r -d '' REPORT_FILE; do
  # フロントマターの status: completed ならスキップ（値は completed ちょうど。引用符と行末のコメントは許す）
  if awk "$FRONTMATTER_AWK" "$REPORT_FILE" 2>/dev/null | grep -qE "^status:[[:space:]]*[\"']?completed[\"']?[[:space:]]*(#.*)?\$"; then
    continue
  fi

  # 必須セクションごとに、見出しがちょうど 1 つあり、中身が空でないかチェック
  for SECTION in "${REQUIRED_SECTIONS[@]}"; do
    check_section "$REPORT_FILE" "$SECTION"
  done

  # §6 で "B" 選択時は §7 も必須（§6 の中の、コードブロックの外の「- [x] **B**」で判定）。§7 にも同じ確かめをする
  SECTION_6_TEXT=$(awk -v section="$SECTION_6" -v skip_code=1 "$SECTION_AWK" "$REPORT_FILE" 2>/dev/null)
  if printf '%s\n' "$SECTION_6_TEXT" | grep -qE '^[[:space:]]*-[[:space:]]*\[x\][[:space:]]*\*\*B\*\*'; then
    EMPTY_7="§6 で「B」を選択したのに §7 新規型の提案が空です"
    check_section "$REPORT_FILE" "$SECTION_7" "$EMPTY_7" "$EMPTY_7"
  fi
done < <(find "$PROJECT_DIR/_Prompt" -type f -name "debug-report*.md" -print0 2>/dev/null)

# 空セクションがあればブロック
if [ -n "$BLOCK_REASONS" ]; then
  REASON="debug-report の必須セクションが空欄のまま完了宣言を出そうとしています。debug-toolkit skill §1-2 強制インターロックにより、以下のセクションを埋めてから停止してください:"$'\n'"${BLOCK_REASONS}"$'\n'"完了する場合は、debug-report のフロントマターを 'status: completed' に変更してから停止してください。"
  cat <<EOF
{
  "decision": "block",
  "reason": "$(json_escape "$REASON")"
}
EOF
  exit 0
fi

exit 0
