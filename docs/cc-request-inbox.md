# CC Request Inbox

> CCPIT Maintenance Center の 4 番目のタブ。
> CC (Claude Code) が出力する `~/.claude/settings.json` への変更案を、人間が GUI から安全に適用するための仕組み。

---

## 機能概要

CC は `settings-guard.sh` (PreToolUse hook) と `permissions.deny` により `~/.claude/settings.json` を直接編集できない。これは MANX 安全アーキテクチャの根幹である。

CC Request Inbox は、CC が出力した「変更案 MD」を CCPIT GUI から読み込み、以下を **構造的に** 保証して適用する:

- 自動バックアップ（`~/.ccpit/settings-backups/<ts>-settings.json`）
- パスワード認証（`auth.password`）
- 適用前 JSON 構文検証
- 適用後 JSON 構文検証
- 検証失敗時の自動ロールバック
- 変更ログ追記（`~/.ccpit/settings-change-log.jsonl`）

人間の手作業は「Apply ボタンをクリック」「（必要なら）パスワード入力」のみ。

---

## 使い方

### 1. CC が変更案 MD を出力する

CC のセッション内で、settings.json への変更が必要な状況になると `settings-change-request-emitter` skill が発火し、以下の MD ファイルを出力する:

```
${cwd}/_Prompt/_SettingsChangeRequests/<timestamp>_<request-id>.md
```

例: `_Prompt/_SettingsChangeRequests/20260501_1930_add-debug-report-gate.md`

### 2. CCPIT で MD を読み込む

1. CCPIT を起動
2. Sidebar の **Settings** → **Open Maintenance** ボタンをクリック
3. Maintenance ダイアログのタブから **CC Request Inbox** を選択
4. 右上の **Open Request File...** ボタンで file picker を開き、MD を選択

### 3. 内容を確認

- **Request Details** セクションで frontmatter（目的、ID、対象、ステータス）を確認
- **Diff** セクションで現在の settings.json と変更案の差分を視覚化
- 提案された JSON が syntax error の場合、赤いエラーカードが表示される

### 4. パスワードを入力（事前登録があれば）

- `~/.claude/settings.json` の `auth.password` が登録されていれば、Authentication セクションに入力欄が表示される
- 未登録の場合は、認証スキップで Apply 可能

### 5. Apply

- 大きな **Apply** ボタンをクリック
- 内部で次が順次実行される:
  1. パスワード検証
  2. 自動バックアップ取得（`~/.ccpit/settings-backups/`）
  3. 提案 JSON の構文検証
  4. settings.json への書き込み
  5. 書込後の再検証
  6. 失敗時の自動ロールバック
  7. ログ追記

- 結果は緑（成功）/ 黄（自動ロールバック）/ 赤（失敗）で表示される

---

## ロールバック

過去のバックアップから復元する場合:

1. CC Request Inbox 内の **Rollback to a Backup** セクションを開く
2. バックアップ一覧から復元したいタイムスタンプを選び、**Rollback** ボタンをクリック
3. 確認ダイアログ → 復元実行

ロールバック実行もログに記録される。

---

## ログ確認

`Change Logs` セクションを開くと、適用 / ロールバック / 失敗の履歴を時系列で確認できる。

ログの実体は `~/.ccpit/settings-change-log.jsonl`（JSON Lines 形式）。CCPIT GUI が再表示しやすい構造化形式で保管される。

---

## トラブルシューティング

### Apply 後に Claude Code が起動しない

- 自動ロールバックが走っていれば settings.json は元に戻っている。`Change Logs` を確認
- 自動ロールバックが失敗した場合、`~/.ccpit/settings-backups/` から最新の `*-settings.json` を手動で `~/.claude/settings.json` にコピーして復旧

### パスワード認証が通らない

- `~/.claude/settings.json` の `auth.password` と入力値が完全一致している必要がある（大文字小文字含む）
- パスワード未設定の場合は、Authentication セクションに「auth.password is not set」と表示され、認証スキップで Apply できる

### 提案 JSON が syntax error と表示される

- CC が出力した MD の `## 3. 変更後の完成版` セクションの ```json ... ``` ブロックの構文が不正
- CC に修正を依頼するか、人間が MD を直接修正してから再度 Open Request File... する

---

## アーキテクチャ

```
CC （settings-change-request-emitter skill）
   ↓ MD ファイル生成
${cwd}/_Prompt/_SettingsChangeRequests/<ts>_<id>.md
   ↓ 人間が file picker で選択
CCPIT (CC Request Inbox タブ)
   ├─ パース・diff 表示
   ├─ パスワード認証
   └─ Apply
       ↓ Electron Main プロセス
       ↓ ~/.claude/settings.json （書込）
       ↓ ~/.ccpit/settings-backups/<ts>-settings.json （バックアップ）
       └─ ~/.ccpit/settings-change-log.jsonl （ログ）
```

CC は Read のみ、Edit/Write は禁止。CCPIT Electron Main プロセス（人間の操作下）のみが書き込みを行う。
