# pi-workshop / workshop pi extension

Global pi extension for intense technical ideation with world-class expert workshops.

## Installation

pi-workshop is distributed as a git-installable pi extension. From a shell where the `pi` CLI is on your PATH:

```bash
pi install <git-url-of-this-repo>
```

Verify it loaded:

```bash
pi -p "/workshop-config --check"
```

The check should print resolved defaults and config paths (or "built-in defaults only" if no config file exists yet).

### Requirements

- Node 20+
- A pi session with a model available — either inherited from the parent process or set explicitly in `pi-workshop.config.json` (see [Model configuration](#model-configuration) below)

### Uninstall

```bash
pi remove <git-url-of-this-repo>
```

## Safe-beta status

This is now a **safe beta** build. The core workshop flow is intact, but the release hardening changes make privilege boundaries explicit:

- the assistant-callable `workshop` tool is restricted;
- privileged modes are available only through slash commands/config, with project-config privileged defaults confirmed per run;
- web research and local bash are separate controls;
- assistant context paths must resolve inside the current cwd;
- scratch prototypes require an active per-expert run capability, store only nonce hashes, and revoke policy at run end; scratch is **artifact-contained, not sandboxed**;
- runs write `manifest.json` audit trails;
- slash flags/config are validated;
- `/workshop-doctor` and `/workshop-cancel` are available.

## Registered commands/tools

- `/workshop [--profile workshop] [--rounds 4] [--web-research] [--local-bash] [--subagents] [--expert-subagents] [--prototype] [--html-report] [--fixed-experts] [--keep-dashboard] [--observatory] <idea>`
- `/workshop-config [--profile workshop] [--check]` — show and validate resolved defaults/config/limits
- `/workshop-doctor [same flags as /workshop]` — preflight tools, models, config, and artifact permissions
- `/workshop-cancel` — abort the active slash workshop and write cancelled artifacts when possible
- `/workshop-hide` — hide the observatory widget
- `/workshop-observatory` — open a navigable TUI inspector for experts, subagents, tool events, and downloaded/saved files (`Ctrl+Alt+W`)
- `/workshop-sessions` — pick a previous session and show its saved resolution
- `/workshop-pickup [--rounds 2] [--web-research] [session-dir or instructions]` — linked continuation from a previous session
- `workshop` tool for the assistant — restricted public schema
- `workshop_scratch` tool for expert-only prototype experiments inside active workshop artifacts; it is globally registered but rejects calls without an active, unrevoked per-expert capability

## Assistant tool vs slash command privileges

The LLM-callable `workshop` tool intentionally **does not expose**:

- `cwd`
- `outputDir`
- `experts[].tools`
- custom expert model fields
- `localBash`
- `expertSubagents`
- `prototyping`
- `workshop=true` / privileged profiles

It may use `idea`, `rounds`, simple `experts`, `contextPaths`, `webResearch`, parent-run `subagents`, `htmlReport`, and the non-privileged `safe` profile. Assistant context paths must resolve inside the current cwd (existing paths are checked with realpath so symlink escapes are rejected). Use `/workshop` for explicit privileged modes.

Planner-selected experts are also sanitized: planner JSON cannot smuggle `tools` or `model` into child experts or assistant briefs, unsupported fields are rejected, and duplicate/equivalent expert artifact names fall back to the fixed safe panel. User-supplied duplicate/equivalent expert names fail clearly.

## Expert tools

Default child tools are read-only:

```text
read,grep,find,ls
```

Web research is separate from local shell:

```text
/workshop --web-research <idea>
```

adds:

```text
web_search,fetch_content,get_search_content,code_search
```

Local shell is explicit:

```text
/workshop --local-bash <idea>
```

adds `bash` to main expert agents only. The planner and synthesizer remain on read/search tools even when `--local-bash` is enabled. The prompt still forbids project mutation, but this is a real local shell with user permissions.

## Subagents

`--subagents` means **parent-orchestrated junior briefs**, not recursive expert delegation. The parent runs bounded `scout`/`researcher` brief tasks and passes the resulting files to each expert.

Direct main-expert subagent calls are off by default. To allow them, use:

```text
/workshop --expert-subagents <idea>
```

or the privileged `workshop` profile.

## Observatory / navigability

Interactive slash workshops show a live **workshop observatory** widget with per-expert boxes. The bottom status strip summarizes:

- subagents launched/running;
- files newly detected in `~/Downloads` during child runs;
- subagent saved-output/session/artifact files;
- tool events surfaced from child JSON streams.

Open the navigable inspector while Pi is idle with:

```text
/workshop-observatory
```

or `Ctrl+Alt+W`. During a long-running `/workshop` command, Pi may not dispatch new slash commands until the command returns. To enter the navigator live from the start of a run, launch with:

```text
/workshop --observatory <idea>
```

(`--open-observatory` and `--inspect` are aliases.) The inspector lets you drill into expert lanes, parent-run subagent briefs, direct subagent tool-call records when visible, downloaded/saved files, tool events, synthesis, and final artifact paths. It is intentionally observational: it does not grant additional permissions or open/edit files.

## Scratch/prototype mode

```text
/workshop --prototype <idea>
```

adds `workshop_scratch` to main expert tools and writes a nonce-free `.scratch-policy.json` policy. Each expert receives a different one-run nonce in its temporary system prompt; only salted hashes are stored in artifacts. Scratch calls must provide:

- `workshopDir`
- `expertName`
- `nonce`

The tool validates the real workshop path, allowed expert, hashed nonce, active/unrevoked policy status, expiry, and symlink-safe file writes under `scratch/<expert>/`. Scratch policy is revoked at run end and on errors when possible. Nonce-bearing system prompt files are created under the OS temp directory and removed after child process exit, not saved in workshop artifacts.

Important: `workshop_scratch` is **artifact-contained, not sandboxed**. Its `bash -lc` command runs as the local user from the scratch directory. It can still read/write outside that directory if the command does so. Use a real sandbox/container extension if you need OS-level isolation.

## Workshop profile

```text
/workshop --profile workshop <idea>
```

The built-in privileged profile enables:

- `webResearch`
- `localBash`
- parent-run `subagents`
- direct `expertSubagents`
- `prototyping`
- `htmlReport`

The built-in `safe` profile enables web research and parent-run briefs, but not local bash, direct expert subagents, or prototyping.

If a nearest project `.pi/pi-workshop.config.json` enables privileged defaults (`localBash`, `expertSubagents`, or `prototyping`) without explicit per-run slash flags/profile selection, `/workshop` and `/workshop-pickup` require per-run confirmation in the UI. In non-UI mode they fail closed with a clear message. Explicit `--local-bash`, `--expert-subagents`, `--prototype`, `--workshop`, `--profile ...`, or matching `--no-*` flags make the choice per-run and avoid surprise project-default escalation.

## Model configuration

pi-workshop does not ship with hardcoded default model IDs. At resolution time the extension will, in order:

1. Use the role-specific model from CLI flags (`--strong-model`, `--planner-model`, `--expert-model`, `--junior-model`, `--synth-model`).
2. Use `models.<role>` from `pi-workshop.config.json`.
3. Fall back to the model the parent `pi` session is running with.

If none of those resolve a `strongModel`, the workshop fails with a clear error pointing you here. To set explicit defaults, add a `models` block to `~/.pi/agent/pi-workshop.config.json`:

```json
{
  "models": {
    "strongModel": "provider/your-strong-model-id",
    "juniorModel": "provider/your-cheap-model-id"
  }
}
```

Use `pi --list-models` to discover available model IDs in your environment.

## Configuration

Config precedence:

```text
built-in defaults → ~/.pi/agent/pi-workshop.config.json → nearest project .pi/pi-workshop.config.json → slash flags / tool params
```

Use `/workshop-config --check` to validate config. Unknown config keys, unknown profiles, invalid booleans, and non-finite numeric limits are rejected.

`defaults.profile` selects a default named profile. `defaults.workshop: true` is shorthand for selecting the built-in `workshop` profile. Explicit `/workshop --profile ...`, `--workshop`, or `--no-workshop` wins over config defaults; `--no-workshop` neutralizes a default workshop profile selection. Project-config privileged defaults require per-run confirmation or fail closed outside the UI as described above.

See `pi-workshop.config.example.json`. Minimal shape:

```json
{
  "defaults": {
    "rounds": 4,
    "webResearch": false,
    "localBash": false,
    "subagents": false,
    "expertSubagents": false,
    "prototyping": false,
    "htmlReport": false
  },
  "profiles": {
    "workshop": {
      "webResearch": true,
      "localBash": true,
      "subagents": true,
      "expertSubagents": true,
      "prototyping": true,
      "htmlReport": true
    }
  },
  "limits": {
    "scratchTimeoutSeconds": 60,
    "maxScratchTimeoutSeconds": 300,
    "childTimeoutSeconds": 1200,
    "globalTimeoutSeconds": 7200
  }
}
```

Supported `--no-*` overrides include `--no-web-research`, `--no-local-bash`, `--no-subagents`, `--no-expert-subagents`, `--no-prototype`, `--no-html-report`, and `--no-workshop`.

## Artifacts

By default artifacts are written to:

```text
.pi/workshops/<timestamp-slug>/
```

`.pi/workshops/` contains local run artifacts and is intentionally ignored by git/npm packaging.

Key files:

- `idea.md` — original prompt
- `workflow.md` — config/delegation/tool policy
- `manifest.json` — extension version, params, models, tools, experts, timings, child exit codes, child tool-event summaries, detected downloads, errors, and artifact checksums
- `.scratch-policy.json` — nonce-free scratch policy/status/hash metadata when prototyping is enabled
- `round_N_<expert>.md` — expert critiques
- `round_N_synthesis.md` — per-round synthesis
- `working-resolution.md` — latest synthesis
- `resolution.md` — final resolution
- `transcript.md` — full transcript
- `user-answers.md` — authoritative interactive Q&A answers
- `scratch/<expert>/...` — prototype artifacts
- `report.html` — self-contained report when enabled

Statuses include `ACCEPT`, `ITERATE`, `REJECT`, `ILL_POSED`, `UNRESOLVED`, `DEGRADED`, `FAILED`, and `CANCELLED`.

## Privacy

pi-workshop does not collect telemetry or phone home. All artifacts stay in `.pi/workshops/`. Web research tools, when enabled, talk to the search providers configured in your pi installation — pi-workshop itself does not introduce additional network calls. Note: when running, the manifest records files newly detected in `~/Downloads` for audit; this is a known privacy consideration and is on by default for transparency.

## Development / validation

This directory is also a pi package:

```bash
cd ~/.pi/agent/extensions/workshop
npm test
npm run smoke
npm run validate
```

The smoke test loads the extension and runs `/workshop-config --check` without launching model-heavy workshops.
