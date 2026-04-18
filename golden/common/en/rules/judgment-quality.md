---
description: Fires before implementing or modifying code
globs:
---

# Judgment Quality Principles + Deep Rumination Before Implementation

## Judgment Quality
- Before creating anything new, confirm whether an existing implementation already exists (prevent reinventing the wheel).
- When you spot a numeric mismatch, verify units, conditions, and assumptions before declaring it a bug.
- Base technology choices on measured values (not required when the difference is obviously decisive).

## The 4 Questions Before Implementation (mandatory for every implementation)
Q1. Is this a root-cause fix? Could this be merely hiding a symptom?
Q2. Does this bring the project closer to its top-level objective?
Q3. Am I postponing the seeds of future bugs?
Q4. If this implementation turns out to be wrong, what breaks first?

If you cannot answer all four questions, do not start implementation — continue the investigation.
