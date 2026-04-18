---
description: Fires when modifying library or framework code
globs: "*.py,*.js,*.ts,*.c,*.cpp,*.rs"
---

# Library Design Intent Check (mandatory before modifying code)

1. Before making changes, actually read the target code and note the design intent.
2. If the author already provides a legitimate configuration knob, prefer changing the configuration over patching the code.
3. Do not reinvent the wheel.
4. The code in the original upstream repository is the canonical source of design. Locally patched code is a derivative, not the author's design.
