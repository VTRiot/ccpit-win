# 機能 B — DetectLink + Remove from List

## 機能概要

ProjectsPage 上部のツールバーから利用する **PJ 一括取り込み / 一括除外** 機能。

- **DetectLink (Discovery)**: 指定フォルダ配下を再帰走査し、`CLAUDE.md` を持つディレクトリを発見 → ChkBox 一覧 → Select All / Deselect All → 一括 import
- **Remove from List**: 既存管理 PJ の ChkBox 一覧 → Select All / Deselect All → リストからの除外（**ファイルシステム操作なし**）

CCDG v1 の UX 思想（「指定フォルダ走査」「ChkBox 一覧 → 一括処理」）を踏襲。ただし inode 比較・hardlink 操作は採用していない（024 完了報告 §Phase 0「採用しなかった要素」）。

正式仕様は FSA r4 §機能 B、024 完了報告 §機能 B を参照。

## アーキテクチャ

### 関連ファイル

| 役割 | パス | 備考 |
|---|---|---|
| 走査ロジック | `ccpit/src/main/services/projectDiscovery.ts` | `discoverClaudeProjects()` / `walkClaudeMd()` / `EXCLUDE_DIR_NAMES` / `DEFAULT_MAX_DEPTH=4` |
| PJ レジストリ | `ccpit/src/main/services/projects.ts` | `loadProjects` / `importProjects` / `removeProjectsFromList` / `listManagedPaths` |
| Discovery UI | `ccpit/src/renderer/src/components/ProjectDiscoveryDialog.tsx` | フォルダ選択 + Scan + 候補一覧（既存管理 PJ は disable） |
| Remove UI | `ccpit/src/renderer/src/components/RemoveFromListDialog.tsx` | 既存 PJ リスト + ChkBox 複数選択 + 黄色警告必須表示 |
| 共通 Dialog | `ccpit/src/renderer/src/components/MultiSelectDialog.tsx` | `MultiSelectDialog<T>` ジェネリック（Discovery / Remove で使い回し） |
| IPC 配線 | `ccpit/src/main/ipc.ts:75-82` | `projects:discover` / `projects:import` / `projects:removeFromList` |
| preload | `ccpit/src/preload/index.ts:68-78` | `projectsDiscover` / `projectsImport` / `projectsRemoveFromList` |
| 統合点 | `ccpit/src/renderer/src/pages/ProjectsPage.tsx:192-203` / `:262-283` | ツールバーボタン + Dialog 配線（`useFeatureFlag('detectLinkRemove')` ガード） |

### Discovery のデータフロー

```
ユーザーがフォルダ選択
  → ProjectDiscoveryDialog で window.api.projectsDiscover(rootPath)
  → IPC 'projects:discover' (ipc.ts:75)
  → listManagedPaths() で既存登録パス取得
  → discoverClaudeProjects(rootPath, managed) (projectDiscovery.ts:63)
    → walkClaudeMd(rootPath, maxDepth=4) で再帰走査
       - 隠しディレクトリ ('.' 始まり) スキップ
       - EXCLUDE_DIR_NAMES (node_modules, dist, build, out, target, .cache, .next, .turbo) スキップ
       - readdir 失敗時は黙って continue（権限拒否でも全体走査継続）
    → 各 dir について alreadyManaged を toLowerCase() 比較で判定（Windows 大文字小文字無視）
  → DiscoveryCandidate[] を返却
  → ChkBox 一覧表示（alreadyManaged は disable）
  → ユーザーが Select → Import
  → window.api.projectsImport(paths) → importProjects(paths)（projects.ts:149）
    → 既存登録パスは toLowerCase() 比較でスキップ
    → location_type: 'local', favorite: false で追加
  → onImported → loadProjectList で UI 再描画
```

### Remove from List のデータフロー

```
ユーザーが Remove from List ボタン
  → RemoveFromListDialog（既存 PJ リスト + 黄色警告「This does NOT delete files」）
  → 選択 → Confirm
  → window.api.projectsRemoveFromList(paths) → removeProjectsFromList(paths)（projects.ts:180）
    → projects.json filter で当該パス除外
    → ファイルシステム一切触らない（CLAUDE.md / .ccpit / .claude/ すべて無傷）
  → onRemoved → loadProjectList で UI 再描画
```

### 依存する Feature Flag

- `detectLinkRemove`: ProjectsPage の Discover / Remove from List ボタンと Dialog 全体を表示するか（`ProjectsPage.tsx:192-203, 262-283`）

## 故障モード一覧

### FM-B-01: Discovery でプロジェクトが見つからない

- **症状**: フォルダ選択 → Scan しても候補が空、または明らかに `CLAUDE.md` を持つ PJ が出てこない
- **影響範囲**: 特定フォルダのみ、または全体
- **既知の発生事例**: なし

#### 原因候補

1. 走査深度 `DEFAULT_MAX_DEPTH=4` を超える深さに PJ がある
2. PJ が `EXCLUDE_DIR_NAMES`（node_modules / dist / build / out / target / .cache / .next / .turbo）配下にある
3. PJ ディレクトリ名が `.` で始まる（隠しディレクトリ扱い）
4. `readdir` が permission denied を返し走査が止まる（黙って continue するため候補が欠ける）
5. `CLAUDE.md` のファイル名が大文字小文字違い（macOS 互換 / 一部 Windows ファイルシステム）

#### 確認手順

1. `ccpit/src/main/services/projectDiscovery.ts:14-23` の `EXCLUDE_DIR_NAMES` を確認。当該 PJ がこのいずれかの配下にないか
2. `ccpit/src/main/services/projectDiscovery.ts:13` の `DEFAULT_MAX_DEPTH = 4`。PJ の深さを `dir/sub1/sub2/sub3/sub4/CLAUDE.md` まで許容、それ以上は見逃す
3. PJ ディレクトリ名が `.` で始まっていないか（`.foo/CLAUDE.md` は走査対象外）
4. PowerShell で `Get-ChildItem -Path <root> -Recurse -Filter CLAUDE.md -Depth 4` で実行し、CC 側と差を取る
5. `walkClaudeMd` の `entries.some((e) => e.isFile() && e.name === 'CLAUDE.md')` は完全一致比較。ファイル名が `claude.md`（小文字）の場合は引っかからない

#### 修正担当ファイル

- 主担当: `ccpit/src/main/services/projectDiscovery.ts:29-57`
- 副担当: なし

#### 関連 vitest ケース

- 現状なし。`walkClaudeMd` は OS 依存だがテスト書ける（tmpdir に擬似 PJ 構造を作る）

#### 修正時の注意

- `DEFAULT_MAX_DEPTH` を増やすと再帰回数が爆発する（走査時間 O(N^4) → O(N^5) 等）。設定値を増やす場合はユーザーに見える設定 UI を作って対応
- `EXCLUDE_DIR_NAMES` から要素を消すと、ビルド成果物に紛れ込んだ `CLAUDE.md` を拾い始める（goose: monorepo の `dist/` 配下に dummy CLAUDE.md がある等）
- 規範的読み: 走査深度のマジックナンバー `4` は `projectDiscovery.ts:13` で定数化されている。深度を変えるなら定数定義のみ書き換える

### FM-B-02: Discovery で候補が出すぎる（過剰検出）

- **症状**: ビルド成果物・テストフィクスチャ等にも `CLAUDE.md` があり、当該行が候補に出てくる
- **影響範囲**: 特定 root 配下
- **既知の発生事例**: なし

#### 原因候補

1. `EXCLUDE_DIR_NAMES` に当該フォルダ名が含まれていない（`.git`, `coverage`, `tmp` 等が漏れ）
2. 隠しディレクトリ判定（`.` 始まり）に該当しない名前のキャッシュフォルダ
3. 同一 PJ 配下のサブディレクトリに `CLAUDE.md` があり、本体と子の両方が候補化

#### 確認手順

1. 候補一覧を観察し、明らかにビルド成果物の path が紛れ込んでいないか
2. `projectDiscovery.ts:14-23` の `EXCLUDE_DIR_NAMES` Set に当該名を追加候補とする
3. PJ 内に複数の `CLAUDE.md` がある場合、`walkClaudeMd` は **全部** push する（重複チェックなし）。意図的にサブ PJ を持つ monorepo は問題化しない

#### 修正担当ファイル

- 主担当: `ccpit/src/main/services/projectDiscovery.ts:14-23`

#### 関連 vitest ケース

- 現状なし

#### 修正時の注意

- 安易に `EXCLUDE_DIR_NAMES` に追加すると、ユーザーが意図的にそこに置いた PJ を見逃す（フェイルセーフとフェイルオープンのトレードオフ）
- monorepo 対応で「PJ ルート優先」を入れる場合は別機能として設計（本機能の現スコープ外）
- 規範的読み: 「EXCLUDE_DIR_NAMES」というハードコード Set は将来 user 設定に昇格すべき。後続 CC が拡張する際の設計余地

### FM-B-03（致命）: Remove from List で実ファイルが消えた

- **症状**: Remove from List 実行後に `CLAUDE.md` / `.ccpit/` / その他 PJ 本体ファイルが消えている
- **影響範囲**: 致命。**絶対起きてはいけない**
- **既知の発生事例**: なし。安全装置の検証対象として警戒

#### 原因候補

1. `removeProjectsFromList` が `unlink` / `rm` 系を呼んでいる（実装事故）
2. 別経路（`removeProject` 等）が混線して呼ばれている
3. ユーザーが Discovery と Remove を混同して、Remove ダイアログから `Refresh` ボタン経由で別操作が走る

#### 確認手順

1. `ccpit/src/main/services/projects.ts:180-191` の `removeProjectsFromList` を読む。**`saveProjects` のみ呼び、`unlink` / `rm` を使わない**ことを必ず確認
2. `RemoveFromListDialog` の `onConfirm` ハンドラが `window.api.projectsRemoveFromList(paths)` のみ呼ぶか（`RemoveFromListDialog.tsx:26-31`）
3. IPC 名 `projects:removeFromList` と `projects:remove`（単一削除）の混同を確認。後者は `removeProject` で、これも `saveProjects` のみ（projects.ts:138-142）
4. i18n 警告キー `pages.projects.removeFromList.warning` で「This does NOT delete files」が表示されているか確認

#### 修正担当ファイル

- 主担当: `ccpit/src/main/services/projects.ts:180-191`
- 副担当: なし（fs 操作はここに局所化）

#### 関連 vitest ケース

- 現状なし。**最優先で vitest テスト追加すべき**（後続 CC への TODO）。期待値: tmpdir に PJ ディレクトリと projects.json を作り、removeProjectsFromList 後に PJ ディレクトリが残存することを assert

#### 修正時の注意

- `removeProjectsFromList` の **fs 不可侵** は機能 B の最重要不変条件。違反するとユーザー資産破壊になる
- 関数名に `delete` / `rm` を含めないこと（誤呼び出し誘発）
- 規範的読み: 致命的副作用を持ちうる関数は **黄色警告 UI + 関数名 + 単体テスト + 設計レビュー** の四重防御が必要。本機能では UI 警告と関数名は揃っているが、vitest 防御が抜けている

### FM-B-04: Select All / Deselect All が動かない

- **症状**: ボタンを押しても全選択 / 全解除されない
- **影響範囲**: Discovery / Remove from List 両方
- **既知の発生事例**: なし

#### 原因候補

1. `MultiSelectDialog<T>` の選択状態が `getKey(item)` をキーにして Set 管理している。`getKey` が unique でない（path が重複する候補がある）
2. `alreadyManaged` の disable と Select All の整合性問題（disable された行が選択候補から除外されている）
3. ChkBox の controlled / uncontrolled 切替問題

#### 確認手順

1. `ccpit/src/renderer/src/components/MultiSelectDialog.tsx` を読み、`getKey` 関数の用途を確認
2. Discovery 側 `getKey={(c) => c.path}` で path をキーにする（path が unique なら問題なし）
3. Remove 側 `getKey={(p) => p.path}` 同上
4. `alreadyManaged` の disable は Discovery 側のみ（Remove は全部削除可能）。Select All が disable 行も選んでしまっていないか確認

#### 修正担当ファイル

- 主担当: `ccpit/src/renderer/src/components/MultiSelectDialog.tsx`
- 副担当: `ProjectDiscoveryDialog.tsx` / `RemoveFromListDialog.tsx`

#### 関連 vitest ケース

- 現状なし。`MultiSelectDialog` のロジックは React Testing Library で検証可能

#### 修正時の注意

- `MultiSelectDialog<T>` は **ジェネリック**。Discovery で破壊的変更すると Remove 側も連鎖する。両方の呼び出し元の挙動を必ず手動テストする
- Discovery の `alreadyManaged` 行は disable されているのが UX 上の不変条件（既存 PJ の重複登録を防ぐ）

## 過去の修正履歴

- **024**（2026-04-29〜04-30）: 機能新規実装。`MultiSelectDialog<T>` ジェネリック化、`removeProjectsFromList` 非破壊性確保、走査深度 4 + 除外パターン 8 種

## 更新履歴

- 2026-04-30: 029 で初版作成
