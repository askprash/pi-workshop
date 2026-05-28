import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as fssync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, truncateHead } from "@earendil-works/pi-coding-agent";
import { Key, Markdown, Text, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { MAX_ROUNDS, DEFAULT_ROUNDS, DEFAULT_TOOLS, AssistantBriefSchema, ExpertSchema, PublicExpertSchema, WorkshopParams, PublicWorkshopParams, type Intensity, type ResolutionStatus, type ExpertInput, type WorkshopInput, type PublicWorkshopInput } from "./schemas.ts";
import { resolveWorkshopConfig, validateWorkshopConfig, definedOnly, type WorkshopConfig, type ResolvedWorkshopConfig } from "./config.ts";
import { SCRATCH_POLICY_FILE, MANIFEST_FILE, writeFileQueued, writeJsonQueued, listFilesRecursive, writeScratchPolicy, readScratchPolicy, writeRunManifest, type ScratchPolicy } from "./artifacts.ts";

const EXTENSION_VERSION = "0.2.0-safe-beta";
const WEB_RESEARCH_TOOLS = "web_search,fetch_content,get_search_content,code_search";
const PROTOTYPE_TOOL = "workshop_scratch";
const OUTPUT_CAP_BYTES = 80 * 1024;

type ObservedFile = {
	path: string;
	name: string;
	source: "downloads" | "subagent-output" | "subagent-session" | "artifact-output" | "tool-output";
	bytes?: number;
	mtimeMs?: number;
	detectedAt: string;
	owner?: string;
	phase?: string;
	round?: number;
};

type ToolAuditEvent = {
	time: string;
	child: string;
	toolName: string;
	eventType: string;
	phase?: string;
	round?: number;
	argsPreview?: string;
	resultPreview?: string;
};

type SubagentAuditEntry = {
	id: string;
	name: string;
	expert?: string;
	agent?: string;
	task?: string;
	round?: number;
	phase: "assistant_brief" | "direct_tool";
	status: "running" | "done" | "failed";
	startedAt: string;
	finishedAt?: string;
	durationMs?: number;
	exitCode?: number;
	timedOut?: boolean;
	aborted?: boolean;
	outputPreview?: string;
	activity?: string[];
	sessionExports?: string[];
	savedOutputs?: string[];
	artifactOutputs?: string[];
};

type ChildRun = {
	name: string;
	text: string;
	stderr: string;
	exitCode: number;
	model?: string;
	phase?: string;
	round?: number;
	timedOut?: boolean;
	aborted?: boolean;
	durationMs?: number;
	toolEvents?: ToolAuditEvent[];
	artifacts?: ObservedFile[];
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number };
};

type WorkshopResult = {
	summary: string;
	status: ResolutionStatus;
	converged: boolean;
	roundsRun: number;
	workshopDir: string;
	transcriptPath: string;
	resolutionPath: string;
	workflowPath: string;
	manifestPath: string;
	reportPath?: string;
	experts: string[];
	subagentWorkflow: string[];
};

type PanelEvent =
	| { type: "planner_start" }
	| { type: "planner_done"; experts: string[]; path: string }
	| { type: "delegation_policy"; lines: string[] }
	| { type: "brief_start"; round: number; name: string }
	| { type: "brief_done"; round: number; name: string; path: string }
	| { type: "round_start"; round: number; rounds: number; experts: string[] }
	| { type: "expert_start"; round: number; name: string }
	| { type: "expert_activity"; round: number; name: string; text: string }
	| { type: "expert_done"; round: number; name: string; path: string; text: string }
	| { type: "synth_start"; round: number }
	| { type: "synth_done"; round: number; path: string; text: string; status: ResolutionStatus; converged: boolean }
	| { type: "questions"; round: number; questions: string[] }
	| { type: "subagent_start"; subagent: SubagentAuditEntry }
	| { type: "subagent_activity"; id: string; text: string }
	| { type: "subagent_done"; subagent: SubagentAuditEntry }
	| { type: "tool_event"; event: ToolAuditEvent }
	| { type: "download_detected"; files: ObservedFile[] }
	| { type: "final"; result: WorkshopResult };

const DEFAULT_EXPERTS: ExpertInput[] = [
	{
		name: "world-class-domain-expert",
		stance:
			"Bring deep domain judgment to make the idea real. Own problem framing, assumptions, constraints, safety, evidence, user value, and prior art. Be generous about the strongest version of the idea, but attack vague terms, impossible acceptance criteria, missing stakeholders, unbounded regimes, and weak evidence.",
	},
	{
		name: "world-class-scientific-programmer",
		stance:
			"Bring elite scientific-programming judgment to make the idea buildable. Own implementability, numerical correctness, testability, reproducibility, interfaces, data flow, type/units discipline, performance, and sequencing. Inspect code before codebase claims. First ask what must be true or built before this can land cleanly.",
	},
];

function timestampSlug(): string {
	return new Date().toISOString().replace(/[-:]/g, "").replace(/\./g, "");
}

function slugify(text: string): string {
	const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
	return slug || "idea";
}

function resolveMaybe(cwd: string, p: string): string {
	return path.isAbsolute(p) ? p : path.resolve(cwd, p);
}

function toolListIncludes(tools: string | undefined, name: string): boolean {
	return (tools ?? "").split(",").map((tool) => tool.trim()).filter(Boolean).includes(name);
}

function withTool(tools: string, name: string): string {
	const list = tools.split(",").map((tool) => tool.trim()).filter(Boolean);
	return list.includes(name) ? list.join(",") : [...list, name].join(",");
}

function uniqueToolList(tools: string[]): string {
	return Array.from(new Set(tools.map((tool) => tool.trim()).filter(Boolean))).join(",");
}

function defaultToolsFor(options: { webResearch: boolean; localBash: boolean }): string {
	return uniqueToolList([
		...DEFAULT_TOOLS.split(","),
		...(options.webResearch ? WEB_RESEARCH_TOOLS.split(",") : []),
		...(options.localBash ? ["bash"] : []),
	]);
}

function resolveExpertTools(explicitTools: string | undefined, options: { webResearch: boolean; localBash: boolean; expertSubagents: boolean; prototyping: boolean }): string {
	const allowed = new Set(defaultToolsFor(options).split(","));
	if (options.expertSubagents) allowed.add("subagent");
	if (options.prototyping) allowed.add(PROTOTYPE_TOOL);
	const requested = explicitTools?.trim() ? explicitTools.split(",").map((tool) => tool.trim()).filter(Boolean) : Array.from(allowed);
	const sanitized = requested.filter((tool) => allowed.has(tool));
	return uniqueToolList(sanitized.length ? sanitized : Array.from(allowed));
}

function activeModelRef(ctx: any): string | undefined {
	const provider = typeof ctx?.model?.provider === "string" ? ctx.model.provider : undefined;
	const id = typeof ctx?.model?.id === "string" ? ctx.model.id : undefined;
	return provider && id ? `${provider}/${id}` : undefined;
}

function activeProvider(ctx: any): string | undefined {
	return typeof ctx?.model?.provider === "string" ? ctx.model.provider : undefined;
}

function providerQualifiedIfAvailable(ctx: any, provider: string | undefined, modelId: string): string | undefined {
	if (!provider || modelId.includes("/")) return undefined;
	try {
		return ctx?.modelRegistry?.find?.(provider, modelId) ? `${provider}/${modelId}` : undefined;
	} catch {
		return undefined;
	}
}

function safeSegment(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "item";
}

function assertInside(parent: string, child: string): void {
	const rel = path.relative(parent, child);
	if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`Path escapes allowed directory: ${child}`);
}

async function assertRealInside(parent: string, child: string): Promise<void> {
	const realParent = await fs.realpath(parent);
	const realChild = await fs.realpath(child);
	assertInside(realParent, realChild);
}

function isAbortLike(error: unknown): boolean {
	const message = String((error as Error)?.message ?? error);
	return /aborted|cancelled|cancelled|AbortError/i.test(message);
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Workshop cancelled by abort signal");
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function logWarn(context: string, error: unknown): void {
	try {
		const msg = String((error as Error)?.message ?? error);
		process.stderr.write(`[pi-workshop] ${context}: ${msg}\n`);
	} catch {
		/* nothing we can do if stderr is broken */
	}
}

function extractAssistantText(message: any): string {
	if (!message?.content || !Array.isArray(message.content)) return "";
	return message.content.filter((p: any) => p?.type === "text" && typeof p.text === "string").map((p: any) => p.text).join("\n");
}

function previewUnknown(value: unknown, max = 800): string | undefined {
	if (value === undefined || value === null) return undefined;
	let text: string;
	if (typeof value === "string") text = value;
	else {
		try { text = JSON.stringify(value); }
		catch { text = String(value); }
	}
	text = text.replace(/\s+/g, " ").trim();
	return text ? text.slice(0, max) : undefined;
}

function firstMeaningfulLine(text: string, max = 220): string {
	return text.split("\n").map((line) => line.trim()).find(Boolean)?.slice(0, max) ?? "";
}

async function observedFileFromPath(filePath: string, source: ObservedFile["source"], owner?: string, phase?: string, round?: number): Promise<ObservedFile> {
	const stat = await fs.stat(filePath).catch(() => undefined);
	return {
		path: filePath,
		name: path.basename(filePath),
		source,
		bytes: stat?.size,
		mtimeMs: stat?.mtimeMs,
		detectedAt: new Date().toISOString(),
		owner,
		phase,
		round,
	};
}

function parseSubagentOutputPaths(text: string): Pick<SubagentAuditEntry, "sessionExports" | "savedOutputs" | "artifactOutputs"> {
	const sessionExports: string[] = [];
	const savedOutputs: string[] = [];
	const artifactOutputs: string[] = [];
	let section = "";
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (/^##\s+Child session exports/i.test(line)) section = "session";
		else if (/^##\s+Saved outputs/i.test(line)) section = "saved";
		else if (/^##\s+Artifact outputs/i.test(line)) section = "artifact";
		else if (/^##\s+/.test(line)) section = "";
		const paths = [...line.matchAll(/`(\/[^`\n]+)`/g)].map((m) => m[1]).filter(Boolean) as string[];
		const saved = line.match(/^Output saved to:\s+(\/\S+)/i)?.[1];
		if (saved) paths.push(saved);
		for (const p of paths) {
			if (section === "session" || p.endsWith(".jsonl")) sessionExports.push(p);
			else if (section === "artifact" || p.includes("/artifacts/")) artifactOutputs.push(p);
			else savedOutputs.push(p);
		}
	}
	const uniq = (items: string[]) => [...new Set(items)];
	return { sessionExports: uniq(sessionExports), savedOutputs: uniq(savedOutputs), artifactOutputs: uniq(artifactOutputs) };
}

async function observedFilesFromSubagentRun(run: ChildRun): Promise<ObservedFile[]> {
	const parsed = parseSubagentOutputPaths(run.text);
	const entries: ObservedFile[] = [];
	for (const file of parsed.sessionExports ?? []) entries.push(await observedFileFromPath(file, "subagent-session", run.name, run.phase, run.round));
	for (const file of parsed.savedOutputs ?? []) entries.push(await observedFileFromPath(file, "subagent-output", run.name, run.phase, run.round));
	for (const file of parsed.artifactOutputs ?? []) entries.push(await observedFileFromPath(file, "artifact-output", run.name, run.phase, run.round));
	return entries;
}

async function snapshotDownloads(): Promise<Map<string, { bytes: number; mtimeMs: number }>> {
	const dir = path.join(os.homedir(), "Downloads");
	const out = new Map<string, { bytes: number; mtimeMs: number }>();
	let entries: fssync.Dirent[] = [];
	try { entries = await fs.readdir(dir, { withFileTypes: true }); }
	catch { return out; }
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		const full = path.join(dir, entry.name);
		const stat = await fs.stat(full).catch(() => undefined);
		if (!stat) continue;
		out.set(full, { bytes: stat.size, mtimeMs: stat.mtimeMs });
	}
	return out;
}

async function createDownloadAudit(onFiles?: (files: ObservedFile[]) => void): Promise<{ files: ObservedFile[]; scan: (owner?: string, phase?: string, round?: number) => Promise<ObservedFile[]> }> {
	const baseline = await snapshotDownloads();
	const seen = new Set(baseline.keys());
	const files: ObservedFile[] = [];
	return {
		files,
		scan: async (owner?: string, phase?: string, round?: number) => {
			const current = await snapshotDownloads();
			const fresh: ObservedFile[] = [];
			for (const [filePath, stat] of current.entries()) {
				if (seen.has(filePath)) continue;
				seen.add(filePath);
				fresh.push({
					path: filePath,
					name: path.basename(filePath),
					source: "downloads",
					bytes: stat.bytes,
					mtimeMs: stat.mtimeMs,
					detectedAt: new Date().toISOString(),
					owner,
					phase,
					round,
				});
			}
			if (fresh.length) {
				files.push(...fresh);
				onFiles?.(fresh);
			}
			return fresh;
		},
	};
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fssync.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
	return { command: "pi", args };
}

function shellQuoteForSlash(text: string): string {
	return JSON.stringify(text);
}

function killProcessTree(proc: any, signal: NodeJS.Signals = "SIGTERM"): void {
	if (!proc?.pid) return;
	try {
		process.kill(-proc.pid, signal);
	} catch {
		try { proc.kill(signal); } catch (error) { logWarn(`killProcessTree fallback pid=${proc.pid}`, error); }
	}
}

async function runPiJsonPrompt(options: {
	name: string;
	prompt: string;
	cwd: string;
	tools?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	phase?: string;
	round?: number;
	onProgress?: (text: string) => void;
	onActivity?: (text: string) => void;
}): Promise<ChildRun> {
	const args = ["--mode", "json", "-p", "--no-session"];
	if (options.tools) args.push("--tools", options.tools);
	args.push(options.prompt);
	const started = Date.now();
	const result: ChildRun = {
		name: options.name,
		text: "",
		stderr: "",
		exitCode: 0,
		phase: options.phase,
		round: options.round,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
	};
	let wasAborted = false;
	let timedOut = false;
	const exitCode = await new Promise<number>((resolve) => {
		const invocation = getPiInvocation(args);
		const proc = spawn(invocation.command, invocation.args, { cwd: options.cwd, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		let stdoutBuffer = "";
		let sigkillTimer: NodeJS.Timeout | undefined;
		let timeoutTimer: NodeJS.Timeout | undefined;
		let settled = false;
		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			if (stdoutBuffer.trim()) processLine(stdoutBuffer);
			if (timeoutTimer) clearTimeout(timeoutTimer);
			if (sigkillTimer) clearTimeout(sigkillTimer);
			options.signal?.removeEventListener("abort", onAbort);
			resolve(code);
		};
		const terminate = (reason: "abort" | "timeout") => {
			if (reason === "abort") wasAborted = true;
			if (reason === "timeout") timedOut = true;
			killProcessTree(proc, "SIGTERM");
			sigkillTimer = setTimeout(() => killProcessTree(proc, "SIGKILL"), 5000);
			sigkillTimer.unref?.();
		};
		const onAbort = () => terminate("abort");
		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try { event = JSON.parse(line); } catch (error) { logWarn(`runPiJsonPrompt parse line (${options.name})`, error); return; }
			if (event.type === "message_update" && event.message) {
				const text = typeof event.message.content === "string" ? event.message.content : extractAssistantText(event.message);
				const preview = firstMeaningfulLine(text, 180);
				if (preview) options.onActivity?.(preview);
			}
			if (event.type === "message_end" && event.message) {
				const msg = event.message;
				let text = "";
				if (typeof msg.content === "string") text = msg.content;
				else text = extractAssistantText(msg);
				if (text.trim()) result.text = text;
				if (msg.role === "assistant") {
					result.usage.turns += 1;
					const usage = msg.usage;
					if (usage) {
						result.usage.input += usage.input || 0;
						result.usage.output += usage.output || 0;
						result.usage.cacheRead += usage.cacheRead || 0;
						result.usage.cacheWrite += usage.cacheWrite || 0;
						result.usage.cost += usage.cost?.total || 0;
					}
				}
				options.onProgress?.(`${options.name}: ${text.split("\n")[0]?.slice(0, 120) || "updated"}`);
			}
		};
		proc.stdout.on("data", (data) => {
			stdoutBuffer += data.toString();
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		});
		proc.stderr.on("data", (data) => { result.stderr += data.toString(); });
		proc.on("close", (code) => finish(code ?? 0));
		proc.on("error", (err) => { result.stderr += String(err?.message ?? err); finish(1); });
		if (options.timeoutMs && options.timeoutMs > 0) {
			timeoutTimer = setTimeout(() => terminate("timeout"), options.timeoutMs);
			timeoutTimer.unref?.();
		}
		if (options.signal?.aborted) onAbort();
		else options.signal?.addEventListener("abort", onAbort, { once: true });
	});
	result.exitCode = exitCode;
	result.aborted = wasAborted;
	result.timedOut = timedOut;
	result.durationMs = Date.now() - started;
	if (wasAborted) result.stderr += "\nAborted.";
	if (timedOut) result.stderr += `\nTimed out after ${Math.round((options.timeoutMs ?? 0) / 1000)}s.`;
	if (!result.text.trim() && result.stderr.trim()) result.text = `[no output]\n\nSTDERR:\n${result.stderr}`;
	result.artifacts = await observedFilesFromSubagentRun(result);
	return result;
}

async function runChildPi(options: {
	name: string;
	systemPrompt: string;
	userPrompt: string;
	cwd: string;
	model?: string;
	tools?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	phase?: string;
	round?: number;
	runDir: string;
	onProgress?: (text: string) => void;
	onActivity?: (text: string) => void;
	onToolEvent?: (event: ToolAuditEvent) => void;
}): Promise<ChildRun> {
	const safeName = options.name.replace(/[^\w.-]+/g, "_");
	const systemPath = path.join(options.runDir, `_system_${safeName}_${Date.now()}.md`);
	await writeFileQueued(systemPath, options.systemPrompt);

	const args = ["--mode", "json", "-p", "--no-session", "--tools", options.tools ?? DEFAULT_TOOLS];
	if (options.model) args.push("--model", options.model);
	args.push("--append-system-prompt", systemPath, options.userPrompt);

	const started = Date.now();
	const result: ChildRun = {
		name: options.name,
		text: "",
		stderr: "",
		exitCode: 0,
		model: options.model,
		phase: options.phase,
		round: options.round,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		toolEvents: [],
	};

	let wasAborted = false;
	let timedOut = false;
	const exitCode = await new Promise<number>((resolve) => {
		const invocation = getPiInvocation(args);
		const proc = spawn(invocation.command, invocation.args, {
			cwd: options.cwd,
			shell: false,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdoutBuffer = "";
		let sigkillTimer: NodeJS.Timeout | undefined;
		let timeoutTimer: NodeJS.Timeout | undefined;
		let settled = false;

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch (error) {
				logWarn(`runChildPi parse line (${options.name})`, error);
				return;
			}
			const eventType = String(event.type ?? "");
			const rawToolName = event.toolName ?? event.name ?? event.message?.toolName ?? event.toolCall?.name ?? event.tool_call?.name;
			const toolName = typeof rawToolName === "string" ? rawToolName : undefined;
			if ((eventType.includes("tool") || eventType.includes("Tool")) && toolName) {
				const audit: ToolAuditEvent = {
					time: new Date().toISOString(),
					child: options.name,
					toolName,
					eventType,
					phase: options.phase,
					round: options.round,
					argsPreview: previewUnknown(event.input ?? event.args ?? event.arguments ?? event.toolCall?.input ?? event.tool_call?.arguments),
					resultPreview: previewUnknown(event.result ?? event.output ?? event.content ?? event.message?.content),
				};
				result.toolEvents?.push(audit);
				options.onToolEvent?.(audit);
				options.onActivity?.(toolName === "subagent" ? "MAIN EXPERT called subagent tool" : toolName === PROTOTYPE_TOOL ? "ran scratch/prototype experiment" : `tool: ${toolName}`);
			}
			if (eventType === "message_update") {
				const preview = extractAssistantText(event.message ?? event.assistantMessage ?? {}).split("\n").find(Boolean);
				if (preview) options.onActivity?.(preview.slice(0, 120));
			}

			if (event.type === "message_end" && event.message?.role === "assistant") {
				const text = extractAssistantText(event.message);
				if (text.trim()) result.text = text;
				result.usage.turns += 1;
				const usage = event.message.usage;
				if (usage) {
					result.usage.input += usage.input || 0;
					result.usage.output += usage.output || 0;
					result.usage.cacheRead += usage.cacheRead || 0;
					result.usage.cacheWrite += usage.cacheWrite || 0;
					result.usage.cost += usage.cost?.total || 0;
				}
				if (event.message.model) result.model = event.message.model;
				options.onProgress?.(`${options.name}: ${text.split("\n")[0]?.slice(0, 120) || "responded"}`);
			}
		};

		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			if (stdoutBuffer.trim()) processLine(stdoutBuffer);
			if (timeoutTimer) clearTimeout(timeoutTimer);
			if (sigkillTimer) clearTimeout(sigkillTimer);
			options.signal?.removeEventListener("abort", onAbort);
			resolve(code);
		};
		const terminate = (reason: "abort" | "timeout") => {
			if (reason === "abort") wasAborted = true;
			if (reason === "timeout") timedOut = true;
			killProcessTree(proc, "SIGTERM");
			sigkillTimer = setTimeout(() => killProcessTree(proc, "SIGKILL"), 5000);
			sigkillTimer.unref?.();
		};
		const onAbort = () => terminate("abort");

		proc.stdout.on("data", (data) => {
			stdoutBuffer += data.toString();
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		});
		proc.stderr.on("data", (data) => {
			result.stderr += data.toString();
		});
		proc.on("close", (code) => finish(code ?? 0));
		proc.on("error", (err) => {
			result.stderr += String(err?.message ?? err);
			finish(1);
		});
		if (options.timeoutMs && options.timeoutMs > 0) {
			timeoutTimer = setTimeout(() => terminate("timeout"), options.timeoutMs);
			timeoutTimer.unref?.();
		}
		if (options.signal?.aborted) onAbort();
		else options.signal?.addEventListener("abort", onAbort, { once: true });
	});

	result.exitCode = exitCode;
	result.aborted = wasAborted;
	result.timedOut = timedOut;
	result.durationMs = Date.now() - started;
	if (wasAborted) result.stderr += "\nAborted.";
	if (timedOut) result.stderr += `\nTimed out after ${Math.round((options.timeoutMs ?? 0) / 1000)}s.`;
	if (!result.text.trim() && result.stderr.trim()) result.text = `[no assistant text]\n\nSTDERR:\n${result.stderr}`;
	return result;
}

function intensityRules(intensity: Intensity): string {
	if (intensity === "normal") {
		return "Be direct. Separate blockers from preferences. Do not invent objections.";
	}
	if (intensity === "hard") {
		return "Be adversarial but fair. Hunt hidden assumptions, dependency chains, undefined terms, missing tests, and ways this fails in practice.";
	}
	return [
		"Be ruthlessly adversarial and collaborative.",
		"Try to kill weak ideas early. If idea survives, strengthen it.",
		"No politeness padding. No consensus theater. No vague 'looks good'.",
		"Convergence may be: ACCEPT, ITERATE, REJECT, or ILL_POSED. Bad/unclear idea is valid shared resolution.",
	].join("\n");
}

function expertSystemPrompt(expert: ExpertInput, intensity: Intensity, tools: string, parentBriefsEnabled: boolean, prototypingEnabled: boolean, workshopDir?: string, scratchNonce?: string): string {
	const canCallSubagents = toolListIncludes(tools, "subagent");
	const canPrototype = prototypingEnabled && toolListIncludes(tools, PROTOTYPE_TOOL);
	return `# Pi Workshopist: ${expert.name}

${expert.stance}

Goal: help a panel of world-class experts reach a useful shared resolution. Do not merely criticize. Bring your expertise to improve the idea, identify the strongest viable version, and decide whether it should be accepted, iterated, rejected, or declared too poorly posed.

${intensityRules(intensity)}

Available tools for this run: ${tools}

Subagent / delegation policy:
- Parent-orchestrated assistant briefs: ${parentBriefsEnabled ? "ENABLED. Any assistant-brief files were run by the parent orchestrator before you speak; they are junior input, not your own tool calls." : "DISABLED. No parent-run assistant briefs are expected."}
- Main-expert direct subagent calls: ${canCallSubagents ? "ENABLED because the subagent tool is in your available tools. Use it only for narrow research/verification; report when you used it and remain responsible for judgment." : "DISABLED. You cannot launch subagents in this run. Do not claim you used them."}
- Scratch/prototype experiments: ${canPrototype ? `ENABLED via ${PROTOTYPE_TOOL}. Use it for throwaway code, timing checks, small simulations, parsing experiments, or executable sanity checks. Workshop dir: ${workshopDir ?? "(not supplied)"}. Required nonce: ${scratchNonce ?? "(missing)"}. This is artifact-contained only, not a security sandbox.` : "DISABLED. Do not claim you ran code experiments unless you actually used a tool."}

Tool policy:
- Default tools are read/search only: read, grep, find, ls.
- Web research tools may be granted separately from local shell access.
- If bash is granted through the explicit localBash policy, you may use it for local inspection and controlled commands. Do not mutate project state.
- If a web/search tool is installed and explicitly included in available tools, you may use it.
- If subagent is explicitly included in available tools, you may delegate only narrow research/verification tasks; you remain responsible for final judgment.
- If subagent is not in available tools, do not pretend you used it.
- If workshop_scratch is included, keep generated code/data small and disposable. Cite the scratch artifact paths and important command output in your critique.

Rules:
- Stay in your authority lane, but name cross-lane risks.
- If codebase evidence matters, inspect files before claiming facts. Cite paths/commands.
- If external facts are needed and unavailable with available tools, state uncertainty and make it an open question.
- Do not edit files. Use read-only tools unless caller explicitly grants more tools.
- Respond to peer arguments explicitly after round 1.
- Prefer crisp technical fragments over prose.

Strict output format:

## Agreements
- ...

## Blocking objections
- [category] objection. Why it matters. Required fix or experiment.

## Non-blocking concerns
- ...

## Strongest viable version
- Best revised form of the idea, if any.

## Required revision to idea
- ...

## Questions for user
- Q: ...

## Response to peers
- Agreement/disagreement with reason. Round 1: "none — independent read".

## Verdict
VERDICT: ACCEPT | ITERATE | REJECT | ILL_POSED
`;
}

function synthesisSystemPrompt(intensity: Intensity): string {
	return `# Workshop Synthesizer

Merge expert critiques into one shared resolution and strongest revised idea. No ego. No false compromise.

${intensityRules(intensity)}

Authority rules:
- Domain expert wins domain facts within their stated lane.
- Scientific/programming expert wins implementation, testing, reproducibility, and sequencing facts.
- For cross-cutting disagreement, preserve disagreement unless evidence resolves it.
- User answers outrank experts when explicit.

Convergence rules:
- CONVERGED: YES means experts now share a stable resolution.
- Stable resolution can be ACCEPT, ITERATE, REJECT, or ILL_POSED.
- Mark ACCEPT only if all blocking objections are resolved and acceptance criteria are testable.
- Mark ITERATE if idea has promise but needs concrete revision before execution.
- Mark REJECT if core premise fails or cost/risk dominates.
- Mark ILL_POSED if key terms/goals/constraints are too undefined to evaluate productively.
- Mark UNRESOLVED and CONVERGED: NO if experts still materially disagree or user answers are required to decide.

Strict output format:

# Round <N> synthesis

## Shared ground
- ...

## Resolved disagreements
- ...

## Unresolved disagreements
- ...

## Strongest viable version
- Best revised form of the idea, or "none — reject/ill-posed".

## Required idea revision
- Concrete revised framing / constraints / tests / sequencing, or "none".

## Open questions for user
- Q: ...

## Resolution
STATUS: ACCEPT | ITERATE | REJECT | ILL_POSED | UNRESOLVED
CONVERGED: YES | NO
`;
}

function buildRoundPrompt(args: {
	round: number;
	maxRounds: number;
	ideaPath: string;
	contextPaths: string[];
	workingPath: string;
	userAnswersPath: string;
	previousSynthesisPath?: string;
	peerCritiquePaths: string[];
	currentPeerPaths: string[];
	expertName: string;
	panelExperts: ExpertInput[];
	assistantBriefPaths: string[];
	prototyping: boolean;
	workshopDir: string;
	scratchNonce?: string;
}): string {
	const context = args.contextPaths.length ? args.contextPaths.map((p) => `- ${p}`).join("\n") : "- (none supplied)";
	const panel = args.panelExperts.map((e) => `- ${e.name}: ${e.stance}`).join("\n");
	return `Round ${args.round} of ${args.maxRounds}. Expert: ${args.expertName}.

You are talking to a panel of other experts. Treat this as a working-room discussion, not a solo review. Address peer arguments by name, build on good ideas, challenge weak claims, and help the panel converge on the strongest viable resolution.

Panel:
${panel}

Read these files first:
- Original idea: ${args.ideaPath}
- Current working synthesis/resolution: ${args.workingPath}
- User answers/rulings: ${args.userAnswersPath}

Context paths to inspect when relevant:
${context}

Prior synthesis:
${args.previousSynthesisPath ? `- ${args.previousSynthesisPath}` : "- none — round 1"}

Peer critiques from previous round:
${args.peerCritiquePaths.length ? args.peerCritiquePaths.map((p) => `- ${p}`).join("\n") : "- none — round 1 independent critique"}

Peer critiques already produced this round:
${args.currentPeerPaths.length ? args.currentPeerPaths.map((p) => `- ${p}`).join("\n") : "- none"}

Parent-orchestrated assistant briefs for your lane:
${args.assistantBriefPaths.length ? args.assistantBriefPaths.map((p) => `- ${p}`).join("\n") : "- none"}

If assistant briefs are present, read them before finalizing your critique. These subagents were launched by the parent orchestrator before your critique; they are not evidence that you personally called subagents. Treat them as junior research/scouting input, not authority. You own judgment and must correct or ignore weak brief claims.

Scratch/prototype workspace:
${args.prototyping ? `- Enabled. Use ${PROTOTYPE_TOOL} with workshopDir=${args.workshopDir}, expertName=${args.expertName}, and nonce=${args.scratchNonce ?? "(missing)"}. Cite generated artifact paths and key outputs. This is artifact-contained only, not a security sandbox.` : "- Disabled."}

Write your answer in the strict format. End with exactly one VERDICT line.`;
}

function plannerSystemPrompt(intensity: Intensity): string {
	return `# Expert Panel Designer

You design a small, high-signal workshop for technical ideation.

${intensityRules(intensity)}

Choose 2-4 experts. Too many cooks spoil the broth. Prefer 3 when the idea spans domain, implementation, and product/validation. Prefer 2 for narrow ideas. Prefer 4 only when there are genuinely distinct high-risk axes.

Each expert must have:
- short kebab-case name
- stance: what they own and how they should help improve/kill/reframe the idea
- assistantBriefs: 1-3 tailored junior-assistant tasks that will gather evidence before this expert speaks

Assistant brief design:
- Use scout for local repository/code/context inspection.
- Use researcher for external web/docs/papers/prior-art evidence.
- Make each task narrow and evidence-seeking. Do not ask juniors to decide the answer.
- Include exact search targets, source types, code areas, or benchmark families when known.
- Junior assistants are cheaper/faster models; they gather facts. Main experts own judgment.

Always include a scientific/programming/systems implementation expert when the idea involves software. Add domain experts specific to the idea instead of generic skeptics. Add product/user/validation expert only when adoption or evidence is a major risk.

Return JSON only, no markdown:
{"experts":[{"name":"...","stance":"...","assistantBriefs":[{"agent":"researcher","task":"..."},{"agent":"scout","task":"..."}]}]}
`;
}

function buildPlannerPrompt(ideaPath: string, contextPaths: string[]): string {
	return `Read the idea and choose the best workshop.

Idea: ${ideaPath}
Context paths:
${contextPaths.length ? contextPaths.map((p) => `- ${p}`).join("\n") : "- none"}

Return JSON only.`;
}

function parsePlannedExperts(text: string): ExpertInput[] | null {
	const jsonText = text.match(/\{[\s\S]*\}/)?.[0];
	if (!jsonText) return null;
	try {
		const parsed = JSON.parse(jsonText) as {
			experts?: Array<{
				name?: unknown;
				stance?: unknown;
				assistantBriefs?: Array<{ agent?: unknown; task?: unknown; model?: unknown }>;
			}>;
		};
		const experts = (parsed.experts ?? [])
			.map((e) => ({
				name: String(e.name ?? "").toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-|-$/g, ""),
				stance: String(e.stance ?? "").trim(),
				assistantBriefs: Array.isArray(e.assistantBriefs)
					? e.assistantBriefs
						.map((b) => ({
							agent: ["scout", "researcher"].includes(String(b.agent ?? "")) ? (String(b.agent) as any) : "scout",
							task: String(b.task ?? "").trim(),
						}))
						.filter((b) => b.task)
						.slice(0, 3)
					: undefined,
			}))
			.filter((e) => e.name && e.stance)
			.slice(0, 4);
		return experts.length >= 2 ? experts : null;
	} catch (error) {
		logWarn("parsePlannedExperts", error);
		return null;
	}
}

async function runExpertAssistantBrief(args: {
	expert: ExpertInput;
	round: number;
	ideaPath: string;
	workingPath: string;
	contextPaths: string[];
	baseCwd: string;
	workshopDir: string;
	webResearch: boolean;
	juniorModel: string;
	signal?: AbortSignal;
	childTimeoutMs?: number;
	onUpdate?: (text: string) => void;
	recordChildRun?: (run: ChildRun) => void;
	onPanelEvent?: (event: PanelEvent) => void;
}): Promise<string> {
	const safeName = args.expert.name.replace(/[^\w.-]+/g, "_");
	const out = path.join(args.workshopDir, `round_${args.round}_${safeName}_assistant_brief.md`);
	const context = args.contextPaths.length ? args.contextPaths.map((p) => `- ${p}`).join("\n") : "- none supplied";
	const fallbackBriefs = [
		{
			agent: "scout" as const,
			task: `Create a local/code/context scouting brief for expert ${args.expert.name}.\n\nExpert stance:\n${args.expert.stance}\n\nIdea file: ${args.ideaPath}\nWorking synthesis: ${args.workingPath}\nContext paths:\n${context}\n\nFocus on facts this expert should know before critique. Cite files/paths. Do not edit project files.`,
		},
		...(args.webResearch
			? [
					{
						agent: "researcher" as const,
						task: `Research external evidence and prior art for expert ${args.expert.name}.\n\nExpert stance:\n${args.expert.stance}\n\nIdea file: ${args.ideaPath}\n\nReturn source-backed findings, gaps, and implications for this expert's critique. Prefer primary sources and cite URLs.`,
					},
				]
			: []),
	];
	const briefs = args.expert.assistantBriefs?.length ? args.expert.assistantBriefs : fallbackBriefs;
	let content = `# Assistant brief for ${args.expert.name} (round ${args.round})\n\nJunior model default: ${args.juniorModel}\n`;
	for (const [i, brief] of briefs.entries()) {
		const agent = brief.agent ?? "scout";
		if (agent === "researcher" && !args.webResearch) {
			content += `\n\n## ${i + 1}. researcher subagent skipped\n\nResearch brief requested by planner, but webResearch was not enabled. Re-run with --web-research --subagents for web-backed research.\n\nTask:\n${brief.task}\n`;
			continue;
		}
		const model = brief.model ?? args.juniorModel;
		const agentSpec = model ? `${agent}[model=${model}]` : agent;
		const task = `${brief.task}\n\nExpert receiving this brief: ${args.expert.name}\nExpert stance:\n${args.expert.stance}\n\nIdea file: ${args.ideaPath}\nWorking synthesis: ${args.workingPath}\nContext paths:\n${context}\n\nOutput a concise evidence brief. Do not decide the final verdict; the main expert owns judgment.`;
		const subagentId = `${args.round}:${args.expert.name}:${i + 1}:${agent}`;
		const startedAt = new Date().toISOString();
		args.onPanelEvent?.({
			type: "subagent_start",
			subagent: { id: subagentId, name: `${args.expert.name}-${agent}-subagent`, expert: args.expert.name, agent, task: brief.task, round: args.round, phase: "assistant_brief", status: "running", startedAt, activity: ["queued"] },
		});
		const run = await runPiJsonPrompt({
			name: `${args.expert.name}-${agent}-subagent`,
			prompt: `/run ${agentSpec} ${shellQuoteForSlash(task)}`,
			cwd: args.baseCwd,
			tools: "subagent",
			signal: args.signal,
			timeoutMs: args.childTimeoutMs,
			phase: "assistant_brief",
			round: args.round,
			onProgress: args.onUpdate,
			onActivity: (text) => args.onPanelEvent?.({ type: "subagent_activity", id: subagentId, text }),
		});
		const parsedPaths = parseSubagentOutputPaths(run.text);
		args.onPanelEvent?.({
			type: "subagent_done",
			subagent: {
				id: subagentId,
				name: run.name,
				expert: args.expert.name,
				agent,
				task: brief.task,
				round: args.round,
				phase: "assistant_brief",
				status: run.exitCode === 0 && !run.timedOut && !run.aborted ? "done" : "failed",
				startedAt,
				finishedAt: new Date().toISOString(),
				durationMs: run.durationMs,
				exitCode: run.exitCode,
				timedOut: run.timedOut,
				aborted: run.aborted,
				outputPreview: firstMeaningfulLine(run.text),
				...parsedPaths,
			},
		});
		args.recordChildRun?.(run);
		content += `\n\n## ${i + 1}. ${agent} subagent\n\nModel: ${model}\n\nTask:\n${brief.task}\n\nResult:\n${run.text}\n`;
	}
	await writeFileQueued(out, content);
	return out;
}

function buildSynthesisPrompt(args: {
	round: number;
	maxRounds: number;
	ideaPath: string;
	workingPath: string;
	userAnswersPath: string;
	critiquePaths: string[];
	previousSynthesisPath?: string;
}): string {
	return `Round ${args.round} of ${args.maxRounds} synthesis.

Read:
- Original idea: ${args.ideaPath}
- Current working synthesis/resolution: ${args.workingPath}
- User answers/rulings: ${args.userAnswersPath}
${args.previousSynthesisPath ? `- Previous synthesis: ${args.previousSynthesisPath}\n` : ""}
Critiques this round:
${args.critiquePaths.map((p) => `- ${p}`).join("\n")}

Produce synthesis in strict format. Last two lines must be STATUS then CONVERGED.`;
}

function parseStatus(text: string): ResolutionStatus {
	const match = text.match(/^STATUS:\s*(ACCEPT|ITERATE|REJECT|ILL_POSED|UNRESOLVED|DEGRADED|FAILED|CANCELLED)\s*$/im);
	return (match?.[1] as ResolutionStatus | undefined) ?? "UNRESOLVED";
}

function hasStrictSynthesisStatus(text: string): boolean {
	return /^STATUS:\s*(ACCEPT|ITERATE|REJECT|ILL_POSED|UNRESOLVED|DEGRADED|FAILED|CANCELLED)\s*$/im.test(text) && /^CONVERGED:\s*(YES|NO)\s*$/im.test(text);
}

function parseConverged(text: string): boolean {
	return /^CONVERGED:\s*YES\s*$/im.test(text);
}

function extractQuestions(text: string): string[] {
	const lines = text.split("\n");
	const questions: string[] = [];
	let inSection = false;
	for (const line of lines) {
		if (/^##\s+Open questions for user/i.test(line)) {
			inSection = true;
			continue;
		}
		if (inSection && /^##\s+/.test(line)) break;
		if (!inSection) continue;
		const q = line.match(/^\s*-\s*Q:\s*(.+)\s*$/i)?.[1]?.trim();
		if (q && !/^none\.?$/i.test(q)) questions.push(q);
	}
	return questions;
}

async function formatTranscript(roundFiles: string[], finalSynthesis: string): Promise<string> {
	const chunks: string[] = ["# Workshop transcript", "", `Final synthesis: ${finalSynthesis}`, ""];
	for (const file of roundFiles) {
		chunks.push("---", "", `## ${path.basename(file)}`, "", `Path: ${file}`, "");
		chunks.push(await fs.readFile(file, "utf8").catch((err) => `[could not read: ${String(err)}]`));
		chunks.push("");
	}
	return chunks.join("\n");
}

async function generateHtmlReport(args: {
	workshopDir: string;
	ideaPath: string;
	workflowPath: string;
	answersPath: string;
	finalPath: string;
	transcriptPath: string;
	roundFiles: string[];
	result: Omit<WorkshopResult, "summary" | "reportPath">;
}): Promise<string> {
	const reportPath = path.join(args.workshopDir, "report.html");
	const scratchRoot = path.join(args.workshopDir, "scratch");
	const scratchFiles = (await listFilesRecursive(scratchRoot)).filter((file) => file.endsWith(".md") || file.endsWith(".py") || file.endsWith(".ts") || file.endsWith(".js") || file.endsWith(".txt"));
	const read = async (file: string) => fs.readFile(file, "utf8").catch((err) => `[could not read ${file}: ${String(err)}]`);
	const idea = await read(args.ideaPath);
	const workflow = await read(args.workflowPath);
	const answers = await read(args.answersPath);
	const final = await read(args.finalPath);
	const fileSection = async (title: string, files: string[]) => {
		const parts: string[] = [];
		for (const file of files) {
			const content = await read(file);
			parts.push(`<details><summary>${escapeHtml(title)}: ${escapeHtml(path.relative(args.workshopDir, file))}</summary><pre>${escapeHtml(content)}</pre></details>`);
		}
		return parts.join("\n");
	};
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Pi workshop report — ${escapeHtml(args.result.status)}</title>
<style>
:root { color-scheme: light dark; --fg:#172033; --muted:#657084; --bg:#f6f8fb; --card:#fff; --border:#d8dee9; --accent:#3b82f6; --ok:#16a34a; --warn:#d97706; }
@media (prefers-color-scheme: dark) { :root { --fg:#e5e7eb; --muted:#9ca3af; --bg:#111827; --card:#1f2937; --border:#374151; --accent:#60a5fa; --ok:#22c55e; --warn:#f59e0b; } }
body { margin:0; font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:var(--fg); background:var(--bg); }
main { max-width:1120px; margin:0 auto; padding:32px 20px 64px; }
h1,h2,h3 { line-height:1.15; }
.card, details { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:16px; margin:16px 0; box-shadow:0 1px 2px rgba(0,0,0,.04); }
.grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; }
.metric { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:14px; }
.metric b { display:block; font-size:20px; color:var(--accent); }
pre { white-space:pre-wrap; overflow:auto; background:rgba(127,127,127,.10); padding:12px; border-radius:8px; }
summary { cursor:pointer; font-weight:650; }
.path { color:var(--muted); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; }
.badge { display:inline-block; padding:3px 8px; border-radius:999px; background:rgba(59,130,246,.14); color:var(--accent); font-weight:650; }
.ok { color:var(--ok); } .warn { color:var(--warn); }
</style>
</head>
<body><main>
<h1>Pi workshop report <span class="badge">${escapeHtml(args.result.status)}</span></h1>
<p class="path">${escapeHtml(args.workshopDir)}</p>
<div class="grid">
  <div class="metric"><span>Status</span><b>${escapeHtml(args.result.status)}</b></div>
  <div class="metric"><span>Converged</span><b class="${args.result.converged ? "ok" : "warn"}">${args.result.converged ? "yes" : "no"}</b></div>
  <div class="metric"><span>Rounds</span><b>${args.result.roundsRun}</b></div>
  <div class="metric"><span>Experts</span><b>${escapeHtml(String(args.result.experts.length))}</b></div>
</div>
<section class="card"><h2>Original goal / prompt</h2><pre>${escapeHtml(idea)}</pre></section>
<section class="card"><h2>Workflow and delegation policy</h2><pre>${escapeHtml(workflow)}</pre></section>
<section class="card"><h2>Final resolution</h2><pre>${escapeHtml(final)}</pre></section>
<section class="card"><h2>User answers / rulings</h2><pre>${escapeHtml(answers)}</pre></section>
<h2>Prototype and scratch evidence</h2>
${scratchFiles.length ? await fileSection("scratch", scratchFiles) : `<p class="card">No scratch/prototype artifacts were recorded.</p>`}
<h2>Panel work products</h2>
${await fileSection("artifact", args.roundFiles)}
<section class="card"><h2>Raw transcript</h2><p class="path">${escapeHtml(args.transcriptPath)}</p></section>
</main></body></html>`;
	await writeFileQueued(reportPath, html);
	return reportPath;
}

async function askUserForQuestions(ctx: any, round: number, questions: string[], answersPath: string): Promise<boolean> {
	if (!ctx.hasUI || questions.length === 0) return false;
	const prefill = questions.map((q, i) => `Q${i + 1}: ${q}\nA${i + 1}: `).join("\n\n");
	const answer = await ctx.ui.editor(
		`Pi workshop round ${round}: answer blocking questions (optional)`,
		`${prefill}\n\nLeave blank/close to skip. Your answers become authoritative.`,
	);
	if (!answer?.trim()) return false;
	await writeFileQueued(answersPath, `${await fs.readFile(answersPath, "utf8").catch(() => "")}\n\n## Round ${round} user answers\n\n${answer.trim()}\n`);
	return true;
}

async function runWorkshop(
	pi: ExtensionAPI,
	params: WorkshopInput,
	ctx: any,
	signal?: AbortSignal,
	onUpdate?: (text: string) => void,
	onArtifact?: (artifact: { kind: "critique" | "synthesis"; round: number; name: string; path: string; text: string }) => void,
	onPanelEvent?: (event: PanelEvent) => void,
): Promise<WorkshopResult> {
	const startedAt = new Date();
	const baseCwd = resolveMaybe(ctx.cwd, params.cwd ?? ".");
	const resolvedConfig = await resolveWorkshopConfig(baseCwd, params);
	params = resolvedConfig.params;
	const rounds = params.rounds ?? DEFAULT_ROUNDS;
	const intensity: Intensity = "hard";
	const workshop = Boolean(params.workshop || resolvedConfig.profile === "workshop");
	const webResearchEnabled = Boolean(params.webResearch);
	const localBashEnabled = Boolean(params.localBash);
	const parentBriefsEnabled = Boolean(params.subagents);
	const expertSubagentsEnabled = Boolean(params.expertSubagents);
	const prototypingEnabled = Boolean(params.prototyping);
	const htmlReportEnabled = Boolean(params.htmlReport);
	const childRuns: ChildRun[] = [];
	const errors: string[] = [];
	let degraded = false;
	const downloadAudit = await createDownloadAudit((files) => onPanelEvent?.({ type: "download_detected", files }));
	const scanDownloads = (owner?: string, phase?: string, round?: number) => downloadAudit.scan(owner, phase, round).catch(() => []);
	const childTimeoutMs = resolvedConfig.limits.childTimeoutSeconds * 1000;
	const runAbort = new AbortController();
	const onExternalAbort = () => runAbort.abort();
	if (signal?.aborted) runAbort.abort();
	else signal?.addEventListener("abort", onExternalAbort, { once: true });
	let globalTimeoutRemainingMs = resolvedConfig.limits.globalTimeoutSeconds * 1000;
	let globalTimerStartedAt = 0;
	let globalTimer: NodeJS.Timeout | undefined;
	const startGlobalTimer = () => {
		if (runAbort.signal.aborted || globalTimer) return;
		if (globalTimeoutRemainingMs <= 0) {
			runAbort.abort();
			return;
		}
		globalTimerStartedAt = Date.now();
		globalTimer = setTimeout(() => runAbort.abort(), globalTimeoutRemainingMs);
		globalTimer.unref?.();
	};
	const pauseGlobalTimer = () => {
		if (!globalTimer) return;
		clearTimeout(globalTimer);
		globalTimer = undefined;
		globalTimeoutRemainingMs = Math.max(0, globalTimeoutRemainingMs - (Date.now() - globalTimerStartedAt));
	};
	const stopGlobalTimer = () => {
		if (globalTimer) clearTimeout(globalTimer);
		globalTimer = undefined;
	};
	startGlobalTimer();
	const runSignal = runAbort.signal;
	const recordChildRun = (run: ChildRun) => {
		childRuns.push(run);
		void scanDownloads(run.name, run.phase, run.round);
		if (run.exitCode !== 0 || run.timedOut || run.aborted) {
			degraded = true;
			errors.push(`${run.phase ?? "child"}:${run.name} exited ${run.exitCode}${run.timedOut ? " (timeout)" : ""}${run.aborted ? " (aborted)" : ""}`);
		}
	};
	const emitToolEvent = (event: ToolAuditEvent) => {
		onPanelEvent?.({ type: "tool_event", event });
		void scanDownloads(event.child, event.phase, event.round);
	};
	const inheritedModel = activeModelRef(ctx);
	const inheritedProvider = activeProvider(ctx);
	const strongModel = params.strongModel ?? inheritedModel;
	if (!strongModel) {
		throw new Error(
			"pi-workshop: no strongModel available. Set models.strongModel in ~/.pi/agent/pi-workshop.config.json or pass --strong-model, or launch pi with a default model so the workshop can inherit it.",
		);
	}
	const plannerModel = params.plannerModel ?? strongModel;
	const expertModel = params.expertModel ?? strongModel;
	const synthModel = params.synthModel ?? strongModel;
	const juniorModel = params.juniorModel ?? (inheritedProvider ? providerQualifiedIfAvailable(ctx, inheritedProvider, strongModel) : undefined) ?? inheritedModel ?? strongModel;
	const contextPaths = (params.contextPaths ?? []).map((p) => resolveMaybe(baseCwd, p));
	const workshopDir = params.outputDir
		? resolveMaybe(baseCwd, params.outputDir)
		: path.join(baseCwd, ".pi", "workshops", `${timestampSlug()}-${slugify(params.idea)}`);
	await fs.mkdir(workshopDir, { recursive: true });
	const realWorkshopDir = await fs.realpath(workshopDir);
	if (prototypingEnabled && !realWorkshopDir.includes(`${path.sep}.pi${path.sep}workshops${path.sep}`)) {
		throw new Error("prototyping/workshop_scratch requires the workshop artifact directory to be under .pi/workshops");
	}

	const ideaPath = path.join(workshopDir, "idea.md");
	const workingPath = path.join(workshopDir, "working-resolution.md");
	const answersPath = path.join(workshopDir, "user-answers.md");
	const transcriptPath = path.join(workshopDir, "transcript.md");
	const finalPath = path.join(workshopDir, "resolution.md");
	const workflowPath = path.join(workshopDir, "workflow.md");
	const manifestPath = path.join(workshopDir, MANIFEST_FILE);
	await writeFileQueued(ideaPath, `# Technical idea for workshop\n\n${params.idea.trim()}\n`);
	await writeFileQueued(
		workingPath,
		`# Working resolution\n\nInitial idea is untested. Experts must converge on ACCEPT, ITERATE, REJECT, ILL_POSED, or UNRESOLVED.\n`,
	);
	await writeFileQueued(answersPath, "# User answers / rulings\n");
	throwIfAborted(runSignal);

	const allRoundFiles: string[] = [];
	let experts: ExpertInput[] = params.experts?.length ? params.experts : DEFAULT_EXPERTS;
	if (!params.experts?.length && params.planExperts !== false) {
		onUpdate?.("Planning workshop");
		onPanelEvent?.({ type: "planner_start" });
		const planPath = path.join(workshopDir, "panel-plan.md");
		const planner = await runChildPi({
			name: "panel-designer",
			systemPrompt: plannerSystemPrompt(intensity),
			userPrompt: buildPlannerPrompt(ideaPath, contextPaths),
			cwd: baseCwd,
			model: plannerModel,
			tools: defaultToolsFor({ webResearch: webResearchEnabled, localBash: localBashEnabled }),
			signal: runSignal,
			timeoutMs: childTimeoutMs,
			phase: "planner",
			runDir: workshopDir,
			onProgress: onUpdate,
			onToolEvent: emitToolEvent,
		});
		recordChildRun(planner);
		await writeFileQueued(planPath, planner.text);
		allRoundFiles.push(planPath);
		const planned = parsePlannedExperts(planner.text);
		if (planned) experts = planned;
		else if (planner.exitCode !== 0 || !planner.text.trim()) {
			degraded = true;
			errors.push("Planner failed or returned no parseable experts; falling back to fixed experts.");
		}
		onPanelEvent?.({ type: "planner_done", experts: experts.map((e) => e.name), path: planPath });
	}
	experts = experts.slice(0, 4).map((expert) => {
		const tools = resolveExpertTools(expert.tools, {
			webResearch: webResearchEnabled,
			localBash: localBashEnabled,
			expertSubagents: expertSubagentsEnabled,
			prototyping: prototypingEnabled,
		});
		return {
			...expert,
			model: expert.model ?? expertModel,
			tools,
		};
	});
	const scratchPolicy = prototypingEnabled ? await writeScratchPolicy(workshopDir, experts, resolvedConfig.limits.globalTimeoutSeconds) : undefined;
	const mainExpertsCanUseSubagents = experts.some((expert) => toolListIncludes(expert.tools, "subagent"));
	const subagentWorkflow = [
		`Config files: ${resolvedConfig.configPaths.length ? resolvedConfig.configPaths.join(", ") : "built-in defaults only"}`,
		`Profile: ${resolvedConfig.profile ?? "none"}`,
		`Scratch timeout: ${resolvedConfig.limits.scratchTimeoutSeconds}s default, ${resolvedConfig.limits.maxScratchTimeoutSeconds}s max before approval/escalation`,
		`Child timeout: ${resolvedConfig.limits.childTimeoutSeconds}s; global timeout: ${resolvedConfig.limits.globalTimeoutSeconds}s`,
		`Web research tools: ${webResearchEnabled ? "enabled" : "disabled"}`,
		`Local bash tools: ${localBashEnabled ? "enabled" : "disabled"}`,
		`Workshop mode (--workshop): ${workshop ? "enabled" : "disabled"}`,
		`Parent-orchestrated assistant briefs (--subagents): ${parentBriefsEnabled ? "enabled" : "disabled"}`,
		`Main expert direct subagent tool: ${mainExpertsCanUseSubagents ? "enabled" : "disabled"}`,
		`Scratch/prototype tool (${PROTOTYPE_TOOL}): ${prototypingEnabled ? "enabled" : "disabled"}`,
		`HTML report: ${htmlReportEnabled ? "enabled" : "disabled"}`,
		parentBriefsEnabled
			? "Before each expert critique, the parent runs scout/researcher briefs and passes brief files to experts."
			: "No parent-run junior briefs will be created unless --subagents/subagents=true is used.",
		mainExpertsCanUseSubagents
			? "If an expert calls subagent directly, dashboard activity will show 'MAIN EXPERT called subagent tool' when JSON tool events expose it."
			: "In the default slash workflow, main experts cannot call subagents; use --expert-subagents/--workshop or explicit expert.tools='...,subagent' to allow that.",
		prototypingEnabled
			? `Experts can run throwaway experiments through ${PROTOTYPE_TOOL}; artifacts are under scratch/<expert>/ and included in report.html. Scratch calls require the per-run nonce and are artifact-contained, not sandboxed.`
			: `Experts cannot run scratch experiments unless --prototype/--workshop or prototyping=true is used.`,
	];
	await writeFileQueued(workflowPath, `# Pi workshop workflow\n\n${subagentWorkflow.map((line) => `- ${line}`).join("\n")}\n\n## Expert tools\n\n${experts.map((expert) => `- ${expert.name}: ${expert.tools}`).join("\n")}\n`);
	allRoundFiles.push(workflowPath);
	onPanelEvent?.({ type: "delegation_policy", lines: subagentWorkflow });
	onUpdate?.(`Workflow: parent briefs ${parentBriefsEnabled ? "enabled" : "disabled"}; main expert subagents ${mainExpertsCanUseSubagents ? "enabled" : "disabled"}; prototypes ${prototypingEnabled ? "enabled" : "disabled"}; HTML ${htmlReportEnabled ? "enabled" : "disabled"}.`);

	let previousSynthesisPath: string | undefined;
	let status: ResolutionStatus = "UNRESOLVED";
	let converged = false;
	let roundsRun = 0;

	for (let round = 1; round <= rounds; round++) {
		if (runSignal.aborted) {
			status = "CANCELLED";
			converged = false;
			break;
		}
		roundsRun = round;
		onPanelEvent?.({ type: "round_start", round, rounds, experts: experts.map((e) => e.name) });
		onUpdate?.(`Round ${round}/${rounds}: expert critique`);
		const assistantBriefs = new Map<string, string[]>();
		if (parentBriefsEnabled) {
			onUpdate?.(`Round ${round}/${rounds}: assistant subagent briefs`);
			await Promise.all(experts.map(async (expert) => {
				onPanelEvent?.({ type: "brief_start", round, name: expert.name });
				try {
					const briefPath = await runExpertAssistantBrief({
						expert,
						round,
						ideaPath,
						workingPath,
						contextPaths,
						baseCwd,
						workshopDir,
						webResearch: webResearchEnabled,
						juniorModel,
						signal: runSignal,
						childTimeoutMs,
						onUpdate,
						recordChildRun,
						onPanelEvent,
					});
					assistantBriefs.set(expert.name, [briefPath]);
					allRoundFiles.push(briefPath);
					onPanelEvent?.({ type: "brief_done", round, name: expert.name, path: briefPath });
				} catch (error) {
					degraded = true;
					errors.push(`Assistant brief failed for ${expert.name}: ${String((error as Error)?.message ?? error)}`);
					const safeName = expert.name.replace(/[^\w.-]+/g, "_");
					const briefPath = path.join(workshopDir, `round_${round}_${safeName}_assistant_brief_error.md`);
					await writeFileQueued(briefPath, `# Assistant brief failed for ${expert.name}\n\n${String((error as Error)?.stack ?? error)}\n`);
					assistantBriefs.set(expert.name, [briefPath]);
					allRoundFiles.push(briefPath);
					onPanelEvent?.({ type: "brief_done", round, name: expert.name, path: briefPath });
				}
			}));
		}
		const critiquePaths: string[] = [];
		const previousCritiques =
			round > 1
				? experts
					.map((e) => path.join(workshopDir, `round_${round - 1}_${e.name.replace(/[^\w.-]+/g, "_")}.md`))
					.filter((p) => fssync.existsSync(p))
				: [];

		if (round === 1) {
			await Promise.all(
				experts.map(async (expert) => {
					const out = path.join(workshopDir, `round_${round}_${expert.name.replace(/[^\w.-]+/g, "_")}.md`);
					onPanelEvent?.({ type: "expert_start", round, name: expert.name });
					const run = await runChildPi({
						name: expert.name,
						systemPrompt: expertSystemPrompt(expert, intensity, expert.tools ?? DEFAULT_TOOLS, parentBriefsEnabled, prototypingEnabled, workshopDir, scratchPolicy?.nonce),
						userPrompt: buildRoundPrompt({
							round,
							maxRounds: rounds,
							ideaPath,
							contextPaths,
							workingPath,
							userAnswersPath: answersPath,
							previousSynthesisPath,
							peerCritiquePaths: [],
							currentPeerPaths: [],
							expertName: expert.name,
							panelExperts: experts,
							assistantBriefPaths: assistantBriefs.get(expert.name) ?? [],
							prototyping: prototypingEnabled,
							workshopDir,
							scratchNonce: scratchPolicy?.nonce,
						}),
						cwd: baseCwd,
						model: expert.model,
						tools: expert.tools,
						signal: runSignal,
						timeoutMs: childTimeoutMs,
						phase: "expert",
						round,
						runDir: workshopDir,
						onProgress: onUpdate,
						onActivity: (text) => onPanelEvent?.({ type: "expert_activity", round, name: expert.name, text }),
						onToolEvent: emitToolEvent,
					});
					recordChildRun(run);
					await writeFileQueued(out, run.text);
					onPanelEvent?.({ type: "expert_done", round, name: expert.name, path: out, text: run.text });
					onArtifact?.({ kind: "critique", round, name: expert.name, path: out, text: run.text });
					critiquePaths.push(out);
				}),
			);
		} else {
			for (const expert of experts) {
				const out = path.join(workshopDir, `round_${round}_${expert.name.replace(/[^\w.-]+/g, "_")}.md`);
				onPanelEvent?.({ type: "expert_start", round, name: expert.name });
				const run = await runChildPi({
					name: expert.name,
					systemPrompt: expertSystemPrompt(expert, intensity, expert.tools ?? DEFAULT_TOOLS, parentBriefsEnabled, prototypingEnabled, workshopDir, scratchPolicy?.nonce),
					userPrompt: buildRoundPrompt({
						round,
						maxRounds: rounds,
						ideaPath,
						contextPaths,
						workingPath,
						userAnswersPath: answersPath,
						previousSynthesisPath,
						peerCritiquePaths: previousCritiques,
						currentPeerPaths: critiquePaths,
						expertName: expert.name,
						panelExperts: experts,
						assistantBriefPaths: assistantBriefs.get(expert.name) ?? [],
						prototyping: prototypingEnabled,
						workshopDir,
						scratchNonce: scratchPolicy?.nonce,
					}),
					cwd: baseCwd,
					model: expert.model,
					tools: expert.tools,
					signal: runSignal,
					timeoutMs: childTimeoutMs,
					phase: "expert",
					round,
					runDir: workshopDir,
					onProgress: onUpdate,
					onActivity: (text) => onPanelEvent?.({ type: "expert_activity", round, name: expert.name, text }),
					onToolEvent: emitToolEvent,
				});
				recordChildRun(run);
				await writeFileQueued(out, run.text);
				onPanelEvent?.({ type: "expert_done", round, name: expert.name, path: out, text: run.text });
				onArtifact?.({ kind: "critique", round, name: expert.name, path: out, text: run.text });
				critiquePaths.push(out);
			}
		}
		if (runSignal.aborted) {
			status = "CANCELLED";
			converged = false;
			break;
		}

		critiquePaths.sort();
		allRoundFiles.push(...critiquePaths);
		onUpdate?.(`Round ${round}/${rounds}: synthesis`);
		onPanelEvent?.({ type: "synth_start", round });
		const synthOut = path.join(workshopDir, `round_${round}_synthesis.md`);
		const synth = await runChildPi({
			name: "synthesizer",
			systemPrompt: synthesisSystemPrompt(intensity),
			userPrompt: buildSynthesisPrompt({
				round,
				maxRounds: rounds,
				ideaPath,
				workingPath,
				userAnswersPath: answersPath,
				critiquePaths,
				previousSynthesisPath,
			}),
			cwd: baseCwd,
			model: synthModel,
			tools: defaultToolsFor({ webResearch: webResearchEnabled, localBash: localBashEnabled }),
			signal: runSignal,
			timeoutMs: childTimeoutMs,
			phase: "synthesis",
			round,
			runDir: workshopDir,
			onProgress: onUpdate,
			onToolEvent: emitToolEvent,
		});
		recordChildRun(synth);
		if (!hasStrictSynthesisStatus(synth.text)) {
			degraded = true;
			errors.push(`Synthesizer returned malformed or incomplete status in round ${round}.`);
		}
		await writeFileQueued(synthOut, synth.text);
		onArtifact?.({ kind: "synthesis", round, name: "synthesizer", path: synthOut, text: synth.text });
		await writeFileQueued(workingPath, synth.text);
		allRoundFiles.push(synthOut);
		previousSynthesisPath = synthOut;
		status = parseStatus(synth.text);
		converged = parseConverged(synth.text);
		if (degraded && status === "UNRESOLVED") status = "DEGRADED";
		onPanelEvent?.({ type: "synth_done", round, path: synthOut, text: synth.text, status, converged });
		if (runSignal.aborted) {
			status = "CANCELLED";
			converged = false;
			break;
		}

		const questions = extractQuestions(synth.text);
		if (questions.length) onPanelEvent?.({ type: "questions", round, questions });
		let userAnswered = false;
		if (params.interactive && questions.length) {
			pauseGlobalTimer();
			try {
				userAnswered = await askUserForQuestions(ctx, round, questions, answersPath);
			} finally {
				startGlobalTimer();
			}
		}
		if (userAnswered && round < rounds) converged = false;
		if (converged) break;
	}

	if (runSignal.aborted) {
		status = "CANCELLED";
		converged = false;
		await writeFileQueued(workingPath, `# Workshop cancelled\n\nSTATUS: CANCELLED\nCONVERGED: NO\n\nThe run was cancelled or timed out. Partial artifacts remain in this directory.\n`);
	} else if (degraded && !converged) {
		status = "DEGRADED";
	}
	const finalText = await fs.readFile(workingPath, "utf8");
	const truncation = truncateHead(finalText, { maxBytes: OUTPUT_CAP_BYTES, maxLines: 2000 });
	await writeFileQueued(finalPath, finalText);
	await writeFileQueued(transcriptPath, await formatTranscript(allRoundFiles, finalText));

	let reportPath: string | undefined;
	const resultBase = {
		status,
		converged,
		roundsRun,
		workshopDir,
		transcriptPath,
		resolutionPath: finalPath,
		workflowPath,
		manifestPath,
		experts: experts.map((e) => e.name),
		subagentWorkflow,
	};
	if (htmlReportEnabled) {
		reportPath = await generateHtmlReport({
			workshopDir,
			ideaPath,
			workflowPath,
			answersPath,
			finalPath,
			transcriptPath,
			roundFiles: allRoundFiles,
			result: resultBase,
		});
	}
	await scanDownloads("workshop", "final", roundsRun);
	await writeRunManifest(workshopDir, {
		extensionVersion: EXTENSION_VERSION,
		piNodeVersion: process.version,
		startedAt: startedAt.toISOString(),
		finishedAt: new Date().toISOString(),
		durationMs: Date.now() - startedAt.getTime(),
		status,
		converged,
		profile: resolvedConfig.profile ?? null,
		configPaths: resolvedConfig.configPaths,
		params: { ...params, idea: params.idea },
		limits: resolvedConfig.limits,
		models: { strongModel, plannerModel, expertModel, synthModel, juniorModel },
		experts: experts.map((expert) => ({ name: expert.name, model: expert.model, tools: expert.tools })),
		childRuns,
		downloadedFiles: downloadAudit.files,
		errors,
		scratchPolicy: scratchPolicy ? { path: SCRATCH_POLICY_FILE, allowedExperts: scratchPolicy.allowedExperts, expiresAt: scratchPolicy.expiresAt, artifactContainedNotSandboxed: true } : undefined,
		reportPath: reportPath ?? null,
	});
	signal?.removeEventListener("abort", onExternalAbort);
	stopGlobalTimer();

	const summary = [
		`# Workshop resolution`,
		``,
		`Status: **${status}**`,
		`Converged: **${converged ? "yes" : "no"}** after ${roundsRun} round${roundsRun === 1 ? "" : "s"}`,
		`Experts: ${experts.map((e) => e.name).join(", ")}`,
		``,
		`Artifacts:`,
		`- Resolution: ${finalPath}`,
		`- Workflow: ${workflowPath}`,
		`- Manifest: ${manifestPath}`,
		reportPath ? `- HTML report: ${reportPath}` : undefined,
		`- Transcript: ${transcriptPath}`,
		`- Workshop dir: ${workshopDir}`,
		``,
		`Subagent workflow:`,
		...subagentWorkflow.map((line) => `- ${line}`),
		``,
		`---`,
		``,
		truncation.content,
		truncation.truncated ? `\n\n[Resolution truncated in tool output; full file at ${finalPath}]` : "",
	].filter((line): line is string => line !== undefined).join("\n");

	const result: WorkshopResult = {
		summary,
		...resultBase,
		reportPath,
	};
	onPanelEvent?.({ type: "final", result });
	return result;
}

type LaneState = { name: string; status: "queued" | "running" | "done"; activity: string[]; path?: string; text?: string };
type DashboardState = {
	round: number;
	rounds: number;
	phase: string;
	lanes: Map<string, LaneState>;
	synthesis?: { status?: ResolutionStatus; converged?: boolean; activity: string[]; path?: string; text?: string };
	questions: string[];
	delegation: string[];
	subagents: SubagentAuditEntry[];
	toolEvents: ToolAuditEvent[];
	downloads: ObservedFile[];
	final?: WorkshopResult;
};

function createDashboardState(): DashboardState {
	return { round: 0, rounds: 0, phase: "starting", lanes: new Map(), synthesis: { activity: [] }, questions: [], delegation: [], subagents: [], toolEvents: [], downloads: [] };
}

function pushActivity(items: string[], text: string, limit = 4): void {
	const trimmed = text.replace(/\s+/g, " ").trim();
	if (!trimmed) return;
	items.push(trimmed);
	while (items.length > limit) items.shift();
}

function updateDashboardState(state: DashboardState, event: PanelEvent): void {
	if (event.type === "planner_start") {
		state.phase = "planning workshop";
		state.lanes = new Map([["panel-designer", { name: "panel-designer", status: "running", activity: ["choosing expert mix"] }]]);
		state.synthesis = { activity: [] };
		return;
	}
	if (event.type === "planner_done") {
		state.phase = "panel planned";
		state.lanes = new Map(event.experts.map((name) => [name, { name, status: "queued" as const, activity: ["selected for panel"] }]));
		return;
	}
	if (event.type === "delegation_policy") {
		state.delegation = event.lines;
		return;
	}
	if (event.type === "brief_start") {
		const lane = state.lanes.get(event.name) ?? { name: event.name, status: "queued" as const, activity: [] };
		lane.status = "running";
		pushActivity(lane.activity, "assistant subagents briefing");
		state.lanes.set(event.name, lane);
		state.phase = "assistant briefs";
		return;
	}
	if (event.type === "brief_done") {
		const lane = state.lanes.get(event.name) ?? { name: event.name, status: "queued" as const, activity: [] };
		lane.status = "queued";
		pushActivity(lane.activity, `brief ready: ${path.basename(event.path)}`);
		state.lanes.set(event.name, lane);
		return;
	}
	if (event.type === "round_start") {
		state.round = event.round;
		state.rounds = event.rounds;
		state.phase = "expert critique";
		state.lanes = new Map(event.experts.map((name) => [name, { name, status: "queued" as const, activity: [] }]));
		state.synthesis = { activity: [] };
		state.questions = [];
		return;
	}
	if (event.type === "expert_start") {
		const lane = state.lanes.get(event.name) ?? { name: event.name, status: "queued" as const, activity: [] };
		lane.status = "running";
		pushActivity(lane.activity, "started");
		state.lanes.set(event.name, lane);
		return;
	}
	if (event.type === "expert_activity") {
		const lane = state.lanes.get(event.name) ?? { name: event.name, status: "running" as const, activity: [] };
		lane.status = "running";
		pushActivity(lane.activity, event.text);
		state.lanes.set(event.name, lane);
		return;
	}
	if (event.type === "expert_done") {
		const lane = state.lanes.get(event.name) ?? { name: event.name, status: "done" as const, activity: [] };
		lane.status = "done";
		lane.path = event.path;
		lane.text = event.text;
		pushActivity(lane.activity, event.text.split("\n").find((line) => line.trim().startsWith("VERDICT:")) ?? "critique complete");
		state.lanes.set(event.name, lane);
		return;
	}
	if (event.type === "synth_start") {
		state.phase = "synthesis";
		state.synthesis = { activity: ["merging expert critiques"] };
		return;
	}
	if (event.type === "synth_done") {
		state.phase = event.converged ? "converged" : "not converged";
		state.synthesis = { status: event.status, converged: event.converged, activity: [], path: event.path, text: event.text };
		pushActivity(state.synthesis.activity, `${event.status} / converged=${event.converged ? "yes" : "no"}`);
		return;
	}
	if (event.type === "questions") {
		state.questions = event.questions;
		state.phase = "awaiting user input";
		return;
	}
	if (event.type === "subagent_start") {
		state.subagents = [...state.subagents.filter((item) => item.id !== event.subagent.id), event.subagent];
		const lane = event.subagent.expert ? state.lanes.get(event.subagent.expert) : undefined;
		if (lane) {
			pushActivity(lane.activity, `subagent ${event.subagent.agent ?? "run"} started`);
			state.lanes.set(lane.name, lane);
		}
		return;
	}
	if (event.type === "subagent_activity") {
		state.subagents = state.subagents.map((item) => {
			if (item.id !== event.id) return item;
			const activity = [...(item.activity ?? [])];
			pushActivity(activity, event.text, 8);
			return { ...item, activity, outputPreview: event.text };
		});
		return;
	}
	if (event.type === "subagent_done") {
		const previous = state.subagents.find((item) => item.id === event.subagent.id);
		state.subagents = [...state.subagents.filter((item) => item.id !== event.subagent.id), { ...event.subagent, activity: previous?.activity ?? event.subagent.activity }];
		const observedAt = new Date().toISOString();
		const subagentFiles: ObservedFile[] = [
			...(event.subagent.sessionExports ?? []).map((filePath) => ({ path: filePath, name: path.basename(filePath), source: "subagent-session" as const, detectedAt: observedAt, owner: event.subagent.name, phase: event.subagent.phase, round: event.subagent.round })),
			...(event.subagent.savedOutputs ?? []).map((filePath) => ({ path: filePath, name: path.basename(filePath), source: "subagent-output" as const, detectedAt: observedAt, owner: event.subagent.name, phase: event.subagent.phase, round: event.subagent.round })),
			...(event.subagent.artifactOutputs ?? []).map((filePath) => ({ path: filePath, name: path.basename(filePath), source: "artifact-output" as const, detectedAt: observedAt, owner: event.subagent.name, phase: event.subagent.phase, round: event.subagent.round })),
		];
		if (subagentFiles.length) {
			const existing = new Set(state.downloads.map((file) => file.path));
			state.downloads = [...state.downloads, ...subagentFiles.filter((file) => !existing.has(file.path))].slice(-100);
		}
		const lane = event.subagent.expert ? state.lanes.get(event.subagent.expert) : undefined;
		if (lane) {
			pushActivity(lane.activity, `subagent ${event.subagent.agent ?? "run"} ${event.subagent.status}`);
			state.lanes.set(lane.name, lane);
		}
		return;
	}
	if (event.type === "tool_event") {
		state.toolEvents = [...state.toolEvents, event.event].slice(-200);
		if (event.event.toolName === "subagent" && /call|start|begin/i.test(event.event.eventType)) {
			const id = `direct:${event.event.child}:${event.event.round ?? "?"}:${state.toolEvents.length}`;
			state.subagents = [...state.subagents, {
				id,
				name: `${event.event.child} direct subagent`,
				expert: event.event.child,
				round: event.event.round,
				phase: "direct_tool",
				status: "running",
				startedAt: event.event.time,
				outputPreview: event.event.resultPreview ?? event.event.argsPreview,
			}].slice(-100);
		} else if (event.event.toolName === "subagent" && /result|end|complete|done/i.test(event.event.eventType)) {
			let updated = false;
			state.subagents = state.subagents.map((item) => {
				if (updated || item.phase !== "direct_tool" || item.expert !== event.event.child || item.status !== "running") return item;
				updated = true;
				return { ...item, status: "done", finishedAt: event.event.time, outputPreview: event.event.resultPreview ?? item.outputPreview };
			});
		}
		return;
	}
	if (event.type === "download_detected") {
		const existing = new Set(state.downloads.map((file) => file.path));
		state.downloads = [...state.downloads, ...event.files.filter((file) => !existing.has(file.path))].slice(-100);
		return;
	}
	if (event.type === "final") {
		state.final = event.result;
		state.phase = "final";
	}
}

function padAnsi(text: string, width: number): string {
	const truncated = truncateToWidth(text, width, "…");
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function boxLines(title: string, status: string, body: string[], width: number, theme: any, color: "accent" | "success" | "warning" | "muted"): string[] {
	const inner = Math.max(10, width - 2);
	const topLabel = ` ${title} `;
	const top = theme.fg(color, "╭" + "─".repeat(Math.max(0, inner - visibleWidth(topLabel))) + topLabel + "╮");
	const bottom = theme.fg(color, "╰" + "─".repeat(inner) + "╯");
	const rows = [theme.fg(color, status), ...body].slice(0, 5);
	while (rows.length < 5) rows.push("");
	return [top, ...rows.map((row) => theme.fg(color, "│") + padAnsi(row, inner) + theme.fg(color, "│")), bottom];
}

function dashboardStatsLine(state: DashboardState, theme: any): string {
	const parentSubagents = state.subagents.filter((item) => item.phase === "assistant_brief").length;
	const directSubagents = state.subagents.filter((item) => item.phase === "direct_tool").length;
	const runningSubagents = state.subagents.filter((item) => item.status === "running").length;
	const downloaded = state.downloads.filter((file) => file.source === "downloads").length;
	const savedFiles = state.downloads.length - downloaded;
	const toolEvents = state.toolEvents.length;
	const parts = [
		`${parentSubagents + directSubagents} subagent${parentSubagents + directSubagents === 1 ? "" : "s"}${runningSubagents ? ` (${runningSubagents} running)` : ""}`,
		`${downloaded} downloaded file${downloaded === 1 ? "" : "s"}`,
		`${savedFiles} saved/artifact file${savedFiles === 1 ? "" : "s"}`,
		`${toolEvents} tool event${toolEvents === 1 ? "" : "s"}`,
	];
	return theme.fg("accent", "observatory") + theme.fg("muted", `  ${parts.join(" • ")}  •  /workshop-observatory or Ctrl+Alt+W to inspect`);
}

function renderDashboardLines(state: DashboardState, theme: any, width: number): string[] {
	const w = Math.max(50, width);
	const lines: string[] = [];
	const phase = state.final
		? `${state.final.status} (${state.final.converged ? "converged" : "not converged"})`
		: `${state.phase} • round ${state.round || "?"}/${state.rounds || "?"}`;
	lines.push(truncateToWidth(theme.fg("accent", theme.bold("workshop observatory")) + theme.fg("muted", `  ${phase}`), w));

	const flow = [
		["plan", state.phase.includes("planning") || state.phase.includes("planned")],
		["briefs", state.phase.includes("brief")],
		["experts", state.phase.includes("expert")],
		["synthesis", state.phase.includes("synthesis")],
		["questions", state.phase.includes("question") || state.phase.includes("awaiting")],
		["final", Boolean(state.final)],
	] as const;
	lines.push(
		truncateToWidth(
			flow
				.map(([label, active]) => (active ? theme.fg("accent", `[${label}]`) : theme.fg("dim", `[${label}]`)))
				.join(theme.fg("borderMuted", " ─▶ ")),
			w,
		),
	);
	if (state.delegation.length) {
		lines.push(truncateToWidth(theme.fg("muted", `subagents: ${state.delegation.join(" • ")}`), w));
	}

	const lanes = Array.from(state.lanes.values());
	const cols = w >= 110 ? 2 : 1;
	const gap = cols === 2 ? 2 : 0;
	const colW = cols === 2 ? Math.floor((w - gap) / 2) : w;
	for (let i = 0; i < lanes.length; i += cols) {
		const group = lanes.slice(i, i + cols);
		const boxes = group.map((lane) => {
			const icon = lane.status === "done" ? "✓" : lane.status === "running" ? "●" : "○";
			const color = lane.status === "done" ? "success" : lane.status === "running" ? "warning" : "muted";
			const activity = lane.activity.length ? lane.activity.slice(-3) : ["queued"];
			return boxLines(lane.name, `${icon} ${lane.status}`, activity.map((a) => theme.fg("dim", a)), colW, theme, color);
		});
		if (boxes.length === 1) {
			lines.push(...boxes[0].map((line) => truncateToWidth(line, w)));
		} else {
			for (let row = 0; row < boxes[0].length; row++) {
				lines.push(truncateToWidth(padAnsi(boxes[0][row], colW) + " ".repeat(gap) + padAnsi(boxes[1][row], colW), w));
			}
		}
	}

	if (state.synthesis && (state.synthesis.activity.length || state.synthesis.status)) {
		const synthIcon = state.synthesis.converged ? "✓" : "◆";
		const synthText = state.synthesis.activity[state.synthesis.activity.length - 1] ?? "pending";
		lines.push(...boxLines("synthesis", `${synthIcon} ${state.synthesis.status ?? "running"}`, [theme.fg("dim", synthText)], w, theme, state.synthesis.converged ? "success" : "warning"));
	}
	if (state.questions.length) {
		const qLines = [`${state.questions.length} user question(s) — answer popup can steer next round`, ...state.questions.slice(0, 3).map((q) => `Q: ${q}`)];
		lines.push(...boxLines("user steering", "? waiting", qLines.map((q) => theme.fg("dim", q)), w, theme, "warning"));
	}
	if (state.final) {
		lines.push(...boxLines("resolution", state.final.status, [theme.fg("dim", state.final.reportPath ?? state.final.resolutionPath)], w, theme, state.final.converged ? "success" : "warning"));
	}
	lines.push(truncateToWidth(dashboardStatsLine(state, theme), w));
	return lines.slice(0, 30);
}

function installDashboardWidget(ctx: any, state: DashboardState): void {
	ctx.ui.setWidget(
		"pi-workshop-dashboard",
		(_tui: any, theme: any) => ({
			render: (width: number) => renderDashboardLines(state, theme, width),
			invalidate: () => {},
		}),
		{ placement: "aboveEditor" },
	);
}

function formatBytes(bytes?: number): string {
	if (bytes === undefined) return "unknown size";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type ObservatoryItem = { label: string; description: string; detail: () => string };

function observatoryItems(state: DashboardState): ObservatoryItem[] {
	const items: ObservatoryItem[] = [];
	for (const lane of state.lanes.values()) {
		items.push({
			label: `expert: ${lane.name}`,
			description: `${lane.status}${lane.path ? ` • ${path.basename(lane.path)}` : ""}`,
			detail: () => [
				`# Expert lane: ${lane.name}`,
				`Status: ${lane.status}`,
				lane.path ? `Artifact: ${lane.path}` : "Artifact: not written yet",
				"",
				"## Recent activity",
				...(lane.activity.length ? lane.activity.map((a) => `- ${a}`) : ["- none yet"]),
				"",
				lane.text ? `## Critique preview\n\n${lane.text.slice(0, 6000)}` : "Critique preview not available yet.",
			].join("\n"),
		});
	}
	if (state.synthesis?.path || state.synthesis?.activity.length) {
		items.push({
			label: "synthesis",
			description: `${state.synthesis.status ?? "running"}${state.synthesis.path ? ` • ${path.basename(state.synthesis.path)}` : ""}`,
			detail: () => [
				"# Synthesis",
				`Status: ${state.synthesis?.status ?? "running"}`,
				`Converged: ${state.synthesis?.converged ? "yes" : "no"}`,
				state.synthesis?.path ? `Artifact: ${state.synthesis.path}` : "Artifact: not written yet",
				"",
				state.synthesis?.text ? state.synthesis.text.slice(0, 6000) : (state.synthesis?.activity ?? []).join("\n"),
			].join("\n"),
		});
	}
	for (const sub of state.subagents.slice().reverse()) {
		items.push({
			label: `subagent: ${sub.name}`,
			description: `${sub.status} • ${sub.phase}${sub.expert ? ` • ${sub.expert}` : ""}`,
			detail: () => [
				`# Subagent thread: ${sub.name}`,
				`Status: ${sub.status}`,
				`Phase: ${sub.phase}`,
				sub.expert ? `Expert: ${sub.expert}` : undefined,
				sub.agent ? `Agent: ${sub.agent}` : undefined,
				sub.round ? `Round: ${sub.round}` : undefined,
				`Started: ${sub.startedAt}`,
				sub.finishedAt ? `Finished: ${sub.finishedAt}` : undefined,
				sub.durationMs !== undefined ? `Duration: ${(sub.durationMs / 1000).toFixed(1)}s` : undefined,
				sub.exitCode !== undefined ? `Exit code: ${sub.exitCode}` : undefined,
				"",
				sub.task ? `## Task\n${sub.task}` : undefined,
				sub.activity?.length ? `## Live/recent activity\n${sub.activity.map((a) => `- ${a}`).join("\n")}` : undefined,
				sub.outputPreview ? `## Output preview\n${sub.outputPreview}` : undefined,
				sub.sessionExports?.length ? `## Session exports\n${sub.sessionExports.map((p) => `- ${p}`).join("\n")}` : undefined,
				sub.savedOutputs?.length ? `## Saved outputs\n${sub.savedOutputs.map((p) => `- ${p}`).join("\n")}` : undefined,
				sub.artifactOutputs?.length ? `## Artifact outputs\n${sub.artifactOutputs.map((p) => `- ${p}`).join("\n")}` : undefined,
			].filter(Boolean).join("\n"),
		});
	}
	for (const file of state.downloads.slice().reverse()) {
		items.push({
			label: `${file.source === "downloads" ? "download" : "file"}: ${file.name}`,
			description: `${file.source} • ${formatBytes(file.bytes)}${file.owner ? ` • ${file.owner}` : ""}`,
			detail: () => [
				`# File: ${file.name}`,
				`Path: ${file.path}`,
				`Source: ${file.source}`,
				`Size: ${formatBytes(file.bytes)}`,
				file.mtimeMs ? `Modified: ${new Date(file.mtimeMs).toISOString()}` : undefined,
				`Detected: ${file.detectedAt}`,
				file.owner ? `Owner/child: ${file.owner}` : undefined,
				file.phase ? `Phase: ${file.phase}` : undefined,
				file.round ? `Round: ${file.round}` : undefined,
			].filter(Boolean).join("\n"),
		});
	}
	for (const event of state.toolEvents.slice(-50).reverse()) {
		items.push({
			label: `tool: ${event.toolName}`,
			description: `${event.child} • ${event.eventType}`,
			detail: () => [
				`# Tool event: ${event.toolName}`,
				`Child: ${event.child}`,
				`Event: ${event.eventType}`,
				`Time: ${event.time}`,
				event.phase ? `Phase: ${event.phase}` : undefined,
				event.round ? `Round: ${event.round}` : undefined,
				"",
				event.argsPreview ? `## Args\n${event.argsPreview}` : undefined,
				event.resultPreview ? `## Result\n${event.resultPreview}` : undefined,
			].filter(Boolean).join("\n"),
		});
	}
	if (state.final) {
		items.unshift({
			label: "final resolution",
			description: `${state.final.status} • ${state.final.converged ? "converged" : "not converged"}`,
			detail: () => [
				"# Final resolution",
				`Status: ${state.final?.status}`,
				`Converged: ${state.final?.converged ? "yes" : "no"}`,
				`Workshop dir: ${state.final?.workshopDir}`,
				`Resolution: ${state.final?.resolutionPath}`,
				`Transcript: ${state.final?.transcriptPath}`,
				state.final?.reportPath ? `Report: ${state.final.reportPath}` : undefined,
			].filter(Boolean).join("\n"),
		});
	}
	return items;
}

function launchWorkshopObservatory(ctx: any, state: DashboardState, setRefresh: (requestRender?: () => void) => void): void {
	void openWorkshopObservatory(ctx, state, setRefresh).catch((error) => {
		ctx.ui.notify(`Workshop observatory failed: ${String((error as Error)?.message ?? error)}`, "error");
	});
}

async function openWorkshopObservatory(ctx: any, state?: DashboardState, onRefresh?: (requestRender?: () => void) => void): Promise<void> {
	if (!state) {
		ctx.ui.notify("No active workshop observatory state yet", "warning");
		return;
	}
	if (!ctx.hasUI) {
		ctx.ui.notify("/workshop-observatory requires the interactive TUI", "warning");
		return;
	}
	try {
		await ctx.ui.custom((tui: any, theme: any, _keybindings: any, done: () => void) => {
		onRefresh?.(() => tui.requestRender());
		let selected = 0;
		let detail = false;
		let scroll = 0;
		const renderList = (width: number): string[] => {
			const items = observatoryItems(state);
			if (selected >= items.length) selected = Math.max(0, items.length - 1);
			const header = theme.fg("accent", theme.bold("workshop observatory navigator")) + theme.fg("muted", `  ${dashboardStatsLine(state, theme).replace(/\x1b\[[0-9;]*m/g, "")}`);
			const lines = [truncateToWidth(header, width), truncateToWidth(theme.fg("dim", "↑↓ select • enter details • esc close"), width)];
			if (!items.length) return [...lines, theme.fg("muted", "No observable expert/subagent/file events yet.")];
			const windowSize = 18;
			const start = Math.max(0, Math.min(selected - Math.floor(windowSize / 2), items.length - windowSize));
			for (let i = start; i < Math.min(items.length, start + windowSize); i++) {
				const item = items[i];
				const prefix = i === selected ? theme.fg("accent", "› ") : "  ";
				const text = `${item.label} — ${item.description}`;
				lines.push(truncateToWidth(prefix + (i === selected ? theme.fg("accent", text) : text), width));
			}
			return lines;
		};
		const renderDetail = (width: number): string[] => {
			const items = observatoryItems(state);
			const item = items[selected];
			if (!item) return renderList(width);
			const body = item.detail();
			const wrapped = body.split("\n").flatMap((line) => wrapTextWithAnsi(line || " ", Math.max(20, width - 2)));
			const visible = wrapped.slice(scroll, scroll + 24);
			return [
				truncateToWidth(theme.fg("accent", theme.bold(item.label)) + theme.fg("muted", "  ↑↓ scroll • ←/backspace list • esc close"), width),
				...visible.map((line) => truncateToWidth(line, width)),
				truncateToWidth(theme.fg("dim", `${Math.min(scroll + visible.length, wrapped.length)}/${wrapped.length} lines`), width),
			];
		};
		return {
			render: (width: number) => detail ? renderDetail(width) : renderList(width),
			invalidate: () => {},
			handleInput: (data: string) => {
				const items = observatoryItems(state);
				if (matchesKey(data, Key.escape)) { done(); return; }
				if (detail) {
					if (matchesKey(data, Key.left) || matchesKey(data, Key.backspace)) { detail = false; scroll = 0; tui.requestRender(); return; }
					if (matchesKey(data, Key.up)) scroll = Math.max(0, scroll - 1);
					else if (matchesKey(data, Key.down)) scroll += 1;
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.up)) selected = Math.max(0, selected - 1);
				else if (matchesKey(data, Key.down)) selected = Math.min(Math.max(0, items.length - 1), selected + 1);
				else if (matchesKey(data, Key.enter) && items.length) { detail = true; scroll = 0; }
				tui.requestRender();
			},
		};
		}, { overlay: true, overlayOptions: { width: "90%", maxHeight: "85%", anchor: "center", margin: 1 } });
	} finally {
		onRefresh?.(undefined);
	}
}

async function listWorkshopSessions(cwd: string): Promise<Array<{ dir: string; label: string; mtimeMs: number; status?: string }>> {
	const roots: string[] = [];
	let probe = cwd;
	while (true) {
		const root = path.join(probe, ".pi", "workshops");
		if (!roots.includes(root)) roots.push(root);
		const parent = path.dirname(probe);
		if (parent === probe || probe === os.homedir()) break;
		probe = parent;
	}
	const sessions: Array<{ dir: string; label: string; mtimeMs: number; status?: string }> = [];
	for (const root of roots) {
		let entries: fssync.Dirent[] = [];
		try {
			entries = await fs.readdir(root, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const dir = path.join(root, entry.name);
			const resolution = path.join(dir, "resolution.md");
			if (!fssync.existsSync(resolution)) continue;
			const stat = await fs.stat(resolution).catch(() => undefined);
			const text = await fs.readFile(resolution, "utf8").catch(() => "");
			const status = text.match(/^STATUS:\s*(.+)$/im)?.[1]?.trim() ?? text.match(/Status:\s*\*\*(.+?)\*\*/i)?.[1]?.trim();
			sessions.push({
				dir,
				label: `${entry.name}${status ? `  [${status}]` : ""}`,
				mtimeMs: stat?.mtimeMs ?? 0,
				status,
			});
		}
	}
	return sessions.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 30);
}

type ParsedWorkshopCommand = Pick<WorkshopInput, "idea" | "rounds" | "profile" | "webResearch" | "localBash" | "planExperts" | "subagents" | "expertSubagents" | "prototyping" | "htmlReport" | "workshop" | "strongModel" | "plannerModel" | "expertModel" | "juniorModel" | "synthModel"> & { keepDashboard?: boolean; openObservatory?: boolean; check?: boolean };

function unquoteArg(text: string): string {
	return text.replace(/^"|"$/g, "");
}

function parsePositiveIntFlag(value: string, flag: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_ROUNDS) throw new Error(`${flag} must be an integer between 1 and ${MAX_ROUNDS}`);
	return parsed;
}

function parseFlagBooleanValue(value: string, flag: string): boolean {
	if (/^(true|1|yes|on)$/i.test(value)) return true;
	if (/^(false|0|no|off)$/i.test(value)) return false;
	throw new Error(`${flag} expects a boolean value`);
}

function parseWorkshopCommand(args: string): ParsedWorkshopCommand {
	const parts = args.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
	const parsed: ParsedWorkshopCommand = { idea: "" };
	const ideaParts: string[] = [];
	const takeValue = (i: number, flag: string): [string, number] => {
		if (parts[i]?.startsWith(`${flag}=`)) return [unquoteArg(parts[i].slice(flag.length + 1)), i];
		if (!parts[i + 1] || parts[i + 1].startsWith("--")) throw new Error(`${flag} requires a value`);
		return [unquoteArg(parts[i + 1]), i + 1];
	};
	const setBoolean = (name: keyof ParsedWorkshopCommand, value: boolean) => { (parsed as any)[name] = value; };
	for (let i = 0; i < parts.length; i++) {
		const raw = unquoteArg(parts[i]);
		if (raw === "--rounds" || raw.startsWith("--rounds=")) {
			const [value, next] = takeValue(i, "--rounds");
			parsed.rounds = parsePositiveIntFlag(value, "--rounds");
			i = next;
			continue;
		}
		if (raw === "--profile" || raw.startsWith("--profile=")) {
			const [value, next] = takeValue(i, "--profile");
			parsed.profile = value;
			i = next;
			continue;
		}
		const valueFlag = (flag: string, key: keyof ParsedWorkshopCommand): boolean => {
			if (raw === flag || raw.startsWith(`${flag}=`)) {
				const [value, next] = takeValue(i, flag);
				(parsed as any)[key] = value;
				i = next;
				return true;
			}
			return false;
		};
		if (valueFlag("--strong-model", "strongModel")) continue;
		if (valueFlag("--planner-model", "plannerModel")) continue;
		if (valueFlag("--expert-model", "expertModel")) continue;
		if (valueFlag("--junior-model", "juniorModel")) continue;
		if (valueFlag("--synth-model", "synthModel")) continue;

		const boolWithOptionalValue = (flags: string[], key: keyof ParsedWorkshopCommand, value: boolean): boolean => {
			for (const flag of flags) {
				if (raw === flag) { setBoolean(key, value); return true; }
				if (raw.startsWith(`${flag}=`)) { setBoolean(key, parseFlagBooleanValue(raw.slice(flag.length + 1), flag)); return true; }
			}
			return false;
		};
		if (boolWithOptionalValue(["--web-research", "--web"], "webResearch", true)) continue;
		if (boolWithOptionalValue(["--no-web-research", "--no-web"], "webResearch", false)) continue;
		if (boolWithOptionalValue(["--local-bash", "--bash"], "localBash", true)) continue;
		if (boolWithOptionalValue(["--no-local-bash", "--no-bash"], "localBash", false)) continue;
		if (boolWithOptionalValue(["--fixed-experts", "--no-plan"], "planExperts", false)) continue;
		if (boolWithOptionalValue(["--plan"], "planExperts", true)) continue;
		if (boolWithOptionalValue(["--keep-dashboard"], "keepDashboard", true)) continue;
		if (boolWithOptionalValue(["--no-keep-dashboard"], "keepDashboard", false)) continue;
		if (boolWithOptionalValue(["--observatory", "--open-observatory", "--inspect"], "openObservatory", true)) continue;
		if (boolWithOptionalValue(["--no-observatory", "--no-open-observatory", "--no-inspect"], "openObservatory", false)) continue;
		if (boolWithOptionalValue(["--subagents", "--briefs"], "subagents", true)) continue;
		if (boolWithOptionalValue(["--no-subagents", "--no-briefs"], "subagents", false)) continue;
		if (boolWithOptionalValue(["--expert-subagents", "--allow-expert-subagents"], "expertSubagents", true)) continue;
		if (boolWithOptionalValue(["--no-expert-subagents", "--no-allow-expert-subagents"], "expertSubagents", false)) continue;
		if (boolWithOptionalValue(["--prototype", "--prototypes", "--prototyping"], "prototyping", true)) continue;
		if (boolWithOptionalValue(["--no-prototype", "--no-prototypes", "--no-prototyping"], "prototyping", false)) continue;
		if (boolWithOptionalValue(["--html-report", "--report"], "htmlReport", true)) continue;
		if (boolWithOptionalValue(["--no-html-report", "--no-report"], "htmlReport", false)) continue;
		if (boolWithOptionalValue(["--workshop", "--rlm"], "workshop", true)) continue;
		if (boolWithOptionalValue(["--no-workshop", "--no-rlm"], "workshop", false)) continue;
		if (boolWithOptionalValue(["--check"], "check", true)) continue;
		if (raw.startsWith("--")) throw new Error(`Unknown /workshop flag: ${raw}`);
		ideaParts.push(raw);
	}
	parsed.idea = ideaParts.join(" ").trim();
	return parsed;
}

function sanitizePublicWorkshopParams(params: PublicWorkshopInput): WorkshopInput {
	if (params.profile && params.profile !== "safe") {
		throw new Error("Assistant-invoked workshop may only use the non-privileged 'safe' profile. Use /workshop for privileged profiles.");
	}
	return definedOnly({
		idea: params.idea,
		rounds: params.rounds,
		profile: params.profile,
		experts: params.experts?.map((expert) => ({ name: expert.name, stance: expert.stance })),
		contextPaths: params.contextPaths,
		interactive: params.interactive,
		webResearch: params.webResearch,
		planExperts: params.planExperts,
		subagents: params.subagents,
		htmlReport: params.htmlReport,
		localBash: false,
		expertSubagents: false,
		prototyping: false,
		workshop: false,
	}) as WorkshopInput;
}

function modelExists(ctx: any, ref: string | undefined): boolean {
	if (!ref) return true;
	const [provider, ...rest] = ref.split("/");
	const id = rest.join("/");
	if (!provider || !id) return true;
	try { return Boolean(ctx?.modelRegistry?.find?.(provider, id)); } catch (error) { logWarn(`modelExists(${ref})`, error); return false; }
}

async function preflightWorkshop(pi: ExtensionAPI, ctx: any, params: WorkshopInput): Promise<{ ok: boolean; critical: string[]; warnings: string[]; content: string }> {
	const resolved = await resolveWorkshopConfig(resolveMaybe(ctx.cwd, params.cwd ?? "."), params);
	const resolvedParams = resolved.params;
	const webResearch = Boolean(resolvedParams.webResearch);
	const localBash = Boolean(resolvedParams.localBash);
	const allTools = new Set((pi.getAllTools?.() ?? []).map((tool: any) => String(tool.name)));
	const critical: string[] = [];
	const warnings: string[] = [];
	for (const tool of DEFAULT_TOOLS.split(",")) if (!allTools.has(tool)) warnings.push(`Built-in read/search tool not visible in parent: ${tool}`);
	if (webResearch) {
		for (const tool of WEB_RESEARCH_TOOLS.split(",")) if (!allTools.has(tool)) critical.push(`webResearch requested but tool is unavailable: ${tool}`);
	}
	if ((resolvedParams.subagents || resolvedParams.expertSubagents) && !allTools.has("subagent")) critical.push("subagents requested but the subagent tool is unavailable");
	if (localBash && !allTools.has("bash")) critical.push("localBash requested but bash tool is unavailable");
	for (const model of [resolvedParams.strongModel, resolvedParams.plannerModel, resolvedParams.expertModel, resolvedParams.juniorModel, resolvedParams.synthModel]) {
		if (!modelExists(ctx, model)) warnings.push(`Configured model was not found in the current model registry: ${model}`);
	}
	const workshopsRoot = path.join(resolveMaybe(ctx.cwd, resolvedParams.cwd ?? "."), ".pi", "workshops");
	try {
		await fs.mkdir(workshopsRoot, { recursive: true });
		await fs.access(workshopsRoot, fssync.constants.W_OK);
	} catch (error) {
		critical.push(`Cannot write workshop artifacts under ${workshopsRoot}: ${String((error as Error)?.message ?? error)}`);
	}
	const content = [
		"# Pi workshop doctor",
		"",
		`Extension version: ${EXTENSION_VERSION}`,
		`Profile: ${resolved.profile ?? "none"}`,
		`Config files: ${resolved.configPaths.length ? resolved.configPaths.join(", ") : "built-in defaults only"}`,
		`Web research: ${webResearch ? "enabled" : "disabled"}`,
		`Local bash: ${localBash ? "enabled" : "disabled"}`,
		`Subagents: ${resolvedParams.subagents ? "parent briefs" : "off"}; expert direct: ${resolvedParams.expertSubagents ? "enabled" : "disabled"}`,
		`Prototyping: ${resolvedParams.prototyping ? "enabled (artifact-contained, not sandboxed)" : "disabled"}`,
		"",
		"## Critical",
		...(critical.length ? critical.map((item) => `- ${item}`) : ["- none"]),
		"",
		"## Warnings",
		...(warnings.length ? warnings.map((item) => `- ${item}`) : ["- none"]),
		"",
		"## Tool availability",
		...[...new Set([...DEFAULT_TOOLS.split(","), ...WEB_RESEARCH_TOOLS.split(","), "bash", "subagent", PROTOTYPE_TOOL])].map((tool) => `- ${tool}: ${allTools.has(tool) ? "ok" : "missing"}`),
	].join("\n");
	return { ok: critical.length === 0, critical, warnings, content };
}

export default function piWorkshop(pi: ExtensionAPI) {
	let activeWorkshop: { controller: AbortController; startedAt: number; label: string } | undefined;
	let latestDashboard: DashboardState | undefined;
	let observatoryRefresh: (() => void) | undefined;

	pi.registerMessageRenderer("pi-workshop", (message, _options, _theme) => {
		return new Markdown(String(message.content ?? ""), 0, 0, getMarkdownTheme());
	});

	pi.registerTool({
		name: PROTOTYPE_TOOL,
		label: "Workshop Scratchpad",
		description:
			"Create/run small throwaway prototype experiments for a workshop expert inside an active workshop artifact directory. Requires the per-run nonce from the workshop prompt. This is artifact-contained, not a security sandbox.",
		promptSnippet: "Run scratch/prototype code experiments for pi-workshop and save outputs as artifacts; requires an active-workshop nonce.",
		promptGuidelines: [
			"Use workshop_scratch only when workshop prompts provide a workshopDir and nonce; it is artifact-contained, not sandboxed, so keep experiments small and do not use it for project mutations.",
		],
		parameters: Type.Object({
			workshopDir: Type.String({ description: "Absolute or cwd-relative .pi/workshops/<run> artifact directory" }),
			expertName: Type.String({ description: "Expert lane/name using this scratchpad" }),
			nonce: Type.String({ description: "Per-run scratch nonce supplied in the workshop expert prompt" }),
			label: Type.Optional(Type.String({ description: "Short label for this run, e.g. timing-check or parser-prototype" })),
			files: Type.Optional(Type.Array(Type.Object({
				path: Type.String({ description: "Relative path under this expert's scratch directory" }),
				content: Type.String(),
			}), { description: "Optional files to create before running the command" })),
			command: Type.Optional(Type.String({ description: "Optional shell command to run from the expert scratch directory" })),
			timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, description: "Requested timeout for this scratch command. Defaults to config limits.scratchTimeoutSeconds; requests above limits.maxScratchTimeoutSeconds require approval/escalation." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const scratchConfig = await resolveWorkshopConfig(ctx.cwd, { idea: "scratch" });
			let timeoutSeconds = params.timeoutSeconds ?? scratchConfig.limits.scratchTimeoutSeconds;
			if (timeoutSeconds > scratchConfig.limits.maxScratchTimeoutSeconds) {
				const message = `Scratch command requested ${timeoutSeconds}s, above configured max ${scratchConfig.limits.maxScratchTimeoutSeconds}s.`;
				if (!ctx.hasUI) throw new Error(`${message} User approval is required before running longer scratch/prototype commands.`);
				const ok = await ctx.ui.confirm("Long scratch command", `${message}\n\nAllow this one command to proceed?`);
				if (!ok) throw new Error(`${message} User declined.`);
			} else {
				timeoutSeconds = Math.max(1, timeoutSeconds);
			}
			const workshopDir = resolveMaybe(ctx.cwd, params.workshopDir);
			if (!fssync.existsSync(workshopDir)) throw new Error("workshopDir does not exist");
			const realWorkshopDir = await fs.realpath(workshopDir);
			if (!realWorkshopDir.includes(`${path.sep}.pi${path.sep}workshops${path.sep}`)) {
				throw new Error("workshopDir must point inside a real .pi/workshops run directory");
			}
			const policy = await readScratchPolicy(realWorkshopDir);
			if (params.nonce !== policy.nonce) throw new Error("Invalid workshop_scratch nonce for this run");
			if (Date.now() > Date.parse(policy.expiresAt)) throw new Error("Workshop scratch policy has expired");
			const expertSegment = safeSegment(params.expertName);
			if (!policy.allowedExperts.includes(expertSegment)) throw new Error(`Expert ${params.expertName} is not allowed by this workshop scratch policy`);
			const scratchRoot = path.join(realWorkshopDir, "scratch", expertSegment);
			await fs.mkdir(scratchRoot, { recursive: true });
			await assertRealInside(realWorkshopDir, scratchRoot);
			const realScratchRoot = await fs.realpath(scratchRoot);
			const writtenFiles: string[] = [];
			let totalInputBytes = 0;
			for (const file of params.files ?? []) {
				if (path.isAbsolute(file.path)) throw new Error(`Scratch file path must be relative: ${file.path}`);
				if ((params.files?.length ?? 0) > 20) throw new Error("Too many scratch files requested; limit is 20");
				totalInputBytes += Buffer.byteLength(file.content);
				if (totalInputBytes > 256 * 1024) throw new Error("Scratch input files exceed 256KB total limit");
				const target = path.resolve(realScratchRoot, file.path);
				assertInside(realScratchRoot, target);
				await fs.mkdir(path.dirname(target), { recursive: true });
				await assertRealInside(realScratchRoot, path.dirname(target));
				const existing = await fs.lstat(target).catch(() => undefined);
				if (existing?.isSymbolicLink()) throw new Error(`Refusing to overwrite symlink scratch file: ${file.path}`);
				await writeFileQueued(target, file.content);
				writtenFiles.push(target);
			}
			let stdout = "";
			let stderr = "";
			let code: number | undefined;
			let killed: boolean | undefined;
			let execError: string | undefined;
			if (params.command?.trim()) {
				try {
					const run = await pi.exec("bash", ["-lc", params.command], {
						cwd: realScratchRoot,
						signal,
						timeout: timeoutSeconds * 1000,
					});
					stdout = run.stdout ?? "";
					stderr = run.stderr ?? "";
					code = run.code;
					killed = run.killed;
				} catch (error) {
					execError = String((error as Error)?.message ?? error);
					stderr += `\n${execError}`;
					code = 1;
				}
			}
			const label = safeSegment(params.label ?? params.command?.split("\n")[0] ?? "scratch-run");
			const artifactPath = path.join(realScratchRoot, `${timestampSlug()}-${label}.md`);
			const outTrunc = truncateHead(stdout, { maxBytes: 20 * 1024, maxLines: 500 });
			const errTrunc = truncateHead(stderr, { maxBytes: 10 * 1024, maxLines: 300 });
			const artifact = [
				`# Scratch run: ${params.label ?? label}`,
				``,
				`> Safety note: workshop_scratch is artifact-contained, not sandboxed. The command ran as the local user from the scratch directory.`,
				``,
				`Expert: ${params.expertName}`,
				`Directory: ${realScratchRoot}`,
				`Timeout: ${timeoutSeconds}s`,
				``,
				`## Files written`,
				...(writtenFiles.length ? writtenFiles.map((file) => `- ${file}`) : ["- none"]),
				``,
				`## Command`,
				"```bash",
				params.command ?? "(none)",
				"```",
				`Exit code: ${code ?? "not run"}${killed ? " (killed/timeout)" : ""}${execError ? ` (error: ${execError})` : ""}`,
				``,
				`## stdout`,
				"```text",
				outTrunc.content || "(empty)",
				outTrunc.truncated ? "\n[stdout truncated]" : "",
				"```",
				``,
				`## stderr`,
				"```text",
				errTrunc.content || "(empty)",
				errTrunc.truncated ? "\n[stderr truncated]" : "",
				"```",
			].join("\n");
			await writeFileQueued(artifactPath, artifact);
			return {
				content: [{ type: "text", text: `Scratch artifact: ${artifactPath}\nSafety: artifact-contained, not sandboxed.\nExit code: ${code ?? "not run"}\n\nstdout:\n${outTrunc.content || "(empty)"}\n\nstderr:\n${errTrunc.content || "(empty)"}` }],
				details: { scratchRoot: realScratchRoot, artifactPath, writtenFiles, code, killed, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr), artifactContainedNotSandboxed: true },
			};
		},

		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("workshop_scratch ")) + theme.fg("accent", args.expertName ?? "expert") + "\n" + theme.fg("dim", args.label ?? args.command ?? "scratch run"), 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as { artifactPath?: string; code?: number } | undefined;
			return new Text(`${theme.fg("success", "✓")} ${theme.fg("toolTitle", "scratch")}: ${theme.fg("accent", String(details?.code ?? "not run"))}\n${theme.fg("dim", details?.artifactPath ?? "")}`, 0, 0);
		},
	});

	pi.registerTool({
		name: "workshop",
		label: "Pi Workshop",
		description:
			"Run a recursive expert workshop over an idea until experts converge on ACCEPT, ITERATE, REJECT, ILL_POSED, or hit the round cap. Writes artifacts under .pi/workshops by default.",
		promptSnippet: "Ideate, research, prototype, and stress-test technical ideas with independent expert subprocesses until a shared resolution or round cap.",
		promptGuidelines: [
			"Use workshop when the user asks to ideate, stress-test, grill, or resolve a technical idea with multiple expert viewpoints.",
			"workshop can improve an idea, conclude it needs iteration, reject it, or declare it too poorly posed to proceed.",
			"Assistant-invoked workshop is restricted: it may use webResearch and parent-run briefs, but cannot grant bash, direct expert subagents, prototyping, cwd, outputDir, custom tools, or privileged workshop profiles. Tell the user to use /workshop for privileged modes.",
		],
		parameters: PublicWorkshopParams,
		prepareArguments(args) {
			if (!args || typeof args !== "object") return args;
			const input = args as Record<string, unknown>;
			return definedOnly({
				idea: input.idea,
				rounds: input.rounds,
				profile: input.profile,
				experts: Array.isArray(input.experts) ? input.experts.map((expert: any) => ({ name: expert?.name, stance: expert?.stance })) : undefined,
				contextPaths: input.contextPaths,
				interactive: input.interactive,
				webResearch: input.webResearch,
				planExperts: input.planExperts,
				subagents: input.subagents,
				htmlReport: input.htmlReport,
			});
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const safeParams = sanitizePublicWorkshopParams(params as PublicWorkshopInput);
			const preflight = await preflightWorkshop(pi, ctx, safeParams);
			if (!preflight.ok) throw new Error(`workshop preflight failed:\n${preflight.critical.join("\n")}`);
			const result = await runWorkshop(
				pi,
				safeParams,
				ctx,
				signal,
				onUpdate ? (text) => onUpdate({ content: [{ type: "text", text }], details: { phase: text } }) : undefined,
			);
			return {
				content: [{ type: "text", text: result.summary }],
				details: result,
			};
		},
		renderCall(args, theme) {
			const preview = typeof args.idea === "string" ? args.idea.slice(0, 80) : "...";
			return new Text(
				theme.fg("toolTitle", theme.bold("workshop ")) +
					theme.fg("accent", `${args.rounds ?? DEFAULT_ROUNDS} rounds`) +
					"\n" +
					theme.fg("dim", preview),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const details = result.details as WorkshopResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			const icon = details.converged ? theme.fg("success", "✓") : theme.fg("warning", "◐");
			return new Text(
				`${icon} ${theme.fg("toolTitle", theme.bold("workshop"))} ${theme.fg("accent", details.status)}\n` +
					`${theme.fg("muted", `${details.roundsRun} rounds • ${details.experts.join(", ")}`)}\n` +
					`${theme.fg("dim", details.reportPath ?? details.resolutionPath)}`,
				0,
				0,
			);
		},
	});

	const runWorkshopCommand = async (args: string, ctx: any) => {
		let parsed: ParsedWorkshopCommand;
		try {
			parsed = parseWorkshopCommand(args);
		} catch (error) {
			const message = `Workshop flag error: ${String((error as Error)?.message ?? error)}`;
			ctx.ui.notify(message, "error");
			pi.sendMessage({ customType: "pi-workshop", content: `# ${message}`, display: true, details: { error: message } });
			return;
		}
		let idea = parsed.idea;
		if (!idea) {
			if (!ctx.hasUI) {
				ctx.ui.notify("Usage: /workshop <technical idea>", "warning");
				return;
			}
			const edited = await ctx.ui.editor(
				"Technical idea for workshop",
				"Paste proposal / PRD excerpt / architecture here...\n\nFlags: --workshop --profile workshop --rounds 4 --web-research --local-bash --subagents --expert-subagents --prototype --html-report --fixed-experts",
			);
			idea = edited?.trim() ?? "";
		}
		if (!idea) {
			ctx.ui.notify("Workshop canceled: no idea provided", "warning");
			return;
		}
		const params = { ...parsed, idea, interactive: true };
		let preflight;
		let resolvedForUi;
		try {
			preflight = await preflightWorkshop(pi, ctx, params);
			resolvedForUi = await resolveWorkshopConfig(ctx.cwd, params);
		} catch (error) {
			const message = `Workshop preflight/config error: ${String((error as Error)?.message ?? error)}`;
			pi.sendMessage({ customType: "pi-workshop", content: `# ${message}`, display: true, details: { error: message } });
			return;
		}
		if (!preflight.ok) {
			pi.sendMessage({ customType: "pi-workshop", content: `${preflight.content}\n\n/workshop blocked by critical preflight failures.`, display: true, details: preflight });
			return;
		}
		const keepDashboard = Boolean(resolvedForUi.params.keepDashboard);
		const dashboard = createDashboardState();
		latestDashboard = dashboard;
		if (ctx.hasUI) installDashboardWidget(ctx, dashboard);
		if (ctx.hasUI && resolvedForUi.params.openObservatory) launchWorkshopObservatory(ctx, dashboard, (requestRender) => { observatoryRefresh = requestRender; });
		ctx.ui.setStatus("pi-workshop", "workshop starting...");
		const controller = new AbortController();
		activeWorkshop = { controller, startedAt: Date.now(), label: idea.slice(0, 80) };
		try {
			const result = await runWorkshop(
				pi,
				params,
				ctx,
				controller.signal,
				(text) => ctx.ui.setStatus("pi-workshop", text),
				(artifact) => {
					const title = artifact.kind === "critique" ? `# Round ${artifact.round}: ${artifact.name} critique` : `# Round ${artifact.round}: synthesis`;
					pi.sendMessage({
						customType: "pi-workshop",
						content: `${title}\n\nPath: ${artifact.path}\n\n---\n\n${artifact.text}`,
						display: true,
						details: artifact,
					});
				},
				(event) => {
					updateDashboardState(dashboard, event);
					observatoryRefresh?.();
					if (ctx.hasUI) installDashboardWidget(ctx, dashboard);
				},
			);
			pi.sendMessage({ customType: "pi-workshop", content: result.summary, display: true, details: result });
		} catch (error) {
			pi.sendMessage({ customType: "pi-workshop", content: `# Workshop failed\n\n${String((error as Error)?.stack ?? error)}`, display: true, details: { error: String((error as Error)?.message ?? error) } });
		} finally {
			if (activeWorkshop?.controller === controller) activeWorkshop = undefined;
			ctx.ui.setStatus("pi-workshop", undefined);
			if (!keepDashboard) ctx.ui.setWidget("pi-workshop-dashboard", undefined);
		}
	};

	pi.registerCommand("workshop-config", {
		description: "Show resolved pi-workshop config. Usage: /workshop-config [--profile workshop] [--check]",
		handler: async (args, ctx) => {
			let parsed: ParsedWorkshopCommand;
			try {
				parsed = parseWorkshopCommand(args);
			} catch (error) {
				const message = `Workshop config flag error: ${String((error as Error)?.message ?? error)}`;
				ctx.ui.notify(message, "error");
				pi.sendMessage({ customType: "pi-workshop", content: `# ${message}`, display: true, details: { error: message } });
				return;
			}
			const { check: _check, ...configPreviewParams } = parsed;
			let resolved: ResolvedWorkshopConfig;
			try {
				resolved = await resolveWorkshopConfig(ctx.cwd, { ...configPreviewParams, idea: "config preview" });
			} catch (error) {
				const message = `Workshop config error: ${String((error as Error)?.message ?? error)}`;
				pi.sendMessage({ customType: "pi-workshop", content: `# ${message}`, display: true, details: { error: message } });
				return;
			}
			const content = [
				parsed.check ? "# Pi workshop config check" : "# Pi workshop config",
				"",
				parsed.check ? "Config validation: **ok**" : "",
				`Config files: ${resolved.configPaths.length ? resolved.configPaths.join(", ") : "built-in defaults only"}`,
				`Profile: ${resolved.profile ?? "none"}`,
				"",
				"## Resolved params",
				"```json",
				JSON.stringify(resolved.params, null, 2),
				"```",
				"",
				"## Limits",
				"```json",
				JSON.stringify(resolved.limits, null, 2),
				"```",
				"",
				"Config locations checked:",
				`- ${path.join(os.homedir(), ".pi", "agent", "pi-workshop.config.json")}`,
				`- nearest project .pi/pi-workshop.config.json from ${ctx.cwd}`,
			].join("\n");
			pi.sendMessage({ customType: "pi-workshop", content, display: true, details: resolved });
		},
	});

	pi.registerCommand("workshop", {
		description:
			"Run a recursive expert workshop. Usage: /workshop [--profile workshop] [--rounds 4] [--web-research] [--local-bash] [--subagents] [--expert-subagents] [--prototype] [--html-report] [--fixed-experts] <idea>",
		handler: async (args, ctx) => runWorkshopCommand(args, ctx),
	});

	pi.registerCommand("workshop-cancel", {
		description: "Cancel the active /workshop run and write CANCELLED artifacts",
		handler: async (_args, ctx) => {
			if (!activeWorkshop) {
				ctx.ui.notify("No active workshop run to cancel", "warning");
				return;
			}
			activeWorkshop.controller.abort();
			ctx.ui.notify(`Cancelling workshop: ${activeWorkshop.label}`, "warning");
		},
	});

	pi.registerCommand("workshop-doctor", {
		description: "Preflight pi-workshop tools, models, config, and artifact permissions. Usage: /workshop-doctor [same flags as /workshop]",
		handler: async (args, ctx) => {
			let parsed: ParsedWorkshopCommand;
			try { parsed = parseWorkshopCommand(args); }
			catch (error) {
				const message = `Workshop doctor flag error: ${String((error as Error)?.message ?? error)}`;
				ctx.ui.notify(message, "error");
				pi.sendMessage({ customType: "pi-workshop", content: `# ${message}`, display: true, details: { error: message } });
				return;
			}
			try {
				const report = await preflightWorkshop(pi, ctx, { ...parsed, idea: parsed.idea || "doctor" });
				pi.sendMessage({ customType: "pi-workshop", content: report.content, display: true, details: report });
			} catch (error) {
				const message = `Workshop doctor error: ${String((error as Error)?.message ?? error)}`;
				pi.sendMessage({ customType: "pi-workshop", content: `# ${message}`, display: true, details: { error: message } });
			}
		},
	});

	pi.registerCommand("workshop-hide", {
		description: "Hide the persistent workshop observatory widget",
		handler: async (_args, ctx) => {
			ctx.ui.setWidget("pi-workshop-dashboard", undefined);
			ctx.ui.notify("Workshop observatory hidden", "info");
		},
	});

	pi.registerCommand("workshop-observatory", {
		description: "Open a navigable inspector for the active/latest workshop: experts, subagents, tool events, and downloaded files",
		handler: async (_args, ctx) => openWorkshopObservatory(ctx, latestDashboard, (requestRender) => { observatoryRefresh = requestRender; }),
	});

	pi.registerShortcut(Key.ctrlAlt("w"), {
		description: "Open workshop observatory navigator",
		handler: async (ctx) => openWorkshopObservatory(ctx, latestDashboard, (requestRender) => { observatoryRefresh = requestRender; }),
	});

	pi.registerCommand("workshop-sessions", {
		description: "Pick a previous workshop session and show its saved resolution",
		handler: async (_args, ctx) => {
			const sessions = await listWorkshopSessions(ctx.cwd);
			if (sessions.length === 0) {
				ctx.ui.notify("No previous .pi/workshops sessions found", "warning");
				return;
			}
			const chosen = ctx.hasUI
				? await ctx.ui.select("Previous workshop sessions", sessions.map((s) => s.label))
				: sessions[0].label;
			const session = sessions.find((s) => s.label === chosen);
			if (!session) return;
			const resolutionPath = path.join(session.dir, "resolution.md");
			const resolution = await fs.readFile(resolutionPath, "utf8").catch(() => "(could not read resolution.md)");
			pi.sendMessage({
				customType: "pi-workshop",
				content: `# Previous workshop session\n\nPath: ${session.dir}\n\n---\n\n${resolution}`,
				display: true,
				details: { dir: session.dir, resolutionPath },
			});
		},
	});

	pi.registerCommand("workshop-pickup", {
		description:
			"Continue from a previous workshop session. Usage: /workshop-pickup [--rounds 2] [--web-research] [optional session-dir or instructions]",
		handler: async (args, ctx) => {
			let parsed: ParsedWorkshopCommand;
			try { parsed = parseWorkshopCommand(args); }
			catch (error) {
				const message = `Workshop pickup flag error: ${String((error as Error)?.message ?? error)}`;
				ctx.ui.notify(message, "error");
				pi.sendMessage({ customType: "pi-workshop", content: `# ${message}`, display: true, details: { error: message } });
				return;
			}
			let targetDir: string | undefined;
			let extraInstructions = parsed.idea;
			if (parsed.idea) {
				const candidate = resolveMaybe(ctx.cwd, parsed.idea);
				if (fssync.existsSync(path.join(candidate, "resolution.md"))) {
					targetDir = candidate;
					extraInstructions = "";
				}
			}
			if (!targetDir) {
				const sessions = await listWorkshopSessions(ctx.cwd);
				if (sessions.length === 0) {
					ctx.ui.notify("No previous .pi/workshops sessions found", "warning");
					return;
				}
				const chosen = ctx.hasUI
					? await ctx.ui.select("Pick session to continue", sessions.map((s) => s.label))
					: sessions[0].label;
				const session = sessions.find((s) => s.label === chosen);
				if (!session) return;
				targetDir = session.dir;
			}

			const resolutionPath = path.join(targetDir, "resolution.md");
			const transcriptPath = path.join(targetDir, "transcript.md");
			const previousResolution = await fs.readFile(resolutionPath, "utf8");
			if (ctx.hasUI) {
				const edited = await ctx.ui.editor(
					"Continue previous workshop session",
					`${extraInstructions || "Answer open questions, tighten scope, or ask for next-round critique."}\n\nPrevious session:\n${targetDir}`,
				);
				extraInstructions = edited?.trim() ?? extraInstructions;
			}

			const idea = `Continue this previous workshop ideation session.\n\nPrevious session dir: ${targetDir}\nPrevious resolution:\n\n${previousResolution}\n\nUser continuation instructions:\n${extraInstructions || "Continue from remaining open questions and produce a sharper next resolution."}`;
			const pickupParams = {
				...parsed,
				idea,
				interactive: true,
				contextPaths: [resolutionPath, transcriptPath].filter((p) => fssync.existsSync(p)),
			};
			let preflight;
			let resolvedForUi;
			try {
				preflight = await preflightWorkshop(pi, ctx, pickupParams);
				resolvedForUi = await resolveWorkshopConfig(ctx.cwd, pickupParams);
			} catch (error) {
				const message = `Workshop pickup preflight/config error: ${String((error as Error)?.message ?? error)}`;
				pi.sendMessage({ customType: "pi-workshop", content: `# ${message}`, display: true, details: { error: message } });
				return;
			}
			if (!preflight.ok) {
				pi.sendMessage({ customType: "pi-workshop", content: `${preflight.content}\n\n/workshop-pickup blocked by critical preflight failures.`, display: true, details: preflight });
				return;
			}
			const keepDashboard = Boolean(resolvedForUi.params.keepDashboard);
			const dashboard = createDashboardState();
			latestDashboard = dashboard;
			if (ctx.hasUI) installDashboardWidget(ctx, dashboard);
			if (ctx.hasUI && resolvedForUi.params.openObservatory) launchWorkshopObservatory(ctx, dashboard, (requestRender) => { observatoryRefresh = requestRender; });
			ctx.ui.setStatus("pi-workshop", "picking up previous session...");
			const controller = new AbortController();
			activeWorkshop = { controller, startedAt: Date.now(), label: `pickup ${path.basename(targetDir)}` };
			try {
				const result = await runWorkshop(
					pi,
					pickupParams,
					ctx,
					controller.signal,
					(text) => ctx.ui.setStatus("pi-workshop", text),
					(artifact) => {
						const title = artifact.kind === "critique" ? `# Round ${artifact.round}: ${artifact.name} critique` : `# Round ${artifact.round}: synthesis`;
						pi.sendMessage({
							customType: "pi-workshop",
							content: `${title}\n\nPath: ${artifact.path}\n\n---\n\n${artifact.text}`,
							display: true,
							details: artifact,
						});
					},
					(event) => {
						updateDashboardState(dashboard, event);
						observatoryRefresh?.();
						if (ctx.hasUI) installDashboardWidget(ctx, dashboard);
					},
				);
				pi.sendMessage({ customType: "pi-workshop", content: result.summary, display: true, details: result });
			} catch (error) {
				pi.sendMessage({ customType: "pi-workshop", content: `# Workshop pickup failed\n\n${String((error as Error)?.stack ?? error)}`, display: true, details: { error: String((error as Error)?.message ?? error) } });
			} finally {
				if (activeWorkshop?.controller === controller) activeWorkshop = undefined;
				ctx.ui.setStatus("pi-workshop", undefined);
				if (!keepDashboard) ctx.ui.setWidget("pi-workshop-dashboard", undefined);
			}
		},
	});
}
