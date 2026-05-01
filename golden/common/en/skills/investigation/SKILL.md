---
name: investigation
description: Fires when investigating root causes or bugs. Performs exhaustive code-path enumeration and counter-evidence checking.
---

# Investigation Skill

## ⚠️ When Debugging

This skill is the **procedural discipline of investigation** (counter-evidence checks, exhaustive code-path enumeration, the no-guessing rule). It is NOT a symptom-indexed catalog of failure modes.

When you observe a bug, defect, or unexpected behavior, fire the **`debug-toolkit`** skill in parallel and look up the menu of known failure modes (FMs) by symptom.

But the `debug-toolkit` menu is also **not exhaustive**. When you encounter a symptom that is not on the menu, do **not** force-fit it to the closest FM (no heuristic over-fit). Build your own SST (Special Service Tool) when needed, and propose adding the technique to `debug-toolkit` in your completion report if it is generalizable.

## Trigger
Fires whenever you are investigating a root cause, debugging, or isolating a problem.

## Core Principles
- Keep the investigation phase and the implementation phase separate.
- Do not answer by guessing. Back every claim with runtime facts before reporting.
- Investigation results that end with "might be" or "should be" are failures.

## Exhaustive Code-Path Enumeration
1. Enumerate every related code path (finding one hit is the start of the investigation, not the end).
2. Identify the actual execution path (confirm with debug logs, import chains, or runtime evidence).
3. Compare the state of every path in a table.

## Counter-Evidence Check (mandatory before reporting a conclusion)
Actively search for evidence that disproves your own conclusion.

```
## Counter-evidence check
- [ ] Is there another code path with the same functionality?
- [ ] Did you back up the conclusion with runtime logs?
- [ ] If this conclusion is wrong, what is the real cause? (at least one alternative hypothesis)
- [ ] Are there past cases where the initial conclusion was wrong?
```

## Investigation Summary (required output)
```
=== Investigation Summary ===
- Cause:
- Scope of impact:
- Fix strategy:
```
