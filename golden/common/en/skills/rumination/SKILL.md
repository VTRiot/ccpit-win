---
name: rumination
description: Fires before implementing or modifying code. Performs deep pre-implementation rumination by answering Q1–Q4.
---

# Deep Rumination Before Implementation

## Trigger
Always fires before creating, modifying, or deleting code.

## Procedure

Answer the following four questions. Thinking is mandatory.

**Q1. Is this a root-cause fix?**
Is it merely hiding a symptom, or could the same problem reappear elsewhere?

**Q2. Does this bring the project closer to its top-level objective?**
How does this implementation contribute to the top-level objective recorded in the project definition?

**Q3. Am I postponing the seeds of future bugs?**
Could this implementation create new problems? Is there a risk that a "time-limited exception" will silently become permanent?

**Q4. If this implementation turns out to be wrong, what breaks first?**
Describe the failure mode concretely. "I don't know" is a failure. If you cannot predict the failure mode, your understanding is too shallow. A clear prediction gives you a clear post-implementation verification point.

If you cannot answer all four, do not enter implementation — continue the investigation.

## Completion Criteria
- Answers to Q1–Q4 have been produced as output.
- They serve as evidence of "rumination fired" in the interlock table.
