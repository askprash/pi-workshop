# Code Context

## Files Retrieved
1. `artifacts.ts` (lines 1-260) - artifact/scratch path helpers, manifest generation, policy writes/revocation.
2. `index.ts` (lines 1184-1205) - workshop run directory construction and initial artifact writes.
3. `index.ts` (lines 1211-1272) - scratch policy lifecycle setup/revocation and workflow text.
4. `index.ts` (lines 2413-2489) - `workshop_scratch` path gate, nonce validation, scratch file writes, and unsandboxed subprocess execution.
5. `.pi/workshops/20260529T024827214Z-pi-workshop-is-a-pi-agent-extension-that-runs-re/idea.md` (lines 1-11) - release-prep/security questions being assessed.
6. `.pi/workshops/20260529T024827214Z-pi-workshop-is-a-pi-agent-extension-that-runs-re/working-resolution.md` (lines 1-61) - current synthesis: artifact-contained is acceptable only for placement; prototype remains local shell execution.

## Key Code

### Path construction and containment helpers
- `artifacts.ts` lines 33-35: `safeSegment()` lowercases names, replaces non `[a-z0-9_.-]` with `-`, trims dashes, truncates to 80 chars, fallback `item`.
- `artifacts.ts` lines 37-40: `assertInside(parent, child)` uses `path.relative`; rejects `..` or absolute rel paths.
- `artifacts.ts` lines 42-50: `splitSafeRelativePath()` rejects absolute paths, empty paths, `.`/`..` segments, and separator-containing segments after splitting on `/` or `\`.
- `artifacts.ts` lines 52-73: `ensureDirInsideNoSymlinks(root, relativeParts)` realpaths `root`, creates each directory with mode `0o700`, rejects symlink/non-directory segments, realpaths each segment, and asserts it remains inside real root.
- `artifacts.ts` lines 75-114: `writeScratchFileNoSymlink(root, relativePath, content)` uses the relative path splitter, verifies parent via `ensureDirInsideNoSymlinks`, rejects existing symlink/directory target, then opens with `O_WRONLY|O_CREAT|O_TRUNC|O_NOFOLLOW` and mode `0o600` inside a mutation queue.

### Generic writes are not contained by `artifacts.ts`
- `artifacts.ts` lines 116-124: `writeFileQueued(filePath, content)` and `writeJsonQueued(filePath, value)` create `path.dirname(filePath)` recursively and write UTF-8. They perform no run-directory containment, no symlink check, and no explicit file/directory modes.
- `artifacts.ts` lines 165-183: `writeScratchPolicy(workshopDir, ...)` writes `.scratch-policy.json` via `writeJsonQueued(path.join(workshopDir, SCRATCH_POLICY_FILE), policy)`.
- `artifacts.ts` lines 204-229: `revokeScratchPolicy(workshopDir)` reads/writes the same policy path via `writeJsonQueued`.

### Manifest generation/write behavior
- `artifacts.ts` lines 233-244: `artifactManifestEntries(workshopDir)` recursively lists files under `workshopDir`, skips only `manifest.json`, stats each file, records `{ path: rel, bytes, sha256 }`, and sorts by relative path.
- `artifacts.ts` lines 246-256: `writeRunManifest(workshopDir, manifest)` writes `manifest.json.tmp` in the workshop directory, then `fs.rename(tmpPath, manifestPath)`. This is atomic rename on same filesystem, but it is not routed through `withFileMutationQueue`, does not `fsync` temp file/directory, and leaves `manifest.json.tmp` if the process dies before rename.

### Workshop and scratch call sites
- `index.ts` lines 1184-1190: `workshopDir` is either `resolveMaybe(baseCwd, params.outputDir)` or default `path.join(baseCwd, ".pi", "workshops", timestamp-slug)`. `outputDir` may therefore be absolute/outside the default run tree unless constrained elsewhere.
- `index.ts` lines 1190-1193: only prototyping mode checks `realWorkshopDir.includes(`${path.sep}.pi${path.sep}workshops${path.sep}`)`. Non-prototype artifact writes can target arbitrary `outputDir`.
- `index.ts` lines 1200-1205 and later grep hits show all normal artifacts (`idea.md`, `working-resolution.md`, `user-answers.md`, plans, briefs, critiques, final, transcript, report) are written via `writeFileQueued` to paths derived from `workshopDir`.
- `index.ts` lines 2413-2420: `workshop_scratch` accepts `params.workshopDir`, resolves it against tool cwd, requires existence and realpath containing `/.pi/workshops/`, then reads policy from that directory.
- `index.ts` lines 2421-2428: nonce-gates by expert segment and writes requested files under `scratch/<expert>/` via `writeScratchFileNoSymlink`.
- `index.ts` lines 2435-2441: scratch commands run `pi.exec("bash", ["-lc", params.command], { cwd: realScratchRoot, ... })`. This is explicitly not sandboxed; the process runs as the local user and can read/write outside scratch/workshop if shell permissions allow.
- `index.ts` lines 2451-2489: scratch artifact markdown records the safety note: “artifact-contained, not sandboxed. The command ran as the local user from the scratch directory.” The artifact file itself is written through `writeScratchFileNoSymlink` under scratch root.

## Architecture
- `artifacts.ts` separates two classes of writes:
  - Scratch writes: relatively strong path hygiene (`realpath`, no symlink dirs, `O_NOFOLLOW`, `0o700` dirs, `0o600` files) under a caller-provided root.
  - General artifact writes: queued convenience writes to any caller-provided `filePath`, with recursive directory creation and no containment/symlink/mode hardening.
- Run artifacts are rooted in `workshopDir`, but `workshopDir` can be user/config supplied. Default is `baseCwd/.pi/workshops/<timestamp-slug>`; absolute/custom output directories remain possible, especially outside prototype mode.
- Scratch/prototype has a policy file with per-expert nonce hashes, TTL, and `artifactContainedNotSandboxed: true`. Revocation is attempted at normal completion and again in `finally`, but this is policy cleanup, not filesystem cleanup.
- Manifest creation scans the workshop directory after revocation and includes all files except `manifest.json`; `.scratch-policy.json` and scratch artifacts are included. Symlink entries are skipped by recursive listing.

## Security observations for expert
- Artifact path construction is mostly caller-root-relative, not globally sandboxed. The strongest containment is only for `writeScratchFileNoSymlink`; generic artifact writes trust `workshopDir`/`filePath`.
- Atomic manifest write is same-directory temp + rename, but not queued and not crash-durable (`fsync` absent). Stale `manifest.json.tmp` can remain after interruption and may be included in a later manifest scan because only `manifest.json` is excluded.
- Permissions are hardened only for scratch-created dirs/files. Normal artifacts and policy/manifest writes rely on process umask/default directory perms; `writeFileQueued` may create directories with default permissions.
- Cleanup behavior: no artifact deletion/cleanup in `artifacts.ts`; scratch policy is revoked, but scratch files and all artifacts persist. If revocation/write manifest fails, warnings/errors are recorded by caller, not remediated.
- “Artifact-contained, not sandboxed” is accurate only for files the tool writes and the markdown artifact it records. The scratch shell itself is unsandboxed local `bash -lc` from scratch cwd, so command effects are not contained.

## Writes outside the run directory
- Inside `artifacts.ts`, `writeFileQueued`, `writeJsonQueued`, and `writeRunManifest` can write wherever their `filePath`/`workshopDir` arguments point; there is no intrinsic run-directory assertion.
- In the main call path, custom `params.outputDir` can make the entire run directory outside default `.pi/workshops` when prototyping is disabled (`index.ts` lines 1184-1193).
- In scratch mode, artifact/helper-created files are under `realWorkshopDir/scratch/<expert>`, but the subprocess command can write anywhere permitted by the OS user.

## Start Here
Open `artifacts.ts` lines 75-124 and 246-256 first: these show the difference between hardened scratch writes, generic unconstrained writes, and the manifest temp+rename implementation that drives most artifact security questions.

## Supervisor coordination
No blocker; no supervisor decision requested.

## Domain terms
- **Workshop Run** — one execution of the workshop flow for a technical idea or pickup session. A Workshop Run selects or receives a Panel, creates run artifacts, runs Assistant briefs when enabled, runs Expert critiques across rounds, runs Synthesizer passes, handles user-question pauses/cancellation/degradation, revokes Scratch Policy when relevant, and writes the final resolution/manifest.
