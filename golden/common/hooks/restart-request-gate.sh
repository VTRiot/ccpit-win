#!/bin/bash
# restart-request-gate.sh — 再起動要求フラグ検知の Stop hook（入口の薄い殻）。CCPIT_L0_015。
#
# 役割: CCPIT が設置した「再起動要求フラグ」(~/.ccpit/.restart-requests/<session_id>.json) を Stop（ターン終了）時に検知し、
#       検知したら block して「安全な完了点なので /exit→`claude --resume` で自己再起動し設定を反映せよ」と促す。
#       フラグは block の出力より先に削除（consume）する＝要求につき一度。stop_hook_active=true のときは消さずに通過する。
#
# 出力方式: exit 0 + JSON（decision: "block"）。※ exit 2 は stdout JSON を無視するため使わない（公式仕様）。
#
# 構造（CCPIT_L0_009 の 4 本と同じ型。L0_015 で restart-request-gate に適用）:
#   本ファイル                       = 入口の薄い殻。bash の組み込みコマンドだけで node を探し、あれば exec node -e（BOOT）で隣の .cjs を呼ぶ。
#   restart-request-gate.cjs          = 入口の殻（固定の約 40 行）。実体を呼んで返された Buffer を 1 回だけ書く。
#   restart-request-gate.run.cjs      = 足場の判断（session_id・フラグ・stop_hook_active・consume・block 文）。旧 .sh の写し。
#   旧は cat / echo / grep / head / sed / tr / rm とコマンド置換で子プロセスを約 20 個起こしていた。MSYS ではプロセス生成が
#   機械全体でほぼ直列で、Stop hook が同時に走ると 1 回が数倍に伸びる。判断を 1 つの Node に移す。
#
# fail-open の向き（この 1 本は「再起動を促す義務」の関門なので、壊れたときに黙って通過させず、旧の本体へ戻す）:
#   ・node が無い・殻 .cjs／実体 .run.cjs が無い、または殻 .cjs が途中で切れている → 旧の bash 本体（legacy_main）を実行する。
#   ・殻 .cjs／実体 .run.cjs の構文エラー・読み込み／実行時の例外 → BOOT の catch が、すでに読み込んだ標準入力のバイト列を保持して
#     おり、環境変数 L0015_LEGACY=1 を付けて本ファイルを再起動する（その入口では上の確認を飛ばして legacy_main へ直行＝再帰しない）。
#     この呼び直しも失敗したとき（bash が起動できない等）だけ、無出力・終了コード 0。
#   ・起動できた上で非 0 終了する node（DLL 欠落・偽の実行体）は、exec で bash が置き換わっているので防げない既知の残差。
#   戻し方: 一律に通過へ替えるなら、末尾の `legacy_main` を `exit 0` に替える（試験の該当行の期待も替える）。

# 殻 .cjs が最後まで書かれているか（最終行が印と一致）。CRLF の CR は落とす。fork しない（組み込みの read のみ）。
shell_complete() {
  local last line
  while IFS= read -r line || [ -n "$line" ]; do last=${line%$'\r'}; done < "$1" 2>/dev/null
  [ "$last" = '// STOPGATE-SHELL-END' ]
}

# 旧の bash 本体（凍結。基準の HEAD の同名ファイルの「REQ_DIR= の行」以降を逐語で。変更しない）
legacy_main() {
REQ_DIR="$HOME/.ccpit/.restart-requests"

INPUT=$(cat)

# --- session_id を抽出（公式スキーマ記載。skill-proposal-gate と同じ grep/sed 流儀） ---
SESSION_ID=$(echo "$INPUT" \
  | grep -oE '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' \
  | head -1 \
  | sed -E 's/.*"session_id"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')
# ファイル名安全化（UUID はハイフン保持。欠落時は何もできないので通過）。
SAFE_ID=$(printf '%s' "$SESSION_ID" | tr -cd 'A-Za-z0-9_-')
[ -z "$SAFE_ID" ] && exit 0

FLAG="$REQ_DIR/${SAFE_ID}.json"

# フラグが無ければ通過（再起動要求なし）。
[ -f "$FLAG" ] || exit 0

# --- stop_hook_active（無限ループ防止の補助）。true なら通過 ---
ACTIVE=$(echo "$INPUT" \
  | grep -oE '"stop_hook_active"[[:space:]]*:[[:space:]]*(true|false)' \
  | head -1 \
  | grep -oE '(true|false)')
if [ "$ACTIVE" = "true" ]; then
  exit 0
fi

# consume: 先に削除してから block（次 Stop 以降は素通り＝要求につき一度）。
rm -f "$FLAG" 2>/dev/null

cat <<'EOF'
{
  "decision": "block",
  "reason": "CCPIT から設定反映のための再起動要求があります。いまは安全な完了点（ターン終了）です。クリーン引き継ぎメモ（目的・完了済み・次操作のみ。誤形式出力は引用しない）を残し、`/exit` で一度終了してから `claude --resume <このセッションID>` で再起動し、変更後の settings/hooks/skills/plugins を反映してください。（再起動要求フラグは consume 済み＝この要求につき一度だけ）"
}
EOF
exit 0
}

# 呼び直しの入口: 殻の例外のあとに BOOT がここへ入る。node も殻 .cjs も使わず旧の本体を実行する（再帰しない）。
if [ "$L0015_LEGACY" = "1" ]; then
  legacy_main
fi

if command -v node >/dev/null 2>&1; then
  # 自分の置き場所（fork せずに解く。試験は Windows の \ 区切りで呼ぶので / と \ の両方を区切りとみなす）
  case $0 in
    *[\\/]*) HERE=${0%[\\/]*} ;;
    *) HERE=. ;;
  esac
  if [ -f "$HERE/restart-request-gate.cjs" ] && [ -f "$HERE/restart-request-gate.run.cjs" ] && shell_complete "$HERE/restart-request-gate.cjs"; then
    # 起動の足場（BOOT）: ①標準入力を先に全部読んで保持する（旧は最初に $(cat) で読み切った）②殻 .cjs を require して run(入力) を呼ぶ
    # ③殻・実体が構文エラー等で落ちたら、保持した入力で旧の本体を L0015_LEGACY=1 で呼び直し、その標準出力を流す。
    # 引数: argv[1]=殻 .cjs / argv[2]=$HOME / argv[3]=置き場 / argv[4]=$BASH / argv[5]=$0。exec のままなので bash は残らず、fork は増えない。
    # BOOT は二重引用符・ドル記号・バックスラッシュ・バッククォートを含まない（MSYS の引数渡しで壊れない）。
    BOOT="var fs=require('fs');process.stdout.on('error',function(){});var cs=[],b=Buffer.alloc(65536),w=null,n,inp;try{for(;;){try{n=fs.readSync(0,b,0,b.length,null)}catch(x){if(x&&x.code==='EAGAIN'){if(w===null)w=Date.now();if(Date.now()-w<5000){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);continue}}break}w=null;if(n===0)break;cs.push(Buffer.from(b.subarray(0,n)))}}catch(y){}inp=Buffer.concat(cs);try{require(process.argv[1]).run(inp)}catch(e){try{var r=require('child_process').spawnSync(process.argv[4]||'bash',[process.argv[5]],{input:inp,env:Object.assign({},process.env,{L0015_LEGACY:'1'}),stdio:['pipe','pipe','ignore'],maxBuffer:1<<30});if(r&&r.stdout&&r.stdout.length)process.stdout.write(r.stdout)}catch(z){}}process.exitCode=0"
    # exec 自体が失敗する場合（node が壊れた実行体・0 バイト・実行できない形式。command -v は通る）は execfail で exec の後ろへ進み、legacy_main へ戻る。
    shopt -s execfail
    exec node -e "$BOOT" "$HERE/restart-request-gate.cjs" "$HOME" "$HERE" "$BASH" "$0"
  fi
fi
legacy_main
