---
version: "1.0.0"
language: "ja"
purpose: "MANX Protocol public summary"
---

# MANX Protocol 概要

本ドキュメントは MANX Protocol の公開可能な範囲の要約です。CP（Conversion Pack）および DP（Doctor Pack）の両方から参照される共通リファレンスです。

---

## 1. MANX Protocol の目的

MANX Protocol は、CC（Claude Code）の構成ファイル群（CLAUDE.md / rules/ / skills/ / settings.json）の設計原則と配置ルールを定義するアーキテクチャ仕様です。

### 1-1. コンテキスト削減

CC はセッション開始時に CLAUDE.md を全文ロードし、コンテキストウィンドウを消費します。命令数が増えるほど個々の命令の遵守率が均一に劣化します。

MANX Protocol は CLAUDE.md を「身分証明書 + スキル目次」（30〜50 行）として再定義し、詳細ルールを skills/ に配置することで、コンテキスト消費を最小化しつつルールの厚さを維持します。

### 1-2. 安全設計

CC の推論品質を保証するために、2 つの独立した安全層（Senior TT / Junior TT）を設け、一方が故障しても他方が機能する耐障害設計を実現しています。

---

## 2. 階層構造（P0〜P5）

| Priority | 配置先 | 役割 | ロード挙動 |
|----------|--------|------|-----------|
| P0 | settings.json | 絶対禁止 + hooks + 認証 | 起動時読み込み。強制適用 |
| P1 | CLAUDE.md | 身分・価値観・インターロック表 | 起動時に全文読み込み |
| P2 | rules/*.md | 短い行動規範 | glob 条件マッチ時 or 常時読み込み |
| P3 | skills/*/SKILL.md | 詳細手順書 | 起動時は YAML のみ。本文はオンデマンド |
| P4 | {project}/CLAUDE.md | プロジェクト固有ルール | 起動時に全文読み込み |
| P5 | CLAUDE.local.md | 揮発メモ | 起動時に全文読み込み（.gitignore 対象） |

---

## 3. 設計原則

1. **CC を縛るルールをなるべく作らない。** ルールの量より、受け入れ条件の精度
2. **設計 AI 側が受け入れ条件を正確に必要十分に表現することに注力する。** それが満たされれば CC の How（具体的手順）は自由
3. **ゲート / インターロック / hooks は WDT（Watchdog Timer）的な保険。** 日常的に発火しないのが正常状態
4. **CC の行動バイアスを矯正せず、品質に寄与する方向にインセンティブを設計する。** 「今やった方が将来の自分が楽」と内面化させる
5. **報告書を「義務」ではなく「知見蓄積の投資」として設計する。** タスクを回すほど rules/ と skills/ が育つ仕組み
6. **「慎重とは急ぐ事也」。** プロセス規律そのものが近道への誘惑に対する構造的抵抗

---

## 4. 用語集

| 略語 / 用語 | 正式名称 | 説明 |
|------------|---------|------|
| CC | Claude Code | 実装 AI。CLI エージェント |
| CCPIT | Protocol Interlock Tower | 構成管理ツール（本ソフトウェア）。公開名称 |
| CP | Conversion Pack | Migration 時に claude.ai に渡す変換指示パック |
| DP | Doctor Pack | 障害診断時に claude.ai に渡す診断情報パック |
| RK | Recovery Kit | 構成ファイルの snapshot・diff・復元機能 |
| DA | Doctor Analysis | DP（Doctor Pack）生成 + claude.ai 診断連携機能 |
| MANX | （Windows 版プロジェクトコード） | マン島 TT 由来。Windows 向け CCDG v2 |
| ASAMA | （Linux 版プロジェクトコード） | 浅間高原レース由来。Linux 向け CCDG v2 |
| Macau | （macOS 版プロジェクトコード） | マカオグランプリ由来。macOS 向け CCDG v2 |
| CCDG | Claude Code Directory Generator | v1（公開済み）と v2（= CCPIT）がある |
| Golden | Golden テンプレート | CCPIT が管理するルール正本。common/ + OS 固有の構造 |
| Senior TT | Main Function (A) | CLAUDE.md + rules/ + skills/ による推論品質保証 |
| Junior TT | Safety Mechanism | settings.json（deny + hooks + auth）による最下層防護 |
| P0〜P5 | Priority 0〜5 | ルールの配置先優先度。P0 が最高（settings.json）、P5 が最低（CLAUDE.local.md） |
| hooks | イベント駆動ガードレール | settings.json 内に定義されるシェルスクリプト。CC のライフサイクルイベントで発火 |
| report-gate | Stop hook | CC 停止時に報告書 MD の存在を確認。なければブロック |
| settings-guard | PreToolUse hook | settings.json への Edit/Write を二重防壁でブロック |
| WDT | Watchdog Timer | ECU の独立ハードウェア安全機構。hooks のアナロジー元 |
| Marshal | 外部ノード監視（将来構想） | ローカル LLM による独立外部監視 |
| SOR/EOR | Start of Report / End of Report | 報告マーカー。CLI 出力では使用。MD ファイル内では使用禁止 |
| i18n | Internationalization | 多言語対応。CCPIT は ja/en をサポート |
| Lost in the Middle | （LLM の既知問題） | 長いコンテキストの中間部分への注意力が低下する現象。CP/DP のサンドイッチ戦略で対策 |
| インターロック | Skill 発火検証機構 | skill 発火の証跡を検証し、未発火時に行動を阻止する自己診断機構。3 段構え（CLAUDE.md 表 + report skill 内チェック欄 + hooks 終了ゲート） |
| Progressive Disclosure | 段階的開示 | 必要な情報を必要なタイミングでのみロードする設計パターン。skills/ の核心 |
| compaction | コンテキスト圧縮 | サーバサイドで発生するコンテキスト圧縮。CC の命令遵守率を劣化させる |
| 規律（Discipline） | — | CLAUDE.md / rules/ / skills/ による CC への指示。逸脱が可能 |
| 強制（Enforcement） | — | settings.json による CC への制御。逸脱が不可能 |
| The Shallow Fix Swamp | 浅い修正の沼 | 浅い修正で済ませる怠慢の沼。MANX Protocol が撲滅を目指す主要ハザード |
