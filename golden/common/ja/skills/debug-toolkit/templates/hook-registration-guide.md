---
type: setup-guide
target: ユーザー（人間）
created_at: 2026-04-30
---

# debug-report-gate hook 登録ガイド

## 概要

debug-toolkit skill の強制インターロックを有効化するため、`debug-report-gate.sh` を Claude Code の Stop hook として `settings.json` に登録する。本ガイドは **ユーザー（人間）** が実施する手順を示す。CC は `settings.json` を直接編集できないため、登録作業は人間が行う。

## 前提

- `~/.claude/hooks/debug-report-gate.sh` が配置済み（debug-toolkit skill インストール時に同梱）
- スクリプトに実行権限がある（chmod +x）
- `~/.claude/settings.json` が存在する

## 登録手順

### Windows

```powershell
# 1. settings.json をバックアップ
Copy-Item "$env:USERPROFILE\.claude\settings.json" "$env:USERPROFILE\.claude\settings.json.bak.$(Get-Date -Format yyyyMMddHHmmss)"

# 2. settings.json を VS Code 等で開く
code "$env:USERPROFILE\.claude\settings.json"
```

### Linux/macOS

```bash
# 1. settings.json をバックアップ
cp ~/.claude/settings.json ~/.claude/settings.json.bak.$(date +%Y%m%d%H%M%S)

# 2. settings.json を編集
${EDITOR:-vi} ~/.claude/settings.json
```

## settings.json への追記内容

既存の `hooks` セクションに `Stop` 配列の要素として `debug-report-gate.sh` を追加する。

### 既存の Stop hook がない場合

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$HOME/.claude/hooks/debug-report-gate.sh"
          }
        ]
      }
    ]
  }
}
```

### 既存の Stop hook（report-gate 等）がある場合

既存配列に追加する:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$HOME/.claude/hooks/report-gate.sh"
          },
          {
            "type": "command",
            "command": "$HOME/.claude/hooks/debug-report-gate.sh"
          }
        ]
      }
    ]
  }
}
```

## 登録後の動作確認

1. デバッグタスクを開始（debug-toolkit skill が発火する状況を作る）
2. `~/.claude/skills/debug-toolkit/templates/debug-report-template.md` をタスク用パスにコピー
3. **意図的に §1 観察事実を空欄のまま** 完了宣言を出す
4. hook が block して、`reason` フィールドのメッセージが返ることを確認
5. 必須セクションを埋めると完了が通ることを確認

## トラブルシューティング

### hook が発火しない

- スクリプトに実行権限があるか確認: `ls -la ~/.claude/hooks/debug-report-gate.sh`
- パスが正しいか確認: `$HOME/.claude/hooks/debug-report-gate.sh` で展開できているか
- settings.json の JSON 構文が正しいか確認（カンマの過不足、括弧の対応）

### hook が block しすぎる

- debug-report-template.md がコピーされていないタスクで block される場合、hook 内の検出ロジックを確認
- 想定: `_Prompt/_DebugReports/` 配下に `*.md` で `status: in_progress` のものがあるときのみ block

### settings.json が壊れた

- バックアップから復元: `cp ~/.claude/settings.json.bak.YYYYMMDDHHMMSS ~/.claude/settings.json`

## 注意事項

- settings.json の編集は CC では実施しない（safety-principles 準拠）
- バックアップは必ず取る
- 構文エラーがあると Claude Code が起動しなくなる可能性がある。慎重に編集する
