#!/bin/bash
# cc-identity-register.sh — SessionStart hook（CC固有ID 発番・戸籍係 / The Registrar）
#
# 役割: この CC セッションに 16進10桁の固有ID（ccId）が未発番なら発番し、Global 台帳
#       （~/.ccpit/.cc-id/<session_id>.json）に登録する。
#       - ▶起動でも 直接 cd→起動でも、全 CC が SessionStart で必ず発火 → 漏れなく ID が付く。
#       - ID は session_id をキーに永続（resume は同 session_id → 同 ccId 維持）。発番済なら何もしない。
#       - CCES 発行時に台帳から ccId を併記 → Juiz が「自分がどの CC と紐づくか」を辿れる。
#       - 個別ファイル（race-free・記録屋の .session-gen と同方式）＋ temp→mv で原子的に書く。
#
# 起動形: exec form 前提（settings.json で {"command":"bash","args":["-c","<this>"]}）。
#         bare `.sh` は端末 Windows CC で不発（Phase 0 V1 実証）。
# 出力: 副作用のみ（台帳書込）。SessionStart ゆえ decision/block は使わない。exit 0。

CCPIT_DIR="$HOME/.ccpit"
IDDIR="$CCPIT_DIR/.cc-id"

INPUT=$(cat 2>/dev/null)
SID=$(printf '%s' "$INPUT" \
  | grep -oE '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' \
  | head -1 \
  | sed -E 's/.*"session_id"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')
SAFE=$(printf '%s' "$SID" | tr -cd 'A-Za-z0-9_-')
[ -z "$SAFE" ] && exit 0

REC="$IDDIR/$SAFE.json"
# 既存レコードがあれば一切触らない（resume 等で ccId 不変・**修復/上書きの race を構造的に回避**）。
# 本 hook は下記 temp→ln で **完成レコードしか公開しない**ため、自ら部分/破損レコードを作らない。
# 稀な legacy/外部由来の破損レコードは hook では修復せず、reader(ccRegistry) が fail-soft で除外する
# → その CC は ID 無しで graceful degradation（追跡からそのセッションが落ちるだけ・システムは壊れない）。
# hook 側で validity を判定して再登録すると reader の判定と不一致になり、かつ並行 winner を消す race を
# 生む（Codex 5巡）。判定の単一真実源は reader に集約し、hook は「存在すれば不変」に徹する。
[ -f "$REC" ] && exit 0

# cwd（任意）: 入力 JSON から抽出し、backslash を forward slash へ変換して格納する（Codex #2 対応）。
# slash は JSON エスケープ不要＝Windows パスの backslash 二重/単一エスケープ事故を **構造的に回避**する
# （シェル層を跨ぐ backslash 計数に依存しない）。ccRegistry は cwd を normalize して照合するので、
# slash/backslash・大小・連続 slash の差はすべて吸収される。
CWD=$(printf '%s' "$INPUT" \
  | grep -oE '"cwd"[[:space:]]*:[[:space:]]*"[^"]*"' \
  | head -1 \
  | sed -E 's/.*"cwd"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/' \
  | tr '\\' '/')

# 16進10桁（40bit）発番: openssl 優先・無ければ /dev/urandom。
CCID=$(openssl rand -hex 5 2>/dev/null)
if [ -z "$CCID" ]; then
  CCID=$(tr -dc 'a-f0-9' < /dev/urandom 2>/dev/null | head -c 10)
fi
# 不正ID（非hex / 長さ≠10）は台帳に入れない（fail-safe）
case "$CCID" in *[!0-9a-f]*) exit 0 ;; esac
[ "${#CCID}" -eq 10 ] || exit 0

TS=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)

mkdir -p "$IDDIR" 2>/dev/null
# まず temp に **完全に**書き、書込成功（printf 成功 かつ 非空）を確認してから公開する。書込失敗時は
# 不完全レコードを公開しない（Codex 4巡#2）。途中クラッシュしても $REC は生まれない（部分を出さない）。
TMP="$REC.tmp.$$"
if ! printf '{"ccId":"%s","sessionId":"%s","cwd":"%s","registeredAt":"%s"}\n' \
       "$CCID" "$SAFE" "$CWD" "$TS" > "$TMP" 2>/dev/null || [ ! -s "$TMP" ]; then
  rm -f "$TMP" 2>/dev/null
  exit 0
fi
# 原子的 create-if-not-exists で公開。hard link は既存なら EEXIST で失敗＝**先勝ち**で上書きしない
# （並行 SessionStart でも ccId 不変＝Codex 1巡#1）。完成 temp からの公開ゆえ部分レコードは出ない
# （Codex 3巡）。ln 不可環境は mv -n（no-clobber）にフォールバック（完成 temp ゆえ部分なし）。
ln "$TMP" "$REC" 2>/dev/null || mv -n "$TMP" "$REC" 2>/dev/null
rm -f "$TMP" 2>/dev/null
exit 0
