---
name: skill-proposal-emitter
description: Fires at session end to emit, for each WorkFlow worth turning into a skill, a proposal MD containing the complete SKILL.md + an adopt/reject label + evaluation-axis scores. Formatted so a human can adopt it from CCPIT's candidate browser with near-zero effort.
---

# skill-proposal-emitter — Skill-proposal MD emitter skill

## 0. Role of this skill

During a session, you (CC) often run useful WorkFlows. Instead of throwing them away, leave the ones worth turning into a skill as a **proposal MD**. The human reviews them as a list in CCPIT's candidate browser and adopts with near-zero effort via: review gate → password auth → adopt (kind:skill apply).

This is the entry point (proposal = sensing) of Part B "Skill adoption & feedback pipeline". The proposal format is aligned with CCPIT's kind:skill apply input, so adoption applies the content almost verbatim to `~/.claude/skills/<name>/SKILL.md`.

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

```markdown
---
request_id: <FILL: matches the request-id in the filename>
created_at: <FILL: ISO 8601, e.g. 2026-05-29T16:58:00+09:00>
purpose: <FILL: one line — what this proposes to turn into a skill>
target: ~/.claude/skills/<FILL: skill-name>/SKILL.md
status: pending
kind: skill
adoption_label: <FILL: recommend | reject>
source_project: <FILL: absolute path of the working dir at generation time, e.g. C:\path\to\your\project>
---

## 1. Summary

- Title: <FILL: one-line title of the candidate skill>
- What: <FILL: what this skill does, 1-2 lines>
- Why: <FILL: why turning it into a skill helps, 1-2 lines>
- How: <FILL: how/when it is used or fires, 1-2 lines>

## 2. Evaluation axes

Fill a 0-5 score AND a rationale for every axis (empty / boilerplate is rejected by CCPIT's quality gate).

- Reproducibility: <FILL: 0-5> — <FILL: rationale>
- Generality: <FILL: 0-5> — <FILL: rationale>
- ContextSaving: <FILL: 0-5> — <FILL: rationale>
- OverlapWithExisting: <FILL: 0-5> — <FILL: rationale (if overlap, propose unification)>
- EssentialUXGain: <FILL: 0-5> — <FILL: rationale>

## 3. Final content after change

On adoption, the content of this block is written verbatim as the SKILL.md at `target`.
**Make the outer fence at least one backtick longer than the longest inner backtick run**
(if the longest inner run is N, the outer fence is N+1 or more; minimum 3; not fixed at 4 — CommonMark fence rule.
CCPIT's parser matches "opening N → closing N or more").
Example: if the SKILL.md body contains a 3-backtick fence (```), the outer fence is 4 (````); if it contains 4, the outer fence is 5.

````markdown
---
name: <FILL: skill name (matches target)>
description: <FILL: description incl. firing conditions>
---

<FILL: the complete SKILL.md, including steps and examples (inner code examples allowed)>
````

## 4. Adopt / reject decision and reason

- Decision: <FILL: recommend | reject (matches frontmatter adoption_label)>
- Reason: <FILL: decision reason grounded in §2 axes. Even for reject, never drop it — always record the reason>

## 5. Review box

Filled by a reviewer (human / future reviewer AI). Emit empty (pending) at proposal time.

- review_verdict: pending
- findings:
- reviewer_id:
- cc_rebuttal:
```

### 2-3. Key authoring steps

1. Inventory the WorkFlows you ran this session and list **all** candidates worth turning into a skill.
2. **Check existing skills**: before filling the "OverlapWithExisting" axis, Read the existing skill list under `~/.claude/skills/` (do not write "no overlap" without looking — for the overlap check to be meaningful).
3. Score each candidate (§2). Even low-value ones are emitted **with a reject reason** (never dropped).
4. **Handling duplicates**: a candidate that clearly overlaps an existing skill is not `recommend`ed — set `reject` and state the overlap target and whether they can be unified (reduces duplicate proposals accumulating across every-session firing; note the primary duplicate-prevention is CCPIT's candidate-browser "already-seen / adopted" visualization).
5. Write the "## 3." final SKILL.md at adopt-and-run quality (steps, firing conditions, examples).
6. Make the outer fence at least one backtick longer than the longest inner backtick run (inner N → outer N+1; not fixed at 4; see §2-2).
7. Frontmatter must be **flat key: value only** (no nesting; CCPIT parser constraint).

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

## 7. Completion

After emitting the proposal MD(s), CC tells the human in conversation:

- The proposal file path(s) (all of them)
- Each candidate's title and adopt/reject label
- "Please adopt from CCPIT's candidate browser"

CC does **not** edit `~/.claude/skills/` directly. Adoption goes through CCPIT's authenticated apply path (the core of the safety architecture).
