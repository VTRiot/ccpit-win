---
name: imaging-proxy-verbatim-read
description: Fires — regardless of model — when, under a proxy that renders tool output as images, you are about to quote, pass as an argument, or cross-check a value where one wrong character changes the meaning or makes the target unreachable: sha256, PID, port, line number, path, URL, version number. Does not fire for reads where the gist suffices. Narrow the target first so the output stays small enough not to be rendered as an image, never use a value from imaged output as grounds, and treat values you cannot obtain as unverified.
---

# imaging-proxy-verbatim-read — verbatim reading under an imaging proxy

## 1. When this applies

### 1-1. Environmental condition

- An imaging proxy sits on the conversation's input side (the system prompt and tool results arrive as images; in place of the original text, only a list of identifiers remains as text)

This skill applies **regardless of model or version**. Verbatim accuracy from an image varies by model and version (there are real cases of it degrading between versions of the same model family), but the principle "do not use a value transcribed from an image as grounds" is the same for every model — do not adopt a value that came via an image even on a model expected to be highly accurate.

### 1-2. Reads this applies to (verbatim values)

**Values where one wrong character changes the meaning, or makes the target unreachable.** Do not read these from imaged output; obtain them as text by the §3 procedure:

- Hashes (sha256, etc.), PIDs, port numbers, line numbers, byte counts and line counts — any number used for verification or cross-checking
- File paths, file names, directory names, URLs, version numbers, identifiers (request_id, UUID, commit hash)
- Values passed straight into a command argument, values copied out **as-is** as a quotation, values supplied for a human's or another tool's cross-check

Decide by "am I going to use this value **as-is** for a quotation, an argument, or a cross-check?" If yes, treat it as a verbatim value and apply this skill; if no, follow 1-3.

### 1-3. Reads this does not apply to (where the gist suffices)

**Do not use** this skill for reads that can be reconstructed from context and where a little misrecognition does not affect the outcome. Read them as the gist while still imaged, and do not re-fetch them in pieces (so as not to kill the token savings imaging provides — piecewise fetching of verbatim values spends part of the tokens saved here):

- The thrust of prose or a design document; the intent of a review comment
- The trend in logs or error messages (what failed)
- Grasping code structure or control flow (which function calls where)
- The "approximate count" in a list, or "is it included or not"

However, the moment a value you read as gist is going to be used for a quotation, an argument, or a cross-check, move to 1-2 and re-fetch **only that value** as text. Do not carry over a value read as gist. The quality of gist comprehension itself is out of this skill's scope.

What this skill prevents is **misreading caused by imaging, and nothing else**. Whether a value you read is still valid (is the PID alive, is the port still held, has the file changed) is a separate problem; its handling is at the end of §4.

## 2. Determining that imaging occurred

On receiving a tool result, judge in two stages.

**Confirmed** — any of the following confirms "it was imaged":

- The result body arrived as an image
- In place of the original text, only a list of identifiers remains as text (a rendering marker such as "Exact identifiers from the rendered context")

**Suspected** — none of the confirming conditions hold, but the text does not contain the expected number of lines or items, only a short summarizing sentence. Besides imaging, this also happens with a failed command, truncation, or a tool-side summary. Separate them with the following **probe**:

- The only thing usable as a probe is **a query whose expected result is already known from an immediately preceding confirmed result**. Example: if `ls -la -- '<file>'` already confirmed existence and byte count, then `wc -c -- '<file>'` should return that same byte count on one line. If you are going to use the result of `grep -c '^## ' -- '<file>'` as the heading count, you must have received `grep -n '^## ' -- '<file>'` as text beforehand
- The probe's form is a single call of `<cmd>; echo exit=$?`. The command body's **stdout must be exactly one data line and stderr must be empty.** The trailing `exit=<n>` is a control line; compare against the expectation using **the data line only**. Zero data lines (only the `exit=` line) means empty output; a non-zero exit code or any stderr means a command-side failure — neither is material for judging imaging
- If the probe's data line **matches** the known expectation, then the original output was not a failure, so suspect imaging and re-fetch it narrowed down by the §3 procedure. If it **does not match**, or you cannot construct a probe you can hold an expectation for, do not try to identify the cause (imaging / failure / summarization) — treat the original output's values as **unverified** (§3-1's terminating condition)

Numbers, hashes, and paths read from a result confirmed to be imaged are **not adopted**. They may be used to grasp the gist, but not for placement verification, quotation, or command arguments.

## 3. The procedure for narrowing and fetching

Imaging is decided by a size threshold, and the threshold's concrete value varies with environment configuration, so it is not written into this skill. Judge by the §2 signs, and shrink the output in the following order when fetching.

### 3-1. Common principles

1. **Narrow the target first**: constrain "what am I reading" by argument — a single file, a single port, a single PID, the direct children of a single directory — before executing
2. **Do not bundle multiple fetches into one tool call**: chaining `ls`, `wc`, and `sha256sum` with `&&` or `;` gets imaged on the combined size. A fetch that needs a verbatim value is one command per call (excluding the addition of a single control line such as §2's `; echo exit=$?`)
3. **Re-judge with §2 for every result**: an expectation that it "should be small" is not a guarantee. Many headings, long lines, or long paths will inflate the output
4. **If it gets imaged, do not fill in by transcribing from the image.** Re-fetch, narrowing further in this order: **target specification → column selection → count limit → individual query**
5. **Terminating condition**: if, even after narrowing to an individual query for a single value (one line, one item, one file), you still cannot confirm it as text, or the result is empty, or the extraction does not settle on exactly one item, or you cannot confirm the owner or the value — report that value as **unverified**. Do not use an unverified value for a quotation, a command argument, or a destructive operation (stopping a process, overwriting, deleting), and do not keep retrying. Identifying the cause (imaging vs. failure vs. permissions) is not required in the report

### 3-2. How to narrow by kind of value (POSIX shell)

**How to fill in the placeholders** (common to every example in the tables and the body). The agent fills these in by hand for each call, so the filled-in result must be restricted to a form that reaches the shell as **a safe literal**:

- Wrap `<file>`, `<dir>`, `<word>` in **single quotes**: `'<file>'`. Do not use double quotes, because they expand `$(...)`, backticks, and `$var` (measured: a file literally named `-a $(x) \`y\` b.txt` worked with every command under `'…'` and failed under `"…"`). When the value itself contains `'`, join with `'\''` (e.g. `it's.txt` → `'it'\''s.txt'`; measured to work)
- **Put `--` before a filename argument**: `wc -c -- '<file>'`. This keeps a path starting with `-` from being read as an option. Measured for `ls`, `wc`, `sed`, `head`, `grep`, `sha256sum`, `shasum` (Git Bash and WSL)
- `<word>` is a fixed string; add **`-F`** (do not interpret as a regular expression), as in `grep -n -F -- '<word>' '<file>'`. After `--`, the first argument is the pattern and the next is the file
- Confirm `<port>` consists of **digits only** before filling it in. `<a>`, `<b>`, `<k>`, `<n>` are positive integers
- Only `<value pattern>` is a regular expression (for `grep -o -E`), written deliberately. Wrap it in single quotes as well

| Kind of value | Target specification | Column selection | Count limit | Individual query |
|---|---|---|---|---|
| Lines of a file's body | Line range `sed -n '<a>,<b>p' -- '<file>'` | For long lines, see "Long lines" below | Halve the range | One line at a time: `sed -n '<k>p' -- '<file>'` |
| Headings / line numbers | `grep -n '^## ' -- '<file>'` | — | `head -n <n>` | By heading word: `grep -n -F -- '<word>' '<file>'` |
| Line count / size | `wc -l -- '<file>'` / `wc -c -- '<file>'` | — | — | — |
| Hash | See "Hash" below (a single file) | — | — | — |
| Directory listing | `ls -la -- '<dir>/<name>'` (a single entry) | `ls -1` for names only | `ls -1 -- '<dir>' \| head -n <n>` | `ls -la` per target name |
| Port → PID | §3-3 (the output format differs per OS) | | | |

- **Hash**: `sha256sum` is not POSIX standard (it is GNU coreutils). First confirm **the presence of both** with `command -v sha256sum shasum` (measured: Git Bash has both, WSL has only `sha256sum`, macOS ships `shasum`). Use `sha256sum -- '<file>'` if present, otherwise `shasum -a 256 -- '<file>'`. **If neither exists, report the hash as unverified** (if you use a different hashing mechanism, treat it as §6's "separate route" and state explicitly what you obtained it with). Both return a single line of `<hash>  <file>`
- **Long lines**: when the verbatim value is late in the line, `cut -c1-<n>` will not reach it. If you know the value's shape, extract just the value with `grep -o -E` **after first narrowing to a single target line**: first confirm the count (`sed -n '<k>p' -- '<file>' | grep -o -E '<value pattern>' | wc -l`), and **only if it is exactly 1**, drop the `| wc -l` on the next call and take the value. Zero or multiple matches are unverified (`grep -o` prints every match, so multiple matches can get re-imaged and leave no determinate value to adopt). If you cannot write a pattern and must cut by range, use `cut -c<a>-<b>` per range in separate calls — **only when the line is ASCII-only**. The coreutils `cut -c` on Git Bash and WSL cuts **by byte** (measured: `cut -c1-2` on `あいう` emits two bytes from the middle of the first character), so do not split a non-ASCII line with `cut`. If you cannot pattern-extract the value from a non-ASCII line, treat it as unverified
- When you genuinely need "everything" in one go, such as an entire directory, first take the count (`ls -1 -- '<dir>' | wc -l`) and then fetch in ranges according to that count

### 3-3. Narrowing port → PID (per OS)

The output for port occupancy differs per OS in column positions and state words, so do not write a generic regular expression. The common principles are: "narrow by three conditions — the **local-address column** holding that port, **Listen** state, and the protocol", "if multiple PIDs remain, do not take an arbitrary one — query each PID individually", and "if the PID column is empty you cannot confirm the owner, so it is unverified". Confirm `<port>` is digits only before filling it in (§3-2).

- **Windows (Windows `netstat` under Git Bash)**: the output has five columns — protocol / local / foreign / state / PID. Do not constrain the IP notation with a regular expression; **judge by column** (this hits both IPv4 `127.0.0.1:<port>` and IPv6 `[::]:<port>`):
  `netstat -ano | awk '$1=="TCP" && $2 ~ /:<port>$/ && $4=="LISTENING" {print $2, $5}'`
  `$2 ~ /:<port>$/` hits only the trailing port in the local column, excluding the same port on the foreign-address side and rows in an established state. Running `grep` for `:<port>` across the whole line increases both the row count and the PIDs (measured: 7 rows unconstrained → 1 row constrained)
- **Linux**: `ss -ltnp 'sport = :<port>'` (Listen, TCP, numeric display, restricted to that port). The PID appears in the Process column as `pid=<n>`. When the **Process column is empty** (measured: it comes out empty for a listener owned by another user; other causes such as a race with termination are also possible), do not assert the reason — you cannot confirm the owner, so treat it as unverified. `lsof -nP -iTCP:<port> -sTCP:LISTEN -t` likewise returns empty when it cannot confirm
- **PowerShell**: `Get-NetTCPConnection -LocalPort <port> -State Listen | Select-Object -ExpandProperty OwningProcess`

## 4. Handling verbatim values

- Values used for placement verification, reports, or command arguments are drawn from **that specific command result you judged not to have been imaged**. Do not fill them in from memory of another call, or from the identifier list of an imaged result
- The identifier list contained in an imaged result is a clue that **the value exists somewhere in the body**, but it does not indicate which line or which context the value came from. When the context matters, re-fetch as text
- For a value supplied for a human's cross-check (sha256, etc.), **copy the fetching command's output exactly as it is** (do not abbreviate digits, change case, or strip whitespace). When the comparison side uses a different notation, produce a "value normalized for comparison" **separately** from the raw copied value, and state which normalization you applied (e.g. note that PowerShell's `Get-FileHash` returns uppercase, so you lowercased it for comparison)
- **The definition of line count**: POSIX `wc -l` counts LFs, while PowerShell's `Get-Content` `.Count` is a logical line count — they differ by one for a file with no trailing LF (measured). When cross-checking the same file across environments, compare by **byte count (`wc -c` / `.Length`) and hash**, not by line count. If you do use line count, state explicitly which one it is: "LF count" or "logical line count"
- **Freshness and identity are outside this skill's scope.** A PID, a port, or a file being updated can change after you fetch it, so re-fetch immediately before using that value to stop a process or overwrite a file

## 5. Examples

Bundling placement verification (existence, line count, hash, first line, headings) into one call can get imaged when the target is a long MD. Run each block below as **a separate tool call**. **Do not run the group of blocks together in one call.** Wrap `<file>` in single quotes per the §3-2 rules and place it after `--`.

```bash
ls -la -- '<file>'            # 実在・サイズ（単一ファイル）
```

```bash
wc -c -- '<file>'             # バイト数（環境をまたぐ照合はこれとハッシュ）
```

```bash
command -v sha256sum shasum   # ハッシュコマンドの有無（両方無ければハッシュは未検証）
```

```bash
sha256sum -- '<file>'         # 上で選んだ方を 1 回だけ実行（無ければ shasum -a 256 -- '<file>'）。生の出力を引き写す
```

```bash
head -n 1 -- '<file>'         # 先頭行（末尾行が要るなら tail -n 1 -- '<file>' を別呼び出し）
```

```bash
grep -n '^## ' -- '<file>'    # 見出しと行番号
```

## 6. Related skills and the division of labor

- `large-doc-section-probe`: locating and reading the relevant section of a huge **document**. When both fire at once (taking a verbatim value out of a huge document), **locating the section belongs to that skill, and judging each output for imaging plus re-fetching belongs to this one**. The reason this exists as a separate skill is that its targets are not limited to documents — they extend to ports, hashes, directory listings, and any other tool output
- `tool-path-cross-verification`: the procedure for when values need to be reconciled. It **fires** in any of these cases: (a) values for the same target obtained from separate calls disagree (e.g. the byte count from `ls -la` differs from `wc -c`), (b) a value read as gist from an imaged result disagrees with the value re-fetched as text, (c) it did not become unverified, but you are going to use that value as an argument to a destructive operation (a PID to kill, a path to overwrite). Constant cross-checking is not required
  - **If that skill is adopted**, follow it
  - **If it is not adopted**, additionally obtain the same value once via an independent separate route, and do not adopt it unless they agree. The minimum condition for an "independent route" is **querying the target directly through a different acquisition mechanism, not reformatting the same output** (e.g. `Get-FileHash` against `sha256sum`, `Get-NetTCPConnection` against `netstat`, the size column of `ls -la` against `wc -c`). If they disagree, follow §3-1's terminating condition and report it as unverified

## 7. Execution-environment premises

The command examples in the body assume a **POSIX shell** (Claude Code's Bash tool, Git Bash, WSL, etc.). For things that are not POSIX standard, such as `sha256sum`, an alternative is written in §3-2. Things that depend on OS-specific output formats, such as `netstat` and `ss`, are split per OS in §3-3. Filling in the placeholders (single quotes, `--`, `-F`, the digits check) follows the §3-2 rules. In PowerShell, wrap `-LiteralPath '<file>'` in **single quotes** as well (PowerShell single quotes do not expand variables or subexpressions; a `'` inside the value is doubled as `''`). In a PowerShell-only environment, observe the same principles with these equivalents (narrow the target, one fetch per call, copy the raw value):

| Purpose | POSIX | PowerShell |
|---|---|---|
| Line count (definition in §4) | `wc -l -- '<file>'` (LF count) | `(Get-Content -LiteralPath '<file>' -Encoding UTF8).Count` (logical line count; do not use `Measure-Object -Line`, which does not count blank lines) |
| Line range | `sed -n '<a>,<b>p' -- '<file>'` | `Get-Content -LiteralPath '<file>' -Encoding UTF8 \| Select-Object -Skip (<a> - 1) -First <n>` (`<a>` is a positive integer; writing `-Skip <a>-1` fails because it cannot convert to an integer) |
| Headings and line numbers | `grep -n '^## ' -- '<file>'` | `Select-String -LiteralPath '<file>' -Encoding UTF8 -Pattern '^## ' \| Select-Object LineNumber, Line` |
| Fixed-string search | `grep -n -F -- '<word>' '<file>'` | `Select-String -LiteralPath '<file>' -Encoding UTF8 -SimpleMatch -Pattern '<word>' \| Select-Object LineNumber, Line` |
| Byte count | `wc -c -- '<file>'` | `(Get-Item -LiteralPath '<file>').Length` |
| Hash (raw value) | `sha256sum -- '<file>'` or `shasum -a 256 -- '<file>'` (lowercase) | `(Get-FileHash -LiteralPath '<file>' -Algorithm SHA256).Hash` (uppercase; normalization for comparison is §4) |
| Port → PID | §3-3 | `Get-NetTCPConnection -LocalPort <port> -State Listen \| Select-Object -ExpandProperty OwningProcess` |

When verifying non-ASCII body text verbatim in PowerShell, characters will still be mangled if the console output encoding is not UTF-8, even with `-Encoding UTF8`. This does not affect fetching numbers, hashes, PIDs, or line numbers, but **verbatim confirmation of non-ASCII filenames and body text should be done on the POSIX shell side**, or after aligning the console output encoding to UTF-8.
