# 機能 D — Favorite 星マーク + 予約フィールド

## 機能概要

ProjectsPage の各 PJ 行に表示される **Favorite 星マーク（toggle）** と、`projects.json` に格納される **将来機能用の予約フィールド群**。

- **Favorite 星マーク**: クリックで toggle、楽観的更新、再起動後保持
- **予約フィールド**: `parent_id` / `groupKey` / `documents` / `favorite` / `location_type` の 5 種。024 時点では永続化のみで UI 未実装も多数（将来余地）
- **Capability Matrix**: `services/capabilities.ts` で `local` / `remote-readonly` / `remote-full` の能力差を定義（024 で導入、現状は MVP として `location_type='local'` 固定運用）

正式仕様は FSA r1 §機能 D、024 完了報告 §機能 D を参照。

## アーキテクチャ

### 関連ファイル

| 役割 | パス | 備考 |
|---|---|---|
| 型定義 + 永続化 | `ccpit/src/main/services/projects.ts:9-22` | `LocationType` / `ProjectEntry`（5 予約フィールド all optional） |
| `setFavorite` | `ccpit/src/main/services/projects.ts:200-206` | 単一 PJ の favorite フラグ更新 |
| Capability Matrix | `ccpit/src/main/services/capabilities.ts` | local / remote-readonly / remote-full の能力定義（024 で導入） |
| IPC 配線 | `ccpit/src/main/ipc.ts:83-85` | `projects:setFavorite` |
| preload | `ccpit/src/preload/index.ts:79-80` | `projectsSetFavorite` |
| 統合点 | `ccpit/src/renderer/src/pages/ProjectsPage.tsx:121-127, 310-332` | Star toggle ハンドラ + Star ボタン UI（`useFeatureFlag('favoriteToggle')` ガード） |
| Feature Flag | `ccpit/src/renderer/src/hooks/useFeatureFlag.ts` の `'favoriteToggle'` |  |

### 5 予約フィールドの役割（FSA r1 §機能 D）

| フィールド | 型 | 現状の使用 | 将来予定 |
|---|---|---|---|
| `parent_id` | `string \| null` (optional) | 未使用（永続化のみ） | PJ 階層構造（親子関係） |
| `groupKey` | `string \| null` (optional) | 未使用 | グルーピング・タグ管理 |
| `documents` | `string[]` (optional) | 未使用 | Document リンク管理 |
| `favorite` | `boolean` (optional) | **使用中**（Star toggle） | 同左 |
| `location_type` | `'local' \| 'remote-readonly' \| 'remote-full'` (optional) | 書き込みのみ（常に `'local'`） | リモート PJ 対応時に分岐 |

すべて optional（`?`）。**既存 `projects.json` 互換維持** のため。

### Favorite toggle のデータフロー

```
ユーザーが ★ クリック
  → ProjectsPage.handleToggleFavorite(project) (ProjectsPage.tsx:121-127)
  → next = !(project.favorite ?? false)
  → window.api.projectsSetFavorite(project.path, next) (preload/index.ts:79)
  → IPC 'projects:setFavorite' (ipc.ts:83)
  → setFavorite(projectPath, favorite) (projects.ts:200-206)
    → loadProjects → findIndex by path
    → projects[idx] = { ...projects[idx], favorite }
    → saveProjects
  → setProjects(prev => prev.map(...)) で **楽観的更新**
```

楽観的更新: IPC 待たずに UI を即時更新。失敗時の rollback は MVP 範囲外（024 §How の判断記録参照）。

### location_type の書き込みポイント

`createProject`（projects.ts:114-119）と `importProjects`（projects.ts:158-165）の両方で **`location_type: 'local'`** を明示書き込み。

将来、リモート PJ 対応時に `'remote-readonly'` / `'remote-full'` を選択可能にする予定（024 §How）。

### 依存する Feature Flag

- `favoriteToggle`: ProjectsPage で Star ボタンを表示するか（`ProjectsPage.tsx:310-332`）

OFF にすると Star ボタン自体が消える（hidden、disable ではない）。

## 故障モード一覧

### FM-D-01: Favorite toggle が永続化されない

- **症状**: ★ をクリックして黄色になるが、再起動後に消えている、または別 PJ の favorite が一緒に変わる
- **影響範囲**: 全 PJ
- **既知の発生事例**: なし

#### 原因候補

1. `setFavorite` が path 一致で findIndex に失敗（path の正規化問題、Windows の `\` vs `/` 等）
2. `saveProjects` の atomic 性が破れている（write 中の競合）
3. UI の楽観的更新が成功し、IPC 失敗を握り潰している
4. `loadProjects` が古い JSON を返す（fs キャッシュ問題）

#### 確認手順

1. `ccpit/src/main/services/projects.ts:200-206` の `setFavorite` を確認。`findIndex((p) => p.path === projectPath)` の **完全一致比較**
2. `~/.ccpit/projects.json` を直接開いて当該 PJ の `favorite` フィールドを確認
3. ProjectsPage が UI 上で楽観的更新するため、IPC 失敗が画面に出ない問題に注意（`ProjectsPage.tsx:121-127`）
4. path に大文字小文字違い / 末尾 `\` の有無 / `/` vs `\` 違いがないか
5. `ccpit/src/main/services/projects.ts:9-22` の `ProjectEntry` 型で `favorite?: boolean` が optional 定義されていることを確認

#### 修正担当ファイル

- 主担当: `ccpit/src/main/services/projects.ts:200-206`
- 副担当: `ccpit/src/renderer/src/pages/ProjectsPage.tsx:121-127`（楽観的更新の rollback 余地）

#### 関連 vitest ケース

- 現状なし。`setFavorite` は I/O 副作用ありだが tmpdir で簡単にテスト可能（後続 CC への TODO）

#### 修正時の注意

- path 比較を `toLowerCase()` 化するなら **import 系（`importProjects`）と整合性を取ること**。importProjects は重複防止に `toLowerCase()` 比較しているため、setFavorite だけ厳密一致にすると矛盾する
- 規範的読み: path をキーにする操作は **Windows の path normalization 問題** が常につきまとう。後続 CC が `path.normalize()` + 一貫した case 処理を導入する余地

### FM-D-02: 予約フィールドが undefined エラーを起こす

- **症状**: PJ 一覧読み込み時に「Cannot read property 'parent_id' of undefined」等のエラー、または UI で予約フィールド由来の表示が崩れる
- **影響範囲**: 古い `projects.json` を持つユーザー（024 より前のスキーマ）
- **既知の発生事例**: なし

#### 原因候補

1. 5 予約フィールドのいずれかが optional ではなく required になっている（型定義変更の事故）
2. UI 側で `project.documents.length` 等を直接アクセス（`?.` を使わない）
3. JSON parse 失敗時の fallback がない

#### 確認手順

1. `ccpit/src/main/services/projects.ts:11-20` の `ProjectEntry` 型で全 5 フィールドが `?` 付き optional であること
2. ProjectsPage で `project.favorite ?? false` のような **null 安全アクセス** が使われているか
3. `~/.ccpit/projects.json` を直接観察し、古いエントリ（024 以前作成）に予約フィールドが欠落していても OK
4. 024 完了報告「予約フィールドはすべて optional（`?`）: 既存 projects.json 互換維持」を確認

#### 修正担当ファイル

- 主担当: `ccpit/src/main/services/projects.ts:9-22`（型定義）
- 副担当: ProjectsPage.tsx の predicate 式

#### 関連 vitest ケース

- 現状なし

#### 修正時の注意

- 5 予約フィールドの **all optional** は機能 D の不変条件。required にすると 024 以前の `projects.json` を破壊する
- 規範的読み: 「予約フィールド」という設計概念は将来機能の **incremental rollout** を可能にする。024 では `favorite` と `location_type` のみ実用、残り 3 フィールドは永続化のみ。これは Feature Flag と組み合わせた「データ先行・UI 後行」戦略

### FM-D-03: location_type が `'local'` 以外で書き込まれた

- **症状**: `projects.json` で `location_type` が `'remote-readonly'` 等になっている
- **影響範囲**: 該当 PJ のみ
- **既知の発生事例**: なし（024 では常に `'local'` 固定書き込み）

#### 原因候補

1. `createProject` / `importProjects` が `'local'` 以外を渡している（実装事故）
2. 外部ツール / 手動編集で書き換えられている
3. 将来的にリモート PJ 機能が実装されるが Feature Flag で制御されていない

#### 確認手順

1. `ccpit/src/main/services/projects.ts:114-119`（createProject）と `:158-165`（importProjects）で `location_type: 'local'` の固定書き込みを確認
2. grep で `location_type` を全数調査。書き込み箇所が createProject / importProjects のみ + 設定 UI 経由の更新ハンドラのみ（現状未実装）
3. Capability Matrix（`services/capabilities.ts`）で `'local'` 以外が定義されているか確認

#### 修正担当ファイル

- 主担当: `ccpit/src/main/services/projects.ts:114-119, 158-165`
- 副担当: `ccpit/src/main/services/capabilities.ts`

#### 関連 vitest ケース

- 現状なし

#### 修正時の注意

- 将来リモート PJ 機能を追加する際は **Feature Flag + Capability Matrix + UI 切替** を一括導入する設計。024 の固定書き込みは MVP として正しい
- 規範的読み: 予約フィールドを optional にしてあるのは「将来機能を出す前は値が無くても動く」設計。`location_type` を必須化するなら全 PJ への migration が必要になる。それは breaking change として扱う

## 過去の修正履歴

- **024**（2026-04-29〜04-30）: 機能新規実装。5 予約フィールド all optional、Favorite 楽観的更新、Capability Matrix 導入

## 更新履歴

- 2026-04-30: 029 で初版作成
