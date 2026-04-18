---
name: report
description: Fires when producing a report or completion notice. Generates a report that includes the interlock verification section.
---

# Report Output Skill

## Trigger
Fires at task completion, at interruption, or when the human asks "report it."

## Where the Report Goes
The report for the design AI is written as an MD file.
In-conversation text does not count as "outputting a report."

## Interlock Verification Section (required)
Include the following checklist in the report:

```
## Interlock Verification
- rumination: fired / not fired (reason: )
- testable-impl: fired / not fired (reason: )
- investigation: fired / not fired (reason: )
```

If any "not fired" entry lacks a justified reason, stop the report and re-fire the missing skill.

## Knowledge Accumulation Proposal (mandatory consideration)
Include the following in the report. Evaluate candidates; if none are needed, state why. Skipping this section with "N/A" is forbidden.

```
## Local Knowledge Proposal
- Candidates: (Is there any knowledge worth storing in rules/ or skills/?)
- Decision: adopt / not needed (reason: )
```
