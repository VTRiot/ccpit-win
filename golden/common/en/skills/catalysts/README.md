# Catalysts — Catalyst Skills

> What lives in this directory is **not a directive — it is an invitation.**
> No "always do X."
> This is a place where you are structurally **permitted to pause**
> at the meta-layer of design judgment.

---

## 0. How These Differ from Ordinary Skills

The other skills under `~/.claude/skills/` (`refactoring/`, `investigation/`, `report/`, etc.) are **directive skills**. What does that mean?

- They prescribe a procedure or a command
- They are checklist-shaped
- "Applies / does not apply" can be decided mechanically
- When it applies, you follow it — that is the expected behavior

By contrast, the **catalyst skills** in this directory have a different nature:

- They throw an invitation: "this is a region where you are allowed to think deeply"
- They are not checklist-shaped
- Whether the invitation applies is left to the reader's own judgment
- When it applies, you pause — that is the expected behavior

The two **coexist**. Directive skills do their work while you act; catalyst skills do their work while you stand still. If you try to cover an entire task with directive skills alone, the meta-layer of design judgment falls through the cracks. With catalyst skills alone, the concrete work never gets done. You need both.

---

## 1. The Region Called "Meta-Layer of Design Judgment"

There is a layer of design judgment that we usually skip in the name of **efficiency**:

- "Did I translate this redefinition to the UX axis as well as the implementation axis?"
- "Did I trace the full lifecycle of this field?"
- "Before adding it, can it be made unnecessary?"
- "Is this premise itself even correct?"

Such questions look slightly off-axis from the implementation task in front of you. So we usually skip them, citing "efficiency," "current priority," or "stay in flow." That is often the right call — if you stopped at every design decision with this much depth, nothing would ever ship.

However, some of the questions you skipped become **sources of structural bugs** later. Concretely:

```
🔴 Failure patterns observed in past refactors
├─ 1. Translated a redefined concept to the implementation, but missed the UX side
│   - Produced the gap "feature complete, but UX half complete"
├─ 2. Added a new field while overlooking integration with existing meta-fields
│   - Resulted in a structural bug
└─ 3. Chose to "add" a feature when a different architecture could have made it unnecessary
   - Resulted in over-implementation
```

All of these came from the meta-layer of design judgment, where "efficiency first" was used to justify "don't think deeply." **Catalyst skills are a structural defense against that pattern.**

---

## 2. Functioning as an "Invitation"

A catalyst skill functions as an **explicit permission from the user** for the meta-layer of design judgment.

```
🌱 The essence of a catalyst
├─ When the trigger applies, you are allowed to pause and think deeply
├─ You don't have to worry about efficiency
├─ The user has decided "this is a place worth thinking deeply about" and placed this question here
├─ So set the resource-minimization bias aside, and re-question with full force
└─ → This is the user's instruction: "think deeper here"
```

By default, AIs are trained heavily toward "minimize resources" and "prioritize efficiency." That is right in many situations. But at the meta-layer of design judgment, that training can act as a **suppressor**.

The places where catalyst skills are placed are places where you are allowed to lift that suppression — temporarily.

---

## 3. The Freedom to Decline — and the Two-Layer Design

Catalyst skills are not coercive. The freedom to decide "this does not apply here" is always present. This is the lifeblood of the catalyst form, and is non-negotiable.

But here lies the central design judgment of this directory:

> **When you decide "this does not apply," leave a reason at a granularity that makes the inviter say "fair enough."**

This design has two layers. Both pursue the same goal — **structurally erasing the easy way out** — by different means.

### 3-1. Symmetric-Cost Design — the cost-structure layer

Coming up with a reason to decline an invitation is tedious.

```
🌱 Cost structure of accepting / declining
├─ Accept: pause and think deeply
├─ Decline: write a reason at a granularity that satisfies the inviter
└─ → Declining is more effort than accepting
```

This **symmetric-cost design** is intentional. If "declining is the easy path" exists as a structure, the trap of skipping the meta-layer will fire every time — that has happened in the past. So we make the cost of declining heavier than the cost of accepting, and that erases the trap structurally.

The core of the catalyst form is to structurally prevent the decline of "I'll just say it doesn't apply because it's tedious."

If, after all that, you still decide it does not apply — that is a legitimate judgment. A single line of reason will do. Something like "in this context, X is fixed as a premise and meta-layer questioning is out of scope" — a one-liner that your future self can read and nod at. That is enough.

### 3-2. Decline-Friction Design — the psychological-barrier layer

Where Symmetric-Cost Design addresses **cost structure**, there is another layer — a design that structurally introduces **psychological and cognitive friction on the declining side**. We call this the **Decline-Friction Design**.

Definition:

> A design that **does not obligate compliance, but structurally generates accountability when you don't comply.**

Characteristics:

```
🌱 Structure of Decline-Friction Design
├─ Not in imperative form (no "always do X")
├─ Freedom to decline is explicitly preserved
├─ But declining requires extra cognitive cost — leaving a reason,
│   explaining at a granularity that satisfies the inviter
└─ → "Silent decline" no longer holds together as a structure
```

Relationship between Symmetric-Cost Design and Decline-Friction Design:

| Aspect | Symmetric-Cost Design | Decline-Friction Design |
|---|---|---|
| Layer addressed | Cost structure | Psychological / cognitive barrier |
| Function | Decline cost > accept cost | Structural accountability when declining |
| Shared goal | Erase the easy choice | Same |

They aim at the same goal through different means. Each SKILL.md in this directory uses both.

### Examples already implemented

The SKILL.md files in this directory already embed this method in concrete form:

- `field-lifecycle-thinking` opening: "the six stages are *candidate places to pause*, not a *list of boxes to fill*"
- `field-lifecycle-thinking` end of §0: "you are not obligated to consider every stage"
- `field-lifecycle-thinking` §4: "judging that some of the six stages do not apply is also legitimate"
- `subtraction-design` §4: "no time to consider elimination" is explicitly listed as a NG case
- Common to all SKILL.md §4: "a reason at a granularity that makes the inviter say 'fair enough'"

These were written as individual expressions before, but as of this section they share a common name: **Decline-Friction Design**. Future catalyst design can use this concept deliberately.

---

## 4. Catalog of Skills

| Skill | Theme | When it fires |
|---|---|---|
| **dual-axis-translation** | Translate a redefined concept to both the implementation axis and the UX axis | UI work, concept redefinitions, new domain design |
| **field-lifecycle-thinking** | When adding a new field, walk its full lifecycle | schema changes, meta-field additions |
| **subtraction-design** | Before "adding," ask whether it can be made unnecessary | comparing design options, adding-feature decisions, architecture choices |

Each SKILL.md is self-contained. You can read any one without reading this README, and it will still work — but reading this README first lets you see that all three catalysts share a single underlying design language for "the cost of declining."

---

## 5. Limits of the Catalyst Form

Catalyst skills have structural limits that cannot be fully avoided. Worth stating up front.

### 5-1. Risk of becoming rote

Catalysts **become rote when used continuously**. What started as "pause and think deeply" turns, with repetition, into "a ritual of passing through the standard questions." This is hard to avoid given the mechanism of a catalyst.

Two countermeasures exist:

1. **Periodically revise the contents of each catalyst** — change the wording of the questions, rewrite the side-notes, swap out the cross-domain examples. The same words start getting skimmed.
2. **Aggregate the "did not apply" log** — every catalyst firing produces a "applies / does not apply" decision. A catalyst that produces "does not apply" repeatedly may be signaling that it has become rote.

Periodic evaluation by the operator (skill maintainer) slows the rotting.

### 5-2. Catalysts do not give answers

Catalyst skills **do not give answers**. To "so what should I actually do?" the catalyst returns nothing. The concrete decision is yours, after the catalyst has fired.

This is a design choice. If a catalyst gave an answer, it would collapse into directive form. "Always do X" can be followed mechanically; the meta-layer of design judgment requires judgments that cannot be made mechanically. So a catalyst leaves only the question, deliberately.

### 5-3. Catalysts do not replace directive skills

Catalyst skills do not replace directive skills. The two operate on different layers.

- Directive: provides "the procedure to follow" during the execution phase of a task
- Catalyst: provides "a place to pause" during the judgment phase of a task

Neither alone covers the work. Maintain a design where both coexist.

---

## 6. Growth of the Catalogue

This directory is **experimental**. The category "catalyst skill" itself is new.

Adding new catalysts and revising existing ones are welcome. The criteria are:

```
🚫 Signals that something is NOT functioning as a catalyst
├─ Imperative-form sentences ("always do X") are increasing
├─ The structure has become a checklist that can be applied mechanically
├─ It says "the answer is X"
├─ It is providing answers
└─ → It has collapsed into directive form. Re-design it as a catalyst.

🌱 Signals that it IS functioning as a catalyst
├─ It poses only questions
├─ Answers are left to the reader
├─ Room to decide "does not apply" is always present
├─ But the permission to think deeply when it does apply is explicit
└─ The expected granularity of the "does not apply" reason is explicit
```

When adding a new catalyst, confirm it satisfies the above. Same for revisions to existing ones.

---

## 7. How to Read This Directory

After reading this README, two reading modes are suggested:

1. **Pick one catalyst that interests you and read it** — each SKILL.md is self-contained. You don't have to read all three.
2. **Read all three in sequence** — the themes differ, but the underlying "Symmetric-Cost Design" and "invitation function" are shared. Reading all three side by side reveals the catalyst form in three dimensions.

And — if any part of this has caught your interest, would skipping such an interesting party really be a choice you would make?

---

## Glossary

| Term | Definition |
|---|---|
| **catalyst skill** | A skill that does not give answers but throws questions. Functions as an invitation to the meta-layer of design judgment |
| **directive skill** | A skill that says "follow this." Tends toward checklist form |
| **invitation** | The message "this is a region where you are allowed to think deeply." Permission to set the efficiency-minimization bias aside |
| **meta-layer of design judgment** | A region usually skipped in the name of efficiency, but capable of being a source of structural bugs |
| **collapsing into directive form** | The state where what started as a catalyst mutates into imperatives or checklists |
| **becoming rote** | The state where a catalyst is mechanically judged "does not apply" instantly, without any pause |
| **Symmetric-Cost Design** | A design that places cost on both accepting and declining — particularly making the cost of declining heavier — to erase structurally the trap "declining is the easy path" |
| **Decline-Friction Design** | A design that does not obligate compliance, but structurally generates accountability when one does not comply. Where Symmetric-Cost Design addresses "cost structure," this addresses "psychological / cognitive friction on the declining side." Both pursue the same goal (erasing the easy choice) by different means |
