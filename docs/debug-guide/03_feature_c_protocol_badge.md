# 機能 C — プロトコルバッジ + 自動マーキング + Re-scan / Edit Marker UI

## 機能概要

ProjectsPage の各 PJ 行に表示される **プロトコル状態バッジ** と、その背後にある自動判定 / 手動編集の仕組み。

- **プロトコルバッジ**: PJ の MANX 化状態を 1 つのバッジで表示。`MANX r5 β`, `Legacy *`, `MANX ?` 等
- **自動マーキング**: PJ ディレクトリ構造（CLAUDE.md / hooks/ / skills/ / rules/ / .claude/）を 2 ソース（PJ 直下 + PJ 内 .claude/）でスキャンし、ルール R1〜R4 で `protocol.json` を自動生成
- **既存マーカー保護原則**: 既に `.ccpit/protocol.json` がある PJ は自動経路では絶対に上書きしない（FSA r4 §4-1）
- **Re-scan Marker**: per-PJ で `force:true` 上書き再判定（明示確認ダイアログ付き、FSA r4 §4-2）
- **Edit Marker UI**: per-PJ で手動明示マーキング（`stage_inferred:false`, `detection_confidence:'explicit'`）

正式仕様は FSA r4 §2〜§4、026 完了報告、028 完了報告 系統 A〜D を参照。

## アーキテクチャ

### 関連ファイル

| 役割 | パス | 備考 |
|---|---|---|
| 判定アルゴリズム本体 | `ccpit/src/main/services/protocol/autoMarker.ts` | `gatherInputs` / `deriveMarker` / `detectProtocol` / `buildExplicitMarker` / `formatAppliedAt` / `LEGACY_LINE_THRESHOLD=200` / `APP_VERSION` / `REVISION_UNKNOWN='?'` |
| Reader | `ccpit/src/main/services/protocol/protocolReader.ts` | `readProtocol()` / `getProtocolFilePath()` / `PROTOCOL_DIR='.ccpit'` / `PROTOCOL_FILE='protocol.json'` |
| Writer | `ccpit/src/main/services/protocol/protocolWriter.ts` | `writeProtocol(force=false)` 既定で衝突時 throw |
| 型定義 | `ccpit/src/main/services/protocol/types.ts` | `ProtocolMarker`（10 フィールド schema）/ `Stage` / `DetectionConfidence` / `ProtocolProfile` |
| Profile loader | `ccpit/src/main/services/protocol/profilesLoader.ts` | `loadProfiles()` / `DEFAULT_PROFILES` / `getAvailableProfiles(profiles, debugMode)` |
| バッジ表示 lib | `ccpit/src/renderer/src/lib/protocolBadge.ts` | `formatBadgeView()` / `STAGE_COLOR` / `STAGE_SUFFIX` / `BadgeView` |
| バッジ UI | `ccpit/src/renderer/src/components/ProtocolBadge.tsx` | Tooltip 詳細パネル付き |
| Edit Marker UI | `ccpit/src/renderer/src/components/EditMarkerDialog.tsx` | 5 入力（protocol/revision/stage/variant/variant_alias） |
| index re-export | `ccpit/src/main/services/protocol/index.ts` | 全 public API のエントリポイント |
| IPC 配線 | `ccpit/src/main/ipc.ts:148-182` | `protocol:read` / `protocol:write` / `protocol:detect` / `protocol:autoMark` / `protocol:editMarker` / `protocol:rescanMarker` / `protocol:profiles` |
| preload | `ccpit/src/preload/index.ts:128-164` | 7 つの protocol 系 API |
| 統合点 | `ccpit/src/renderer/src/pages/ProjectsPage.tsx:72-119, 285-296, 336-352` | `scanMarkers` / EditMarkerDialog / ProtocolBadge / Re-scan ボタン |
| Feature Flag | `ccpit/src/renderer/src/hooks/useFeatureFlag.ts` の `'protocolBadge'`, `'autoMarking'`, `'editMarkerUI'`（3 個） |  |
| vitest テスト | `ccpit/src/main/services/protocol/__tests__/autoMarker.test.ts` | 31 ケース（Case 1〜30 + Case 20-CCDG2 検体） |

### protocol.json の 10 フィールド schema

```typescript
interface ProtocolMarker {
  protocol: string                           // 'manx' | 'legacy' | 'unknown' | カスタム値（Edit Marker）
  revision: string                           // 'r5' 等。自動時は '?'
  stage: 'stable' | 'beta' | 'alpha' | 'experimental'
  stage_inferred: boolean                    // 自動時 true、Edit Marker 時 false
  variant: string | null
  variant_alias: string | null
  applied_at: string | null                  // YYMMDDHHMM 10 桁。自動時 null、Edit/Re-scan 時記録
  applied_by: string                         // 'ccpit-1.0.0' 等
  detection_evidence: string | null          // 4 セクション形式（自動）/ null（Edit）
  detection_confidence: 'explicit' | 'high' | 'low' | 'unknown'
}
```

格納先: `<PJ>/.ccpit/protocol.json`

### 判定アルゴリズム R1〜R4（FSA r4 §2-5）

`merged*` 入力（PJ 直下 + PJ 内 .claude/ の OR、**グローバル ~/.claude/ は judgment 材料外**）に対して評価:

```
R1  mergedHooks + mergedSkills + mergedRules + mergedSettings + CLAUDE.md → manx, high
R2  CLAUDE.md + (mergedHooks OR mergedSkills) (not full)                  → manx, low
R3a CLAUDE.md > 200 lines + no mergedHooks + no mergedSkills              → legacy, high
R3b CLAUDE.md ≤ 200 lines + no mergedHooks + no mergedSkills              → unknown, low
R4  no CLAUDE.md                                                          → unknown, unknown
```

`mergedHasSettings` の判定対象は `<.claude>/settings.json` または `<.claude>/settings.local.json` の OR（026 §How の判断記録参照）。

`LEGACY_LINE_THRESHOLD = 200` は `autoMarker.ts:8` で定数化。境界条件は `> 200` で R3a（199/200/201 の境界値テスト Case あり）。

### detection_evidence の 4 セクション形式

```
local: CLAUDE.md=true(45行), hooks=false, skills=false, rules=false;
local.claude: hooks=false, skills=false, rules=false, settings.json=true;
global.claude (informational only, not used for judgment): hooks=true, skills=true, rules=true;
merged (excludes global): hooks=false, skills=false, rules=false, settings.json=true
```

`global.claude` セクションには **`(informational only, not used for judgment)`** を必ず含む（FSA r4 §2-4）。`merged` セクションには **`(excludes global)`** を含む。

### バッジ表示の生成（protocolBadge.ts:34-65 の `formatBadgeView`）

```
m.protocol === 'legacy'   → "Legacy"  + (stage_inferred ? " *" : "")  / muted color
m.protocol === 'unknown' && confidence === 'unknown' → null（バッジ非表示）
m.protocol === 'unknown' (low) → "MANX ?" + (stage_inferred ? " *" : "") / emerald (薄緑)
それ以外 → `${protocol.toUpperCase()} ${revision}` + variant + STAGE_SUFFIX[stage] + (stage_inferred ? " *" : "")
```

`STAGE_SUFFIX` は `stable=''`, `beta=' β'`, `alpha=' α'`, `experimental=' exp'`。
`STAGE_COLOR` は stable=緑, beta=黄, alpha=橙, experimental=赤。

### データフロー（自動マーキング）

```
ProjectsPage.useEffect [projects]
  → scanMarkers(paths, autoMarkingEnabled=true)
  → 各 path で window.api.protocolAutoMark(p)
  → IPC 'protocol:autoMark' (ipc.ts:156)
  → readProtocol(p): 既存マーカーあれば return（**保護原則**）
  → なければ detectProtocol(p) → gatherInputs → deriveMarker
  → writeProtocol(p, marker, { force: false })
  → markers state 更新 → ProtocolBadge 描画
```

### データフロー（Re-scan Marker — force:true 経路）

```
ユーザーが ⋯ → Re-scan Marker クリック
  → confirm dialog (i18n: editMarker.confirmRescan)
  → window.api.protocolRescanMarker(path)
  → IPC 'protocol:rescanMarker' (ipc.ts:173)
  → detectProtocol(path, { force: true }) で既存マーカー無視
  → writeProtocol(path, marker, { force: true })
  → markers state 更新
```

### データフロー（Edit Marker — 明示マーキング）

```
ユーザーが ⋯ → Edit Marker クリック
  → EditMarkerDialog 開（current 値で初期化）
  → 5 入力編集 → Save → confirm dialog (i18n: editMarker.confirmSave)
  → window.api.protocolEditMarker(path, edits)
  → IPC 'protocol:editMarker' (ipc.ts:164)
  → buildExplicitMarker(edits, new Date())
     - stage_inferred: false
     - detection_confidence: 'explicit'
     - detection_evidence: null
     - applied_at: formatAppliedAt(now) (YYMMDDHHMM)
  → writeProtocol(path, marker, { force: true })
  → markers state 更新
```

### 依存する Feature Flag

- `protocolBadge`: ProjectsPage のバッジ表示・Re-scan ボタンを出すか（`ProjectsPage.tsx:179, 336`）
- `autoMarking`: scanMarkers が `protocol:autoMark`（書き込み有り）を呼ぶか、`protocol:read`（読み取りのみ）を呼ぶかを切り替え（`ProjectsPage.tsx:80-85`）
- `editMarkerUI`: ⋯ メニューに Edit Marker / Re-scan Marker を出すか + EditMarkerDialog を mount するか（`ProjectsPage.tsx:286, 349, LaunchMenu.tsx:208`）

`autoMarking=false, protocolBadge=true` で **読み取り専用バッジ表示**（既存 protocol.json のみ表示、自動書き込みなし）。

## 故障モード一覧

### FM-C-01: バッジが二重表示される（旧 + 新の並列描画）

- **症状**: 各 PJ 行に 2 つのバッジが並ぶ。1 つ目が日本語（例「MANX」）`*` なし、2 つ目が英語（例「MANX ? *」）`*` あり
- **影響範囲**: 全 PJ
- **既知の発生事例**: 027 調査レポートで特定、028 系統 B で修正済み

#### 原因候補

1. `ProjectsPage.tsx` で旧 `STATUS_COLORS` バッジが描画されている（024 着手時から残存していた残骸）
2. 新 ProtocolBadge 自体が二重 mount されている（コンポーネント自身の問題、028 で否定済み）
3. CSS の `::before` / `::after` で疑似要素が描画されている（028 で否定済み）

#### 確認手順

1. `ccpit/src/renderer/src/pages/ProjectsPage.tsx:336-341` を確認。**`{showProtocolBadge && <ProtocolBadge ... />}` のみ**であり、それ以外のバッジ描画がないこと
2. grep で `STATUS_COLORS` を全数調査: ProjectsPage では使われていないはず（028 で削除済み）。`RKPage.tsx` での参照は **別ドメイン**（diff status: added/modified/removed）で OK
3. grep で `pages.projects.status.` を i18n ja.json / en.json に検索: 028 で削除済みなので 0 件のはず
4. 現状のレンダ DOM を DevTools で観察し、PJ 行に `<span>` バッジが何個あるか確認
5. vitest Case 23（4 セクション evidence）が PASS することを確認（バッジ生成のソースである evidence 形式が正しいことの間接証跡）

#### 修正担当ファイル

- 主担当: `ccpit/src/renderer/src/pages/ProjectsPage.tsx:336-341`
- 副担当: 万一 `STATUS_COLORS` が再導入されていれば該当行（028 で削除済み）

#### 関連 vitest ケース

- Case 23 (r4): evidence 4 セクション形式を検証（バッジソースの正常性）
- バッジ二重描画自体の React Testing Library テストは未整備（後続 CC への TODO）

#### 過去の修正履歴

- **024**: 旧 `STATUS_COLORS` バッジを残したまま新 ProtocolBadge を追加 → 二重バッジ発生
- **027**: 二重バッジを「残置 + 解釈ミス」と特定。FSA に「旧バッジ削除」明示記述がなかったことが根本原因
- **028 系統 B**: ProjectsPage.tsx 旧バッジ JSX 削除 + `STATUS_COLORS` 定数削除 + `ProjectEntry.status` フィールド削除 + `detectStatus()` 削除 + i18n キー `pages.projects.status.*` / `statusLabel` 削除 + RemoveFromListDialog ローカル interface 修正

#### 修正時の注意

- **規範的読み**: 新機能と既存機能の関係を「追加 / 置換 / 共存 / 段階廃止」のいずれかに **必ず明示** してから着手すること（027 §Q4 ルール化候補。06_design_history.md §設計バグの記録を参照）
- 削除時は **全数調査** 必須: `Project.status` / `detectStatus` / i18n キー / RemoveFromListDialog のローカル interface まで一貫して削除する。残置すると死コードが増えて将来の混乱要因
- RKPage の `STATUS_COLORS` は別ドメイン（diff の add/modify/remove）。命名衝突しているだけで触らない（FSA r4 §3-4）

### FM-C-02（致命）: 既存マーカーが上書きされた

- **症状**: Edit Marker で `protocol="manx", revision="r5"` 等を明示設定したのに、しばらくすると別の値に変わっている、または `stage_inferred=false` が `true` に巻き戻る
- **影響範囲**: 致命。**既存マーカー保護原則の侵害**（FSA r4 §4-1）
- **既知の発生事例**: なし。warning 対象

#### 原因候補

1. 自動経路 `protocol:autoMark` が `force:true` で呼ばれている（実装事故）
2. `detectProtocol(path)` が opts なしで呼ばれているのに、`readProtocol(path)` で取れたマーカーを return せず再判定している
3. `writeProtocol(force=false)` の throw が握り潰されている
4. ProjectsPage の自動 scan が ON な状態で、別経路（migration / golden 等）が `writeProtocol(force=true)` を呼んでいる

#### 確認手順

1. `ccpit/src/main/services/protocol/autoMarker.ts:286-298` の `detectProtocol()` を確認。`if (!opts.force) { existing = await readProtocol(...); if (existing) return existing }` の保護ロジックがあるか
2. `ccpit/src/main/ipc.ts:156-162` の `protocol:autoMark` ハンドラを確認。**`writeProtocol(... { force: false })`** を渡していること
3. grep で `force: true` を `ccpit/src/` 全体検索。出るのは `protocol:rescanMarker` / `protocol:editMarker` / vitest テストヘルパのみが正常
4. vitest Case 1（既存マーカー保護）が PASS することを確認
5. 当該 PJ の `.ccpit/protocol.json` の `applied_at` を観察。Edit Marker 後の YYMMDDHHMM が残っているか、null に巻き戻っていないか

#### 修正担当ファイル

- 主担当: `ccpit/src/main/services/protocol/autoMarker.ts:286-298`（detectProtocol の保護ロジック）
- 副担当: `ccpit/src/main/services/protocol/protocolWriter.ts:11-22`（writeProtocol の force 既定値）/ `ccpit/src/main/ipc.ts:156-162`（autoMark ハンドラ）

#### 関連 vitest ケース

- **Case 1**: existing marker is never overwritten（最重要、絶対に PASS させ続ける）
- Case 27: detectProtocol(force:true) bypasses existing marker（force 経路の正常性）

#### 修正時の注意

- 既存マーカー保護原則は機能 C の **最重要不変条件**。自動経路で `force:true` を絶対に使わない
- `force:true` を許可するのは **明示的なユーザー操作** のみ: Re-scan Marker（confirm 必須）と Edit Marker（confirm 必須）
- 規範的読み: 致命的副作用（既存資産の喪失）を持つ関数は **デフォルト false + 名前付きオプション** が必須。`writeProtocol(path, marker, { force: false })` の構造は正しい
- 一括再判定機能を新設する誘惑に乗らない（FSA r4 §4-2「CCPIT は一括再判定機能を提供しない」）

### FM-C-03: バッジが全 PJ で `?` ばかり / `MANX ?` ばかり

- **症状**: 全 PJ で `MANX ?` または `?` 表記、または `Legacy` 判定が消える
- **影響範囲**: 全 PJ
- **既知の発生事例**: 028 改修直後、CCDG2 が unknown/low 判定になる（仕様、FM-C-10 参照）。CanAna 等のグローバル MANX 構成のみの PJ も unknown/low（仕様）

#### 原因候補

1. `gatherInputs` が `merged*` を `false` で返している（PJ 直下と .claude/ に hooks/skills/rules/settings がないと正常）
2. `LEGACY_LINE_THRESHOLD = 200` の境界判定が壊れている（`>` か `>=` か）
3. `deriveMarker` の R1〜R4 ルール順序が壊れている（else if の順序依存）
4. 既存マーカーが保護されたままで古い形式が残っている（保護原則ゆえの正常動作）

#### 確認手順

1. `.ccpit/protocol.json` の `detection_evidence` の **`merged` 行** を確認。`hooks=false, skills=false` なら正しく `unknown`（R3b）か `legacy`（R3a）か `unknown` (R4) のどれかになる
2. `local:` 行と `local.claude:` 行を確認。PJ 直下と PJ 内 .claude/ に hooks/skills/rules があるか
3. `global.claude` 行は **judgment に使われない**（FSA r4 §2-2）。これに hooks/skills/rules があるだけでは MANX 判定にならない
4. vitest Case 2 (R1) / Case 3 (R2) / Case 9 (R3a) / Case 10 (R3b) / Case 4 (R4) すべて PASS することを確認
5. 境界値テスト: vitest「199 lines → R3b」「200 lines → R3b」「201 lines → R3a」がすべて PASS することを確認
6. 全 PJ unknown が回帰でないと判明したら、ユーザーは **Edit Marker UI** で明示マーキングするか、PJ 直下に hooks/skills/rules を配置する

#### 修正担当ファイル

- 主担当: `ccpit/src/main/services/protocol/autoMarker.ts:171-229`（deriveMarker のルール）
- 副担当: `ccpit/src/main/services/protocol/autoMarker.ts:94-148`（gatherInputs の入力収集）

#### 関連 vitest ケース

- Case 2 (R1) / Case 3 (R2) / Case 4 (R4) / Case 9 (R3a) / Case 10 (R3b)
- 境界値テスト 3 件（199 / 200 / 201 行）
- Case 22 (PJ 内 .claude/ 由来 R1)
- Case 28 (CanAna 検体)

#### 修正時の注意

- **R1〜R4 のルール順序は表面上は else if だが、上位ルール（R1）が下位を内包する関係にある**。例えば R2 のチェックを R1 より前に置くと、R1 完備な PJ が R2 と判定される
- `LEGACY_LINE_THRESHOLD` を変える場合、境界値テストの期待値も同期更新する
- 規範的読み: ルール R1〜R4 を分岐ではなく **データ駆動テーブル** にすると順序依存が消える（後続 CC への refactor 候補）

### FM-C-04: stage_inferred=true なのに UI で淡色表示にならない

- **症状**: バッジに `*` が付くべきだが付かない、または淡色（opacity-70）にならない
- **影響範囲**: 自動マーキング由来のバッジ全般
- **既知の発生事例**: なし

#### 原因候補

1. `ProtocolBadge.tsx` の `view.isInferred` が `false` で計算されている
2. `formatBadgeView` の `stage_inferred ? ' *' : ''` が逆論理になっている
3. `cn(view.className, view.isInferred && 'opacity-70')` で `cn` の条件式評価がバグっている
4. protocol.json の `stage_inferred` が `false` で書き込まれている（書き込み側のバグ）

#### 確認手順

1. `.ccpit/protocol.json` の `stage_inferred` フィールドの値を確認
2. `ccpit/src/renderer/src/lib/protocolBadge.ts:39, 48, 59` で `stage_inferred` が `' *'` 付加に使われているか
3. `ccpit/src/renderer/src/components/ProtocolBadge.tsx:33-37, 89` で `view.isInferred` が淡色 + 黄色 inferredNotice に使われているか
4. vitest Case 8（stage_inferred 自動時 true）が PASS すること
5. Edit Marker 経由で書かれた marker は `stage_inferred:false` が正しい（vitest Case 25）

#### 修正担当ファイル

- 主担当: `ccpit/src/renderer/src/lib/protocolBadge.ts:34-65`
- 副担当: `ccpit/src/renderer/src/components/ProtocolBadge.tsx:81-98`

#### 関連 vitest ケース

- Case 8: stage_inferred is always true on auto-marking
- Case 25: Edit Marker payload has stage_inferred=false

#### 修正時の注意

- `stage_inferred` の真偽は **自動マーキングか明示マーキングか** の証跡。UI の `*` だけでなく Tooltip 詳細パネルにも反映される（`ProtocolBadge.tsx:33-37` の inferredNotice）
- 規範的読み: 推定値か明示値かを UI で常に区別する設計は CCPIT 全体の不変条件。「データの確度を UI で正直に表現する」という設計哲学

### FM-C-05: Edit Marker 保存後にバッジが更新されない

- **症状**: Edit Marker で値を入力 → Save しても、ProjectsPage のバッジが古い値のまま
- **影響範囲**: Edit Marker UI を使った PJ
- **既知の発生事例**: なし

#### 原因候補

1. `setMarkers` が編集対象 path に対して呼ばれていない
2. `protocol:editMarker` IPC ハンドラが marker を return していない
3. EditMarkerDialog の `onSubmit` が await されていない（promise の解決前に dialog 閉じる）
4. ProjectsPage の `markers` state が複数 useEffect で同時更新され race condition

#### 確認手順

1. `ccpit/src/renderer/src/pages/ProjectsPage.tsx:162-166` の `handleSubmitEditMarker` を確認。`updated = await window.api.protocolEditMarker(...)` → `setMarkers((prev) => ({ ...prev, [editingPath]: updated }))` の流れ
2. `ccpit/src/main/ipc.ts:164-171` の `protocol:editMarker` ハンドラが marker を return すること
3. `ccpit/src/renderer/src/components/EditMarkerDialog.tsx:61-77` の `handleSave` が `await onSubmit(...)` の **後** に `onOpenChange(false)` を呼ぶこと
4. DevTools で `.ccpit/protocol.json` のディスク内容を確認。書き込み自体は成功していることを確認
5. vitest Case 25（Edit Marker payload + 永続化）が PASS

#### 修正担当ファイル

- 主担当: `ccpit/src/renderer/src/pages/ProjectsPage.tsx:162-166`
- 副担当: `ccpit/src/renderer/src/components/EditMarkerDialog.tsx:61-77` / `ccpit/src/main/ipc.ts:164-171`

#### 関連 vitest ケース

- Case 25: Edit Marker payload has stage_inferred=false, confidence=explicit, evidence=null
- Case 26: applied_at is YYMMDDHHMM (10 digits) for the given Date

#### 修正時の注意

- React state の `setMarkers((prev) => ({ ...prev, [path]: updated }))` で path をキーに上書きする方式は、複数 PJ の並列 scan と整合する（race condition 回避済み）
- Dialog 閉鎖は **書き込み成功後に行う**。失敗時は dialog を残してエラーを伝える設計が望ましい（現状 finally で閉じない、submitting state で disable のみ）

### FM-C-06: Re-scan Marker 確認ダイアログが出ない / 出ても無視される

- **症状**: Re-scan Marker クリック直後に既存マーカーが上書きされる、または confirm が出ない
- **影響範囲**: Re-scan Marker 経路
- **既知の発生事例**: なし

#### 原因候補

1. `confirm()` ブラウザ API が Electron renderer で抑止されている
2. `handleRescanMarker` の `if (!confirm(...)) return` が条件反転している
3. i18n キー `editMarker.confirmRescan` が空文字 / 未定義で confirm が空メッセージになる

#### 確認手順

1. `ccpit/src/renderer/src/pages/ProjectsPage.tsx:168-172` を確認。`if (!confirm(t('editMarker.confirmRescan'))) return` のガードがあるか
2. i18n の ja.json / en.json で `editMarker.confirmRescan` キーが定義されているか
3. Electron の renderer で `window.confirm()` が動くことを別の場面で確認（Edit Marker の `editMarker.confirmSave` も同じ仕組み）

#### 修正担当ファイル

- 主担当: `ccpit/src/renderer/src/pages/ProjectsPage.tsx:168-172`
- 副担当: `ccpit/src/renderer/src/components/EditMarkerDialog.tsx:63`（Edit Marker 側 confirm）/ i18n ファイル

#### 関連 vitest ケース

- Case 27: detectProtocol(force:true) bypasses existing marker（confirm を通過した後の挙動）

#### 修正時の注意

- `confirm()` は ブロッキング UI。代替として shadcn AlertDialog を使う設計余地はあるが、028 までは `confirm()` で MVP 充足
- 規範的読み: 致命的操作（既存マーカー上書き）の前に confirm を入れる設計は **意識的なワンクッション**。安易に飛ばす設計変更を提案しない

### FM-C-07（致命）: グローバル ~/.claude/ への書き込みが起きた

- **症状**: `~/.claude/.ccpit/` 配下にファイルが作成された、または `~/.claude/` 配下のファイルが書き換わった
- **影響範囲**: 致命。**全 PJ への波及**。グローバルは CCPIT のホスト環境で全 PJ 共通
- **既知の発生事例**: なし

#### 原因候補

1. `getProtocolFilePath` が PJ パスを期待するのに、ホームディレクトリが渡されている
2. `gatherInputs` の `globalClaudeDir` 引数経由で書き込みが起きる（gatherInputs は読み取りのみだが、誤呼び出しがあれば）
3. `app.getPath('home')` が空文字を返し、`CCPIT_DIR` が `<root>/.ccpit` になる（プラットフォーム差異）

#### 確認手順

1. grep で `homedir()` / `app.getPath('home')` の用途を全数調査。書き込み（writeFile / mkdir / unlink）に使われていないこと
2. `ccpit/src/main/services/protocol/autoMarker.ts:15-17` の `defaultGlobalClaudeDir()` は `homedir()` 由来だが、これは **読み取り専用** のグローバルパス（gatherInputs で stat / readFile のみ）
3. `ccpit/src/main/services/appConfig.ts:5-7` の `CCPIT_DIR = join(app.getPath('home'), '.ccpit')` は **ユーザー設定領域**（`projects.json` / `app-config.json` / `protocol-profiles.json`）。これはグローバル `~/.claude/` とは別物
4. `ccpit/src/main/services/protocol/protocolReader.ts:9-11` の `getProtocolFilePath(projectPath) = join(projectPath, '.ccpit', 'protocol.json')` を確認。**projectPath がホームディレクトリだとここでグローバル書き込みになる**ため、呼び出し側で projectPath が PJ パスであることを保証する
5. 実機で `~/.claude/` 配下に余計なファイルがないか目視確認

#### 修正担当ファイル

- 主担当: `ccpit/src/main/services/protocol/protocolReader.ts:9-11` の呼び出し元（IPC ハンドラ）
- 副担当: `ccpit/src/main/services/protocol/protocolWriter.ts:11-22`（writeProtocol の path validation 追加余地）

#### 関連 vitest ケース

- 現状なし。**最優先で vitest 追加すべき**: protectAgainstGlobalWrite テスト（projectPath にホームディレクトリを渡したら throw する等）

#### 修正時の注意

- グローバル `~/.claude/` への書き込みは **CCPIT の不文律として絶対禁止**（プロジェクト固有 安全原則 + 028 系統 E の Self-host 保護）
- `gatherInputs` の `globalClaudeDir` は **テスト用の読み取り専用注入ポイント**。書き込み機能を追加するな
- 規範的読み: 「グローバル書き込み禁止」は CCPIT の根幹。本来は path validation で **構造的に不可能** にすべき。後続 CC が writeProtocol に「projectPath がホームと一致したら throw」を加える余地

### FM-C-08: protocol-profiles.json のロード失敗

- **症状**: Edit Marker UI で profile dropdown が空、または「MANX r5 stable」しか出てこない
- **影響範囲**: Edit Marker UI（現状は datalist のみ使用、profile dropdown は将来余地）
- **既知の発生事例**: なし

#### 原因候補

1. `~/.ccpit/protocol-profiles.json` が壊れている（JSON parse 失敗）
2. `debugMode=false` のため `getAvailableProfiles` が `[DEFAULT_STABLE_PROFILE]` のみ返す（仕様）
3. ファイルが存在しない初回起動時、自動生成失敗（mkdir 権限）

#### 確認手順

1. `~/.ccpit/protocol-profiles.json` を直接開いて JSON が valid か確認
2. `ccpit/src/main/services/protocol/profilesLoader.ts:45-62` の `loadProfiles()` を確認。catch で `DEFAULT_PROFILES` を返すフォールバックがあること
3. `ccpit/src/main/services/protocol/profilesLoader.ts:64-72` の `getAvailableProfiles()` を確認。`debugMode=false` で 1 件のみ返すのは **仕様**
4. アプリの Debug モードを ON にして profiles dropdown が増えるか確認
5. 028 時点では Edit Marker UI は profile dropdown を実装しておらず、`PROTOCOL_SUGGESTIONS = ['manx', 'asama', 'macau', 'legacy', 'unknown']` の datalist で代用（`EditMarkerDialog.tsx:19`）。profile 機能は将来余地

#### 修正担当ファイル

- 主担当: `ccpit/src/main/services/protocol/profilesLoader.ts`
- 副担当: `ccpit/src/main/ipc.ts:178-182`（`protocol:profiles` IPC）

#### 関連 vitest ケース

- 現状なし

#### 修正時の注意

- profile loader は壊れたら **DEFAULT_PROFILES** に fallback する設計（catch all）。これを break するとアプリ起動不能になる
- 規範的読み: 設定ファイルを `getAvailableProfiles(debugMode)` で動的に絞る設計は、debugMode が間違って false のままだと困る。後続 CC が UI 側に Debug モード切替を出すか、profile を直接 dropdown 化する余地

### FM-C-09: detection_evidence の global セクションに informational only 注記が抜けている

- **症状**: バッジ Tooltip の evidence 表示で global セクションに `(informational only, not used for judgment)` がない
- **影響範囲**: 全 PJ（自動マーキング由来の marker）
- **既知の発生事例**: 028 系統 A で追加。026 形式の既存マーカーが残っている PJ では古い evidence のまま（仕様、FM-C-10 と関連）

#### 原因候補

1. `buildEvidence` で global セクションに注記文字列が入っていない（コード劣化）
2. 当該 PJ の protocol.json が 028 改修前のもので、自動経路では既存マーカー保護のため上書きされない（**仕様**）
3. 注記の文字列リテラルがコピペで微妙に違う（半角/全角・空白）

#### 確認手順

1. `ccpit/src/main/services/protocol/autoMarker.ts:150-158` の `buildEvidence()` を確認。`global.claude (informational only, not used for judgment):` と `merged (excludes global):` の両方を含むこと
2. vitest Case 30（evidence informational 注記）と Case 23（4 セクション）が PASS することを確認
3. 当該 PJ の protocol.json の `detection_evidence` を直接観察。古い形式（単一文字列、3 セクション、注記なし）の場合は **Re-scan Marker** で更新できる
4. `applied_by` フィールドが `ccpit-1.0.0` で、`detection_evidence` の形式が 028 形式（注記あり）なら正常

#### 修正担当ファイル

- 主担当: `ccpit/src/main/services/protocol/autoMarker.ts:150-158`

#### 関連 vitest ケース

- Case 23 (r4): 4 セクション + global 注記 + merged "excludes global"
- Case 30: evidence global section contains "informational only, not used for judgment"

#### 過去の修正履歴

- **028 系統 A**: r3 では global を judgment に含めていた → r4 で global を除外し、注記を必須化（FSA r4 §2-3, §2-4）

#### 修正時の注意

- 注記文字列は **vitest Case 30 と一字一句一致**。変える場合はテストも同期更新
- 既存マーカーが古い形式のまま残るのは「既存マーカー保護原則」の正常動作。Re-scan Marker で per-PJ 更新を促す（FSA r4 §4-2）
- 規範的読み: judgment material と informational material を **データ表現上で明示** する（注記文字列）のは、後続 CC のデバッグ容易性のため。読み手のための仕様

### FM-C-10: CCDG2 自身が r4 改修後 unknown/low 判定（Self-host 構造の正直な表現）

- **症状**: CCDG2 PJ のバッジが `MANX ? *` または非表示になる。「CCDG2 は MANX 化されているはずなのに」と困惑する
- **影響範囲**: CCDG2 のみ（および同型の Self-host PJ）
- **既知の発生事例**: 028 系統 A 直後、らいおが実機観察で確認

#### 原因候補

これは **仕様**。原因ではなく説明:

- CCDG2 は CCPIT の Self-host 開発環境
- PJ 直下にも `.claude/` 内にも hooks/skills/rules を **持たない**
- グローバル `~/.claude/` に MANX 構成（.pit）を配置する運用
- FSA r4 で「グローバル ~/.claude/ は judgment 材料外」が確定 → CCDG2 は merged*=false → R3b: unknown, low

#### 確認手順

1. CCDG2 の `.ccpit/protocol.json` の `detection_evidence` を確認。`local: hooks=false, skills=false, rules=false`、`local.claude: hooks=false, skills=false, rules=false`、`global.claude (informational only, not used for judgment): hooks=true, skills=true, rules=true`、`merged (excludes global): hooks=false, skills=false, rules=false, settings.json=true` のはず
2. vitest Case 20-CCDG2 が PASS することを確認（CCDG2 検体パスでの実機 E2E 的テスト）
3. これは **仕様変更** （r3 manx, high → r4 unknown, low）であり、回帰ではないことを 028 完了報告 系統 A で確認

#### 修正担当ファイル

修正不要。表示を MANX に戻すには **Edit Marker UI で手動明示マーキング**:
- `protocol="manx", revision="r5", stage="stable"`
- `stage_inferred=false`, `detection_confidence='explicit'` で書き込まれる

#### 関連 vitest ケース

- **Case 20-CCDG2**: real CCDG2 repo → unknown, low (PJ has no MANX setup; global is informational only)

#### 過去の修正履歴

- **r3 → r4**: r3 では CCDG2 が manx, high と判定された（グローバルを judgment に含めていた）。r4 で正しい挙動に修正（半端 MANX を正直に表現）
- **028 系統 E**: CCDG2 半端 MANX の歴史的経緯を推論調査（ロビンの作品）

#### 修正時の注意

- **CCDG2 を MANX 化したいからといって、PJ 直下に hooks/skills/rules を配置するのは推奨しない**:
  - グローバル/ローカル二重管理コスト発生（028 系統 E 結論）
  - グローバル .pit を運用する Self-host ドッグフーディング基盤が崩れる
- 推奨運用は **Edit Marker UI で明示マーキング**
- 規範的読み: Self-host PJ の特殊性は判定アルゴリズムの設計時に視野外だった。後続 CC が「Self-host PJ 認識」を独立機能として実装する余地はあるが優先度低（028 系統 E §E3）
- 06_design_history.md §CCDG2 の特殊性 を必ず読むこと

### FM-C-11: CCDirectoryGenerator の `MANX_PLOT?` 表示（データ問題）

- **症状**: CCDirectoryGenerator PJ のバッジが `MANX_PLOT ?` と表示される
- **影響範囲**: CCDirectoryGenerator 1 PJ のみ
- **既知の発生事例**: 028 着手前にらいお実機観察、028 系統 D で原因特定（コード問題ではなくデータ問題）

#### 原因候補

これは **データ問題**。原因:

- 当該 PJ の `.ccpit/protocol.json` の `protocol` フィールドに `"Manx_Plot"` という非標準値が手動入力されている（`applied_at: "2604300941"` から 2026-04-30 09:41 に Edit Marker UI で入力と推定）
- `formatBadgeView` の標準分岐（`legacy` でも `unknown` でもない）で `m.protocol.toUpperCase()` → `"MANX_PLOT"` + revision `"?"` → `"MANX_PLOT ?"` を生成

#### 確認手順

1. `<CCDirectoryGenerator>/.ccpit/protocol.json` を開き、`protocol` フィールドの値を確認
2. `ccpit/src/renderer/src/lib/protocolBadge.ts:54` の標準分岐を確認。`m.protocol.toUpperCase()` がそのまま使われる
3. `revision === '?'` でも非表示にはならない（unknown 分岐は protocol === 'unknown' 限定）

#### 修正担当ファイル

修正不要（コード問題ではない）。対処:
- 当該 PJ で Edit Marker UI を開き、`protocol="manx", variant="plot"` 等の標準値に再入力

#### 関連 vitest ケース

- 現状なし。`formatBadgeView` の generic 分岐の単体テストは未整備

#### 過去の修正履歴

- **028 系統 D**: 原因特定（データ問題）、コード変更なしで完了。ユーザー手動修正待ち

#### 修正時の注意

- **コード側の対応**:
  - 標準値以外を弾く（厳格化）→ ユーザーのカスタム protocol 値を許可しなくなる、UX 悪化
  - 警告表示 → 設計余地あり、後続 CC への TODO
- データ側の対応: Edit Marker UI で標準値に修正（推奨）
- 規範的読み: Edit Marker UI が「カスタム入力可能な datalist」になっているのは意図的（FSA r3 §3-2）。ユーザーの自由度と表示の予測可能性のトレードオフ。後続 CC が「非標準 protocol 警告 Tooltip」を追加する余地

## 過去の修正履歴

- **024**（2026-04-29〜04-30）: 機能新規実装。R1〜R4 + R3a/R3b、stage_inferred、既存マーカー保護、vitest 19 ケース PASS
- **026**（2026-04-30）: 3 ソース統合スキャン（PJ 直下 + .claude/ + ~/.claude/）+ 4 セクション evidence + Edit Marker UI + Re-scan Marker。vitest 28 ケース PASS。**※後に r3 設計バグと判明、028 で修正**
- **027**（2026-04-30）: 二重バッジ問題と CCDG2 unknown 状態の調査（コード変更なし）。CC ロビン作品。FMA 思想を本手引書に継承
- **028 系統 A**（2026-04-30）: r3 設計バグ修正（グローバル ~/.claude/ を judgment 材料外に）。vitest 31 ケース PASS
- **028 系統 B**（2026-04-30）: ProjectsPage 旧 STATUS_COLORS バッジ削除（ProtocolBadge 単独表示に統一）。関連デッドコード 6 種除去
- **028 系統 D**（2026-04-30）: CCDirectoryGenerator `MANX_PLOT?` 原因特定（データ問題、コード変更なし）

## 更新履歴

- 2026-04-30: 029 で初版作成
