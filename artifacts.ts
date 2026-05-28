import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as fssync from "node:fs";
import * as path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { type ExpertInput } from "./schemas.ts";

export const SCRATCH_POLICY_FILE = ".scratch-policy.json";
export const MANIFEST_FILE = "manifest.json";

export type ScratchPolicy = {
	version: 1;
	nonce: string;
	createdAt: string;
	expiresAt: string;
	allowedExperts: string[];
	artifactContainedNotSandboxed: true;
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

export async function writeScratchPolicy(workshopDir: string, experts: ExpertInput[], ttlSeconds: number): Promise<ScratchPolicy> {
	const policy: ScratchPolicy = {
		version: 1,
		nonce: randomUUID(),
		createdAt: new Date().toISOString(),
		expiresAt: new Date(Date.now() + Math.max(60, ttlSeconds) * 1000).toISOString(),
		allowedExperts: experts.map((expert) => safeSegment(expert.name)),
		artifactContainedNotSandboxed: true,
	};
	await writeJsonQueued(path.join(workshopDir, SCRATCH_POLICY_FILE), policy);
	return policy;
}

export async function readScratchPolicy(workshopDir: string): Promise<ScratchPolicy> {
	const raw = JSON.parse(await fs.readFile(path.join(workshopDir, SCRATCH_POLICY_FILE), "utf8"));
	if (!raw || raw.version !== 1 || typeof raw.nonce !== "string" || !Array.isArray(raw.allowedExperts)) {
		throw new Error("Invalid or missing workshop scratch policy");
	}
	return raw as ScratchPolicy;
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
