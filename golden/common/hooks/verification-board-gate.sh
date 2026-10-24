#!/bin/bash
# verification-board-gate.sh — 実機視認ボード添付 義務化 Stop hook（CCPIT・039 FB01 追加）
#
# 役割: 実機視認待ち（報告書 frontmatter の status に pending-user-verification を含む）の完了報告を
#       出したら、入力可能な視認ボード HTML（handmade-dashboard 形式）の同梱を義務化する。
#       人間の実機テスト依頼時に「判定ボタン+コメント欄+まとめコピー」の視認ボードを毎回添えさせる。
#
# 出力方式: exit 0 + JSON（decision: "block"）。※ exit 2 は stdout JSON を無視するため使わない（公式仕様）。
#
# 構造（CCPIT_L0_009・testable-stop-hook-gate-authoring §1 の 2 層分離をさらに進めた形。recommend-review-gate と同じ型）:
#   本ファイル                       = 入口の薄い殻。bash の組み込みコマンドだけで動き、子プロセスを起こさない。
#   verification-board-gate.cjs      = 入口の殻（Node）。実体の読み込み・実行に失敗しても無出力・exit 0（標準入力は読み捨てる）。
#   verification-board-gate.run.cjs  = 「今 block すべきか」の足場（mode 解決 / off / stop_hook_active / git 変更検出 /
#                                       soft=セッション1回 sentinel）。旧 .sh の足場の判断の写し。
#   verification-board-detect.cjs    = 「何を言うべきか」（純粋判定 → 完成 block-JSON を stdout）。変更なし。
#   旧は grep / head / sed / tr / find / mkdir / touch / echo とコマンド置換で子プロセスを何回も起こしていた。
#   MSYS ではプロセス生成が機械全体でほぼ直列で、Stop hook が同時に走ると 1 回が数倍に伸びる。
#   なお git status はフックの外の子プロセスで、リポジトリの大きさに所要が左右される（Node へ移しても残る）。
#
# 発火モード（~/.ccpit/app-config.json の "verificationBoardMode"。未設定/不明 → 既定 soft）:
#   soft  (既定): セッションにつき一度だけ block。
#   strict      : 各 stop（ターン終了）毎に block。強制力最大・ノイズ大。
#   off         : 何もしない。
#
# env（VBG_CONFIG / VBG_GATE_DIR / VBG_DETECT / CLAUDE_PROJECT_DIR）の扱いは .run.cjs 側。isolated fixture 用。

# 標準入力を読み捨てる（組み込みの read のみ）。旧は最初に $(cat) で EOF まで読んだので、
# 早期に終了する経路でも書き手側（hook の呼び出し元）が EPIPE を受けないよう、同じく読み切ってから終了する。
drain_stdin() {
  # 変数名に _ は使わない（bash が直前の引数で上書きするため、EOF 判定が永久に偽になる）
  local chunk
  while IFS= read -r -d '' chunk || [ -n "$chunk" ]; do chunk=; done
}

# 殻 .cjs が最後まで書かれているか（最終行が印と一致）。途中で切れた配備を fork なしで見分ける。CRLF の CR は落とす。
shell_complete() {
  local last line
  while IFS= read -r line || [ -n "$line" ]; do last=${line%$'\r'}; done < "$1" 2>/dev/null
  [ "$last" = '// STOPGATE-SHELL-END' ]
}

# node 不在は fail-open（判定不能 → 非 block）
command -v node >/dev/null 2>&1 || { drain_stdin; exit 0; }

# 自分の置き場所（fork せずに解く。試験は Windows の \ 区切りで呼ぶので / と \ の両方を区切りとみなす）
case $0 in
  *[\\/]*) HERE=${0%[\\/]*} ;;
  *) HERE=. ;;
esac

# 殻 .cjs の不在・途中切れも fail-open（配備は hooks/ に両方を置く）
[ -f "$HERE/verification-board-gate.cjs" ] && shell_complete "$HERE/verification-board-gate.cjs" || { drain_stdin; exit 0; }

# 起動の足場（BOOT）: 殻 .cjs を node -e の中から require して run() を呼ぶ。殻が構文エラー等で読めなくても、BOOT の catch が
# 標準入力を読み捨てて無出力・終了コード 0 にする（node 殻.cjs と直接起動すると、構文エラーは殻の try/catch の外で node が非 0 終了する。
# Codex 実装レビュー 1-1）。exec のままなので bash は残らず、fork は増えない。BOOT は二重引用符・ドル記号・バックスラッシュ・バッククォートを含まない（MSYS の引数渡しで壊れない）。
BOOT="var fs=require('fs');process.stdout.on('error',function(){});try{require(process.argv[1]).run()}catch(e){try{var b=Buffer.alloc(65536),u=Date.now()+5000,n;for(;;){try{n=fs.readSync(0,b,0,b.length,null)}catch(x){if(x&&x.code==='EAGAIN'&&Date.now()<u){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);continue}break}if(n===0)break}}catch(y){}process.exitCode=0}"
# exec 自体が失敗する場合（node が壊れた実行体・0 バイト・実行できない形式。command -v は通る）は execfail で exec の後ろへ進む。
# ここでは標準入力を読み捨てて終了コード 0。起動できた上で非 0 終了する node（DLL 欠落など）は exec で bash が置き換わっているので防げない（防ぐには fork が要り +約 320 ms）。
shopt -s execfail
exec node -e "$BOOT" "$HERE/verification-board-gate.cjs" "$HOME" "$HERE"
drain_stdin
exit 0
