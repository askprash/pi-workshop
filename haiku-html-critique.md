# HTML Report Critical Design Review

## TL;DR

The prototype is aesthetically polished but architecturally wrong. It optimizes for "looks impressive on a demo" rather than "tells a practitioner what to do in 3 seconds." The real generated report is the opposite problem: it dumps everything raw, with zero information hierarchy. Neither is close to production-ready. The fixes are design choices, not styling tweaks.

---

## 1. AI Slop — Generic Filler and Decorative Vagueness

### Prototype

**Hero section eyebrow text:** `"Prototype · Pi workshop report"` — the word "Prototype" in a shipped report is noise. The eyebrow pattern (small ALL-CAPS label above the title) is borrowed from marketing sites and adds no information.

**"ITERATE resolution" as the H1:** "ITERATE" is a status code, not a title. The H1 should be the thing that was workshopped. A practitioner opening this report already knows it came from a workshop. What they don't know in 3 seconds is *what the workshop was about*.

**The hero summary sentence:** `"The panel moved the idea in the right direction, but not to execution yet: the winning path is narrower, testable, and requires one human product decision before implementation."` This is prototype placeholder prose that sounds meaningful but is fully generic. It could describe literally any ITERATE result. A real summary should quote the specific idea and the specific sticking point.

**4-metric grid in the hero:** "Status / Was direction right? / Human intervention / Evidence confidence" — three of these four are redundant with each other. "Status: ITERATE" and "Was direction right?: Mostly yes" and "Human intervention: 1 decision" are all restating the same fact (not done yet, one blocker). Evidence confidence ("Medium") with no definition of what Medium means is decorative.

**The "Executive summary" section after the hero:** Exists entirely to re-say what the hero already said. The "Direction the discussion took" card and the "Human-readable conclusion" card are two cards both summarizing the same thing that the hero metric grid already summarized. This is the third time the same information appears in the first screenful.

**Round-by-round "shared ground" / "what moved" / "still open" arc:** The three-column arc pattern looks structured but the content in the prototype is maximally vague ("The problem is real; automation could help if scoped carefully" / "Experts rejected the unbounded form"). These are the kinds of summaries an LLM generates when it has nothing specific to say. In a real report with real content they may be fine; as a layout pattern they encourage vague filler because the columns are always the same width regardless of whether you have something to say in each.

**The "Conclusions and action plan" three-card grid:** "Strongest viable version / Required revision / Action checklist" — the action checklist reads as `ol: Answer the target-user question → Draft acceptance criteria → Pick up the workshop`. This is a universally true checklist for any ITERATE result. It would be identical for every workshop. That is a red flag.

**Footer:** `"Prototype only. Backend should be adjusted to this layout only after review/approval."` This should never appear in a generated report.

**Nav bar with anchor links:** "Summary / Intervention / Discussion arc / Conclusion / Evidence / Raw artifacts" — six links for a report that fits on 1.5 screens. The nav adds visual weight without adding navigation utility until the report is much longer.

### Real Report

**"Workflow and delegation policy" section:** The full raw `workflow.md` content is dumped verbatim — 20+ lines of machine-readable config (`Scratch timeout: 60s default, 300s max before approval/escalation`, `Child timeout: 1200s`, every expert's tool list). A practitioner does not need to read tool ACLs in the summary view. This belongs under a collapsed `<details>` or in an appendix.

**"Panel work products" section:** `panel-plan.md` is the raw JSON expert-briefing config, verbatim, inside a `<details>`. It is 80 lines of JSON with fields like `"stance"`, `"assistantBriefs"`. This is an internal orchestration artifact. It proves the process ran correctly; it is not useful to read.

**Round artifact dumps:** Each round's critiques, assistant brief results, and synthesis are dumped as raw markdown inside `<details>` elements. The round 1 assistant brief result alone runs to 4000+ lines. These are appendix material, not report body material.

**"No scratch/prototype artifacts were recorded"** as a visible paragraph in the body is unnecessary negative space. If nothing happened, don't mention it.

---

## 2. Information Hierarchy — What Should Be Above the Fold

### What a practitioner needs in the first 3 seconds

1. **What was the question** (the idea that was workshopped, in plain language, ≤2 sentences)
2. **The verdict** (ITERATE / SHIP / ABANDON — one word, impossible to miss)
3. **The single most important action** (not a checklist, one sentence: "Before moving forward, decide X")
4. **Whether this is trustworthy** (4 rounds, 3 experts, converged — or not)

That is it. Everything else is detail.

### What the prototype puts above the fold

- Eyebrow marketing label (waste)
- "ITERATE resolution" as H1 — status code, not the question (wrong priority)
- Generic one-paragraph summary (useful but diluted)
- Two redundant badge pills ("iterate", "not converged") — same info as the metric grid below
- The full path to the workshop directory (this is footer material, not hero material)
- A 4-metric grid where 3 of 4 metrics restate the same conclusion
- A 6-item nav bar

The **original idea/question is nowhere in the prototype.** A user returning to this report 2 days later cannot know in 3 seconds what the workshop was about.

### What the real report puts above the fold

- `<h1>Pi workshop report ITERATE</h1>` — generic, no question, no content
- The full workshop directory path (footer material)
- A 4-metric grid: Status / Converged / Rounds / Experts — these four are actually the right four

Then immediately dumps the full `idea.md` verbatim as `<pre>` inside a `<section class="card"><h2>Original goal / prompt</h2>`. This is the right instinct (show the original question) but implemented wrong: a 15-paragraph raw LLM-style prompt in a `<pre>` block is not "above the fold" usability; it requires the user to read the whole thing before seeing any synthesis.

---

## 3. Genuinely Useful vs. Gratuitous Visual Complexity

### Prototype

**Genuinely useful:**
- The single "Intervention required" section with the specific decision/gap/rerun trigger — this is the highest-signal section in the entire prototype. It is buried in the middle.
- The "Evidence ledger" table (Source / What it supports / Confidence / Human note) — this is a real artifact that a practitioner would actually check. The table structure is correct.
- The `<details>` pattern for raw artifacts — correct. Collapsed by default, accessible if needed.
- The round-by-round arc with "still open" column — useful signal in principle, though the prototype fills it with placeholder content.

**Gratuitous visual complexity:**
- The `radial-gradient` hero background blur: purely decorative, adds rendering weight, no information value.
- The `border-radius: 30px` on the hero card vs `20px` on regular cards vs `16px` on arc cards vs `12px` on real report cards — four different corner radii in the same document with no semantic meaning attached to the difference.
- The `.eyebrow` pattern (small uppercase spaced label): used 3+ times for labels that don't need extra visual emphasis.
- The `.score` pill row below the executive summary card ("Direction: right / Readiness: not yet / Confidence: medium") — this is a third way of displaying information that was already shown in the hero metric grid and the badge pills.
- Color-coded badges (`.ok`, `.warn`, `.bad`) used on "was direction right?" which is a subjective judgment call — false precision from color coding.
- `letter-spacing: -.045em` on H1 at 56px — this is a design affectation copied from marketing landing pages, not a document optimized for information retrieval.

### Real Report

**Genuinely useful:**
- The "Final resolution" section with the Round 4 synthesis — this is the highest-signal content in the whole report. It answers: what was decided, what changed, what's still open.
- "User answers / rulings" section — extremely valuable. This is the human's choices that shaped the workshop. No other format captures this.
- The metric grid (Status / Converged / Rounds / Experts) — exactly the right four numbers.

**Gratuitous / wrong:**
- Raw JSON panel-plan.md in a `<details>` tag — this is internal orchestration metadata. Even collapsed, listing it implies the user should care.
- The full assistant brief subagent results inside `<details>` — hundreds to thousands of lines of scout reports that are already synthesized into the expert critiques. Double-dipping.
- `workflow.md` as a second verbatim section — tool ACL config.

---

## 4. What Is Missing That a User Who Just Ran a Workshop Would Actually Want

### Highest priority missing items (prototype AND real report):

**1. The original question / idea — legible, not raw**
The real report dumps the full raw `idea.md` in a `<pre>` block. The prototype has no question at all. What's needed: a 2–4 sentence human-readable distillation of what was workshopped, at the top, in `<p>` text, not monospace.

**2. Expert-by-expert verdict summary**
Neither report shows: "Expert A said SHIP, Expert B said ITERATE, Expert C said ITERATE — here's why they disagreed." The real report buries this in per-round detail dumps. A practitioner wants to know immediately whether the experts converged or had a three-way split.

**3. The key blocking concern, named specifically**
The prototype's "Intervention required" section gets close but is placeholder. The real report has the blocking concerns buried in the Round 4 synthesis prose. Neither has a "here is the single thing that blocked SHIP" callout that a practitioner can act on immediately.

**4. Round convergence trajectory**
"Did we get closer to a decision over 4 rounds?" is the key meta-question. Neither report shows a simple "Round 1: ITERATE (3/3 experts) → Round 2: ITERATE → Round 3: ITERATE → Round 4: ITERATE (converged)" arc at the top. This tells the user whether the workshop was productive.

**5. What changed from Round 1 to the final round**
The prototype's arc section is meant to show this but the content is placeholder. The real report has it buried in synthesis prose. A single "before/after" callout — "Original framing → Workshop-refined framing" — is missing from both.

**6. The open questions, actionable**
The real report's Round 4 synthesis has a great "Open questions for user" section. Neither report surfaces these questions in a prominent "what you need to decide" list at the top. The real report's "User answers / rulings" section is retrospective; what's needed is a forward-looking "what still needs an answer" block.

**7. Time / cost signal**
A practitioner who ran a 4-round workshop with 3 experts wants to know: how long did this take? How many model calls? The report has no duration, no token estimate, nothing. This is basic run metadata.

**8. A "run again from here" command**
The prototype hints at `/workshop-pickup --rounds 2 ...` in one card but neither report gives the practitioner the exact command they need to continue. Given that ITERATE is the common case, the most important CTA is "here is the command to pick up where this left off."

---

## 5. Prototype vs. Real Report: What Each Lacks

### Prototype lacks:
- The actual question / idea that was workshopped (completely absent)
- Real content — every section is placeholder prose that would be identical for any workshop
- Round count, expert count, convergence status — the only numbers in the prototype are fake quality signals
- User rulings / answers — the most unique artifact of a workshop (human steering decisions) is not represented at all
- Expert identities — who were the experts? What stances did they take? Not shown.
- The `<pre>` pattern for raw text is completely absent — the prototype avoids showing any actual workshop content
- Time/cost metadata

### Real report lacks:
- Information hierarchy — everything is flat, every section is a `<section class="card">` with equal visual weight
- A legible above-the-fold summary — the idea is raw `<pre>` text, the verdict is in an H1 badge
- Expert-by-expert verdict summary
- Round convergence trajectory — there is no way to see at a glance that 4 rounds ran and converged
- The specific blocking concern named as a first-class element
- Forward-looking "what to do next" — the actionable output of an ITERATE verdict
- Visual differentiation between "this is what happened" (synthesis) and "here is raw evidence" (artifacts)
- Any collapsing of content — everything is fully expanded, including 4000-line assistant brief dumps
- The `/workshop-pickup` command or equivalent

### What the real report does better than the prototype:
- Shows actual content (the real synthesis, the real user rulings, the real expert briefs)
- Has the right 4 metric tiles (Status / Converged / Rounds / Experts) — this is the correct minimal summary
- The "Final resolution" section content is genuinely high-signal
- The "User answers / rulings" section is unique and irreplaceable — nothing like it in the prototype

### What the prototype does better than the real report:
- Information is clearly separated into named sections
- The "Intervention required" section exists (even if placeholder) — this is the right idea
- The evidence ledger table structure is right
- The round arc pattern (shared ground / what moved / still open) is the right structure
- `<details>` are used for raw artifacts — the right pattern, missing from real report

---

## 6. Specific Ruthless Recommendations

**Kill immediately:**
- Hero gradient background blur (prototype)
- The eyebrow label "Pi workshop report" in the hero (prototype)
- Four different border-radius values with no semantic meaning (prototype)
- The `.score` pill row as a third repetition of the same verdict (prototype)
- The footer "Prototype only" text in any shipped report (prototype)
- The 6-item nav bar on a 1.5-screen document (prototype)
- Raw `panel-plan.md` JSON as a visible section (real report)
- Full `workflow.md` as a visible section (real report)
- "No scratch/prototype artifacts were recorded" as a body paragraph (real report)

**Promote to above the fold:**
- The original question, in 2–4 sentences of plain English (neither has this right)
- Expert-by-expert verdict summary table (missing from both)
- The single blocking concern / required decision (buried in both)
- Round convergence trajectory (missing from both)
- The "pick up" command for ITERATE results (missing from both)

**Demote to collapsed `<details>`:**
- All raw artifact dumps: panel-plan.md, workflow.md, assistant brief results (real report)
- The original raw `idea.md` prompt (real report — summarize it instead)
- Round synthesis raw text (both — summarize, then offer raw)

**The H1 should be the idea, not the status:**
```
<h1>[Short name of the idea workshopped]</h1>
<span class="badge warn">ITERATE</span>
```
Not `<h1>ITERATE resolution</h1>` (prototype) or `<h1>Pi workshop report ITERATE</h1>` (real).

**The first thing after the H1 should be the blocking concern:**
```
Before proceeding: [one specific decision or evidence gap]
```
Not a 4-metric grid. Not a re-summary. Not a nav bar.
