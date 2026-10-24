---
name: vendor-safeguard-refusal-triage
description: Fires when a vendor-side closed classifier (an API's safeguards, etc.) has refused an entire request and the current session is stopped. Pins down the refusal category from the raw transcript records rather than the displayed wording, falsifies causal hypotheses with a cohort aggregation over all sessions, confirms from official primary sources what is actually judged and whether an appeal channel exists, and produces a recovery path with stopping conditions. Not for judging false positives in a detector whose decision logic you can reproduce locally (lint, health checks, self-diagnostic UI) — that is detector-signal-fidelity-triage's domain. Does not fire when the goal is merely to explain a past incident that is not blocking you (investigation suffices).

---

# Triaging and recovering from a vendor-classifier refusal

## Scope, and what this procedure can tell you

**Target**: a refusal by an external classifier whose decision logic is closed and cannot be reproduced locally. Because you cannot make a binary determination by reproduction, the only option is to **falsify hypotheses** with a cohort of observational data.

**What this procedure can and cannot establish**: because the data is observational, **it cannot establish causation**. What it can do is three things: (1) falsify the hypotheses you raised, (2) present correlations confident enough for a practical decision, and (3) cross-check against primary sources. Unobserved confounders remain. Always write the conclusion with this limitation attached.

**Out of scope**: a detector you can reproduce locally is handled by `detector-signal-fidelity-triage`. If you are not blocked and only need an explanation, `investigation` suffices.

## Procedure

### 1. Pin down the refusal from the raw records, not the displayed wording

The wording shown on screen is boilerplate and **can disagree with the actual refusal category** (the screen points at a generic terms-of-use page while the raw data cites a different clause, etc.). Always read the actual transcript records.

Put the script below into a working directory and run it. The JSONL structure (one event per line, `type` / the `message.content` block array) is canonically documented in `session-transcript-excavation`.

```javascript
// refusal-census.cjs — 拒否イベントの全数抽出とコホート集計
// 使い方: node refusal-census.cjs [projectsDir]
const fs = require('fs'), path = require('path');
const BASE = process.argv[2] || path.join(require('os').homedir(), '.claude', 'projects');
const files = [];
(function walk(d) {
  let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch (x) { return; }
  for (const n of e) { const p = path.join(d, n.name); if (n.isDirectory()) walk(p); else if (n.name.endsWith('.jsonl')) files.push(p); }
})(BASE);

const events = [], sessions = [];
let excluded = 0, excludedWithRefusal = 0;
for (const fp of files) {
  let txt; try { txt = fs.readFileSync(fp, 'utf8'); } catch (e) { continue; }
  const mb = Buffer.byteLength(txt) / 1048576;
  // 2 パス: 先に uuid -> レコードの索引を作る（refusedUserMessageUuid を解決するため）
  const objs = [], byUuid = new Map(), idxByUuid = new Map();
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch (e) { continue; }
    if (o.uuid) { byUuid.set(o.uuid, o); idxByUuid.set(o.uuid, objs.length); }
    objs.push(o);
  }
  // 区間 (from, to) の tool_use 数。UUID 基準の指標を直近 user 基準と別に出すために使う。
  const countTools = (from, to) => {
    let c = 0;
    for (let i = from + 1; i < to; i++) {
      const mm = objs[i].message || {};
      if (objs[i].type === 'assistant' && Array.isArray(mm.content)) for (const b of mm.content) if (b && b.type === 'tool_use') c++;
    }
    return c;
  };
  const fam = { }; let refusals = 0; let lastUserTs = null, toolsSince = 0;
  for (let oi = 0; oi < objs.length; oi++) {
    const o = objs[oi];
    const m = o.message || {};
    if (m.model && m.model !== '<synthetic>') {
      const k = String(m.model).replace(/\[.*$/, '');
      fam[k] = (fam[k] || 0) + 1;
    }
    if (o.type === 'user' && typeof m.content === 'string' && m.content.trim() && !m.content.startsWith('<')) { lastUserTs = o.timestamp; toolsSince = 0; }
    if (o.type === 'assistant' && Array.isArray(m.content)) for (const b of m.content) if (b && b.type === 'tool_use') toolsSince++;
    // 実イベントのみ計上（テキスト中の文字列出現は数えない＝自己汚染ガード）
    if (o.type === 'system' && typeof o.subtype === 'string' && o.subtype.indexOf('refusal') >= 0) {
      refusals++;
      // 指標は「拒否対象として記録されたメッセージ」を基準に取る。直近 user 基準も併記し、
      // 食い違い（= 拒否対象が直前の発言ではない）を見えるようにする。
      const ru = o.refusedUserMessageUuid ? byUuid.get(o.refusedUserMessageUuid) : null;
      const refTs = ru && ru.timestamp ? ru.timestamp : null;
      const mins = (from) => from && o.timestamp ? ((new Date(o.timestamp) - new Date(from)) / 60000).toFixed(1) : '-';
      const startIdx = o.refusedUserMessageUuid ? idxByUuid.get(o.refusedUserMessageUuid) : undefined;
      events.push({
        ts: o.timestamp, cat: o.apiRefusalCategory || '?', sub: o.subtype,
        model: o.originalModel || '?',
        refUuid: o.refusedUserMessageUuid ? String(o.refusedUserMessageUuid).slice(0, 8) : 'none',
        refResolved: ru ? 'yes' : (o.refusedUserMessageUuid ? 'UNRESOLVED' : 'n/a'),
        minFromRefused: mins(refTs), minFromLastUser: mins(lastUserTs),
        toolsFromRefused: (startIdx !== undefined && startIdx < oi) ? countTools(startIdx, oi) : '-',
        toolsFromLastUser: toolsSince, sess: path.basename(fp).slice(0, 8)
      });
    }
  }
  const tot = Object.values(fam).reduce((a, b) => a + b, 0);
  if (tot >= 5) {
    let dom = '?', best = 0;
    for (const k in fam) if (fam[k] > best) { best = fam[k]; dom = k; }
    sessions.push({ dom, mb, refused: refusals > 0, file: path.basename(fp).slice(0, 8) });
  } else { excluded++; if (refusals > 0) excludedWithRefusal++; }
}

console.log('scanned .jsonl files:', files.length);
console.log('COHORT POPULATION (>=5 model-tagged msgs):', sessions.length, '| EXCLUDED (too few msgs):', excluded, '| of excluded, with refusal:', excludedWithRefusal);
console.log('NOTE: 群ごとの件数の合計は COHORT POPULATION と突き合わせる（scanned files ではない）。');
console.log('      excluded, with refusal が 0 でなければ、コホート外に拒否が落ちている＝比較が不完全。');
console.log('REAL refusal event records:', events.length, '\n');
events.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
console.log('when(UTC)        | category            | model at refusal      | refusedMsg | resolved   | minFromRefused | minFromLastUser | toolsFromRefused | toolsFromLastUser | session');
for (const e of events) console.log('%s | %s | %s | %s | %s | %s | %s | %s | %s | %s', String(e.ts).slice(0, 16),
  String(e.cat).padEnd(19), String(e.model).padEnd(21), String(e.refUuid).padEnd(10), String(e.refResolved).padEnd(10),
  String(e.minFromRefused).padStart(14), String(e.minFromLastUser).padStart(15),
  String(e.toolsFromRefused).padStart(16), String(e.toolsFromLastUser).padStart(17), e.sess);
console.log('\nNOTE: FromRefused 系（拒否対象メッセージ基準）と FromLastUser 系（直近 user 基準）が');
console.log('      食い違う拒否は、拒否対象が直前の発言ではない（走行中のターンへ合流したメッセージ等）。');
console.log('      ターン指標をどちらの発言へ帰属させるか、結論を書く前に必ず確かめる。');
console.log('      resolved=UNRESOLVED は対象メッセージが記録内に無い（指標は FromLastUser しか取れない）。');

const byCat = {}, byModel = {};
for (const e of events) { byCat[e.cat] = (byCat[e.cat] || 0) + 1; byModel[e.model] = (byModel[e.model] || 0) + 1; }
console.log('\nBY CATEGORY', JSON.stringify(byCat));
console.log('BY MODEL AT REFUSAL', JSON.stringify(byModel));

// コホート: 支配的モデル別に「大きい会話がどれだけあるか(=検出力)」と「拒否の有無」
const coh = {};
for (const s of sessions) {
  const c = coh[s.dom] = coh[s.dom] || { n: 0, refused: 0, big: 0, bigRefused: 0, maxMb: 0, mbs: [] };
  c.n++; c.mbs.push(s.mb); if (s.mb > c.maxMb) c.maxMb = s.mb;
  if (s.refused) c.refused++;
  if (s.mb >= 3) { c.big++; if (s.refused) c.bigRefused++; }
}
const med = a => { if (!a.length) return 0; const t = a.slice().sort((x, y) => x - y); return t[Math.floor(t.length / 2)]; };
console.log('\ndominant model | sessions | withRefusal | >=3MB | of those refused | maxMB | medianMB');
for (const k in coh) { const c = coh[k];
  console.log('%s | %s | %s | %s | %s | %s | %s', k.padEnd(14), String(c.n).padStart(8), String(c.refused).padStart(11),
    String(c.big).padStart(5), String(c.bigRefused).padStart(16), c.maxMb.toFixed(1).padStart(5), med(c.mbs).toFixed(2).padStart(8)); }
```

Items to pin down: the refusal category / the explanatory text verbatim / `refusedUserMessageUuid` / that turn's elapsed time and tool-execution count / **the model that was running at the moment of refusal** (`originalModel` — a different thing from the session's dominant model, so do not conflate them).

**Self-contamination guard**: if you write the search term into the conversation yourself, that transcript will hit on a string search. The script above counts **only real event records** where `type=system` and the subtype contains refusal. Do not report a plain `grep` occurrence count as the refusal count.

### 2. Falsify hypotheses with the cohort

Looking at a single case will not produce a cause. Use the cohort table in the second half of the script to compare the "refused" group against the "not refused" group.

**Always reconcile the denominator.** The sum of the per-group counts must match **`COHORT POPULATION`** (the number of sessions with at least the threshold of model-tagged records, as printed by the script) — not the number of scanned files. Read `EXCLUDED` and `of excluded, with refusal` alongside it. **If even one refusal event is on the excluded side, that comparison is incomplete**; lower the threshold and take it again. If the filter conditions differ between groups, the comparison itself becomes unevaluable.

**Look at statistical power first.** "Zero in the control group" means something only when the control group has comparable exposure (conversations of comparable size and count). The `>=3MB` and `maxMB` columns exist for that. Do not use a count of zero as evidence without showing the exposure.

### 3. Dig for a control that cuts the confounders

Confounders remain in a between-group comparison. **Look in the population for a control whose conditions are as close as possible.** The strongest is **a before/after within a single session where only one attribute switched** — if a refusal occurred in a session whose dominant model is A while the model running at refusal was B, you can say "this is hard to explain by the work content alone" (a discrepancy between `BY MODEL AT REFUSAL` and `dominant model` is the trace of this).

**This is not a controlled experiment, however.** Even within a single session, the conversation history, the point in time, and the accumulated context all differ across the switch. What you obtain reaches **hypothesis generation and a weakening of the work-content hypothesis** — it does not establish the attribute's effect. Write this limitation into the conclusion.

If no control is found, write "the confounders could not be cut". Do not claim to have found something that is not there.

### 4. Go out and falsify your own hypothesis

For any cause you come up with, seek **falsification** first, not support. "The unusual configuration on my machine (a proxy, a plugin, a custom setting) is the cause" is especially attractive, but it often collapses once you take a control.

Forms of falsification: does the same phenomenon appear in a group that does not go through that configuration? Is it absent under other conditions that are within that configuration's scope?

**Record the hypotheses you killed — do not delete them.** Keep them in the report's falsification checklist.

### 5. Pin down what is judged, and the appeal channel, from official primary sources

Go to the vendor's support articles and terms, and take the following three points **verbatim**. Do not substitute a summary.

1. **What is detected** (the definition of the category)
2. **What enters the judgement** (only the latest input, or the whole thing including the conversation, attachments, and connected endpoints)
3. **Whether there is a channel for getting a false positive individually cleared**

Always confirm (3), because **writing the procedure as if it exists walks the user to a channel that isn't there**. But be careful how you write it.

- Do not assert: the most you can say is "**within the scope of the published material, no individual-clearance channel is visible**". Do not rule out the possibility that a separate support-inquiry route exists. If there is a channel for reporting false positives, do recommend using it.
- **Do not design an evasion**: when no channel is visible, the only road to take is **to tidy the input within the bounds of legitimate use** (folding away history that is no longer needed, passing only the material the purpose requires, etc.). Obfuscation, split submissions, disguised phrasing, or probing for the classifier's inferred conditions — anything whose purpose is to slip past the detection — are **not written into the procedure and not recommended**. That is safeguard evasion, and it becomes a problem on the terms-of-service side.
- Leave room for not recovering: if it still does not pass after tidying within legitimate bounds, "this model cannot continue" is also a legitimate conclusion.

### 6. Produce a recovery path with stopping conditions

- State explicitly that each move is **tried exactly once**, and write that you move to the next move when it fails. The classifier looks probabilistic, which tempts repeated retries, but repetition only burns through the quota
- **Name and forbid operations that lose artifacts as a side effect** (restore operations that roll files back, and the like). A panicking user presses an adjacent menu item
- Put a **survival check on the artifacts** (checking version-control state, etc.) at the very start of the procedure. "Nothing was lost" cannot be established from the refusal events alone
- In an environment with many uncommitted changes, state explicitly that a misfire of a rollback-type operation **cannot be saved even by version control**
- **No move is guaranteed to work.** Do not call an unguaranteed move "the best move"

### 7. Falsification check (mandatory before concluding)

**This table is not a restatement of every requirement in the body.** The procedure itself is authoritative in the body; this is a final gate listing **only the traps that are actually easy to step on** (copying every requirement one-to-one makes the table long, and a long table gets skimmed at the end and stops functioning). When you add a requirement to the body, judge it by "is it easy to slip past silently?" and add only those that qualify here.

**From §1**
- [ ] Did you confirm the refusal category from the raw records rather than the screen?
- [ ] Did you count from **real event records** (not using a string-occurrence count as the refusal count = self-contamination guard)?
- [ ] Did you distinguish the model running at refusal from the session's dominant model?
- [ ] Did you follow `refusedUserMessageUuid` and read **the message that was actually the refusal target** (rather than assuming it was the preceding utterance)?

**From §2**
- [ ] Did you reconcile the sum of the per-group counts against `COHORT POPULATION` (not confusing it with the number of scanned files)?
- [ ] Did you confirm `of excluded, with refusal` is 0 (and, if not 0, lower the threshold and take it again, since the comparison is incomplete)?
- [ ] Did you show the control group's exposure (the count of comparably sized conversations, and the maximum size)?

**From §3**
- [ ] Did you look for a control with close conditions and, failing that, write "could not cut them"?
- [ ] Did you attach to the conclusion that what you obtained reaches **hypothesis generation only** (not writing it up as a controlled experiment)?

**From §4**
- [ ] Did you go out and **falsify** your own hypothesis (rather than only collecting supporting material)?
- [ ] Did you record the hypotheses you killed instead of deleting them?

**From §5 (confirm all three points individually)**
- [ ] Did you quote **the definition of what is detected** verbatim from a primary source?
- [ ] Did you quote **the scope of what enters the judgement** (latest input only, or the whole conversation) verbatim from a primary source?
- [ ] Did you confirm **whether an individual-clearance channel exists** from a primary source, and write it qualified as "within the scope of the published material"?
- [ ] Did you avoid writing evasion (obfuscation, split submissions, disguise, probing the conditions) into the procedure?

**From §6**
- [ ] Did you put the artifact survival check at the very start of the procedure?
- [ ] Did you write each move as "exactly once" and state the stopping condition?
- [ ] Did you name and forbid operations that lose artifacts (including the note that recovery is impossible in an environment with many uncommitted changes)?
- [ ] Did you write that no move is guaranteed (not calling one "the best move")?

**From how to write the report**
- [ ] Did you put **what was actually judged** (a harmfulness judgement, or a different category) at the top of the report?
- [ ] Before writing "you did not violate anything", did you distinguish that from it being undetermined?
- [ ] Did you qualify the size metric as a **proxy metric**?
- [ ] Did you avoid writing correlation as causation (attaching the note that unobserved confounders remain)?

## How to write the report

- The user will take it as "I was reprimanded". **Put what was actually judged first** (was it a harmfulness judgement, or a different category?)
- But do not assert "you did not violate anything". What the records show is **a refusal by automatic classification** — not a fact that the vendor determined a violation, nor a fact that they acknowledged a false positive
- Attach a note that size metrics (file size, etc.) are **proxy metrics** and are a different thing from the amount actually passed into the judgement
- Do not write correlation as causation. Attach "because the data is observational, unobserved confounders remain" to the conclusion
