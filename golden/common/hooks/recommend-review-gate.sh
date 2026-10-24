#!/bin/bash
# recommend-review-gate.sh — 未レビュー recommend 提案の停止前リマインド Stop hook（CCPIT Part B）。
#
# 役割: セッション終了で「未レビューの recommend 提案が残っていないか」を確認し、
#       在れば独立レビュー（codex / proposal-review-backlog-sweep）を促す。CC が自己判断で
#       recommend とした提案が、独立レビューを経ずに人間の採用へ流れうる穴を塞ぐ soft な強制層。
#
# 出力方式: exit 0 + JSON（decision: "block"）。※ exit 2 は stdout JSON を無視するため使わない（公式仕様）。
#
# 構造（CCPIT_L0_006・testable-stop-hook-gate-authoring §1 の 2 層分離をさらに進めた形）:
#   本ファイル               = 入口の薄い殻。bash の組み込みコマンドだけで動き、子プロセスを起こさない。
#   recommend-review-gate.cjs = 「今 block すべきか」の足場（mode 解決 / off / stop_hook_active /
#                               検出核の不在 / soft=セッション1回 sentinel）。旧 .sh の足場の写し。
#   recommend-review-detect.cjs = 「何を言うべきか」（純粋判定 → 完成 block-JSON を stdout）。変更なし。
#   旧は grep / head / sed / tr / find / mkdir / touch / cat とコマンド置換で子プロセスを約 25 回起こしていた。
#   MSYS ではプロセス生成が機械全体でほぼ直列で、Stop hook が同時に走ると 1 回が数倍に伸びる。
#
# 発火モード（~/.ccpit/app-config.json の "recommendReviewMode" を優先、無ければ "emissionMode" に
#            フォールバック、いずれも無ければ既定 soft）:
#   soft  (既定): セッションにつき一度だけ block。
#   strict      : 各 stop（ターン終了）毎に block。強制力最大・ノイズ大。
#   off         : 何もしない（recommendReviewMode:"off" は emissionMode を巻き込まない独立キルスイッチ）。
#
# env（RRG_CONFIG / RRG_GATE_DIR / RRG_DETECT / RRG_STDIN_JSON ほか）の扱いは .cjs 側。isolated fixture 用。

# 標準入力を読み捨てる（組み込みの read のみ）。旧は最初に $(cat) で EOF まで読んだので、
# 早期に終了する経路でも書き手側（hook の呼び出し元）が EPIPE を受けないよう、同じく読み切ってから終了する。
drain_stdin() {
  # 変数名に _ は使わない（bash が直前の引数で上書きするため、EOF 判定が永久に偽になる）
  local chunk
  while IFS= read -r -d '' chunk || [ -n "$chunk" ]; do chunk=; done
}

# node 不在は fail-open（判定不能 → 非 block）
command -v node >/dev/null 2>&1 || { drain_stdin; exit 0; }

# 自分の置き場所（fork せずに解く。試験は Windows の \ 区切りで呼ぶので / と \ の両方を区切りとみなす）
case $0 in
  *[\\/]*) HERE=${0%[\\/]*} ;;
  *) HERE=. ;;
esac

# 足場 .cjs 不在も fail-open（旧の「検出核不在 → 通過」と同じ向き。配備は hooks/ に両方を置く）
[ -f "$HERE/recommend-review-gate.cjs" ] || { drain_stdin; exit 0; }

exec node "$HERE/recommend-review-gate.cjs" "$HOME"
