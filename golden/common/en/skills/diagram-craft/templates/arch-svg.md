# Template: architecture SVG (arch-svg)

Use: when boundaries, responsibilities, and external dependencies are the subject and mermaid cannot express the layout.
Rules: 3–5 main elements / ≤4 colors (semantic palette only) / labels ≤18 chars / one-sentence conclusion right before the figure.
The renderer converts SVG into a base64 data-URI <img> (scripts neutralized, static image).

How to write (copy and adapt; adjust viewBox and coordinates):

````text
The app and the external service touch at exactly one point: the API layer.

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="460" height="120">
<rect x="0" y="0" width="460" height="120" fill="#1A2230" stroke="#2A3242"/>
<rect x="16" y="30" width="160" height="56" rx="6" fill="#1F2937" stroke="#64748B"/>
<text x="52" y="62" font-size="14" fill="#E5E7EB">App core</text>
<rect x="200" y="30" width="100" height="56" rx="6" fill="#0F766E" stroke="#5EEAD4"/>
<text x="218" y="62" font-size="14" fill="#F8FAFC">API layer</text>
<rect x="324" y="30" width="120" height="56" rx="6" fill="#1E1B4B" stroke="#A5B4FC"/>
<text x="334" y="62" font-size="14" fill="#EEF2FF">External svc</text>
<line x1="176" y1="58" x2="200" y2="58" stroke="#94A3B8" stroke-width="2"/>
<line x1="300" y1="58" x2="324" y2="58" stroke="#94A3B8" stroke-width="2"/>
</svg>
```
````

Frontmatter declaration: `figures: [arch-svg]`
