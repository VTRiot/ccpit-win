---
name: codex-review
description: General-purpose independent Codex second-reviewer. Fires in areas not covered by marshal-review (pre-implementation plan/design review, candidate skill review, artifacts that are not working-tree diffs). If marshal-review fires in the same task (implementation changes exist), stand down to avoid redundant dual Codex runs. When reviewing candidate skills, records findings into CCPIT's review box contract. If the task is an independent cross-check of factual research / study conclusions, use the `codex-cli-crossref` skill (which calls the raw `codex exec` CLI directly, with procedures for a separate tool) instead of this skill.
---

# codex-review — Independent Codex Second-Reviewer (General-Purpose)

## 0. Role of This Skill

Obtains an **independent Codex second opinion** on artifacts and decisions as an advisory input. Holds no final authority. The final gate is always a human. Because this skill fires through the Skill mechanism, unlike invoking the Codex companion directly from Bash, its activity is tracked in trigger statistics and feedback loops.

It serves as a lightweight gap-filling layer that complements `marshal-review`. `marshal-review` is an enforced gate that runs **Codex adversarial-review against the git working tree** whenever there is an implementation change (rule / code / bundle). This skill covers the areas beyond the reach of that enforced gate.

## 0-A. Distinguishing from the `codex-cli-crossref` Skill (Check First)

The entity invoked by this skill is **`codex-companion.mjs` bundled with the plugin** (supporting the `task` subcommand and the `--prompt-file` argument), which is responsible for **reviewing artifacts that do not contain code diffs**—such as pre-implementation design documents, skill candidates, and other artifacts that are not working-tree diffs (actual code diffs are handled by `marshal-review`'s `adversarial-review` as described in §2, and this skill arbitrates to prevent overlap).

Conversely, when you want to **corroborate factual research or study conclusions with an independent engine** (cross-checking factual claims, rather than code diffs or design documents), use the `codex-cli-crossref` skill instead of this skill. `codex-cli-crossref` is a procedure for a different tool that calls the **globally installed raw `codex exec` CLI** directly; how prompts are passed (stdin redirection; the `--prompt-file` flag does not exist in `codex exec`) and where records are saved (directly quoted in the caller's report, rather than in the CCPIT review box) differ from this skill.

When in doubt, distinguish with a single question: "Is the target an independent cross-check of factual research / study conclusions?" → If Yes, use `codex-cli-crossref`. Otherwise (review of pre-implementation design documents, skill candidates, and all other non-working-tree diff artifacts in §1(c); actual code diffs remain with `marshal-review`), use this skill. **The targets in §1(c) are not excluded by this section**—this section isolates only the specific single use case of "factual research cross-check", and all other reviews of non-code-diff artifacts remain the domain of this skill.

In environments where the `codex-cli-crossref` skill is not adopted or deployed, `~/.claude/skills/codex-cli-crossref/` does not exist. In that case, treat the destination of this section as absent, and either degrade to human review even for factual research cross-checks (following the degradation policy in §4) or use the official non-interactive mode procedure (direct invocation of `codex exec`) provisionally while verifying each time.

## 1. Trigger Conditions — and Arbitration with `marshal-review`

Fires when an independent Codex second opinion adds value, **and** `marshal-review` does not cover the same task. Typical contexts:

- (a) **Plan / design review** — Pressure-test plan / design documents *before* implementation begins (since there are no code changes yet, `marshal-review` does not fire).
- (b) **Skill candidate review** — Review proposed SKILL.md contents of candidates (text artifacts that are not working-tree diffs) and record results into CCPIT's review box (§3-A).
- (c) Other artifacts that are not working-tree diffs and are deemed worthy of an independent review.

**Arbitration (do not double-run):** If `marshal-review` fires or is already known to fire in the current task (= implementation changes exist: rule / code / report bundle), **stand down**: do not run this skill. In that case, `marshal-review` already provides an independent Codex review, and running both results in a redundant dual Codex execution. State the stand-down decision explicitly in the report or conversation. No silent skips. When in doubt about whether `marshal-review` covers the task, prioritize the enforced gate `marshal-review` and withdraw this skill.

Why candidate reviews do not conflict: Candidates are in the *proposal* stage (skill files have not been edited yet), so `marshal-review` does not fire. Actual skill modification occurs downstream at *adoption* time (authenticated apply in CCPIT), where `marshal-review` may fire — because the pathways are separate, double execution does not occur.

**Two-tier cost gate (cost threshold):** In candidate reviews, call Codex only for candidates that have passed the primary filter — `adoption_label: recommend` and `review_verdict: pending`. Do not spend Codex runs on candidates already reviewed or labeled reject.

## 2. Invoking Codex (Stable Form Mandatory — Runtime Judgement Limited to Companion Path Resolution)

Because the path of the Codex companion script varies across versions, resolve it dynamically (the same idiom as `marshal-review`):

```
~/.claude/plugins/cache/**/codex-companion.mjs
```

- 1 hit: Adopt it.
- Multiple hits: Adopt the **highest semver** (e.g., if `1.0.4` and `1.0.5`, choose the latter). Prevents leftover older version accidents.
- 0 hits: Deem the Codex plugin undeployed, and degrade to human review (§4).

Call directly from Bash (the known technique to avoid disable-model-invocation). Read-only (no `--write`):

```
node "<解決した codex-companion.mjs>" task --cwd "<実在する絶対パス>" --prompt-file "<レビュープロンプトの絶対パス>"
```

This skill uses the `task` subcommand to review **provided text artifacts** (plan / design documents, or §1–§3 SKILL.md of candidates). Git working-tree diff cases are the responsibility of `marshal-review`'s `adversarial-review`. Write the review prompt (including artifact text) to a file, pass it via `--prompt-file`, and request Codex to return a verdict + findings.

Keep review perspectives dry and concrete:

- Candidate review: *Is this an essential UX improvement? Can it be unified with similar existing skills?*
- Plan / design review: *Hidden assumptions? Unconsidered alternatives? Requirement coverage / side effects?*

## 3. Recording Findings

### 3-A. Candidate Review → CCPIT Review Box

Distill Codex stdout into `verdict` (`approve` / `needs-attention`) and `findings`, then record them into CCPIT's review store **via the recording script (canonical path)**. **Do not rewrite the proposal MD** (this refers to §5 review box auto-transcription; CC does not hand-overwrite §5. Revising candidate body text is a separate activity governed by §3-A-1 with a different actor for revision); CCPIT merges this store into the review box at list time, keyed by `request_id`.

Store: `~/.ccpit/proposal-reviews.json` — **never edit by hand**. Only the recording script writes it, validating before write with the same predicates used by read-side gate (hand-writing produces records that "wrote fine but fail the gate", or type mismatches):

```
node ~/.claude/scripts/proposal-review-record.cjs --request-id <id> --batch-file <batch.json>
```

Batch JSON (skeleton):

```json
{
  "verdict": "approve | needs-attention",
  "findings": "<[n] 連番のレビュー本文。読者の言語（既定: 日本語）で書く>",
  "findingsOriginal": "<レビュアが別言語で返した場合のみ、原文をそのまま（任意）>",
  "reviewerId": "codex",
  "ccRebuttal": "<findings への反論／応答があれば（任意）>",
  "reviewRounds": 1,
  "adjudications": [{ "id": "1", "decision": "rejected", "reason": "<実質的な理由>" }]
}
```

- `reviewedAt` / `proposal_hash` / `adjudicationsFor` **cannot be passed** (the script computes them from actual recording time, proposal MD measurement, and findings text — eliminating estimation, rounding, or transcription drift).
- `adjudications[].id` is a **string** (`"1"`). Passing a JSON number is rejected (the read-side gate type-sensitively matches `[n]`).
- When findings contain `[n]` items, **recording is disallowed until terminal adjudications (`rejected`/`deferred`) are complete for all items**. Intermediate states mid-loop cannot be recorded; record only the final round that completed the harvest loop (revision → re-review or adjudication). **When there are 0 findings (`VERDICT: approve` with no findings), include `FINDINGS: none` in `findings` to state it deterministically** (the recording script treats this string paired with `verdict: approve` as harvest completion).
- In environments lacking the script, do not hand-write as substitute. Keep review results in work log and request human deployment of script (reviewer absence degradation is §4).
- Record both findings and own rebuttal (§4). Final adoption/rejection judgment is made by human through CCPIT password gate.

### 3-A-1. Additional Verification When Candidate Embeds a Runnable Script

**Separation of duties**: Extraction, execution, and revision in this section are performed by **the calling CC** (§2 Codex invocation is read-only review opinion retrieval; executing code or revising candidates is not Codex's job). Responsibility for revising candidate body text follows existing governance norms (CC revises proposal MD).

When a candidate's completed version ("## 3. Completed version after change" block in proposal MD) embeds a runnable script such as Node.js, **do not conclude that findings have been addressed based solely on Codex static review**. For each harvest loop cycle (revision → re-review; each revision cycle under §3-A "cannot record until terminal adjudications are complete for all items"), perform the following:

1. **Extraction**: Pull code blocks **verbatim** from candidate body and materialize them as files in a working temporary directory (outside the project working tree; do not retype by hand). **Do not execute code requiring external writes, real data, or credentials**—target only isolated temporary areas and dummy inputs (fixtures). If execution is impossible due to missing runtime/dependencies, explicitly state "unverified" and do not claim "verified" (in this case, the finding may be subject to `deferred` in §3-A harvest).
2. **Counter-example measurement (findings with execution outcomes only)**: For Codex findings regarding **code behavior** (where execution results change), create an MD fixture (or equivalent input) reproducing the issue and **actually run it with the pre-fix script to confirm failure** (verifying that counter-example functions as counter-example). For findings **without execution outcomes**—design decisions, documentation wording, guarantee scope clarification—do not apply this step; revising the text itself constitutes the response, and checks tailored to finding nature (re-reading revised text to ensure no contradiction with prior wording) suffice.
3. **Post-fix measurement**: Run the same fixture with the fixed script and confirm expected output and exit code.
4. **Regression verification**: Re-test the **normal-case fixture and all counter-example fixtures used in past rounds** (collectively termed "regression set") in the same run, confirming the current fix does not break counter-examples fixed in earlier rounds. In initial rounds where no past counter-examples exist, verify candidate yields expected exit code on basic cases instead of regression set.
5. **Byte-match verification**: After writing fixes back to candidate body, mechanically verify that **code re-extracted from body** is byte-identical to the file actually executed and verified.
6. **Record after revision**: The recording script in §3-A measures `proposal_hash` from proposal MD on disk at record time. Complete revisions in this section (including guarantee scope notes upon cutoff) **prior to recording (§3-A)**—revising after recording causes mismatch between recorded `proposal_hash` and actual file, leaving review records pointing to stale versions.

Writing only "addressed Codex findings" in `ccRebuttal` or findings response fields without following this procedure leaves responses as mere claims, preventing mechanical detection of missed fixes or newly introduced bugs.

**Judging round cutoff (detecting scope overrun)**: When finding characteristics shift qualitatively from "patching holes in lightweight tools" to "re-implementing different systems" (e.g., CSS cascade rules/specificity, full-parser-equivalent syntactic analysis), further iteration demands altering the candidate's design policy itself (implementing a full processing engine rather than a lightweight auxiliary tool). At that point, terminate iterations, establish policy to mark remaining findings as `deferred`, **explicitly document guarantee scope limits in candidate body** (e.g., "what exit code 0 means and does not mean"), and record via §3-A script (per Step 6, revision precedes recording). **However, if remaining findings undermine the candidate's primary purpose, do not cut off**—`deferred` is a means of passing peripheral known limitations to human adjudication, not a way to push through unmet primary objectives. If primary objectives cannot be met, revisit design while remaining at `needs-attention` (returning to §3-A harvest) or reject candidate entirely. This decision axis is distinct from `plan-review-convergence-loop`'s "enumeration mode after same finding class repeats for 2 rounds" (which tracks iteration counts of finding classes rather than qualitative changes in requested implementation); both may be used in tandem where applicable.

**Handling verification files**: Temporary files created during extraction and execution in this section (extracted scripts, fixtures, execution logs) must reside outside the project working tree (in scratch directories). These are not subject to §1 arbitration (implementation changes triggered by `marshal-review`)—they are temporary byproducts of review activity, not changes to the working tree.

### 3-B. Plan / Design Review → Present and Record on the Spot

Present findings to user and record in applicable plan / report. Do not write candidate review box (as `request_id` does not exist).

### 3-C. When the Route Is Broken — Triage Once Before Degrading

If an invocation results in 404 / 400 / no response, diagnose **exactly once** before proceeding to §4 degradation:

    node ~/.claude/scripts/codex-path-doctor.cjs

**Upper limit is 1 time, 5 minutes.** If diagnosis is impossible (script absent, no response, limit reached, unrecoverable),
**record the reason and immediately proceed to §4. Do not make successful recovery a prerequisite for degradation.**
The "do not block" rule in §4 is not weakened in any way by this section.

Diagnosis measures entities, pinning, and connectivity, outputting **candidate causes** and prescriptions (not definitive diagnoses).
Pitfall details and prescriptions appear in script output and **are not enumerated in this section**.

**Diagnosis does not modify configuration.** Even if a communicating model is identified, reflection in config
**must be performed manually by a human** (the script only outputs "which line to fix how"). Connectivity
**does not guarantee capability sufficient for independent review**; therefore, reflection adheres to existing configuration change authority.

## 4. Reviewer Abstraction, Degradation, and Final Authority

- **Reviewer abstraction:** `reviewerId` is a free-form string allowing the reviewer engine to be swapped (default `codex`; other reviewer AIs or local LLMs are permissible). Do not hard-code Codex into the core system.
- **Degradation:** If Codex is absent or unresponsive (§2 zero hits, CLI missing, auth/network failure), **do not block**. Leave review in `pending` (human review) and record absence — reason + timestamp + alternative action taken. The core system maintains independence from specific AI setups. Silent skips of "if applicable" style are forbidden.
- **Final authority rests with humans.** This skill is an advisor. Do not auto-adopt, and never make Codex the final court of appeal. Erroneous reviewer verdicts must never pass unverified.

## 5. Distribution Constraints

Never include in review prompts, findings, or recorded artifacts:

- Personal proper nouns of users (names of persons, companies, project codenames, product names),
- AI session nomenclature or internal development codenames.

Restrict content strictly to technical substance.

## Companion Stable Invocation Form (Mandatory)

When invoking `codex-companion.mjs task`, strictly adhere to the following form:

    node <absolute companion path> task --cwd <existing absolute path> --prompt-file <absolute prompt path> [--json]

- Do not pass prompt text directly in argv (forbidden: single-argument form `task "<long prompt>"`).
  When argv following a subcommand has only 1 element, companion re-tokenizes shell-style and
  misparses short-flag-like strings within the body (such as `-C`) as options
  (Actual incident: quoting `git -C` usage example → `--cwd` contamination → all probes ENOENT → false "Codex CLI is not installed" alert).
- Always specify an existing directory in `--cwd` (ensuring argv has multiple elements, structurally preventing re-tokenization).
- When spawning from programs, use `process.execPath` rather than `'node'` string (avoiding shim resolution drift).
- Encountering "Codex CLI is not installed or is missing required runtime support" warrants
  inspecting invocation form (single-argument prompt, non-existent cwd) before doubting installation status.

Detailed RCA: Project memory `feedback_codex_review_method.md`, 2026-08-25 addendum section.
