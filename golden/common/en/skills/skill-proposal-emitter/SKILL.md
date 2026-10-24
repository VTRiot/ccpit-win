---
name: skill-proposal-emitter
description: Fires at session end to emit, for each WorkFlow worth turning into a skill, a proposal MD containing the complete SKILL.md (and companion files when needed) + a recommend/reject label + evaluation-axis scores. Formatted so a human can adopt it from CCPIT's candidate browser with near-zero effort.
---

# skill-proposal-emitter — Skill-proposal MD emitter skill

## 0-A. Highest priority — the default answer to a finding is "fix it". Deferring is the exception (step on the mine)

House rule: **step on every mine you find**. The default response to a review finding is to **revise the proposal**, not to adjudicate your way out of it.
The full procedure is in §6-1, but the core judgment is stated here, because directives buried in the middle of a long document get skipped.

**You may choose `deferred` (valid but unfixed) for exactly two reasons:**

- **The decision belongs to the human** — taxonomy granularity, prioritization, cost acceptance; anything an implementer AI deciding alone would be overreach.
- **Settling it needs an input you cannot obtain this session** — real hardware, real data, or a third party's response.

**The following are NOT valid reasons to defer. Writing one marks the proposal as incomplete:**

- "Impact is limited" / "the effect is small" / "it's just wording" — you could have fixed it and did not.
- "The first revision after adoption will cover it" / "next time, alongside something else" — no owner and no date.
- "Not revised in this turn" — that is a restatement, not a reason.
- "I wrote it in `ccRebuttal`" — recording a rebuttal is not a substitute for fixing.

**For every `deferred` item, write who must supply what input to settle it. If you cannot write that, fix it instead.**
**Do not submit a proposal where most findings are deferred.** Grading your own evaluation axes backwards from the label you want is the same evasion.

## 0. Role of this skill

During a session, you (CC) often run useful WorkFlows. Instead of throwing them away, leave the ones worth turning into a skill as a **proposal MD**. The human reviews them as a list in CCPIT's candidate browser and adopts with near-zero effort via: review gate → password auth → adopt (kind:skill apply).

This is the entry point (proposal = sensing) of Part B "Skill adoption & feedback pipeline". The proposal format is aligned with CCPIT's kind:skill apply input, so adoption applies the content almost verbatim to `~/.claude/skills/<name>/SKILL.md`. In addition to SKILL.md, companion files inside the skill's folder (scripts, templates, etc.) can also be written into a single proposal (§2-2-1). Upon adoption, all files are installed locally, and when promoted to golden via the Golden Promotion Browser, companion files are included together and listed in the ledger row.

## 1. When to fire

- At session end (required by the proposal Stop hook `skill-proposal-gate.sh`).
- Fire even for short / investigation-only sessions. If no WorkFlow worth adopting was run, emit a structured "none" (§5).

## 2. Output protocol

### 2-1. Location

```
~/.ccpit/proposals/<timestamp>_<request-id>.md
```

- `~/.ccpit/proposals/` = CCPIT's consolidated proposal pool (userData; one place across all projects).
  Since adoption targets are global (`~/.claude/skills/`), the proposal pool is consolidated and cwd-independent.
- `<timestamp>` = `YYYYMMDD_HHMM` (the actual file-generation time; no estimates/rounding).
- `<request-id>` = short kebab-case id (mirror the proposed skill name, e.g. `pdf-extract-flow`).
- Create the directory if missing (`mkdir -p ~/.ccpit/proposals`).
- **One candidate = one file.** Multiple candidates → multiple files.
- Record the origin (the working directory at generation time) in the `source_project` frontmatter (§2-2).

### 2-2. File format

(This template contains 4-run fences inside, so the entire template is enclosed in 5-run fences. Only copy the content inside the 5-run fence lines as the template)

`````markdown
---
request_id: <FILL: ファイル名の request-id と一致>
created_at: <FILL: ISO 8601, 例 2026-05-29T16:58:00+09:00>
purpose: <FILL: 1 行。何を Skill 化する提案か>
target: ~/.claude/skills/<FILL: skill 名>/SKILL.md
status: pending
kind: skill
adoption_label: <FILL: recommend | reject>
source_project: <FILL: 生成時の作業ディレクトリの絶対パス。例 C:\path\to\your\project>
base_hash: <FILL: 更新提案のみ（§2-5）。元にした版の SKILL.md の sha256。新規提案では行ごと省略>
companion_base_hashes: <FILL: 更新提案で、既にある付随ファイルを書き換えるときのみ（§2-5）。`相対パス=sha256` を `;` で区切る。それ以外は行ごと省略>
---

## 1. サマリ

- タイトル: <FILL: 候補 skill の一言タイトル>
- What: <FILL: この skill が何をするか 1〜2 行>
- Why: <FILL: なぜ Skill 化が有益か 1〜2 行>
- How: <FILL: どう使う / いつ発火するか 1〜2 行>

## 2. 評価軸

各軸 0〜5 のスコアと根拠を**必ず**埋める（空欄・定型句は CCPIT の品質ゲートで弾かれる）。

- 再現性: <FILL: 0-5> — <FILL: 根拠>
- 汎用性: <FILL: 0-5> — <FILL: 根拠>
- Context節約効果: <FILL: 0-5> — <FILL: 根拠>
- 既存Skill重複・統一可能性: <FILL: 0-5> — <FILL: 根拠（重複あれば統一案も）>
- 本質的UX向上への寄与: <FILL: 0-5> — <FILL: 根拠>

## 3. 変更後の完成版

採用時にこのブロックの中身がそのまま `target` の SKILL.md として書き込まれる。
**外側フェンスは内側の最長バッククォート連よりも 1 個以上長くする**
（内側の最長が N 連なら外側は N+1 個以上。最低 3 個。固定 4 ではない。CommonMark のフェンス規約。
CCPIT のパーサは「開き N 個 → 閉じ N 個以上」で対応する）。
例: SKILL.md 本文が 3 連フェンス（```）を含むなら外側は 4 連（````）。4 連を含むなら外側は 5 連。
外側に `~~~`（チルダ 3 個以上）を使ってもよい。閉じは開きと同じ文字だけを見るので、中身にバッククォートの
フェンスがいくつあっても切れない（中身にチルダの連があるなら、そのチルダの連より長くする）。

````markdown
---
name: <FILL: skill 名（target と一致）>
description: <FILL: 発火条件を含む説明>
---

<FILL: 完成版 SKILL.md の全文。手順・例を含む（内側のコード例も可）>
````

## 4. 採用推奨 / 棄却の判定と理由

- 判定: <FILL: recommend | reject（frontmatter の adoption_label と一致）>
- 理由: <FILL: §2 の評価軸を踏まえた判定理由。reject でも消さず必ず理由を残す>

## 5. レビューボックス

レビュアー（人間 / 将来のレビュアーAI）の記録が入る欄。提案時は空（pending）で出す。
emit 後にこの欄を書き換えてよいのは記録スクリプト（`proposal-review-record.cjs`）の**自動転記だけ**。
手書き転記は禁止（台帳の手書き upsert 禁止と同じ「正規経路のみ」原則。§6-1）。

- review_verdict: pending
- findings:
- reviewer_id:
- cc_rebuttal:
`````

### 2-2-1. When shipping companion files together (writing multiple files under "## 3.")

If only shipping a single SKILL.md, place a single completed block under "## 3." per §2-2 (the traditional style; remains fully valid).
When shipping other files in the skill's directory together—such as scripts or templates—place file headings `### <relative path from skill directory>` inside "## 3.", and immediately beneath each heading write the full text of that file's completed version inside a code block.

`````markdown
## 3. 変更後の完成版

### SKILL.md
````markdown
---
name: <FILL: skill 名>
description: <FILL: 発火条件を含む説明>
---

<FILL: 完成版 SKILL.md の全文>

````

### scripts/helper.cjs
```javascript
<FILL: 付随ファイルの完成版の全文>

```
`````

(The blank line before the closing fence is to preserve the file's final newline. See the final item in the rules below.)

Rules (identical to CCPIT's parser `parseProposedFilesFromSection3`. Deviating prevents both adoption and promotion):

- Must always include `### SKILL.md`. The order of headings does not matter.
- Headings are placed after "## 3.", and the next chapter must be written in the form `## 4.` (`##`, number, dot). The parser detects the end of "## 3." by a heading of this form (without a dot, such as `## 4 Next chapter`, it does not act as a delimiter, and subsequent `###` headings will be read as files).
- Place a code block immediately beneath the heading (blank lines permitted).
- Paths are relative to the skill folder. `..`, absolute paths, drive letters, leading `/` or `\`, and UNC paths are disallowed.
- Use only `/` as folder separators (`scripts/helper.cjs`). While `\` is accepted at adoption, it halts at promotion to golden due to collation mismatch against the original version declaration (§2-5).
- Do not terminate paths with dots or spaces. Do not use Windows reserved names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, including with extensions) anywhere in paths.
- Do not include backup or temporary files (`.bak`, `.bak.*`, `.bak-*`, `.bak_*`, `.old`, `.orig`, `.tmp`, `.swp`, trailing `~`) or `.DS_Store`, `Thumbs.db`, `.git`, `node_modules`.
- Do not specify two paths differing only in case. Maximum 10MB per file. Write in UTF-8.
- Inside "## 3." in this format (up to the next `## <number>.`), all `###` headings are parsed as file headings. Do not place explanatory `###` headings (such as `### Notes`) or code examples here (if a code block immediately follows, it becomes a file with that name; if none follows, it aborts with an error). Place explanations before "## 3." or in "## 4.".

Practices that do not halt immediately, but alter content or cause downstream trouble (the parser does not check these; authors must observe them):

- Do not use `;` in file or folder names. While adoption succeeds, update proposals later modifying that file cannot declare original versions (since §2-5 `companion_base_hashes` is delimited by `;`), preventing promotion to golden.
- For each file's code block, make the outer fence at least 1 backtick longer than the longest backtick run inside (§2-2; `~~~` may be used on the outside). The parser treats lines with the same fence character and at least the opening length (up to 3 leading spaces, trailing whitespace only) as closing fences. If too short, it truncates prematurely at an internal matching line.
- Leading whitespace on opening fences (up to 3) strips up to that amount of leading whitespace from each line of content. Usually, start opening fences at column 0.
- The parser removes the newline immediately preceding the closing fence as a delimiter. When you want to preserve the file's final newline (almost all files), insert 1 blank line after the content before writing the closing fence. Failing to insert it writes the file without a trailing newline, causing a 1-byte drift against local versions.

Handling at adoption and promotion (what authors must know):

- Adoption replaces or adds only the written files. **Existing files not mentioned in the proposal are neither deleted nor overwritten** (proposals cannot delete files).
- If symlinks or junctions exist along destination paths, adoption halts (never writes outside the directory).
- Upon promotion to golden, all files enter Japanese (`ja`). In English (`en`), executables (`.cjs`, etc.) enter with identical content, while companion `.md` files do not enter, pending translation.
- When promoting to golden, the versions upon which the proposal was based (`base_hash`, `companion_base_hashes`, §2-5) are checked against the current golden; promotion halts if there is a mismatch. Modifying existing companion files requires `companion_base_hashes`.

### 2-3. Key authoring steps

1. Inventory the WorkFlows you ran this session and list **all** candidates worth turning into a skill.
2. **Check existing skills**: before filling the "OverlapWithExisting" axis, Read the existing skill list under `~/.claude/skills/` (do not write "no overlap" without looking — for the overlap check to be meaningful). If a skill with the same name as `target` is already adopted, write that candidate as an update proposal (§2-5) rather than a new one.
3. Score each candidate (§2). Even low-value ones are emitted **with a reject reason** (never dropped).
4. **Handling duplicates**: a candidate that clearly overlaps an existing skill is not `recommend`ed — set `reject` and state the overlap target and whether they can be unified (reduces duplicate proposals accumulating across every-session firing; note the primary duplicate-prevention is CCPIT's candidate-browser "already-seen / adopted" visualization).
5. Write the "## 3." final SKILL.md at adopt-and-run quality (steps, firing conditions, examples). If the skill requires companion files (e.g. SKILL.md calls a script), write those files into the same proposal in the format of §2-2-1 (bringing only SKILL.md and placing companion files outside the system causes drift between the ledger and reality).
6. Make the outer fence at least one backtick longer than the longest inner backtick run (inner N → outer N+1; not fixed at 4; see §2-2).
7. Frontmatter must be **flat key: value only** (no nesting; CCPIT parser constraint).
8. **Write headings and labels in declarative form.** In the final SKILL.md and in any document it makes the agent generate (CLAUDE.md etc.), headings and labels state the content as a noun phrase (e.g. "Scope and terminology of this repository"). Do not use an imperative addressed to the reader or to an automated reader ("Read this first", "You MUST ...") as a heading. An imperative heading reads as an instruction and lowers the credibility of the factual description.
9. **Write search and inspection steps as full-tree scans from the repository root.** Every grep / find / ls in a procedure scans from the **repository root (or from a top-level root explicitly named as the scope of the inspection)**, with exclusions listed explicitly (e.g. `--exclude-dir=node_modules`). Never sample a subdirectory such as `src/`, call it "the tree", and claim absence for the whole from that sample (sampling misses fixtures, tests and generated files).
10. **Write properties, not numbers.** Do not embed numbers that rot with time — line counts, item counts, version numbers, dates — as the grounds of a rule or an explanation. State the reason or the property instead (e.g. "do not copy the legacy 632-line version" → "do not copy the root CLAUDE.md, which contains internal codenames and project-specific development instructions"). If a number is genuinely needed, write the measurement procedure.

### 2-4. Post-emit self-check (mechanical)

After writing the proposal MD(s), run the CCPIT parse-contract check with `proposal_self_check.cjs`, **distributed in the same directory as this skill**:

```
node ~/.claude/skills/skill-proposal-emitter/proposal_self_check.cjs <emit した提案 MD のパス...>
```

- Output is one JSON object on stdout (indented and formatted, therefore multi-line). Read `files[]` (per-file `ok` / `errors[]` / `warnings[]`) and `summary` (`total` / `clean` / `withErrors`).
- **exit 0** = all files clean → proceed to the §7 completion report.
- **exit 1** = contract violation(s) → fix the offending proposal MD(s) per `errors[].message` and re-run. **The fix loop is capped at 3 attempts.** If it is not exit 0 after 3 attempts, do not swallow it — include the remaining `errors[]` verbatim in the §7 report to the human (avoids infinite loops). Never claim "self-check clean" until it actually is. Only edit the emitted proposal MDs (never edit `proposal_self_check.cjs` itself).
- **exit 2** = check impossible (no args / file missing / unreadable) → verify the paths and re-run. If it cannot be resolved, include that in the §7 report (do not conflate it with a contract violation, exit 1).
- `warnings[]` are non-blocking (e.g. deviation from the filename convention `YYYYMMDD_HHMM_<request-id>.md`). Fix them when feasible, but they do not affect the clean verdict (exit 0).
- The inspection of "## 3." (`check: section3_files`) checks the rules of §2-2-1. Single-file writing (one code block) also passes as-is.
- The self-check does not check `base_hash` or `companion_base_hashes` against golden (so that it functions even in environments without local golden copies). Verification against golden is performed by CCPIT upon promotion to golden (§2-5).
- The self-check is a **mechanical parse-contract check**; it does not replace review of content quality (score validity, adopt-and-run quality of the final SKILL.md). That review belongs to CCPIT's gates.

### 2-5. Update proposals (revising an already-adopted skill) — diff-based + base_hash + the rollback principle

If a skill with the same name as `target` is already adopted at `~/.claude/skills/<name>/SKILL.md`, then the proposal is an **update proposal**. On top of §2-2's format, it must satisfy the following three principles.

1. **Present it diff-based (the presentation is a diff; the mechanism is a swap)**
   Write the What/Why/How of "## 1. Summary" not as a summary of the whole text but as **a diff against the currently adopted version**:
   - What: how the current version stands → what this update **adds / changes / removes**
   - Why: what the current version lacks / what it makes difficult
   - How: how the user's operations or the firing behavior change after the update (if nothing changes, say so explicitly)
   Even though the adoption mechanism swaps the whole text, the presentation must not be written as a replacement (dressed up as something new). What the user needs to decide on is
   "what changes, and how, relative to the current version" — not a side-by-side read of two full texts.
2. **Declare base_hash**
   Record `base_hash:` in the frontmatter (the sha256 of the version of SKILL.md that you based your work on).
   It is a declaration of "which version this diff was written against", and it becomes the premise for the review and for the adoption decision.
   - The version you base your work on is the distributed version (the golden SKILL.md). Even if you directly edited a local copy that differs from golden, write the value of the golden version into `base_hash`, and write the summary diff relative to the golden version as well. The promotion path to golden checks this value against the current golden SKILL.md, and halts if it differs (to avoid rolling back golden-side changes). Writing the local copy's value will always halt as long as local and golden differ.
   - The value is the raw sha256 measured directly from the bytes of the file you based work on (e.g. `sha256sum <file>`, or `Get-FileHash <file> -Algorithm SHA256` in PowerShell). The golden version has LF newlines, and promotion collation accepts both the sha256 of the golden LF bytes and the sha256 of the same content with CRLF newlines. Therefore, even if your local copy has CRLF, measuring it directly passes as long as the content matches golden (the raw byte fingerprints of LF and CRLF differ, and the collation side accepts both). Values from files with mixed LF and CRLF newlines will not pass. Hexadecimal uppercase letters are read as lowercase.
   If, at adoption time, the current version disagrees with the declaration (i.e. the adopted version changed after drafting), re-read the current version, rewrite the diff, and re-emit (do not silently overwrite). Note that CCPIT's adoption path mechanically refuses to apply when the skill on disk has been changed externally relative to the adoption-registry record (fail closed).
   **Original versions of companion files (`companion_base_hashes`)**: For companion files that already exist in golden and whose contents are being rewritten, write the sha256 of the version you based work on into `companion_base_hashes:` (measured the same way as `base_hash`).
   - The format is `relative_path=sha256`. If there are multiple, delimit with `;` and list on a single line (e.g. `companion_base_hashes: scripts/helper.cjs=<sha256>;templates/a.md=<sha256>`).
   - **Spelling rules (consolidated here)**: When rewriting companion files that already exist in golden, make both the heading in "## 3." and the declared relative path character-by-character identical to the relative path in golden (including case; folder separator `/`). Headings differing from golden only by case overwrite the same file on Windows and halt at promotion. Using `\` as a heading separator will not match the declaration during collation and halts (§2-2-1). Files with `;` in their names cannot be declared because it cannot be distinguished from the delimiter (avoid `;` in file names in §2-2-1).
   - Newly added files and files whose contents are not modified do not need declaration.
   - Unstated items or items with invalid format (no `=`, or value is not 64 hex characters) are not read. The promotion path to golden halts if a declaration for a companion file being rewritten is absent or unreadable/invalid (as "unable to verify base version"), and halts if the declaration differs from the current golden version.
3. **Do not break rollback-ability**
   Write "## 3." as the **complete text** of the post-update version, as usual (when including companion files, write each file in full, not as a diff). The adoption mechanism is: gzip-archive the old version → swap → verify → automatic rollback on failure; the old version is preserved in the registry (`archivePath` / `previousHash`), and the user can return to the pre-adoption version at any time. Make the completed version stand on its own with **the complete set of files stated in the proposal** (do not write it in a way that requires references to the old version or to files not mentioned in the proposal to function. Both rollback and re-adoption stand on that set).

Determine new-vs-update before emitting (decide it together with the existing-skill check in §2-3 step 2).

## 3. Definition of the evaluation axes

| Axis | Meaning |
|---|---|
| Reproducibility | Is the procedure reusable in the same situation (not a one-off)? |
| Generality | Does it help across other projects/contexts? |
| ContextSaving | Does the skill save per-time instructions/explanations? |
| OverlapWithExisting | Does it avoid overlap with an existing skill; can they be unified? |
| EssentialUXGain | Does it lead to essential UX improvement for the user? |

These 5 axes are the **shared basis** for CC self-evaluation (this skill) and the future reviewer AI's evaluation. Reject reasons and review criteria live on the same axes.

## 4. Distribution constraints

Do **not** include in the proposal MD:

- The user's personal proper nouns (person/company names, project codenames, product names)
- AI session naming (past session names, CC's own name)
- Internal development codenames

Write `purpose` / summary / final SKILL.md with the technical content only.

## 5. When there are zero candidates

Even for a session with no WorkFlow worth adopting, **record it instead of dropping it**.
Emit one file with `adoption_label: reject`, put "no skill candidate for this session" in
"## 1. Summary", and a **brief per-axis reason** in "## 4." (the "## 3." final content may be
an empty skill skeleton; state management is handled on the CCPIT side).

## 6. Integration with CCPIT

The human launches CCPIT → opens "Skill candidates" in the left pane. CCPIT lists the proposals in `~/.ccpit/proposals/` by default (title/What/Why/How + label + axis scores + source project), then candidate select → review gate (inspect the review box) → password auth → adopt (kind:skill apply with auto backup / verify / auto-rollback on failure) → manages state (candidate / adopted / rejected / held).

If an adopted skill has the same name as a golden distributed skill, CCPIT refuses the adoption (to prevent permanent shadowing). Do not reuse golden skill names.

### 6-1. The revision loop after a review raises findings (emitting is not the end)

Emitting is the **starting point**, not the finish line. Leaving a proposal that an independent review
(codex etc.) marked `needs-attention` sitting at `adoption_label: recommend` is **forbidden**.
"The review happened, the findings were ignored" is blocked as a machine condition by the Stop hook
(recommend-review-gate), which refuses to let the session stop.

Once you receive `needs-attention`, drive the proposal to **one of three outcomes**:

1. **(a) Harvest the findings (the default path)** — settle **every** finding. There are exactly two ways
   to settle one:
   - **Fix it** → revise the body and **run the re-review right there**. Revising changes the
     `proposal_hash`, so a re-review is mechanically required anyway. Adjudicate against the *new*
     findings that come back. **Never stop at "fixed, awaiting re-review"** — harvesting is a **loop**,
     with no resting place in the middle.
   - **Don't fix it** → record a per-finding adjudication in the ledger. The vocabulary is exactly two:

     | decision | Meaning | Recommend badge | On adoption |
     |---|---|---|---|
     | `rejected` | The finding is **off-target**. You reject it with stated grounds | kept | adoptable as-is |
     | `deferred` | The finding is **valid but unfixed** — it cannot be fixed within this proposal | kept | requires the user's ack (transfer of responsibility) |

     Record them on the ledger (`~/.ccpit/proposal-reviews.json`) **via the recording script (the
     canonical path) — hand-written upserts are prohibited**:
     `node ~/.claude/scripts/proposal-review-record.cjs --request-id <id> --batch-file <batch.json>`.
     The batch carries `verdict` / `findings` / `reviewerId` etc. plus `adjudications: [{ id, decision, reason }]`.
     `adjudicationsFor` (sha256 of the review's `findings` string), `proposal_hash`, `reviewedAt` and each
     adjudication's `at` are measured and attached by the script (they cannot be passed via flags or batch).
     Each `id` is a **string** (`"1"`; JSON numbers are refused as a type mismatch) and must **match the
     `[n]` markers in the review body exactly** (1..N, contiguous, no duplicates, no gaps, no extras, no
     leading zeros).
     Each `reason` is **shown to the user in full**, so write it dense enough to be decision material
     (one-liner dismissals are rejected mechanically).
     If the script is not deployed, do not fall back to hand-writing; keep the result in the work log and
     ask the human to deploy it.

   **`deferred` is the exception, not the default.** If it can be fixed, fix it and run the re-review.
   If you do choose `deferred`, state *why* it cannot be fixed within this proposal.
2. **(b) Reject** — withdraw the proposal and set it to `rejected` in CCPIT.
3. **(c) Explicitly downgrade to `recommend-with-findings`** — a label stating "the findings are
   acknowledged; awaiting human judgement". The downgrade must be recorded in **both** the ledger and the
   proposal frontmatter (one side alone does not pass):
   - Proposal frontmatter: `adoption_label: recommend-with-findings` plus `downgraded_at: <ISO>`
     (optionally `downgrade_reason:`)
   - Ledger (`~/.ccpit/proposal-reviews.json`): `downgradedTo` / `downgradedAt` /
     `downgradedFromHash` (sha256 of the pre-downgrade content; must equal `proposal_hash`) /
     `downgradedContentHash` (sha256 of the file after the downgrade)
   - **The downgrade may only touch those operational keys.** Rewriting the body in the same operation is
     caught by the hook's inverse-transform check.

**The right to reject findings is preserved (CC_REBUTTAL_RIGHT_CLAUSE).** The implementer may reject any
individual finding. However, **a rejection is legitimate only when the reason is recorded**, and
**silence (leaving adopt/reject undecided) is outside that right**. What is blocked is non-response, not dissent.

**What the recommend badge means**: not "the reviewer said approve" but **"CC settled every finding"**.
A `verdict: approve` with unadjudicated findings left over does *not* clear it; conversely a
`needs-attention` whose findings are all settled as `rejected` / `deferred` may stay recommended.
The point of this norm is to leave the user with **only the adopt-or-not decision**.

Writing a rebuttal into `ccRebuttal` alone does not clear the gate (**recorded adjudications, an actual
revision, or an explicit downgrade is required**). `ccRebuttal` is prose for humans and is not what the
machine reads — the machine reads `adjudications`. `held` does not exempt either — holding is not
evidence that an independent review took place.

## 7. Completion

After emitting the proposal MD(s), CC tells the human in conversation:

- The proposal file path(s) (all of them)
- Each candidate's title and recommend/reject label
- The self-check result (§2-4; confirm all files came back clean, or describe any unresolved exit 2)
- "Please adopt from CCPIT's candidate browser"

CC does **not** edit `~/.claude/skills/` directly. Adoption goes through CCPIT's authenticated apply path (the core of the safety architecture).

## 8. Final gate before submitting (did you leave a mine behind?)

Even after §7 is satisfied, do not submit if any of the following is true. **Go back to §0-A and revise.**

- Most of the findings are `deferred`
- A `deferred` reason contains "impact is limited" / "next time" / "not revised in this turn" style wording
- An item is `deferred` but does not state who must supply what input to settle it
- A fixable finding was deferred because re-running the review felt expensive
- Evaluation-axis scores were graded backwards from the label you wanted
- A command or code block in the procedure was written as "this works" without ever being executed
- A heading or label in the final content is still an imperative addressed to the reader
- A search command in the procedure does not scan from the repository root (or an explicitly named top-level root) / claims absence for the whole tree from a subdirectory sample
- An explanation or rule is grounded on a number that rots with time (line count, item count, version number, date)

**Passing the Stop hook is not a completion criterion.** The hook is the floor of the machine-checkable conditions, not proof that you stepped on the mine.
Clearing the block with the minimum operation that satisfies the gate (relabeling, filling adjudications pro forma) violates the purpose of this skill.
