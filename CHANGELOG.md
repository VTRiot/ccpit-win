# Changelog

All notable changes to CCPIT are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/); versions follow the installer artifacts published on [Releases](https://github.com/VTRiot/ccpit-win/releases).

## [1.7.0] — 2026-10-24

### Added

- **Golden configuration update check at startup** — on every launch (outside Setup), CCPIT compares the deployed golden bundle, its deploy record, and your `~/.claude` copies with content hashes, then asks per file what to do: *Overwrite (with backup)*, *Send to distribution* (promote your edit back into the bundle), *Send to distribution & Propose* (have Claude Code draft a GitHub issue), *Consult Claude Code* (a side-by-side merge consultation), *Stop asking*, or *Later*. Partial deploys are never reported as success; a rollback path archives the previous version before anything is overwritten.
- **Two-layer `settings.json` on redeploy** — redeploying golden no longer discards your own `settings.json` edits: the golden layer and your local layer are composed, and only the golden-owned keys are refreshed.
- **Bulk compose of skill proposals** — when several proposals target the same bundled skill, pick them in the Skill Proposals browser and let a background Claude Code session merge them into one composite proposal. Source proposals get *Merged into composite* / *awaiting approval* badges, progress is shown where you pressed the button, and the composite can be discarded.
- **Conflicting-proposal guidance** — when more than one proposal for the same skill is promotable, the browser explains what blocks the selection, why, and how to resolve it (including rejecting the competing proposal in place). Disabled rows now say why when clicked.
- **One-click "ask Claude Code to repair"** for proposals that failed to parse.
- **Independent review evidence** — the review gate is now route-agnostic (any recorded independent reviewer, Codex CLI included); approvals are bound to the proposal's content hash and expire on edit; forcing past the gate (break-glass) is appended to an audit log; scripts embedded in a proposal are extracted, executed, and byte-compared.
- **Adopted Skill Integrity page** — reconciles the adoption registry with `~/.claude/skills` and classifies each skill as Clean / Hash mismatch / Missing on disk / Gate-bypassed, with removal, restore, and name-collision resolution.
- **Background Claude Code (BG-CC) activity panel** — compose, independent review, and comment-response jobs run in a hidden `claude -p` session; a tray indicator opens a panel with state, elapsed time, and approximate cost. Maintenance gains a *BG-CC* tab (model-list cache clear, raw log).
- **Per-project launch options** — Bypass mode, resume session, and model are stored per project; nothing is inherited implicitly across projects, and resume session IDs are bound to the project they came from.
- **New launch models** — Opus 5.5 / Opus 5 / Sonnet 5 alongside the existing choices; the model catalog fetched at startup now reaches the UI without a remount.
- **Special entries** — pin projects that live outside the scanned roots at the top of the Projects list.
- **Health: deployed `scripts/` check** — bundled helper scripts (e.g. the review-ledger recorder) are verified to exist after deploy.
- **Golden Promotion Browser (developer mode only)** — a queue for promoting locally grown skills and out-of-band golden fixes into the distribution bundle, with diff / author statement / lane detail, exclusive lease + atomic apply, and password verification on every write. Hidden unless debug mode is on.
- **PXP dashboard (opt-in, off by default)** — CCPIT can supervise the local token-saving proxy pxpipe (third-party OSS, pinned version; see bundled NOTICE) and a bundled Japanese dashboard overlay. Adds a *Fable* launch button per project when enabled.

### Bundled golden changes

- New hooks: away-gate, comment-response-gate, context-usage-gate, file-url-backtick-gate, handover-declaration-gate, opaque-approval-gate, paste-delimiter-gate, pending-reaper, stuck-loop-gate, verification-board-gate, skill-edit-auth-guard. Existing gate hooks moved their logic into Node (`.cjs`) for faster start-up; the MANX template now registers 21 hooks (was 8).
- New skills: design-lane-order-and-review-cycle, impl-lane-plan-review-delivery-cycle, imaging-proxy-verbatim-read, skill-distribution-bundler, vendor-safeguard-refusal-triage, plus handover-cc, golden-name-collision-proposal-triage, memory-import-size-rotation, and remote-tmux-lane-drive (these four are marked *Translation Pending* in the English bundle).
- Gate hooks now require Node.js on `PATH` to enforce; without it they exit silently (fail-open). The model catalog is refreshed once at startup through BG-CC when the cache is older than 24 hours. `md-render` gains a copy button, figure color checks, and `comments_resolved` burn-in.
- New rules: denied-file-handoff-as-commands, human-handoff-command-safety, load-test-guard.
- `golden-ledger.json` (promotion ledger) and `scripts/proposal-review-record.cjs` are now part of the bundle.

### Fixed

- **Launch**: projects on Japanese-character paths failed to start (launcher `.ps1` now written as UTF-8 with BOM); projects on paths containing parentheses opened in the default folder (Windows Terminal `-d` quoting); resume session IDs leaked across projects.
- **Skill Proposals browser**: headings inside code blocks were counted as sections, making 175 proposals unreadable; evaluation-axis headers with spelling variants now map to the canonical five axes.
- **Golden promotion / reconcile**: deployed-version vs. proposal-origin detection; companion files are recorded and carried; local copies are aligned with golden after promotion; ledger and promote/remove/restore operations are mutually exclusive; EOL-only differences no longer count as changes; approval marks are bound to the MANIFEST fingerprint; **git read failures are reported instead of being treated as "no changes" / "0 items" / "success"**.
- **Model catalog**: the startup fetch now propagates to the launch menu.
- **Golden hooks**: recommend-review-gate no longer blocks unrelated sessions for another lane's proposal; report-gate no longer misfires across lanes; gate start-up time reduced.
- **Review ledger**: transcription is committed only after the hash is measured.
- **PXP**: `/model` switches are followed; Opus 5 savings were zero due to a duplicated default-model scope; a different tool's Japanese relay on the same port was mistaken for pxpipe; dashboard translation gaps.

### Quality

- Application test suite: **4445 passing** (vitest, 219 files; 15 known failures confined to golden-promotion test fixtures, 96 skipped); TypeScript 0 errors.
- Tests never write to the real `~/.ccpit` / `~/.claude` (guarded); heavy-test timeouts derived from measurement; no hard-coded golden counts.
- Backward compatible / additive. The startup golden update check is new behaviour: it asks before touching anything and can be silenced per file (*Stop asking*).

### Known issues

See [README — Known issues](./README.md#known-issues-v170).

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
