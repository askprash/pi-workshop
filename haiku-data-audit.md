# Workshop Run Data Audit

> What data does a workshop run actually produce that can feed an HTML report?

---

## (A) Data Fields Reliably Available Per Run

### From `manifest.json` (always written, atomic rename-based)

| Field | Type | Notes |
|---|---|---|
| `extensionVersion` | string | e.g. `"0.2.1-safe-beta"` |
| `piNodeVersion` | string | e.g. `"v22.19.0"` |
| `startedAt` | ISO string | |
| `finishedAt` | ISO string | |
| `durationMs` | number | total wall-clock ms |
| `status` | `"ACCEPT"` / `"ITERATE"` / `"DEGRADED"` / `"CANCELLED"` | |
| `converged` | boolean | |
| `profile` | string or null | e.g. `"workshop"` |
| `configPaths` | string[] | config files merged |
| `params` | full `WorkshopParams` object | including `rounds`, `idea`, all flags |
| `limits` | `{ maxRounds, scratchTimeoutSeconds, maxScratchTimeoutSeconds, childTimeoutSeconds, globalTimeoutSeconds }` | |
| `models` | `{ strongModel, plannerModel, expertModel, synthModel, juniorModel }` | all resolved model IDs |
| `experts` | `[{ name, model, tools }]` | per expert |
| `childRuns` | `ChildRun[]` | see below |
| `observedFiles` | `ObservedFile[]` | files detected during run |
| `errors` | `string[]` | run-level error strings |
| `scratchPolicy` | object or undefined | `{ path, status, allowedExperts, expiresAt, revokedAt, artifactContainedNotSandboxed }` |
| `reportPath` | string or null | path to `report.html` if generated |

### `childRuns[]` entries (each child process logged)

| Field | Type | Notes |
|---|---|---|
| `name` | string | child name, e.g. `"extension-security-architect"` |
| `text` | string | full stdout text |
| `stderr` | string | |
| `exitCode` | number | |
| `model` | string | |
| `phase` | string | `"planner"` / `"assistant_brief"` / `"expert"` / `"synth"` |
| `round` | number | present for expert/synth/brief |
| `usage` | `{ input, output, cacheRead, cacheWrite, cost, turns }` | token/cost accounting |
| `toolEvents` | `ToolAuditEvent[]` | each tool call with time, child name, toolName, eventType, argsPreview, resultPreview |
| `aborted` | boolean | |
| `timedOut` | boolean | |
| `durationMs` | number | |
| `artifacts` | `{ path, name, source, bytes?, mtimeMs?, detectedAt, owner, phase, round }[]` | detected output files |

### Markdown artifact files on disk (under `.pi/workshops/<slug>/`)

| File | Always present | Notes |
|---|---|---|
| `idea.md` | ✅ | verbatim idea text |
| `workflow.md` | ✅ | config/tool summary, expert tool lists |
| `panel-plan.md` | ✅ when `planExperts` | planner JSON + expert stances/briefs |
| `round_<N>_<expert>.md` | ✅ per expert per round | expert critique text |
| `round_<N>_synthesis.md` | ✅ per round | synthesizer output, STATUS/CONVERGED lines |
| `round_<N>_<expert>_assistant_brief.md` | ✅ when briefs enabled | scouting context for that expert |
| `working-resolution.md` | ✅ (overwritten each round) | latest synthesis draft |
| `resolution.md` | ✅ at run end | final synthesis (same as last `round_N_synthesis.md`) |
| `transcript.md` | ✅ | concatenated final synthesis + all file paths |
| `answers.md` | ✅ (may be empty) | user Q&A if interactive questions were asked |
| `scratch/<expert>/` | only when `prototyping` | scratch files and bash command/output artifacts |
| `report.html` | only when `htmlReport: true` | generated HTML report |
| `.scratch-policy.json` | only when `prototyping` | nonce policy, revoked at run end |

### What `generateHtmlReport` reads (source of truth for HTML sections)

The function (`index.ts:1373–1530`) reads:
- `idea.md` → shown verbatim in Artifacts section
- `workflow.md` → shown in Artifacts section  
- `answers.md` → shown in Artifacts section
- `finalPath` (= `resolution.md`) → parsed for `Report brief` section, `Shared ground`, `Strongest viable version`, `Required idea revision`, `Resolved disagreements`, `Unresolved disagreements`, open questions
- `roundFiles` (all `round_*.md` files) → classified by kind, grouped by round number for Discussion Arc
- `scratch/` files (if any) → included in Evidence Ledger
- `childRuns[]` from manifest → Evidence table (name, phase, round, exitCode, timedOut, durationMs, toolEvents count, first meaningful line)
- `WorkshopResult` fields: `status`, `converged`, `roundsRun`, `experts[]`, `workshopDir`

### Parsed sections from `resolution.md` that feed HTML report sections

| Markdown section heading | HTML report section |
|---|---|
| `## Report brief` (with labelled sub-fields) | Hero card: Direction, Conclusion, Changed, Confidence, Next Action |
| `## Shared ground` | Direction of discussion (fallback) |
| `## Strongest viable version` | Final conclusion (fallback) |
| `## Required idea revision` | What changed + action items |
| `## Resolved disagreements` | What changed (tertiary fallback) |
| `## Unresolved disagreements` | Intervention list items |
| Open questions (`Q:` lines) | Intervention + action items |
| `STATUS: <value>` | Status badge |
| `CONVERGED: YES/NO` | Converged badge |

---

## (B) What the Prototype Assumes That Isn't Actually Produced

1. **`Report brief` section with labelled fields** — The `parseReportBrief()` function (`index.ts:1156–1165`) looks for a `## Report brief` section with these exact labels: `Direction of discussion`, `Final conclusion`, `What changed from the original idea`, `Human intervention required`, `Confidence / evidence quality`, `Next recommended action`. **The real synthesis files (`round_4_synthesis.md`, `resolution.md`) do not contain a `Report brief` section.** They have `Shared ground`, `Resolved disagreements`, etc. The function falls through to fallbacks for every field.

2. **`## Report-ready summary` / `## Executive report brief`** — `parseReportBrief` also checks these headings (line 1157). Neither exists in real synthesis output. These appear to be aspirational section names never produced.

3. **`answers.md` with meaningful content** — The function reads `answersPath`. In most non-interactive or short runs, this file is empty or contains only the raw Q&A exchange. The HTML report includes it as a raw artifact with no special rendering.

4. **`transcript.md` as structured input** — `transcriptPath` is accepted by `generateHtmlReport` but **never actually read or used** inside the function (no `await read(args.transcriptPath)` call). It's passed to the signature but consumed only in the `summary` string outside the report.

5. **Cost/usage data per expert in the report** — `childRuns[].usage` has full token cost data (`{ input, output, cacheRead, cacheWrite, cost, turns }`). The evidence table only shows `durationMs` and `toolEvents.length`; cost figures are not rendered anywhere in the HTML.

6. **Tool event details in the report** — `childRuns[].toolEvents[]` includes per-call `toolName`, `argsPreview`, `resultPreview`, `time`. The HTML evidence table only shows the count (`toolEvents?.length ?? 0`); no per-call timeline or tool breakdown is rendered.

7. **Expert verdict extraction per round** — `renderExpertCard` (`index.ts:1329–1340`) calls `extractVerdict(artifact.content)` expecting a `VERDICT: <value>` line at the end of each expert brief. Real round files (`round_1_release-dx-critic.md`) do end with `## Verdict / VERDICT: ITERATE` but using `##` heading format. Whether `extractVerdict` reliably parses this depends on its regex — worth verifying.

8. **`subagentWorkflow` field** — Present in `WorkshopResult` but not rendered in the HTML report at all.

---

## (C) Gaps Between Prototype Sections and Real Artifact Data

| HTML Report Section | What it expects | What real data provides | Gap |
|---|---|---|---|
| **Hero: Direction of discussion** | `Report brief > Direction of discussion` label | Falls back to `## Shared ground` text | Works but generic; `Shared ground` is bullet-pointed policy items, not a narrative direction sentence |
| **Hero: Final conclusion** | `Report brief > Final conclusion` label | Falls back to `## Strongest viable version` | The `Strongest viable version` section in real output is a multi-bullet list; `stripMarkdownForSnippet` truncates at 360 chars — may cut mid-bullet |
| **Hero: What changed** | `Report brief > What changed from the original idea` | Falls back to `## Required idea revision` | Real `Required idea revision` is a bullet list; truncated to 300 chars |
| **Hero: Confidence** | `Report brief > Confidence / evidence quality` | Computed from `failingRuns.length` and `converged` | Synthetic text, not evidence-grounded |
| **Hero: Next action** | `Report brief > Next recommended action` | Falls back to `defaultNextAction(status)` | Completely generic ("Review and iterate" style) |
| **Hero: Intervention** | `Report brief > Human intervention required` | Constructed from unresolved disagreements + open questions | Works but verbose; every open Q becomes an intervention item |
| **Metrics: Rounds** | `result.roundsRun` | ✅ available | No gap |
| **Metrics: Experts** | `result.experts[]` | ✅ array of names | No gap |
| **Metrics: Child-run issues** | `failingRuns.length` from `childRuns[]` | ✅ available | No gap |
| **Discussion Arc: Expert cards** | `VERDICT: <value>` line in each `round_N_<expert>.md` | Present as `VERDICT: ITERATE` at file end | Likely works; confirm `extractVerdict` regex |
| **Discussion Arc: Round synthesis** | `STATUS:` + `CONVERGED:` in synthesis files | ✅ present in real files | No gap |
| **Evidence Ledger: Child runs table** | `childRuns[]` full array | ✅ fully available | Cost/usage not shown — missed opportunity |
| **Artifacts: Full text** | reads all `round_*.md`, `idea.md`, `workflow.md`, `answers.md` | ✅ all exist on disk | No gap |
| **Artifacts: Scratch content** | reads `scratch/<expert>/` files | Only present when `prototyping: true` | Conditional — no gap, but report silently omits scratch section if none |
| **No section** | `durationMs` total, `models{}`, `params.idea`, `configPaths`, `observedFiles` | ✅ all in manifest | These rich fields are **never rendered** in the HTML report at all |
| **No section** | `childRuns[].usage.cost` per expert | ✅ fully populated in manifest | Cost/token data completely absent from HTML |
| **No section** | `childRuns[].toolEvents[]` full call log | ✅ fully populated in manifest | Tool timeline/breakdown completely absent from HTML |
| **No section** | `extensionVersion`, `piNodeVersion`, `startedAt`, `finishedAt` | ✅ all in manifest | Run metadata not shown in HTML at all |

---

## Summary

**Richest unused data in manifest** (present but not rendered in HTML):
1. `durationMs` (total), `startedAt`/`finishedAt`
2. `models{}` — which models were used
3. `childRuns[].usage.cost` — per-expert token cost  
4. `childRuns[].toolEvents[]` — full tool call log
5. `extensionVersion`, `piNodeVersion`
6. `observedFiles` — detected local files
7. `params` object (idea text, all flags)

**Most critical parsing gap**: `resolution.md` never contains a `## Report brief` section, so `parseReportBrief()` returns all `undefined` and every hero-card field falls back to truncated bullet-list snippets. To fix properly: either the synthesizer prompt should produce a structured `Report brief` section, or the HTML generator should be rewritten to extract data from the sections that do exist without relying on the `Report brief` contract.
