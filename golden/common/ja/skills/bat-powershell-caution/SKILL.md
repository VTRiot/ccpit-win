---
name: bat-powershell-caution
description: bat スクリプト（.bat / .cmd）や PowerShell スクリプト（.ps1）を書く・修正する・デバッグする際に発火する
---

# bat スクリプト / PowerShell の注意事項

## bat スクリプトの既知問題

複雑な bat スクリプト（ログ出力、サブルーチン、エラーハンドリング等）で
**無言終了**や**予期しない動作**が発生した場合、以下を疑うこと:

### 括弧解釈問題
メッセージ内の `)` が `if/else` ブロックの終端として誤解釈される。

### call ネスト + exit /b 問題
`call :label` 内で `call other.bat` → `exit /b` が発生すると実行コンテキストが破損する。

### 遅延展開の罠
`!variable!` と `%variable%` の混在による予期しない展開。

## PowerShell の既知問題

### .ps1 の param() ブロックにコメントを足すとき（非 ASCII 厳禁）

BOM 無しの `.ps1` を Windows PowerShell 5.x は **CP932（ANSI）** として読む。このため
`param()` ブロック内に**非 ASCII（日本語等）コメント**を書くと、マルチバイト列が誤読され
**param パースが壊れる**（`NamedParameterNotFound`、パラメータが見つからない等）。
モジュール先頭の日本語コメントは無害でも、param 構造の内側は危険。

対策（いずれか）:
- `param()` 内に足すコメントは **ASCII で書く**
- または **スクリプトを UTF-8 BOM 付きで保存**して PowerShell に UTF-8 と認識させる

## 推奨対応

- **PowerShell への切り替えを推奨**。上記の問題は PowerShell では発生しない
- ダブルクリック起動が必要な場合は `.ps1` + `.cmd` ラッパーを使用
- bat を維持する場合は、サブルーチンや括弧ブロックを最小限にする
