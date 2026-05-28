import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const index = fs.readFileSync(path.join(root, 'index.ts'), 'utf8');
const schemasPath = path.join(root, 'schemas.ts');
const schemas = fs.existsSync(schemasPath) ? fs.readFileSync(schemasPath, 'utf8') : '';
const schemasOrIndex = schemas || index;
const config = JSON.parse(fs.readFileSync(path.join(root, 'pi-workshop.config.example.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

assert.equal(pkg.pi.extensions[0], './index.ts', 'package.json exposes index.ts as pi extension');
assert.ok(pkg.keywords.includes('pi-package'), 'package includes pi-package keyword');
assert.ok(config.defaults, 'example config has defaults');
assert.ok(config.profiles.safe, 'example config has safe profile');
assert.ok(config.limits.childTimeoutSeconds > 0, 'example config documents child timeout');
assert.ok(config.limits.globalTimeoutSeconds >= config.limits.childTimeoutSeconds, 'global timeout covers child timeout');

const publicSchemaStart = schemasOrIndex.indexOf('PublicWorkshopParams = Type.Object');
const publicSchemaEnd = schemasOrIndex.indexOf('type ExpertInput', publicSchemaStart);
assert.ok(publicSchemaStart > 0 && publicSchemaEnd > publicSchemaStart, 'public workshop schema exists');
const publicSchema = schemasOrIndex.slice(publicSchemaStart, publicSchemaEnd);
for (const forbidden of ['outputDir', 'cwd', 'localBash', 'expertSubagents', 'prototyping', 'workshop', 'tools', 'model']) {
  assert.ok(!new RegExp(`\\n\\t${forbidden}:`).test(publicSchema), `public schema does not expose property ${forbidden}`);
}

assert.ok(index.includes('parameters: PublicWorkshopParams'), 'LLM workshop tool uses restricted public schema');
assert.ok(index.includes('sanitizePublicWorkshopParams'), 'public params are sanitized before runWorkshop');
assert.ok(index.includes('SCRATCH_POLICY_FILE'), 'scratch policy file is enforced');
assert.ok(index.includes('nonce: Type.String'), 'workshop_scratch requires nonce');
assert.ok(index.includes('artifact-contained, not sandboxed'), 'scratch safety warning is present');
assert.ok(index.includes('process.kill(-proc.pid'), 'child process group cleanup is present');
assert.ok(index.includes('Unknown /workshop flag'), 'unknown slash flags are rejected');
assert.ok(index.includes('workshop-cancel'), 'cancel command is registered');
assert.ok(index.includes('workshop-doctor'), 'doctor command is registered');
assert.ok(index.includes('workshop-observatory'), 'navigable observatory command is registered');
assert.ok(index.includes('--open-observatory'), 'slash workflow can open observatory at run start');
assert.equal(config.defaults.openObservatory, false, 'example config documents openObservatory default');
assert.ok(index.includes('Ctrl+Alt+W') || index.includes('ctrlAlt("w")'), 'observatory shortcut is documented/registered');
assert.ok(index.includes('downloadedFiles'), 'manifest records detected downloads');
assert.ok(index.includes('ToolAuditEvent'), 'child tool events are tracked for observability');
assert.ok(index.includes('writeRunManifest'), 'manifest writer is present');

console.log('static tests ok');
