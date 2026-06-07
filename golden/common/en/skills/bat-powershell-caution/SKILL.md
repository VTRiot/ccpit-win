---
name: bat-powershell-caution
description: Fires when writing, fixing, or debugging batch scripts (.bat / .cmd) or PowerShell scripts (.ps1).
---

# Cautions for batch scripts / PowerShell

## Known batch-script problems

When a complex batch script (logging, subroutines, error handling, etc.)
exits **silently** or behaves **unexpectedly**, suspect the following:

### Parenthesis-parsing problem
A `)` inside a message is mis-parsed as the terminator of an `if/else` block.

### call nesting + exit /b problem
When `call other.bat` followed by `exit /b` happens inside `call :label`,
the execution context gets corrupted.

### Delayed-expansion trap
Mixing `!variable!` and `%variable%` causes unexpected expansion.

## Known PowerShell problems

### Adding comments inside a .ps1 param() block (no non-ASCII)

Windows PowerShell 5.x reads a BOM-less `.ps1` as **CP932 (ANSI)**. Because of this,
a **non-ASCII (e.g. Japanese) comment** inside the `param()` block causes the
multibyte sequence to be misread and **breaks param parsing**
(`NamedParameterNotFound`, parameter not found, etc.).
A non-ASCII comment at the top of the module is harmless, but inside the
param structure it is dangerous.

Mitigation (either one):
- Write any comment added inside `param()` in **ASCII**
- Or **save the script with a UTF-8 BOM** so PowerShell recognizes it as UTF-8

## Recommended response

- **Switching to PowerShell is recommended.** The problems above do not occur in PowerShell.
- If double-click launch is required, use a `.ps1` + `.cmd` wrapper.
- If keeping batch, minimize subroutines and parenthesis blocks.
