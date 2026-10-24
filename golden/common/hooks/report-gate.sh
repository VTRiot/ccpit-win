#!/bin/bash
# report-gate.sh — 報告書出し忘れ防止 Stop hook（入口の薄い殻）。CCPIT_L0_015。
#
# 責務分離（testable-stop-hook-gate-authoring 定型）:
#   本ファイル            = 入口の薄い殻。bash の組み込みコマンドだけで node を探し、あれば exec node -e（BOOT）で隣の .cjs を呼ぶ。
#   report-gate.cjs       = 入口の殻（固定の約 40 行）。実体を呼んで返された Buffer を 1 回だけ書く。
#   report-gate.run.cjs   = 足場の判断: mode 解決（strict/off）・検出核の存在確認・検出核の起動と出力の整形。旧 .sh の写し。
#   report-detect.cjs     = 判定本体（純粋検出核。この案件では 1 バイトも変えない）。block 対象があれば検出核が完成 block-JSON を
#                           出すので、足場は流すだけ（JSON エスケープ事故ゼロ）。検出核は子プロセスとして起こす（stdout・exit・時間予算の意味を旧と同じに保つ）。
#   旧は $(cat)・$(cd $(dirname))・$(node -e)・$(printf|node) の bash のサブシェルと Node の 2 回起動で、MSYS ではプロセス生成が
#   機械全体でほぼ直列のため、Stop hook が同時に走ると 1 回が数倍に伸びた。足場の判断を 1 つの Node にまとめる。
#
# 出力方式: exit 0 + JSON（decision: "block"）。exit 2 は stdout JSON を無視するため使わない（公式仕様）。
#
# mode 正本: ~/.ccpit/app-config.json の "reportGateMode"。**strict（既定）と off の 2 値のみ**。
#   soft（セッション 1 回だけ block）は**採らない**。「報告書がどこにも無い」状態でも 2 回目の停止を
#   通してしまい、本 gate の中核的不変条件（block 条件を広げない／検出力を落とさない）と両立しないため。
#   off は「明示的に無効化した」と分かる operator override であり、共有 hook のロールバック手段でもある。
#
# stop_hook_active による無条件バイパスも**入れない**。入れると「2 回停止すれば通る」＝ゲートが死ぬ。
#   本 gate の要求は CC 自身の行動（報告書を書く）で満たせるので、満たされるまで鳴らすのが正しい。
#
# fail-open の向き（この 1 本は「報告書の出し忘れを止める義務」の関門なので、壊れたときに黙って通過させず、旧の本体へ戻す）:
#   ・node が無い・殻 .cjs／実体 .run.cjs が無い、または殻 .cjs が途中で切れている → 旧の bash 本体（legacy_main）を実行する。
#     （旧の本体は node が無ければ従来どおり exit 0＝検出不能は非 block。node が在るのに殻だけ欠けたときは旧の判定がそのまま働く）
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

# 旧の bash 本体（凍結。基準の HEAD の同名ファイルの「INPUT=$(cat) の行」以降を逐語で。変更しない）
legacy_main() {
INPUT=$(cat)
DIR=$(cd "$(dirname "$0")" && pwd)
DETECT="${RG_DETECT:-$DIR/report-detect.cjs}"
CONFIG="${RG_CONFIG:-$HOME/.ccpit/app-config.json}"

# --- mode 解決（jq 非依存。node -e で JSON を正しく解く。破損・不在は strict へ倒す） ---
MODE=$(RG_CONFIG_PATH="$CONFIG" node -e 'try{const c=require(process.env.RG_CONFIG_PATH);const m=c.reportGateMode;process.stdout.write(m==="off"||m==="strict"?m:"strict")}catch(e){process.stdout.write("strict")}' 2>/dev/null)
[ -z "$MODE" ] && MODE=strict
[ "$MODE" = "off" ] && exit 0

# --- node 不在 / 検出核不在は fail-open（判定不能 → 非 block。他 gate と同じ向き） ---
command -v node >/dev/null 2>&1 || exit 0
[ -f "$DETECT" ] || exit 0

# --- 検出核へ委譲。hook 入力 JSON をそのまま渡し、向こうで JSON.parse させる ---
#     （bash の grep+sed では transcript_path の "C:\\Users\\..." を復元できないため）
OUT=$(printf '%s' "$INPUT" | RG_STDIN_JSON=1 node "$DETECT" 2>/dev/null)
if [ -n "$OUT" ]; then
  printf '%s\n' "$OUT"
fi
exit 0
}

# 呼び直しの入口: 殻の例外のあとに BOOT がここへ入る。node も殻 .cjs も使わず旧の本体を実行する（再帰しない）。
if [ "$L0015_LEGACY" = "1" ]; then
  legacy_main
fi

if command -v node >/dev/null 2>&1; then
  # 自分の置き場所（fork せずに解く）。旧の DIR=$(cd "$(dirname "$0")" && pwd) と同じく、区切りは / だけ（MSYS の dirname は \ を区切りと見ない。
  # 登録の形 bash -c "$HOME/…" では $0 は / 区切りの絶対パス）。\ 区切りの $0 では HERE が . になり、旧と同じく cwd を見る（そこに殻 .cjs が無ければ旧の本体へ戻る）。
  case $0 in
    */*)
      HERE=${0%/*}
      [ -z "$HERE" ] && HERE=/
      ;;
    *) HERE=. ;;
  esac
  if [ -f "$HERE/report-gate.cjs" ] && [ -f "$HERE/report-gate.run.cjs" ] && shell_complete "$HERE/report-gate.cjs"; then
    # 設定と検出核の場所は、旧と同じ素材（RG_CONFIG／RG_DETECT の :- 既定）から .sh が組み、引数で渡す。
    # 引数にすると MSYS が POSIX 形のパスを Windows 形へ変換する（旧が node の引数・環境に渡した形と同じ扱い）。
    CFG_ARG="${RG_CONFIG:-$HOME/.ccpit/app-config.json}"
    DET_ARG="${RG_DETECT:-$HERE/report-detect.cjs}"
    # 起動の足場（BOOT）: ①標準入力を先に全部読んで保持する（旧は最初に $(cat) で読み切った）②殻 .cjs を require して run(入力) を呼ぶ
    # ③殻・実体が構文エラー等で落ちたら、保持した入力で旧の本体を L0015_LEGACY=1 で呼び直し、その標準出力を流す。
    # 引数: argv[1]=殻 .cjs / argv[2]=$HOME / argv[3]=置き場 / argv[4]=$BASH / argv[5]=$0 / argv[6]=設定のパス / argv[7]=検出核のパス。
    # exec のままなので bash は残らず、fork は増えない。
    # BOOT は二重引用符・ドル記号・バックスラッシュ・バッククォートを含まない（MSYS の引数渡しで壊れない）。
    BOOT="var fs=require('fs');process.stdout.on('error',function(){});var cs=[],b=Buffer.alloc(65536),w=null,n,inp;try{for(;;){try{n=fs.readSync(0,b,0,b.length,null)}catch(x){if(x&&x.code==='EAGAIN'){if(w===null)w=Date.now();if(Date.now()-w<5000){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);continue}}break}w=null;if(n===0)break;cs.push(Buffer.from(b.subarray(0,n)))}}catch(y){}inp=Buffer.concat(cs);try{require(process.argv[1]).run(inp)}catch(e){try{var r=require('child_process').spawnSync(process.argv[4]||'bash',[process.argv[5]],{input:inp,env:Object.assign({},process.env,{L0015_LEGACY:'1'}),stdio:['pipe','pipe','ignore'],maxBuffer:1<<30});if(r&&r.stdout&&r.stdout.length)process.stdout.write(r.stdout)}catch(z){}}process.exitCode=0"
    # exec 自体が失敗する場合（node が壊れた実行体・0 バイト・実行できない形式。command -v は通る）は execfail で exec の後ろへ進み、legacy_main へ戻る。
    shopt -s execfail
    exec node -e "$BOOT" "$HERE/report-gate.cjs" "$HOME" "$HERE" "$BASH" "$0" "$CFG_ARG" "$DET_ARG"
  fi
fi
legacy_main
