#!/bin/bash
# session-summary-gate.sh — セッション終了 SOR/EOR 四点要約 義務化 Stop hook（CCPIT）
#
# 役割: やり取り終了時に「(本流の)やったこと / 提案した SkillProposal の概要+ファイル名+フルパス /
#       レビュー対象の報告書 or 複数時の Bundle フルパス / HTML 報告書の file:/// URL」の四点を SOR/EOR で CC ウィンドウへ出力させる。
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
#
# 構造（CCPIT_L0_009・recommend-review-gate の L0_006 と同じ型）:
#   本ファイル                 = 入口の薄い殻。bash の組み込みコマンドだけで node を探し、あれば exec node -e（BOOT）で隣の .cjs を呼ぶ。
#   session-summary-gate.cjs      = 入口の殻（固定の約 30 行）。実体の読み込み・実行に失敗しても無出力・終了コード 0。
#   session-summary-gate.run.cjs  = 足場の判断（mode 解決 / off / stop_hook_active / session_id / センチネル）。旧 .sh の足場の写し。
#   旧は grep / head / sed / tr / find / mkdir / touch / cat とコマンド置換で子プロセスを何回も起こしていた。
#   MSYS ではプロセス生成が機械全体でほぼ直列で、Stop hook が同時に走ると 1 回が数倍に伸びる。
#
# fail-open の向き（発注書の「node 不在・.cjs 不在は通過」を、この 1 本に限り「旧の本体へ戻る」と読んだ。Plan §2.3）:
#   旧は node を一切使わない純粋な bash だった。node が無い・殻 .cjs が無い／途中で切れている・実体 .run.cjs が無い環境でも
#   動いていたので、そこで黙って止めると判定が変わる。よって上の条件のどれかが欠けるときは、凍結した旧の本体（legacy_main）を実行する。
#   戻し方: 一律に通過へ替えるなら、末尾の `legacy_main` を `exit 0` に替える（試験の該当行の期待も替える）。

# 殻 .cjs が最後まで書かれているか（最終行が印と一致）。CRLF の CR は落とす。fork しない（組み込みの read のみ）。
shell_complete() {
  local last line
  while IFS= read -r line || [ -n "$line" ]; do last=${line%$'\r'}; done < "$1" 2>/dev/null
  [ "$last" = '// STOPGATE-SHELL-END' ]
}

# 旧の bash 本体（凍結。基準の HEAD の同名ファイルの「CONFIG= の行」以降を逐語で。変更しない）
legacy_main() {
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
  "reason": "このセッションのやり取りが終了します。停止前に、次の四点要約を ---SOR--- と ---EOR--- で囲んで CC ウィンドウへ出力してください。\n【本流の作業】このセッションで本流として何をしたか（簡潔に）。\n【SkillProposal】提案の概要と adoption_label（recommend/reject）、提案ファイル名とそのフルパス（複数可）。提案が無ければ『該当なし』。\n【レビュー対象】レビュー対象の報告書のフルパス。複数のレビュー対象物があるときは Bundle(ZIP) のフルパス。\n【HTML報告書】レビュー対象の HTML 報告書の file:/// URL（フルパス形式）。無ければ『該当なし』。\n（sessionSummaryMode で抑制可: soft=セッション1回 / strict=毎ターン / off=無効。~/.ccpit/app-config.json）"
}
EOF
exit 0
}

if command -v node >/dev/null 2>&1; then
  # 自分の置き場所（fork せずに解く。試験は Windows の \ 区切りで呼ぶので / と \ の両方を区切りとみなす）
  case $0 in
    *[\\/]*) HERE=${0%[\\/]*} ;;
    *) HERE=. ;;
  esac
  if [ -f "$HERE/session-summary-gate.cjs" ] && [ -f "$HERE/session-summary-gate.run.cjs" ] && shell_complete "$HERE/session-summary-gate.cjs"; then
    # 起動の足場（BOOT）: 殻 .cjs を node -e の中から require して run() を呼ぶ。殻が構文エラー等で読めなくても、BOOT の catch が
    # 標準入力を読み捨てて無出力・終了コード 0 にする（node 殻.cjs と直接起動すると、構文エラーは殻の try/catch の外で node が非 0 終了する。
    # Codex 実装レビュー 1-1）。exec のままなので bash は残らず、fork は増えない。BOOT は二重引用符・ドル記号・バックスラッシュ・バッククォートを含まない（MSYS の引数渡しで壊れない）。
    BOOT="var fs=require('fs');process.stdout.on('error',function(){});try{require(process.argv[1]).run()}catch(e){try{var b=Buffer.alloc(65536),u=Date.now()+5000,n;for(;;){try{n=fs.readSync(0,b,0,b.length,null)}catch(x){if(x&&x.code==='EAGAIN'&&Date.now()<u){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);continue}break}if(n===0)break}}catch(y){}process.exitCode=0}"
    # exec 自体が失敗する場合（node が壊れた実行体・0 バイト・実行できない形式。command -v は通る）は execfail で exec の後ろへ進む。
    # SP・SS は下の legacy_main（旧の bash 本体）へ戻る。起動できた上で非 0 終了する node（DLL 欠落など）は exec で bash が置き換わっているので防げない（防ぐには fork が要り +約 320 ms）。
    shopt -s execfail
    exec node -e "$BOOT" "$HERE/session-summary-gate.cjs" "$HOME" "$HERE"
  fi
fi
legacy_main
