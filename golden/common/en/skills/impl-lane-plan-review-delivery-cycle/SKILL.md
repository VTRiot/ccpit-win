---
name: impl-lane-plan-review-delivery-cycle
description: Fires when you are in the position of implementing (the implementation-lane CC) after receiving an instruction MD in What/Why form from the design AI. Manages the whole flow end to end — verifying reference information against the real thing, drafting the Plan as a file via /plan, putting the implementation plan through Codex review after approval, harvesting the findings and implementing, putting the implemented state through Codex review again, and returning a human-facing HTML report. You hold the decision on How, and you may reject findings as long as you meet your accountability for doing so. Does not fire when you are the ordering side, or for standalone work not accompanied by an instruction.
---

# impl-lane-plan-review-delivery-cycle — Implementation-lane intake, implementation, and reporting cycle

## 0. Role

**The design AI decides the What/Why; you decide the How.** Candidate Hows handed to you as reference are
"confirmations of possibility", not specifications. Taking the current implementation into account, choose for yourself the method that delivers the best UX.
In exchange, you bear the reason for your choice and, if you rejected a review finding, **the accountability for that**.

## 0-2. Positioning and firing conditions

This is a **thin orchestration layer**, not a reinvention of procedures. The substance is delegated to existing skills:
`testable-impl` (implementation sequence) / `rumination` (the 4 questions before starting) / `plan-invariant-test-binding` (binding invariants) /
`bundled-payload-behavior-audit` (behavior audit of bundled content) / `codex-review` and `marshal-review` (running reviews) /
`report` and `md-render` (reports). **Do not rewrite the same procedures inside this Skill.**
However, the rules that connect the steps (verifying what you receive, binding the Plan, the order of the two-stage review, the §3-1 convergence rules, the reporting requirements, the approval gates) are this Skill's job, so they live here (at least, convergence rules equivalent to §3-1 do not exist in the delegated skills).
The delegated skills are authoritative for the details of each step, and where a delegated skill has a detailed rule of the same kind, follow it. This Skill is authoritative for the order and the approvals that connect the steps.

**When a delegated dependency is missing**: if a delegated skill or tool (`codex-companion.mjs`, Codex's configuration `config.toml`, etc.) is absent or unreadable in the environment,
carry out the minimal procedure written in this Skill (the key points of each step in §1–§4), and write in the report which dependency was missing and what you did instead.
For degrading when the reviewer is unavailable, follow §4-3.

Fire only when **all** of the following hold (to prevent over-firing):

- You are the **implementer** and have received a handoff deliverable (an instruction MD, etc.) from a **designer in a separate session**
- The implementation is **non-trivial** (includes any of: design decisions, multiple files, irreversible operations, distributed artifacts)
- A **human approval gate** is expected

**Does not fire**: typos, formatting, small configuration changes, read-only investigations (the lightweight path where a verbal instruction suffices).

### 0-3. Risk tiers (decidable by this Skill alone; stands on its own even without a counterpart)

| Tier | Scope | Application |
|---|---|---|
| Lightweight | Typos, formatting, small configuration changes, read-only investigations | Do not use this Skill. No Plan or two-stage review needed |
| Standard | Ordinary feature additions and bug fixes (spanning multiple files but reversible) | Carry out §2–§4. One round of Plan review is enough |
| High risk | Distributed artifacts, shared hooks / settings, irreversible operations, security / privacy boundaries, touching the same files as another lane | Full application. In addition, obtain **human approval immediately before** publishing, distribution, or commit, and fix the rollback conditions of §4-2 before starting |

**Decisions to raise the tier lean toward safety** (when in doubt, go up). **When lowering it, record the reason in the report.**
If the design-side Skill has been adopted, the same criteria are shared, but **this table is self-contained within this Skill**
(you will not be stuck on tier judgment even without the counterpart).

## 1. Intake (Step 0)

1. **Read the instruction MD and primary sources carefully.** If a closing report of a previous case or the like is specified, read it first.
2. **Verify reference information against the real thing.** The design AI's observations may be stale or misread.
   If the conclusion changes, **state in the Plan that it changed, with the evidence**, and return it to the design AI.
3. **Check for traces of a predecessor** (the same order may have been re-dropped; prevents duplicating or overwriting deliverables).
4. **Expand the constraint table into search expressions.** If the instruction enumerates constraints (C-1, C-2, … and the like), convert each item
   on the spot into a **concrete search pattern**, run it against every target file, and pin down the hit locations.
   Merely quoting the constraints in the Plan does not guarantee they are applied (see §5).

## 2. Plan (Step 1 — this is the core)

- **Use `/plan`, and always write the Plan as a file.** Do not let the conversation body stand in for the plan
  (what gets approved is the file).
- **Make the completion conditions concrete yourself** (the instruction's completion conditions are abstract; bring them down to a measurable form).
- **Bind invariant claims to test names.** If you write "~ does not change / does not happen / has no effect",
  decide first, by name, the test that corresponds 1:1 to it (see `plan-invariant-test-binding`).
  For conditional guarantees, place **both sides** (when A, do B / when not A, do not do B).
- **If there are distributed or bundled artifacts, read them in full** (`bundled-payload-behavior-audit`). Inventory external communication, writes,
  persistence, and child processes, and judge whether they are acceptable as defaults.
- Record out-of-scope findings **without fixing them on the spot**. However, if you find **a defect that your own instruction would trigger and that breaks the whole**,
  propose a correction even if out of scope (leave the judgment and reasoning).
- **Put the results of the §1-4 constraint scan into the Plan.** For each constraint, write "the search expression used, the hit count, the target files",
  and map each hit location to the work item that handles it. **Any hit left unlinked to any work item
  is an omission** (the approver can also point out the omission by looking there).

## 3. Review and implementation (Steps 2–4)

| Stage | Content |
|---|---|
| After approval | Put the approved Plan through **Codex review as an implementation plan** (`codex-review`). **Record the adoption decision for every finding** |
| Implementation | Start only after harvesting the findings. Take a `.bak` before editing (do not overwrite an existing `.bak`) |
| After implementation | Put **the implemented state through Codex review again** (`marshal-review`). How rounds are stacked and adjudicated follows the **convergence rules of §3-1**. If rejecting, you are accountable |

- **Rejection is a right, not a prohibition.** But write "why it is not adopted" in the report. Silent rejection is prohibited.
- **A fix that silences things by failing open is not a "resolution".** It goes quiet, but the gate dies.
- **The reviewer's field of view is limited to the diff.** A finding extracted in a diff review may have
  the same pattern in places that were not changed. **Do not stop after fixing only the extracted location; sweep out every instance of the same pattern.**

## 3-1. Review convergence rules (apply to both plan reviews and implementation reviews)

There are two patterns of reviews that fail to converge: **oscillation**, where the same point gets restated because the history of previous rounds is not conveyed,
and **fragmentation**, where findings descend into ever finer implementation details as rounds accumulate. Stop them through how the request text is composed (A, B, C, E)
and through adjudication after rounds have accumulated (D). A "round" means one Codex review of the same deliverable; plan reviews and implementation reviews are counted separately.

**A. In the round-1 request text, have the details raised all at once.** Put the following intent into the request text:
"Raise all findings that go into implementation details (boundary values, type hardening, how tests are written, etc.) at once in this round."
Do not reject a finding that first appears in a later round on the grounds of its timing alone. First classify it with the table in D: anything affecting user-visible behavior,
data loss or corruption, or security or personal information is fixed in any round (if you reject it, escalate to a human as in §4-3).
Everything else that falls under details (formatting, naming, comments, how tests are written, etc.) is decided and recorded finding by finding as usual in rounds 1–3; from round 4 onward it may be closed as Low per the table in D.

**B. From round 2 onward, always include a list of the history in the request text.** For each finding up to the previous round,
list on one line each: number, gist, decision (adopted / rejected), where it was fixed if adopted, and the reason if rejected.
If a rejected finding is restated, you may reject it for the same reason unless new grounds are presented.

**C. From round 2 onward, show only the diff fixed after the previous round.** Do not show the whole file every round.
Write in the request text: "The scope is limited to the diff after the previous round. Do not reread already-reviewed parts to look for new points."
The only additional locations you may show are those found by exhaustively searching for patterns of the same type as the previous round's diff; write that search expression and the hit locations in the request text (you do the exhaustive sweep of §3 yourself). Do not add and show any other range.

**D. Once reviews exceed 3 (round 4 onward), adjudicate by the UX criterion.**

| Kind of finding | Handling from round 4 onward |
|---|---|
| Errors in user-visible behavior, data loss or corruption, anything affecting security or personal information. Low frequency is not a reason (if it can occur with legitimate input or operation, even rarely, it belongs here) | Fix it. To reject a critical / high one, escalate to a human as in §4-3 |
| Everything else (code style, naming, comments, how tests are written, hardening against input users cannot produce through legitimate operation) | Treat as Low; may be closed without fixing |

- When closing as Low, write in the report, **per finding**, one line each with: number, the grounds for which row of the table above it falls under, and the reason for closing. Do not close multiple findings together on one line.
- If you fix a "fix"-category finding in round 4 or later, run one confirmation review targeting **only that fix** (the request text follows B and C, with the scope limited to the diff of that fix). If that confirmation yields a new "fix"-category finding, do not run any more; escalate to a human. If the confirmation cannot be run (usage limits, etc.), also escalate to a human.
- If only findings closed as Low remain, proceed to the completion report without re-review.
The threshold of 3 is provisional. If problems become visible in operation (serious findings first appearing in round 4 or later, waste remaining in cases that converge by round 3, etc.),
propose to a human a revision that sets the threshold based on how finding severity trends.

**E. Hand over test results in a form verified by running them.** A reviewer launched read-only may be unable to create a temporary directory
and run the tests (in that case, findings multiply through static guesswork).

- Default: run the tests yourself and paste the executed command and its output (the pass/fail line and counts) into the request text.
- When the reviewer itself needs to run them (e.g., when the target is adding or changing tests): make a disposable copy of the working tree
  (a duplicate in a temporary directory, etc.) and launch the reviewer on that copy with write permission. Discard the copy when done.
  - Do not include secrets (credentials, keys, tokens, `.env` and the like), git remote settings, or hooks in the copy (duplicate only the working files).
  - State in the request text that external operations other than running tests (network communication, fetching packages, push, publish, deploy, writing to shared caches) are neither requested nor allowed.
  - Network blocking is guaranteed by the reviewer's sandbox, not by the request text. Codex's write-permission mode blocks external communication by default (even if test code communicates on its own, it fails). Before launching, confirm in Codex's configuration (`config.toml`) that there is no setting allowing network in write-permission mode (something like `network_access = true` under `sandbox_workspace_write`); if there is, abandon the copy-based review and return to the default (pasting the output you ran yourself). If `config.toml` cannot be found or read, you cannot confirm this, so also return to the default.
  - The invocation form is `codex-companion.mjs task --write --cwd <absolute path of the copy> --prompt-file <request text>`. This is an exception, limited to this use, to "read-only (no `--write`)" in `codex-review` §2. `marshal-review`'s `adversarial-review` reads the real working tree, so do not use it for this purpose.
- **Do not launch a reviewer with write permission against the real working tree** (the reviewer could rewrite the deliverables).

## 4. Reporting (Step 5)

**For humans, produce an HTML report that has been thought through to minimize cognitive load.** Rather than filling in a template,
structure it so that "what the reader should do next" is clear at a glance.

- Put the **conclusion** and **the reader's move** (what, where, how) at the top
- **3-tier Before/After** (code / real-device UX / user FB). If the third tier has not been received, say it has not been received
- **Review contents, adoption decisions, and your own impressions** are mandatory. Also write the number of rounds and the list of findings closed as Low under §3-1 D
- **Write up your own judgment errors without hiding them** (who caught it, cause, root-cause analysis). This is where trust is built
- For the HTML, follow the project's reporting conventions if it has them (e.g., comment section, status-color legend, presentation via `file:///`, paths in code notation).
  Even without such conventions, always include the conclusion, the reader's move, the 3-tier Before/After, and the review adoption decisions above. **Before delivery, run once through the checklist of those conventions (or of this section if there are none)**
- Destructive operations (commit/push/deploy/kill) require **human approval before starting**. If not performed, state explicitly that they were not performed

## 4-2. Recoverability (`.bak` is not a rollback strategy)

- **Capture the state before starting**: if the working tree is dirty, record what is already there and **do not mix it with your own changes**
  (do not drag in another lane's untracked files).
- **Decide the rollback conditions first** (how broken things must get before you revert). Make the means of reverting explicit
  (stash/set aside if uncommitted, revert if committed).
- **Report partial completion**: if you stopped midway, write "what is done, what is not yet done, and whether it should be reverted". Do not leave it at "it probably works".

## 4-3. Standard for rejection, reviewer absence, disagreement

- **Reject per finding, individually.** Attach evidence (file:line, measurements) and impact analysis.
  **Rejection of critical / high findings is escalated to a human** (do not settle it on your own). A formal rejection
  that merely "wrote a reason" is a rubber stamp and is prohibited. Closing as Low under §3-1 D does not fall under this prohibition (the criterion and a one-line reason suffice).
- **Reviewer absence** (not deployed, authentication failure, cost cap, timeout) **does not block**. Record the cause and the alternative action
  and degrade to human review. **Do not falsely claim "reviewed".**
- **When you disagree with the design AI**, do not force your way through; build an **evidence packet** (point of contention / each side's grounds / options and their costs / recommendation) and
  escalate to a human. If you overturned a design premise against the real thing, **state that and the evidence in the Plan and the report** and return it
  (do not silently build to a different direction).

## 4-4. When there is no counterpart

This Skill is valid on its own even if the design-side Skill has not been adopted. However, **the quality of the input (What/Why) is not guaranteed**, so
if the instruction specifies down to the How, confirm "whether it may be treated as reference". If the approval gate has been omitted,
**request human approval at the point of presenting the Plan** (do not proceed to implementation on your own).

## 5. Anti-patterns (from real cases)

- **Taking reference information as specification** — you discard a better solution. Verify it and decide for yourself
- **Distributing without reading** — there is a real case where a distributed artifact contained third-party communication. Pay the cost of reading once, before distributing
- **Not double-checking your own claims** — there is a real case where an implementation that stated "existing behavior unchanged" broke existing behavior
- **Not verifying what an observed quantity means** — "0 connections = unused" is wrong. Do not base conclusions on a metric that cannot be used as **proof of absence**
- **Skipping because you estimated it as "heavy"** — "measured it and it took a few seconds" keeps happening. Measure once before skipping
- **Asserting a negative on weak grounds** — "it is not ~" is a claim that requires exhaustive confirmation
- **Not reducing the constraint table to search expressions** — there is a real case where the instruction explicitly gave the pattern and the corrected form as a constraint, yet application was missed because the work design was
  built around a different angle (tokens of the main target, etc.). **Quoting something in the constraint table and
  applying it across the entire target are different things**, and the gap is decided by the accident of work order (if the file you looked at first was already fixed,
  the pattern never even comes into view). At the start, convert each constraint into a search expression and run it across all targets before entering design
- **Fixing every finding and continuing to cycle rounds** — if you fix details that do not affect users and re-review, the next detail attaches to what you fixed, and
  the rounds never end. There is a real case where the shared usage quota was exhausted and other lanes were halted too. Follow §3-1