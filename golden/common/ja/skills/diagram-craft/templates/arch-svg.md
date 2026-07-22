# 雛形: 構成図 SVG（arch-svg）

用途: 境界・責務・外部依存が主役で、mermaid では表せない配置を示す時。
規則: 主役要素 3〜5 個 / 色 4 種以内（palette.md の意味色のみ）/ ラベル 18 字以内 / 図の直前に結論 1 文。
SVG はレンダラが base64 data URI の <img> に変換する（script 無害化・静的画像）。

書き方（コピーして書き換える。viewBox と座標は内容に合わせ調整）:

````text
本体と外部サービスの境界は API 層の 1 点のみ。

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="460" height="120">
<rect x="0" y="0" width="460" height="120" fill="#1A2230" stroke="#2A3242"/>
<rect x="16" y="30" width="160" height="56" rx="6" fill="#1F2937" stroke="#64748B"/>
<text x="46" y="62" font-size="14" fill="#E5E7EB">アプリ本体</text>
<rect x="200" y="30" width="100" height="56" rx="6" fill="#0F766E" stroke="#5EEAD4"/>
<text x="218" y="62" font-size="14" fill="#F8FAFC">API 層</text>
<rect x="324" y="30" width="120" height="56" rx="6" fill="#1E1B4B" stroke="#A5B4FC"/>
<text x="344" y="62" font-size="14" fill="#EEF2FF">外部サービス</text>
<line x1="176" y1="58" x2="200" y2="58" stroke="#94A3B8" stroke-width="2"/>
<line x1="300" y1="58" x2="324" y2="58" stroke="#94A3B8" stroke-width="2"/>
</svg>
```
````

frontmatter 宣言: `figures: [arch-svg]`
