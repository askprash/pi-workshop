# pi-workshop / workshop pi extension

Global Pi extension for recursive expert workshops over technical ideas, plans, PRDs, and architecture proposals.

## Status

This is a **public beta with safe defaults** for trusted local use on **macOS/Linux**. The default/public path does not grant local shell, prototype scratch, or direct expert subagent tools. Privileged modes run as your local user and require explicit UI confirmation.

## Installation

Pinned git install (replace the tag only when you intentionally update):

```bash
pi install git:github.com/prashanthprakash/pi-workshop-extension@v0.2.2-beta
```

Verify it loaded and preflight your model/tool/artifact setup:

```bash
pi -p "/workshop-doctor --rounds 1 --fixed-experts"
```

Uninstall:

```bash
pi remove git:github.com/prashanthprakash/pi-workshop-extension
```

### Requirements

- macOS or Linux beta environment
- Node 20+
- `pi` on PATH
- A Pi model available from the parent session, or `models.strongModel` configured in `~/.pi/agent/pi-workshop.config.json`

If doctor reports no `strongModel`, list models and add a minimal config:

```bash
pi --list-models
```

```json
{
  "models": {
    "strongModel": "provider/your-strong-model-id",
    "juniorModel": "provider/your-cheap-model-id"
  }
}
```

## Quickstart

Run a tiny safe workshop first:

```text
/workshop-doctor --rounds 1 --fixed-experts
/workshop --rounds 1 --fixed-experts "Should this extension use direct restricted brief runners instead of global subagents?"
```

Expected output:

- run directory: `.pi/workshops/<timestamp-slug>/`
- final answer: `.pi/workshops/<timestamp-slug>/resolution.md`
- manifest: `.pi/workshops/<timestamp-slug>/manifest.json`

Cancel an active run:

```text
/workshop-cancel
```

## Registered commands/tools

- `/workshop [--profile workshop] [--rounds 4] [--web-research] [--local-bash] [--subagents] [--expert-subagents] [--prototype] [--html-report] [--fixed-experts] [--keep-dashboard] [--observatory] <idea>` — with no args, opens an interactive settings wizard before the idea editor
- `/workshop-config [--profile workshop] [--check]` — validate config and show shared preflight/model resolution
- `/workshop-doctor [same flags as /workshop]` — preflight tools, models, config, and artifact permissions
- `/workshop-cancel` — abort the active slash workshop
- `/workshop-hide` — hide the observatory widget
- `/workshop-observatory` / `Ctrl+Alt+W` — inspect experts, direct brief runners, tool events, and saved artifact files
- `/workshop-sessions` — pick a previous session and show its saved resolution
- `/workshop-pickup [--rounds 2] [--web-research] [session-dir or instructions]` — continue a previous session; with no args, opens the same settings wizard before session selection
- `workshop` tool for the assistant — restricted public schema
- `workshop_scratch` tool — prototype scratchpad for active workshop experts only; local shell execution, not a sandbox

## Default safety model

When `/workshop` or `/workshop-pickup` is invoked with no arguments in the interactive TUI, pi-workshop first asks whether to use the resolved defaults or configure per-run settings. The wizard can set rounds, web research, panel planning, parent subagent briefs, expert direct subagents, prototyping/scratch, local bash, HTML report generation, observatory launch, and dashboard persistence.

The assistant-callable `workshop` tool does not expose `cwd`, `outputDir`, custom tools/models, `localBash`, `expertSubagents`, `prototyping`, or privileged profiles. Assistant context paths must exist and realpath-resolve inside the current cwd.

Slash commands are a UX surface, not a proof of human provenance. Any resolved privileged mode (`localBash`, `expertSubagents`, or `prototyping`) requires UI confirmation. Non-UI privileged runs fail closed until a user-global trust toggle exists.

The built-in `safe` profile is immutable and subagent-free by default. Project config cannot redefine `safe`.

## Expert tools

Default child tools are read-only:

```text
read,grep,find,ls
```

Web research is separate:

```text
/workshop --web-research <idea>
```

Local shell is privileged and confirmed:

```text
/workshop --local-bash <idea>
```

This grants `bash` to main expert agents only. Planner, synthesizer, and safe/direct brief runners do not inherit local bash.

## Parent brief runners (`--subagents`)

`--subagents` means parent-orchestrated junior evidence briefs. In this beta these are **direct restricted child Pi runners**, not global mutable `/run scout` or `/run researcher` agents and not the `subagent` tool.

- scout briefs: `read,grep,find,ls`, `--no-extensions --no-skills --no-context-files`
- researcher briefs: `read,grep,find,ls` plus configured web/search tools when `--web-research` is enabled, `--no-skills --no-context-files`

Direct main-expert subagent calls remain off by default. To allow them, use privileged/confirmed `--expert-subagents` or `--profile workshop`.

## Observatory and Q&A

Interactive slash workshops show a framed live observatory widget with expert boxes. Open the full-screen **Observatory** control-room interface with:

```text
/workshop-observatory
```

or `Ctrl+Alt+W`. The full-screen view has a top-left `✦ Observatory` title, an outer border, a phase/progress ribbon, and split Index/Detail panes. Use arrow keys to select or scroll, Enter/→ for detail focus, ←/Backspace for the index, PageUp/PageDown for larger jumps, Esc to close, and `t` to toggle activity/thinking visibility.

User-question rounds now open a full-screen **Workshop Q&A** surface. Select a question and type the answer directly — placeholders are dim hints, not text you need to delete. Press Enter to move to the next question/save when done, Ctrl+S to save, or Tab to open a small clarification helper agent seeded with the current synthesis/resolution context. In helper chat, ask what the question means, then press Tab/Ctrl+S to summarize that chat back into the selected answer. Answers are written to `user-answers.md` and treated as authoritative in later rounds.

## HTML reports

`--html-report` writes a polished self-contained `report.html`. The synthesizer emits a structured `\`\`\`report-brief` fenced block in `resolution.md` containing: idea title, Why/How/What abstract, direction, conclusion, what changed, intervention, confidence, next action, and optional prior-art links. The HTML report renders:

- **Hero** — idea title + colorblind-safe status badge, Why/How/What three-card abstract, convergence strip (verdict · rounds · experts · converged), expert verdict strip with per-expert chips that scroll to detail cards, and a copyable `/workshop-pickup` command (ITERATE/REJECT/DEGRADED only)
- **Intervention** — blocking concern callout + decisions-needed list + pickup command (conditional: ITERATE, REJECT, DEGRADED only; hidden on ACCEPT)
- **Panel** — expert convergence table (rows = experts, columns = per-round verdicts), expert detail cards with key concerns and full per-round critique in a collapsed `<details>`
- **Round arc** — collapsible per-round cards (what panel agreed on / what shifted / what remained open), sourced from synthesizer voice
- **Prior art** — web-research-conditional section with project cards and hyperlinks; hidden entirely when absent
- **Evidence ledger** — two-tab view: Summary (what each expert thought about the idea, opinion-first) and Details (cost, tokens, duration, model, tool calls per run)
- **Raw artifacts** — single collapsed `<details>` containing all round files, workflow, and idea prompt rendered as readable markdown (not raw `<pre>` dumps); scratch/prototype files included when present

`DEGRADED` reports show a banner callout explaining partial data and recommending pickup.

## Scratch/prototype mode

```text
/workshop --prototype <idea>
```

adds `workshop_scratch` to main expert tools. Each expert receives a one-run nonce; only salted nonce hashes are stored in artifacts, and policy is revoked at run end.

Important: `workshop_scratch` is **artifact-contained, not sandboxed**. Its `bash -lc` command runs as the local user from the scratch directory and can still read/write outside that directory if the command does so.

## Model configuration

Resolution order:

1. role-specific slash flags (`--strong-model`, `--planner-model`, `--expert-model`, `--junior-model`, `--synth-model`)
2. `models.<role>` in config
3. parent Pi session model

Missing required `strongModel` is a critical doctor/config/run preflight failure. Unknown provider-qualified model IDs warn and require UI confirmation; non-UI runs fail closed.

## Configuration

Config precedence:

```text
built-in defaults → ~/.pi/agent/pi-workshop.config.json → nearest project .pi/pi-workshop.config.json → slash flags / tool params
```

Minimal defaults:

```json
{
  "defaults": {
    "rounds": 4,
    "webResearch": false,
    "localBash": false,
    "planExperts": true,
    "subagents": false,
    "expertSubagents": false,
    "prototyping": false,
    "htmlReport": false
  }
}
```

Built-in `workshop` is privileged and enables web research, parent briefs, local bash, expert subagents, prototyping, and HTML reports. Use it only when you intend to confirm local-user authority.

## Artifacts and privacy

By default artifacts are cwd-local:

```text
.pi/workshops/<timestamp-slug>/
```

Absolute/symlink escapes are rejected for beta run output. Key files include `idea.md`, `workflow.md`, `manifest.json`, `round_N_<expert>.md`, `round_N_synthesis.md`, `resolution.md`, `transcript.md`, `user-answers.md`, optional `scratch/<expert>/...`, and optional `report.html`.

pi-workshop does not collect telemetry or phone home. Web research tools, when enabled, use the providers configured in your Pi installation. The extension no longer scans home-directory locations or OS download folders.

## Troubleshooting

- `pi` not on PATH: run from a shell where Pi is installed, or use the absolute Pi binary.
- Node too old: use Node 20+.
- Missing model: run `pi --list-models`, then configure `models.strongModel`.
- Unknown model warning: fix the ID or confirm in the UI for one run.
- `DEGRADED`: one or more child experts/synthesizers failed strict validation (for example blank output, nonzero exit, timeout, or malformed synthesis status). Later bad output is written as an explicit failure marker and the runner preserves the last reliable synthesis instead of overwriting `resolution.md` with empty text.
- Non-UI privileged failure: rerun in the TUI and confirm, or disable privileged flags.
- Artifact permission failure: ensure the repo cwd can write `.pi/workshops/`.
- Private git auth: use an SSH `git:` install URL and working SSH keys.

## Development / validation

```bash
cd ~/.pi/agent/extensions/workshop
npm test
npm run smoke
npm run validate
```
