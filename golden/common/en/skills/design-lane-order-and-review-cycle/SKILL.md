---
name: design-lane-order-and-review-cycle
description: Fires when a CC acting as the design AI places an order with an implementation-lane CC in another session. State only What/Why and delegate the How (when you do write a How, state explicitly that it is reference material and the decision right belongs to the implementing CC); hand it over as the four-point set (instruction MD / placement and verification / the Clear decision and its justification / the drop-in prompt, per canonical Vol.2-7 §3-0); and manage the order of Plan review → approval → Codex review of the implementation plan → implementation → Codex review of the implementation → HTML report → findings. Does not fire when you implement it yourself, or for a one-off review request.
---

# design-lane-order-and-review-cycle — Design-Lane Ordering and Review Cycle

## 0. Role

The design AI decides **what and why**; the implementation AI decides **how**. Make this boundary explicit every time,
keep reviews from becoming "done but ignored", and fold the human's involvement down to a minimum of two points
(Plan approval / findings on the report).

## 0-2. Positioning (a thin orchestration layer)

This skill is **not a reinvention of independent procedures — it is a thin layer defining when and in what order to call existing skills.**
The substance is delegated to what already exists: multi-round Plan convergence = `plan-review-convergence-loop` / a one-off independent review = `codex-review` /
adversarial review of an implementation diff = `marshal-review` / reports = `report` and `md-render` / the implementation sequence = `testable-impl`.
**Do not rewrite those same procedures inside this skill** (no duplication).

## 1. When to fire (AND conditions — preventing over-firing)

Fires when **all** of the following hold:

- The design role and the implementation role are in **separate sessions**
- You create and hand over a **handoff artifact** (an instruction MD, etc.)
- The implementation is **non-trivial** (involves any of: a design decision, multiple files, an irreversible operation, or a distributed artifact)
- There is value in interposing a **human approval gate**

**Does not fire (route to the lightweight path)**: you implement it yourself / only a one-off second opinion (`codex-review`) /
typos, formatting, small configuration changes, read-only investigation.

### 1-2. Risk tiers (do not force the heavy form onto everything)

| Tier | Target | Application |
|---|---|---|
| Light | Typos, formatting, read-only investigation | This skill is not used. Verbal instruction suffices |
| Standard | Ordinary feature additions, bug fixes | The 7 stages of §3, except that one round of Plan review is enough |
| High risk | Distributed artifacts, shared hooks, irreversible operations, security/privacy boundaries | The full 7 stages. Additionally, the design AI applies an independent gate immediately before publication/distribution |

**Deciding to raise a tier is the safe side** (when in doubt, go up). When lowering a tier, leave the reason on record.

## 2. Placing the order (the four-point set)

When you hand over instructions, assemble all four of the following. If even one is missing, the receiver either cannot move or misjudges.

**The definition follows the canonical source (`_GeneralAiRule` Handover Vol.2-7 §3-0).** It is the same definition as skill `handover-cc`, so even when both fire the receiver never gets two different definitions. **The canonical text is handover-cc. When ordering, always use handover-cc together and declare the order type (compliant / non-compliant). When not complying, follow handover-cc's "opt-out route" (SKILL.md §2-5, detailed version Vol2-7_CC.md §3-6)** (CCPIT_071).

| # | Artifact | Contents |
|---|---|---|
| **(a)** | **Instruction MD** | What/Why, **acceptance criteria** (4 columns: condition / evaluation method / evidence form / classification, per handover-cc §5), out of scope, cautions (traps), decision rights and rejection rights |
| **(b)** | **Placement** | **Place it yourself** into the target lane's project folder (canonical location), and **verify placement** → `path` / `sha256` / `lineCount` / head-and-tail anchors / existence of required headings. Existence and line count alone cannot detect a wrong file or failed overwrite of an old version |
| **(c)** | **The Clear decision and its justification** | New session or continuation, **and why** (different domain? needs preceding context? avoiding LITM). Also attach implementation model and launch cwd (directly under the repository being touched). **The decision and its justification are one point, not two** (a decision without grounds is not a decision) |
| **(d)** | **Drop-in prompt** | A single block the receiver can paste as-is. **If it exceeds 300 characters, write full instructions into an MD and fold the prompt down to a pointer to that path** (§2-3). Paths to primary sources, procedure, and decision-rights wording live inside MD |

### 2-1. Stay at What/Why (most important)

- **Do not write the How.** The implementing CC decides the optimal method for the best UX, given the state of the implementation.
- You may pass How-equivalent material (placement candidates, existing idioms, measured values) in order to save discovery. However,
  **state explicitly in the body that it is reference material and that the responsibility for considering the How, and the decision right, belong to the implementing CC.**
- The exception is **process-How** (§5 below). That is not subject to delegation.

**Calibrating the granularity — write as if addressing a human senior engineer**

Write instructions at the same granularity and the same quality as an instruction document addressed to a **human senior engineer**. Assume the recipient
has context, has judgement, and can fill in the details themselves.

When you think you are addressing an AI you tend to write endlessly fine-grained detail, but **excessive detail is encroachment on the How**, in direct
conflict with this section's principle. **Do not write anything to the implementation AI that you would not write to a senior engineer.**

### 2-2. Decision rights and rejection rights (include verbatim)

> That said, the decision right over the How belongs to the CC (you).
> You hold the right to reject a review finding, by discharging your accountability to Raio
> for the soundness of that rejection.

On rejection, make them **leave the reason in the report and explain it carefully to the human** (silent rejection is forbidden).

### 2-3. The drop-in prompt is capped at 300 characters (fold it into an MD if it exceeds that)

**If the prompt exceeds 300 characters, write the full instructions into an MD file and fold the prompt down to a
one- or two-line pointer to that path.** This applies to all instructions to implementation lanes, subagents, and other CLI agents.

```
以降のPATHのファイルの指示に従い、実行してください。"<絶対パス>"
```

**Why**:

- Pasting a long prompt into chat creates work for the **human to visually pick out where the prompt starts and ends**.
  That is a cost only a human can pay, and it is not something the AI side may impose for its own convenience.
- Put it in an MD and **the receiving AI reads it itself**. The human only has to copy a short pointer.
- The instructions become version-controlled and the diff is traceable afterwards. Text flung into a chat is not.

**Do not do this**: put the full prompt into an MD and then ask the human to "open this MD and copy the block inside".
**That does not reduce the number of steps — it increases them.** The MD is something the receiving AI reads, not something the
human opens as a source to copy from.

**The 300 characters is a cap on the prompt, not on the MD's contents.** The MD may be as detailed as necessary.

### 2-4. Fix the drop-in prompt delimiter to this format

When issuing a drop-in prompt in chat, **always bracket it in the following format**. Because the mere mindset of "making delimiters clear" cannot be upheld (and in practice was not upheld), we fix the shape.

```
━━━━━ ▼ 投下プロンプト ここから（この下のブロックだけを貼る）▼ ━━━━━

(the text to paste — plain text, not wrapped in a code fence)

━━━━━ ▲ 投下プロンプト ここまで ▲ ━━━━━
```

**Rules**:

1. The content between the delimiters is **only what gets pasted**, as plain text — do not wrap it in a code fence (a fence is invisible as a frame in a CLI and pushes the boundary-cutting onto the human). Never mix in headings, explanations, or notes.
2. The drop-in prompt is **strictly 1 per chat message**. If issuing multiple prompts, split them into separate messages.
3. Supplementary details, context, and next actions must always be written **outside** the delimiters.
4. Delimiter lines are boundary declarations, not decoration. Do not omit them.

As long as the recipient is human, make extraction effort zero. This is the formatting expression of the principle in §2-3: never incur costs that only humans can pay due to AI convenience.

## 3. The cycle (7 stages — fixed order)

| Stage | Actor | Content | Gate |
|---|---|---|---|
| 1 | Implementing CC | Investigate with `/plan` and draft **Plan as a file** | Do not let conversation text substitute for the Plan |
| 2 | Design AI + human | Review Plan | **Feed back on serious items (large rework) only and re-review. Do not return minor items at Plan stage** (§3-2) |
| 3 | Human | Approval | — |
| 4 | Implementing CC | **Codex-review the approved Plan as implementation plan** | Make them record accept/reject of each finding |
| 5 | Implementing CC | **Implement** after harvesting findings | — |
| 6 | Implementing CC | **Codex-review the implemented state again** | Until approve, or accountability for rejection |
| 7 | Implementing CC → us | **Report** (for humans, HTML report that minimizes cognitive load) | Inspect and return any findings to implementing CC |

- **The design AI's own instruction document may also be put through a Codex review before it is dropped in** (catches real omissions; proven in practice).

### 3-2. Plan approval etiquette — do not return minor items as comments (operational optimum for Plan mode)

**Stage 2 has exactly two exits.**

| Judgement | Exit |
|---|---|
| **Serious** (large rework, design needs to change) | **Feed back and re-review** (make them fix Plan) |
| **Minor** (quality polish, numeric precision, additional tests, strengthened prose) | **Approve with no comment** (equivalent to `Yes, and use auto mode`). **Carry the finding yourself, and raise it when you receive report after implementation, if it is still there** |

**Why minor items are not returned at Plan stage** (owner ruling, 2026-08-08):

- A Plan-mode architect has the property of **re-working the Plan whenever it receives input**. Throwing a minor finding at it
  spins a re-planning loop over something inessential and delays getting started.
- Most minor items **resolve naturally in the course of implementation** (the implementer notices once they see the real thing).
  Raising things at Plan stage that then resolve themselves makes the finding itself a wasted round.
- **After implementation you can judge "is it still there?" against the real artifact.** You raise findings from fact, not from guesswork.

**The obligation of the side carrying minor items (the design AI)**: **carry them forward without forgetting.** At report receipt, check them against artifact;
raise what remains, and silently drop what has been resolved. **Do not let a carried finding evaporate** (that is the same as never raising it).

## 4. Inspection on receipt (the design AI's responsibility)

- **Run the evaluation method of acceptance criteria yourself once, and check against evidence pasted in the report** (handover-cc §5-1, CCPIT_071). Lines without evidence or lines with only summaries instead of copies of output are treated as failed.
- **Delegate depth and aiming points of inspection to `implementation-review-depth-budget`** (when artifact has an **observable exit** — tests, CLI, API, generated output). Aim at entrance (input surface) and exit, narrowing to main route, representative failure routes, and boundaries. When finding an anomaly, **decide cap on investigation rounds up front**, investigate, stop at cap, and return to implementation lane. **Reading implementation line by line from top and tracking cause all the way down is implementation lane's job** (if design AI goes that far it pays roughly the cost of implementing, falling outside §0-2 "thin orchestration layer").
- **For artifacts with no observable exit** (design documents, investigation reports, configuration-only changes, etc.) the above does not fire. In that case, **identify premises artifact depends on and verify only those premises against the real thing.** Do not re-verify full text. Here too, tracking cause goes back to implementation lane.
- **When implementation lane attaches self-reported claims (tests passed, constraints observed, what changed), do not take them at face value — check them.** But not every item: minimal set suffices (identity of artifact, one core claim, consistency between report and another route). **This item does not arise for delivery with no self-report** (proceed on own observations alone).
- **Only for claims touching safety, privacy, distribution, legal matters, or irreversible operations, do not reduce depth — verify against real thing regardless of whether anything was self-reported.**
- **Always check minor findings carried from Plan stage here** (second half of §3-2). Look at real thing,
  raise what remains, and drop what is resolved. **Skipping this check makes carried findings evaporate.**
- Present points needing human judgement **one at a time**. For branches where grounds are already assembled, **decide yourself and report**
  (asking "A or B?" can itself be cognitive load).
- For concerns touching publication, distribution, or irreversible operations, declare in advance that **you will gate it yourself immediately before that execution**.

## 5. process-How is not delegated

The following are not "how to implement it" but **guardrails common to every lane**, and may be stated explicitly in instruction document:

- Proceeding with `/plan`, and writing Plan as a file
- A `.bak` before editing (never overwrite an existing `.bak`)
- Two-stage Codex review (plan / implementation) and recording accept/reject in report
- Human approval before starting destructive operations such as commit / push / deploy / kill
- Report format (three-tier Before/After, interlock verification, HTML derivative)

If a reviewer raises this as "a How specification that contradicts What/Why",
you may reject it by explaining **distinction between feature-How (delegable) and process-How (non-delegable)**.

## 5-2. The standard for a rejection (preventing rubber-stamping)

"I wrote a reason" is not sufficient as a rejection. It must satisfy:

- **Individual adjudication per finding** (do not lump together as "addressed")
- A rejection carries **evidence** (real file:line, measured value) and **impact analysis** (what could happen if not taken)
- **Escalate critical / high rejections to human** (do not settle within design AI alone)
- If rejections continue for two rounds on same kind of finding, **treat it as suspected defect on specification side** and revisit design

## 5-3. When the counterpart is absent (one-sided operation fallback)

Even if counterpart (`impl-lane-plan-review-delivery-cycle`) is not adopted, this skill remains **valid on its own as ordering side's etiquette**.
However, you cannot force receiver's behavior, so **embed 7-stage order and decision-rights wording verbatim in drop-in prompt**
(prompt carries discipline in skill's place). If you observe a deviation — receiver not writing Plan as a file, for instance —
demand correction on the spot.

## 5-4. Reviewer absence and disagreement

- **Reviewer absent** (Codex not deployed, auth/network failure, cost ceiling, timeout): **do not block.**
  Record reason for absence, time, and fallback action, and **degrade to human review**. Do not falsely claim "reviewed".
- **Disagreement between design AI and implementing CC** (implementation denies design's premise / design deems implementation's How unsuitable):
  **do not settle a winner — build evidence packet and escalate to human** — (1) point at issue in one line, (2) both sides' grounds (with references to real thing),
  (3) options and cost of each, (4) recommendation and reason. Record decider and final authority. If implementation overturned a premise,
  **revise design side's instruction document** (do not settle verbally).

## 6. Anti-patterns

- **Writing a How without stating explicitly that it is reference material** — implementing CC takes it as specification and discards better solution
- **Breaking review order** — reviewing only after implementation turns design hole into rework of implementation along with it
- **Throwing minor findings immediately** — induces Plan re-working loop. Carry them and raise at receipt
- **Dumping choice on human** — if grounds are assembled, design AI decides
- **Forgetting comment field, legend, or `file:///` on report's HTML** — non-compliance with convention. Run through checklist once before delivery
