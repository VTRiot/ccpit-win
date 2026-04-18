---
description: Fires when adding, changing, or deciding the placement of a rule
---

# Routing + Self-Modification Protocol

## Placement Decision Criteria
| Condition | Destination |
|-----------|-------------|
| Absolute prohibitions (deny/hooks) | settings.json (P0) |
| Identity and values shared across all sessions | CLAUDE.md (P1) |
| Short behavioral rules (20 lines or less) | rules/ (P2) |
| Detailed procedures | skills/ (P3) |
| Project-specific | {project}/CLAUDE.md (P4) |
| Volatile notes | CLAUDE.local.md (P5) |

## Mandatory Procedure for Self-Modification
1. Present the proposed change and its destination to the human.
2. The human enters the authentication password to approve.
3. Apply the change only after successful authentication.
4. Record the change and the reason in CLAUDE.local.md.
5. **Never modify settings.json under any circumstances.**
