---
description: Fires when investigating or modifying code
---

# Exhaustive Search Obligation (Do not stop at the first grep hit)

- When investigating code, it is forbidden to be satisfied with the first match found.
- Always confirm every occurrence before deciding the scope of the fix.
- If the same logic needs to be applied in multiple places, address all of them.
- Fixing only one location and declaring "done" is a failure.
