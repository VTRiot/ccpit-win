---
description: For CCPIT bulk-restart delegate path: clarify State and self-restart when a restart-request flag is detected
---

# CC State Declaration and Self-Restart

Settings changes (settings/hooks/skills/plugins) are snapshotted at startup and are NOT applied to a
running session. CCPIT restarts all CC sessions on a node to guarantee they take effect. Each CC follows:

- At turn end, keep your State (busy / waiting / idle, and the waiting reason if waiting) consistent
  with the CC runtime session state. State is the basis for CCPIT's restart-safety decision.
- When CCPIT's **restart-request flag** is detected (by `restart-request-gate`), this is a safe
  completion point. Leave a clean handover note (goal, done, next action only; never quote malformed
  output), then `/exit` once and restart with `claude --resume <sessionId>` to apply the new settings.
- A task force-killed mid-run cannot restore its in-flight state. That is why the delegate path —
  where the CC restarts itself at a safe completion point — is preferred over external kill.
