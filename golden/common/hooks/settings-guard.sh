#!/bin/bash
# settings-guard.sh — PreToolUse hook（settings.json 保護 + shell-aware 秘匿読取ガード）
#
# 出力方式: exit 0 + JSON（hookSpecificOutput.permissionDecision）
#
# 判定本体は同ディレクトリの settings-guard.py（python）。理由（成果物1 core / Marshal F1-F4）:
#  保護パス照合は glob→regex の実マッチ・パス正規化・settings.json deny の動的抽出を要し、
#  bash の小 allowlist では grep/sed/awk 等の reader を列挙し切れずバイパスされる（critical）。
#  python に集約し「保護パス到達 → 任意コマンド deny」モデルで根治する。
#
#  python3 不在の host のみ、本スクリプト末尾の bash fallback が動作する。fallback は生 JSON を
#  正規化して保護ディレクトリ・セグメント・command-only 秘匿規則を literal 走査する degraded な
#  best-effort であり、python 経路の完全な双子ではない（grep でシェル構文を完全パースするのは
#  原理的に不可能なため）。enforcement の保証は python3 経路が担う → デプロイ環境は python3 を
#  満たすこと（python3 可用性の health check 化は別途タスク）。fallback は fail-closed 寄り
#  （不確実なら deny 側）。bash 3.2 互換。

INPUT=$(cat)
DIR=$(cd "$(dirname "$0")" 2>/dev/null && pwd)

# ---- python3 判定本体へ委譲（通常経路） ---------------------------------------------------
# python3 を要求する（本体は py3 専用構文・非 ASCII リテラルを含むため py2 では動かない）。
# `python` は v3 の時のみ採用。判定本体の終了コードを捕捉し、異常終了時は fail-open させず
# bash fallback に倒す（Marshal M3）。
PY=""
if command -v python3 >/dev/null 2>&1; then
  PY=python3
elif command -v python >/dev/null 2>&1 && python -c 'import sys;sys.exit(0 if sys.version_info[0]==3 else 1)' >/dev/null 2>&1; then
  PY=python
fi
if [ -n "$PY" ] && [ -f "$DIR/settings-guard.py" ]; then
  OUT=$(printf '%s' "$INPUT" | "$PY" "$DIR/settings-guard.py" 2>/dev/null)
  RC=$?
  if [ "$RC" = "0" ]; then
    [ -n "$OUT" ] && printf '%s\n' "$OUT"
    exit 0
  fi
  # 判定本体が異常終了（クラッシュ/interpreter skew）→ 下の bash fallback で縮退判定（fail-closed 寄り）
fi

# ---- 最小 bash fallback（python 不在 host のみ） -------------------------------------------
deny() {
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$1"
  exit 0
}

# 抽出に依存せず、生 INPUT（JSON 全体）を正規化して走査する（Marshal N1: grep 抽出は JSON 内の
# エスケープ済クォートで切れ、`bash -c "cat ~/.ssh/x"` 等を取りこぼすため）。保護パス文字列は
# クォート/エスケープに関わらず生 JSON 中に現れるので、ここでは fail-closed 寄りに全体走査する。
HOME_LC=$(printf '%s' "$HOME" | tr 'A-Z' 'a-z')
# クォート除去（R6-1: `.s''sh` 連結難読化の縮退解消）+ 小文字化 + 空白圧縮 + エイリアス/スラッシュ正規化
NORM=$(printf '%s' "$INPUT" | tr -d "\"'" | tr 'A-Z' 'a-z' | tr -s ' ' \
  | sed "s#%userprofile%#$HOME_LC#g; s#\$home#$HOME_LC#g; s#\\\\#/#g; s#~/#$HOME_LC/#g; s#//*#/#g")

# (A) settings.json 編集保護（生 JSON 中に settings.json と .claude が同時に現れたら deny）
if printf '%s' "$NORM" | grep -qE 'settings(\.local)?\.json' \
  && printf '%s' "$NORM" | grep -qF '.claude'; then
  deny "settings.json の編集は禁止されています（hooks 二重防壁）。ルール変更はユーザー（人間）に直接依頼してください。"
fi

# (B) 保護ディレクトリ/セグメントの literal 照合（python 不在時の縮退保護。anchor-free 同名も含む）
for p in "/.ssh/" "/.aws/" "/.gnupg/" "/.kube/" "/.docker/" "/.npmrc" "/.netrc" \
         "/.password-store/" "/library/keychains/" "/credentials/" \
         "/etc/shadow" "/etc/gshadow" "/etc/sudoers" "/etc/krb5.keytab"; do
  printf '%s' "$NORM" | grep -qF "$p" && deny "保護パス '$p' へのアクセスをブロック（bash fallback 縮退保護）。"
done
printf '%s' "$NORM" | grep -qE '\.env([^.a-z0-9]|$)' \
  && deny "保護パス '*.env' へのアクセスをブロック（bash fallback 縮退保護）。"
# command-only 秘匿規則（env dump / security / keyctl / secret-tool / kwallet-query）の縮退保護
printf '%s' "$NORM" | grep -qE '(^|[ |;&("/])env( +-[a-z-]+)* *($|[|;&<>"])' \
  && deny "秘匿取得コマンド 'env'（dump）をブロック（bash fallback 縮退保護）。"
printf '%s' "$NORM" | grep -qE 'security (dump-keychain|export)' \
  && deny "秘匿取得コマンド 'security'（dump/export）をブロック（bash fallback 縮退保護）。"
printf '%s' "$NORM" | grep -qE 'security find-(generic|internet)-password.*-w' \
  && deny "秘匿取得コマンド 'security find-*-password -w' をブロック（bash fallback 縮退保護）。"
printf '%s' "$NORM" | grep -qE 'keyctl (read|print|pipe)|secret-tool (lookup|search)|kwallet-query' \
  && deny "秘匿取得コマンド（keyctl/secret-tool/kwallet-query）をブロック（bash fallback 縮退保護）。"
# 未解決のコマンド置換/動的パス構築は fail-closed（python 不在時の最小防御）
printf '%s' "$NORM" | grep -qE '\$\(|`|join-path' && \
  deny "未解決のコマンド置換/動的パス構築のため fail-closed でブロック（bash fallback）。"

exit 0
