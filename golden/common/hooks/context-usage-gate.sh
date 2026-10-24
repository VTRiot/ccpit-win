#!/bin/bash
# context-usage-gate.sh — Stop hook 薄いラッパ（stopbug-observe-gate.sh の二層 fail-open 型踏襲・CCPIT 049）
#
# 役割: stdin の hook 入力 JSON を node 検出核 context-usage-detect.cjs へ渡し、
#       その stdout を形状 allowlist で検査してから通す（§5④ Codex 指摘[2]の採用形）。
#
# 出力契約: 単一行 {"systemMessage":"<JSON文字列>"} のみ通過。
#           複数行・非 JSON・他キー含み・部分 JSON・デバッグ debris はすべて破棄する。
#   ※ この allowlist を拡張する場合（例: 将来 suppressOutput を足す等）は、
#     本コメントと下の grep 正規表現を**同時に・意図的に**更新すること。黙った拡張は禁止。
#
# advisory 専用: decision の語彙を持たん。node 不在・本体失敗・出力不正を含む
# いかなる場合も fail-open（exit 0・無出力）で Stop を決してブロックしない
# （hook が Stop を妨げると全作業が止まる＝停止バグより悪い）。

INPUT=$(cat 2>/dev/null)
DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"

command -v node >/dev/null 2>&1 || exit 0

OUT=$(printf '%s' "$INPUT" | node "$DIR/context-usage-detect.cjs" 2>/dev/null)

# 無出力（警告不要・内部失敗）はそのまま通す
[ -z "$OUT" ] && exit 0

# 複数行は契約違反 → 破棄
NL='
'
case "$OUT" in
  *"$NL"*) exit 0 ;;
esac

# 単一キー {"systemMessage":"…"} 形のみ通過（値中のエスケープ \" \\ 等は許容）
# grep は LC_ALL=C でバイトとして照らす: ja_JP.UTF-8 等のロケールでは多バイト（🟣・全角）を含む行が [^"\\] に合わず、
# 警告が一度も出なかった（2026-10-21 実測・L0_013 W4。意味は変えない）
printf '%s' "$OUT" | LC_ALL=C grep -qE '^\{"systemMessage":"([^"\\]|\\.)*"\}$' || exit 0

printf '%s\n' "$OUT"
exit 0
