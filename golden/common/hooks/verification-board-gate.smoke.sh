#!/bin/bash
# verification-board-gate.smoke.sh — bash 足場（verification-board-gate.sh）の自動テスト。
#
# Codex レビュー指摘（テスト網羅性）対応: node 核は verification-board-gate.test.cjs で検証済み。
# 本スクリプトは bash 足場の mode 解決 / off / stop_hook_active / soft sentinel / strict 反復 /
# git 非 repo fail-open を isolated fixture で検証する（VBG_CONFIG/VBG_GATE_DIR/CLAUDE_PROJECT_DIR 注入）。
#
# 実行: bash verification-board-gate.smoke.sh  （終了コード 0=全 PASS / 1=FAIL）

GATE="$(cd "$(dirname "$0")" && pwd)/verification-board-gate.sh"
PASS=0
FAIL=0
TODAY=$(date +%Y%m%d)

ok()  { PASS=$((PASS+1)); echo "  OK  $1"; }
ng()  { FAIL=$((FAIL+1)); echo "  NG  $1 :: $2"; }

# fixture リポを作る: 視認待ち報告 MD（今日付け）+ 変更あり + （board_flag=1 ならボード HTML も置く）
make_repo() {
  local board_flag="$1"
  local repo
  repo=$(mktemp -d)
  mkdir -p "$repo/_Prompt/02_buildai"
  ( cd "$repo" && git init -q && git config user.email t@t && git config user.name t )
  printf -- '---\nstatus: completed-pending-user-verification\n---\n\n# body\n' \
    > "$repo/_Prompt/02_buildai/${TODAY}_0231_report.md"
  if [ "$board_flag" = "1" ]; then
    printf 'x' > "$repo/_Prompt/02_buildai/${TODAY}_視認ボード.html"
  fi
  echo "$repo"
}

# gate を叩いて stdout を返す。$1=mode, $2=repo, $3=stop_active(true/false), $4=session_id
run_gate() {
  local mode="$1" repo="$2" active="$3" sid="$4"
  local cfg gdir
  cfg=$(mktemp)
  gdir=$(mktemp -d)
  printf '{"verificationBoardMode":"%s"}\n' "$mode" > "$cfg"
  printf '{"session_id":"%s","stop_hook_active":%s}' "$sid" "$active" \
    | VBG_CONFIG="$cfg" VBG_GATE_DIR="$gdir" CLAUDE_PROJECT_DIR="$repo" bash "$GATE"
  rm -f "$cfg"; rm -rf "$gdir"
}

# shared gate dir 版（soft の sentinel を跨いで検証するため gdir を固定）
run_gate_shared() {
  local mode="$1" repo="$2" active="$3" sid="$4" cfg="$5" gdir="$6"
  printf '{"session_id":"%s","stop_hook_active":%s}' "$sid" "$active" \
    | VBG_CONFIG="$cfg" VBG_GATE_DIR="$gdir" CLAUDE_PROJECT_DIR="$repo" bash "$GATE"
}

echo "=== verification-board-gate.sh 足場テスト ==="

# 1. off → 非 block（空出力）
REPO=$(make_repo 0)
OUT=$(run_gate off "$REPO" false s-off)
[ -z "$OUT" ] && ok "off は非 block" || ng "off は非 block" "出力あり: $OUT"
rm -rf "$REPO"

# 2. strict + ボード無し → block
REPO=$(make_repo 0)
OUT=$(run_gate strict "$REPO" false s-strict)
echo "$OUT" | grep -q '"decision": "block"' && ok "strict + ボード無しは block" || ng "strict + ボード無しは block" "block 出力なし"
rm -rf "$REPO"

# 3. strict + ボード有り → 非 block
REPO=$(make_repo 1)
OUT=$(run_gate strict "$REPO" false s-strict2)
[ -z "$OUT" ] && ok "strict + ボード有りは非 block" || ng "strict + ボード有りは非 block" "出力あり: $OUT"
rm -rf "$REPO"

# 4. stop_hook_active=true → 非 block（無限ループ防止）
REPO=$(make_repo 0)
OUT=$(run_gate strict "$REPO" true s-active)
[ -z "$OUT" ] && ok "stop_hook_active=true は非 block" || ng "stop_hook_active=true は非 block" "出力あり: $OUT"
rm -rf "$REPO"

# 5. soft: 初回 block → 2回目（同 session・同 gate dir）非 block（sentinel）
REPO=$(make_repo 0)
CFG=$(mktemp); GDIR=$(mktemp -d)
printf '{"verificationBoardMode":"soft"}\n' > "$CFG"
OUT1=$(run_gate_shared soft "$REPO" false s-soft "$CFG" "$GDIR")
OUT2=$(run_gate_shared soft "$REPO" false s-soft "$CFG" "$GDIR")
if echo "$OUT1" | grep -q '"decision": "block"' && [ -z "$OUT2" ]; then
  ok "soft は初回 block・2回目は非 block（セッション1回）"
else
  ng "soft セッション1回" "OUT1=[$OUT1] OUT2=[$OUT2]"
fi
rm -f "$CFG"; rm -rf "$GDIR" "$REPO"

# 6. git 非 repo → fail-open（非 block）。CHANGES 検出が空になり通過。
NOREPO=$(mktemp -d)
mkdir -p "$NOREPO/_Prompt/02_buildai"
printf -- '---\nstatus: completed-pending-user-verification\n---\n' \
  > "$NOREPO/_Prompt/02_buildai/${TODAY}_0231_report.md"
OUT=$(run_gate strict "$NOREPO" false s-norepo)
[ -z "$OUT" ] && ok "git 非 repo は fail-open（非 block）" || ng "git 非 repo は fail-open" "出力あり: $OUT"
rm -rf "$NOREPO"

echo ""
echo "=== 足場テスト: ${PASS} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
