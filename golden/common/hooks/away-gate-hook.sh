#!/bin/bash
# away-gate-hook.sh — AwayGate（離席中に機を使う呼び出しを止める番人）の PreToolUse hook の bash 足場
#
# 責務分離: 本ファイル = 「番人が居る機械か」の判定と起動だけ。判定本体は隣の away-gate-hook.cjs
#   （AwayGate の build 成果物 ~/.ccpit/away-gate/bin/away-gate-hook.cjs の写し。中身は変えない）。
#
# 番人（~/.ccpit/away-gate/bin/away-gate.cjs。AWAYGATE_HOME で上書き可）が居ない機械では何もしない:
#   node を起こさない・~/.ccpit/away-gate を作らない・deny を出さない（allow に倒れる）。
#   判定本体は番人が無くても allow に倒れるが、重い呼び出しのたびにログと起こしの claim を書き、
#   番人の起動を試みて失敗するので、足場で先に止める。
# node が無い機械でも何もしない（exit 0・無出力）。
#
# 出力: 判定本体の出力（deny のときの hookSpecificOutput の JSON）をそのまま通す。stdin もそのまま渡す。

AG_HOME="${AWAYGATE_HOME:-$HOME/.ccpit/away-gate}"
[ -f "$AG_HOME/bin/away-gate.cjs" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0
DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
exec node "$DIR/away-gate-hook.cjs"
