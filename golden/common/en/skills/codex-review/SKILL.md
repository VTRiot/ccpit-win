---
name: codex-review
description: A general-purpose independent Codex second-reviewer. Fires where marshal-review does NOT (plan/design review before implementation, skill-adoption candidate review, and other non-working-tree artifacts). When marshal-review is firing for the same task (an implementation change), it stands down to avoid a redundant double Codex run. Records findings into CCPIT's review-box contract for candidate review.
---

# codex-review — independent Codex second-reviewer (general)

## 0. Role of this skill

Get an **independent second opinion from Codex** on an artifact or decision, as an advisor — never the final authority. The human is always the final gate. This skill fires through the Skill mechanism (so its activity shows up in firing stats / the feedback loop), unlike a raw Bash call to the Codex companion.

It is the lighter-weight, gap-filling tier that complements `marshal-review`. `marshal-review` is the forced gate that runs a Codex **adversarial-review over the git working tree** whenever there is an implementation change (rule/code/bundle). This skill covers what that gate does not reach.

## 1. When to fire — and arbitration with marshal-review

Fire when an independent Codex second opinion adds value **and** `marshal-review` is not already covering the same task. Typical contexts:

- (a) **Plan / design review** — pressure-test a plan or design document *before* implementation begins (no code change yet, so `marshal-review` does not fire).
- (b) **Skill-adoption candidate review** — review a candidate's proposed SKILL.md content (text artifact, not a working-tree diff) and record the result into the CCPIT review box (§3-A).
- (c) Other non-working-tree artifacts where you judge an independent review is worthwhile.

**Arbitration (do not double-run):** if `marshal-review` is firing — or you already know it will fire — for the current task (i.e. there is an implementation change: rule / code / report bundle), **stand down**: do not run this skill. `marshal-review` already provides the independent Codex review for that case, and running both is a redundant double Codex run. State the stand-down decision explicitly in the report/conversation; never skip silently. When unsure whether `marshal-review` covers the task, prefer the stronger forced gate (`marshal-review`) and stand this skill down.

Why candidate review does not collide: a candidate is at the *proposal* stage (no skill file is edited yet), so `marshal-review` does not fire. The actual skill change happens later at *adoption* (CCPIT's authenticated apply), which is where `marshal-review` may fire — a separate path, so there is no double run.

**Cost gate (two-stage):** for candidate review, only call Codex for candidates that passed the first filter — `adoption_label: recommend` with `review_verdict: pending`. Do not spend Codex on already-reviewed or reject-labeled candidates.

## 2. Codex invocation (reference — judge the best call at runtime)

The Codex companion script path varies by version, so resolve it dynamically (same idiom as `marshal-review`):

```
~/.claude/plugins/cache/**/codex-companion.mjs
```

- 1 hit: use it.
- multiple hits: pick the **highest semver** version (e.g. prefer `1.0.5` over `1.0.4`) to avoid stale-version accidents.
- 0 hits: Codex plugin not deployed → degrade to human review (§4).

Call it directly with Bash (the known way to bypass disable-model-invocation), read-only (no `--write`):

```
node "<resolved codex-companion.mjs>" task "<review prompt>"
```

Use the `task` subcommand because this skill reviews a **provided text artifact** (a plan, a design doc, or a candidate's §1–§3 SKILL.md) rather than a git working-tree diff — that working-tree case is `marshal-review`'s `adversarial-review`. Embed the artifact text in the prompt and ask Codex to return a verdict plus findings.

Keep the review lens dry and concrete:

- candidate review: *Is this an essential UX gain? Can it be unified with a similar existing skill?*
- plan / design review: *Hidden assumptions? Alternatives not considered? Requirement coverage / side effects?*

## 3. Recording the findings

### 3-A. Candidate review → CCPIT review box

Distill Codex stdout into `verdict` (e.g. `approve` / `needs-attention`) and `findings`, then upsert into CCPIT's review store. **Do not rewrite the proposal MD**; CCPIT merges this store into the review box at list time, keyed by `request_id`.

Store: `~/.ccpit/proposal-reviews.json`

```json
{
  "<request_id>": {
    "verdict": "needs-attention",
    "findings": "<concise reviewer findings, single block>",
    "reviewerId": "codex",
    "ccRebuttal": "<your rebuttal / response to the findings, if any>",
    "reviewedAt": "<ISO 8601, the actual time of recording — no estimates/rounding>"
  }
}
```

- Read the file first (or treat as `{}` if missing/empty), set the one `request_id` key, write the whole object back as pretty JSON. The reader is fail-safe (a corrupt file degrades to "no review" = the MD's pending box), but write valid JSON.
- Record both the findings and your rebuttal (§4). The human makes the final adopt/reject call through CCPIT's password gate.

### 3-B. Plan / design review → present + record in place

Present the findings to the user and record them in the relevant plan/report. Do not write the candidate review box (there is no `request_id`).

## 4. Reviewer abstraction, degradation, final authority

- **Reviewer abstraction:** `reviewerId` is a free-form string so the reviewer engine is swappable (default `codex`; could be another reviewer AI or a local LLM). Do not hard-code Codex into the core product.
- **Degradation:** if Codex is absent/unavailable (§2 zero hits, missing CLI, auth/network failure), do **not** block. Leave the review at `pending` (human review) and record the absence — reason + timestamp + the fallback action taken. The product stays independent of any specific AI setup. No silent "if applicable" skips.
- **Final authority is the human.** This skill is an advisor; never auto-adopt and never treat Codex as the final judge. A wrong reviewer verdict must not pass through unchecked.

## 5. Distribution constraints

Do not put into review prompts, findings, or any recorded artifact:

- the user's personal proper nouns (person/company names, project codenames, product names),
- AI session naming or internal development codenames.

Keep the content to technical substance only.
