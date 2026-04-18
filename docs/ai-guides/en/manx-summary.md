---
version: "1.0.0"
language: "en"
purpose: "MANX Protocol public summary"
---

# MANX Protocol Overview

This document is a public summary of MANX Protocol. It serves as a common reference for both CP (Conversion Pack) and DP (Doctor Pack).

---

## 1. Purpose of MANX Protocol

MANX Protocol is a design architecture specification that defines the design principles and placement rules for CC (Claude Code) configuration files (CLAUDE.md / rules/ / skills/ / settings.json).

### 1-1. Context Reduction

CC loads the entire CLAUDE.md at session start, consuming the context window. As the number of instructions increases, compliance rate for each instruction degrades uniformly.

MANX Protocol redefines CLAUDE.md as an "identity card + skill index" (30-50 lines) and places detailed rules in skills/, minimizing context consumption while maintaining rule depth.

### 1-2. Safety Design

To ensure CC's reasoning quality, two independent safety layers (Senior TT / Junior TT) are established, achieving fault-tolerant design where one continues to function even if the other fails.

---

## 2. Layer Structure (P0-P5)

| Priority | Location | Role | Load Behavior |
|----------|----------|------|--------------|
| P0 | settings.json | Absolute deny + hooks + auth | Loaded at startup. Enforced |
| P1 | CLAUDE.md | Identity, values, interlock table | Full text loaded at startup |
| P2 | rules/*.md | Short behavioral rules | Loaded on glob match or always |
| P3 | skills/*/SKILL.md | Detailed procedures | YAML only at startup. Body on-demand |
| P4 | {project}/CLAUDE.md | Project-specific rules | Full text loaded at startup |
| P5 | CLAUDE.local.md | Volatile memo | Full text loaded at startup (.gitignore target) |

---

## 3. Design Principles

1. **Minimize restrictive rules for CC.** Precision of acceptance criteria matters more than quantity of rules
2. **Focus on the design AI expressing acceptance criteria accurately and sufficiently.** If those are met, CC's How (specific approach) is free
3. **Gates / interlocks / hooks are WDT (Watchdog Timer)-style insurance.** Not firing routinely is the normal state
4. **Don't try to correct CC's behavioral biases; design incentives toward quality.** Make CC internalize that "doing it now saves my future self work"
5. **Design reports as "knowledge accumulation investment" rather than "obligation."** The system grows rules/ and skills/ with each task cycle
6. **"Caution means to hurry."** Process discipline itself is structural resistance against the temptation of shortcuts

---

## 4. Glossary

| Abbreviation / Term | Full Name | Description |
|---------------------|-----------|-------------|
| CC | Claude Code | Implementation AI. CLI agent |
| CCPIT | Protocol Interlock Tower | Configuration management tool (this software). Public name |
| CP | Conversion Pack | Conversion instruction pack passed to claude.ai during Migration |
| DP | Doctor Pack | Diagnostic information pack passed to claude.ai during fault diagnosis |
| RK | Recovery Kit | Snapshot, diff, and restoration functionality for configuration files |
| DA | Doctor Analysis | DP (Doctor Pack) generation + claude.ai diagnostic integration |
| MANX | (Windows project code) | Named after Isle of Man TT. Windows version of CCDG v2 |
| ASAMA | (Linux project code) | Named after Asama Highland Race. Linux version of CCDG v2 |
| Macau | (macOS project code) | Named after Macau Grand Prix. macOS version of CCDG v2 |
| CCDG | Claude Code Directory Generator | v1 (published) and v2 (= CCPIT) exist |
| Golden | Golden Template | Rule master copy managed by CCPIT. Structure of common/ + OS-specific |
| Senior TT | Main Function (A) | Reasoning quality assurance via CLAUDE.md + rules/ + skills/ |
| Junior TT | Safety Mechanism | Lowest layer protection via settings.json (deny + hooks + auth) |
| P0-P5 | Priority 0-5 | Rule placement priority. P0 is highest (settings.json), P5 is lowest (CLAUDE.local.md) |
| hooks | Event-driven guardrails | Shell scripts defined in settings.json. Fire on CC lifecycle events |
| report-gate | Stop hook | Checks for report MD existence when CC stops. Blocks if missing |
| settings-guard | PreToolUse hook | Blocks Edit/Write to settings.json as dual barrier |
| WDT | Watchdog Timer | Independent hardware safety mechanism in ECUs. Analogy source for hooks |
| Marshal | External node monitoring (future) | Independent external monitoring via local LLM |
| SOR/EOR | Start of Report / End of Report | Report markers. Used in CLI output. Prohibited in MD files |
| i18n | Internationalization | Multi-language support. CCPIT supports ja/en |
| Lost in the Middle | (Known LLM issue) | Phenomenon where attention to the middle portion of long contexts decreases. Countered by CP/DP sandwich strategy |
| Interlock | Skill trigger verification mechanism | Self-diagnostic mechanism that verifies skill trigger evidence and halts action when untriggered. Three-tier structure (CLAUDE.md table + report skill checklist + hooks exit gate) |
| Progressive Disclosure | Staged disclosure | Design pattern that loads information only when needed. Core of skills/ |
| compaction | Context compression | Server-side context compression. Degrades CC's instruction compliance rate |
| Discipline | — | Instructions to CC via CLAUDE.md / rules/ / skills/. Deviation is possible |
| Enforcement | — | Control of CC via settings.json. Deviation is impossible |
| The Shallow Fix Swamp | — | The swamp of lazy shallow fixes. The primary hazard MANX Protocol aims to eliminate |
