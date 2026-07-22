# 図配色パレット（ダークテーマ固定・決定論）

背景前提: ページ #0F141E / カード #1A2230 / 罫線 #2A3242 / 本文 #E5E7EB

## 1. 意味色（状態の意味を示す。図の classDef / SVG 塗りに使用）

| 意味 | 塗り | 枠線 | 文字 |
|---|---|---|---|
| 通常ノード | #1F2937 | #64748B | #E5E7EB |
| 現在地・推奨 | #0F766E | #5EEAD4 | #F8FAFC |
| 警告・リスク | #7C2D12 | #FDBA74 | #FFF7ED |
| 却下・停止 | #7F1D1D | #FCA5A5 | #FEF2F2 |
| 未確定・保留 | #3B2F0B | #FACC15 | #FEFCE8 |
| 外部依存 | #1E1B4B | #A5B4FC | #EEF2FF |

mermaid classDef 雛形（必要な行だけコピー）:

```text
classDef current fill:#0F766E,stroke:#5EEAD4,color:#F8FAFC
classDef risk fill:#7C2D12,stroke:#FDBA74,color:#FFF7ED
classDef rejected fill:#7F1D1D,stroke:#FCA5A5,color:#FEF2F2
classDef pending fill:#3B2F0B,stroke:#FACC15,color:#FEFCE8
classDef external fill:#1E1B4B,stroke:#A5B4FC,color:#EEF2FF
```

## 2. DA バーの値依存グラデ（意味中立。レンダラが自動付与 — 執筆者は何もしない）

表の数値列バーは、列内正規化値 t=(値−列min)/(列max−列min) で自動着色される:
シアン #22D3EE（列最低）→ #06B6D4 → #10B981 → #FACC15 → #F472B6 → マゼンタ #D946EF（列最高）。
両端強調（γ=2.0: 中間値同士は似た色、最大・最低が際立つ）。列最大セルは右エッジ 3px。

**この色は「値の大小位置」のみを示し、良し悪しの意味を持たない**。
長さ（バー幅）が主シグナル・色は補助（色覚配慮）。

## 3. 役割区別（厳守）

- 意味色（§1）= 状態に意味がある（推奨・リスク等）。執筆者が図に明示的に塗る
- バーグラデ（§2）= 値の位置のみ・意味中立。レンダラが自動付与し、執筆者は塗らない
- 中間グリーン #10B981 は推奨ティール #5EEAD4 と別トーン（混同しない）
- 1 図の強調色は 1 色。赤緑のみで判断させない。色だけに意味を持たせない（枠線・太さ・ラベル併用）

## 4. 禁則

- 上記パレット外の色を使う
- mermaid のデフォルト配色に任せる（theme:dark でも classDef なしの強調は禁止）
- 彩度の高い色を背景全面に使う
- バーの色を手で再現して「良し悪し」の意味で使う
