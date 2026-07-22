# Changelog

All notable changes to CCPIT are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/); versions follow the installer artifacts published on [Releases](https://github.com/VTRiot/ccpit-win/releases).

## [1.6.0] — 2026-07-17

### Added

- **Report HTML renderer** (`md-render` bundled skill, major upgrade): Day/Dark themes with value-dependent gradient bars, proper-noun hover tooltips, auto-hoisted conclusion panel with OK / FAIL / CAVEAT / INFO badges, H2 section tabs, per-section comments persisted in `localStorage` with resolved badges, one-click reply-prompt generation + copy, inline diagrams (vendored offline Mermaid + value-driven bars), sha1 heading anchors, and a bidirectional `--verify` (HTML ⊆ MD and MD ⊆ HTML) that fails closed on drift.
- **Bulk CC restart** — one-click, generation-flag based restart of all registered Claude Code sessions, with fail-closed process detection and a per-session confirmation preview.
- **Per-session CC identity** — a SessionStart hook atomically assigns each Claude Code session a persistent 10-hex ID, surfaced in exported session summaries.
- **Codex review gate for recommended skill proposals** — when the OpenAI Codex CLI is detected, "recommend"-badged proposals require an independent recorded review before adoption; rejection rationales are persisted for audit. Inert without Codex.

### Fixed

- **Hook coverage validation: absolute-path interpreters** — interpreter matching now normalizes the basename (directory, `.exe`, case), so hooks launched via e.g. `C:\…\bash.exe -c` are no longer misreported as missing.
- **Windows hook deploy: exec-form unification + Git Bash fail-closed** — golden templates register all gate hooks in exec form; deploy resolves the local Git Bash (scoop Git / Git for Windows; the WSL launcher is excluded) and writes its absolute path into `settings.json`. If no Git Bash can be resolved, deploy stops with guidance instead of writing hooks that would never fire.
- **Hooks survive spaces in the home path** — golden hook script arguments are double-quoted (`"$HOME/…"`), fixing silent hook failure via `bash -c` word-splitting on profile paths containing spaces.
- **Health detects non-firing hook registrations (liveness)** — validation is quote- and interpreter-aware: unquoted legacy registrations are an error on space-containing homes (informational note otherwise), and registrations pointing at the WSL launcher or a bare `bash` are flagged as non-firing instead of showing green. Re-running golden deploy migrates registrations to the quoted, absolute-path form.
- **Packaging: backup artifacts are excluded from the installer** — `*.bak*` files and the local `_bak_preserve/` staging folder are no longer bundled into the app archive or the deployed golden payload. Backups can contain superseded or pre-redaction content and have no place in a distribution.
- **Health: user-customized `CLAUDE.md` is informational, not a warning** — on golden-deployed environments, a `CLAUDE.md` that differs from the bundled golden template is now reported as `info: Modified from Golden (user-edited)` instead of `warn`, matching the `.pit` import path's existing semantics. Customizing `CLAUDE.md` is the product's normal operation, so the permanent yellow badge misread normal use as a problem. Detection of actual damage is sharpened, not lost: a missing `CLAUDE.md` remains an error, and an empty / whitespace-only file (behaviorally equivalent to missing) is now an error too — previously it hid inside the same "Modified" warning.

### Quality

- Application test suite: **667 passing** (vitest, 29 files) + md-render selftest 26/26 (ja/en); TypeScript 0 errors.
- 7 rounds of independent adversarial review (Codex CLI) on the shipped change set; final verdict: approve.
- Backward compatible / additive, with one deliberate exception on Windows: golden deploy now fail-closes when no Git Bash is present (see Fixed).

### Known issues

See [README — Known issues](./README.md#known-issues-v160) (unsigned installer / Git Bash requirement / upgrade notes for older deploys).

## Earlier versions

Releases prior to 1.6.0 predate this changelog; see the [Releases page](https://github.com/VTRiot/ccpit-win/releases) for their notes.
