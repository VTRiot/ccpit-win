---
name: settings-change-request-emitter
description: ~/.claude/settings.json への hook 追加・deny ルール追加・auth 設定変更等が必要になった際、CCPIT の CC Request Inbox 経由で人間が承認・適用できる形式の「変更案 MD ファイル」を出力するために発火する
---

# settings-change-request-emitter — settings.json 変更案 MD 出力 skill

## 0. このスキルの役割

CC（あなた）は安全アーキテクチャに従い `~/.claude/settings.json` を **直接編集できない**。`Edit/Write` は `settings-guard.sh` (PreToolUse hook) と `permissions.deny` で物理的にブロックされている。

settings.json への変更が必要になった場合、本スキルを発火させて **CCPIT GUI に渡す変更案 MD ファイル** を出力する。人間は CCPIT の `CC Request Inbox` タブからこの MD を読み込み、diff 確認 → パスワード認証 → Apply の操作で安全に変更を適用する。

これにより:
- 人間の手作業（VS Code で開く・コピペ・バックアップ）が GUI のクリック数アクションに圧縮される
- バックアップ・JSON 構文検証・失敗時自動ロールバックが構造的に保証される
- CC のアウトプットが統一フォーマットになる

## 1. 発火条件

以下のいずれかに該当する場合、本スキルを発火する:

- `~/.claude/settings.json` の `hooks` セクションに新規 hook を追加したい
- `permissions.deny` / `permissions.allow` を変更したい
- `auth.password` を変更したい（人間に依頼する正当な経路として）
- その他 settings.json 内のキー・値を追加・変更・削除したい

CC が `settings.json` 編集の必要性を内的に検知した時点で、本スキルが優先発火する。

## 2. 出力プロトコル

### 2-1. 配置先

```
${cwd}/_Prompt/_SettingsChangeRequests/<timestamp>_<request-id>.md
```

- `${cwd}` = CC の現在の作業ディレクトリ
- `<timestamp>` = `YYYYMMDD_HHMM` 形式（実際にファイルを生成した時刻、推定値や丸め禁止）
- `<request-id>` = 短い識別子（kebab-case 推奨。例: `add-debug-report-gate`, `update-deny-list`）

ディレクトリが存在しない場合は `mkdir -p` で作成。

### 2-2. ファイル形式

```markdown
---
request_id: <unique id, ファイル名の <request-id> と一致>
created_at: <ISO 8601 datetime, 例: 2026-05-01T19:30:00Z>
purpose: <1 行説明、例: debug-report-gate.sh を Stop hook に追加>
target: ~/.claude/settings.json
status: pending
---

## 1. 変更概要

（人間可読、なぜこの変更が必要か。1〜3 段落）

## 2. 現状の関連箇所

```json
（参考のため、現在の settings.json から該当部分を引用。
 全文不要、関連する hooks セクションのみ等で OK）
```

## 3. 変更後の完成版

```json
（settings.json **全文**。CCPIT は全文置換で適用する。
 既存キーを失わないよう、現在の settings.json を Read してから完成版を組み立てよ）
```

## 4. 変更理由

（詳細な理由。なぜこの設定が必要か、どの問題を解決するか）

## 5. 影響範囲

（他の hook や設定との相互作用、副作用）

## 6. ロールバック手順

（自動ロールバックの想定挙動。CCPIT は backup を自動取得するので、
 「CCPIT で Rollback ボタンをクリック」が標準手順）
```

### 2-3. 重要な作成手順

1. **`Read` で現在の settings.json を読む**（必須。Edit/Write は禁止だが Read は許可）
2. 既存全キーを保持したうえで、変更箇所のみを差し替えた **完成版 JSON** を作成する
3. JSON 構文の正しさを自分で目視確認する（CCPIT 側でも検証されるが、CC の責任として最低限の確認をする）
4. MD ファイルを上記フォーマットで出力する

## 3. 配布対応の制約

本スキルが出力する MD には、以下を **混入させない**:

- ユーザー個人の固有名詞（人名、会社名、PJ コードネーム、製品名等）
- AI セッションの命名（過去のセッション名、CC 自身の名前等）
- 内部開発コードネーム

`purpose` や `## 4. 変更理由` セクションは、当該の技術的な目的のみを記述する。

## 4. CCPIT 側との連携

人間は CCPIT を起動 → Maintenance → "CC Request Inbox" タブを開き、本スキルが出力した MD を file picker で読み込む。CCPIT は:

1. frontmatter と本文をパースして詳細表示
2. 現在の settings.json と「## 3. 変更後の完成版」の diff を視覚化
3. パスワード認証（`auth.password`）を要求
4. Apply ボタンで自動バックアップ → 書き込み → 検証 → 失敗時自動ロールバック
5. ログを `~/.ccpit/settings-change-log.jsonl` に記録

## 5. 完了確認

本スキルを発火して MD を出力したら、CC は会話中で以下を人間に伝える:

- MD ファイルパス（具体的な場所）
- 変更目的（1 行）
- 「CCPIT の CC Request Inbox タブから読み込み、Apply してください」という案内

CC は **settings.json 自体を直接編集しない**。それは安全アーキテクチャの根幹である。
