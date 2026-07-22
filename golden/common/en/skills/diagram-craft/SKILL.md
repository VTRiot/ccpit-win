---
name: diagram-craft
description: Fires when deciding whether a report or explanatory document needs figures, when designing a figure, or when writing the figures declaration in frontmatter. Designs cognitive-load-reducing figures via the trigger table, quantitative limits, and templates
---

# Diagram Craft Skill

A figure is a tool that **reduces** information, not decoration that adds it. One figure, one message.
The sole purpose of a figure is to minimize where the reader must look to make a decision.

## Trigger
- When starting to write a report or explanatory document (always fire once for the figure plan)
- When writing the `figures:` declaration in frontmatter
- When writing any mermaid / SVG / DA table

## §1 Figure Plan (before writing — required)

**Before** writing the body, consult the trigger table (§2), decide the figures, and declare them in frontmatter:

```yaml
figures: [da-table, where-map]   # kinds: da-table / where-map / flow / state / arch-svg
# When using no figures (figures_reason example: no option comparison; single-module impact):
figures: none
figures_reason: <one-line reason>
```

Silently omitting figures is forbidden. Omission costs one line of reason (negative declaration).
`md2html.cjs --lint` machine-checks declaration-reality match **in both directions**: a declared kind with no body counterpart, and an undeclared body mermaid/svg figure (including under `none`), both block with exit 1. Numeric tables only warn (bars auto-render on any numeric column).

## §2 Figure Trigger Table (Visual Decision Guide)

| Situation | Recommended figure | Use when | Don't use when |
|---|---|---|---|
| Option comparison | DA table + proportional bars (`da-table`) | 2+ options and a decision is requested | Choice already made, no comparison needed |
| Current location / impact scope | mermaid tree + highlight (`where-map`) | Spans multiple modules/layers (3+ areas) | 1–2 changed files, simple |
| Procedure / processing order | mermaid flowchart LR (`flow`) | 3+ steps or branching | 2 or fewer sequential steps |
| State transitions | mermaid stateDiagram (`state`) | 3+ states with retry/failure/rollback | Plain success/failure only |
| System structure | SVG (`arch-svg`) | Boundaries, responsibilities, external deps are the subject | mermaid suffices |
| Root-cause analysis | mermaid graph TD (`flow`) | Causes branch or form a hierarchy | Single cause |
| Diffs / file lists | No figure (text) | — | A figure becomes a degraded copy of the source |

**Selection priority**: ① comparison→da-table ② states→state ③ procedure/deps→flow ④ boundaries/layout→arch-svg ⑤ none of these→no figure (state the reason).

## §3 Design Rules (quantitative limits)

- **One figure, one message**: write the figure's conclusion in one sentence right before it; the figure exists only to make that sentence faster to grasp
- **Limits**: flowchart/graph: ≤7 nodes (max 10), ≤3 branches, ≤4 levels deep / stateDiagram: ≤6 states, ≤8 transitions / SVG: 3–5 main elements, ≤4 color categories / DA table: 2–5 options × 3–6 axes, score granularity fixed at 1–5 or 1–10
- **Labels**: noun phrases or short verb phrases, ~12 chars (max 18). Edge labels only for branch conditions. No explanatory prose inside figures (prose belongs in the body)
- **Direction**: time/procedure = left→right (LR); hierarchy/causes = top→down (TD). Comparison uses tables + bars, not diagrams
- **One emphasis per figure** (current location, recommendation, or risk)
- **Pruning procedure**: keep only elements the one-sentence conclusion needs → drop what the reader already knows → bundle same-kind elements → split into overview + detail if >8 nodes → delete the figure if the body alone suffices

## §4 Colors

Use only the fixed palette in `templates/palette.md` (dark theme, deterministic).
**Strict role separation**: semantic colors (recommendation/risk = state meaning) vs. the DA bar value gradient (position of magnitude only = meaning-neutral). Never mix the two.

## §5 Templates (copy & adapt)

| File | Kind |
|---|---|
| `templates/palette.md` | Semantic palette + classDef snippets + bar gradient spec |
| `templates/where-map.md` | Current-location tree |
| `templates/da-table.md` | DA table (with axis-direction rule pointer) |
| `templates/flow.md` | Procedure flow |
| `templates/state.md` | State transitions |
| `templates/arch-svg.md` | Architecture SVG skeleton |

## §6 Figure Checklist (10 items)

1. Does the report contain comparison / current location / procedure / state transitions / structural boundaries? If none, no figure is needed
2. If 2+ options and a judgment/recommendation/rejection is stated, place a DA table + bars
3. If impact spans 3+ areas, place a current-location or impact-scope figure
4. For states, retries, failures, rollback: use stateDiagram or a transition table, not flowchart
5. Write the figure's one-sentence conclusion before the figure
6. ≤7 nodes as a rule (max 10); labels ≤18 chars
7. No long prose inside figures; prose in the body, relations in the figure
8. Exactly one emphasized spot (color, border, weight)
9. Delete any figure that merely boxes up the body's bullet list; a figure whose removal doesn't slow the reader down is unnecessary
10. When omitting figures, state the reason via `figures: none` + `figures_reason:`

## §7 Failure Conditions

- Started writing a report without a figures declaration
- A declared figure kind has no body counterpart (`--lint` exit 1 left unresolved)
- A figure has 2+ emphasized spots / merely restates the body's bullets
- Used colors outside palette.md (breaks determinism and the semantic color system)
