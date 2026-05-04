---
name: dual-axis-translation
description: Fires when translating a redefined concept into an implementation, when working on UI-facing code, or when designing in a new domain — to ask "did you consider both the implementation axis and the UX axis?"
---

# Dual-Axis Translation — An Invitation to Both Axes

> This skill is not a directive. No "always translate to both axes."
> It is placed here as a place where you may pause and ask
> whether you have **translated only to the implementation side
> while overlooking the UX side**, when a redefined concept
> drops into the system.

---

## 0. What this is

When you redefine a concept and reflect that redefinition in the system, a translation occurs.

For example, the concept "tamper-evident history" gets translated, in code, into "physical guarantee via append-only structure." This is **translation to the implementation axis**.

But concept translation does not end on the implementation side. The same concept may also need translation to the **UX axis** — the UI through which a user can *experience* tamper-evidence, the visualization of state, the design of feedback.

If the implementation translation is complete but the UX translation is still missing, the user sees an odd system: "the concept is physically guaranteed, but there is no path to experience it." The gap **"feature complete, but UX half complete"** is born.

This skill is a catalyst that, in places where this gap is likely to occur, offers you "permission to keep both axes in view."

---

## 1. Why this question lives at the meta-layer

In implementation tasks, "build something that works" takes top priority. That priority is correct — there is no point dressing up the UX of something that does not work yet.

But many implementation tasks are judged complete the moment "it works." "It works" is the completion criterion of the implementation axis, not of the UX axis. And yet the two get conflated easily.

```
🌱 Where the conflation happens
├─ You concentrate on translating the concept into implementation
├─ The moment it works, you feel "the concept has been realized"
├─ But from the user's standpoint, that realization does not exist
│   unless it surfaces on the UX
└─ → "Physical guarantee in code" ≠ "experience from the user's side"
```

This conflation is usually skipped in the name of efficiency. "UX is for later." "Getting it working comes first." That priority quietly redirects the UX-axis translation toward forgetting.

Time passes. The UX-axis translation drops out of memory as "work I had been planning to do." The implementation runs. The tests pass. But the user cannot experience the realization of the concept.

The structural defense against that forgetting is the theme of this catalyst.

---

## 2. The questions

There is no obligation to answer the following in order. Which question to enter from is left to the reader's judgment, depending on the nature of the task.

### Question 1 — Did you translate this concept redefinition to the UX axis as well?

You are conscious of translating to the implementation side. But the UX side?

*Translation to the implementation side can be judged complete by the objective test "does it work?"*
*Translation to the UX side requires judging "can the user experience the concept?" — a subjective judgment whose evaluation itself is fuzzy.*
*That fuzziness creates the temptation to file the UX-axis translation under "later" or "out of scope."*

### Question 2 — Can the user actually experience the implementation's physical guarantee?

When something is "guaranteed" by the implementation, how does that guarantee appear from the user's standpoint?

*A physical guarantee, until it surfaces, does not exist for the user.*
*"Quietly protected behind the scenes" alone — the user neither believes nor knows the guarantee exists.*
*Only when there is an experiential path — a UI display, feedback, state visualization, a means of confirmation — does the guarantee become real on the UX axis as well.*

### Question 3 — If the user cannot experience it, does that mean UX translation is needed? Or is it genuinely unnecessary?

Not every implementation guarantee that the user cannot experience requires UX translation. For example, internal data-integrity checks may be fine without surfacing.

*This is the lifeblood of the catalyst. "Dual-axis translation is always correct" is not the position.*
*Whether UX translation is needed depends on the nature of the concept and the expectations the user holds about it.*
*Surfacing "guarantees the user did not expect" can instead increase cognitive load.*
*The judgment is the reader's. The catalyst does not force the judgment.*

### Question 4 — Dual-axis translation or single-axis: which is appropriate for this task?

If dual-axis is needed, treat the UX-axis translation work at the same priority level as the implementation-axis work. If single-axis is enough, make the choice to deliberately omit the UX axis explicit.

*Either judgment is legitimate. What we want to avoid is the state of "single-axis, by default, without realizing it."*
*Your "I considered both axes and chose single-axis" and "I did not consider both axes, so it ended up single-axis" — the outcomes look the same, but the quality differs.*
*This catalyst is a place to pause, to convert the latter into the former.*

---

## 3. Cross-domain — the same shape of question in other fields

The structure "implementation axis + UX axis" is not specific to software. The same shape of question shows up in other domains. Sharing **the form of the question, not the answer**, makes visible that this catalyst is dealing with an abstract design problem.

### Domain 1 — Engine control map design

When you weave the conditions for a limiter into a control map, the implementation embeds the physical behavior of "constrain output under specific operating conditions." This is the implementation-axis translation.

But how does the rider / driver experience the existence of that limit? Warning lights, the feel of torque change, instrument display — these are the UX-axis translation. Even if the limiter physically activates, if the rider does not know "what just happened," they may misjudge the next operation.

Question: When designing the control law, was the feedback design on the driver's side treated at the same priority?

### Domain 2 — Legal / compliance audit trails

The concept "tamper-evident audit trail" is translated, on the implementation side, into "append-only logs," "hash chains," "external timestamp signatures." This is the implementation-axis translation.

On the UX axis? How do stakeholders (auditors, parties, third parties) confirm tamper-evidence? Viewer UI, means of verification, feedback when tampering is detected — only when these are present does tamper-evidence carry legal meaning.

Question: With the physical guarantee of the trail alone, can stakeholders feel secure? Was the UX of the verification means treated as a separate axis?

### Domain 3 — Hallucination suppression in AI models

Suppression of hallucination (false generation) is translated, on the implementation side, into "grounded generation via RAG," "post-hoc verifier model checks," "output gating by confidence score." This is the implementation-axis translation.

On the UX axis? How does the user judge "how trustworthy is this output?" Confidence display, source citations, explicit uncertainty — these are the UX-axis translation. Even when suppression is effective in the implementation, if the user has no material to judge with, they will either distrust the AI as a whole, or trust it too much.

Question: Is the physical guarantee of statistical suppression connected to a path through which the user can judge confidence?

### Domain 4 — Smart contract safety

Reentrancy protection is translated, on the implementation side, into "checks-effects-interactions pattern" or "non-reentrancy locks." This is the implementation-axis translation.

On the UX axis? When an attack is attempted and rejected, does that information reach the people observing transactions? Is a rejected transaction recorded merely as a generic failure, or is it distinguishable as "an attack was attempted and prevented"? — this is the UX axis (observability axis) translation.

Question: Does the fact of physical defense have a path through which an observer can recognize that it was being defended?

---

## 4. When you decide it does not apply

The freedom to decide "this does not apply here" is always present.

But when you do, leave a reason at a granularity that makes the inviter say "fair enough."

Coming up with a reason to decline an invitation is tedious. That is intentional design — making the cost of declining heavier than the cost of accepting, to erase structurally the configuration "declining is the easy path." This consists of two layers, **Symmetric-Cost Design** and **Decline-Friction Design** (see `~/.claude/skills/catalysts/README.md` §3-1 / §3-2).

If, after that, you still decide it does not apply — that is a legitimate judgment. Something like "this task only handles internal data integrity and does not have a path that reaches the user surface" or "the UX-axis translation has already been completed in a separate task" — a one-liner that your future self can read and nod at. That is enough.

What you should avoid is "I'll just say it does not apply because it's tedious."

---

## 5. When this catalyst fires

This catalyst is intended to fire in situations such as:

- UI-related coding
- Tasks that involve concept redefinition (changing the meaning of a term, introducing a new invariant, etc.)
- Designing in a new domain (when bringing in a concept the existing system does not have)
- Tasks where you need to ask "can the user actually experience this?"

Whether it actually fires is left to the reader's judgment. "Implementation-axis translation is all that's needed" is not always true; "dual-axis is mandatory" is not always true either. The catalyst supplies the material for judgment — it does not make the judgment for you.

---

## → Related

- For the design philosophy of catalyst skills in general: `~/.claude/skills/catalysts/README.md`
- Related catalysts: `field-lifecycle-thinking` (connects with UX visualization at the field-addition stage)
