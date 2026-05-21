# technical-debate / expert-panel pi extension

Global pi extension for intense technical ideation with world-class expert panels.

## What it does

Registers:

- `/debate [--workshop] [--rounds 4] [--intensity normal|hard|ruthless] [--research] [--subagents] [--expert-subagents] [--prototype] [--html-report] [--fixed-experts] [--keep-dashboard] [--strong-model gpt-5.5] [--junior-model gpt-5.4-mini] <idea>`
- `/ideate [--workshop] [--rounds 4] [--intensity normal|hard|ruthless] [--research] [--subagents] [--expert-subagents] [--prototype] [--html-report] [--fixed-experts] [--keep-dashboard] [--strong-model gpt-5.5] [--junior-model gpt-5.4-mini] <idea>`
- `/ideate-hide` — hide the observatory widget
- `/ideate-sessions` — pick a previous session and show its saved resolution
- `/ideate-pickup [--rounds 2] [--research] [session-dir or instructions]` — continue from a previous session
- `technical_debate` tool for the assistant
- `debate_scratch` tool for expert-only scratch/prototype experiments inside a debate artifact directory

The extension first runs a strong-model panel-designer/meta-planner pass (unless `--fixed-experts` or explicit tool experts are provided), chooses 2-4 appropriate experts **and their tailored junior research/scouting briefs**, spawns independent `pi --mode json --no-session` expert processes, then a synthesizer, for multiple rounds. It converges on one of:

- `ACCEPT` — idea is ready enough to proceed
- `ITERATE` — promising, but must be revised first
- `REJECT` — core premise/cost/risk fails
- `ILL_POSED` — cannot be debated productively until reframed
- `UNRESOLVED` — round cap hit or experts still disagree

A negative conclusion is valid convergence. The panel is instructed to find the strongest viable version of the idea, not just criticize it.

## TUI behavior

The slash commands show an **expert panel observatory** widget above the editor while the run is active. It now auto-hides when the run completes unless `--keep-dashboard` is provided:

- proper side-by-side bordered panels for expert lanes (`queued`, `running`, `done`)
- round/phase flow (`plan → briefs → experts → synthesis → questions → final`)
- explicit workflow line showing parent-run briefs, direct expert subagents, scratch prototypes, and HTML report status
- latest tool/activity snippets per expert when JSON events expose them, including `MAIN EXPERT called subagent tool` and `ran scratch/prototype experiment` when observed
- synthesis/resolution state
- open questions that trigger user input

They also stream visible artifacts into the conversation:

- each expert critique appears as its own markdown message
- each round synthesis appears as its own markdown message
- final resolution appears at the end

The footer/status line still shows the current phase, but it is no longer the only observable output.

Manual controls:

```text
/ideate-hide
/ideate-sessions
/ideate-pickup --rounds 2
/ideate-pickup /path/to/.pi/technical-debates/<session-dir> --rounds 2
```

## Expert selection

Default behavior: a `panel-designer` agent reads the idea and chooses 2-4 experts plus tailored junior-assistant brief prompts for each expert. It usually picks 2 for narrow questions, 3 when domain + implementation + validation/product risks are distinct, and 4 only for genuinely multi-axis problems. The planner defaults to the strong model (`gpt-5.5` unless overridden).

Fallback/fixed experts:

1. `world-class-domain-expert` — framing, assumptions, constraints, evidence, value, safety, prior art.
2. `world-class-scientific-programmer` — implementation, numerics, tests, reproducibility, interfaces, sequencing.

Use `--fixed-experts` to skip planning and use the fallback pair. The tool also accepts explicit custom experts.

## Tools available to child experts

Default child tools:

```text
read,grep,find,ls
```

These are deliberately read-only. Experts can inspect the codebase and cite files/commands but cannot edit files.

Research mode:

```text
/ideate --research <idea>
/debate --research <idea>
```

`--research` grants default experts:

```text
read,grep,find,ls,bash,web_search,fetch_content,get_search_content,code_search
```

This lets them use controlled commands for local inspection plus installed web/doc/code-search tools. Their prompt still forbids project mutation.

Subagent briefing mode:

```text
/ideate --subagents <idea>
/ideate --subagents --research <idea>
```

`--subagents` means **parent-orchestrated junior briefs**, not recursive expert delegation. The extension keeps orchestration in the parent for observability and safety. Experts do **not** recursively launch arbitrary subagents themselves in the default slash workflow. Instead, the strong-model meta-planner decides tailored junior brief tasks for each expert, and before each expert critique the parent runs those controlled pi-subagents briefs:

- `scout` for local/code/context implications for that expert's lane
- `researcher` for external web/docs/papers/prior-art evidence when `--research` is set

The resulting `round_N_<expert>_assistant_brief.md` files are written into the debate directory and passed to the expert as junior-assistant input. The expert is instructed to read them, correct weak claims, and remain responsible for final judgment.

Direct main-expert subagent calls are disabled by default and are made explicit in the dashboard plus `workflow.md`. To allow them, use:

```text
/ideate --expert-subagents <idea>
```

or pass explicit tool experts through `technical_debate` with `expert.tools` containing `subagent`. When enabled, the `subagent` tool is added to main expert tool lists; observed JSON tool events appear in the expert lane as `MAIN EXPERT called subagent tool`. This is intentionally separate from `--subagents` so you can distinguish parent-run brief generation from expert-initiated delegation.

Workshop / RLM-style mode:

```text
/ideate --workshop <idea>
```

`--workshop` is a convenience mode for the extension you described: recursive-style expert delegation, context protection, prototypes, and a readable final report. It enables:

- `--research`
- `--subagents` parent-orchestrated briefs
- `--expert-subagents` direct main-expert access to `subagent`
- `--prototype` / `debate_scratch`
- `--html-report`

This is inspired by the RLM pattern: keep the root process as orchestrator, let experts offload bounded subtasks to separate context windows, and preserve a trajectory of child calls / scratch runs as inspectable artifacts rather than stuffing everything into one context.

Model routing:

- meta-planner / main experts / synthesizer default to `gpt-5.5`
- junior `scout` / `researcher` briefs default to `gpt-5.4-mini`
- override with `--strong-model`, `--planner-model`, `--expert-model`, `--synth-model`, or `--junior-model`

This requires `pi-subagents` to be installed. Your environment has it installed. `pi-web-access` has also been installed so `researcher` and research-enabled main experts can use `web_search`, `fetch_content`, `get_search_content`, and `code_search`.

## Usage

```text
/ideate --rounds 4 --intensity ruthless --research --subagents My idea is ...
```

Allow direct subagent calls from main experts as well as parent-run briefs:

```text
/ideate --research --subagents --expert-subagents My idea is ...
```

Full workshop mode with research, recursive expert delegation, scratch prototypes, and HTML report:

```text
/ideate --workshop --rounds 4 My idea is ...
```

Explicit model routing:

```text
/ideate --research --subagents --strong-model gpt-5.5 --junior-model gpt-5.4-mini My idea is ...
```

Keep the observatory after completion:

```text
/ideate --keep-dashboard --rounds 4 My idea is ...
```

Skip panel planning and use the fixed fallback pair:

```text
/ideate --fixed-experts --rounds 4 My idea is ...
```

or:

```text
/debate --rounds 4 --intensity ruthless My idea is ...
```

Or ask pi naturally:

```text
Use technical_debate to stress-test this architecture: ...
```

## Artifacts

By default artifacts are written to:

```text
.pi/technical-debates/<timestamp-slug>/
```

Key files:

- `idea.md` — original prompt
- `round_N_<expert>.md` — expert critiques
- `round_N_synthesis.md` — per-round synthesis
- `working-resolution.md` — latest synthesis
- `workflow.md` — subagent/delegation/prototyping/report policy for this run and each expert's tool list
- `scratch/<expert>/...` — prototype code, commands, stdout/stderr captured by `debate_scratch`
- `resolution.md` — final resolution
- `report.html` — self-contained evaluation report when `--html-report` or `--workshop` is enabled
- `transcript.md` — full transcript
- `user-answers.md` — authoritative answers from interactive Q&A

## Notes

- If the synthesizer raises blocking open questions and a slash command is used interactively, the extension asks for answers. If you answer and more rounds remain, the panel continues so your ruling can be incorporated.
- Custom tool calls can set `contextPaths` so experts inspect specific files/directories before making claims.
