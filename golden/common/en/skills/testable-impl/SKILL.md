---
name: testable-impl
description: Fires when performing an implementation that involves code changes. Enforces the testable implementation sequence (Step A–E), from pre-creating the report MD to final completion verification.
---

# Testable Implementation Sequence

## Trigger
Fires whenever code is being changed (except changes that do not affect logic, such as comment fixes, typo fixes, or whitespace adjustments). When in doubt, err on the side of firing.

## Procedure

### Step A: Self-derivation of concrete completion criteria
Derive measurable completion criteria (concrete) from the abstract completion criteria written in the design AI's instructions. Once derived, present them to the human and obtain approval before starting implementation.

### Step B: Pre-creation of the report MD file (gate)
Before touching any code, create the report MD file as an empty template.
Advancing to Step C without this file existing is prohibited.

Template:
```
# {Summary of content}
## Connection to the top-level objective
(fill in later)
## Concrete completion criteria
(copy the criteria derived in Step A)
## Changes
(fill in later)
## Result (Before / After)
(fill in later)
```

### Step C: Implementation
Change the code.

### Step D: Verify every item with measured values
Verify every item of the concrete completion criteria with measured values, not guesses.
Do not downplay issues with subjective phrasing like "no real harm."
"Confirmed" without numbers is treated as incomplete.

### Step E: Write to the report MD file
Write the results into the report MD file created in Step B.
Feeling like you "wrote the report" via in-conversation text is forbidden.

→ After Step E, you MUST fire the completion-interlock skill to run the termination check.
