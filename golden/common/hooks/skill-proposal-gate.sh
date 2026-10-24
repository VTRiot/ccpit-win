#!/bin/bash
# skill-proposal-gate.sh — skill-proposal-emitter 自動発火ループ Stop hook（CCPIT Part B / A1+B1）
#
# 役割: セッション終了で「Skill 化候補の提案 MD（候補が無ければ該当なし）」を出すよう促す。
#       report-gate（コード変更時のみ）とは発火条件を分離し、調査のみセッションでも発火する。
#
# 出力方式: exit 0 + JSON（decision: "block"）。※ exit 2 は stdout JSON を無視するため使わない（公式仕様）。
#
# 発火モード（~/.ccpit/app-config.json の "emissionMode"。未設定/不明 → 既定 soft）:
#   soft  (既定): セッションにつき一度だけ block。
#   strict      : 提案/該当なしが出るまで新 stop（=各ターン終了）毎に block。ノイズ大。
#   off         : 何もしない（opt-in 運用）。
#
# 【セッション1回の実装根拠】
#   Claude Code の Stop hook は「各ターン終了」毎に発火する（公式 hooks-guide）。
#   stop_hook_active は hooks-guide の例にあるが公式 reference の入力スキーマには未記載で、
#   これ単独では「セッション1回」を保証できない（保証されてもターン毎にしかならない）。
#   公式スキーマに記載され セッション内で安定な session_id をキーにしたセンチネルで「セッション1回」を担保する。
#   stop_hook_active は（存在すれば）無限ループ防止の補助として併用する。
#
# 構造（CCPIT_L0_009・recommend-review-gate の L0_006 と同じ型）:
#   本ファイル                 = 入口の薄い殻。bash の組み込みコマンドだけで node を探し、あれば exec node -e（BOOT）で隣の .cjs を呼ぶ。
#   skill-proposal-gate.cjs      = 入口の殻（固定の約 30 行）。実体の読み込み・実行に失敗しても無出力・終了コード 0。
#   skill-proposal-gate.run.cjs  = 足場の判断（mode 解決 / off / stop_hook_active / session_id / センチネル）。旧 .sh の足場の写し。
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
GATE_DIR="$HOME/.ccpit/.proposal-gate"
DEFAULT_MODE="soft"
# センチネル保持日数（housekeeping。古いセッションの空マーカーが無限に溜まるのを防ぐだけの値）。
SENTINEL_RETENTION_DAYS=7

INPUT=$(cat)

# --- emissionMode を解決（jq 非依存。report-gate と同じ grep/sed 流儀） ---
MODE=""
if [ -f "$CONFIG" ]; then
  MODE=$(grep -oE '"emissionMode"[[:space:]]*:[[:space:]]*"[^"]*"' "$CONFIG" 2>/dev/null \
    | head -1 \
    | sed -E 's/.*"emissionMode"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')
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

# --- session_id を抽出（公式スキーマ記載。セッション識別子） ---
SESSION_ID=$(echo "$INPUT" \
  | grep -oE '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' \
  | head -1 \
  | sed -E 's/.*"session_id"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')
# ファイル名に使える文字へ正規化。欠落時は固定名（その場合 soft はプロセス横断で実質1回）。
SAFE_ID=$(printf '%s' "$SESSION_ID" | tr -cd 'A-Za-z0-9_-')
[ -z "$SAFE_ID" ] && SAFE_ID="no-session"
SENTINEL="$GATE_DIR/${SAFE_ID}.seen"

mkdir -p "$GATE_DIR" 2>/dev/null
# housekeeping: 古いセンチネルを掃除（失敗は無視）
find "$GATE_DIR" -name '*.seen' -type f -mtime +${SENTINEL_RETENTION_DAYS} -delete 2>/dev/null

# soft: このセッションで既にリマインド済みなら通過（センチネル存在）
if [ "$MODE" = "soft" ] && [ -f "$SENTINEL" ]; then
  exit 0
fi

# soft の初回リマインドはセンチネルを先に作る（次 stop 以降は素通り＝セッション1回を保証）
if [ "$MODE" = "soft" ]; then
  touch "$SENTINEL" 2>/dev/null
fi

# block（soft 初回 / strict）
cat <<'EOF'
{
  "decision": "block",
  "reason": "このセッションで skill-proposal-emitter による提案 MD がまだ出ていません。skill-proposal-emitter を発火し、Skill 化が有益な候補があれば提案 MD を、無ければ『該当なし』(adoption_label: reject) を ~/.ccpit/proposals/ に出力してから停止してください。（提案ループの起点＝センシング。emissionMode で抑制可: soft=セッション1回 / strict=毎ターン / off=無効）"
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
  if [ -f "$HERE/skill-proposal-gate.cjs" ] && [ -f "$HERE/skill-proposal-gate.run.cjs" ] && shell_complete "$HERE/skill-proposal-gate.cjs"; then
    # 起動の足場（BOOT）: 殻 .cjs を node -e の中から require して run() を呼ぶ。殻が構文エラー等で読めなくても、BOOT の catch が
    # 標準入力を読み捨てて無出力・終了コード 0 にする（node 殻.cjs と直接起動すると、構文エラーは殻の try/catch の外で node が非 0 終了する。
    # Codex 実装レビュー 1-1）。exec のままなので bash は残らず、fork は増えない。BOOT は二重引用符・ドル記号・バックスラッシュ・バッククォートを含まない（MSYS の引数渡しで壊れない）。
    BOOT="var fs=require('fs');process.stdout.on('error',function(){});try{require(process.argv[1]).run()}catch(e){try{var b=Buffer.alloc(65536),u=Date.now()+5000,n;for(;;){try{n=fs.readSync(0,b,0,b.length,null)}catch(x){if(x&&x.code==='EAGAIN'&&Date.now()<u){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);continue}break}if(n===0)break}}catch(y){}process.exitCode=0}"
    # exec 自体が失敗する場合（node が壊れた実行体・0 バイト・実行できない形式。command -v は通る）は execfail で exec の後ろへ進む。
    # SP・SS は下の legacy_main（旧の bash 本体）へ戻る。起動できた上で非 0 終了する node（DLL 欠落など）は exec で bash が置き換わっているので防げない（防ぐには fork が要り +約 320 ms）。
    shopt -s execfail
    exec node -e "$BOOT" "$HERE/skill-proposal-gate.cjs" "$HOME" "$HERE"
  fi
fi
legacy_main
