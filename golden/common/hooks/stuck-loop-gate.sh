#!/bin/bash
# stuck-loop-gate.sh — 同一理由の反復発火を CC へ知らせる Stop hook（bash 足場）
#
# 責務分離（report-gate.sh / report-detect.cjs と同じ型）:
#   本ファイル = 「実行できるか」: node と検出核の存在確認と、核の出力が**許可した形**であることの検証のみ。
#   本体       = stuck-loop-detect.cjs（transcript 走査・判定・文言生成）。
#
# 出力方式: exit 0 + JSON。核の出力を、次の許可形のどちらかに **JSON パース後に** 一致した時だけ転送する:
#   (v3/v4 核) {"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"<string>"}}  — 最上位キーはこれのみ
#   (v1 核)    {"systemMessage":"<string>"}                                                     — 最上位キーはこれのみ
#   転送条件: 核の終了値 0・出力が上の形に一致。どれか欠けたら沈黙。
#   2026-09-12 Codex 第 2 巡 指摘 17: 文字列検査（*"decision"*）は "decision" のようなエスケープで素通りし、
#   null・配列・数値も通していた → 形の**ホワイトリスト**に変更。decision キーはそもそも許可形に無い。
#   2026-09-12 Codex 第 3 巡 限定事項: 転送するのは核の元の文字列ではなく、検査済みオブジェクトを再シリアライズした
#   文字列（重複キーが後勝ちで検査を通っても、受信側には検査したとおりの 1 通りしか渡らない）。
#   **block しない。** 既存ゲートの「満たされるまで鳴る」設計（report-gate.sh:11-17）には触れない。
#
# fail の倒れる向き: node 不在 / 核不在 / 核の異常終了 / 形が違う → いずれも沈黙 exit 0。

INPUT=$(cat)
DIR=$(cd "$(dirname "$0")" && pwd)
CORE="${SLD_CORE:-$DIR/stuck-loop-detect.cjs}"

command -v node >/dev/null 2>&1 || exit 0
[ -f "$CORE" ] || exit 0

OUT=$(printf '%s' "$INPUT" | node "$CORE" 2>/dev/null)
RC=$?
[ "$RC" -eq 0 ] || exit 0
[ -n "$OUT" ] || exit 0

# 形の検証（パース後の構造で判定。文字列検査は使わない）。通れば検査済みオブジェクトを再シリアライズして stdout へ。
NORM=$(printf '%s' "$OUT" | node -e '
let s = ""
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  let j
  try { j = JSON.parse(s) } catch (e) { process.exit(1) }
  if (!j || typeof j !== "object" || Array.isArray(j)) process.exit(1)
  const keys = Object.keys(j)
  if (keys.length === 1 && keys[0] === "systemMessage" && typeof j.systemMessage === "string") {
    process.stdout.write(JSON.stringify({ systemMessage: j.systemMessage }))
    process.exit(0)
  }
  if (keys.length === 1 && keys[0] === "hookSpecificOutput") {
    const h = j.hookSpecificOutput
    if (h && typeof h === "object" && !Array.isArray(h)) {
      const hk = Object.keys(h).sort()
      if (hk.length === 2 && hk[0] === "additionalContext" && hk[1] === "hookEventName" &&
          h.hookEventName === "Stop" && typeof h.additionalContext === "string") {
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "Stop", additionalContext: h.additionalContext } }))
        process.exit(0)
      }
    }
  }
  process.exit(1)
})
' 2>/dev/null) || exit 0
[ -n "$NORM" ] || exit 0
printf '%s\n' "$NORM"
exit 0
