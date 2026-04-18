---
name: investigation
description: Fires when investigating root causes or bugs. Performs exhaustive code-path enumeration and counter-evidence checking.
---

# Investigation Skill

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
