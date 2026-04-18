---
description: Fires when about to write a numeric literal in code
globs: "*.py,*.js,*.ts,*.c,*.cpp,*.rs"
---

# Magic Number Ban

- Thresholds, ratios, timeout values, and project-specific constants must not be hard-coded inline.
- Load them from configuration files or constant definitions.
- When a value can be derived from existing constants or formulas, use the formula.
- Only true constants (e.g. physical lower bounds) may be hard-coded, and the reason must be written in a comment.
