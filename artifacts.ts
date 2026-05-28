import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import * as fssync from "node:fs";
import * as path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { type ExpertInput } from "./schemas.ts";

export const SCRATCH_POLICY_FILE = ".scratch-policy.json";
export const MANIFEST_FILE = "manifest.json";

export type ScratchPolicyExpert = {
	name: string;
	nonceHash: string;
};

export type ScratchPolicy = {
	version: 1;
	runId: string;
	status: "active" | "revoked";
	createdAt: string;
	expiresAt: string;
	revokedAt?: string;
	allowedExperts: ScratchPolicyExpert[];
	artifactContainedNotSandboxed: true;
};

export type ScratchPolicyHandle = {
	policy: ScratchPolicy;
	noncesByExpert: Record<string, string>;
};

function logWarn(context: string, error: unknown): void {
	try {
		const msg = String((error as Error)?.message ?? error);
		process.stderr.write(`[pi-workshop] ${context}: ${msg}\n`);
	} catch {
		/* nothing we can do if stderr is broken */
	}
}

function safeSegment(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "item";
}

function assertInside(parent: string, child: string): void {
	const rel = path.relative(parent, child);
	if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`Path escapes allowed directory: ${child}`);
}

function splitSafeRelativePath(relativePath: string): string[] {
	if (path.isAbsolute(relativePath)) throw new Error(`Scratch file path must be relative: ${relativePath}`);
	const parts = relativePath.split(/[\\/]+/).filter((part) => part.length > 0);
	if (!parts.length) throw new Error("Scratch file path must name a file");
	for (const part of parts) {
		if (part === "." || part === ".." || part.includes(path.sep)) throw new Error(`Unsafe scratch path segment: ${relativePath}`);
	}
	return parts;
}

export async function ensureDirInsideNoSymlinks(root: string, relativeParts: string[]): Promise<string> {
	const realRoot = await fs.realpath(root);
	let current = realRoot;
	for (const part of relativeParts) {
		if (!part || part === "." || part === ".." || /[\\/]/.test(part)) throw new Error(`Unsafe scratch directory segment: ${part}`);
		let next = path.join(current, part);
		let stat = await fs.lstat(next).catch((error) => {
			if ((error as any)?.code === "ENOENT") return undefined;
			throw error;
		});
		if (!stat) {
			try {
				await fs.mkdir(next, { mode: 0o700 });
			} catch (error) {
				if ((error as any)?.code !== "EEXIST") throw error;
			}
			stat = await fs.lstat(next);
		}
		if (stat.isSymbolicLink()) throw new Error(`Refusing to use symlink scratch directory: ${next}`);
		if (!stat.isDirectory()) throw new Error(`Scratch path segment is not a directory: ${next}`);
		const realNext = await fs.realpath(next);
		assertInside(realRoot, realNext);
		current = realNext;
	}
	return current;
}

export async function writeScratchFileNoSymlink(root: string, relativePath: string, content: string): Promise<string> {
	const parts = splitSafeRelativePath(relativePath);
	const fileName = parts.pop();
	if (!fileName || fileName === "." || fileName === ".." || /[\\/]/.test(fileName)) throw new Error(`Unsafe scratch file name: ${relativePath}`);
	const parent = await ensureDirInsideNoSymlinks(root, parts);
	const realRoot = await fs.realpath(root);
	assertInside(realRoot, parent);
	const target = path.join(parent, fileName);
	const existing = await fs.lstat(target).catch((error) => {
		if ((error as any)?.code === "ENOENT") return undefined;
		throw error;
	});
	if (existing?.isSymbolicLink()) throw new Error(`Refusing to overwrite symlink scratch file: ${relativePath}`);
	if (existing?.isDirectory()) throw new Error(`Refusing to overwrite scratch directory as file: ${relativePath}`);
	const flags = fssync.constants.O_WRONLY | fssync.constants.O_CREAT | fssync.constants.O_TRUNC | (fssync.constants.O_NOFOLLOW ?? 0);
	await withFileMutationQueue(target, async () => {
		const parentStat = await fs.lstat(parent);
		if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw new Error(`Unsafe scratch file parent: ${relativePath}`);
		assertInside(realRoot, await fs.realpath(parent));
		const handle = await fs.open(target, flags, 0o600);
		try {
			await handle.writeFile(content, "utf8");
		} finally {
			await handle.close();
		}
	});
	return target;
}

export async function writeFileQueued(filePath: string, content: string): Promise<void> {
	await withFileMutationQueue(filePath, async () => {
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, content, "utf8");
	});
}

export async function writeJsonQueued(filePath: string, value: unknown): Promise<void> {
	await writeFileQueued(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function sha256File(filePath: string): Promise<string> {
	const data = await fs.readFile(filePath);
	return createHash("sha256").update(data).digest("hex");
}

export async function listFilesRecursive(root: string): Promise<string[]> {
	const files: string[] = [];
	async function walk(dir: string) {
		let entries: fssync.Dirent[] = [];
		try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (error) { logWarn(`listFilesRecursive(${dir})`, error); return; }
		for (const entry of entries) {
			if (entry.isSymbolicLink()) continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) await walk(full);
			else files.push(full);
		}
	}
	await walk(root);
	return files.sort();
}

export function hashScratchNonce(runId: string, expertSegment: string, nonce: string): string {
	return createHash("sha256").update(`${runId}\0${expertSegment}\0${nonce}`).digest("hex");
}

function validatePolicyShape(raw: unknown): ScratchPolicy {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid or missing workshop scratch policy");
	const policy = raw as ScratchPolicy;
	if (policy.version !== 1 || typeof policy.runId !== "string" || typeof policy.createdAt !== "string" || typeof policy.expiresAt !== "string") {
		throw new Error("Invalid or missing workshop scratch policy");
	}
	if (policy.status !== "active" && policy.status !== "revoked") throw new Error("Invalid workshop scratch policy status");
	if (!Array.isArray(policy.allowedExperts) || !policy.allowedExperts.every((entry) => entry && typeof entry.name === "string" && typeof entry.nonceHash === "string")) {
		throw new Error("Invalid workshop scratch policy experts");
	}
	return policy;
}

export async function writeScratchPolicy(workshopDir: string, experts: ExpertInput[], ttlSeconds: number): Promise<ScratchPolicyHandle> {
	const runId = randomUUID();
	const noncesByExpert: Record<string, string> = {};
	const allowedExperts = experts.map((expert) => {
		const name = safeSegment(expert.name);
		const nonce = randomUUID();
		noncesByExpert[name] = nonce;
		return { name, nonceHash: hashScratchNonce(runId, name, nonce) };
	});
	const policy: ScratchPolicy = {
		version: 1,
		runId,
		status: "active",
		createdAt: new Date().toISOString(),
		expiresAt: new Date(Date.now() + Math.max(60, ttlSeconds) * 1000).toISOString(),
		allowedExperts,
		artifactContainedNotSandboxed: true,
	};
	await writeJsonQueued(path.join(workshopDir, SCRATCH_POLICY_FILE), policy);
	return { policy, noncesByExpert };
}

export async function readScratchPolicy(workshopDir: string): Promise<ScratchPolicy> {
	const raw = JSON.parse(await fs.readFile(path.join(workshopDir, SCRATCH_POLICY_FILE), "utf8"));
	const policy = validatePolicyShape(raw);
	if (policy.status === "revoked") throw new Error("Workshop scratch policy has been revoked");
	const expiresAt = Date.parse(policy.expiresAt);
	if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) throw new Error("Workshop scratch policy has expired");
	return policy;
}

export function validateScratchNonce(policy: ScratchPolicy, expertSegment: string, nonce: string): boolean {
	const entry = policy.allowedExperts.find((item) => item.name === expertSegment);
	if (!entry) return false;
	const expected = Buffer.from(entry.nonceHash, "hex");
	const actual = Buffer.from(hashScratchNonce(policy.runId, expertSegment, nonce), "hex");
	return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function revokeScratchPolicy(workshopDir: string): Promise<ScratchPolicy | undefined> {
	const policyPath = path.join(workshopDir, SCRATCH_POLICY_FILE);
	let raw: any;
	try {
		raw = JSON.parse(await fs.readFile(policyPath, "utf8"));
	} catch (error) {
		if ((error as any)?.code === "ENOENT") return undefined;
		throw error;
	}
	if (raw && typeof raw === "object" && typeof raw.nonce === "string" && Array.isArray(raw.allowedExperts)) {
		raw = {
			version: 1,
			runId: typeof raw.runId === "string" ? raw.runId : "legacy-revoked",
			createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
			expiresAt: typeof raw.expiresAt === "string" ? raw.expiresAt : new Date().toISOString(),
			allowedExperts: raw.allowedExperts.map((name: unknown) => ({ name: safeSegment(String(name)), nonceHash: "revoked" })),
			artifactContainedNotSandboxed: true,
		};
	}
	if (raw && typeof raw === "object") delete raw.nonce;
	const policy = validatePolicyShape({
		...raw,
		status: "revoked",
		revokedAt: raw?.revokedAt ?? new Date().toISOString(),
	});
	await writeJsonQueued(policyPath, policy);
	return policy;
}

async function artifactManifestEntries(workshopDir: string): Promise<Array<{ path: string; bytes: number; sha256: string }>> {
	const files = await listFilesRecursive(workshopDir);
	const entries: Array<{ path: string; bytes: number; sha256: string }> = [];
	for (const file of files) {
		const rel = path.relative(workshopDir, file);
		if (rel === MANIFEST_FILE) continue;
		const stat = await fs.stat(file).catch(() => undefined);
		if (!stat?.isFile()) continue;
		entries.push({ path: rel, bytes: stat.size, sha256: await sha256File(file) });
	}
	return entries.sort((a, b) => a.path.localeCompare(b.path));
}

export async function writeRunManifest(workshopDir: string, manifest: Record<string, unknown>): Promise<string> {
	const manifestPath = path.join(workshopDir, MANIFEST_FILE);
	const artifacts = await artifactManifestEntries(workshopDir);
	const payload = { ...manifest, artifactListGeneratedAt: new Date().toISOString(), artifacts };
	const tmpPath = `${manifestPath}.tmp`;
	await fs.mkdir(path.dirname(tmpPath), { recursive: true });
	await fs.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
	await fs.rename(tmpPath, manifestPath);
	return manifestPath;
}
