---
version: "1.0.0"
language: "en"
purpose: "Doctor Pack（DP）reference guide for claude.ai diagnostic assistant"
---

# DP (Doctor Pack) Diagnosis Guide

This guide is a detailed reference for the CCPIT (Protocol Interlock Tower) diagnostic assistant when performing CC (Claude Code) environment fault diagnosis using a DP (Doctor Pack).

---

## 1. MANX Protocol Safety Design Overview

MANX Protocol has two independent safety layers to ensure CC's reasoning quality.

### 1-1. Senior TT (Main Function) - Discipline Layer

The core system that ensures CC's reasoning quality.

Components:
- **CLAUDE.md** (P1): CC's identity card + interlock table
- **rules/** (P2): Short behavioral rules
- **skills/** (P3): Detailed procedure documents

Characteristics:
- Rules that CC should internalize and follow
- Compliance is strongly expected, but deviation is structurally possible
- Compliance rate may degrade through compaction (context compression)

### 1-2. Junior TT (Safety Mechanism) - Enforcement Layer

The lowest layer of protection based on settings.json. The last line of defense that functions even if the entire discipline layer fails.

Components:
- **deny**: Absolute prohibition list. Unconditionally blocks matching operations
- **hooks**: Event-driven guardrails. Conditionally block or allow
- **auth**: Identity verification for rule changes

Characteristics:
- Enforced at the system prompt layer. Cannot be circumvented regardless of CC's judgment or intent
- Unaffected by CLAUDE.md compaction degradation
- CC's own modification of settings.json is blocked by deny

---

## 2. Role of deny and Typical Problem Patterns

### 2-1. What is deny

An absolute prohibition list defined in settings.json. Regardless of CC's state, operations listed in deny are physically blocked.

### 2-2. Typical Problem Patterns with deny

| Pattern | Symptom | Cause |
|---------|---------|-------|
| Invalid syntax | deny doesn't work (silent fail) | Using `file_path=` syntax, incorrect glob patterns, etc. |
| Excessive deny | Legitimate operations are blocked | Operations that should be user-permissible were placed in deny |
| Insufficient escaping | settings.json parse error | Unescaped `\` in Windows paths (`C:\` -> `C:\\` required) |
| Bypass routes | Access possible despite deny | Read is denied but Bash(cat) is not configured, etc. |

### 2-3. deny Syntax Notes

- `file_path=` syntax is invalid. Only glob patterns are accepted
- `*` matches one level only; `**/*` matches all levels
- Read and Bash(cat) are independent tools. Both need deny rules
- `C:\)` in JSON requires double-escaping as `C:\\)`

---

## 3. Role of hooks and Failure Modes

### 3-1. What are hooks

Event-driven shell scripts defined in settings.json. They automatically fire on CC lifecycle events (Stop / PreToolUse, etc.).

### 3-2. Differences Between hooks and deny

| Characteristic | deny | hooks |
|---------------|------|-------|
| Detection target | When CC attempts a prohibited operation | When CC passes through an event |
| Detecting inaction | Not possible | **Possible** (CC must eventually stop -> Stop hook fires) |
| Decision logic | Pattern matching (fixed) | Shell script (arbitrary logic) |

### 3-3. Representative hooks

| Hook Name | Event | Purpose |
|-----------|-------|---------|
| report-gate | Stop | Checks for report MD existence when CC stops. Blocks if code changes exist but no report |
| settings-guard | PreToolUse (Edit\|Write) | Blocks Edit/Write to settings.json as a dual barrier with deny |

### 3-4. hooks Failure Modes

| Failure Mode | Symptom | Diagnostic Method |
|-------------|---------|-------------------|
| Script missing | Hook doesn't fire | Check file existence in `$HOME/.claude/hooks/` |
| Insufficient permissions | Hook errors out | Verify `chmod +x` (mode displayed in DP Hooks section) |
| Wrong exit code | Hook result is ignored | exit 2 ignores stdout JSON. exit 0 + JSON is correct |
| Path notation error | Hook not found | Check if `\` is used in settings.json paths. Forward slash only |
| Missing settings.json definition | Hook itself is not registered | Check hooks section in settings.json |

---

## 4. Diff Summary Risk Scores

The Diff Summary included in the DP (Doctor Pack) classifies differences from the latest snapshot by risk level.

| Risk | Target | Meaning |
|------|--------|---------|
| **High** | settings.json / hooks script changes | Affects Junior TT (lowest layer protection). Check with highest priority |
| **Medium** | rules/ / skills/ changes | Affects Senior TT (discipline layer). Impacts reasoning quality |
| **Low** | Other file changes | Low direct safety impact |

**When High-Risk Changes exist, check them with highest priority.** Junior TT changes affect the last line of defense when the discipline layer completely fails.

---

## 5. Diagnostic Procedure

Follow this order for diagnosis:

### Step 1: Confirm Symptoms

Review the user's reported issue from the DP's Symptom section.

### Step 2: Check deny

Review the Deny Rules section:
- Is the deny rule syntax valid?
- Are there excessive deny rules?
- Are necessary deny rules missing?

### Step 3: Check hooks

Review the Hooks section:
- Do hooks definitions exist in settings.json?
- Do script files exist?
- Do they have execution permissions (execution bits in mode)?

### Step 4: Check Diff

Review the Diff Summary:
- Are there High-Risk Changes? -> Analyze with highest priority
- Are there changes temporally correlated with symptoms?
- Are there unintended changes (possible tampering)?

### Step 5: Conclusion

Integrate the above analysis results to:
- Identify the cause (which layer has the problem)
- Present remediation steps (with priority ranking)
- Propose recurrence prevention measures

---

## 6. CC Cannot Modify settings.json

**Important:** CC (Claude Code) cannot modify settings.json.

- CC's own editing of settings.json is prohibited by deny
- An additional dual barrier is set up via hooks (settings-guard)
- If settings.json modification is needed, **the user must edit it manually**

When diagnostic results include settings.json modifications, present the specific changes and ask the user to edit manually.

---

## 7. Typical Failure Scenarios and Response Patterns

### 7-1. Skill Doesn't Fire

**Symptom:** CC proceeds with a task without invoking a specific skill.

**Possible causes:**
- Skill's YAML description is category-restrictive ("Bug investigation" -> CC decides "this is a status check, not a bug investigation" and skips)
- Skill file doesn't exist or path is wrong
- Compaction has degraded the interlock table in CLAUDE.md

**Response:**
1. Verify skill file existence
2. Revise YAML description to action-based ("Fires when ...")
3. Check if the interlock table exists in CLAUDE.md

### 7-2. Report Not Output (report-gate Block)

**Symptom:** CC cannot stop when completing work (report-gate hook is blocking).

**Possible causes:**
- CC forgot to output report MD after code changes
- report-gate.sh script is not functioning correctly
- Hook exit code is incorrect

**Response:**
1. Check report-gate hook definition (in settings.json)
2. Verify report-gate.sh existence and execution permissions
3. Prompt CC to output the report MD

### 7-3. settings.json Parse Error Disables All deny

**Symptom:** deny rules don't work at all. CC can execute prohibited operations.

**Possible causes:**
- JSON syntax error (unescaped `\` in Windows paths, etc.)
- A single error causes the entire settings.json to be skipped

**Response:**
1. Validate settings.json with a JSON validator
2. Check if `\` in Windows paths is escaped as `\\`
3. After fixing, verify effectiveness with deny live-fire testing
