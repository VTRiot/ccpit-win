# 雛形: HTML 提示の判定・配信コマンド（実測済み）

report skill「提示規約」の各段を実行するコマンド集。POSIX bash（Git Bash 含む）前提。

## 1. 在席ノード判定

```bash
# 段1/2 の入力（個別参照のみ。env 全列挙は保護コマンドのため禁止）
echo "SSH_CONNECTION=[${SSH_CONNECTION:-<unset>}] TMUX=[${TMUX:-<unset>}] STY=[${STY:-<unset>}]"

# 実行ノード（権威シグナル）
grep -o '"currentProfile": *"[a-z]*"' ~/.ccpit/app-config.json

# 段2: SSH 時 — client IP（SSH_CONNECTION の第 1 フィールド）→ tailnet ノード名
CIP=${SSH_CONNECTION%% *}
tailscale whois --json "$CIP" | grep -m1 '"Name"'
# 物理着席可能ノードに解決した場合のみ採用。失敗/集合外 → 段3 へ

# 段3: 状態ファイル（TTL 2 時間 = -mmin -120 ＋ 集合検証 = fail-closed）
if [ -n "$(find ~/.ccpit/operator-node -mmin -120 2>/dev/null)" ]; then
  head -1 ~/.ccpit/operator-node | grep -xE 'hp01|mbp'   # 集合は環境の物理着席可能ノードに合わせる
fi
# 出力なし = 無し/期限切れ/集合外（typo・ヘッドレス名等は黙って棄却）→ 段4（安全既定）
```

## 2. Tailscale 配信（在席 ≠ 実行ノード）

```bash
# 報告ごとに**新規** staging を作る（前回配信分の残置 HTML が再露出する事故を構造的に排除）
STAGE=$(mktemp -d "$HOME/.ccpit/serve-stage.XXXXXX")
cp <報告書.html> "$STAGE/"

# 127.0.0.1 限定 bind のローカル HTTP サーバ
# **ポートは OS 割当（port 0）** — 固定ポートだと前回中断時の旧サーバが残っていた場合、
# 新サーバが EADDRINUSE で死に proxy が旧 staging を再露出する（動的ポートで構造排除）
cd "$STAGE" && PORTFILE="$STAGE.port" node -e "
const http=require('http'),fs=require('fs'),path=require('path');const root=process.cwd();
http.createServer((q,s)=>{const p=path.join(root,decodeURIComponent(q.url.split('?')[0]).replace(/^\/+/,''));
if(!p.startsWith(root)){s.writeHead(403);s.end();return;}
fs.readFile(p,(e,d)=>{if(e){s.writeHead(404);s.end('404');return;}
s.writeHead(200,{'Content-Type':p.endsWith('.html')?'text/html; charset=utf-8':'application/octet-stream'});s.end(d);});
}).listen(0,'127.0.0.1',function(){fs.writeFileSync(process.env.PORTFILE,String(this.address().port));});" & SRV_PID=$!

# fail-closed ゲート（**強制** — 失敗時は serve に到達させず後片付けして終了する）
fail_closed() { echo "fail-closed: $1"; tailscale serve reset 2>/dev/null; kill "$SRV_PID" 2>/dev/null; wait "$SRV_PID" 2>/dev/null; cd "$HOME"; rm -rf "$STAGE" "$STAGE.port"; exit 1; }

# 実ポート捕捉（約 5 秒でファイル未出現 = 起動失敗）
for i in 1 2 3 4 5 6 7 8 9 10; do [ -s "$STAGE.port" ] && break; sleep 0.5; done
[ -s "$STAGE.port" ] || fail_closed "ポートファイル未出現 (サーバ起動失敗)"
PORT=$(cat "$STAGE.port")
case "$PORT" in ''|*[!0-9]*) fail_closed "ポート値が数値でない";; esac
echo "PORT=$PORT"

# **backend 同一性検証**（提示前必須・ハードゲート）: 配信内容 = 今回 staging のファイル
curl -s "http://127.0.0.1:$PORT/<報告書.html>" | cmp -s - "$STAGE/<報告書.html>" || fail_closed "backend 同一性不一致 (旧サーバ/誤ファイルの疑い)"
echo "backend verified"

# ここに到達した時のみ serve してよい（tailnet 内限定。funnel は絶対禁止）
tailscale serve --bg --http=80 "$PORT"
tailscale serve status   # "(tailnet only)" と proxy 先が $PORT であることを確認

# 提示 URL（tailnet 名は tailscale status で確認）
#   http://<実行ノードの tailnet 名>.<tailnet ドメイン>.ts.net/<file>.html

# 確認後の後片付け（**3 点セット必須** — proxy だけでは staging が次回 serve 時に再露出する）
tailscale serve reset
kill "$SRV_PID"
wait "$SRV_PID" 2>/dev/null   # kill 直後の rm はプロセス終了と競合し Device busy になる（実測）
cd "$HOME"   # Windows は cwd が staging 内のままだと rm が Device busy になる
rm -rf "$STAGE" "$STAGE.port"
```

注: 本スニペットは**改行のまま**実行する。`&&` で 1 行に連結すると `&`（サーバ背景化）がチェーン全体に掛かり、以降の変数が空になる。

## 3. 既知の制約（実測由来）

- Windows では `tailscale serve <ディレクトリ>` の path serve は**ローカル管理者必須**（401）→ 上記ポートプロキシ方式を全ノード共通の採用方式とする
- HTTPS（443、`--http=80` なし）は tailnet の **HTTPS Certificates 機能の有効化**（管理画面・人間操作 1 回）が前提。未有効だと `tailscale cert` が ACME DNS 500 で失敗する。tailnet 内は WireGuard でリンク暗号化済みのため HTTP 80 でも経路上は暗号化
- mermaid 図はオフライン時 CDN 退化（vendor 同梱までは原文表示にフォールバック）
