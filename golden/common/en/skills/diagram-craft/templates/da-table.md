# Template: DA table (da-table)

Use: when stating a judgment/recommendation/rejection over 2+ options.
Rules: 2–5 options × 3–6 axes / score granularity fixed at 1–5 or 1–10 / one-sentence conclusion right before the table.
Numeric columns get proportional bars + the value gradient (cyan=low, magenta=high; meaning-neutral) automatically.

How to write (copy and adapt):

```text
Option B has the highest total score (recommended).

| Option | Cost efficiency | Maintainability | Total |
|---|---|---|---|
| A | 3 | 4 | 7 |
| B | 5 | 4 | 9 |
| C | 2 | 2 | 4 |

> [!DA] Recommend option B (one-sentence reason)
```

**Axis direction**: when you have discretion over an axis, align it so that higher = positive,
as long as no distortion is involved (e.g. "cost" → "cost efficiency" when natural).
Forced reciprocals, unnatural indicators, and data manipulation are forbidden.
Axes that are naturally "lower is better" stay as-is (color shows position only; goodness is read from the header and numbers).
See the report skill's "Evaluation Axis Direction Rule" for details.

Frontmatter declaration: `figures: [da-table]`
