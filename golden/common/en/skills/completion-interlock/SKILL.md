---
name: completion-interlock
description: Fires right before declaring a code-changing task "complete". Final gate that verifies the presence and quality of all artifacts.
---

# Termination Interlock

## Trigger
Fires right before declaring a code-changing task "complete".
Functions as the final gate immediately after testable-impl Step E.

## Checklist

Before declaring a code-changing task complete, verify ALL of the following.
If even one is missing, do NOT declare completion.

| Artifact | Verification |
|----------|--------------|
| Report MD file | File exists directly under `_Prompt\02_buildai\` (legacy `_Prompt\01_FromBuilderAi\` also accepted) |
| **"Readers and Purpose of This Report" section** | Explicitly stated at the top of the report MD, right after the frontmatter (PIKES r1.2 §9-1-1) |
| **frontmatter `audience` / `purpose` / `expected_action`** | Provisionally written in the report MD frontmatter (PIKES r1.2 §9-1, optional) |
| Before / After measured values | Written inside the report MD (not in-conversation text) |
| Every concrete completion criterion | Verified inside the report MD with measured values |
| **Two-tier structure: dev log + canonical report** | Where applicable: both the dev log in the working repo and the canonical report in the upstream doc repo are placed (PIKES r1.2 §11-3-1) |

## Failure Conditions

- No report MD exists, or only exists under the `_Research/` subdirectory
- Before / After only in in-conversation text, not written to the report MD
- Some completion criteria are only confirmed with subjective phrasing ("confirmed") with no measured values
- Issues are downplayed with subjective phrasing such as "no real harm"

## Exception

Changes that do not affect logic (comment fixes, typo fixes, whitespace adjustments, etc.) are out of scope for this interlock.
When in doubt, treat the change as in scope.

## Relationship with hooks/report-gate

This skill is CC's self-verification (checks content quality).
hooks/report-gate is external verification (mechanically checks only the existence of the report MD).
The two are independent dual-layer defenses; neither alone is sufficient.
