---
name: debug-toolkit
description: Fires when you observe a defect, bug, unexpected behavior, or symptom; when you start a debugging task; before forming a root-cause hypothesis from a symptom; or when consulting known thinking patterns (Patterns).
---

# Debug Toolkit — A Workshop of Thinking Patterns

> This skill is **NOT a catalog of off-the-shelf tools**.
> It is a systematized **thinking framework for building tools yourself**.
> When the symptom is not on the menu, do **not** force-fit it to the closest pattern.
> If you don't have the right tool, build one. That is the spirit of this skill.

---

## 0. The Minor-Marque Mechanic Mindset (Preface)

This skill is **a toolbox for a mechanic who services minor / less-popular marques of cars**.

Generic tools — off-the-shelf scan tools, OBD-II readers, standard logic analyzers — handle the common failure modes. But this skill does not catalog ready-made tools. In a minor-marque restoration shop, the required tool often does not exist at all. The mechanic **invents the tool on the spot**.

When you encounter an unfamiliar symptom, you have two choices:

1. **Force-fit the symptom to an existing tool** (heuristic over-fit) — leads to misdiagnosis, symptom-hiding, recurrence, or the problem reappearing somewhere else
2. **Invent the missing tool yourself** (SST = Special Service Tool) — the professionalism of a minor-marque mechanic

This skill systematizes the **second mindset**. When you see a symptom that is not on the menu, do not force-fit. Invent a new SST when needed. And when you judge that the SST you built can apply to other domains, propose adding it as a new **Pattern** to this skill (see §4 Self-Extension Rule).

This is a **growing thinking framework**, open to all CC users as a shared asset. The Pattern you articulate today might rescue a different domain's problem tomorrow.

The "secret sauce" metaphor: this skill is not a recipe. It is the cook's philosophy — what makes flavor good, where to make judgments, how to learn from failures — passed down in the form of a particular shop's tradition. Do not imitate the steps; embody the thinking.

---

## 1. How to Use (Onset Workflow and the Hard Interlock)

### 1-1. Steps at the Start of a Debug Task

When you observe a defect, bug, or unexpected behavior and start debugging:

1. **Articulate the symptom**: describe what is happening as objective fact (no speculation)
2. **Copy the template**: copy `templates/debug-report-template.md` to a task-specific path
   - Example destination: `_Prompt/01_FromBuilderAi/_DebugReports/<task-id>/debug-report.md`
   - Decide the destination path based on the project's conventions
3. **Consult the §2 Pattern Catalog**: look up which Pattern applies to the symptom. If one applies, use its three-layer structure to form a hypothesis
4. **If no Pattern applies**: invoke the meta-thinking pattern in §3 ("Pattern for Extracting Patterns"). Treat the case as a candidate for a new Pattern
5. **Fill out debug-report.md while debugging**: complete §1–§8 of the template. Section §2 ("Pattern in Use") must be filled **from the start**, not at the end

### 1-2. The Hard Interlock (debug-report-gate hook)

This skill includes a **completion-time forced check mechanism**:

- Hook name: `debug-report-gate` (Stop event)
- Script: `~/.claude/hooks/debug-report-gate.sh`
- Behavior: when CC tries to declare completion, the hook checks whether all required sections in the in-progress `debug-report-*.md` are filled. If any required section is empty, completion is **blocked**.

This forced mechanism structurally prevents CC from "completing with §6 left empty because we are busy." Documentary rules alone can be ignored by CC, as has been observed in prior cases. Some invariants can only be protected by physical enforcement at the hook layer (see also Pattern 7 in §2).

### 1-3. About Hook Registration

The hook script ships with this skill. The actual registration in `settings.json` is performed by **the user (human)**:

- CC cannot edit `settings.json` directly (per CLAUDE.md / safety-principles)
- See `templates/hook-registration-guide.md` for registration steps
- The hook file can be placed in the prescribed location even before registration; the user registers it during the next maintenance window

### 1-4. Intended Audience

- **CC (Claude Code, the implementing AI)**: primary reader. Consults the Pattern Catalog and fills the template during a debug session
- **Design AI**: organizes new Pattern proposals using this skill's format
- **OSS users**: reference this skill in their own projects and add domain-specific Patterns over time

---

## 2. Pattern Catalog (Core)

> Less "looking up the menu" and more "opening a drawer of thinking patterns."
> Each Pattern is described as a Three-Layer Structure (abstract description → concrete case → lesson + cross-domain reach).
> Why three layers: humans (and AIs) cannot understand abstraction without concrete examples,
> but concrete examples alone do not generalize. Lesson and cross-domain reach recursively reinforce the abstraction.

---

### Pattern 1: Distinguish "all targets" vs "specific targets" first

**Abstract layer**:
When observing a defect, the first thing to check is **the scope of occurrence in the target population**. "All targets affected" vs "only specific targets affected" partition the hypothesis space cleanly. Common infrastructure / rendering / configuration layer vs individual data / state / condition layer. Mixing these leads to attempts to fix a common-layer problem at the per-target data level (or vice versa) and quickly turns into a swamp.

**Concrete case**:
On a management screen, every registered target (dozens of items) showed "two status badges drawn side by side." On the first item observed, the diagnosis "this target's data is corrupted" was nearly adopted. Then a second item showed the identical symptom, and the cause was identified as a problem in the common list-rendering logic. Had work started from the first item alone, fixing target data would not have removed the symptom.

**Lesson**:
When you see a symptom, build the habit of **immediately comparing one more target**. After observing one, always look at a second.

**Cross-domain reach**:
- In ECU reverse-engineering, "the same communication error on all ECUs" vs "errors only on a specific ECU" point to firmware / protocol issues vs ECU individuality / data variation respectively
- In embedded-device firmware development, "all tags fail to read" vs "only specific tags fail" — reader-side vs tag-side
- In legal-compliance traceability, "missing records across the entire period" vs "missing records only in a specific period" — system fault vs individual operational error
- In engine-control calibration-map generation, "errors across all driving conditions" vs "errors only in specific regions" — global model coefficients vs interpolation-boundary issues

---

### Pattern 2: Flip Descriptive Data into Prescriptive Questions

**Abstract layer**:
When reading past documents, commit logs, scope-of-investigation tables, or data, do not stop at "this is past fact." Flip it: **"why was this information needed?"** and **"therefore, the design ought to have been ...?"**. Information that is not written (design rationale, psychological motives, preventive intent) can be recovered only through prescriptive reading. When a table appears, recognize that **the existence of the table itself is a mirror reflecting the designer's areas of concern**.

**Concrete case**:
A past instruction document for a project contained a comparison table covering several other related projects. The implementer processed this descriptively, as "reference data on the current state." But asking **"why was this table needed?"** would have surfaced a design judgment: a preventive motive to avoid breaking compatibility with the other projects. The presence of the table itself was a signal of an unwritten preventive intent. The implementer did not perform this flip and remained unaware of one of the design motives until disclosed later.

**Lesson**:
When a table appears, **think one line about "why this table was needed" before moving on**. The breadth of investigation scope reflects the designer's areas of concern. When a design choice favors "single management," "unification," or "minimal configuration," the explicit "cost avoidance" often hides an implicit "ripple-effect avoidance" preventive motive.

**Cross-domain reach**:
- In legal-compliance traceability, when reading past communication histories, "what is NOT written" hints at the truth. Silence is testimony
- In engine control, reverse-deriving an intended torque map from a fuel map is similar — the shape of the map reveals the controller's intent
- In ECU reverse-engineering, the layout of calibration data shows which parameters the developer wanted to tune
- In RAG-system development for conversational AI, what the user did NOT ask hints at premises the user already takes for granted
- In organizational meeting minutes, topics that did NOT come up reveal the organization's blind spots

---

### Pattern 3: The Trap of Judging a Specific Target by a Source Common to All Targets

**Abstract layer**:
When designing judgment logic, first verify whether each input source is **specific to the judgment target or common to all targets**. Sources common to all targets must NOT be used as judgment material for a specific target. Common-source-based individual judgment yields the same result for every target — a logical contradiction. Enumerate input sources and label each as "target-specific" or "common to all" before designing.

**Concrete case**:
In a project-classification system designed to "judge the configuration of a target project," global settings (common across all projects) were included in the judgment material. In production, "multiple projects all collapse into the same judgment result" was observed. One subset of the common configuration (`settings.json`) was already documented as out-of-scope for judgment, but other subsets in the same common configuration (`hooks/skills/rules`) remained in-scope. **Logical consistency was broken**. The fix excluded the common source completely, judging only target-specific sources.

**Lesson**:
At judgment-logic design time, label every input source as **target-specific / common**. Common sources are out-of-scope for judgment. A design that excludes only a partial subset of a common source is **logically half-baked** and will inevitably break.

**Cross-domain reach**:
- In ML feature engineering, a feature that is constant across all samples cannot improve classification performance (information-theoretically zero)
- In engine control, using a coefficient common to all engines as a per-engine correction value defeats individual-variation compensation
- In organizational HR evaluation, using criteria common to all employees (e.g., the company mission) as the basis for individual evaluation produces uniform ratings
- In ECU reverse-engineering, reading the Vehicle ID region (common to all ECUs) reveals nothing about the individual ECU's character

---

### Pattern 4: Multi-Layer Safety for Catastrophic Operations

**Abstract layer**:
When implementing irreversible operations (delete, overwrite, external API call, flash write), **a confirmation dialog alone is insufficient**. The invariant "this function does not perform irreversible operations" must be **structurally guaranteed across code layer, type layer, test layer, and UI layer**. The same professional culture as a mechanic who, when working on the brake system, always disconnects the battery and verifies master-cylinder protection. **Multi-layering** is the only way to protect assets from cognitive bias in humans (and LLMs).

**Concrete case**:
A management tool's "remove from list only — do not delete the actual file" function. Failure of this contract would be a critical incident — the user's important data deleted. The design split responsibility: a "file-delete function" and a "list-management function" as separate functions, with the list-removal feature only calling the latter. A yellow warning ("This does NOT delete files") was displayed in the UI. Ideally, a unit test would assert "after list-removal, the directory still exists," but that test remained unimplemented (see Pattern 7). At the implementation-pattern level, the three-layer defense (responsibility-split + UI warning + function naming) was in place.

**Lesson**:
Do not put irreversible and reversible operations **in the same function** (responsibility split). Do not include `delete` / `rm` in the function name (it invites mistaken calls). Display explicit warnings in the UI. Then, **guarantee the invariant with tests** (see Pattern 7). Only when all of these are in place can it be called "multi-layered."

**Cross-domain reach**:
- In legal-compliance traceability, "permanently delete from archive" and "remove from active view" must be separate functions
- In embedded-device firmware, flash write and RAM write absolutely must not share the same function. Flash is irreversible in both lifetime and content
- In ECU reverse-engineering, an EEPROM-rewrite tool should separate read mode and write mode at the hardware level. Software-layer confirmation alone is insufficient
- In ISO 26262 functional safety, an irreversible operation at ASIL-D level (e.g., releasing ABS braking) must be protected by a multi-channel control system. A confirmation dialog alone does not satisfy ASIL-B or higher
- For smart-contract reentrancy protection, doubling up on checks-effects-interactions and a mutex prevents recurrence of The DAO incident; documentary rules alone do not

---

### Pattern 5: Specify the Relationship between New and Existing Features as One of Four Values

**Abstract layer**:
When designing a new feature, **always specify "which existing feature it relates to"**. The relationship type must be selected as one of: **add / replace / coexist / phase-out**. Adding without specification produces **duplicate implementation, data conflict, and UI overlap**. The maxims "don't fix on the side" and "ignore conflict with existing features" are mutually exclusive; when the new feature is a clear superset of the existing one, **replacement = an exception to "don't fix on the side"** and must be declared explicitly.

**Concrete case**:
A management tool's design added a new status-display badge. A legacy badge already existed, but the design specification did not state "delete the legacy badge" or "keep the legacy badge." The implementer interpreted the ambiguity as "keep both" and resulted in two badges drawn side-by-side on every target row. Later investigation articulated that "at design time, the legacy badge should have been replaced as the new badge is a superset" was the intent. The fix exhaustively removed the legacy badge JSX, related constants, i18n keys, and even the local interface in dialogs to align state. The structural cause was that the design-spec template **lacked a "relationship to existing features" section**.

**Lesson**:
The design specification (FSA / instructions) must always include fields for **"related existing features (location / component / data source)," "relationship type (add / replace / coexist / phase-out)," and "deletion targets / retention targets"**. If the designer leaves these blank, the implementer has an obligation to ask before starting work.

**Cross-domain reach**:
- In ECU reverse-engineering, when developing a "new analysis method," failing to specify "replace" or "coexist" with the existing method causes data integrity to break under double analysis
- In engine-control map updates, failing to specify "full-region replace," "partial-region overwrite," or "parallel operation" between the new and old maps causes the engine to behave unintendedly
- In organizational change, failing to specify whether the existing workflow is "discontinued" or "operated in parallel" alongside the new workflow causes confusion
- In RAG-system development for conversational AI, when adding a new knowledge source, failing to specify "which to prioritize on duplication," "show both," or "decide priority by context" produces contradictory answers
- In legal-compliance system updates, failing to specify "transition period," "concurrent retention," or "automatic conversion" between new and old record formats breaks evidential consistency

---

### Pattern 6: Eliminate Order-Dependence in Conditional Branches via Data-Driven Tables

**Abstract layer**:
When chaining multiple judgment rules as `if A then X else if B then Y else if C then Z`, the rule order can change the result. When a higher rule (A) subsumes the conditions of lower rules (B, C), reordering changes the verdict. This is **order-dependence as a side effect**. If the conditions can be rewritten as mutually independent dictionary lookups, table-ization structurally removes order-dependence. When an `else if` chain reaches three levels or more, consider data-driven table-ization.

**Concrete case**:
In a project-classification system, four-stage judgment rules (complete configuration / partial configuration / legacy / unknown) were written as an `else if` chain. Targets that satisfy R1 also satisfy R2's conditions; if a refactor placed R2 before R1, R1-complete targets would be classified as R2. The structurally correct expression is "a dictionary defining (condition, result) pairs per rule ID," with the judgment as a pure function returning the highest-priority ID whose condition is satisfied — eliminating order-dependence. Table-ization remained a refactoring candidate, not yet applied.

**Lesson**:
When an `else if` chain reaches three or more levels, consider data-driven table-ization. If the conditions are not independent (overlap with each other), express them with a table that explicitly assigns priorities. Tabularized rules **dramatically improve testability**, since each rule can be verified in isolation.

**Cross-domain reach**:
- An ECU control map is typically a "condition → output value" dictionary. Writing `if RPM > 5000 and TPS > 80 then ...` with delays is harder to tune, test, and reverse-engineer than `Map<(RPM_band, TPS_band), output>`
- For ECU-reverse-engineering parsing rules per ECU type, replacing `else if` with `Map<ECU_signature, parser>` makes new-ECU support a parser-addition only
- In embedded-device firmware, writing state transitions as `else if` chains breeds order-dependent bugs frequently. State-transition tables improve verifiability
- In ML feature engineering, replacing conditional branches with lookups eases parallelization and optimization
- In rule-based judgment for legal contracts, table-ization with explicit priority order prevents disputes
- In RAG-system development for conversational AI, replacing user-intent classification's `else if` with a `Map<intent_label, response_template>` is more extensible

---

### Pattern 7: Negative Invariants Must Be Asserted by Tests

**Abstract layer**:
Negative invariants ("must NOT do X") cannot be sustained by documentary rules alone in the long run. They will be broken — at commit-review time, by a newcomer's added implementation, during refactoring, in large-scale changes — moments where someone fails to read the document (or reads it but loses focus) WILL happen. Negative invariants must be structurally guaranteed by **tests, type systems, static analysis, or hardware mechanisms**. "Documentary safety is not safety" is the core philosophy of ISO 26262 and applies to software in general.

**Concrete case**:
In a management tool, two negative invariants were established: "the auto path NEVER overwrites an existing marker" and "the list-removal feature NEVER touches the filesystem." The former is asserted by an explicit unit test (Case 1) and is also documented. The latter is documented but has no unit test. Therefore, the latter **will be broken the moment someone in a future refactor adds an `unlink` call**. Only when a test like Case 1 fails immediately on regression can a negative invariant be sustained. The unimplemented test is a technical debt and should have been prioritized by criticality.

**Lesson**:
When you find a "must NOT do X" in a codebase, check whether a test asserting it exists. If not, adding the test is the first priority. Documentary protection is a **time bomb**. In code reviews, when you see a comment like "this function presupposes X is not done," look for ways to add a test or enforce it via the type system.

**Cross-domain reach**:
- ISO 26262's functional safety requirements demand BOTH "safety goals (must NOT)" and "safety requirements (mechanisms that prevent)." Documentary safety is not safety, per the ISO philosophy
- In engine control, "fuel injection must not exceed engine tolerance" is enforced not only by software-layer limiters but also by hardware (injector spec) and CAN protocol-layer guarantees
- In smart contracts, negative invariants like "no reentrancy" or "do not call others" are structurally guaranteed by checks-effects-interactions or mutex patterns. Documentary rules alone produce The DAO–level incidents
- Database foreign-key and NOT NULL constraints are stronger when enforced at the DB layer than at the application logic layer
- Eiffel-style design-by-contract postconditions and invariants are checked at compile-time / runtime. Invariants in comments are only as durable as the comments themselves
- In RAG-system development, the negative invariant "do not generate false information" must be guaranteed in multiple layers: prompt constraints, source attribution, and verification flow
- In legal-compliance traceability, "do not tamper with evidence" must be enforced not only by operational rules but also physically — write-once media, hash verification, timestamped signatures

---

### Pattern 8: Protect the Hierarchy between Explicit Intent and Automatic Inference

**Abstract layer**:
When a system stores both "values explicitly stated by humans (explicit intent)" and "values produced by machine inference (automatic inference)" in the same data field, the **hierarchical relationship must be designed explicitly**. Default to **explicit intent > automatic inference**, and require an "explicit overwrite-permission action" for automatic inference to override explicit intent. Without this hierarchy design, **"data evaporation"** occurs — the user's explicit input is silently overwritten on the next automatic update. Implement hierarchy protection with three components: (a) source-of-origin meta field, (b) staged-permission hierarchy, (c) UI visualization of the source.

**Concrete case**:
In a target-classification system, the metadata of each target could be written via two paths: "automatic inference" and "user manual input." By design, the auto path was guaranteed to "never overwrite existing data," and only the user-manual path performed an existing overwrite (with a UI confirmation dialog). A meta field `stage_inferred` distinguished "automatic inference (true) / explicit intent (false)," and the UI also distinguished them with a fade and an asterisk (`*`). The principle that **explicit intent is hierarchically above automatic inference** was applied consistently. If the hierarchy were violated, a user who manually entered `protocol="manx"` would see the value reverted to `protocol="unknown"` on the next automatic scan — a "data evaporation" event.

**Lesson**:
If a field can be written by both "user input" and "machine inference," implement hierarchy protection with all three: (a) a meta field distinguishing the source of origin, (b) a staged-permission hierarchy for overwrites, (c) UI visualization of the source. Missing any of the three causes "data evaporation" incidents.

**Cross-domain reach**:
- In LLM-based code completion, when both user edits and AI auto-corrections write to the same buffer, AI overwriting the user's most-recent edit destroys trust. Cursor- / Copilot-style editors struggle with this hierarchy design
- In autonomous vehicles, the "driver-action vs ADAS-intervention" hierarchy. The driver's explicit intervention (e.g., grabbing the wheel) must immediately override ADAS — a key principle of ISO 26262 SOTIF
- In engine-control tuning, if "values manually adjusted by the user" and "values learned automatically" land in the same table, source flags and priority are required
- In ECU-reverse-engineering tuning software, automatic Map import must not overwrite calibration values hand-written by the user
- In spreadsheets, the distinction between "user-input cells" and "formula cells." A UI where formulas overwrite manually entered values causes confusion
- In configuration management, the hierarchy of "user setting / organizational policy / default." That explicit intent (user setting) outranks automatic inference (default) is universal — from Windows Group Policy to AWS IAM Policy
- In RAG-system development, when the user corrects ("this answer is wrong"), the correction must take precedence over future RAG search results. Maintain the correction history as a higher-tier layer

---

## 3. Pattern for Extracting Patterns (Meta Thinking)

> This section is the **meta level** of the skill.
> When you encounter a new failure that existing Patterns cannot capture,
> systematize the way to extract a new Pattern.
> With this meta-thinking pattern, this skill can self-grow.

### 3-1. Five Steps for Pattern Extraction

When you experience a new failure, extract a Pattern through five steps:

#### Step 1: Write the surface of the failure in one sentence

It is fine to be very specific. "When clicking button X, instead of Y, Z appeared" is the right level. Capture file names, line numbers, observed symptoms candidly. **Do not rush to abstract**. Capture the fact while preserving specificity.

#### Step 2: Abstract the essence by one level

Discard file names, individual variable names, specific UI element names. Raise to "for a component X with a state, when trigger Y fires, expected value Z is not obtained." At this point, ask yourself **"could this happen in other code?"**. If not, stop. The case has no Pattern-ization value.

#### Step 3: Extract a reusable principle from the essence

Make it domain-independent. Convert into a normative form: "in situation X, verify Y" or "when implementing X, write it with structure Y." Try giving it a **name within 30 characters**. If you cannot, the abstraction is still shallow. What cannot be named is not yet a Pattern.

#### Step 4: Test the principle in another domain

Consider whether the same trap could occur in another domain you know (your specialty / hobby / different project). If you cannot concretely identify a case in **at least two domains**, the Pattern has low generalization value. Ideally, **three or more domains** should yield concrete cases. Test in domains as far apart as possible — embedded development, data processing, UI/UX, organizational theory, natural science, law. The higher the test pass rate, the more robust the Pattern.

#### Step 5: Register as a Pattern, propose per the Self-Extension Rule

Describe in the Three-Layer Structure (abstract → concrete → lesson + cross-domain reach). Propose in §6 ("Reduction to the Pattern Catalog") of the completion report. After Design AI review and adoption decision, the Pattern is formally added to this skill.

### 3-2. The Three-Stage Self-Reflection (Inner Driver Alongside Pattern Extraction)

When you encounter a new failure, hold the following three-stage structure as inner posture:

#### Acknowledge

Say "I had not even imagined this" honestly. **Do not make excuses**. Acknowledging what you did not notice means acknowledging what you did not know, which makes the boundary of your knowledge visible.

#### Regret

Articulate "but there was room to notice." Was the data there? Could you have reached it by flipping the perspective? Ask yourself. **Verbalizing regret** is what generates the energy for next time.

#### Specify the next move

Do not stop at abstraction. Articulate **concrete exploration patterns**: "next time, look at X" or "next time, add Y as a step in the reflection." A new Pattern extracted via the five steps is the most concrete tool for specifying the next move.

This three-stage structure is the inner driver of Pattern extraction. Executing the five steps without the inner three-stage structure produces only **template-shaped patterns**. Run both wheels together.

### 3-3. Watch out for Heuristic Over-fit

When consulting the Pattern Catalog, you may encounter symptoms that **do not perfectly match** any Pattern. At that point, humans (and LLMs) tend to **force-fit the symptom to the closest Pattern** due to cognitive bias. We call this **heuristic over-fit**.

#### Steps to Avoid Over-fit

1. **Articulate the symptom first** — write it down before consulting the catalog
2. **Look at the catalog and self-rate the match: 0–100%**
   - ≥80%: follow the Pattern's three-layer structure
   - 50–80%: refer to the Pattern but design an independent investigation plan
   - <50%: treat as a **new Pattern** and start extraction with the five steps in §3-1
3. **Record Patterns you ruled out** (why you rejected them)
4. **Over-fit warning signs**:
   - You start to think the symptom fits an existing Pattern only by deliberately re-phrasing the symptom — danger sign
   - Verification steps were executed but the actual results differ from expectations — likely the wrong Pattern; form an alternative hypothesis
   - The symptom persists after the fix, or a similar symptom appears elsewhere — over-fit misdiagnosis is likely

---

## 4. Self-Extension Rule (Continuous-Growth Mechanism)

This skill is **not a finished document — it is a growing thinking framework**, open to all CC users as a shared asset.

### 4-1. Self-Reflection Discipline at Task Completion

When CC completes a debugging task, fill out all required sections of `debug-report.md`. In particular, §6 ("Reduction to the Pattern Catalog") and §7 ("New Pattern Proposal" if applicable) are physically prevented from empty completion by the **hard interlock**.

### 4-2. Adoption Criteria (Generalizability)

| Criterion | Recommend Adoption | Reject |
|---|---|---|
| Likelihood of recurrence | Could happen in different projects / situations | Specific to this project / data |
| Abstraction difficulty | Fits a 30-character name and the three-layer structure | Too many specific details, abstraction is shallow |
| Cross-domain reach | At least two domains yield concrete cases | Applies to only one domain |
| Clarity of normative form | Expressible as "if X, do Y" | Action guidance is vague |

When uncertain, **bias toward recommending adoption** (avoid rejection bias). Design AI makes the final call.

### 4-3. Proposal Flow (Four Steps)

```
Step 1: CC self-proposes in the completion report (debug-report.md)
  - §6 Reduction to the Pattern Catalog: 3-way choice
  - §7 New Pattern Proposal: details if applicable
  - Hook blocks empty completion

Step 2: Design AI reviews
  - Generalizability assessment
  - Check overlap / proximity with existing Patterns
  - Adoption decision (when uncertain, bias toward adoption)

Step 3: After adoption, an instruction document is issued for CC to add the new Pattern
  - Add the new Pattern to SKILL.md §2
  - Sync with Golden distribution (ja/en)
  - Ship via sync-to-public.ps1 to OSS

Step 4: Diffusion to OSS
  - The new Pattern is shared with all CC users via ccpit-win
  - This is the essence of "growing toolbox"
```

### 4-4. Pattern Numbering Convention

- Extending the existing catalog → consecutive number (Pattern 9, Pattern 10, ...)
- Tentative ID → `Pattern-NEW-XX` (promote to formal numbering when confirmed)
- Sub-Pattern of an existing Pattern → `Pattern N-a`, `Pattern N-b` (when not an independent new Pattern)

### 4-5. Inheritance of the Underlying Thinking Framework

The §3 ("Pattern for Extracting Patterns") and §3-2 ("Three-Stage Self-Reflection") are abstractions of the thinking framework gained through past development. Without naming proper nouns, the **thinking pattern is inherited**. CC extracting a new Pattern runs the three-stage structure inwardly while executing the five steps.

---

## 5. Glossary

| Term | Definition |
|---|---|
| CC | Claude Code (the implementing AI) |
| CCPIT | Claude Code Protocol Interlock Tower |
| FSA | Function Spec Anchor |
| FM | Failure Mode |
| FMA | Failure Mode Analysis |
| Pattern | A debugging / design thinking pattern organized as a domain-independent abstract principle |
| Pattern Catalog | The core of §2. A collection of Patterns in three-layer structure |
| Three-Layer Structure | Abstract description → concrete case → lesson + cross-domain reach |
| Pattern for Extracting Patterns | Meta-thinking pattern. Five steps for extracting a new Pattern from a failure |
| Hard Interlock | Mechanism in the hooks layer that physically prevents leaving template fields blank |
| debug-report-gate | Stop hook implementing the hard interlock |
| The Minor-Marque Mechanic Mindset | The professional posture of building one's own tool when needed, instead of relying solely on existing tools |
| SST | Special Service Tool. A specialized tool used in mechanical work; in this skill, a metaphor for a self-built tool against an unknown bug |
| Heuristic Over-fit | The cognitive bias of force-fitting a symptom into the existing Pattern Catalog |
| Descriptive Reading | Reading data as past fact (What) |
| Prescriptive Reading | Reading data as design lesson, "how it should have been" (Should) |
| Explicit Intent | A value explicitly stated by a human (Pattern 8) |
| Automatic Inference | A value produced by machine inference (Pattern 8) |
| Negative Invariant | A protective obligation of "must not do X" (Pattern 7) |
| Data-Driven Table | A design that replaces conditional branching with dictionary lookup (Pattern 6) |
| Data Evaporation | An incident where explicit intent is silently overwritten by automatic inference (Pattern 8) |
| Three-Stage Self-Reflection | The three-step posture: Acknowledge → Regret → Specify the next move |
| Living Document | A document continuously updated as features evolve. This skill is one |

---

## 6. Reference Appendix: 27 Failure Modes Catalog (with Pattern Labels)

> This appendix catalogs 27 specific failure modes accumulated in CCPIT development.
> Each FM is labeled with the Pattern in §2 of which it serves as a **concrete case**.
> The intended flow: a future CC reads Pattern N first, then references FM-XX as a concrete case.
> For OSS users, this is offered as "CCPIT-specific reference cases."
> Use it to check whether your own project has analogous Pattern-traps.

### 6-1. FM List (Symptom-Indexed, with Pattern Labels)

| FM ID | Symptom (summary) | Primary Pattern | Secondary Pattern |
|---|---|---|---|
| FM-A-01 | Launch button does not start CC | Pattern 4 (fire-and-forget invariant) | — |
| FM-A-02 | Launch options not applied | — | Pattern 5 (backward compat vs phase-out) |
| FM-A-03 | Some items in ⋯ menu unclickable | — | — |
| FM-A-04 | AutoMode anomaly | Pattern 5 (no legacy-flag retention = phase-out) | — |
| FM-A-05 | Banner anomaly after successful launch | — | — |
| FM-B-01 | Discovery does not find PJs | Pattern 1 (all roots vs specific roots) | — |
| FM-B-02 | Discovery over-detection | — | Pattern 5 (promotion to user setting) |
| **FM-B-03** | **[CRITICAL] Real files deleted by Remove** | **Pattern 4 (multi-layer for catastrophic ops)** | **Pattern 7 (vitest defense missing)** |
| FM-B-04 | Select All / Deselect All broken | — | — |
| FM-C-01 | Two badges side-by-side (legacy + new) | **Pattern 5 (relationship to existing features)** | — |
| **FM-C-02** | **[CRITICAL] Existing marker overwritten** | **Pattern 4** | **Pattern 7 + Pattern 8 (explicit vs auto)** |
| FM-C-03 | All PJs show `?` only | **Pattern 6 (R1–R4 order-dependence)** | Pattern 1 (all PJs vs specific PJs) |
| FM-C-04 | stage_inferred UI not reflected | Pattern 8 (explicit vs auto) | — |
| FM-C-05 | No re-render after Edit Marker save | — | — |
| FM-C-06 | Re-scan confirm skipped | Pattern 4 (confirm as one safety layer) | — |
| **FM-C-07** | **[CRITICAL] Global write occurred** | **Pattern 4 + Pattern 7 (path validation missing)** | — |
| FM-C-08 | profiles load failure | — | — |
| FM-C-09 | "informational only" note missing in evidence | Pattern 3 (common-source-out-of-judgment) | — |
| **FM-C-10** | **Self-host PJ shows unknown/low (spec)** | **Pattern 3 (common-source-exclusion logic)** | Pattern 2 (prescriptive reading of Self-host structure) |
| FM-C-11 | Non-standard value in badge (data issue) | Pattern 8 (user-input freedom) | — |
| FM-D-01 | Favorite not persisted | — | — |
| FM-D-02 | Reserved fields throw undefined | Pattern 5 (incremental rollout) | — |
| FM-D-03 | location_type abnormal | Pattern 5 (staged remote-feature rollout) | — |
| FM-FF-01 | UI persists after flag is OFF | Pattern 5 (hidden vs disable) | — |
| FM-FF-02 | Flag reflection delayed | — | — |
| FM-FF-03 | New flag breaks existing config | Pattern 5 (4-file sync) | Pattern 7 (mergeFeatures test) |
| FM-FF-04 | Flag interaction broken | Pattern 6 (combinatorial test missing) | Pattern 8 |

### 6-2. FM Details

For full details, refer to `_Prompt/_Knowledge/debug-guide-archive_260430/` in the CCPIT development repository (7 files). This appendix is an index used to reference concrete cases from the Pattern Catalog.

Each FM follows the FMA format:
- Symptom (observable phenomenon)
- Scope of impact
- Known incidents
- Cause candidates
- Verification steps
- Files to modify
- Related vitest cases
- Caveats on repair (including prescriptive reading)
- Past repair history

Note for OSS users: the FMs above are failure modes specific to CCPIT's system (an Electron + React + TypeScript management tool). Direct application to your own project may not be possible, but **the Pattern labels make the thinking framework transferable**. Reading Pattern N first and then referencing the corresponding FM as a concrete case can spark the realization "an analogous Pattern-trap could exist in my project too."

### 6-3. "Grow" Rather than "Use"

This appendix is **not a frozen archive**. As CCPIT adds new features, new FMs will be added here. Each FM is linked to §2 Pattern Catalog through Pattern labels and serves as material for proposing new Patterns.

Handover to future CCs maintaining CCPIT development:
- Observe a new feature defect → append a new FM-XX to the end of this appendix
- If any existing Pattern in §2 applies, add a Pattern label
- If none applies, invoke §3 ("Pattern for Extracting Patterns") and propose a new Pattern
- After Design AI review and addition to §2, update the Pattern label of the FM

---

## → Fire next skills

- For investigation procedure (counter-evidence checks, exhaustive code-path enumeration), refer to **skill:investigation**
- For investigation report formatting, refer to **skill:research-report**
- Before entering the implementation phase, fire **skill:rumination** (Q1–Q4) and **skill:refactoring** (reflection rounds 1–2)
- Before declaring completion, refer to **skill:completion-interlock** and confirm that the debug-report-gate hook does not block

---

> **This skill is an OSS asset shared with all CC users.**
> Your contributions (proposals per §4 Self-Extension Rule) grow this thinking framework.
> If you don't have the right tool, build one. That is the spirit of the Minor-Marque Mechanic.
