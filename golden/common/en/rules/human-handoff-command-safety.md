# Safety requirements for commands handed to humans

Commands the CC asks a human to run must be **safe to complete by pasting and running, on their own**.

## Prohibited
- Running scripts fetched from outside; `Invoke-Expression` / `eval` equivalents
- Requesting administrator rights that are not needed
- Wildcard or recursive deletion
- Printing secret values to stdout (have them confirm by count or boolean instead)

## Requirements
- Make it **idempotent**: running it twice breaks nothing
- Resolve the target path and confirm the real file before operating on it
- Match the shell to the human's environment (PowerShell on Windows)
- State the expected result ("this becomes 0 matches"). Do not leave interpretation to the human
- When the request comes with a report, put it in a code block in the HTML report, not only in chat

Procedures specific to editing denied files live in `rules/denied-file-handoff-as-commands.md`.
