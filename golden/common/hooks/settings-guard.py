#!/usr/bin/env python3
# settings-guard.py — PreToolUse 判定本体（settings-guard.sh から呼ばれる）
#
# 設計（成果物1 core / Marshal F1-F4 根治版）:
#  旧 bash 版は「file-read プリミティブ列挙 × 保護パス」だったが、grep/sed/awk/wc/openssl 等の
#  無数の reader を列挙し切れずバイパスされた（Marshal critical）。本版は判定モデルを反転し
#  「保護パスへの到達 → コマンド種別を問わず deny」にする。プリミティブ列挙を撤廃したため
#  あらゆる reader を一律に捕捉する。
#
#  - (A) settings.json/settings.local.json の file_path 編集 → deny（既存の二重防壁を維持）
#  - (B-1) 保護パス（settings.json deny の Read()/Bash(cat) から動的抽出、無ければ fallback）に
#          到達する任意コマンド → deny。glob は fnmatch でなく glob→regex で実マッチ（F2）。
#          パスは home/env 展開・重複スラッシュ/`.`/`..` 畳みで正規化してから照合（F4）。
#  - (B-2) 読取/実行時文脈 × 未解決のコマンド置換・動的パス構築 → fail-closed（実行時迂回防止）
#  - (B-3) osascript は display 通知系のみ allowlist、他は default-deny（macOS 迂回）
#
#  保護パス抽出は python の json で行うため jq 不在環境でも全 deny を取得できる（F3）。
#  settings.json が読めない場合のみ fallback（資格ストアを広めに網羅）。
#
#  静的難読化の網羅（Marshal R6-R9 adversarial-review 9 ラウンドで段階的に根治）:
#   quote 除去 / バックスラッシュ両解釈 / 同一コマンド代入解決 / parameter default (${v:-w}) /
#   brace 展開 ({,s}) / ANSI-C quoting ($'\xHH'/$'\nnn'/$'\uHHHH'/$'\UHHHHHHHH') を実体化し、
#   保護パス・command-only 秘匿規則に照合する。reader/runtime/exfil 文脈の未解決動的構築は
#   fail-closed。脅威モデルは多層防御の 1 層（Junior TT）= AI(Claude) 自身の confused-deputy /
#   injection / 素朴ミス経路と一般的 bypass の遮断。誤検知ゼロを生命線とする（狼少年化＝無効化を防ぐ）。
#
#  既知の限界（PIKES §5-15-9 Phase4。Marshal R9 が in-model gap 無しを確認、残余は out-of-model/実行時）:
#   - command 置換 $()/`` の出力、外部環境変数の値、symlink/realpath 到達は実行を要し静的解決不能
#     （$()/`` と / 隣接変数は (B-2) で fail-closed に倒すが、値そのものは解決しない）。
#   - 完全な shell AST 意味論（tree-sitter）は未導入。残る難読化は人間攻撃者が手組みする out-of-model。
#   - bash fallback（python3 不在時）は degraded best-effort。enforcement 保証は python3 経路。

import json
import sys
import os
import re


def emit_deny(reason):
    # 区切りはコンパクト形式（Claude Code hook 既存形式 "permissionDecision":"deny" と一致）。
    # 日本語 reason の cp932 等での UnicodeEncodeError を避けるため UTF-8 bytes で直接出力する
    # （Marshal M3: 出力時クラッシュ→fail-open を防ぐ）。
    payload = json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason
        }
    }, ensure_ascii=False, separators=(",", ":")) + "\n"
    try:
        sys.stdout.buffer.write(payload.encode("utf-8"))
        sys.stdout.buffer.flush()
    except Exception:
        sys.stdout.write(payload)
    sys.exit(0)


def normalize_home(home):
    return (home or "").replace("\\", "/").rstrip("/").lower()


def expand_aliases(s, home_l):
    s = s.replace("%userprofile%", home_l)
    s = s.replace("$env:userprofile", home_l)
    s = re.sub(r"\$\{?home\}?", home_l, s)
    s = re.sub(r"~(?=/)", home_l, s)
    return s


def normalize_path_pattern(p, home_l):
    s = p.strip().replace("\\", "/").lower()
    s = expand_aliases(s, home_l)
    s = re.sub(r"/{2,}", "/", s)
    return s


def _finish_norm(s, home_l):
    s = expand_aliases(s, home_l)
    s = re.sub(r"/{2,}", "/", s)          # 重複スラッシュ（F4: ~//.ssh）
    s = re.sub(r"/\./", "/", s)           # /./ → /
    prev = None
    while prev != s:                      # /foo/../ → /
        prev = s
        s = re.sub(r"/[^/ ]+/\.\./", "/", s)
    s = re.sub(r"\s+", " ", s)
    return s


def resolve_assignments(s):
    """同一コマンド内の単純な `VAR=value` 代入を抽出して `$VAR`/`${VAR}` を置換する（Marshal R7）。
    `d=s; cat ~/.${d}sh/id_rsa`・`r=r; secu${r}ity dump-keychain` のような自己完結型の変数
    スプライス難読化を実体化させ、B-1/command-rule で捕捉できるようにする。value に未解決変数や
    コマンド置換を含む複雑代入は展開しない（静的解決不能なため）。外部環境変数やループ変数は
    同一コマンド内に代入が無いので未解決のまま残り、既存の VARPATH/slash 隣接 fail-closed に委ねる。"""
    assigns = {}
    for m in re.finditer(r"(?:^|[;&|])\s*([a-z_][a-z0-9_]*)=([^\s;|&()`]*)", s):
        name, val = m.group(1), m.group(2)
        if "$" in val or "`" in val:   # value 自体が未解決 → 展開しない
            continue
        assigns[name] = val
    if not assigns:
        return s

    def repl(mm):
        nm = mm.group(1) or mm.group(2)
        return assigns.get(nm, mm.group(0))

    out = s
    for _ in range(5):                 # 連鎖代入の有限反復
        nxt = re.sub(r"\$\{([a-z_][a-z0-9_]*)\}|\$([a-z_][a-z0-9_]*)", repl, out)
        if nxt == out:
            break
        out = nxt
    return out


def _ansi_c_decode(content):
    simple = {"\\n": "\n", "\\t": "\t", "\\r": "\r", "\\\\": "\\",
              "\\'": "'", '\\"': '"', "\\e": "\x1b", "\\a": "\a", "\\b": "\b"}

    def rep(m):
        g = m.group(0)
        if g[1] in "xXuU":          # \xHH / \uHHHH / \UHHHHHHHH（16進）
            try:
                return chr(int(g[2:], 16))
            except (ValueError, OverflowError):
                return g
        if g[1] in "01234567":      # \nnn（8進）
            try:
                return chr(int(g[1:], 8) & 0xFF)
            except ValueError:
                return g
        return simple.get(g, g[1:])

    return re.sub(
        r"\\x[0-9a-fA-F]{1,2}|\\u[0-9a-fA-F]{1,4}|\\U[0-9a-fA-F]{1,8}|"
        r"\\[0-7]{1,3}|\\[ntr\\'\"eab]",
        rep, content)


def expand_ansi_c(s):
    """ANSI-C quoting `$'...'`（`\\xHH`/`\\nnn`/`\\t` 等）を実体化する（Marshal R8 系の静的難読化）。
    `cat ~/$'\\x2e\\x73\\x73\\x68'/id_rsa` は静的に `~/.ssh/id_rsa` になる。"""
    return re.sub(r"\$'([^']*)'", lambda m: _ansi_c_decode(m.group(1)), s)


def param_default_sub(s):
    """`${name:-word}`/`${name:=word}`/`${name-word}`/`${name+word}` 等の literal default を
    実体化する（Marshal R8）。`cat ~/.${d:-s}sh/id_rsa` は d 未設定で静的に `~/.ssh` になる。
    default/alternate の literal が保護パスを構成しうるため word を採用して照合に載せる。"""
    return re.sub(r"\$\{[a-z_][a-z0-9_]*:?[-=+]([^{}]*)\}", r"\1", s)


def brace_expand(s, cap=64):
    """単純な `{a,b}` brace expansion（非ネスト・カンマ区切り）を cartesian 展開する（Marshal R8）。
    `~/.s{,s}h` は bash 展開後に `~/.ssh` を含む。カンマ無しの `{}`（find 等）は対象外。"""
    m = re.search(r"\{([^{}]*,[^{}]*)\}", s)
    if not m:
        return [s]
    pre, post = s[:m.start()], s[m.end():]
    results = []
    for o in m.group(1).split(","):
        for v in brace_expand(pre + o + post, cap):
            results.append(v)
            if len(results) >= cap:
                return results
    return results


def normalize_variants(cmd, home_l):
    """照合用に正規化したコマンド文字列の集合を返す（Marshal R6-1/R7/R8）。
    - クォート除去: bash の quote removal は解決後パスを変えないため `'`/`"` を一律除去し、
      `cat ~/.s''sh`・`.s"s"h`・`secu''rity dump-keychain` 等の連結難読化を解消する。
    - 同一コマンド代入解決: `d=s; ... ${d} ...` の自己完結スプライスを実体化（resolve_assignments）。
    - parameter default 実体化: `${name:-word}` 等の literal default を採用（param_default_sub）。
    - brace 展開: `{,s}` 等を cartesian 展開（brace_expand）。proper 展開なので `cp f.{js,ts}` は誤検知しない。
    - バックスラッシュ: bash の escape（`\\x`→`x`）か windows/cmd のセパレータか静的には曖昧。
      両解釈（`\\`→`/` と `\\`→除去）の変種を生成し、いずれかが保護パスに一致すれば deny する
      fail-closed 方式で取りこぼしを防ぐ。"""
    s = expand_ansi_c(cmd)                 # ANSI-C quoting を先に実体化（R8 系静的難読化）
    s = s.lower().replace("'", "").replace('"', "")
    s = resolve_assignments(s)
    s = param_default_sub(s)
    base = [s.replace("\\", "/"), s.replace("\\", "")] if "\\" in s else [s]
    expanded = []
    for b in base:
        expanded.extend(brace_expand(b))
    seen = []
    for v in expanded:
        nv = _finish_norm(v, home_l)
        if nv not in seen:
            seen.append(nv)
        if len(seen) >= 128:
            break
    return seen


def glob_to_regex(p):
    """正規化済 glob パターンをパス照合用 regex に変換（F2: 実マッチ）。
    `**` はディレクトリ跨ぎ、`*` は単一セグメント。前後にパス境界を付ける。
    末尾 `/**`（ディレクトリ配下）は配下だけでなくディレクトリ自体への到達も deny
    （`tar -cf - ~/.ssh` / `ls ~/.ssh` 等の列挙・アーカイブ経由の exfil を含めて捕捉）。"""
    trail_dir = False
    if p.endswith("/**"):
        p = p[:-3]
        trail_dir = True
    out = []
    i = 0
    n = len(p)
    while i < n:
        if p[i:i+3] == "**/":
            out.append(r"(?:[^\s'\";|&]*/)?")
            i += 3
        elif p[i:i+2] == "**":
            out.append(r"[^\s'\";|&]*")
            i += 2
        elif p[i] == "*":
            out.append(r"[^/\s'\";|&]*")
            i += 1
        elif p[i] == "?":
            out.append(r"[^/\s'\";|&]")
            i += 1
        else:
            out.append(re.escape(p[i]))
            i += 1
    body = "".join(out)
    if trail_dir:
        body += r"(?:/[^\s'\";|&]*)?"
    # 前境界: 直前がパス継続文字でない（負の後読み）。`<`/`>` 等あらゆるリダイレクト・区切り記号や
    #   行頭を一律に境界扱いし、`cat<~/.ssh/id_rsa` のスペース無し迂回も捕捉（Marshal M1 critical）。
    # 後境界: パス継続文字でない（.env.example 等の部分一致誤検知を防ぐ）。
    return re.compile(r"(?<![\w./\\-])" + body + r"(?![\w./-])")


# settings.json が読めない場合の fallback 保護パス（資格ストアを広めに網羅。F3）。
FALLBACK_RAW = [
    "~/.ssh/**", "~/.aws/**", "~/.gnupg/**", "~/.kube/**", "~/.docker/**",
    "~/.npmrc", "~/.netrc", "~/.config/gh/hosts.yml", "~/.config/gh/**",
    "~/.password-store/**", "~/*.keytab",
    "/etc/shadow", "/etc/gshadow", "/etc/sudoers", "/etc/krb5.keytab",
    "**/*.env", "**/.npmrc", "**/credentials/**",
    "~/library/keychains/**", "/library/keychains/**",
    "~/.local/share/keyrings/**", "~/.kde/share/apps/kwallet/**",
    "~/.kde4/share/apps/kwallet/**",
]


def load_patterns(home_l):
    settings = home_l + "/.claude/settings.json"
    raw = []
    try:
        with open(settings, encoding="utf-8") as f:
            cfg = json.load(f)
        deny = ((cfg.get("permissions") or {}).get("deny")) or []
        for e in deny:
            if not isinstance(e, str):
                continue
            m = re.match(r"^Read\((.+)\)$", e)
            if not m:
                m = re.match(r"^Bash\(cat (.+)\)$", e)
            if not m:
                continue
            p = m.group(1)
            # settings.json 自身の読取は許可（編集は (A) で別途 file_path 保護）
            if "settings.json" in p or "settings.local.json" in p:
                continue
            raw.append(p)
    except Exception:
        raw = []
    if not raw:
        raw = FALLBACK_RAW
    pats = [normalize_path_pattern(p, home_l) for p in raw]
    # anchor-free 変種（Marshal N3）: home 固定パターンは相対遡上 `../.ssh/` や別マウントの同名
    # セグメントでも到達するため `**/<tail>` を追加し、home アンカーに依存せず保護セグメントを捕捉する。
    #   純粋な symlink（コマンド文字列に保護セグメントが一切現れない）は静的解析では不可能であり
    #   実行時 realpath を要する。これは PIKES §5-15-9 Phase4 の既知の限界として残す。
    home_prefix = home_l + "/"
    extra = []
    for p in pats:
        if p.startswith(home_prefix):
            tail = p[len(home_prefix):]
            if tail:
                extra.append("**/" + tail)
    return pats + extra


# command-only 秘匿規則（path リテラルを持たない Bash(...) deny）の fallback。settings.json から
# 動的抽出できない時に使う。CC native deny は literal/glob 一致のため `bash -c "env"` 等の wrapper で
# 回避され得る。本 hook が shell-aware に backstop する（Marshal round4）。
FALLBACK_CMD_RULES = [
    "env",
    "security dump-keychain*", "security export*",
    "security find-generic-password*-w*", "security find-internet-password*-w*",
    "keyctl read*", "keyctl print*", "keyctl pipe*",
    "secret-tool lookup*", "secret-tool search*",
    "kwallet-query*",
]

# `env` は dump 用法のみ deny（`env VAR=x cmd` の環境設定起動は正当なので除外）。
#   コマンド語境界（行頭・空白・区切り・スラッシュ・引用符）を前置に取り、`command env`・
#   `/usr/bin/env`・`time env`・`bash -c "command env"` 等の prefix/絶対パスも捕捉（Marshal round5）。
#   後続が flags のみ→区切り/終端/リダイレクトなら dump とみなす（`env NAME=value cmd` は除外）。
#   前境界をスラッシュ含む語境界にしても、後続厳格化により `cat /etc/env.conf` 等は誤検知しない。
ENV_DUMP_RE = re.compile(r"""(?:^|[\s|;&(/"'])env(?:\s+-[\w-]+)*\s*(?:$|[|;&<>"'])""")


def load_command_rules(home_l):
    """command-only 秘匿規則を settings.json から抽出し shell-aware matcher を返す。
    cat/rm は別系統（cat は path 規則、rm は破壊系）なので除外する。"""
    settings = home_l + "/.claude/settings.json"
    raw = []
    try:
        with open(settings, encoding="utf-8") as f:
            cfg = json.load(f)
        deny = ((cfg.get("permissions") or {}).get("deny")) or []
        for e in deny:
            if not isinstance(e, str):
                continue
            m = re.match(r"^Bash\((.+)\)$", e)
            if not m:
                continue
            c = m.group(1).strip()
            cl = c.lower()
            if cl.startswith("cat ") or cl.startswith("rm "):
                continue
            raw.append(cl)
    except Exception:
        raw = []
    if not raw:
        raw = [r.lower() for r in FALLBACK_CMD_RULES]
    compiled = []
    for c in raw:
        if c == "env":
            compiled.append(("env", ENV_DUMP_RE))
        else:
            # glob* → regex。コマンド語境界（行頭/区切り/引用符）から照合し wrapper も捕捉。
            rx = re.escape(c).replace(r"\*", r"[^|;&]*")
            compiled.append((c, re.compile(r"(?:^|[\s|;&(\"'])" + rx)))
    return compiled


READER_RE = re.compile(
    r"(?:^|[ |;&(])(?:cat|head|tail|less|more|od|xxd|hexdump|strings|dd|nl|tac|"
    r"base64|grep|egrep|fgrep|zgrep|sed|awk|gawk|nawk|wc|cut|cmp|diff|file|rev|"
    r"fold|paste|join|column|expand|unexpand|sort|uniq|tr|type|get-content|gc|"
    r"select-string)(?:[ ]|$)"
)
RUNTIME_RE = re.compile(
    r"python[0-9.]* +-[a-z]*c|perl +-[a-z]*e|ruby +-[a-z]*e|node +-[a-z]*e|"
    r"cmd(?:\.exe)? +/c|powershell|pwsh"
)
# アーカイブ/転送/エンコード系の exfil 可能コマンド（Marshal R6-2）。reader/runtime と同様に
# パス位置の未解決変数を fail-closed の対象文脈に含める（`tar -cf - ~/.s$d/...` 等の変数隠しを捕捉）。
EXFIL_RE = re.compile(
    r"(?:^|[ |;&(])(?:tar|openssl|gzip|gunzip|zcat|bzip2|xz|zstd|zip|unzip|"
    r"cp|rsync|scp|sftp|curl|wget|nc|ncat|socat|cpio|pax)(?:[ ]|$)"
)
# 未解決の動的構築（コマンド置換・サブシェル・PS の Join-Path）。${VAR} 単純展開は誤検知源なので除外。
DYN_RE = re.compile(r"\$\(|`|\$\{[^}]*\(|join-path")
# パス構築位置の未解決変数（`/` に隣接する $VAR/${VAR}）。reader/runtime 文脈で fail-closed に倒す。
#   `cat ~/$d/id_rsa`（保護セグメントが変数に隠れる）を捕捉。`grep "$q" file` 等の非パス変数は除外。
#   位置パラメータ・特殊パラメータ（$1/${1}/$@/$*/$#）も対象（Marshal N2）。
VARPATH_RE = re.compile(r"/\$\{?[a-z_0-9@*#]|\$\{?[a-z_0-9@*#][\w]*\}?/")


def main():
    raw = sys.stdin.read()
    try:
        data = json.loads(raw)
    except Exception:
        return
    if not isinstance(data, dict):
        return
    ti = data.get("tool_input")
    if not isinstance(ti, dict):
        ti = {}

    home_l = normalize_home(
        os.environ.get("HOME") or os.environ.get("USERPROFILE") or ""
    )

    # (A) settings.json file_path 保護（既存）
    fp = str(ti.get("file_path") or data.get("file_path") or "").replace("\\", "/").lower()
    if ("settings.json" in fp or "settings.local.json" in fp) and ".claude" in fp:
        emit_deny("settings.json の編集は禁止されています（hooks 二重防壁）。"
                  "ルール変更はユーザー（人間）に直接依頼してください。")

    cmd = str(ti.get("command") or data.get("command") or "")
    if not cmd.strip():
        return

    norms = normalize_variants(cmd, home_l)   # バックスラッシュ両解釈を含む変種集合（R6-1）

    def any_match(rx):
        return any(rx.search(n) for n in norms)

    patterns = load_patterns(home_l)

    # (B-1) 保護パス到達 → コマンド種別を問わず deny（grep/sed/awk/openssl 等も網羅）
    for p in patterns:
        try:
            rx = glob_to_regex(p)
        except re.error:
            continue
        if any_match(rx):
            emit_deny("保護パス（%s）へのアクセスを settings-guard がブロック"
                      "（shell-aware enforcement）。" % p)

    # (B-1.5) command-only 秘匿規則（env dump / security / keyctl / secret-tool / kwallet-query）を
    #          shell-aware に backstop（path リテラルを持たないため B-1 では捕捉できない。Marshal round4）
    for label, rx in load_command_rules(home_l):
        if any_match(rx):
            emit_deny("秘匿取得コマンド（%s）を settings-guard がブロック"
                      "（shell-aware enforcement）。" % label)

    # (B-2) 読取/実行時/exfil 文脈 × 未解決の動的構築（コマンド置換 or パス位置の変数）→ fail-closed
    if any_match(READER_RE) or any_match(RUNTIME_RE) or any_match(EXFIL_RE):
        if any_match(DYN_RE):
            emit_deny("読取/転送コマンドに未解決のコマンド置換/動的パス構築があり最終パスを"
                      "静的解決できないため fail-closed でブロック。")
        if any_match(VARPATH_RE):
            emit_deny("読取/転送コマンドのパス位置に未解決の変数があり保護パス到達を静的に"
                      "判定できないため fail-closed でブロック（実行時パス構築の迂回防止）。")

    # (B-3) osascript は display 通知系のみ allowlist、他は default-deny
    if any("osascript" in n for n in norms):
        bad_rx = re.compile(
            r"do shell script|do script|read |open for access|write |path to |posix|"
            r"alias |objc|nsstring|nsdata|set [a-z_]+ to|/\.ssh/|/\.aws/|/\.gnupg/|"
            r"/library/keychains/|settings"
        )
        ok_rx = re.compile(r"osascript +-e +.{0,6}display (?:notification|dialog|alert)")
        ok = any(ok_rx.search(n) for n in norms)
        bad = any(bad_rx.search(n) for n in norms)
        if not (ok and not bad):
            emit_deny("osascript はスクリプトファイル実行・file/path/shell API を含むため "
                      "default-deny（display 通知のみ allowlist）。")


main()
