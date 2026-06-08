---
name: pi-workshop
description: Explain and use the pi-workshop extension for recursive expert panels over technical ideas, plans, PRDs, architecture proposals, and decisions. Use when a user asks about workshop, wants multi-expert critique/ideation/stress-testing, or asks how to run/configure /workshop.
---

# Pi Workshop

Use this skill when the user wants a rigorous multi-perspective review, recursive ideation, architecture/design critique, PRD stress-test, or guidance on running the pi-workshop extension.

## When to recommend pi-workshop

Recommend pi-workshop for:

- technical ideas that need multiple expert viewpoints
- architecture proposals, PRDs, plans, or release-readiness checks
- decision convergence: `ACCEPT`, `ITERATE`, `REJECT`, `ILL_POSED`, or `DEGRADED`
- cases where the user asks to "workshop", "stress-test", "grill", "debate", or "get a panel"

Do not force a workshop for small direct code edits, simple Q&A, or tasks where one-pass implementation is clearly enough.

## Assistant-callable path

If the `workshop` tool is available and the user explicitly wants a workshop-style review, call it with safe defaults:

- `rounds`: usually 2-4; use 1 only for a quick smoke/check
- `contextPaths`: include only existing files/directories inside the current cwd
- `experts`: optional; provide 2-4 named experts when the user already knows the panel shape
- `webResearch`: enable only when external prior art/facts are important and web tools are available
- `subagents`: optional parent-orchestrated restricted briefs; this does **not** require the `pi-subagents` package
- `htmlReport`: useful for polished summaries when the user asks for a report

The assistant-callable `workshop` tool is intentionally restricted. It cannot grant local bash, direct expert subagent tools, prototyping/scratch, custom cwd/outputDir, arbitrary tools, custom models, or privileged profiles. If the user wants those, tell them to use the slash command in the TUI.

## Slash command path for users

Tell users to start with:

```text
/workshop-doctor --rounds 1 --fixed-experts
/workshop --rounds 2 --fixed-experts "<idea, plan, PRD, or architecture proposal>"
```

Useful variants:

```text
/workshop --web-research "<idea>"
/workshop --subagents "<idea>"
/workshop --html-report "<idea>"
/workshop-pickup --rounds 2 <session-dir or instructions>
/workshop-config --check
/workshop-observatory
/workshop-cancel
```

Privileged variants require explicit UI confirmation:

```text
/workshop --local-bash "<idea>"
/workshop --prototype "<idea>"
/workshop --expert-subagents "<idea>"
/workshop --profile workshop "<idea>"
```

Safety notes to mention:

- default workshops are read-only and do not grant local shell
- `--prototype` uses `workshop_scratch`; it is artifact-contained, not sandboxed
- `--expert-subagents` requires a `subagent` tool provider, commonly `pi-subagents`
- `--web-research` requires web/search tools, commonly from `pi-web-access`
- artifacts are written under `.pi/workshops/<run>/` in the current project

## How to describe the outcome

After a workshop, tell the user:

- final status: `ACCEPT`, `ITERATE`, `REJECT`, `ILL_POSED`, or `DEGRADED`
- whether the panel converged
- the key decision or blocker
- where artifacts were written, especially `resolution.md` and optional `report.html`
- the suggested `/workshop-pickup` command if more rounds are needed
