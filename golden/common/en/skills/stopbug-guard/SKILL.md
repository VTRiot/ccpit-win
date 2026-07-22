---
name: stopbug-guard
description: Discipline for preventing the stop bug (malformed tool call -> self-priming). Fires when the stopbug-observe hook emits a trip-wire (migration advice) or the time-based timer (calibration prompt), or as a minimal focus-check right before heavy processing.
---

# stopbug-guard — stop-bug prevention discipline

## When it fires
- When the `stopbug-observe` Stop hook emits a **migration advice** (a malformed output was observed in this session).
- When the Stop hook emits a **calibration prompt** (observation data reached the collection period).
- As a minimal focus-check right **before** heavy processing (multi-file edits, long generation).

## Rationale (why)
A malformed tool call stays in the history as an "example" and pulls subsequent output toward
repeating it (self-priming). The true root fix — constrained decoding at the serving layer — is
only available on the Anthropic side. At this layer the strongest and cheapest lever is to
**cut the polluted context early = migrate the session**. The reminder is only a weak auxiliary.
Machine observation is done by the hook, the recovery discipline by [[priming-loop-recovery]],
and the migration path by [[cc-state-declaration]]. This skill only holds the steps that connect them.

## Procedure A — on a migration advice (trip-wire)
1. This is a safe stopping point. **Do not start additional heavy work.**
2. Write a clean handoff note (purpose / done / next action only).
   - **Never quote the malformed output** (avoid re-priming).
3. Exit with `/exit` and resume with `claude --resume <session-id>` ([[cc-state-declaration]]).
   - A fresh session is the most reliable. `/clear` plus the handoff note also works.
4. After migrating, resume work from the handoff note.

## Procedure B — on a calibration prompt (time-based timer)
1. Outside the conversation, run `python ~/.claude/hooks/stopbug-calibrate.py`.
2. Check the malformed base rate and the conditional rate (chance of more malformed after the first).
3. If enabling the trip-wire (Phase 2) is warranted, set `TRIPWIRE_ENABLED` to true in
   `~/.ccpit/.stopbug-config.json` (no settings change needed, only the config file).

## Procedure C — right before heavy processing (minimal, weak auxiliary)
- Tighten focus in one line: "emit tool calls now in the correct format, one at a time."
- Do not lecture yourself further (do not bloat context). The real lever is migration in Procedure A.

## Prohibited
- Do not reproduce tool-call syntax (`invoke` / `parameter` / `function_calls`) in hook reasons or notes.
- Do not add a fancy predictor "to be smarter." The lever is migration.

## References
- [[priming-loop-recovery]] — recovery protocol for consecutive malformed output (the parent discipline).
- [[cc-state-declaration]] — self-restart / migration path at a safe stopping point.
- Observation core: `~/.claude/hooks/stopbug-observe.py`, calibration: `stopbug-calibrate.py`.
