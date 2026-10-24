"use strict";

// src/hook-entry.ts
var import_node_fs4 = require("node:fs");

// src/constants.ts
var HEARTBEAT_DEAD_MS = 9e4;
var STALE_JOB_MS = 24 * 60 * 60 * 1e3;
var KILL_CONFIRM_MS = 1e3;
var KILL_RETRY_LIMIT = 3;
var KILL_ATTEMPT_WINDOWS = 2;
var KILL_CALLS_PER_TICK = 2;
var KILL_CONFIRM_WAITS_PER_ATTEMPT = 1;
var TICK_KILL_MAX_MS = KILL_CALLS_PER_TICK * KILL_RETRY_LIMIT * (KILL_ATTEMPT_WINDOWS + KILL_CONFIRM_WAITS_PER_ATTEMPT) * KILL_CONFIRM_MS;
var MS_PER_MIN = 6e4;
var STORE_RETRY_LIMIT = 8;
var STORE_RETRY_BASE_MS = 15;
var SPAWNED_BY_ENV = "AWAYGATE_SPAWNED_BY";
var LEASE_IDLE_MS = 3 * MS_PER_MIN;
var WAKE_WINDOW_MS = 6e4;
var HOOK_STATE_READ_RETRIES = 3;
var HOOK_STATE_RETRY_MS = 5;
var CLASSIFY_MAX_DEPTH = 3;
var PW_LOCK_STALE_MS = 10 * MS_PER_MIN;

// src/hook-main.ts
var import_node_fs3 = require("node:fs");
var import_node_path2 = require("node:path");

// src/classify.ts
var LIGHT = { kind: "light", rule: "light" };
function isSpace(c) {
  return c === void 0 || c === " " || c === "	" || c === "\r" || c === "\n";
}
function scanCommand(cmd) {
  const segs = [];
  const bodies = [];
  let cur = "";
  let unterminated = false;
  const pending = [];
  const n = cmd.length;
  let i = 0;
  const push = () => {
    if (cur.trim().length > 0) segs.push(cur);
    cur = "";
  };
  const skipHeredocBodies = () => {
    for (const h of pending) {
      let closed = false;
      let body = "";
      while (i < n) {
        let j = cmd.indexOf("\n", i);
        if (j < 0) j = n;
        const line = cmd.slice(i, j).replace(/\r$/, "");
        i = Math.min(n, j + 1);
        const cmp = h.dash ? line.replace(/^\t+/, "") : line;
        if (cmp === h.delim || cmp.trim() === h.delim) {
          closed = true;
          break;
        }
        body += `${line}
`;
      }
      if (!closed) unterminated = true;
      if (h.expand) bodies.push({ text: body, shell: "bash" });
    }
    pending.length = 0;
  };
  while (i < n) {
    const c = cmd.charAt(i);
    const next = cmd.charAt(i + 1);
    if ((c === "\\" || c === "`") && (next === "\n" || next === "\r" && cmd.charAt(i + 2) === "\n")) {
      cur += " ";
      i += next === "\r" ? 3 : 2;
      continue;
    }
    if (c === "@" && (next === "'" || next === '"') && /^[ \t]*\r?\n/.test(cmd.slice(i + 2))) {
      const term = `
${next}@`;
      const end = cmd.indexOf(term, i + 2);
      if (end < 0) unterminated = true;
      if (next === '"') bodies.push({ text: cmd.slice(i + 2, end < 0 ? n : end), shell: "powershell" });
      cur += `${next}${next}`;
      i = end < 0 ? n : end + term.length;
      continue;
    }
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      const stop = end < 0 ? n : end + 1;
      cur += cmd.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        const d = cmd.charAt(j);
        if ((d === "\\" || d === "`") && j + 1 < n) {
          j += 2;
          continue;
        }
        if (d === '"') break;
        j++;
      }
      const stop = Math.min(n, j + 1);
      cur += cmd.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === "<" && next === "<" && cmd.charAt(i + 2) !== "<") {
      let j = i + 2;
      let dash = false;
      if (cmd.charAt(j) === "-") {
        dash = true;
        j++;
      }
      while (cmd.charAt(j) === " " || cmd.charAt(j) === "	") j++;
      let q = "";
      let quoted = false;
      if (cmd.charAt(j) === "'" || cmd.charAt(j) === '"') {
        q = cmd.charAt(j++);
        quoted = true;
      } else if (cmd.charAt(j) === "\\") {
        j++;
        quoted = true;
      }
      const start = j;
      while (j < n && !isSpace(cmd.charAt(j)) && !";|&()<>".includes(cmd.charAt(j)) && cmd.charAt(j) !== q) j++;
      const word = cmd.slice(start, j);
      if (q && cmd.charAt(j) === q) j++;
      if (word.length > 0) {
        pending.push({ delim: word, dash, expand: !quoted });
        i = j;
        continue;
      }
    }
    if (c === "#" && (cur.length === 0 || isSpace(cur.charAt(cur.length - 1)))) {
      const e = cmd.indexOf("\n", i);
      i = e < 0 ? n : e;
      continue;
    }
    if (c === "\n") {
      push();
      i++;
      if (pending.length > 0) skipHeredocBodies();
      continue;
    }
    if (c === ";" || c === "(" || c === ")" || c === "{" || c === "}") {
      if ((c === "{" || c === "}") && (cur.endsWith("$") || /\$\{[^}]*$/.test(cur))) {
        cur += c;
        i++;
        continue;
      }
      push();
      i++;
      continue;
    }
    if (c === "|") {
      push();
      i += next === "|" ? 2 : 1;
      continue;
    }
    if (c === "&") {
      if (next === "&") {
        push();
        i += 2;
        continue;
      }
      const prev = cur.trimEnd().slice(-1);
      if (prev === ">" || prev === "<" || next === ">") {
        cur += c;
        i++;
        continue;
      }
      if (cur.trim().length === 0) {
        cur += "& ";
        i++;
        continue;
      }
      push();
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  push();
  return { segs, unterminated, bodies };
}
function findSubstitutions(text, shell) {
  const out = [];
  const n = text.length;
  let i = 0;
  let dq = false;
  while (i < n) {
    const c = text.charAt(i);
    if (c === "'" && !dq) {
      const e = text.indexOf("'", i + 1);
      i = e < 0 ? n : e + 1;
      continue;
    }
    if (c === '"') {
      dq = !dq;
      i++;
      continue;
    }
    if (c === "\\" && shell === "bash" || c === "`" && shell === "powershell") {
      i += 2;
      continue;
    }
    if (c === "$" && text.charAt(i + 1) === "(") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        const d = text.charAt(j);
        if (d === "(") depth++;
        else if (d === ")") depth--;
        j++;
      }
      out.push(text.slice(i + 2, depth === 0 ? j - 1 : n));
      i = j;
      continue;
    }
    if (c === "`" && shell === "bash") {
      let j = i + 1;
      while (j < n && !(text.charAt(j) === "`" && text.charAt(j - 1) !== "\\")) j++;
      out.push(text.slice(i + 1, j));
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}
function tokenize(seg) {
  const out = [];
  let cur = "";
  let has = false;
  const n = seg.length;
  let i = 0;
  while (i < n) {
    const c = seg.charAt(i);
    if (c === "'") {
      const end = seg.indexOf("'", i + 1);
      cur += seg.slice(i + 1, end < 0 ? n : end);
      has = true;
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = "";
      while (j < n) {
        const d = seg.charAt(j);
        if ((d === "\\" || d === "`") && j + 1 < n && (seg.charAt(j + 1) === '"' || seg.charAt(j + 1) === d)) {
          s += seg.charAt(j + 1);
          j += 2;
          continue;
        }
        if (d === '"') break;
        s += d;
        j++;
      }
      cur += s;
      has = true;
      i = Math.min(n, j + 1);
      continue;
    }
    if (c === "\\" && seg.charAt(i + 1) === " ") {
      cur += " ";
      has = true;
      i += 2;
      continue;
    }
    if (c === " " || c === "	" || c === "\r" || c === "\n") {
      if (has) out.push(cur);
      cur = "";
      has = false;
      i++;
      continue;
    }
    cur += c;
    has = true;
    i++;
  }
  if (has) out.push(cur);
  return out;
}
function baseName(x) {
  const s = x.replace(/\\/g, "/");
  return (s.slice(s.lastIndexOf("/") + 1) || s).toLowerCase();
}
function progName(x) {
  return baseName(x).replace(/\.(exe|cmd|bat|com)$/, "");
}
var NODE_LIKE = /* @__PURE__ */ new Set(["node", "nodejs", "tsx", "ts-node", "bun", "deno", "npx", "electron"]);
var SHELL_BASH = /* @__PURE__ */ new Set(["bash", "sh", "zsh", "dash", "ash"]);
var SHELL_PS = /* @__PURE__ */ new Set(["powershell", "pwsh"]);
var WRAPPERS = /* @__PURE__ */ new Set(["&", ".", "call", "nohup", "setsid", "stdbuf", "time", "exec", "sudo", "command", "builtin", "env", "nice", "timeout", "if", "then", "else", "elif", "do", "while", "until", "!"]);
var VARIABLE_ONLY = /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/;
var READ_ONLY = /* @__PURE__ */ new Set([
  "rg",
  "grep",
  "egrep",
  "fgrep",
  "sed",
  "awk",
  "gawk",
  "cat",
  "bat",
  "less",
  "more",
  "ls",
  "dir",
  "head",
  "tail",
  "tasklist",
  "echo",
  "printf",
  "findstr",
  "select-string",
  "sls",
  "get-content",
  "gc",
  "type",
  "get-filehash",
  "git",
  "ps",
  "wc",
  "sort",
  "uniq",
  "cut",
  "tr",
  "diff",
  "cmp",
  "stat",
  "file",
  "find",
  "fd",
  "where",
  "which",
  "write-output",
  "write-host",
  "out-file",
  "tee",
  "cp",
  "mv",
  "rm",
  "mkdir",
  "touch",
  "set-content",
  "add-content",
  "get-process",
  "taskkill",
  "stop-process"
]);
function escapeRe(s) {
  return s.replace(/[.*+?^$()|{}[\]\\]/g, "\\$&");
}
function isHeavyScript(arg, cfg) {
  const b = baseName(arg.replace(/^["']|["']$/g, ""));
  for (const h of cfg.heavyScripts) {
    const hl = h.toLowerCase();
    if (b === hl) return h;
    if (!/\.[a-z0-9]+$/.test(hl) && new RegExp("^" + escapeRe(hl) + "\\.[cm]?[jt]s$").test(b)) return h;
  }
  return null;
}
function decodeEncoded(b64) {
  try {
    const buf = Buffer.from(b64, "base64");
    if (buf.length === 0) return null;
    return buf.toString("utf16le");
  } catch {
    return null;
  }
}
function unwrapStartProcess(args) {
  let file;
  let argList = [];
  const rest = [];
  const optsWithValue = /* @__PURE__ */ new Set(["-verb", "-windowstyle", "-workingdirectory", "-redirectstandardoutput", "-redirectstandarderror", "-redirectstandardinput", "-credential", "-wd"]);
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    const al = a.toLowerCase();
    if (al === "-filepath" || al === "-fp") {
      file = args[++k];
    } else if (al === "-argumentlist" || al === "-args") {
      const v = args[++k] ?? "";
      argList = v.includes(",") && !/\s/.test(v) ? v.split(",") : tokenize(v);
    } else if (optsWithValue.has(al)) {
      k++;
    } else if (al.startsWith("-") && !al.startsWith("--")) {
    } else if (file === void 0) {
      file = a;
    } else {
      rest.push(a);
    }
  }
  return file === void 0 ? [] : [file, ...argList, ...rest];
}
var WRAPPER_OPT_ARGS = {
  env: /* @__PURE__ */ new Set(["-u", "--unset", "-C", "--chdir"]),
  exec: /* @__PURE__ */ new Set(["-a"]),
  sudo: /* @__PURE__ */ new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-r", "-t", "--user", "--group"]),
  timeout: /* @__PURE__ */ new Set(["-s", "-k", "--signal", "--kill-after"]),
  nice: /* @__PURE__ */ new Set(["-n", "--adjustment"]),
  time: /* @__PURE__ */ new Set(["-f", "--format", "-o", "--output"]),
  stdbuf: /* @__PURE__ */ new Set(["-i", "-o", "-e"])
};
var OPTION_WRAPPERS = /* @__PURE__ */ new Set(["command", "builtin", "nohup", "setsid", ...Object.keys(WRAPPER_OPT_ARGS)]);
function skipWrapperOptions(head, toks) {
  if (!OPTION_WRAPPERS.has(head)) return { toks, lookup: false };
  const withArg = WRAPPER_OPT_ARGS[head];
  let t = toks;
  let lookup = false;
  while (t.length > 0 && t[0].startsWith("-") && t[0].length > 1) {
    const o = t[0];
    if (o === "--") {
      t = t.slice(1);
      break;
    }
    if (head === "command" && /^-[vV]$/.test(o)) lookup = true;
    if (head === "env" && (o === "-S" || o === "--split-string")) {
      t = [...tokenize(t[1] ?? ""), ...t.slice(2)];
      continue;
    }
    if (withArg?.has(o)) {
      t = t.slice(2);
      continue;
    }
    t = t.slice(1);
  }
  if (head === "timeout" && t.length > 0 && /^[\d.]+[smhd]?$/.test(t[0])) t = t.slice(1);
  return { toks: t, lookup };
}
function classifyInner(inner, cfg, depth, shell) {
  if (depth + 1 > CLASSIFY_MAX_DEPTH) return { kind: "light", rule: "nested-too-deep", unparsable: true };
  return classifyCommand(inner, cfg, depth + 1, shell);
}
function classifySegment(seg, cfg, depth, shell) {
  for (const sub of findSubstitutions(seg, shell)) {
    const r = classifyInner(sub, cfg, depth, shell);
    if (r.kind !== "light" || r.unparsable) return r;
  }
  let toks = tokenize(seg);
  let called = false;
  for (let guard = 0; guard < 16; guard++) {
    while (toks.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0])) toks = toks.slice(1);
    const head = (toks[0] ?? "").toLowerCase();
    if (head === "start-process" || head === "saps") {
      toks = unwrapStartProcess(toks.slice(1));
      continue;
    }
    if (head === "start") {
      toks = toks.slice(1).filter((t) => !t.startsWith("/") && t !== "");
      continue;
    }
    if (WRAPPERS.has(head)) {
      if (head === "&" || head === ".") called = true;
      const skipped = skipWrapperOptions(head, toks.slice(1));
      if (skipped.lookup) return LIGHT;
      toks = skipped.toks;
      continue;
    }
    break;
  }
  if (toks.length === 0) return LIGHT;
  const first = toks[0];
  if (VARIABLE_ONLY.test(first) && (shell === "bash" || called)) return { kind: "light", rule: "indirect-exec", unparsable: true };
  const prog = progName(first);
  const args = toks.slice(1);
  if (prog === "away-gate" || NODE_LIKE.has(prog) && args[0] !== void 0 && /^away-gate(-hook)?(\.cjs)?$/.test(baseName(args[0]))) {
    return { kind: "light", rule: "away-gate-cli" };
  }
  const direct = isHeavyScript(first, cfg);
  if (direct !== null) return { kind: "heavy", rule: `heavy:${direct}`, detail: first };
  let inner = null;
  let innerShell = shell;
  let unparsable = false;
  if (SHELL_BASH.has(prog)) {
    const idx = args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
    if (idx >= 0) inner = args[idx + 1] ?? null;
    innerShell = "bash";
  } else if (prog === "cmd") {
    const idx = args.findIndex((a) => /^\/[ck]$/i.test(a));
    if (idx >= 0) inner = args.slice(idx + 1).join(" ").replace(/\^(.)/g, "$1");
    innerShell = "powershell";
  } else if (SHELL_PS.has(prog)) {
    const idx = args.findIndex((a) => /^-(c|command)$/i.test(a));
    const enc = args.findIndex((a) => /^-(e|ec|enc|encodedcommand)$/i.test(a));
    if (idx >= 0) inner = args.slice(idx + 1).join(" ");
    else if (enc >= 0) {
      inner = decodeEncoded(args[enc + 1] ?? "");
      if (inner === null) unparsable = true;
    }
    innerShell = "powershell";
  } else if (prog === "eval") {
    inner = args.join(" ");
    innerShell = "bash";
  } else if (prog === "iex" || prog === "invoke-expression") {
    inner = args.join(" ");
    innerShell = "powershell";
    if (VARIABLE_ONLY.test(inner.trim())) return { kind: "light", rule: "indirect-exec", unparsable: true };
  }
  if (inner !== null) {
    const r = classifyInner(inner, cfg, depth, innerShell);
    if (r.kind !== "light" || r.unparsable) return r;
    return LIGHT;
  }
  if (unparsable) return { kind: "light", rule: "encoded-undecodable", unparsable: true };
  if (NODE_LIKE.has(prog)) {
    for (const a of args) {
      const v = a.includes("=") && a.startsWith("-") ? a.slice(a.indexOf("=") + 1) : a;
      const h = isHeavyScript(v, cfg);
      if (h !== null) return { kind: "heavy", rule: `heavy:${h}`, detail: a };
    }
  }
  if (!READ_ONLY.has(prog) && args.some((a) => /^--remote-debugging-port(=|$)/.test(a))) {
    return { kind: "desktop", rule: "remote-debugging-port", detail: first };
  }
  return LIGHT;
}
function classifyCommand(cmd, cfg, depth = 0, shell = "bash") {
  let worst = LIGHT;
  const scan = scanCommand(cmd);
  for (const seg of scan.segs) {
    const r = classifySegment(seg, cfg, depth, shell);
    if (r.kind !== "light") return r;
    if (r.unparsable) worst = r;
  }
  for (const body of scan.bodies) {
    for (const sub of findSubstitutions(body.text, body.shell)) {
      const r = classifyInner(sub, cfg, depth, body.shell);
      if (r.kind !== "light") return r;
      if (r.unparsable) worst = r;
    }
  }
  if (worst === LIGHT && scan.unterminated) return { kind: "light", rule: "heredoc-unterminated", unparsable: true };
  return worst;
}
function classifyCall(toolName, toolInput, cfg, ctx) {
  for (const p of cfg.lightToolPrefixes) if (toolName.startsWith(p)) return { kind: "light", rule: `light-tool:${p}` };
  if (toolName.startsWith("mcp__playwright__")) {
    if (ctx.playwrightHeadless === true) return { kind: "light", rule: "playwright-headless" };
    return { kind: "desktop", rule: "playwright-headed", detail: ctx.playwrightHeadless === null ? "\u5B9A\u7FA9\u304C\u8AAD\u3081\u3093\uFF08desktop \u3068\u3057\u3066\u6271\u3046\uFF09" : void 0 };
  }
  for (const p of cfg.desktopToolPrefixes) if (toolName.startsWith(p)) return { kind: "desktop", rule: `desktop-tool:${p}` };
  if (toolName === "Bash" || toolName === "PowerShell") {
    const command = typeof toolInput === "object" && toolInput !== null ? toolInput.command : void 0;
    if (typeof command !== "string") return LIGHT;
    return classifyCommand(command, cfg, 0, toolName === "PowerShell" ? "powershell" : "bash");
  }
  return LIGHT;
}

// src/lease.ts
function leaseExpired(lease, now) {
  return now >= lease.expiresAt;
}

// src/decide.ts
var PASS = { pass: true, out: null, log: null, touch: false, wake: false };
function denyOutput(reason) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
}
function daemonLiveness(state, lock, now, pidAlive2) {
  if (now - state.heartbeatAt > HEARTBEAT_DEAD_MS) return { alive: false, why: "heartbeat-old" };
  if (lock === null) return { alive: false, why: "no-lock" };
  if (lock.procStart === null || state.daemon.procStart === null) return { alive: false, why: "no-procstart" };
  if (lock.pid !== state.daemon.pid || lock.procStart !== state.daemon.procStart) return { alive: false, why: "lock-mismatch" };
  if (!pidAlive2) return { alive: false, why: "pid-dead" };
  return { alive: true, why: "alive" };
}
function failOpen(why, wake) {
  return { pass: true, out: null, log: { verdict: "failopen", why }, touch: false, wake };
}
function situationText(s, sessionId, now) {
  if (s.phase !== "afk") {
    return s.phase === "arming" ? { code: "arming", text: "\u96E2\u5E2D\u306E\u6E96\u5099\u4E2D\uFF08arming\uFF09\u3067\u3001\u4EBA\u306F\u307E\u3060\u5E2D\u306B\u5C45\u308B\u3068\u307F\u306A\u3059" } : { code: "present", text: "\u3044\u307E\u4EBA\u304C\u5E2D\u306B\u5C45\u308B\uFF08present\uFF09" };
  }
  const l = s.lease;
  if (l !== null && !leaseExpired(l, now) && l.sessionId !== sessionId) {
    return { code: "afk-other-lease", text: `\u96E2\u5E2D\u4E2D\u3060\u304C\u3001\u4ED6\u306E\u30EC\u30FC\u30F3\uFF08${l.sessionId.slice(0, 8)}\uFF09\u304C\u673A\u3092\u8CB8\u51FA\u4E2D` };
  }
  return { code: "afk-no-lease", text: "\u96E2\u5E2D\u4E2D\u3060\u304C\u3001\u3053\u306E\u30BB\u30C3\u30B7\u30E7\u30F3\u306B\u306F\u673A\u306E\u8CB8\u51FA\u304C\u7121\u3044" };
}
function reasonText(i, sit) {
  const c = i.cli;
  const head = `AwayGate: ${sit.text}\u3002\u305D\u306E\u305F\u3081\u3001`;
  if (i.cls.kind === "heavy") {
    return [
      `${head}\u91CD\u3044\u8A66\u9A13\u306E\u76F4\u63A5\u306E\u8D77\u52D5\uFF08${i.toolName}\u3001\u898F\u5247 ${i.cls.rule}\uFF09\u306F\u901A\u305B\u3093\u3002`,
      `\u4EE3\u308F\u308A\u306B: ${c} run --class heavy --est <\u898B\u8FBC\u307F\u5206> -- <\u5143\u306E\u30B3\u30DE\u30F3\u30C9> \u3067\u884C\u5217\u306B\u8F09\u305B\u308B\uFF08\u96E2\u5E2D\u4E2D\u306B\u8ABF\u505C\u8005\u304C 1 \u672C\u305A\u3064\u6D41\u3059\uFF09\u3002`,
      `\u8F09\u305B\u305F\u3089 ${c} wait <id> \u3092 Bash \u30C4\u30FC\u30EB\u306E run_in_background \u3067\u547C\u3073\u3001\u5B8C\u4E86\u306E\u901A\u77E5\u3092\u5F85\u3064\uFF08\u524D\u666F\u3067\u5F85\u3064\u3068\u9577\u3044\u3068\u304D\u306B\u5207\u308C\u308B\uFF09\u3002`
    ].join("\n");
  }
  const hint = i.cls.rule === "playwright-headed" ? "\nPlaywright \u3092 headless \u306B\u3059\u308C\u3070\u673A\u3092\u4F7F\u308F\u305A\u3001\u3053\u306E\u5236\u9650\u3082\u53D7\u3051\u3093\uFF08~/.claude.json \u306E mcpServers.playwright.args \u306B --headless \u3092\u8DB3\u3059\u3002\u3089\u3044\u304A\u306E\u8A2D\u5B9A\u5909\u66F4\u306A\u306E\u3067\u3001\u52DD\u624B\u306B\u66F8\u304D\u63DB\u3048\u305A\u4F9D\u983C\u3059\u308B\uFF09\u3002" : "";
  const runHint = i.cls.rule === "remote-debugging-port" ? `
\u307E\u305F\u306F ${c} run --class desktop --est <\u898B\u8FBC\u307F\u5206> -- <\u5143\u306E\u30B3\u30DE\u30F3\u30C9> \u3067\u884C\u5217\u306B\u8F09\u305B\u308B\u3002` : "";
  return [
    `${head}\u673A\uFF08\u753B\u9762\u30FB\u5165\u529B\uFF09\u3092\u4F7F\u3046\u547C\u3073\u51FA\u3057\uFF08${i.toolName}\u3001\u898F\u5247 ${i.cls.rule}\uFF09\u306F\u901A\u305B\u3093\u3002`,
    `\u4EE3\u308F\u308A\u306B: ${c} lease --est <\u898B\u8FBC\u307F\u5206> \u3092 Bash \u30C4\u30FC\u30EB\u306E run_in_background \u3067\u547C\u3076\uFF08\u524D\u666F\u3067\u547C\u3076\u3068\u5F85\u3061\u304C\u9577\u3044\u3068\u304D\u306B\u5207\u308C\u308B\uFF09\u3002`,
    `\u8CB8\u51FA\u304C\u59CB\u307E\u3063\u305F\u5B8C\u4E86\u306E\u901A\u77E5\u304C\u6765\u3066\u304B\u3089\u3001\u3053\u306E\u547C\u3073\u51FA\u3057\u3092\u3084\u308A\u76F4\u3059\u3002\u7D42\u308F\u3063\u305F\u3089 ${c} release \u3092\u547C\u3076\u3002\u4EBA\u304C\u623B\u308B\u3068\u8CB8\u51FA\u306F\u5931\u52B9\u3057\u3001\u673A\u306E\u547C\u3073\u51FA\u3057\u306F\u307E\u305F\u6B62\u307E\u308B\u3002` + runHint + hint
  ].join("\n");
}
function decide(i) {
  if (i.mode === "off") return PASS;
  if (i.cls.kind === "light") {
    if (i.cls.unparsable === true) return failOpen(`unparsable:${i.cls.rule}`, false);
    return PASS;
  }
  if (i.state.kind === "absent") return failOpen("state-absent", true);
  if (i.state.kind === "unknown") return failOpen(`state-unknown:${i.state.reason}`, false);
  const s = i.state.state;
  const live = daemonLiveness(s, i.lock, i.now, i.pidAlive);
  if (!live.alive) return failOpen(`daemon-dead:${live.why}`, true);
  if (s.phase === "afk" && s.lease !== null && !leaseExpired(s.lease, i.now) && i.sessionId !== null && s.lease.sessionId === i.sessionId) {
    return { pass: true, out: null, log: { verdict: "lease-pass", why: `lease:${i.cls.rule}` }, touch: true, wake: false };
  }
  const sit = situationText(s, i.sessionId, i.now);
  if (i.mode === "soft") {
    return { pass: true, out: null, log: { verdict: "soft-would-deny", why: `${sit.code}:${i.cls.rule}` }, touch: false, wake: false };
  }
  return { pass: false, out: denyOutput(reasonText(i, sit)), log: { verdict: "deny", why: `${sit.code}:${i.cls.rule}` }, touch: false, wake: false };
}

// src/hookrules.ts
var DEFAULT_CONFIG = {
  heavyScripts: ["burn.cjs", "repeat-suite"],
  desktopToolPrefixes: ["mcp__claude-in-chrome__", "mcp__computer"],
  lightToolPrefixes: []
};
function strArray(v, key) {
  if (v === void 0) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x.length === 0)) return `${key} \u306F\u7A7A\u3067\u306A\u3044\u6587\u5B57\u5217\u306E\u914D\u5217`;
  return v;
}
function playwrightHeadless(text) {
  if (text === null) return null;
  try {
    const v = JSON.parse(text);
    if (typeof v !== "object" || v === null) return null;
    const servers = v.mcpServers;
    if (typeof servers !== "object" || servers === null) return null;
    const pw = servers.playwright;
    if (typeof pw !== "object" || pw === null) return null;
    const args = pw.args;
    if (!Array.isArray(args)) return null;
    return args.some((a) => typeof a === "string" && /^--headless(=true)?$/.test(a));
  } catch {
    return null;
  }
}
function parseConfig(text) {
  if (text === null) return { kind: "default", config: DEFAULT_CONFIG };
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return { kind: "broken", reason: "JSON \u3068\u3057\u3066\u8AAD\u3081\u3093", config: DEFAULT_CONFIG };
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return { kind: "broken", reason: "\u30AA\u30D6\u30B8\u30A7\u30AF\u30C8\u3067\u306A\u3044", config: DEFAULT_CONFIG };
  const o = v;
  const heavy = strArray(o["heavyScripts"], "heavyScripts");
  const desk = strArray(o["desktopToolPrefixes"], "desktopToolPrefixes");
  const light = strArray(o["lightToolPrefixes"], "lightToolPrefixes");
  for (const x of [heavy, desk, light]) if (typeof x === "string") return { kind: "broken", reason: x, config: DEFAULT_CONFIG };
  return {
    kind: "ok",
    config: {
      heavyScripts: [...DEFAULT_CONFIG.heavyScripts, ...heavy],
      desktopToolPrefixes: [...DEFAULT_CONFIG.desktopToolPrefixes, ...desk],
      lightToolPrefixes: [...DEFAULT_CONFIG.lightToolPrefixes, ...light]
    }
  };
}

// src/paths.ts
var import_node_os = require("node:os");
var import_node_path = require("node:path");
function claudeJsonPath(env) {
  const p = env["AWAYGATE_CLAUDE_JSON"];
  return p && p.length > 0 ? p : (0, import_node_path.join)((0, import_node_os.homedir)(), ".claude.json");
}
function hookLogFile(p, day) {
  return (0, import_node_path.join)(p.home, `hook-${day}.log`);
}
function touchFile(p, sessionId) {
  return /^[A-Za-z0-9_-]{1,100}$/.test(sessionId) ? (0, import_node_path.join)(p.touchDir, `${sessionId}.json`) : null;
}
function resolveHome(env) {
  const h = env["AWAYGATE_HOME"];
  return h && h.length > 0 ? h : (0, import_node_path.join)((0, import_node_os.homedir)(), ".ccpit", "away-gate");
}
function appConfigPath(env) {
  const p = env["AWAYGATE_APP_CONFIG"];
  return p && p.length > 0 ? p : (0, import_node_path.join)((0, import_node_os.homedir)(), ".ccpit", "app-config.json");
}
function pathsFor(home) {
  return {
    home,
    state: (0, import_node_path.join)(home, "state.json"),
    queueDir: (0, import_node_path.join)(home, "queue"),
    logDir: (0, import_node_path.join)(home, "log"),
    events: (0, import_node_path.join)(home, "events.log"),
    config: (0, import_node_path.join)(home, "config.json"),
    binDir: (0, import_node_path.join)(home, "bin"),
    inbox: (0, import_node_path.join)(home, "inbox"),
    outbox: (0, import_node_path.join)(home, "outbox"),
    quarantine: (0, import_node_path.join)(home, "quarantine"),
    lock: (0, import_node_path.join)(home, "daemon.lock"),
    touchDir: (0, import_node_path.join)(home, "touch"),
    wakeClaim: (0, import_node_path.join)(home, "wake.claim")
  };
}

// src/readers.ts
var import_node_fs = require("node:fs");

// src/lock.ts
function parseLock(text) {
  try {
    const v = JSON.parse(text);
    if (typeof v.pid !== "number" || typeof v.startedAt !== "number") return null;
    return { pid: v.pid, procStart: typeof v.procStart === "string" ? v.procStart : null, startedAt: v.startedAt, ready: v.ready === true };
  } catch {
    return null;
  }
}

// src/types.ts
var SCHEMA_VERSION = 1;

// src/schema.ts
var PHASES = ["present", "arming", "afk"];
var MODES = ["off", "soft", "strict"];
function isObj(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function parseState(text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return { kind: "bad", reason: "JSON \u3068\u3057\u3066\u8AAD\u3081\u3093" };
  }
  if (!isObj(v)) return { kind: "bad", reason: "\u30AA\u30D6\u30B8\u30A7\u30AF\u30C8\u3067\u306A\u3044" };
  if (v["schemaVersion"] !== SCHEMA_VERSION) return { kind: "bad", reason: `\u30B9\u30AD\u30FC\u30DE\u306E\u7248\u304C\u9055\u3046\uFF08${String(v["schemaVersion"])}\uFF09` };
  if (typeof v["phase"] !== "string" || !PHASES.includes(v["phase"])) return { kind: "bad", reason: "phase \u304C\u4E0D\u6B63" };
  if (typeof v["mode"] !== "string" || !MODES.includes(v["mode"])) return { kind: "bad", reason: "mode \u304C\u4E0D\u6B63" };
  if (typeof v["heartbeatAt"] !== "number") return { kind: "bad", reason: "heartbeatAt \u304C\u4E0D\u6B63" };
  if (!isObj(v["daemon"]) || typeof v["daemon"]["pid"] !== "number") return { kind: "bad", reason: "daemon \u304C\u4E0D\u6B63" };
  return { kind: "ok", value: v };
}
function parseMode(text) {
  try {
    const v = JSON.parse(text);
    if (isObj(v) && typeof v["awayGateMode"] === "string" && MODES.includes(v["awayGateMode"])) {
      return v["awayGateMode"];
    }
  } catch {
  }
  return "soft";
}

// src/readers.ts
function readText(path) {
  try {
    return (0, import_node_fs.readFileSync)(path, "utf8");
  } catch {
    return null;
  }
}
function readLock(p) {
  const text = readText(p.lock);
  return text === null ? null : parseLock(text);
}
function readMode(appConfig) {
  const text = readText(appConfig);
  return text === null ? "soft" : parseMode(text);
}
function readTextFile(path) {
  return readText(path);
}

// src/store.ts
var import_node_fs2 = require("node:fs");
var tmpCounter = 0;
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function isTransient(e) {
  const code = e.code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}
function appendHookLog(p, day, line) {
  (0, import_node_fs2.mkdirSync)(p.home, { recursive: true });
  (0, import_node_fs2.appendFileSync)(hookLogFile(p, day), `${JSON.stringify(line)}
`, "utf8");
}
function writeTouch(p, sessionId, at) {
  const path = touchFile(p, sessionId);
  if (path === null) return false;
  const tmp = `${path}.tmp-${process.pid}-${tmpCounter++}`;
  try {
    (0, import_node_fs2.mkdirSync)(p.touchDir, { recursive: true });
    (0, import_node_fs2.writeFileSync)(tmp, JSON.stringify({ at }), "utf8");
    for (let i = 0; i < STORE_RETRY_LIMIT; i++) {
      try {
        (0, import_node_fs2.renameSync)(tmp, path);
        return true;
      } catch (e) {
        if (!isTransient(e)) break;
        sleepSync(STORE_RETRY_BASE_MS);
      }
    }
  } catch {
  }
  try {
    (0, import_node_fs2.unlinkSync)(tmp);
  } catch {
  }
  return false;
}
function claimWake(p, now, ownPid) {
  const body = JSON.stringify({ pid: ownPid, at: now });
  const create = () => {
    try {
      (0, import_node_fs2.writeFileSync)(p.wakeClaim, body, { encoding: "utf8", flag: "wx" });
      return true;
    } catch {
      return false;
    }
  };
  (0, import_node_fs2.mkdirSync)(p.home, { recursive: true });
  if (create()) return true;
  let text;
  try {
    text = (0, import_node_fs2.readFileSync)(p.wakeClaim, "utf8");
  } catch {
    return create();
  }
  let at = null;
  try {
    const v = JSON.parse(text);
    if (typeof v.at === "number") at = v.at;
  } catch {
    at = null;
  }
  if (at === null) {
    try {
      at = (0, import_node_fs2.statSync)(p.wakeClaim).mtimeMs;
    } catch {
      return create();
    }
  }
  const age = now - at;
  if (age > -WAKE_WINDOW_MS && age < WAKE_WINDOW_MS) return false;
  try {
    if ((0, import_node_fs2.readFileSync)(p.wakeClaim, "utf8") !== text) return false;
    (0, import_node_fs2.renameSync)(p.wakeClaim, `${p.wakeClaim}.stale.${process.pid}-${tmpCounter++}`);
  } catch {
    return false;
  }
  const won = create();
  return won;
}
function releaseWake(p, ownPid) {
  try {
    const v = JSON.parse((0, import_node_fs2.readFileSync)(p.wakeClaim, "utf8"));
    if (v.pid === ownPid) (0, import_node_fs2.unlinkSync)(p.wakeClaim);
  } catch {
  }
}

// src/hook-main.ts
function parseInput(text) {
  try {
    const v = JSON.parse(text);
    if (typeof v !== "object" || v === null) return null;
    const o = v;
    if (typeof o.tool_name !== "string" || o.tool_name.length === 0) return null;
    return { sessionId: typeof o.session_id === "string" && o.session_id.length > 0 ? o.session_id : null, toolName: o.tool_name, toolInput: o.tool_input };
  } catch {
    return null;
  }
}
function readStateForHook(p, readFile) {
  let reason = "state-read";
  for (let i = 0; i <= HOOK_STATE_READ_RETRIES; i++) {
    try {
      const r = parseState(readFile(p.state));
      if (r.kind === "ok") return { kind: "ok", state: r.value };
      reason = r.reason;
      if (r.reason.includes("\u30B9\u30AD\u30FC\u30DE\u306E\u7248")) return { kind: "unknown", reason };
    } catch (e) {
      const code = e.code;
      if (code === "ENOENT") return { kind: "absent" };
      reason = `state-read:${code ?? "error"}`;
    }
    if (i < HOOK_STATE_READ_RETRIES) sleepSync(HOOK_STATE_RETRY_MS);
  }
  return { kind: "unknown", reason };
}
function dayOf(ms) {
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}
function record(p, now, mode, inp, rule, verdict, why) {
  try {
    appendHookLog(p, dayOf(now), { t: new Date(now).toISOString(), m: now, session: inp.sessionId, tool: inp.toolName, rule, mode, verdict, why });
  } catch {
  }
}
function runHook(io) {
  let p = null;
  let mode = "soft";
  let who = { sessionId: null, toolName: "?" };
  try {
    p = pathsFor(resolveHome(io.env));
    let text = null;
    try {
      text = io.stdin();
    } catch {
      text = null;
    }
    mode = readMode(appConfigPath(io.env));
    if (mode === "off") return 0;
    const now = io.now();
    if (text === null) {
      record(p, now, mode, who, "input", "failopen", "input-unreadable");
      return 0;
    }
    const inp = parseInput(text);
    if (inp === null) {
      record(p, now, mode, who, "input", "failopen", "input-unreadable");
      return 0;
    }
    who = inp;
    const cfg = parseConfig(readTextFile(p.config));
    if (cfg.kind === "broken") {
      record(p, now, mode, who, "config", "failopen", `config-broken:${cfg.reason}`);
      return 0;
    }
    const headless = inp.toolName.startsWith("mcp__playwright__") ? playwrightHeadless(readTextFile(claudeJsonPath(io.env))) : null;
    const cls = classifyCall(inp.toolName, inp.toolInput, cfg.config, { playwrightHeadless: headless });
    if (cls.kind === "light" && cls.unparsable !== true) return 0;
    const state = readStateForHook(p, io.readFile ?? ((path) => (0, import_node_fs3.readFileSync)(path, "utf8")));
    const lock = readLock(p);
    const daemonPid = state.kind === "ok" ? state.state.daemon.pid : lock?.pid ?? -1;
    const d = decide({
      now,
      mode,
      cls,
      toolName: inp.toolName,
      sessionId: inp.sessionId,
      state,
      lock,
      pidAlive: daemonPid > 0 && io.pidAlive(daemonPid),
      cli: `node "${(0, import_node_path2.join)(p.binDir, "away-gate.cjs")}"`
    });
    if (d.touch && inp.sessionId !== null && !writeTouch(p, inp.sessionId, now)) {
      record(p, now, mode, who, "touch", "failopen", "touch-write-failed");
    }
    if (d.log !== null) record(p, now, mode, who, cls.rule, d.log.verdict, d.log.why);
    if (d.wake && claimWake(p, now, io.pid)) {
      try {
        io.wake((0, import_node_path2.join)(p.binDir, "away-gate.cjs"), io.env);
      } catch {
        releaseWake(p, io.pid);
      }
    }
    if (!d.pass && d.out !== null) io.out(d.out);
    return 0;
  } catch (e) {
    if (p !== null) record(p, io.now(), mode, who, "exception", "failopen", `exception:${e.message ?? "unknown"}`.slice(0, 200));
    return 0;
  }
}

// src/proc.ts
var import_node_child_process = require("node:child_process");
function spawnHidden(file, args, opts = {}) {
  return (0, import_node_child_process.spawn)(file, args, { ...opts, windowsHide: true });
}
function spawnDetached(file, args, env) {
  const child = spawnHidden(file, args, { detached: true, stdio: "ignore", env });
  child.unref();
}

// src/hook-entry.ts
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
try {
  runHook({
    env: process.env,
    now: () => Date.now(),
    stdin: () => (0, import_node_fs4.readFileSync)(0, "utf8"),
    // process.exit を呼ばず自然に終わるので、保留中の書き込みは終了前に流れる
    out: (text) => {
      process.stdout.write(text);
    },
    pid: process.pid,
    pidAlive,
    wake: (daemonCjs, env) => {
      if (!(0, import_node_fs4.existsSync)(daemonCjs)) throw new Error("daemon \u304C\u7121\u3044");
      spawnDetached(process.execPath, [daemonCjs, "daemon"], { ...env, [SPAWNED_BY_ENV]: "hook" });
    }
  });
} catch {
}
process.exitCode = 0;
