# Template: HTML presentation detection & serving commands (verified)

Command set for each tier of the report skill "Presentation Rules". Assumes POSIX bash (incl. Git Bash).

## 1. Operator-node detection

```bash
# Inputs for tiers 1/2 (reference variables individually; enumerating env is a protected command — forbidden)
echo "SSH_CONNECTION=[${SSH_CONNECTION:-<unset>}] TMUX=[${TMUX:-<unset>}] STY=[${STY:-<unset>}]"

# Execution node (authoritative signal)
grep -o '"currentProfile": *"[a-z]*"' ~/.ccpit/app-config.json

# Tier 2: under SSH — client IP (first field of SSH_CONNECTION) → tailnet node name
CIP=${SSH_CONNECTION%% *}
tailscale whois --json "$CIP" | grep -m1 '"Name"'
# Adopt only when it resolves to a physically-seatable node. Failure / outside the set → tier 3

# Tier 3: state file (TTL 2 hours = -mmin -120 + set membership = fail-closed)
if [ -n "$(find ~/.ccpit/operator-node -mmin -120 2>/dev/null)" ]; then
  head -1 ~/.ccpit/operator-node | grep -xE 'hp01|mbp'   # adapt the set to your environment's seatable nodes
fi
# No output = absent/expired/outside the set (typos, headless names are silently rejected) → tier 4 (safe default)
```

## 2. Tailscale serving (operator ≠ execution node)

```bash
# Create a **fresh** staging dir per report (structurally prevents re-exposure of previously served HTML)
STAGE=$(mktemp -d "$HOME/.ccpit/serve-stage.XXXXXX")
cp <report.html> "$STAGE/"

# Local HTTP server bound to 127.0.0.1 only
# **OS-assigned port (port 0)** — with a fixed port, a leftover server from an interrupted
# prior run would make the new server die with EADDRINUSE and the proxy would re-expose
# the OLD staging dir (dynamic ports eliminate this structurally)
cd "$STAGE" && PORTFILE="$STAGE.port" node -e "
const http=require('http'),fs=require('fs'),path=require('path');const root=process.cwd();
http.createServer((q,s)=>{const p=path.join(root,decodeURIComponent(q.url.split('?')[0]).replace(/^\/+/,''));
if(!p.startsWith(root)){s.writeHead(403);s.end();return;}
fs.readFile(p,(e,d)=>{if(e){s.writeHead(404);s.end('404');return;}
s.writeHead(200,{'Content-Type':p.endsWith('.html')?'text/html; charset=utf-8':'application/octet-stream'});s.end(d);});
}).listen(0,'127.0.0.1',function(){fs.writeFileSync(process.env.PORTFILE,String(this.address().port));});" & SRV_PID=$!

# Fail-closed gate (**enforced** — failures must never reach serve; clean up and exit)
fail_closed() { echo "fail-closed: $1"; tailscale serve reset 2>/dev/null; kill "$SRV_PID" 2>/dev/null; wait "$SRV_PID" 2>/dev/null; cd "$HOME"; rm -rf "$STAGE" "$STAGE.port"; exit 1; }

# Capture the actual port (no file after ~5s = startup failure)
for i in 1 2 3 4 5 6 7 8 9 10; do [ -s "$STAGE.port" ] && break; sleep 0.5; done
[ -s "$STAGE.port" ] || fail_closed "port file never appeared (server startup failure)"
PORT=$(cat "$STAGE.port")
case "$PORT" in ''|*[!0-9]*) fail_closed "port value is not numeric";; esac
echo "PORT=$PORT"

# **Backend identity verification** (required before presenting; hard gate): served bytes = this run's staged file
curl -s "http://127.0.0.1:$PORT/<report.html>" | cmp -s - "$STAGE/<report.html>" || fail_closed "backend identity mismatch (stale server / wrong file suspected)"
echo "backend verified"

# Only reach serve when all gates passed (tailnet only; funnel is absolutely forbidden)
tailscale serve --bg --http=80 "$PORT"
tailscale serve status   # confirm "(tailnet only)" and that the proxy targets $PORT

# URL to present (check the tailnet name via tailscale status)
#   http://<exec-node tailnet name>.<tailnet domain>.ts.net/<file>.html

# Cleanup after acknowledgment (**all 3 steps required** — proxy reset alone leaves staging re-exposable on the next serve)
tailscale serve reset
kill "$SRV_PID"
wait "$SRV_PID" 2>/dev/null   # rm right after kill races with process death and hits "Device busy" (measured)
cd "$HOME"   # on Windows, rm fails with "Device busy" while cwd is inside the staging dir
rm -rf "$STAGE" "$STAGE.port"
```

Note: run this snippet **with its line breaks**. Joining lines with `&&` makes the `&` (server backgrounding) apply to the whole chain, leaving later variables empty.

## 3. Known constraints (from verification)

- On Windows, `tailscale serve <directory>` (path serving) **requires local admin** (401) → the port-proxy method above is the adopted method on all nodes
- HTTPS (443, without `--http=80`) requires the tailnet **HTTPS Certificates feature** to be enabled once by a human in the admin console; otherwise `tailscale cert` fails with an ACME DNS 500. Inside the tailnet, links are WireGuard-encrypted, so HTTP 80 is still encrypted on the wire
- mermaid figures degrade to CDN fallback when offline (raw-text fallback until a vendor bundle ships)
