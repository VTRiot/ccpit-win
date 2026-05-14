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

**Two-tier structure: dev log + canonical report** (canonized in PIKES r1.2 §11-3-1):
- Upstream doc repo (e.g. PIKES Family): **canonical report** (judgment-centric: design decisions, rumination, proposals). Readers: design AI / human decision-maker
- Working repo (e.g. CCDG2): **dev log** (fact-centric: diffs, commit unit). Readers: next-session CC / future maintainers
- When in doubt, write both (cross-navigate to maintain integrity)

## Readers and Purpose of This Report (required, PIKES r1.2 §9-1-1)

The report MUST start with the following section right after the frontmatter:

```markdown
## Readers and Purpose of This Report

- **Who reads it**: <primary audience, in order of priority if multiple>
- **For what purpose**: <information the reader should obtain, why they should read it>
- **Next action**: <action expected from the reader after finishing the report>
```

Also recommended in frontmatter (machine-readable, optional in PIKES r1.2 §9-1):
```yaml
audience: [raio | juiz | cc-next | cc-self | raiko | public]
purpose: <one-line summary>
expected_action: <one-line summary>
```

Skipping this section with "N/A" is forbidden. If the reader is unclear, revisit the design.

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
