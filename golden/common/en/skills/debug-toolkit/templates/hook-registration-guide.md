---
type: setup-guide
target: User (human)
created_at: 2026-04-30
---

# debug-report-gate Hook Registration Guide

> **When CCPIT GUI is available, prefer the `CC Request Inbox` feature over the manual procedure below.**
> Have CC emit a change-request MD via the `settings-change-request-emitter` skill, then load it from the CC Request Inbox tab in CCPIT and click Apply. The entire procedure (backup, edit, syntax check, post-write verification) collapses to a few GUI clicks.
> This guide remains as the manual fallback for environments without CCPIT.

## Overview

To activate the hard interlock of the debug-toolkit skill, register `debug-report-gate.sh` as a Stop hook in Claude Code's `settings.json`. This guide describes the steps the **user (human)** performs. CC cannot edit `settings.json` directly, so registration must be done by a person.

## Prerequisites

- `~/.claude/hooks/debug-report-gate.sh` is in place (shipped with the debug-toolkit skill)
- The script has executable permission (`chmod +x`)
- `~/.claude/settings.json` exists

## Registration Steps

### Windows

```powershell
# 1. Back up settings.json
Copy-Item "$env:USERPROFILE\.claude\settings.json" "$env:USERPROFILE\.claude\settings.json.bak.$(Get-Date -Format yyyyMMddHHmmss)"

# 2. Open settings.json in VS Code or similar
code "$env:USERPROFILE\.claude\settings.json"
```

### Linux/macOS

```bash
# 1. Back up settings.json
cp ~/.claude/settings.json ~/.claude/settings.json.bak.$(date +%Y%m%d%H%M%S)

# 2. Edit settings.json
${EDITOR:-vi} ~/.claude/settings.json
```

## Content to Add to settings.json

Add `debug-report-gate.sh` as an entry in the `Stop` array of the existing `hooks` section.

### When no existing Stop hook is present

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

### When an existing Stop hook (e.g., report-gate) is present

Append to the existing array:

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

## Verification After Registration

1. Start a debugging task (a situation where the debug-toolkit skill fires)
2. Copy `~/.claude/skills/debug-toolkit/templates/debug-report-template.md` to a task-specific path
3. **Intentionally leave §1 (Observed Facts) blank** and try to declare completion
4. Confirm that the hook blocks and returns the message in the `reason` field
5. Confirm that completion passes once the required sections are filled

## Troubleshooting

### Hook does not fire

- Verify the script has executable permission: `ls -la ~/.claude/hooks/debug-report-gate.sh`
- Verify the path is correct: `$HOME/.claude/hooks/debug-report-gate.sh` should expand
- Verify settings.json JSON syntax is correct (commas, brackets)

### Hook blocks too aggressively

- If a non-debug task without a copied debug-report-template.md is being blocked, check the detection logic in the hook
- Expected: blocks only when `_Prompt/_DebugReports/` (or similar) contains `*.md` with `status: in_progress`

### settings.json was broken

- Restore from backup: `cp ~/.claude/settings.json.bak.YYYYMMDDHHMMSS ~/.claude/settings.json`

## Notes

- Do not edit settings.json from CC (per safety-principles)
- Always take a backup
- A syntax error can prevent Claude Code from starting. Edit carefully.
