# Code Context

## Files Retrieved
1. `artifacts.ts` (lines 1-255) - artifact helper module: scratch policy types, path containment, queued writes, recursive listing, manifest writer.
2. `index.ts` (lines 1-25, 191-193, 240-314, 460-615, 632-658, 877-954, 1010-1088, 1138, 1151-1341, 1389-1534, 1562-1620, 2258-2310, 2530-2632) - imports/call sites for artifact writes, child runner, nonce prompt path, run lifecycle, public restrictions, scratch tool adapter.
3. `logic.js` (lines 1-19) - shared expert-name canonicalization used by `index.ts`, duplicated in `artifacts.ts`.
4. `schemas.ts` (lines 30-109) - privileged vs public workshop schemas; public tool excludes output/cwd/bash/prototyping knobs.
5. `config.ts` (lines 1-80, 221-268) - built-in safety defaults and resolved limits used by run/scratch policy.
6. `tests/static-tests.mjs` (lines 34-98, 133-145) - mostly source-string security assertions and packaging checks.
7. `README.md` (lines 85-143, 181-191) - documented safety model, scratch non-sandbox warning, artifact/privacy claims.

## Key Code

- `artifacts.ts` has four responsibilities in one module: constants/types (`SCRATCH_POLICY_FILE`, `MANIFEST_FILE`, `ScratchPolicy`) at lines 8-29; path containment + scratch file writes at lines 45-113; generic queued write/list/hash helpers at lines 116-145; scratch policy + manifest generation at lines 148-255.

```ts
// artifacts.ts:116-124
export async function writeFileQueued(filePath: string, content: string): Promise<void> {
  await withFileMutationQueue(filePath, async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
  });
}
```

- Scratch containment is deeper than generic writes: `ensureDirInsideNoSymlinks` realpaths the root, walks parts, rejects symlink dirs, and asserts containment; `writeScratchFileNoSymlink` rejects absolute/`..`, uses `O_NOFOLLOW`, and rechecks parent before write (`artifacts.ts:50-113`).

- Scratch policy stores only hashes and rejects revoked/expired policy on read (`artifacts.ts:148-201`); revocation deletes legacy plaintext `nonce` and rewrites status `revoked` (`artifacts.ts:204-230`).

- Manifest generation enumerates every non-symlink file under `workshopDir`, excludes only `manifest.json`, hashes each file, writes `manifest.json.tmp`, then renames (`artifacts.ts:132-145`, `233-255`).

- `runWorkshop` validates `outputDir` once, then all normal artifacts are path-joined and written directly: `idea.md`, `working-resolution.md`, `user-answers.md`, plan/workflow, briefs, critiques, synthesis, final, transcript, report, manifest (`index.ts:1218-1246`, `1272-1288`, `1341`, `1390-1391`, `1409-1444`, `1503-1534`, `1565-1620`).

- Scratch nonce path: policy is created after experts/tools are resolved (`index.ts:1298-1314`); nonce is injected only into the child system prompt (`index.ts:632-658`, `1411-1415`, `1453-1458`); `runChildPi` writes that system prompt to a `0600` temp file and deletes it (`index.ts:473-485`, `612-614`).

- Scratch tool adapter validates active policy and nonce, then writes uploaded files via scratch-safe writer and executes `bash -lc` from the scratch dir (`index.ts:2541-2583`); result artifact is also written through `writeScratchFileNoSymlink` (`index.ts:2594-2632`).

## Architecture

Data flow:
1. `index.ts` is the Pi extension/orchestrator adapter. It resolves config/models, chooses `workshopDir`, validates realpath containment under `baseCwd`, then owns most artifact path construction (`index.ts:1151-1246`).
2. `artifacts.ts` is a filesystem/security helper. It does not own a workshop-run root object; callers pass raw strings. Generic `writeFileQueued` has no containment policy, while scratch-specific writes do.
3. Prototyping adds a file-backed capability policy: `writeScratchPolicy` -> nonce in expert system prompt -> `workshop_scratch` reads `.scratch-policy.json` -> validates nonce -> writes/executes under `scratch/<expert>` -> run end revokes -> manifest records revoked policy summary (`index.ts:1312-1314`, `1600-1618`).
4. Manifest generation is last: after optional HTML report and scratch revocation, `writeRunManifest` hashes artifacts and embeds run metadata/child runs (`index.ts:1587-1620`; `artifacts.ts:233-255`).

## Architecture-deepening candidates

1. **Module depth / locality: `artifacts.ts` is a shallow utility bag.** It mixes generic writes, scratch path containment, nonce policy, and manifest generation (`artifacts.ts:1-255`). The import fan-in from `index.ts` is broad and function-level (`index.ts:13`). High leverage because most security invariants cross this seam.

2. **Tangled seam: artifact root containment lives in `index.ts`, not at the write boundary.** `runWorkshop` validates `realWorkshopDir` inside `realBaseCwd` once (`index.ts:1222-1231`), but normal writes use raw `workshopDir` strings and generic `writeFileQueued` (`artifacts.ts:116-124`). This is safe only by convention/local call-site discipline; future artifact call sites can bypass containment silently.

3. **Path containment policy is not uniform.** Assistant context paths realpath inside cwd (`index.ts:2291-2310`); run output dirs must realpath inside cwd and, for prototyping, merely contain `/.pi/workshops/` (`index.ts:1222-1231`); `workshop_scratch` accepts any existing real path containing `/.pi/workshops/` and relies on nonce policy rather than cwd containment (`index.ts:2552-2561`). This is a shallow string-based seam with security implications if nonce handling or path provenance changes.

4. **Scratch policy lifecycle is split across three places.** Policy creation/revocation is in `runWorkshop` (`index.ts:1249-1263`, `1312-1314`, `1600-1618`), policy mechanics are in `artifacts.ts` (`148-230`), and execution limits/path checks are in the registered scratch tool (`index.ts:2541-2583`). Also, expert name canonicalization is duplicated: `logic.js:1-6` vs `artifacts.ts:41-43`; divergence would break nonce lookup/validation.

5. **Manifest generation has high audit leverage but broad data exposure.** It embeds full `childRuns` plus params/model/config metadata (`index.ts:1601-1619`) and hashes all files under the run dir (`artifacts.ts:233-255`). Tool-event previews are redacted (`index.ts:240-253`, `528-537`), but child text/artifacts are not enforce-redacted if a model prints a nonce/secret despite instructions (`index.ts:657-658`).

6. **Resource bounds are uneven.** Scratch uploads are capped at 20 files / 256KB (`index.ts:2564-2569`) and stdout/stderr are truncated into scratch artifacts (`index.ts:2594-2626`), but commands can create large files in scratch; report generation reads selected scratch files fully (`index.ts:1032-1042`) and manifest hashing reads all files (`artifacts.ts:127-145`, `233-241`).

7. **Observability seam looks partially stubbed.** `runChildPi` requires `runDir` but does not use it (`index.ts:460-485`; grep showed only call sites). `createRunLocalFileAudit` intentionally returns an empty scanner (`index.ts:308-314`), while the manifest still includes `observedFiles` (`index.ts:1615-1617`). Artifact hashes are real, but non-workshop output observability is shallow.

8. **Tests are mostly static for security-critical behavior.** `tests/static-tests.mjs` asserts source substrings for nonce hashing, revocation, `O_NOFOLLOW`, context restrictions, and redaction (`lines 44-82`) plus package contents (`133-145`). There are behavioral tests for `logic.js`, but no temp-dir runtime tests for symlink/path traversal, expiry/revocation, manifest contents, or scratch resource behavior.

## Security / test implications

- Strong current controls: public schema excludes privileged knobs (`schemas.ts:96-109`), assistant params force privileged flags false (`index.ts:2269-2288`), context paths realpath inside cwd (`index.ts:2291-2310`), scratch policy stores hashes not plaintext (`artifacts.ts:165-184`), and scratch writes reject symlinks (`artifacts.ts:60-113`).
- Main residual risk is seam drift, not obvious missing checks: root containment, expert-name canonicalization, policy lifecycle, and manifest audit are distributed across modules and call sites.
- `workshop_scratch` is correctly documented as artifact-contained, not sandboxed (`README.md:134-143`), but report/manifest code can still amplify large or sensitive scratch outputs.

## Start Here

Open `artifacts.ts` lines 41-255 first, then `index.ts` lines 1151-1620 and 2530-2632. Those ranges contain the highest-leverage artifact/security seams: root containment, scratch policy lifecycle, all write call sites, report/manifest generation, and the scratch execution adapter.
