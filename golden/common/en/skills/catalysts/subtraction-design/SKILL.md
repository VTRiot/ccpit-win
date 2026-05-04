---
name: subtraction-design
description: Fires when comparing multiple design options in parallel, when choosing a design that adds feature X, or when making an architecture choice — to ask "before adding, can it be made unnecessary?" as a catalyst.
---

# Subtraction Design — An Invitation to Consider Making It Unnecessary

> This skill is not a directive. No "always subtract." No "don't add."
> Before you "add" a feature, this is a place where you may pause
> and ask whether **the feature itself can be made unnecessary**
> by a different design decision.
> Subtraction is not always the right answer. This skill places
> a **question**, not a conclusion.

---

## 0. What this is

In the middle of design, you frequently land on the judgment "if we add feature X, this problem is solved." This is correct in many situations — adding features is a natural means of problem solving.

But the judgment to add a feature tends to **skip the premise check**. The premise itself — "feature X is necessary" — may be overturnable by a different design decision. Yet "let's add X" becomes the default path before that possibility is examined.

A pattern observed in past refactors: work began with the plan to add a feature, but a review of the design revealed that a different architectural choice made that feature itself unnecessary. **Implementing a feature that could be made unnecessary becomes over-implementation.** The codebase carries permanent dead weight.

This skill is a catalyst that structurally prevents that omission of the premise check.

At the same time, this skill **does not say "subtraction is always correct."** When the feature should remain, it should remain. This is not a skill that forces a decision; it is a skill that, before you make the decision, gives you a place to pause.

---

## 1. Why this question lives at the meta-layer

The judgment "let's add feature X" arises out of the natural progression of the task in front of you. The syllogism "I observed problem P → solving P requires X → add X" solves the problem efficiently.

But this syllogism **does not question its premises**:

- Is problem P actually observed? Or is it a hypothetical problem?
- Is "solving P requires X" a conclusion drawn after excluding other design options?
- Are there means other than X by which P could be eliminated?

Raising these questions looks like a detour from the efficiency standpoint. "There is X right in front of me as a solution — why question the premise?" That is the feeling. So the questioning is usually skipped.

```
🌱 Where the skipping happens
├─ Problem P was observed
├─ Solution X came to mind
├─ If we implement X, P disappears
├─ Questioning the premise feels "slow," "inefficient"
└─ → X gets implemented. The "paths other than X" disappear from memory before being examined
```

Time passes. In the course of another refactor, you realize "X was unnecessary." Or, "if we had made architectural choice Y instead of X, X itself would have been unnecessary." But by then X has put down roots in the codebase, and the cost of removing it has surpassed the cost of keeping it.

This catalyst offers a place to pause before that "skipping" happens.

---

## 2. The questions

There is no obligation to answer the following in order. Considering only the questions that are relevant, depending on the nature of the task, is a legitimate judgment.

### Question 1 — Before adding this feature, can it be made unnecessary by a different design decision?

Before the judgment "add X," is there a possibility that a different architectural choice / data structure / responsibility split could make X itself unnecessary?

*This is a "free-association" question. You don't need to have a concrete alternative in hand.*
*Just asking "if I were not to add X, is there another path?" can widen the field of view.*
*If the answer is "no," that strengthens the legitimacy of the judgment to add X.*
*If the answer is "maybe yes," that one candidate is worth examining, even if briefly.*

### Question 2 — Is the premise "feature X is necessary" itself correct?

Re-inspect the chain of reasoning from problem P to feature X.

*The proposition "solving P requires X" is often inherited unconsciously from "the memory of having adopted X for a similar past problem."*
*Whether P is actually observed, whether the observed P is the essential problem, whether means other than X exist for solving P — checking these in order makes the strength of the chain visible.*
*When the chain is weak, spending time on redefining P, before adding X, is sometimes the more efficient move.*

### Question 3 — Could a different architectural choice make X itself unnecessary?

This is a concretization of Question 1. Think at the architecture layer.

*Example: Against "add a cache to speed it up," there is the alternative "change the data structure so the complexity drops and the cache itself is unnecessary."*
*Example: Against "add a field to store a setting," there is the alternative "derive the setting from a formula."*
*Example: Against "add a logging feature," there is the alternative "derive it from existing state history."*
*When you think at the architecture layer, "make the feature unnecessary" sometimes appears in place of "add the feature."*

### Question 4 — If it can be made unnecessary, what is the price?

This is the lifeblood of this catalyst. **Subtraction is not always correct.**

*The price of choosing subtraction:*
*- Cost of switching to a different architecture (impact range on existing code)*
*- Cost of learning the different architecture (can the team understand it?)*
*- Future-proofness of the different architecture (extensibility, resilience to external requirements)*
*Evaluate these prices, then judge between "make it unnecessary" and "add it."*
*If subtraction is high cost, the judgment to add is correct. This catalyst supports the choice "add" arrived at after that judgment.*
*What this catalyst wants to prevent is only this: choosing "add" without comparing to "make it unnecessary."*

---

## 3. Cross-domain — the same shape of question in other fields

The structure "before adding, consider making it unnecessary" is not specific to software.

### Domain 1 — Extending an engine control map

Output error appears under specific operating conditions. Against this:

- **Add proposal**: Extend the correction table by adding a correction value dedicated to those operating conditions
- **Subtract proposal**: Revise the control law itself so that the error does not appear under those operating conditions

Question: Extending the correction table risks bloating the table and complicating future maintenance. Revising the control law has a high upfront cost, but the necessity of the correction itself may disappear. Which do you choose?

Price evaluation: Revising the control law requires retesting the entire ECU and impacts the release schedule. Extending the correction table is local and safe, but interactions among correction values become a future problem. "Subtraction is always correct" is not the position.

### Domain 2 — Post-processing in an ML model

The model output exhibits a specific bias. Against this:

- **Add proposal**: Add a post-processing heuristic to correct the bias
- **Subtract proposal**: Fix the training data, or retrain the model itself

Question: Post-processing heuristics solve the problem immediately, but the bias in the model itself remains. As post-processing accumulates, system readability degrades. Fixing training data takes time and offers no convergence guarantee. Which do you choose?

Price evaluation: Short-term, post-processing is rational; long-term, fixing the training data is rational. The decision depends on the task's lifespan and the operational cost forecast.

### Domain 3 — Adding a clause to a contract

Contract interpretation is ambiguous under a particular trade pattern. Against this:

- **Add proposal**: Add an exception clause to handle that trade pattern explicitly
- **Subtract proposal**: Redesign the main clauses so that a general rule no longer requires an exception

Question: Exception clauses are clear in the short term, but as exceptions pile up, the integrity of the contract as a whole degrades. Redesigning main clauses has a wide impact, but may erase the necessity of the exception itself.

Price evaluation: Redesigning the main clauses comes with effects on existing contracts. Adding an exception clause is local, but risks producing exceptions to exceptions later. "Always rework the main clauses" is not the position.

### Domain 4 — Adding a guard function to a smart contract

An unintended attack path is found in a state transition. Against this:

- **Add proposal**: Add a guard function (require / modifier) to physically block the attack path
- **Subtract proposal**: Simplify the state model so the attack path itself does not arise

Question: Guard function additions block attacks immediately, but as guards accumulate, contract readability degrades and interactions among guards become a new attack surface. Simplifying the state model entails redeployment cost and migration.

Price evaluation: For an already-deployed contract, subtraction is high-cost. In the design phase, subtraction is a strong candidate. Post-deployment, in operation, adding is the realistic choice. The judgment depends on the lifecycle stage.

---

## 4. When you decide it does not apply

The freedom to decide "this does not apply here" is always present.

But when you do, leave a reason at a granularity that makes the inviter say "fair enough."

Coming up with a reason to decline an invitation is tedious. That is intentional design — making the cost of declining heavier than the cost of accepting, to erase structurally the configuration "declining is the easy path." This consists of two layers, **Symmetric-Cost Design** and **Decline-Friction Design** (see `~/.claude/skills/catalysts/README.md` §3-1 / §3-2).

The fact that this catalyst explicitly lists "no time to consider elimination" as a NG case is itself an implementation of **Decline-Friction Design** — preventing "skipping past in the name of efficiency" from disguising itself as "this does not apply."

Examples of legitimate "does not apply" decisions for this catalyst:

- "This task has feature X locked in by external requirements; even if subtraction were considered, it would not be adopted"
- "The architecture layer is already fixed; the scope of this task is local modifications only"
- "This is not the phase where multiple options are compared in parallel — it is the phase where a chosen decision is implemented"

Such clear scope restrictions are legitimate reasons to decline. On the other hand:

- "I don't have time to consider subtraction" → That is skipping past in the name of efficiency. The very structure this catalyst tries to prevent.
- "Adding is the normal thing to do" → It looks like following a norm, but in fact it skips the premise check.

What you should avoid is "I'll just say it does not apply because it's tedious."

---

## 5. When this catalyst fires

This catalyst is intended to fire in situations such as:

- When comparing multiple design options in parallel
- When choosing a design that "adds feature X"
- Tasks where the question "is this feature really necessary?" needs to be raised
- Design involving architecture choices

Whether it actually fires is left to the reader's judgment. Not every feature addition triggers this catalyst. In situations where a feature is clearly necessary, the catalyst can pass through quickly with a "does not apply" verdict (but record the reason for the verdict).

---

## → Related

- For the design philosophy of catalyst skills in general: `~/.claude/skills/catalysts/README.md`
- Related catalysts: `field-lifecycle-thinking` (connects with the consideration of making fields unnecessary before adding them), `dual-axis-translation` (connects with comparing implementation-axis additions vs. UX-axis additions)
