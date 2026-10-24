# Hand off edits to denied files as commands

## Scope
Files the CC cannot edit because of deny rules or hooks, where a syntax error would propagate into safety settings, authentication, or execution control (e.g. `~/.claude/settings.json`). Low-risk reversible changes may use a simplified form.

## Norm
As a rule, do not write "open it in an editor and fix it by hand." Hand over commands that complete in a single paste, embedded in a code block in the HTML report. **Before writing "the user does this manually," always ask whether it can be handed over as a command.** Safety requirements for the commands themselves live in `rules/human-handoff-command-safety.md`.

## Why (safety, not convenience)
One syntax error makes the whole `settings.json` be skipped, which **disables every deny rule** (MANX §5-5 note 6). An edit meant to protect can wipe out the entire defense. The CC cannot repair it itself because of the deny, so recovery also falls to the human. Do not put syntax integrity on the human.

## Procedure (one execution block, fixed order)
Back up → **write the change to a temp file** → validate → **apply to the real file only if validation passes** → confirm the result. Leave no partial write. Stop on failure.

## Restore
Put it in a **separate block** labeled "run only on failure." Never mix it into the execution block: pasting everything at once would run the restore too.

## Exceptions
When turning it into a command is more dangerous, for GUI-only settings, or when the human explicitly asks to edit by hand. State the reason, the minimal steps, and how to verify.
