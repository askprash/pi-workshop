import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  assertUniqueExpertNamesForArtifacts,
  expertArtifactSegment,
  parsePlannedExperts,
  selectRequestedProfile,
} from '../logic.js';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const index = read('index.ts');
const artifacts = read('artifacts.ts');
const configSource = read('config.ts');
const schemas = read('schemas.ts');
const readme = read('README.md');
const config = JSON.parse(read('pi-workshop.config.example.json'));
const pkg = JSON.parse(read('package.json'));

assert.ok(!fs.existsSync(path.join(root, 'REVIEW.html')), 'stale REVIEW.html has been removed from repo');
assert.equal(pkg.version, '0.1.0-beta', 'package version uses initial public beta branding');
assert.ok(!JSON.stringify(pkg).includes('safe-beta') && !JSON.stringify(pkg).includes('TODO'), 'package metadata has no safe-beta branding or TODO comments');
assert.ok(pkg.repository.url.includes('github.com/askprash/pi-workshop.git'), 'package repository points at public GitHub repo');
assert.ok(pkg.bugs.url.includes('github.com/askprash/pi-workshop/issues'), 'package bugs URL points at public GitHub repo');
assert.ok(pkg.homepage.includes('github.com/askprash/pi-workshop#readme'), 'package homepage points at public GitHub repo');
assert.equal(pkg.pi.extensions[0], './index.ts', 'package.json exposes index.ts as pi extension');
assert.ok(pkg.keywords.includes('pi-package'), 'package includes pi-package keyword');
for (const peer of ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox']) {
  assert.equal(pkg.peerDependencies[peer], '*', `Pi-bundled package ${peer} is declared as a wildcard peer dependency`);
}
assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, 'package has no non-Pi runtime dependencies to bundle');
assert.ok(config.defaults, 'example config has defaults');
assert.ok(!config.profiles.safe, 'example config does not override immutable built-in safe profile');
assert.ok(config.profiles['trusted-local'], 'example config uses a non-reserved trusted-local profile for parent briefs');
assert.ok(config.limits.childTimeoutSeconds > 0, 'example config documents child timeout');
assert.ok(config.limits.globalTimeoutSeconds >= config.limits.childTimeoutSeconds, 'global timeout covers child timeout');
assert.ok(pkg.files.includes('logic.js'), 'package whitelist includes shared pure logic helpers');

const publicSchemaStart = schemas.indexOf('PublicWorkshopParams = Type.Object');
const publicSchemaEnd = schemas.indexOf('export type ExpertInput', publicSchemaStart);
assert.ok(publicSchemaStart > 0 && publicSchemaEnd > publicSchemaStart, 'public workshop schema exists');
const publicSchema = schemas.slice(publicSchemaStart, publicSchemaEnd);
for (const forbidden of ['outputDir', 'cwd', 'localBash', 'expertSubagents', 'prototyping', 'workshop', 'tools', 'model']) {
  assert.ok(!new RegExp(`\\n\\t${forbidden}:`).test(publicSchema), `public schema does not expose property ${forbidden}`);
}
assert.ok(publicSchema.includes('inside the current cwd'), 'public contextPaths document cwd restriction');
assert.ok(!schemas.includes('oracle') && !schemas.includes('delegate'), 'assistant briefs expose only scout/researcher agents');

assert.ok(index.includes('parameters: PublicWorkshopParams'), 'LLM workshop tool uses restricted public schema');
assert.ok(index.includes('sanitizePublicWorkshopParams'), 'public params are sanitized before runWorkshop');
assert.ok(index.includes('restrictAssistantContextPaths'), 'assistant context paths are restricted');
assert.ok(index.indexOf('restrictAssistantContextPaths') < index.indexOf('preflightWorkshop(pi, ctx, safeParams)'), 'assistant context path restriction runs before preflight/runWorkshop');
assert.ok(index.includes('SCRATCH_POLICY_FILE'), 'scratch policy file is enforced');
assert.ok(index.includes('nonce: Type.String'), 'workshop_scratch requires nonce at call time');
assert.ok(index.includes('artifact-contained, not sandboxed'), 'scratch safety warning is present');
assert.ok(index.includes('process.kill(-proc.pid'), 'child process group cleanup is present');
assert.ok(index.includes('Unknown /workshop flag'), 'unknown slash flags are rejected');
assert.ok(index.includes('workshop-cancel'), 'cancel command is registered');
assert.ok(index.includes('workshop-doctor'), 'doctor command is registered');
assert.ok(index.includes('promptSlashWorkshopLaunchSettings'), 'empty slash workshop commands open interactive settings wizard');
assert.ok(index.includes('Use these defaults') && index.includes('Configure interactively'), 'settings wizard can accept defaults or configure options');
assert.ok(index.includes('Parent subagent briefs (--subagents)') && index.includes('HTML report (--html-report)') && index.includes('Prototype scratchpad (--prototype)'), 'settings wizard exposes subagents, report, and prototyping toggles');
assert.ok(index.includes('workshop-observatory'), 'navigable observatory command is registered');
assert.ok(index.includes('--open-observatory'), 'slash workflow can open observatory at run start');
assert.equal(config.defaults.openObservatory, false, 'example config documents openObservatory default');
assert.ok(index.includes('Ctrl+Alt+W') || index.includes('ctrlAlt("w")'), 'observatory shortcut is documented/registered');
assert.ok(index.includes('✦ ${theme.bold("Observatory")}') && index.includes('renderObservatoryMode'), 'observatory has branded full-screen renderer');
assert.ok(index.includes('outputPreviewFromText(run.text)'), 'observatory subagent output preview uses multi-line child output excerpts');
assert.ok(index.includes('function extractVerdict') && index.includes('function extractStatus') && index.includes('function isConverged'), 'HTML report/pickup helpers are defined');
assert.ok(index.includes('width: "100%"') && index.includes('maxHeight: "100%"') && index.includes('row: 0') && index.includes('col: 0'), 'observatory opens as a full-screen overlay');
assert.ok(index.includes('observedFiles'), 'manifest records only explicit observed artifact files');
assert.ok(!index.includes('path.join(os.homedir(), "Downloads")'), 'code does not scan home Downloads');
assert.ok(!readme.includes('~/Downloads'), 'README does not document home Downloads scanning');
assert.ok(index.includes('ToolAuditEvent'), 'child tool events are tracked for observability');
assert.ok(index.includes('extractAssistantUpdateText'), 'child JSON parsing captures streamed assistant text as fallback');
assert.ok(index.includes('blockingChildRunIssue') && index.includes('childRunFailureMarkdown'), 'blank/nonzero child outputs are promoted to explicit degraded failure artifacts');
assert.ok(index.includes('preserving last reliable synthesis'), 'failed later rounds preserve the last reliable synthesis instead of overwriting it');
assert.ok(index.indexOf('if (synthIssue || malformedSynthesis)') < index.indexOf('await writeFileQueued(workingPath, synth.text)'), 'working resolution is updated only after synthesis strict validation');
assert.ok(index.includes('Workshop Q&A') && index.includes('questionHelperSystemPrompt'), 'question UI supports inline answers plus helper-agent clarification');
assert.ok(!index.includes('Type your answer or clarification here.'), 'question UI does not prefill deletable placeholder answer text');
assert.ok(index.includes('Start typing your answer…'), 'question UI renders placeholder as a hint outside saved answer text');
assert.ok(index.includes('Current synthesis / resolution context'), 'question helper receives current synthesis context');
assert.ok(index.includes('writeRunManifest'), 'manifest writer is present');
assert.ok(index.includes('## Report brief') && index.includes('report-brief') && index.includes('next_action') && index.includes('parseReportBriefFencedBlock'), 'synthesizer is scaffolded to produce structured report-brief fenced block');
assert.ok(index.includes('renderMarkdownLite') && index.includes('Before you proceed') && index.includes('round-arc') && index.includes('ledger-summary') && index.includes('Evidence ledger'), 'HTML report has polished human-readable sections beyond raw pre blocks');
assert.ok(index.includes('renderLedgerDetailsRow') && index.includes('conv-value'), 'HTML report surfaces child-run trust/degraded evidence');
assert.ok(readme.includes('report-brief') && readme.includes('child-run trust ledger') || readme.includes('Details & metrics') || readme.includes('Evidence ledger'), 'README documents high-quality HTML report contents');
assert.ok(index.includes('redactSensitiveForAudit'), 'tool-event audit previews redact sensitive fields');
assert.ok(index.includes('argsPreview: previewUnknown(redactSensitiveForAudit('), 'tool-event args are redacted before manifest/dashboard preview');

assert.ok(!artifacts.includes('nonce: string;'), 'ScratchPolicy does not persist plaintext nonce');
assert.ok(artifacts.includes('nonceHash') && artifacts.includes('hashScratchNonce'), 'scratch policy stores hashed nonces');
assert.ok(artifacts.includes('status: "active" | "revoked"'), 'scratch policy has active/revoked status');
assert.ok(artifacts.includes('revokeScratchPolicy'), 'scratch policy revocation helper exists');
assert.ok(index.includes('revokeScratchPolicyForRun') && index.includes('await revokeScratchPolicyForRun();'), 'runWorkshop revokes scratch policy');
assert.ok(!index.includes('path.join(options.runDir, `_system_'), 'system prompts are not persisted under workshop dir');
assert.ok(index.includes('os.tmpdir()') && index.includes('mkdtemp') && index.includes('fs.rm(systemTempDir'), 'system prompts use cleaned temp files');
const roundPromptStart = index.indexOf('function buildRoundPrompt');
const roundPromptEnd = index.indexOf('function plannerSystemPrompt', roundPromptStart);
assert.ok(roundPromptStart > 0 && roundPromptEnd > roundPromptStart, 'round prompt source is located');
const roundPromptSource = index.slice(roundPromptStart, roundPromptEnd);
assert.ok(!roundPromptSource.includes('scratchNonce'), 'nonce is not placed in normal round prompt / child argv');
assert.ok(index.includes('localBash: false'), 'planner/synth tool calls explicitly avoid local bash');
assert.ok(!index.includes('defaultToolsFor({ webResearch: webResearchEnabled, localBash: localBashEnabled })'), 'planner/synth do not inherit localBashEnabled');
assert.ok(artifacts.includes('ensureDirInsideNoSymlinks') && artifacts.includes('O_NOFOLLOW'), 'scratch file creation is symlink-safe');
assert.ok(!index.includes('writeFileQueued(target, file.content)'), 'scratch uploaded files are not written through generic queued writer');
assert.ok(configSource.includes('projectConfigPath'), 'resolved config tracks project config path');
assert.ok(configSource.includes('projectConfig?: WorkshopConfig'), 'resolved config tracks project config source for privilege attribution');
assert.ok(configSource.includes('profiles.safe is immutable'), 'built-in safe profile cannot be overridden by config');
assert.ok(index.includes('confirmProjectPrivilegedDefaults'), 'privileged workshop modes are confirmed/blocked');
assert.ok(index.includes('resolveWorkshopModels'), 'doctor/config/run share model resolution helper');
assert.ok(index.includes('missingStrongModelGuidance'), 'missing strongModel guidance is shared');
assert.ok(index.includes('confirmUnknownConfiguredModels'), 'unknown configured models require confirmation/fail closed');
assert.ok(index.includes('runChildPi({') && index.includes('assistantBriefSystemPrompt'), 'parent briefs use direct restricted child runners');
assert.ok(index.includes('noContextFiles: true') && index.includes('--no-context-files'), 'brief runners disable project context files');
assert.ok(!index.includes('/run ${agentSpec}'), 'parent briefs do not invoke global /run scout/researcher');
assert.ok(!index.includes('tools: "subagent"'), 'parent briefs do not use subagent tool');
assert.ok(readme.includes('Assistant context paths must exist and realpath-resolve inside the current cwd'), 'README documents assistant context path restriction');
assert.ok(readme.includes('requires UI confirmation'), 'README documents privileged confirmation');
assert.ok(readme.includes('interactive settings wizard'), 'README documents empty slash-command settings wizard');
assert.ok(readme.includes('public beta with safe defaults'), 'README uses public beta safe-defaults branding');
assert.ok(readme.includes('git:github.com/askprash/pi-workshop@v0.1'), 'README install command points at public GitHub repo and v0.1 tag');
assert.ok(readme.includes('git:github.com/askprash/pi-workshop'), 'README uninstall command points at public GitHub repo');
assert.ok(readme.includes('declared as peer dependencies'), 'README explains Pi-bundled runtime dependencies');
assert.ok(!readme.includes('safe beta') && !readme.includes('Safe-beta'), 'README no longer uses safe-beta branding');
assert.ok(!readme.includes('.scratch-policy.json` nonce'), 'README no longer says scratch policy contains plaintext nonce');

assert.equal(selectRequestedProfile({ profile: 'workshop' }, {}), 'workshop', 'defaults.profile selects default profile');
assert.equal(selectRequestedProfile({ workshop: true }, {}), 'workshop', 'defaults.workshop selects workshop profile');
assert.equal(selectRequestedProfile({ workshop: true }, { profile: 'safe' }), 'safe', 'explicit profile wins over defaults.workshop');
assert.equal(selectRequestedProfile({ profile: 'workshop' }, { workshop: false }), undefined, '--no-workshop neutralizes default workshop selection');
assert.equal(selectRequestedProfile({ profile: 'safe' }, { workshop: true }), 'workshop', '--workshop wins over defaults.profile');

const validPlan = JSON.stringify({
  experts: [
    { name: 'ML Expert', stance: 'Own ML risks', assistantBriefs: [{ agent: 'scout', task: 'Inspect local model code' }] },
    { name: 'Systems', stance: 'Own implementation', assistantBriefs: [{ agent: 'researcher', task: 'Check prior art' }] },
  ],
});
const parsedPlan = parsePlannedExperts(validPlan);
assert.equal(parsedPlan?.length, 2, 'valid planner JSON parses');
assert.deepEqual(parsedPlan?.map((expert) => expert.name), ['ml-expert', 'systems'], 'planner names are canonicalized');
for (const rejected of [
  { experts: [{ name: 'a', stance: 'x', tools: 'bash' }, { name: 'b', stance: 'y' }] },
  { experts: [{ name: 'a', stance: 'x', model: 'provider/model' }, { name: 'b', stance: 'y' }] },
  { tools: 'bash', experts: [{ name: 'a', stance: 'x' }, { name: 'b', stance: 'y' }] },
  { experts: [{ name: 'a', stance: 'x', assistantBriefs: [{ agent: 'scout', task: 'x', model: 'provider/model' }] }, { name: 'b', stance: 'y' }] },
  { experts: [{ name: 'a', stance: 'x', assistantBriefs: [{ agent: 'scout', task: 'x', tools: 'bash' }] }, { name: 'b', stance: 'y' }] },
  { experts: [{ name: 'a', stance: 'x', assistantBriefs: [{ agent: 'oracle', task: 'x' }] }, { name: 'b', stance: 'y' }] },
  { experts: [{ name: 'ML Expert', stance: 'x' }, { name: 'ml-expert', stance: 'y' }] },
]) {
  assert.equal(parsePlannedExperts(JSON.stringify(rejected)), null, `planner JSON is rejected: ${JSON.stringify(rejected)}`);
}
assert.throws(
  () => assertUniqueExpertNamesForArtifacts([{ name: 'ML Expert' }, { name: 'ml-expert' }, { name: 'ML Expert!' }], 'User-supplied expert'),
  /must be unique after canonicalization/,
  'user-supplied duplicate/equivalent expert names fail clearly',
);
assert.equal(expertArtifactSegment({ name: 'ML Expert!' }), 'ml-expert', 'artifact segment canonicalization is deterministic');

const pack = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' });
assert.equal(pack.status, 0, `npm pack --dry-run succeeds: ${pack.stderr || pack.stdout}`);
const packInfo = JSON.parse(pack.stdout)[0];
const packedPaths = packInfo.files.map((file) => file.path);
for (const forbiddenPrefix of ['.pi/', 'plans/', 'validation/', 'worker/']) {
  assert.ok(!packedPaths.some((file) => file.startsWith(forbiddenPrefix)), `package excludes ${forbiddenPrefix}`);
}
assert.ok(!packedPaths.includes('progress.md'), 'package excludes progress.md');
for (const required of ['index.ts', 'config.ts', 'artifacts.ts', 'schemas.ts', 'logic.js', 'pi-workshop.config.example.json', 'README.md', 'LICENSE']) {
  assert.ok(packedPaths.includes(required), `package includes ${required}`);
}

console.log('static and behavioral tests ok');
