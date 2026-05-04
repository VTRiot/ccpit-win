---
name: field-lifecycle-thinking
description: Fires when adding a new field to a schema, when adding a meta-field (status, confirmed, locked, etc.), or when working on a task where you need to consider a field's lifespan — to walk through the full lifecycle as a catalyst.
---

# Field Lifecycle Thinking — An Invitation to Walk the Field's Lifespan

> This skill is not a directive. No "always check all six stages."
> When you add a new field, this is a place where you may pause
> and walk through its **full lifecycle.**
> The six stages are *candidate places to pause*,
> not a *list of boxes to fill*.

---

## 0. What this is

Adding a new field to a schema happens often. `status`, `confirmed`, `locked`, `reviewedAt`, `favorite` — meta-field additions are especially frequent.

When this happens, the addition looks local: "define the field, write where it gets set, write where it gets displayed." That feels like the work is done.

But every field has a **lifespan**. It is born, persisted, read, modified, and sometimes deleted. At each stage of that lifespan, design decisions are required.

If you only implement one or two stages of the lifespan and forget the rest, the field ends up "working but full of holes." The holes are invisible at first. They surface later, with time. **A past refactor produced a structural bug from overlooking integration with existing meta-fields** — that incident is the origin of this catalyst.

This skill divides the field's lifespan into six stages and offers each stage as a place to pause. **There is no obligation to consider every stage.** But your decision to consciously not consider a stage, and silently skipping past it, are different things.

---

## 1. Why this question lives at the meta-layer

The work of adding a new field is, in the foreground of the task, performed "to realize a specific feature." For example, given the requirement "let users mark things as complete," you add a field called `completed`.

The center of design gravity, then, is "how do we satisfy the feature requirement?" That is correct — a design that does not satisfy the requirement fails as a starting point.

But the moment the feature requirement is satisfied, the field-addition work tends to be judged complete. The other stages of the lifespan — the relationship to existing fields, the reset path, migration, UX visibility — get pushed into a layer of forgetting under "consider it later," "out of scope," or "no clear requirement, so on hold."

```
🌱 Where the forgetting happens
├─ A field F is added to satisfy feature requirement X
├─ The minimal behavior of F (set, read, display) gets implemented
├─ The moment X is satisfied, the addition of F feels "complete"
├─ But the other stages of F's lifespan are outside the X context, so they slip out of awareness
└─ → Later, when F is handled in a different context, the un-designed stages surface as holes
```

The most frequent hole is **"overlooking integration with existing fields."** A `confirmed` is added when `status` already exists; `frozen` is added when `locked` already exists. Fields with overlapping meaning living side by side make it ambiguous which one to trust. This is the breeding ground of structural bugs.

This catalyst offers six places to pause against that layer of forgetting.

---

## 2. The six stages of the lifespan — candidate places to pause

There is no obligation to walk through the six stages in order. Considering only the stages that are relevant, depending on the nature of the task, is a legitimate judgment. But the act of consciously distinguishing "stages that are relevant" from "stages that are not" — that is what this catalyst does.

### Stage 1 — Birth

**At what timing, by what action, does this field get set?**

User action? Automated process? Cascading from another field's change? What's the initial value?

*Listing the set paths consciously sometimes turns up "set paths I had not anticipated."*
*For example, "the initial value at data import time," "the default during migration," "bulk insert from an external API" — these often do not appear in the feature-requirement discussion.*
*Once you become aware of them, "what about at import time?" surfaces as an additional requirement.*

### Stage 2 — Decommission

**Is there a path for the user to reset / undo this field?**

The setting path tends to be conscious. But the "undoing path" frequently falls out of the feature-requirement discussion.

*The requirement "let users put a complete mark" does not necessarily include "let users remove a complete mark."*
*But a user who put the mark on by mistake will want to take it off.*
*Without an undo path, the asymmetry "the field can be set but not unset" appears in the UX.*
*Deliberately not providing an undo path is also a possible decision (when irreversibility is a requirement). But "deliberate" and "unaware" are different things.*

### Stage 3 — Persistence

**Where, and how, does it get stored?**

DB? File? Memory? Persistence granularity?

*Where you persist changes write frequency, integrity guarantees, and behavior under failure.*
*"It works" alone does not determine the choice of persistence target. The decision depends on the task's lifespan vs. the user's expectation of persistence.*
*In particular, "should this survive across sessions?", "should it last forever?", "should it remain until the user explicitly deletes it?" — these are the design decisions to make at this stage.*

### Stage 4 — Migration

**What is the strategy for existing data? Eager or lazy?**

At the moment a new field is added, existing data has no value for it. How do you handle that?

*Eager migration (insert the initial value into all records at once) is reliable but pays the cost of touching all data.*
*Lazy migration (fill the value at next access) is lightweight but can leave un-touched records semi-permanently un-migrated.*
*Either can be correct. But "lazy by default, without an explicit decision" is a hole.*
*If the migration strategy is not documented, the fact that some records are partially un-migrated will become a source of structural bugs later.*

### Stage 5 — Integration with existing meta-fields

**Are there existing fields with the same kind of meaning? Is the relationship one of (superset / complement / replacement / deprecation)?**

This is the most important stage of the catalyst. **Past structural bugs have come from overlooking this stage.**

*Before adding a new field, check whether its meaning overlaps with existing meta-fields like `status`, `flag`, `confirmed`, `locked`, `done`.*
*If overlap exists, the relationship is one of four:*
*- **Superset**: the new field contains all the information of the old field. The old field becomes derivable from the new one*
*- **Complement**: the new field handles an aspect the old field does not. There is meaning in having both side by side*
*- **Replacement**: the new field completely replaces the old field. The old field is now scheduled for deprecation*
*- **Deprecation**: the addition of the new field makes the old field unnecessary*
*The state "neither of the four; they just kind of both exist" will, without exception, become a structural bug later.*
*"They do not overlap" is also a legitimate conclusion. But before reaching that conclusion, it is worth confirming that they really do not overlap.*

### Stage 6 — UX visibility

**Is there a path for the user to confirm the state of this field?**

A field's value, until it surfaces, does not exist for the user.

*Fields used only internally (system-internal state management) need no UX visibility.*
*But for fields that relate to user actions, without a visibility path, the user cannot determine the current state.*
*"The field exists, but it appears nowhere" cannot be distinguished by the user from "the feature does not exist."*
*This question connects with the `dual-axis-translation` catalyst — how do you display, on the UX axis, the value that was set on the implementation axis?*

---

## 3. Cross-domain — the same shape of question in other fields

The structure "when adding a new variable, walk its lifespan" is not specific to software.

### Domain 1 — Adding a new parameter to an engine control map

When you add a new correction parameter to an ECU map, that parameter's lifespan:

- **Birth**: Under what operating conditions does it get computed?
- **Decommission**: Does it get reset on anomaly detection?
- **Persistence**: Stored in EEPROM? RAM only?
- **Migration**: When updating from an older ECU, how do you decide its initial value?
- **Integration with existing parameters**: Does the meaning overlap with existing correction values? (Most important — double-application of corrections is dangerous)
- **Visibility**: Can a mechanic read it via diagnostic tools?

Question: Could correction values double-apply or cancel each other out? What is the relationship to the meaning of existing correction parameters?

### Domain 2 — Adding a new feature to an ML model

When you add a new feature to a model:

- **Birth**: From what is it computed?
- **Treatment of missing values**: For records where the value cannot be obtained, what do you do?
- **Persistence**: Stored in a feature store? Computed on the fly?
- **Migration**: How do you generate it for past data?
- **Integration with existing features**: What is the correlation with existing features? Is the same signal already represented in another form?
- **Visibility**: Can it be confirmed via feature importance / SHAP values?

Question: By adding a new feature highly correlated with existing ones, is the model's interpretability damaged?

### Domain 3 — Adding a new column to a database

When adding a new column to an existing table:

- **Birth**: In which operations does it get written?
- **Decommission**: Is there a path back to NULL?
- **Persistence**: Behavior at transaction boundaries?
- **Migration**: DEFAULT strategy for existing rows?
- **Integration with existing columns**: Relationship to existing triggers / indices / constraints?
- **Visibility**: Is it surfaced at the application layer?

Question: Could existing triggers fail to recognize the new column, in a path where integrity collapses?

### Domain 4 — Amending a contract clause

When adding a new clause to a contract (a structure analogous to adding a field):

- **Birth**: From which transactions does it apply?
- **Decommission**: Is there a path under which it is voided?
- **Persistence**: How is it preserved as a document?
- **Migration (transitional measures)**: Retroactive application to past contracts? Design of transitional rules?
- **Integration with existing clauses**: Are there clauses contradicting it? Override? Complement?
- **Visibility**: Is there a path through which the parties can recognize the existence of the clause?

Question: If a new clause is added without designing transitional measures for past contracts, are the interpretations of past transactions left dangling?

---

## 4. When you decide it does not apply

The freedom to decide "this does not apply here" is always present.

But when you do, leave a reason at a granularity that makes the inviter say "fair enough."

Coming up with a reason to decline an invitation is tedious. That is intentional design — making the cost of declining heavier than the cost of accepting, to erase structurally the configuration "declining is the easy path." This consists of two layers, **Symmetric-Cost Design** and **Decline-Friction Design** (see `~/.claude/skills/catalysts/README.md` §3-1 / §3-2).

The redundant explicit statements found throughout this catalyst — "you are not obligated to check all six stages," "they are candidate places to pause, not a list of boxes to fill," "judging that some of the six stages do not apply is also legitimate" — are concrete implementations of **Decline-Friction Design**: they structurally prevent the catalyst from being read as "applies, mechanically."

For this catalyst especially, the judgment **"some stages of the six do not apply"** is also possible. For example:

- "This field is internal state only; UX visibility (stage 6) is out of scope"
- "This field is part of a brand-new schema; migration (stage 4) is unnecessary"
- "This field is session-scoped only; persistence (stage 3) is unnecessary"

Such partial "does not apply" judgments are also legitimate. However, for **stage 5 (integration with existing meta-fields)** especially, before deciding it does not apply, take particular care to confirm. The most frequent hole of this catalyst lives there.

What you should avoid is "I'll just say it does not apply because it's tedious."

---

## 5. When this catalyst fires

This catalyst is intended to fire in situations such as:

- New field additions to schemas (data models / record types / DTOs, etc.)
- Additions of meta-fields (status, confirmed, locked, frozen, archived, etc.)
- Tasks where the field's lifespan needs consideration
- Design decisions involving schema changes

Whether it actually fires is left to the reader's judgment. Even for field additions, there are cases where the lifespan discussion is unnecessary.

---

## → Related

- For the design philosophy of catalyst skills in general: `~/.claude/skills/catalysts/README.md`
- Related catalysts: `dual-axis-translation` (connects with stage 6, UX visibility), `subtraction-design` (asks whether the field can be made unnecessary before adding)
