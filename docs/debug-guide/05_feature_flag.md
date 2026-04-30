# Feature Flag 基盤

## 機能概要

CCPIT の **「使いながら作り替えていく」イテラティブ開発思想** を支える、機能単位の独立 ON/OFF 切替機構。

- **6 個のフラグ**: `ccLaunchButton` / `detectLinkRemove` / `protocolBadge` / `favoriteToggle` / `autoMarking` / `editMarkerUI`
- 永続化先: `~/.ccpit/app-config.json` の `features` セクション
- UI 制御: Debug タブから ChkBox 切替
- ガード方式: `{flag && <Component />}` パターン（**hidden、disable ではない**）
- 既定値: 全部 ON（`DEFAULT_FEATURES`）

正式仕様は FSA r1〜r4 §横断要件、024 完了報告 §Feature Flag 基盤、026 完了報告 §Edit Marker UI を参照。

## アーキテクチャ

### 関連ファイル

| 役割 | パス | 備考 |
|---|---|---|
| 型定義 + 既定値（main） | `ccpit/src/main/services/appConfig.ts:24-54` | `FeatureKey` / `FeatureFlags` / `FEATURE_KEYS` / `DEFAULT_FEATURES` |
| 設定 I/O | `ccpit/src/main/services/appConfig.ts:82-136` | `mergeFeatures` / `readConfigSync` / `getConfig` / `setConfig` |
| renderer hook + 型 | `ccpit/src/renderer/src/hooks/useFeatureFlag.ts` | `useFeatureFlag(key)` / `useFeatureFlags()` / `setFeatureFlag` / `resetFeatureFlags` / グローバル `cached` + `listeners` |
| preload 公開 | `ccpit/src/preload/index.ts:108-111` / `ccpit/src/preload/index.d.ts:86-87` | `configGet` / `configSet`（`features` を含む） |
| IPC 配線 | `ccpit/src/main/ipc.ts:107-108` | `config:get` / `config:set` |
| Debug タブ UI | `ccpit/src/renderer/src/pages/DebugPage.tsx` | 各 FeatureKey の ChkBox + リセットボタン |

### 6 フラグの所属（024 + 026 で計 6 個）

| フラグ | 由来 | 制御対象（hidden 化される UI） | 関連章 |
|---|---|---|---|
| `ccLaunchButton` | 024 | LaunchMenu 全体（Launch ボタン + ⋯ メニュー） | [01_feature_a](./01_feature_a_cc_launch.md) |
| `detectLinkRemove` | 024 | Discovery / Remove from List ボタン + Dialog | [02_feature_b](./02_feature_b_detect_link.md) |
| `protocolBadge` | 024 | バッジ表示 + Re-scan ボタン | [03_feature_c](./03_feature_c_protocol_badge.md) |
| `favoriteToggle` | 024 | Star ボタン | [04_feature_d](./04_feature_d_favorite_reserved.md) |
| `autoMarking` | 024 | scanMarkers が `protocol:autoMark`（書き込み有り）vs `protocol:read`（読み取りのみ）を切替 | [03_feature_c](./03_feature_c_protocol_badge.md) |
| `editMarkerUI` | **026** | ⋯ メニューの Edit Marker / Re-scan Marker 項目 + EditMarkerDialog | [03_feature_c](./03_feature_c_protocol_badge.md) |

### データフロー（読み取り）

```
React component で useFeatureFlag('xxx') 呼び出し
  → useFeatureFlags() を内部呼び出し（同一 cached を共有）
  → 初回のみ fetchFeatures() で window.api.configGet() → cached に格納
  → listeners.add(cb) で再レンダ通知購読
  → cached[key].enabled を return
```

`cached` は **モジュールローカルなグローバル変数**（`useFeatureFlag.ts:31`）。Context Provider を使わず軽量に共有（024 §How）。

### データフロー（書き込み）

```
ユーザーが Debug タブで ChkBox 切替
  → setFeatureFlag(key, enabled) (useFeatureFlag.ts:60-64)
  → window.api.configSet({ features: { [key]: { enabled } } })
  → IPC 'config:set' (ipc.ts:108)
  → setConfig(partial) (appConfig.ts:122-136)
    → readConfigSync で現値 load
    → features は **deep merge**（partial.features ? { ...current.features, ...partial.features } : current.features）
    → ~/.ccpit/app-config.json へ atomic write
  → fetchFeatures() で cached を更新 → listeners 全員に通知 → UI 再レンダ
```

### マイグレーション設計（既存ユーザーの ON/OFF 設定保護）

`mergeFeatures(parsed)`（appConfig.ts:82-96）は以下のロジック:
- `DEFAULT_FEATURES` を起点に
- `FEATURE_KEYS` でループし、`parsed[key]` が valid な `{ enabled: boolean }` なら上書き
- 不正値や欠落キーは `DEFAULT_FEATURES` の値を維持

→ **新規 Feature Flag を追加してもユーザーの既存設定を破壊しない**。024 §How 判断記録参照。

### 依存する Feature Flag

なし（Feature Flag 自体は独立基盤）。

## 故障モード一覧

### FM-FF-01: フラグを OFF にしても UI が消えない

- **症状**: Debug タブで ChkBox を OFF にしたが、対象機能の UI が残る
- **影響範囲**: 特定フラグ
- **既知の発生事例**: なし

#### 原因候補

1. UI 側で `useFeatureFlag('xxx')` の戻り値を **disable** にしているだけで `&&` ガードしていない
2. `disabled={!flag}` 等で disable のみ実装、hidden 化していない
3. flag 値が反映される前に component が render（初回 fetch 完了前）
4. `useFeatureFlag` の return が `false` でなく `undefined` になっている（`cached[key]?.enabled ?? false`）

#### 確認手順

1. 当該 UI を表示する component で `{flag && <Component />}` パターンになっているか grep
   - 例: `ccpit/src/renderer/src/pages/ProjectsPage.tsx:179, 192, 263, 274, 286, 310, 336, 345`
2. `useFeatureFlag(key)` 戻り値の型を確認: `boolean`（`useFeatureFlag.ts:55-58`）
3. 初回 fetch 完了前は `cached = { ...DEFAULT_FEATURES }`（ON が既定）。OFF にした直後の同期問題はないはず
4. DevTools で `~/.ccpit/app-config.json` の `features` セクションを直接確認し、ディスク値が OFF になっているか
5. 期待動作: OFF 時は UI が完全に DOM から消える（hidden）。disable でなく hidden の理由は **「使いながら作り替える」思想で機能をクリーンに切り替える** ため

#### 修正担当ファイル

- 主担当: 該当機能の component（ProjectsPage.tsx 等）
- 副担当: `ccpit/src/renderer/src/hooks/useFeatureFlag.ts:55-58`（fallback 値）

#### 関連 vitest ケース

- 現状なし

#### 修正時の注意

- **disable ではなく hidden** が機能 Flag の不変条件。disable で残すと「壊れた UI が見える」状態になり、動作確認時に混乱する
- 規範的読み: hidden vs disable のトレードオフは UX 設計の典型問題。CCPIT は「ドッグフーディング中の機能切替を綺麗に行う」ため hidden を選択。後続 CC は安易に disable に切り替えない

### FM-FF-02: Debug タブで切り替えても再起動しないと反映されない

- **症状**: ChkBox を切り替えた直後に UI が変わらない、アプリ再起動後にしか反映されない
- **影響範囲**: 全フラグ
- **既知の発生事例**: なし

#### 原因候補

1. `setFeatureFlag` 後の `fetchFeatures()` が呼ばれていない
2. `listeners` への通知が走らない（`force(n => n + 1)` の useState 通知メカニズム）
3. component が `useFeatureFlag` ではなく `cached` を直接読んでいる（hook を経由していない）
4. React 17 系の useState batch 動作で再レンダが遅延

#### 確認手順

1. `ccpit/src/renderer/src/hooks/useFeatureFlag.ts:60-64` の `setFeatureFlag` を確認。`await fetchFeatures()` で cached 更新と listeners 通知が走ること
2. `useFeatureFlag.ts:35-40` の `fetchFeatures` で `listeners.forEach((l) => l())` が呼ばれること
3. 当該 component が `useFeatureFlag(key)` 経由でフラグを読んでいるか（直接 `cached` を読むのは禁止）
4. Debug タブの ChkBox ハンドラが `setFeatureFlag(key, value)` を呼ぶか

#### 修正担当ファイル

- 主担当: `ccpit/src/renderer/src/hooks/useFeatureFlag.ts:42-69`
- 副担当: Debug タブの ChkBox ハンドラ

#### 関連 vitest ケース

- 現状なし。React Testing Library で hook 単体テスト可能（後続 CC への TODO）

#### 修正時の注意

- グローバル `cached` + `listeners` Set + `useState(force)` の組み合わせは **Context Provider を使わず軽量に共有** する設計（024 §How）
- 後続 CC が React Context 化する誘惑に注意。テスト容易性は上がるが **依存ツリーが深くなる**。MVP 思想に反する変更は控える

### FM-FF-03: 新規 Feature Flag 追加時に既存ロジックが壊れる

- **症状**: 新フラグを追加したら既存ユーザーの ChkBox 設定がリセットされる、または `app-config.json` が壊れる
- **影響範囲**: 既存ユーザー全員
- **既知の発生事例**: なし

#### 原因候補

1. `FEATURE_KEYS` 配列に追加し忘れ → `mergeFeatures` で merge 対象外
2. `DEFAULT_FEATURES` に追加し忘れ → fallback 値が `undefined`
3. 型定義 `FeatureKey` に追加し忘れ → TypeScript エラー
4. main / renderer / preload の **3 箇所同期** を片方だけ更新（type と DEFAULT_FEATURES が main / renderer 両方に重複定義されている）

#### 確認手順

1. **新フラグ追加時の同期更新が必要なファイル一覧**:
   - `ccpit/src/main/services/appConfig.ts:24-54`（main 側 type + 配列 + 既定）
   - `ccpit/src/renderer/src/hooks/useFeatureFlag.ts:3-29`（renderer 側 type + 配列 + 既定）
   - `ccpit/src/preload/index.ts:108-111`（configGet / configSet の型）
   - `ccpit/src/preload/index.d.ts:86-87`（型同期）
2. 026 で `editMarkerUI` を追加した実例を参照: 026 完了報告「Feature Flag editMarkerUI を appConfig.ts / useFeatureFlag.ts / preload index.ts/d.ts の 4 箇所に追加（型同期）」
3. typecheck で型エラーが出るか確認: `npm run typecheck` を実行（main + renderer 両方）
4. ユーザーの既存 `app-config.json` を擬似的に古い形式（新フラグ欠落）で保存し、起動して fallback が DEFAULT で埋めるか確認

#### 修正担当ファイル

- 主担当: 上記 4 ファイルの **同期更新**

#### 関連 vitest ケース

- 現状なし。`mergeFeatures` の単体テストは tmpdir で簡単（後続 CC への TODO）

#### 修正時の注意

- **4 ファイル同期更新** は機能 Flag 追加の **不変手順**。1 ファイル抜けると runtime で `cached[key]` が undefined / TypeScript で型エラー
- 規範的読み: 型を main / renderer / preload で重複定義しているのは Electron 構造の制約（process boundary）。後続 CC が **共通型ファイル** を作って一元化する余地はあるが、preload の context isolation を破ると security 問題が出る。慎重に
- 既定値 `enabled: true` で出すか `false` で出すかは「使いながら作り替える」思想に従う: **新機能は最初 ON で出して使い始める**（実機ドッグフーディング前提）。OFF 既定でリリースするのは仕様確認用途のみ

### FM-FF-04: フラグの相互依存が壊れる（autoMarking + protocolBadge）

- **症状**: `autoMarking=false, protocolBadge=true` で読み取り専用バッジ表示するつもりが、自動書き込みが起きる
- **影響範囲**: 当該 2 フラグの組み合わせ
- **既知の発生事例**: なし

#### 原因候補

1. `scanMarkers(paths, allowAutoWrite)` の `allowAutoWrite` が `autoMarkingEnabled` ではなく常に `true`
2. `protocol:autoMark` IPC が常に `writeProtocol` を呼ぶ（書き込み有り）
3. `protocol:read` IPC が間違って書き込みもする（実装事故）

#### 確認手順

1. `ccpit/src/renderer/src/pages/ProjectsPage.tsx:72-103` の `scanMarkers` を確認。`allowAutoWrite` が真なら `protocolAutoMark`（書き込み有り）、偽なら `protocolRead`（読み取りのみ）
2. `ccpit/src/renderer/src/pages/ProjectsPage.tsx:109-114` の `useEffect` で `scanMarkers(paths, autoMarkingEnabled)` が渡されているか
3. `ccpit/src/main/ipc.ts:149` の `protocol:read` が **`readProtocol` のみ** を呼び書き込みしないこと
4. `ccpit/src/main/ipc.ts:156-162` の `protocol:autoMark` が **既存マーカーがない場合のみ** writeProtocol を呼ぶこと

#### 修正担当ファイル

- 主担当: `ccpit/src/renderer/src/pages/ProjectsPage.tsx:72-114`
- 副担当: `ccpit/src/main/ipc.ts:149, 156-162`

#### 関連 vitest ケース

- Case 1: existing marker is never overwritten（`protocol:autoMark` の保護動作）

#### 修正時の注意

- 2 つのフラグの組み合わせは **意図された設計**:
  - `autoMarking=true, protocolBadge=true`: 完全自動（バッジ表示 + 自動書き込み）
  - `autoMarking=false, protocolBadge=true`: 読み取り専用（既存マーカーのみ表示、新規 PJ には書き込まない）
  - `autoMarking=true, protocolBadge=false`: 書き込みは走るがバッジは見えない（普通使わない）
  - `autoMarking=false, protocolBadge=false`: 機能 C 全停止
- フラグの相互作用は将来的に増える。組み合わせテストを vitest で書く（後続 CC への TODO）

## 過去の修正履歴

- **024**（2026-04-29〜04-30）: Feature Flag 基盤新規実装。5 フラグ（ccLaunchButton / detectLinkRemove / protocolBadge / favoriteToggle / autoMarking）+ Debug タブ + マイグレーション機構
- **026**（2026-04-30）: 6 個目のフラグ `editMarkerUI` を追加（4 ファイル同期更新）

## 更新履歴

- 2026-04-30: 029 で初版作成
