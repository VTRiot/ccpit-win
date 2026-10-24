---
name: report
description: Fires when producing a report or completion notice. Generates a report that includes the interlock verification section.
---

# Report Output Skill

## Trigger
Fires at task completion, at interruption, or when the human asks "report it."

## Where the Report Goes
The report for the design AI is written as an MD file.
In-conversation text does not count as "outputting a report."

**Two-tier structure: dev log + canonical report**:
- Upstream doc repo: **canonical report** (judgment-centric: design decisions, rumination, proposals). Readers: design AI / human decision-maker
- Working repo: **dev log** (fact-centric: diffs, commit unit). Readers: next-session CC / future maintainers
- When in doubt, write both (cross-navigate to maintain integrity)

## Figure Plan (before writing — required)

**Before** writing the body, fire the diagram-craft skill, decide the figures via its trigger table, and declare them in frontmatter:

```yaml
figures: [da-table, where-map]   # 図種: da-table / where-map / flow / state / arch-svg
# 図を使わない場合（省略理由の明文化義務）:
figures: none
figures_reason: <理由 1 行>
```

- Silently omitting figures is forbidden. Every declared kind must have a body counterpart (`--lint` machine-checks declaration-reality match)
- The 4 cognitive-load-reduction anchors the reader looks at first: **pending-decisions panel / current-location map (where-map) / DA table bars / out-of-scope ledger**. Structuring decision material into these 4 anchors takes top priority

## Readers and Purpose of This Report (required)

The report MUST start with the following section right after the frontmatter:

```markdown
## 本報告書の読者と目的

- **誰が読む**: <主読者、複数なら優先順>
- **何のために**: <読者が本文書から得るべき情報、なぜ読むべきか>
- **次のアクション**: <読者に期待する次のアクション、読み終わったら何をすべきか>
```

Also recommended in frontmatter (machine-readable, optional):
```yaml
audience: [<FILL: 主読者ロールを指定>]  # 例: design-ai, human-user, cc-next, cc-self, public
purpose: <FILL: 1 文で要約>
expected_action: <FILL: 1 文で要約>
```

Skipping this section with "N/A" is forbidden. If the reader is unclear, revisit the design.

### Line pointing to the case milestone document (only for cases that have such a document)

In a multi-day case where a document tracks and updates stage progress on a single sheet (e.g., `<case_identifier>_MILESTONES.md`; the schema of the `case-journey-map` skill where available), add the following line to "Readers and Purpose of This Report":

```markdown
- **案件の現在地**: `<その文書のパス>`（この報告の対象の段: <段の番号>）
```

- For "target stage", write the stage number covered by this report. Write this even for reports that only investigated or waited and did not advance the stage state.
- Do not copy the overall case progress (list of completed and remaining stages) into the report. The report is a record at the time of writing, not the canonical source of truth for the current milestone. When read later, current progress should be viewed in that tracking document. Copying progress into each report makes it unclear which represents the current state.
- If this report changed stage state, next steps, new traps, or stage ordering, update that tracking document in the same turn (same conditions as that document's update rules). However, do not update if that document is closed (e.g. marked with `status: closed` in frontmatter, indicating no further edits). If new stages are needed after closing, create a new tracking document as a new case, and point reports there.
- Frontmatter `where:` and where-map diagrams represent "which parts of code or documentation were touched", which is distinct from case milestone stage progress. Both may coexist.
- For cases without such a document, do not write this line (there is no obligation to create a document just for this line).

## Conclusion Summary (required — right after Readers & Purpose)

Reports follow the order **Readers & Purpose → Conclusion Summary → (pending-decisions / TOC = renderer-automatic) → Details**. So the reader grasps the conclusion and its "good/bad direction" up front, always place it right after Readers & Purpose (md-render auto-hoists it):

```markdown
## 結論の概要

- **OK** — <結論（検証 PASS の実測あり）>
- **CAVEAT** — <結論（動くが条件付き・残課題）>
- **FAIL** — <結論（実測で破綻・未解決）>
- **INFO** — <結論（中立・対象外）>
```

- **Content**: a 1–5 line outcome (what the reader should now believe / do). Do not rephrase Readers & Purpose, duplicate the decision list, or pad it (it is not a second TOC).
- **Status badge**: a leading `**OK/FAIL/CAVEAT/INFO**` is converted by md-render into a colored pill (OK=teal / FAIL=red / CAVEAT=amber / INFO=slate). Only bold that **exactly matches** the set is converted (`**OK:**`, `**OK …**` are not).
- **★No badge without grounds (honesty standard — most important)**: every badge states its grounds. **OK = a measured verification PASS exists / FAIL = measured breakage or unresolved / CAVEAT = works but conditional, open issues / INFO = neutral, out of scope**. A groundless "OK" is forbidden (a brake against the report drifting toward "looking good"). For mixed cases, reflect the **principal outcome / risk** (if the core failed, it is FAIL even if parts work; anti-gaming demotions like FAIL→CAVEAT are forbidden).
- **Do not hand-write the pending-decisions list or TOC**: the pending-decisions list is auto-generated by the renderer from `> [!DECISION]` in the body, and the TOC from headings. The author writes only Readers & Purpose, Conclusion Summary, [!DECISION], Details, and Out-of-Scope (Pending). If a conclusion requires reader judgment or approval, mirror it into `[!DECISION]` (Conclusion Summary = direction / [!DECISION] = pending matters for the reader to decide). Settled decisions and operator instructions must not be placed in `[!DECISION]`.
- **Exemption (Conclusion Summary)**: pure descriptive memos / minutes / references etc. are exempt via frontmatter `conclusion_summary: none` + `conclusion_summary_reason: <reason>` (same shape as `figures: none`; `--lint` checks it).
- **Exemption (Pending-Decisions List)**: reports that truly have no pending decision items for the reader must explicitly declare exemption via frontmatter `decisions: none` + `decisions_reason: <reason>` (`--lint` checks it; creating fake DECISIONs just to silence warnings when there are no pending matters is forbidden).

## Interlock Verification Section (required)
Include the following checklist in the report:

```
## インターロック検証
- rumination: 発火した / 発火していない（理由: ）
- testable-impl: 発火した / 発火していない（理由: ）
- investigation: 発火した / 発火していない（理由: ）
- diagram-craft: 発火した / 発火していない（理由: ）
- md2html --lint: exit 0 / 未実行（理由: ）
- md2html --check: 実行済 / 対象外（理由: _index.md 非更新 等）
```

If any "not fired" entry lacks a justified reason, stop the report and re-fire the missing skill.

## Knowledge Accumulation Proposal (mandatory consideration)
Include the following in the report. Evaluate candidates; if none are needed, state why. Skipping this section with "N/A" is forbidden.

```
## ローカル知見提案
- 候補: （rules/ や skills/ に格納すべき知見はないか）
- 判断: 採用 / 不要（理由: ）
```

## Allowed Syntax (closed set of 8)

Report MDs use **only** the 8 syntax kinds supported by the deterministic renderer (md-render).
No italics, strikethrough, images, footnotes, or raw HTML tags (using them merely degrades to literal display; no content is lost).

| # | Syntax | Use |
|---|---|---|
| 1 | YAML frontmatter (scalars + inline lists) | doc_id / revision / audience / where / status / figures |
| 2 | Headings H1–H4 | document title / §N / subsections |
| 3 | GFM tables | DA tables / pending ledger / comparisons |
| 4 | Fenced code (with info string; mermaid / svg special-cased) | code quotes / figure sources. **SVG is converted by the renderer into a base64 data-URI img** (scripts neutralized) |
| 5 | blockquote + `[!DECISION]` `[!DA]` admonitions | decision markers |
| 6 | Bullet / numbered lists (≤2 nesting levels) | enumerations |
| 7 | Horizontal rule `---` | separators |
| 8 | Inline: code span / bold / link | emphasis / references |

## Optional Tabs (frontmatter `tabs: by-h2`)

For long status reports, declare `tabs: by-h2` in frontmatter to present the top-level body H2 sections as tabs (deterministic renderer extension — **not a new syntax**). Use it when the report has ≥2 such sections (e.g. purpose / history / now / next / open issues). The audience / decisions / TOC / pending panels and the lead stay outside the tabs; with JS disabled every section stays readable (fail-soft). Labels are the H2 heading text — number your headings if you want numbered tabs. See the md-render skill for details and the CSP note.

## Comments & Reply Prompt (default on for reports)

Every report you render gets, by default, a per-topic comment box under each body H2 plus a one-click "reply prompt" generator (the user comments while reading → generate → copy → hand to a reviewer / CC). Requirements & notes:

- Include a stable `report_id` (or `doc_id`) in frontmatter — comments key off it and are stored in the reader's `localStorage` (never written back into the MD/HTML). Without a stable id, comments are disabled.
- Give every body H2 a **unique** heading (identical headings share one sha1 anchor and merge comments; `--lint` warns).
- Suppress with `comments: off` (e.g. for dev logs / non-interactive docs).
- The renderer only produces the reply *prompt* (fixed-format, LLM-free) + copy button; writing the reply itself is out of scope. See the md-render skill for details.

## Substantive Comment Replies Go Into a Report (not the chat)

When replying to review comments, anything **substantive — analysis, investigation, design judgment, audit responses** (beyond a plain Yes/No or acknowledgment) must not be written out in the chat body; **output it as a report**. Two reasons:

- **Leave it for posterity**: chat does not survive as design material. The context behind a conclusion (why, the evidence, alternatives, rejection reasons) is an asset for the next session's CC and for human reviewers, and only becomes reusable once fixed in a report that carries a `report_id`.
- **Lower the human's cognitive load**: a long analysis streamed through chat forces the reader to extract the gist, re-read, and go back and forth. A well-formed HTML — conclusion first, status badges, tabs — is grasped in one pass.

Operation:

1. Write the substantive reply into a report. Existing topic → append a section (e.g. audit response) to the relevant report; independent topic → start a new report.
2. **The chat-side reply must always carry that report's `file:///` (encoded, in code formatting) and its `report_id` (report signature)** so the human can reach the full text in one step.
3. Also burn the handling into `comments_resolved` (3-part form) so the ✓ badge shows read / handled. **From the 2nd round onward** (comments written in the "Re-comment" field below the handled field), append `:re` to the key (`- <heading>:re || <original comment> || <memo>`; in round n, append n−1 `:re` tags). Merging into the previous round's declaration without `:re` leaves the re-comment field unprocessed and causes it to appear in the reply prompt every time — looking like it was neglected.
4. **Exception (no over-generation)**: plain acknowledgments, Yes/No, and minor factual corrections are covered by the `comments_resolved` memo alone — no new report.

Criterion: could this reply later be cited as grounds for a design decision? If so, make it a report; if it is a throwaway nod, a memo suffices.

## Decision Marker Rules

| Requirement | How to write |
|---|---|
| Decision items (unsettled) | `> [!DECISION] <title>` (auto-aggregated into the pending-decisions panel; limited strictly to unsettled matters requiring reader judgment or approval) |
| Settled matters / records | `> [!NOTE] <title>` or `> [!IMPORTANT] <title>` (not aggregated into pending-decisions; records of already-decided matters or instruction contents) |
| DA recommendation | `> [!DA] <recommendation + one-sentence reason>` (optional) |
| Current location (Where) | frontmatter `where: A > B > C` + `## Current Location` section + where-map figure when needed |
| Out-of-scope accounting | fixed heading `## Out-of-Scope Proposals (Pending)` + table |

### [!DECISION] Admission Criteria and Rule Provisions

- **Admission criteria (permitted only when all are met)**:
  1. **Unsettledness**: The decision regarding the matter is not yet final, remaining pending or under consideration.
  2. **Reader discretion**: The reader (owner / design AI) holds the authority and responsibility to judge, choose, or reject the matter.
  3. **Presentation of options**: The matter requests the reader to choose among multiple options or make an explicit Yes/No (approve/reject) judgment.
- **Exclusion criteria (prohibited if any applies)**:
  1. Content the owner has already instructed or decided (instructions / settled matters).
  2. Decisions already approved or ratified by the owner or design lane.
  3. Reversible internal design choices decidable at implementation lane's autonomous discretion (explain these with `[!NOTE]` or in body text).
- **Standard format for settled matters (defining destination)**:
  - `> [!NOTE] 【Settled matter: Actor (Date)】<Topic>` (or `> [!IMPORTANT]` depending on severity)
  - Example: `> [!NOTE] 【Settled matter: Operator instruction (2026-09-13)】Do not change the Progress main path (fixed URL)`
  - Example: `> [!NOTE] 【Settled matter: Design role decision (2026-09-14)】Submit artifacts as diffs against golden ja`
- **Boundary case evaluation procedure**:
  - **Case 1 (Single proposal approval/rejection Yes/No)**: Since the reader retains the rejection option, **include** in `[!DECISION]`.
  - **Case 2 (Confirmation of pre-approved instruction)**: Since the reader has already decided and no choice remains, **do not include** in `[!DECISION]` (move to `[!NOTE]`).
  - **Case 3 (How at implementation discretion)**: To avoid wasting reader working memory, **do not include** in `[!DECISION]` (move to `[!NOTE]`). However, seek prior approval via `[!DECISION]` for irreversible or high-cost changes.
  - **Case 4 (Lifecycle when past DECISION is resolved)**: In subsequent reports, transition to settled matter under `[!NOTE]`. If revising the same document, clearly state resolution via `comments_resolved` or history.

## Evaluation Axis Direction Rule (DA tables)

- When you have discretion over an axis direction, **align it so that higher = positive, within the bounds of zero distortion** (e.g. rephrase "cost" as "cost efficiency" when natural). The bar value color (high = magenta) then naturally matches goodness, speeding up reading
- **Forbidden**: distortion for the sake of alignment (forced reciprocals, unnatural indicators, data manipulation)
- Axes that are naturally "lower is better" stay **as-is** (bar colors are meaning-neutral position indicators; goodness is read from the header and numbers)
- Criterion: can it be aligned to "higher = better" naturally and without distortion? Yes → align / No → leave as-is

## HTML Derivation and Renderer Procedure

The MD is canonical. HTML is derived (HTML ⊆ MD); reporting obligations are fulfilled by the MD alone.

1. After saving the MD, generate HTML: `node ~/.claude/skills/md-render/md2html.cjs <report.md> <report.html>` (in environments without md-render, skip HTML generation — the canonical MD suffices)
2. Run `--lint <report.md>` and confirm exit 0 (bidirectional machine check of figures declaration-reality match: declared→present and present→declared; on exit 1, fix and re-run)
3. Run `--verify <report.md>` for bidirectional verification (zero fabrication / omission)
4. If `_index.md` was updated, regenerate `_index.html` and confirm freshness with `--check <_index.md> <_index.html>`
5. How to present the HTML follows the **Presentation Rules** below

## Presentation Rules (operator-node detection + delivery)

Principle: **no authoritative signal for the operator node exists**. Machine detection is primary; when undecidable, always fall to the safe default (no auto-launch). **Falling back to a default node is forbidden** (eliminates the structure where omissions become misdelivery).

### Operator-node detection (evaluate top-down; adopt the first tier that holds)

| Tier | Conditions (all AND) | Result |
|---|---|---|
| 1. Local interactive | `SSH_CONNECTION`/`SSH_CLIENT`/`SSH_TTY` all unset + `TMUX`/`STY` unset + execution node is a physically-seatable node | operator = execution node |
| 2. SSH tailnet | `SSH_CONNECTION` set + `TMUX`/`STY` unset + client IP resolves via `tailscale whois` to a physically-seatable node | operator = resolved node |
| 3. State file | first line of `~/.ccpit/operator-node` is a seatable node name + mtime within 2 hours | operator = stated node |
| 4. Safe default | none of the above | operator **unknown** → no auto-launch; present URL + path only |

- Execution node = `currentProfile` in `~/.ccpit/app-config.json` (authoritative signal)
- The seatable-node set is defined per environment (headless servers and phones are excluded). Any resolution outside the set is treated as undecidable
- `SSH_CONNECTION` inside tmux/screen can be stale — **never** use it to confirm the operator
- Operator-node designation via instruction frontmatter is **abolished**. Only an optional `allow_autolaunch: false` (delivery policy) is accepted, which suppresses auto-launch even when the operator is confirmed. Omission is safe
- The state file is a human override for exceptional cases only (never demanded routinely; expiry invalidates it = forgetting decays to the safe side)
- Command snippets for detection/serving: `templates/present.md` (verified commands only)

### Delivery

| Detection result | Delivery |
|---|---|
| operator = execution node | Direct launch allowed (Windows `Start-Process` / macOS `open` / Linux desktop `xdg-open`). Auto-launch only for final deliverables; interim reports stay at `file://` presentation |
| operator ≠ execution node (confirmed) | Tailscale serving: copy the HTML into a staging dir → local HTTP server bound to 127.0.0.1 only → `tailscale serve --bg --http=80 <port>` → present `http://<exec-node tailnet name>.ts.net/<file>` (include the cleanup procedure). After acknowledgment, always perform the **3-step cleanup** (`tailscale serve reset`, stop the serving process, remove the staging dir) — resetting the proxy alone leaves staged leftovers re-exposable on the next serve |
| operator unknown (safe default) | No auto-launch. Present **both** the Tailscale URL and the `file://` path |

- **`tailscale funnel` is absolutely forbidden** (public internet exposure). Confirm "tailnet only" in the serve status output
- Never serve the repository directly (copy only the target files into staging)

## Migration for Existing Reports (grandfather)

- The `figures` declaration rule and the `--lint` figures checks apply **only to reports newly written after this revision**
- No retroactive linting or frontmatter retrofitting of existing reports (bulk lint application is forbidden)
- When regenerating HTML for an existing report, adding `figures` is optional
