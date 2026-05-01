---
status: in_progress
report_id: <task-id-here>
parent_task_id: <parent-task-id or "standalone">
report_type: debug-report
created_at: <YYYY-MM-DD HH:MM>
---

# Debug Report — <task-id>

> This report is a copy of the debug-toolkit skill template.
> When complete, change `status` to `completed` and pass the
> required-section check by the debug-report-gate hook.
> Declaring completion with required sections empty will be blocked by the Stop hook.

---

## 1. Observed Facts【REQUIRED】

> Describe the symptom objectively (no speculation).
> Include file location, timing, reproduction conditions, observed values.
> Do not use "should be" or "presumably." Measured values only.

(write here)

---

## 2. Pattern in Use【REQUIRED】

> From the §2 Pattern Catalog of debug-toolkit, choose the Pattern(s) you will use for this debugging session.
> Fill this section **from the start** (not at the end).

Selected Pattern(s) (multiple allowed; "none" must be made explicit):

- [ ] Pattern 1: Distinguish "all targets" vs "specific targets" first
- [ ] Pattern 2: Flip descriptive data into prescriptive questions
- [ ] Pattern 3: The trap of judging a specific target by a source common to all targets
- [ ] Pattern 4: Multi-layer safety for catastrophic operations
- [ ] Pattern 5: Specify the relationship between new and existing features as one of four values
- [ ] Pattern 6: Eliminate order-dependence in conditional branches via data-driven tables
- [ ] Pattern 7: Negative invariants must be asserted by tests
- [ ] Pattern 8: Protect the hierarchy between explicit intent and automatic inference
- [ ] No applicable Pattern (→ §7 New Pattern Proposal becomes mandatory)

How each selected Pattern was used (2–3 lines per Pattern):

(write here)

---

## 3. Hypothesis Candidates【REQUIRED】

> List multiple candidates (at least 2; only one means shallow reflection).
> Include rejected candidates.
> For each, state verification priority and rationale.

Candidate 1: ...
Candidate 2: ...
Candidate 3: ... (optional)

Rejected candidates and reasons:
- Candidate X: rejection reason
- Candidate Y: rejection reason

---

## 4. Verification Process【REQUIRED】

> Record step by step how each hypothesis was verified.
> Following the investigation skill's counter-evidence checklist, also seek evidence that disproves your conclusion.

- Step 1: ...
- Step 2: ...
- Step 3: ...

Counter-evidence check:
- [ ] Are there other code paths with the same functionality? (exhaustively enumerated)
- [ ] Did runtime logs / debug output back up the conclusion?
- [ ] If this conclusion is wrong, what is the real cause? (at least one alternative hypothesis)
- [ ] Are there past cases where the initial conclusion turned out wrong?

---

## 5. Root Cause and Resolution【REQUIRED】

### 5-1. Identified Root Cause

(write here)

### 5-2. Applied Resolution

(write here)

### 5-3. Descriptive Reading (What — how it actually behaved)【REQUIRED】

> The code behaved this way. Statement of fact.

(1–2 lines)

### 5-4. Prescriptive Reading (Should — how it should have been designed)【REQUIRED】

> Given that this symptom occurred, the design was fragile here. It should have been designed as follows.
> Suggestion at the design level for preventing recurrence of the same class of mistake.

(1–2 lines)

---

## 6. Reduction to the Pattern Catalog【REQUIRED】

> A judgment to grow the §2 Pattern Catalog of debug-toolkit.
> Choose one of the three options and fill the corresponding section.

- [ ] **A**: Solved using existing Pattern N (the activation is already described in §2)
  - Pattern adopted: ...
  - Reduction proposal: none (existing Pattern covers it sufficiently)

- [ ] **B**: Existing Patterns were insufficient; a new pattern was discovered
  - → §7 New Pattern Proposal becomes mandatory

- [ ] **C**: Existing Patterns cover this sufficiently, but no addition proposed
  - Applicable existing Pattern: ...
  - Why no addition is needed: ...

---

## 7. New Pattern Proposal (mandatory only when "B" was selected in §6)

> If the existing Patterns were insufficient, propose a new one here.
> Follow the five steps in §3 ("Pattern for Extracting Patterns") of debug-toolkit.

### 7-1. Pattern Name (within 30 chars, domain-independent, English)

(write here)

### 7-2. Abstract Description (3–5 lines)

> Articulation of a domain-crossing principle.

(write here)

### 7-3. Concrete Case (3–5 lines)

> Describe what happened, abstracting proper nouns (file names / component names).
> Use phrasing like "in a certain management screen ..." or "in the auto-classification feature of X ...".

(write here)

### 7-4. Lesson (1–2 lines)

> A behavioral guideline: "in short, you should think this way."

(write here)

### 7-5. Cross-Domain Reach (at least 2 domains)

> Why this pattern would be valuable to generalize.
> Cite at least two concrete cases in different domains.

- Domain A: ...
- Domain B: ...
- Domain C: ... (optional)

---

## 8. Personal Lesson【OPTIONAL】

> Lessons not Pattern-worthy but learned this round.
> Personal improvement points, reflections, what to be mindful of next time, etc.

(write here)

---

## Pre-Completion Checklist

Confirm before changing `status` to `completed`:

- [ ] §1–§6 are all non-empty
- [ ] If "B" was chosen in §6, all of §7 is non-empty
- [ ] No speculation written as fact (no "should be" used)
- [ ] All counter-evidence checklist items answered

If all OK, change the YAML front matter at the top from `status: in_progress` to `status: completed`, then declare completion.

---

## Three-Stage Self-Reflection (optional but recommended)

> The three-stage structure in §3-2 of the debug-toolkit skill.
> Activate the inner driver for extracting Patterns from new failures.

- **Acknowledge**: ... (acknowledge what you had not even imagined)
- **Regret**: ... (was there room to notice? articulate the headroom in yourself)
- **Specify the next move**: ... (how will you change the exploration pattern next time?)
