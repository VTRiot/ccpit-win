# Template: current-location tree (where-map)

Use: show "you are here" within the system when impact spans 3+ areas.
Rules: ≤7 nodes / exactly 1 highlighted current node / labels ≤18 chars / one-sentence conclusion right before the figure.

How to write (copy and adapt):

````text
The target is feature Y in module X (green below).

```mermaid
graph TD
  SYS[Whole system] --> A[Module A]
  SYS --> B[Module B]
  A --> A1[Feature A1]
  A --> A2[Feature A2 target]
  classDef current fill:#0F766E,stroke:#5EEAD4,color:#F8FAFC
  class A2 current
```
````

Frontmatter declaration: `figures: [where-map]`
