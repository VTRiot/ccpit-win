# 機能 A — CC 起動ボタン + 起動オプションメニュー

## 機能概要

ProjectsPage の各 PJ 行に表示される **Launch ボタン + ⋯ メニュー**。

- Launch ボタン: 当該 PJ のディレクトリで Claude Code（CC）を起動する
- ⋯ メニュー: 起動オプション（Skip Permissions / Permission Mode / Continue Last / Resume / Verbose / Add-Dir / IDE / Effort）+ Edit Marker / Re-scan Marker（編集マーカーは機能 C）
- シェル選定: `wt.exe`（Windows Terminal）優先 → 失敗時 `powershell.exe` フォールバック
- 起動方式: `spawn` の `detached: true, stdio: 'ignore', shell: false` で fire-and-forget
- 起動オプションは `localStorage` の `ccpit-launch-options` キーで永続化（per-user 設定、PJ ごとではない）

正式仕様は FSA r4 §機能 A、および 024 完了報告 §機能 A を参照。

## アーキテクチャ

### 関連ファイル

| 役割 | パス | 備考 |
|---|---|---|
| UI コンポーネント | `ccpit/src/renderer/src/components/LaunchMenu.tsx` | Launch ボタン + ⋯ メニュー本体 |
| 起動オプション lib | `ccpit/src/renderer/src/lib/launchOptions.ts` | `LaunchOptions` 型 / `buildFlags()` / `loadLaunchOptions` / `saveLaunchOptions` / `PERMISSION_MODES` / `EFFORT_LEVELS` / `DEFAULT_OPTIONS` |
| main 起動処理 | `ccpit/src/main/services/ccLaunch.ts` | `launchCc()` / `whichExe()` / シェル選定 |
| IPC 配線 | `ccpit/src/main/ipc.ts:146` | `cc:launch` ハンドラ登録 |
| preload | `ccpit/src/preload/index.ts:122-125` / `ccpit/src/preload/index.d.ts:93-95` | `window.api.ccLaunch` 公開 |
| 統合点 | `ccpit/src/renderer/src/pages/ProjectsPage.tsx:345-353` | LaunchMenu の呼び出し（`useFeatureFlag('ccLaunchButton')` ガード） |
| Feature Flag | `ccpit/src/renderer/src/hooks/useFeatureFlag.ts` の `'ccLaunchButton'` |  |

### データフロー

```
ユーザーが Launch クリック
  → LaunchMenu.handleLaunch() (LaunchMenu.tsx:59-68)
  → buildFlags(opts) で flag 配列組立
  → window.api.ccLaunch({ projectPath, flags }) (preload/index.ts:122)
  → IPC 'cc:launch' (ipc.ts:146)
  → launchCc(args) (ccLaunch.ts:36)
  → whichExe('wt.exe') 検出
    → 見つかれば: spawn(wt, ['-d', projectPath, 'powershell.exe', '-NoExit', '-Command', claudeCmd], { detached: true, stdio: 'ignore', shell: false })
    → なければ:   spawn(ps, ['-NoExit', '-Command', `cd '${projectPath}'; ${claudeCmd}`], 同上)
  → child.unref() で fire-and-forget
  → { shell, spawned, error? } を返す
  → LaunchMenu.handleLaunched 経由で ProjectsPage のバナーへ
```

### 依存する Feature Flag

- `ccLaunchButton`: ProjectsPage で LaunchMenu 全体を表示するか（`ProjectsPage.tsx:345`）
- `editMarkerUI`: ⋯ メニューの末尾に Edit Marker / Re-scan Marker 項目を出すか（`LaunchMenu.tsx:208`、機能 C 由来）

両方 OFF にすると Launch ボタン自体が消える（hidden、disable ではない）。

## 故障モード一覧

### FM-A-01: Launch ボタンを押しても CC が起動しない

- **症状**: クリックしてもターミナルが開かない、エラーバナーが「No shell found」と表示される、または無反応
- **影響範囲**: 全 PJ。ただし PATH 環境変数の状態に依存
- **既知の発生事例**: なし（024 直後の手動テストでは PASS）。回帰時の警戒対象

#### 原因候補

1. `wt.exe` も `powershell.exe` も `PATH` に存在しない（最も可能性高）
2. `process.env.PATH` が main プロセスから読めていない（Electron の env 引き継ぎ問題）
3. `claude` コマンド本体が `PATH` にない（CC 未インストール / CC 配下の bin に PATH が通っていない）
4. `spawn` 呼び出しが OS の権限で拒否されている（AV / EDR の干渉）

#### 確認手順

1. `ccpit/src/main/services/ccLaunch.ts:11-18` の `whichExe()` を読む。`process.env.PATH` を分割して `existsSync` で各候補を探す実装
2. main プロセスから観測した PATH を確認: ProjectsPage 上で起動失敗エラーバナーが「No shell found (wt.exe or powershell.exe)」かを確認（`ccLaunch.ts:76`）
3. ターミナルで `where wt.exe` / `where powershell.exe` / `where claude` を実行し、見つかるか確認
4. 起動成功した場合の表示は ProjectsPage バナー「{shell} で起動しました」（i18n キー `pages.projects.launch.successWith`）。`shell` の中身が `wt.exe` か `powershell.exe` かを観察
5. CC が起動するが claude コマンドが「コマンドが見つかりません」と言う場合は、PATH ではなく CC 本体の問題

#### 修正担当ファイル

- 主担当: `ccpit/src/main/services/ccLaunch.ts:11-77`
- 副担当: なし（PATH 探索ロジックは whichExe に集約）

#### 関連 vitest ケース

- 現状なし。`ccLaunch.ts` の単体テストは 028 時点で未整備（OS 依存・spawn 副作用のためモックが必要）

#### 修正時の注意

- `shell: false` を絶対に変えるな。`true` にすると引数の quote 処理が OS 任せになり、パスにスペースを含む PJ で破綻する
- `detached: true` + `child.unref()` の組み合わせは fire-and-forget の必須条件。`child.unref()` を消すと Electron アプリ終了時に子プロセスが死ぬ
- wt.exe の引数順序（`-d <path>` → `powershell.exe` → `-NoExit` → `-Command` → `claudeCmd`）は wt の引数規則。順序を変えると wt が prompt を表示せず即終了する

### FM-A-02: 起動するが指定オプション（ChkBox / Dropdown）が反映されない

- **症状**: チェックを入れても CC が当該フラグなしで起動する、または前回値で起動する
- **影響範囲**: 全 PJ・全オプション、もしくは特定オプションのみ
- **既知の発生事例**: なし

#### 原因候補

1. `localStorage` への書き込み失敗（Quota 超過 / IndexedDB 連動エラー）
2. `loadLaunchOptions` が JSON parse に失敗してデフォルトを返している（`localStorage` 内容が壊れている）
3. `buildFlags(opts)` が当該 opt を flag に変換していない（lib のバグ、未実装オプション）
4. `update()` 関数の closure が古い `opts` を保持している（State の整合性問題）

#### 確認手順

1. ブラウザ DevTools の Application タブで `localStorage` の `ccpit-launch-options` キーを確認。値が JSON として正しいか
2. `ccpit/src/renderer/src/lib/launchOptions.ts` の `buildFlags()` を読み、当該オプションが flag 配列に変換されるルートを追跡
3. LaunchMenu.tsx の `update()` 関数（`LaunchMenu.tsx:53-57`）が `setOpts(next)` の **後** に `saveLaunchOptions(next)` を呼んでいるか
4. 起動コマンドに含まれる flag を確認: `ccLaunch.ts:46` の `claudeCmd` を console.log で観察、もしくは wt 経由で開いた PowerShell の上で `claude --help` でコマンド構文を確認

#### 修正担当ファイル

- 主担当: `ccpit/src/renderer/src/lib/launchOptions.ts`（buildFlags の判定）
- 副担当: `LaunchMenu.tsx:46-57`（State / update 関数）

#### 関連 vitest ケース

- 現状なし。`buildFlags()` は pure 関数なので vitest 化候補（後続 CC への TODO）

#### 修正時の注意

- `--enable-auto-mode` は CC v2.1.111 で **廃止**。`--permission-mode auto` を使う（024 完了報告 §Phase 0 参照）
- `--permission-mode` の値は CC が受け付ける enum（`PERMISSION_MODES`）と完全一致させる。typo は CC 側でエラーになり起動失敗
- 1 行コマンドの quoting に注意: `claudeCmd = ['claude', ...flags].join(' ')`（`ccLaunch.ts:46`）。flag 内に空白を含む値を渡すと PowerShell でパースが破綻する → 値はクォート済みの文字列で flags 配列に入れる

### FM-A-03: ⋯ メニューの一部項目がクリックできない / 値が変わらない

- **症状**: Permission Mode の Dropdown が選べない、Effort の値が固定、Resume / Add-Dir の Input が押下不可
- **影響範囲**: 特定 ChkBox / Dropdown のみ
- **既知の発生事例**: なし

#### 原因候補

1. shadcn DropdownMenu の `onSelect` が `e.preventDefault()` を呼んで close を阻止している（仕様）
2. Resume / Add-Dir の Input が `enabled` ChkBox によって `&&` ガードされている（`LaunchMenu.tsx:144` / `:172`）
3. `<select>` の `value` が `opts.permissionMode` だが、`PermissionMode` 型に存在しない値が localStorage から読まれて controlled component が壊れている

#### 確認手順

1. `LaunchMenu.tsx:113-124` の Permission Mode `<select>` の onChange を確認。`update('permissionMode', e.target.value as PermissionMode)` がそのまま型キャスト → 型外の値が来ると runtime で残る
2. `localStorage` の `ccpit-launch-options` を確認。`permissionMode` が `PERMISSION_MODES` のいずれかか
3. Resume / Add-Dir の Input が `opts.resume.enabled` / `opts.addDir.enabled` の ChkBox 連動で表示制御されている。ChkBox 自体は別物
4. shadcn DropdownMenuItem の `onSelect` ハンドラが Edit/Re-scan の 2 項目に存在。それ以外（オプション ChkBox）は普通の `<label>` + `Checkbox` 構造で DropdownMenuItem を使っていない

#### 修正担当ファイル

- 主担当: `ccpit/src/renderer/src/components/LaunchMenu.tsx:100-205`
- 副担当: `ccpit/src/renderer/src/lib/launchOptions.ts`（型ガード強化）

#### 関連 vitest ケース

- 現状なし

#### 修正時の注意

- `<select>` を `as PermissionMode` でキャストしている箇所は **型ガード回避**。後続 CC が `loadLaunchOptions` で値の正当性チェックを足すと安全
- DropdownMenu の `align="end"` と `className="w-80 p-3"` は UI レイアウト依存（小さい画面で右端に張り付く）。むやみに削るな

### FM-A-04: AutoMode 関連の挙動異常

- **症状**: AutoMode で起動したいが Permission Mode に「auto」が見えない、または「auto」を選んでも CC が反応しない
- **影響範囲**: AutoMode を使うユーザーのみ
- **既知の発生事例**: 設計時には CC v2.1.111 で `--enable-auto-mode` が廃止され `--permission-mode auto` に統合された（024 §Phase 0 参照）

#### 原因候補

1. CC 本体が古い（v2.1.111 未満）で `--permission-mode auto` を認識しない
2. `PERMISSION_MODES` 配列に `auto` が含まれていない
3. `buildFlags()` が `--enable-auto-mode` 旧仕様で flag を吐いている

#### 確認手順

1. ターミナルで `claude --version` を確認。v2.1.111 以上でない場合は CC 自体を更新
2. `ccpit/src/renderer/src/lib/launchOptions.ts` で `PERMISSION_MODES` 配列をチェック。`'auto'` が含まれているか
3. `claude --permission-mode auto` を手で叩いて CC が起動するか単体検証
4. 過去のドキュメント参照: 024 完了報告 §Phase 0 末尾「v2.1.111 で `--enable-auto-mode` 廃止 → `--permission-mode auto` を採用」

#### 修正担当ファイル

- 主担当: `ccpit/src/renderer/src/lib/launchOptions.ts`（`PERMISSION_MODES` / `buildFlags`）

#### 関連 vitest ケース

- 現状なし

#### 修正時の注意

- CC 側のフラグ仕様は破壊的変更が起こりうる（v2.1.111 の例）。**CC のバージョン依存表** を本機能の章末尾にメンテすると後続が助かる（後続 CC への TODO）
- 後方互換のために旧 `--enable-auto-mode` を温存しないこと。CC 本体側で deprecated → removed されると壊れる

### FM-A-05: 起動成功後にバナーが表示されない / 消えない

- **症状**: 起動はするがバナー（緑/赤の通知）が出ない、または 3 秒後に消えるはずが残り続ける
- **影響範囲**: 全 PJ
- **既知の発生事例**: なし

#### 原因候補

1. `setLaunchMessage` の `setTimeout(_, 3000)` がアンマウント時にクリアされていない
2. 連続クリックで `setTimeout` が複数走り、後発の `setLaunchMessage(null)` が先発のメッセージを消す
3. `result.spawned` が常に true として返るため成功バナーしか出ない

#### 確認手順

1. `ccpit/src/renderer/src/pages/ProjectsPage.tsx:58-65` の `handleLaunched` を確認。`result.spawned` 真偽で ok/err 切替、3 秒後にクリア
2. `ccLaunch.ts:50-57` / `:64-71` の例外ハンドリング。spawn が同期 throw する場合のみ false。実行時のエラー（claude コマンドが死ぬ等）は親プロセスから見えないことに注意
3. バナー DOM が `launchMessage` ステートに反映されていることを確認: `ProjectsPage.tsx:210-221`

#### 修正担当ファイル

- 主担当: `ccpit/src/renderer/src/pages/ProjectsPage.tsx:58-65`
- 副担当: `ccpit/src/main/services/ccLaunch.ts:36-77`

#### 関連 vitest ケース

- 現状なし

#### 修正時の注意

- **fire-and-forget** の構造上、CC 起動後にプロセスが落ちても親（CCPIT）からは検知できない。バナーは「spawn 自体が成功したか」のみ。「CC が正しく動き続けているか」は別問題
- 規範的読み: 「CC の死活監視まで CCPIT 側で持つべきか」は将来の議論。MVP では fire-and-forget が正しい設計判断

## 過去の修正履歴

- **024**（2026-04-29〜04-30）: 機能新規実装。wt.exe 優先 + powershell.exe フォールバック、基本 8 オプション、`--permission-mode auto` 採用
- 026 / 028 ではこの機能には触れていない（Edit Marker / Re-scan Marker 項目の追加は機能 C）

## 更新履歴

- 2026-04-30: 029 で初版作成（指示書 029）
