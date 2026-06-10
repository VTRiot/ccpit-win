---
description: Fires when consecutive malformed tool calls or parse errors are detected
---

# Self-Output Priming Loop Recovery Protocol

Malformed output self-reinforces as a strong in-context example once it enters the history; respond by isolating the contamination, not by prevention alone.

## Detection signals (limited to consecutive failures of the same tool-call intent)
- No tool result returned, and only tool-call-like text remains in the message body
- Repeated highly similar output accompanied by malformed syntax or parse errors (mere work stagnation or repeated investigation is out of scope)

## Recovery procedure (count = consecutive malformed attempts of the same tool-call intent)
1. 1st time: retry the fix only once, with a short correction that does not re-quote the bad output
2. 2nd time: stop work. Self-report "session contaminated, reset recommended" and always attach a clean handoff memo
3. 3rd time and beyond: continuing in the same session is forbidden

## Priority of recovery means
New session (most reliable) > /clear + clean handoff memo > compaction (choose only when you can control
the summary content yourself; otherwise prefer a new session / /clear) > in-session self-correction (weakest, once only)

## Clean handoff memo
Record only the goal, completed items, and next action. Quoting malformed output is absolutely forbidden.
