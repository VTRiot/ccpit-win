# Figure Color Palette (dark theme, fixed, deterministic)

Background context: page #0F141E / card #1A2230 / line #2A3242 / text #E5E7EB

## 1. Semantic colors (express state meaning; used in classDef / SVG fills)

| Meaning | Fill | Stroke | Text |
|---|---|---|---|
| Normal node | #1F2937 | #64748B | #E5E7EB |
| Current / recommended | #0F766E | #5EEAD4 | #F8FAFC |
| Warning / risk | #7C2D12 | #FDBA74 | #FFF7ED |
| Rejected / stopped | #7F1D1D | #FCA5A5 | #FEF2F2 |
| Undecided / pending | #3B2F0B | #FACC15 | #FEFCE8 |
| External dependency | #1E1B4B | #A5B4FC | #EEF2FF |

mermaid classDef snippets (copy only the lines you need):

```text
classDef current fill:#0F766E,stroke:#5EEAD4,color:#F8FAFC
classDef risk fill:#7C2D12,stroke:#FDBA74,color:#FFF7ED
classDef rejected fill:#7F1D1D,stroke:#FCA5A5,color:#FEF2F2
classDef pending fill:#3B2F0B,stroke:#FACC15,color:#FEFCE8
classDef external fill:#1E1B4B,stroke:#A5B4FC,color:#EEF2FF
```

## 2. DA bar value gradient (meaning-neutral; applied automatically by the renderer — authors do nothing)

Numeric-column bars are auto-colored by the column-normalized value t=(v−colMin)/(colMax−colMin):
cyan #22D3EE (column min) → #06B6D4 → #10B981 → #FACC15 → #F472B6 → magenta #D946EF (column max).
End-emphasized (γ=2.0: mid values look alike; max/min stand out). The column-max cell gets a 3px right edge.

**These colors express only the position of magnitude — never good/bad.**
Bar length is the primary signal; color is auxiliary (color-vision consideration).

## 3. Role separation (strict)

- Semantic colors (§1) = state has meaning (recommended, risk, ...). The author paints them explicitly
- Bar gradient (§2) = magnitude position only, meaning-neutral. The renderer applies it; authors never paint it
- Mid-green #10B981 is a different tone from the recommendation teal #5EEAD4 (do not confuse)
- One emphasis color per figure. Never let red/green alone carry meaning. Never rely on color alone (combine border/weight/label)

## 4. Forbidden

- Colors outside this palette
- Leaving emphasis to mermaid defaults (even with theme:dark, emphasis without classDef is forbidden)
- High-saturation colors across large background areas
- Hand-reproducing bar colors to convey good/bad
