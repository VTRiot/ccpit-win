---
name: settings-change-request-emitter
description: Fires when a change to ~/.claude/settings.json is needed (adding hooks, modifying deny rules, updating auth settings, etc.) so that CC emits a "change request" Markdown file in the standard format that the human can review and apply through the CCPIT CC Request Inbox tab.
---

# settings-change-request-emitter — Skill that emits a settings.json change-request MD

## 0. Role of this skill

CC (you) cannot directly edit `~/.claude/settings.json` per the safety architecture. `Edit/Write` is physically blocked by `settings-guard.sh` (PreToolUse hook) and the `permissions.deny` list.

When a change to settings.json is needed, fire this skill to emit a **change-request Markdown file** that the human will hand to CCPIT GUI. The human opens the CCPIT `CC Request Inbox` tab, picks the MD with the file picker, reviews the diff, enters the password, and clicks Apply.

This brings:
- The human's manual workflow (open in editor, copy/paste, take backup) collapses to a few GUI clicks.
- Backup, JSON syntax validation, and automatic rollback on failure are guaranteed structurally.
- CC's output follows a uniform format.

## 1. When to fire

Fire this skill when any of the following applies:

- You want to add a new entry under `hooks` in `~/.claude/settings.json`.
- You want to modify `permissions.deny` or `permissions.allow`.
- You want to change `auth.password` (a legitimate route via the human).
- You want to add, change, or remove any other key/value in settings.json.

The moment CC internally detects the need to modify `settings.json`, this skill fires with priority.

## 2. Output protocol

### 2-1. Output location

```
${cwd}/_Prompt/_SettingsChangeRequests/<timestamp>_<request-id>.md
```

- `${cwd}` = CC's current working directory.
- `<timestamp>` = `YYYYMMDD_HHMM` format (use the actual file generation time; do not estimate or round).
- `<request-id>` = short identifier in kebab-case (e.g., `add-debug-report-gate`, `update-deny-list`).

If the directory does not exist, create it with `mkdir -p`.

### 2-2. File format

```markdown
---
request_id: <unique id, must match the <request-id> in the filename>
created_at: <ISO 8601 datetime, e.g., 2026-05-01T19:30:00Z>
purpose: <one-line description, e.g., add debug-report-gate.sh to the Stop hook>
target: ~/.claude/settings.json
status: pending
---

## 1. Summary of the change

(Human-readable. Why is this change needed? 1–3 paragraphs.)

## 2. Relevant section of the current settings.json

```json
(For reference. Quote the relevant section of the current settings.json.
 Full content not required — the relevant hooks block etc. is enough.)
```

## 3. The complete file after the change

```json
(The **entire** settings.json. CCPIT applies it as a full-file replacement.
 Read the current settings.json first so you don't drop existing keys.)
```

## 4. Detailed reason

(Why this configuration is needed; which problem it solves.)

## 5. Impact

(Interaction with other hooks/settings, side effects.)

## 6. Rollback

(Expected automatic-rollback behavior. Since CCPIT takes a backup automatically,
 "click Rollback in CCPIT" is the standard procedure.)
```

### 2-3. Authoring procedure (important)

1. **Read the current `settings.json`** with the `Read` tool (mandatory — Edit/Write is forbidden, but Read is allowed).
2. Compose the **complete new JSON** by preserving every existing key and replacing only the changed parts.
3. Visually verify the JSON syntax yourself (CCPIT also validates, but you carry minimum responsibility).
4. Write the MD file in the format above.

## 3. Distribution constraints

The MD file emitted by this skill must NOT contain:

- Personal proper nouns of the user (people, companies, project codenames, product names, etc.).
- AI session names (past session names, CC's own name, etc.).
- Internal development codenames.

The `purpose` and `## 4. Detailed reason` sections describe only the technical purpose of the change.

## 4. CCPIT-side handoff

The human launches CCPIT → Maintenance → "CC Request Inbox" tab and loads the MD via the file picker. CCPIT will:

1. Parse the frontmatter and body and show the details.
2. Render a diff between the current settings.json and "## 3. The complete file after the change."
3. Require password authentication (`auth.password`).
4. Take an automatic backup → write → verify → rollback automatically on failure when the user clicks Apply.
5. Append a log entry to `~/.ccpit/settings-change-log.jsonl`.

## 5. After emitting

After firing this skill and writing the MD, tell the human in chat:

- The MD file path (concrete location).
- The change purpose (one line).
- "Please open the CC Request Inbox tab in CCPIT and Apply it."

CC must **never edit `settings.json` directly**. That is the foundation of the safety architecture.
