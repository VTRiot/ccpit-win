#!/bin/bash
# pending-reaper.sh — Pending 刈り取り屋の SessionStart hook の bash 足場
#
# 責務分離: 本ファイル = 起動だけ。本体は隣の pending-reaper.cjs（源はリポジトリの _Tools/pending-reaper.cjs と同一）。
#   本体は stdin の cwd から上へ辿って台帳 _Prompt/01_designai/TASK_LEDGER.md を探し、無ければ沈黙する。
#   同じ SessionStart で並んで走った 2 本目（手元の直呼びの登録が残っている機械）は沈黙する。
# node が無い機械では何もしない（exit 0・無出力）。

command -v node >/dev/null 2>&1 || exit 0
DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
exec node "$DIR/pending-reaper.cjs"
