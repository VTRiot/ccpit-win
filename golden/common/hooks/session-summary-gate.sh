#!/bin/bash
# session-summary-gate.sh — セッション終了 SOR/EOR 三点要約 義務化 Stop hook（CCPIT）
#
# 役割: やり取り終了時に「(本流の)やったこと / 提案した SkillProposal の概要+ファイル名+フルパス /
#       レビュー対象の報告書 or 複数時の Bundle フルパス」の三点を SOR/EOR で CC ウィンドウへ出力させる。
#       SkillProposal 等の割り込みで「何のやり取りだったか」が埋もれる問題の恒久対策。
#
# 出力方式: exit 0 + JSON（decision: "block"）。※ exit 2 は stdout JSON を無視するため使わない（公式仕様）。
#
# 発火モード（~/.ccpit/app-config.json の "sessionSummaryMode"。未設定/不明 → 既定 soft）:
#   soft  (既定): セッションにつき一度だけ block。
#   strict      : 各 stop（ターン終了）毎に block。ノイズ大。
#   off         : 何もしない。
#
# 順序保証（skill-proposal-gate との関係）:
#   要約は「提案ファイルのフルパス」を含むため、skill-proposal-gate が提案 MD を排出した後に出す必要がある。
#   注意: skill-proposal-gate(soft) は提案 MD の「排出前」に自身のセンチネルを作る。よってそのセンチネルの
#   有無では「排出済み」を判定できない（Codex 差分レビュー P2）。そこで本ゲートは「proposal ゲートが有効な
#   間は最初の stop を arm して 1 stop 見送り、次 stop で要約を出す」方式を採る。これにより proposal 排出の
#   ターンが先に完了してから要約が出る。proposal が off / gate 不在 のときは arm せず即評価する。

CONFIG="$HOME/.ccpit/app-config.json"
GATE_DIR="$HOME/.ccpit/.summary-gate"
PROPOSAL_HOOK="$HOME/.claude/hooks/skill-proposal-gate.sh"
DEFAULT_MODE="soft"
SENTINEL_RETENTION_DAYS=7

INPUT=$(cat)

# --- sessionSummaryMode を解決（jq 非依存。proposal-gate と同じ grep/sed 流儀） ---
MODE=""
if [ -f "$CONFIG" ]; then
  MODE=$(grep -oE '"sessionSummaryMode"[[:space:]]*:[[:space:]]*"[^"]*"' "$CONFIG" 2>/dev/null \
    | head -1 \
    | sed -E 's/.*"sessionSummaryMode"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')
fi
case "$MODE" in
  soft|strict|off) : ;;
  *) MODE="$DEFAULT_MODE" ;;
esac

# off は即通過
if [ "$MODE" = "off" ]; then
  exit 0
fi

# --- stop_hook_active（補助の無限ループ防止）。存在し true なら通過 ---
ACTIVE=$(echo "$INPUT" \
  | grep -oE '"stop_hook_active"[[:space:]]*:[[:space:]]*(true|false)' \
  | head -1 \
  | grep -oE '(true|false)')
if [ "$ACTIVE" = "true" ]; then
  exit 0
fi

# --- session_id を抽出（公式スキーマ記載） ---
SESSION_ID=$(echo "$INPUT" \
  | grep -oE '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' \
  | head -1 \
  | sed -E 's/.*"session_id"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')
SAFE_ID=$(printf '%s' "$SESSION_ID" | tr -cd 'A-Za-z0-9_-')

mkdir -p "$GATE_DIR" 2>/dev/null
# housekeeping: 古いセンチネル/arm マーカーを掃除（失敗は無視）
find "$GATE_DIR" -type f \( -name '*.seen' -o -name '*.armed' \) -mtime +${SENTINEL_RETENTION_DAYS} -delete 2>/dev/null

# --- 順序保証(arm 方式): proposal ゲートが有効なら最初の stop は arm して 1 stop 見送り、
#     提案 MD 排出の次 stop で要約を出す（proposal センチネルは排出前に作られ当てにならない / Codex P2）。---
PROP_MODE=""
if [ -f "$CONFIG" ]; then
  PROP_MODE=$(grep -oE '"emissionMode"[[:space:]]*:[[:space:]]*"[^"]*"' "$CONFIG" 2>/dev/null \
    | head -1 \
    | sed -E 's/.*"emissionMode"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')
fi
case "$PROP_MODE" in
  soft|strict|off) : ;;
  *) PROP_MODE="soft" ;;
esac
if [ -n "$SAFE_ID" ] && [ -f "$PROPOSAL_HOOK" ] && [ "$PROP_MODE" != "off" ]; then
  ARMED="$GATE_DIR/${SAFE_ID}.armed"
  if [ ! -f "$ARMED" ]; then
    touch "$ARMED" 2>/dev/null
    # 1 stop 見送り（提案ゲートを先に通し、提案 MD 排出ターンを完了させる）。自身のセンチネルは作らない。
    exit 0
  fi
fi

# session_id 欠落時はセンチネルで dedup せず毎回 block（no-session で広く抑止しない / Codex Med 反映）。
if [ -n "$SAFE_ID" ]; then
  SENTINEL="$GATE_DIR/${SAFE_ID}.seen"
  # soft: 既にリマインド済みなら通過
  if [ "$MODE" = "soft" ] && [ -f "$SENTINEL" ]; then
    exit 0
  fi
  # soft の初回はセンチネルを先に作る（次 stop 以降は素通り＝セッション1回を保証）
  if [ "$MODE" = "soft" ]; then
    touch "$SENTINEL" 2>/dev/null
  fi
fi

# block（soft 初回 / strict / session_id 欠落）。reason は単一文字列（JSON 整形崩れ防止）。
cat <<'EOF'
{
  "decision": "block",
  "reason": "このセッションのやり取りが終了します。停止前に、次の三点要約を ---SOR--- と ---EOR--- で囲んで CC ウィンドウへ出力してください。\n【本流の作業】このセッションで本流として何をしたか（簡潔に）。\n【SkillProposal】提案の概要と adoption_label（recommend/reject）、提案ファイル名とそのフルパス（複数可）。提案が無ければ『該当なし』。\n【レビュー対象】レビュー対象の報告書のフルパス。複数のレビュー対象物があるときは Bundle(ZIP) のフルパス。\n（sessionSummaryMode で抑制可: soft=セッション1回 / strict=毎ターン / off=無効。~/.ccpit/app-config.json）"
}
EOF
exit 0
