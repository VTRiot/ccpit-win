---
name: skill-distribution-bundler
description: Fires when distributing or gifting a home-grown skill / script set to another user or another environment (including a different OS) in an importable form. Runs one continuous gate covering sanitization of private proper nouns, cross-platform porting of OS-dependent code, bundling an install README for the recipient, syntax / dry-run verification, and ZIP packaging.
---

# skill-distribution-bundler — the distribution-bundling gate

## When to fire
- "I want to hand / distribute / gift / share this skill or tool to someone."
- "Package it so it can be imported", "make a bundle/ZIP with a README".
- This is NOT for bringing something *into* your own host (inbound). This skill is outbound only (sending your own work out to others).

## Core principles
- **The original skill / files stay unmodified.** Always make a copy in a separate folder; edit only the copy.
- Apply "a working thing is the first responsibility" to the distributed artifact. Syntax OK / typecheck OK are preconditions, not completion criteria. It is done only once it is in a form that works in the recipient's environment.
- Irreversible operations (overwriting the original files, replacing an existing distributed artifact) require confirmation beforehand.

## Workflow

### 1. Pin down the recipient profile (always first)
- Pin down the recipient's OS (Win / macOS / Linux), runtime (pwsh / python / node, etc.), and authentication premises (whether an API key is needed, whether a login is needed).
- If unknown, ask. Getting the OS wrong changes the whole porting approach, so do not guess here.

### 2. Build the copy base
- Create a staging directory for distribution and copy the whole target set into it.
- Logic files (.ps1/.py/.js, etc.) are copied unmodified as a rule. Documents (.md) are subject to sanitization.

### 3. Sanitize private proper nouns (exhaustive grep)
- Sweep out person names, company names, project codenames, AI session names, internal development jargon, and internal document references (canonical-source paths, etc.) with an **exhaustive grep**, and replace them with generic wording.
- Within the range that **does not change the logic's behavior**, also clean up internal jargon in comments and runtime message strings (especially strings that surface on the recipient's screen).
- After replacing, grep again and confirm zero remain (do not stop at the first hit).

### 4. Port OS-dependent code cross-platform (exhaustive grep)
- Sweep out OS dependencies with an exhaustive grep (e.g. `$env:USERPROFILE` / `%USERPROFILE%` / `$HOME`, drive letters like `C:\`, `\`-separated paths, OS-specific commands, line endings).
- Fix only what breaks on the destination OS, minimally. Move to portable forms (e.g. resolve home with a `$HOME` fallback when the environment variable is absent, plus OS-native path joining; normalize paths to forward slashes).
- Separate "places that break the destination in real logic" from "mere prose", and make sure the former are actually fixed.

### 5. A README for the recipient (mandatory inclusion)
- Put a README written from the recipient's point of view at the top of the bundle. At minimum: what the tool is / premises (runtime, authentication, install steps) / install location and placement commands / smoke test (a connectivity check that generates and runs nothing, plus a real-run check) / principal options / a manifest (a list of what is included and the provenance of each file) / cautions (rights, safety).
- State in the README's manifest/provenance section what the porting changed (unmodified, or exactly what was fixed).

### 6. Verification (mandatory before reporting — never declare completion on a guess)
- Syntax-parse-verify the scripts (every file). Where possible, confirm the wiring through a side-effect-free path such as a dry run.
- If an end-to-end real run is impossible in this environment, say so honestly as "unverified" and write it into the README as a first-run check item for the recipient.

### 7. ZIP packaging and content check
- For ZIP creation you may reuse the packaging from the review-bundle-zip family.
- **Always check the list of entries inside the ZIP**: does it match the expected tree, and is there any contamination by `.bak` files, verification scripts, temp files, etc.?
- Report the distributed artifact's path, what is included, the verification results, and any unverified items, concisely.

## Checklist (completion gate)
- [ ] Original files unmodified (edits made only to the copy)
- [ ] Zero private proper nouns remaining (re-grepped after replacement)
- [ ] OS dependencies exhaustively checked and ported (works on the recipient's OS)
- [ ] Recipient README included (premises / setup / smoke test / manifest / cautions)
- [ ] All scripts syntax-OK, plus a side-effect-free wiring check where possible
- [ ] ZIP contents checked (expected tree / no contamination)
- [ ] Any unverified items stated honestly

## Cautions
- Check copyright, licensing, and rights notices before distributing. Inspect whether third-party material may be included.
- Do not leave private settings (personal paths, tokens, local-only premises) in the distributed artifact.
