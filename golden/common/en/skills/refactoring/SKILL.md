---
name: refactoring
description: Fires before changing code. Enforces the two-pass rumination obligation, including exhaustive enumeration of sibling code paths and validation of the proposed fix.
---

# Rumination Obligation (mandatory before code changes)

## Trigger
Fires before any change that modifies code.

## Rumination Pass 1: Exhaustive enumeration of sibling code paths
- Search for implementation sites of the same shape beyond the one you just found.
- Use grep / ripgrep / caller tracing / branch tracing to enumerate every place the same bug could hide.
- Confirm there is no "scorched-earth risk" where fixing only the first hit leaves the rest broken.

## Rumination Pass 2: Validity and side-effect evaluation of the proposed fix
- Review whether the change you are about to introduce is genuinely the best option.
- State what would break, and what side effects would emerge, if the fix is wrong.
- Compare against more upstream or safer alternatives instead of a local patch.

## Mandatory Reporting of Rumination Content
The report must include:

```
#### Rumination Pass 1
- First location found:
- Scope of sibling code-path search:
- Other candidates discovered:
- Locations related / unrelated to the current root cause:

#### Rumination Pass 2
- Alternatives considered but rejected:
- Alternative adopted:
- Reason for adoption:
- Side-effect assessment if the fix is wrong:
- Why this fix is judged best this time:
```

## Failure Conditions
- Fixing based only on the first grep hit.
- Claiming "root-cause fix" without checking similar locations.
- Changing code without evaluating side effects.
- Proceeding to the fix without writing the rumination content.
