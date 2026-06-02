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
import { resolveWorkshopConfig, definedOnly, type ResolvedWorkshopConfig } from "./config.ts";
import { safeSegment, expertArtifactSegment, assertUniqueExpertNamesForArtifacts, parsePlannedExperts, selectRequestedProfile } from "./logic.js";
import { SCRATCH_POLICY_FILE, MANIFEST_FILE, writeFileQueued, listFilesRecursive, writeScratchPolicy, readScratchPolicy, revokeScratchPolicy, validateScratchNonce, ensureDirInsideNoSymlinks, writeScratchFileNoSymlink, writeRunManifest, type ScratchPolicy, type ScratchPolicyHandle } from "./artifacts.ts";

const EXTENSION_VERSION = "0.2.2-beta";
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

function assertInside(parent: string, child: string): void {
	const rel = path.relative(parent, child);
	if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`Path escapes allowed directory: ${child}`);
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

function redactSensitiveForAudit(value: unknown, depth = 0): unknown {
	if (value === undefined || value === null) return value;
	if (depth > 8) return "[redacted:depth-limit]";
	if (Array.isArray(value)) return value.map((item) => redactSensitiveForAudit(item, depth + 1));
	if (typeof value !== "object") return value;
	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		if (/^(nonce|token|api[-_]?key|authorization|password|secret)$/i.test(key) || /(nonce|token|secret|password|api[-_]?key)/i.test(key)) {
			out[key] = "[REDACTED]";
		} else {
			out[key] = redactSensitiveForAudit(child, depth + 1);
		}
	}
	return out;
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

async function createRunLocalFileAudit(_onFiles?: (files: ObservedFile[]) => void): Promise<{ files: ObservedFile[]; scan: (owner?: string, phase?: string, round?: number) => Promise<ObservedFile[]> }> {
	// Privacy first: do not scan home-directory locations.
	// Observable files are added from explicit child-run output paths and workshop artifacts only.
	return {
		files: [],
		scan: async (_owner?: string, _phase?: string, _round?: number) => [],
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
	noExtensions?: boolean;
	noSkills?: boolean;
	noContextFiles?: boolean;
	signal?: AbortSignal;
	timeoutMs?: number;
	phase?: string;
	round?: number;
	onProgress?: (text: string) => void;
	onActivity?: (text: string) => void;
}): Promise<ChildRun> {
	const args = ["--mode", "json", "-p", "--no-session"];
	if (options.noExtensions) args.push("--no-extensions");
	if (options.noSkills) args.push("--no-skills");
	if (options.noContextFiles) args.push("--no-context-files");
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
	noExtensions?: boolean;
	noSkills?: boolean;
	noContextFiles?: boolean;
	signal?: AbortSignal;
	timeoutMs?: number;
	phase?: string;
	round?: number;
	runDir: string;
	onProgress?: (text: string) => void;
	onActivity?: (text: string) => void;
	onToolEvent?: (event: ToolAuditEvent) => void;
}): Promise<ChildRun> {
	const safeName = expertArtifactSegment({ name: options.name });
	const systemTempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-workshop-system-"));
	const systemPath = path.join(systemTempDir, `${safeName}_${Date.now()}.md`);
	await fs.writeFile(systemPath, options.systemPrompt, { encoding: "utf8", mode: 0o600 });

	try {
	const args = ["--mode", "json", "-p", "--no-session"];
	if (options.noExtensions) args.push("--no-extensions");
	if (options.noSkills) args.push("--no-skills");
	if (options.noContextFiles) args.push("--no-context-files");
	args.push("--tools", options.tools ?? DEFAULT_TOOLS);
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
					argsPreview: previewUnknown(redactSensitiveForAudit(event.input ?? event.args ?? event.arguments ?? event.toolCall?.input ?? event.tool_call?.arguments)),
					resultPreview: previewUnknown(redactSensitiveForAudit(event.result ?? event.output ?? event.content ?? event.message?.content)),
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
	} finally {
		await fs.rm(systemTempDir, { recursive: true, force: true }).catch((error) => logWarn(`cleanup system prompt temp ${systemTempDir}`, error));
	}
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
- Never print, cite, copy, or save the scratch nonce. Treat it as a one-run capability secret; cite only generated artifact paths and command output.

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
${args.prototyping ? `- Enabled. Use ${PROTOTYPE_TOOL} with workshopDir=${args.workshopDir} and expertName=${args.expertName}. The per-expert nonce is provided only in your system prompt; do not print or save it. Cite generated artifact paths and key outputs only. This is artifact-contained only, not a security sandbox.` : "- Disabled."}

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
- Do not include privileged fields such as tools or model on experts or assistant briefs. Planner JSON containing tools/model or unknown fields will be rejected.

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

function assistantBriefSystemPrompt(agent: "scout" | "researcher"): string {
	const mode = agent === "researcher" ? "external evidence / web research" : "local codebase / context scouting";
	return `# Pi workshop restricted ${agent} brief runner

You are a junior ${mode} runner for pi-workshop. You are a direct child process, not a global pi-subagents /run agent. You must produce a concise evidence brief for a main expert.

Rules:
- Use only the tools explicitly granted to this child.
- Do not call /run or launch subagents.
- Do not edit, write, or mutate project files.
- Cite files, paths, commands/tool evidence, or URLs for claims.
- Gather facts and uncertainty; do not decide the workshop verdict.
- If needed tools are unavailable, say what evidence is missing and continue with available evidence.`;
}

function assistantBriefTools(agent: "scout" | "researcher", webResearch: boolean): string {
	return uniqueToolList([
		...DEFAULT_TOOLS.split(","),
		...(agent === "researcher" && webResearch ? WEB_RESEARCH_TOOLS.split(",") : []),
	]);
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
	onToolEvent?: (event: ToolAuditEvent) => void;
	onPanelEvent?: (event: PanelEvent) => void;
}): Promise<string> {
	const safeName = expertArtifactSegment(args.expert);
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
		const agent = brief.agent === "researcher" ? "researcher" : "scout";
		if (agent === "researcher" && !args.webResearch) {
			content += `\n\n## ${i + 1}. researcher subagent skipped\n\nResearch brief requested by planner, but webResearch was not enabled. Re-run with --web-research --subagents for web-backed research.\n\nTask:\n${brief.task}\n`;
			continue;
		}
		const model = brief.model ?? args.juniorModel;
		const task = `${brief.task}\n\nExpert receiving this brief: ${args.expert.name}\nExpert stance:\n${args.expert.stance}\n\nIdea file: ${args.ideaPath}\nWorking synthesis: ${args.workingPath}\nContext paths:\n${context}\n\nOutput a concise evidence brief. Do not decide the final verdict; the main expert owns judgment.`;
		const subagentId = `${args.round}:${args.expert.name}:${i + 1}:${agent}`;
		const startedAt = new Date().toISOString();
		args.onPanelEvent?.({
			type: "subagent_start",
			subagent: { id: subagentId, name: `${args.expert.name}-${agent}-brief`, expert: args.expert.name, agent, task: brief.task, round: args.round, phase: "assistant_brief", status: "running", startedAt, activity: ["queued direct restricted runner"] },
		});
		const run = await runChildPi({
			name: `${args.expert.name}-${agent}-brief`,
			systemPrompt: assistantBriefSystemPrompt(agent),
			userPrompt: task,
			cwd: args.baseCwd,
			model,
			tools: assistantBriefTools(agent, args.webResearch),
			noExtensions: agent === "scout",
			noSkills: true,
			noContextFiles: true,
			signal: args.signal,
			timeoutMs: args.childTimeoutMs,
			phase: "assistant_brief",
			round: args.round,
			runDir: args.workshopDir,
			onProgress: args.onUpdate,
			onActivity: (text) => args.onPanelEvent?.({ type: "subagent_activity", id: subagentId, text }),
			onToolEvent: args.onToolEvent,
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
		content += `\n\n## ${i + 1}. ${agent} brief (direct restricted runner)\n\nModel: ${model}\nTools: ${assistantBriefTools(agent, args.webResearch)}\nIsolation: ${agent === "scout" ? "--no-extensions --no-skills --no-context-files" : "--no-skills --no-context-files; web/search tools come from the trusted Pi installation"}\n\nTask:\n${brief.task}\n\nResult:\n${run.text}\n`;
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

type QuestionHelperMessage = { role: "user" | "assistant"; text: string };
type QuestionAnswerDialogResult = { answers: string[]; other: string };
type QuestionAnswerDialogState = {
	selected: number;
	answers: string[];
	other: string;
	mode: "answer" | "helper";
	helperInput: string;
	helperBusy: boolean;
	helperError?: string;
	helperChats: Map<number, QuestionHelperMessage[]>;
};

type AskUserForQuestionsArgs = {
	ctx: any;
	round: number;
	questions: string[];
	answersPath: string;
	idea: string;
	synthesisText: string;
	baseCwd: string;
	model: string;
	workshopDir: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	onToolEvent?: (event: ToolAuditEvent) => void;
};

function currentQuestionLabel(questions: string[], selected: number): string {
	return selected >= questions.length ? "Other / additional comments" : `Q${selected + 1}`;
}

function currentQuestionText(questions: string[], selected: number): string {
	return selected >= questions.length ? "Other / additional comments" : questions[selected] ?? "";
}

function currentQuestionAnswer(state: QuestionAnswerDialogState, questions: string[]): string {
	return state.selected >= questions.length ? state.other : state.answers[state.selected] ?? "";
}

function setQuestionAnswerAtIndex(state: QuestionAnswerDialogState, questions: string[], selected: number, answer: string): void {
	if (selected >= questions.length) state.other = answer;
	else state.answers[selected] = answer;
}

function setCurrentQuestionAnswer(state: QuestionAnswerDialogState, questions: string[], answer: string): void {
	setQuestionAnswerAtIndex(state, questions, state.selected, answer);
}

function anyQuestionAnswer(state: QuestionAnswerDialogState): boolean {
	return state.answers.some((answer) => answer.trim()) || Boolean(state.other.trim());
}

function previousCodepoint(text: string): string {
	return Array.from(text).slice(0, -1).join("");
}

function printableInput(data: string): string {
	if (!data || data.startsWith("\x1b")) return "";
	return data.replace(/\r/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

function questionHelperSystemPrompt(): string {
	return `# Workshop question clarification helper

You are a small helper agent embedded in pi-workshop's user-question interface. Your job is to help the human understand a workshop blocking question and convert the human's clarification into a concise authoritative answer.

Rules:
- Use the supplied current synthesis/resolution context as the primary source for why the question is being asked.
- Do not invent product decisions for the user.
- If chatting, explain what decision/evidence would unblock the workshop and ask focused follow-up questions only when necessary.
- If asked to summarize/inject, return only the answer text to place in user-answers.md; no markdown heading, no preamble.`;
}

function questionHelperTranscript(messages: QuestionHelperMessage[]): string {
	return messages.map((message) => `${message.role === "user" ? "User" : "Helper"}: ${message.text}`).join("\n\n") || "(no clarification chat yet)";
}

async function runQuestionHelper(args: AskUserForQuestionsArgs, selected: number, messages: QuestionHelperMessage[], userMessage: string, mode: "chat" | "summary"): Promise<string> {
	const targetQuestion = currentQuestionText(args.questions, selected);
	const existingAnswers = args.questions
		.map((question, index) => `Q${index + 1}: ${question}`)
		.join("\n");
	const task = mode === "summary"
		? "Summarize the clarification chat as the concise authoritative answer to inject for the target question. Return only that answer text."
		: "Answer the user's latest clarification request. Help them understand what the workshop needs and why this question matters.";
	const userPrompt = `${task}

Original workshop idea:
${args.idea}

Current synthesis / resolution context:
<synthesis>
${args.synthesisText.slice(0, 24_000)}
</synthesis>

Open questions from the synthesizer:
${existingAnswers}

Target question (${currentQuestionLabel(args.questions, selected)}):
${targetQuestion}

Clarification chat so far:
${questionHelperTranscript(messages)}

Latest user message:
${userMessage}`;
	const run = await runChildPi({
		name: `question-helper-r${args.round}-${currentQuestionLabel(args.questions, selected).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
		systemPrompt: questionHelperSystemPrompt(),
		userPrompt,
		cwd: args.baseCwd,
		model: args.model,
		tools: DEFAULT_TOOLS,
		noSkills: true,
		noContextFiles: true,
		signal: args.signal,
		timeoutMs: args.timeoutMs,
		phase: "question_helper",
		round: args.round,
		runDir: args.workshopDir,
		onToolEvent: args.onToolEvent,
	});
	if (run.exitCode !== 0 || run.timedOut || run.aborted) {
		throw new Error(run.text.trim() || run.stderr.trim() || `question helper exited ${run.exitCode}`);
	}
	return run.text.trim();
}

function wrapPlainLines(text: string, width: number): string[] {
	return text.split("\n").flatMap((line) => wrapTextWithAnsi(line || " ", Math.max(8, width)));
}

function renderQuestionList(questions: string[], state: QuestionAnswerDialogState, height: number, width: number, theme: any): string[] {
	const rows: string[] = [];
	const total = questions.length + 1;
	state.selected = clampIndex(state.selected, total);
	const start = Math.max(0, Math.min(state.selected - Math.floor(height / 2), Math.max(0, total - height)));
	for (let offset = 0; offset < Math.min(total, height); offset++) {
		const i = start + offset;
		const selected = i === state.selected;
		const label = currentQuestionLabel(questions, i);
		const text = currentQuestionText(questions, i);
		const answer = i >= questions.length ? state.other : state.answers[i] ?? "";
		const status = answer.trim() ? theme.fg("success", "✓") : theme.fg("muted", "○");
		const prefix = selected ? theme.fg("accent", "› ") : "  ";
		const line = prefix + status + " " + theme.fg(selected ? "accent" : "muted", `${label}: `) + truncateToWidth(text, Math.max(8, width - 8), "…");
		rows.push(selected ? theme.bg("selectedBg", padAnsi(line, width)) : truncateToWidth(line, width, "…"));
	}
	return rows;
}

function renderAnswerPane(questions: string[], state: QuestionAnswerDialogState, height: number, width: number, theme: any): string[] {
	const question = currentQuestionText(questions, state.selected);
	const answer = currentQuestionAnswer(state, questions);
	const rows: string[] = [];
	rows.push(theme.fg("accent", theme.bold(currentQuestionLabel(questions, state.selected))) + theme.fg("muted", " — answer directly, or Tab for helper chat"));
	rows.push(...wrapPlainLines(question, width).slice(0, 4).map((line) => theme.fg("text", line)));
	rows.push(theme.fg("borderMuted", "─".repeat(Math.max(0, width))));
	rows.push(theme.fg("muted", "Answer"));
	const answerWithCursor = answer
		? `${answer}${theme.fg("accent", "▌")}`
		: `${theme.fg("dim", "Start typing your answer…")}${theme.fg("accent", "▌")}`;
	rows.push(...wrapPlainLines(answerWithCursor, width));
	return rows.slice(0, height);
}

function renderHelperPane(questions: string[], state: QuestionAnswerDialogState, height: number, width: number, theme: any): string[] {
	const messages = state.helperChats.get(state.selected) ?? [];
	const rows: string[] = [];
	rows.push(theme.fg("accent", theme.bold(`Helper chat for ${currentQuestionLabel(questions, state.selected)}`)) + theme.fg("muted", "  Tab/Ctrl+S inject summary • Esc back"));
	rows.push(...wrapPlainLines(currentQuestionText(questions, state.selected), width).slice(0, 3));
	rows.push(theme.fg("borderMuted", "─".repeat(Math.max(0, width))));
	for (const message of messages.slice(-8)) {
		const speaker = message.role === "user" ? theme.fg("accent", "You") : theme.fg("success", "Helper");
		rows.push(`${speaker}:`);
		rows.push(...wrapPlainLines(message.text, width).slice(0, 8).map((line) => `  ${line}`));
	}
	if (state.helperBusy) rows.push(theme.fg("warning", "● helper agent thinking…"));
	if (state.helperError) rows.push(theme.fg("error", `Helper error: ${state.helperError}`));
	rows.push(theme.fg("borderMuted", "─".repeat(Math.max(0, width))));
	const input = state.helperInput
		? `${state.helperInput}${theme.fg("accent", "▌")}`
		: `${theme.fg("dim", "Ask what this question means, or what answer would unblock it…")}${theme.fg("accent", "▌")}`;
	rows.push(theme.fg("muted", "Message") + " " + input);
	return rows.slice(Math.max(0, rows.length - height));
}

function renderQuestionAnswerDialog(questions: string[], state: QuestionAnswerDialogState, round: number, theme: any, width: number, height: number): string[] {
	if (width <= 0 || height <= 0) return [];
	const w = width;
	const h = Math.max(1, height);
	const inner = Math.max(0, w - 2);
	const lines: string[] = [];
	lines.push(frameRule(theme.fg("accent", ` ✦ ${theme.bold("Workshop Q&A")} `), theme.fg("muted", ` round ${round} `), w, theme, { leftCorner: "╭", rightCorner: "╮", color: "borderAccent" }));
	lines.push(frameContent(theme.fg("muted", "Type answers directly • Enter next/save • Tab helper agent • Ctrl+S save • Esc skip/back"), w, theme));
	const bodyRows = Math.max(0, h - 4);
	if (state.mode === "helper") {
		const helperRows = renderHelperPane(questions, state, bodyRows, inner, theme);
		for (let i = 0; i < bodyRows; i++) lines.push(frameContent(helperRows[i] ?? "", w, theme));
	} else if (w >= 96) {
		const leftW = Math.min(56, Math.max(34, Math.floor((inner - 1) * 0.38)));
		const rightW = Math.max(0, inner - leftW - 1);
		lines.push(splitRule(w, leftW, rightW, theme));
		const remaining = Math.max(0, h - lines.length - 1);
		const listRows = renderQuestionList(questions, state, remaining, leftW, theme);
		const answerRows = renderAnswerPane(questions, state, remaining, rightW, theme);
		for (let i = 0; i < remaining; i++) lines.push(splitContent(listRows[i] ?? "", answerRows[i] ?? "", leftW, rightW, theme));
	} else {
		const answerRows = renderAnswerPane(questions, state, bodyRows, inner, theme);
		for (let i = 0; i < bodyRows; i++) lines.push(frameContent(answerRows[i] ?? "", w, theme));
	}
	const bottom = frameRule(theme.fg("muted", ` ${questions.length} question${questions.length === 1 ? "" : "s"} `), theme.fg(anyQuestionAnswer(state) ? "success" : "dim", anyQuestionAnswer(state) ? " answers ready " : " no answers yet "), w, theme, { leftCorner: "╰", rightCorner: "╯", color: "borderAccent" });
	if (lines.length >= h) return [...lines.slice(0, h - 1), bottom].map((line) => truncateToWidth(line, w, ""));
	while (lines.length < h - 1) lines.push(frameContent("", w, theme));
	lines.push(bottom);
	return lines.map((line) => truncateToWidth(line, w, ""));
}

async function askUserForQuestions(args: AskUserForQuestionsArgs): Promise<boolean> {
	const { ctx, round, questions, answersPath } = args;
	if (!ctx.hasUI || questions.length === 0) return false;
	const result = await ctx.ui.custom<QuestionAnswerDialogResult | null>((tui: any, theme: any, _keybindings: any, done: (result: QuestionAnswerDialogResult | null) => void) => {
		let closed = false;
		const requestRender = () => { if (!closed) tui.requestRender(); };
		const state: QuestionAnswerDialogState = {
			selected: 0,
			answers: questions.map(() => ""),
			other: "",
			mode: "answer",
			helperInput: "",
			helperBusy: false,
			helperChats: new Map(),
		};
		const finish = (value: QuestionAnswerDialogResult | null) => { closed = true; done(value); };
		const moveNextOrFinish = () => {
			if (state.selected < questions.length) {
				const nextUnanswered = state.answers.findIndex((answer, index) => index > state.selected && !answer.trim());
				if (nextUnanswered >= 0) state.selected = nextUnanswered;
				else if (state.selected < questions.length - 1) state.selected += 1;
				else if (anyQuestionAnswer(state)) finish({ answers: [...state.answers], other: state.other });
			} else if (anyQuestionAnswer(state)) finish({ answers: [...state.answers], other: state.other });
		};
		const appendAnswerInput = (text: string) => {
			const current = currentQuestionAnswer(state, questions);
			setCurrentQuestionAnswer(state, questions, current + text);
		};
		const sendHelperMessage = async (text: string, auto = false) => {
			if (state.helperBusy || !text.trim()) return;
			const selected = state.selected;
			state.helperBusy = true;
			state.helperError = undefined;
			const messages = [...(state.helperChats.get(selected) ?? [])];
			messages.push({ role: "user", text: text.trim() });
			state.helperChats.set(selected, messages);
			if (!auto) state.helperInput = "";
			requestRender();
			try {
				const reply = await runQuestionHelper(args, selected, messages, text.trim(), "chat");
				state.helperChats.set(selected, [...messages, { role: "assistant", text: reply }]);
			} catch (error) {
				state.helperError = String((error as Error)?.message ?? error);
			} finally {
				state.helperBusy = false;
				requestRender();
			}
		};
		const openHelper = () => {
			state.mode = "helper";
			state.helperInput = "";
			state.helperError = undefined;
			if (!(state.helperChats.get(state.selected)?.length)) {
				void sendHelperMessage("Help me understand why the workshop is asking this question and what kind of answer would unblock the next round.", true);
			}
		};
		const summarizeHelper = async () => {
			const selected = state.selected;
			const messages = state.helperChats.get(selected) ?? [];
			if (state.helperBusy || !messages.length) return;
			state.helperBusy = true;
			state.helperError = undefined;
			requestRender();
			try {
				const summary = await runQuestionHelper(args, selected, messages, "Summarize this clarification chat as my authoritative answer to the target question.", "summary");
				setQuestionAnswerAtIndex(state, questions, selected, summary);
				if (state.selected === selected) state.mode = "answer";
			} catch (error) {
				state.helperError = String((error as Error)?.message ?? error);
			} finally {
				state.helperBusy = false;
				requestRender();
			}
		};
		return {
			render: (width: number) => renderQuestionAnswerDialog(questions, state, round, theme, width, Number(tui?.terminal?.rows ?? 24)),
			invalidate: () => {},
			dispose: () => { closed = true; },
			handleInput: (data: string) => {
				if (state.mode === "helper") {
					if (matchesKey(data, Key.escape)) { state.mode = "answer"; requestRender(); return; }
					if (matchesKey(data, Key.tab) || matchesKey(data, Key.ctrl("s"))) { void summarizeHelper(); return; }
					if (matchesKey(data, Key.enter)) { void sendHelperMessage(state.helperInput); return; }
					if (matchesKey(data, Key.backspace)) state.helperInput = previousCodepoint(state.helperInput);
					else if (matchesKey(data, Key.ctrl("u"))) state.helperInput = "";
					else state.helperInput += printableInput(data);
					requestRender();
					return;
				}
				if (matchesKey(data, Key.escape)) { finish(null); return; }
				if (matchesKey(data, Key.ctrl("s"))) { finish(anyQuestionAnswer(state) ? { answers: [...state.answers], other: state.other } : null); return; }
				if (matchesKey(data, Key.tab)) { openHelper(); requestRender(); return; }
				if (matchesKey(data, Key.up)) { state.selected = Math.max(0, state.selected - 1); requestRender(); return; }
				if (matchesKey(data, Key.down)) { state.selected = Math.min(questions.length, state.selected + 1); requestRender(); return; }
				if (matchesKey(data, Key.shift("enter"))) { appendAnswerInput("\n"); requestRender(); return; }
				if (matchesKey(data, Key.enter)) { moveNextOrFinish(); requestRender(); return; }
				if (matchesKey(data, Key.backspace)) { setCurrentQuestionAnswer(state, questions, previousCodepoint(currentQuestionAnswer(state, questions))); requestRender(); return; }
				if (matchesKey(data, Key.ctrl("u"))) { setCurrentQuestionAnswer(state, questions, ""); requestRender(); return; }
				const text = printableInput(data);
				if (text) { appendAnswerInput(text); requestRender(); }
			},
		};
	}, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 } });
	if (!result) return false;
	const answers = result.answers
		.map((answer, index) => answer.trim() ? `### Q${index + 1}: ${questions[index]}\n\n${answer.trim()}` : undefined)
		.filter((entry): entry is string => Boolean(entry));
	if (result.other.trim()) answers.push(`### Other / additional comments\n\n${result.other.trim()}`);
	if (!answers.length) return false;
	await writeFileQueued(answersPath, `${await fs.readFile(answersPath, "utf8").catch(() => "")}\n\n## Round ${round} user answers\n\n${answers.join("\n\n")}\n`);
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
	const runLocalFileAudit = await createRunLocalFileAudit((files) => onPanelEvent?.({ type: "download_detected", files }));
	const scanRunLocalFiles = (owner?: string, phase?: string, round?: number) => runLocalFileAudit.scan(owner, phase, round).catch(() => []);
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
		void scanRunLocalFiles(run.name, run.phase, run.round);
		if (run.exitCode !== 0 || run.timedOut || run.aborted) {
			degraded = true;
			errors.push(`${run.phase ?? "child"}:${run.name} exited ${run.exitCode}${run.timedOut ? " (timeout)" : ""}${run.aborted ? " (aborted)" : ""}`);
		}
	};
	const emitToolEvent = (event: ToolAuditEvent) => {
		onPanelEvent?.({ type: "tool_event", event });
		void scanRunLocalFiles(event.child, event.phase, event.round);
	};
	const modelResolution = resolveWorkshopModels(ctx, params);
	if (!modelResolution.strongModel) throw new Error(missingStrongModelGuidance());
	const strongModel = modelResolution.strongModel;
	const plannerModel = modelResolution.plannerModel ?? strongModel;
	const expertModel = modelResolution.expertModel ?? strongModel;
	const synthModel = modelResolution.synthModel ?? strongModel;
	const juniorModel = modelResolution.juniorModel ?? strongModel;
	const contextPaths = (params.contextPaths ?? []).map((p) => resolveMaybe(baseCwd, p));
	const workshopDir = params.outputDir
		? resolveMaybe(baseCwd, params.outputDir)
		: path.join(baseCwd, ".pi", "workshops", `${timestampSlug()}-${slugify(params.idea)}`);
	await fs.mkdir(workshopDir, { recursive: true });
	const realBaseCwd = await fs.realpath(baseCwd);
	const realWorkshopDir = await fs.realpath(workshopDir);
	try {
		assertInside(realBaseCwd, realWorkshopDir);
	} catch {
		throw new Error(`Workshop outputDir must resolve inside the current cwd for public/beta runs: ${workshopDir}`);
	}
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

	let scratchPolicyHandle: ScratchPolicyHandle | undefined;
	let scratchPolicyForManifest: ScratchPolicy | undefined;
	let scratchPolicyRevoked = false;
	const revokeScratchPolicyForRun = async () => {
		if (!scratchPolicyForManifest || scratchPolicyRevoked) return;
		try {
			const revoked = await revokeScratchPolicy(workshopDir);
			scratchPolicyForManifest = revoked ?? { ...scratchPolicyForManifest, status: "revoked" as const, revokedAt: new Date().toISOString() };
			scratchPolicyRevoked = true;
		} catch (error) {
			const message = `Failed to revoke scratch policy ${workshopDir}: ${String((error as Error)?.message ?? error)}`;
			logWarn("revoke scratch policy", error);
			if (!errors.includes(message)) errors.push(message);
		}
	};

	try {
	const allRoundFiles: string[] = [];
	let experts: ExpertInput[] = params.experts?.length ? params.experts : DEFAULT_EXPERTS;
	if (params.experts?.length) assertUniqueExpertNamesForArtifacts(params.experts, "User-supplied expert");
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
			tools: defaultToolsFor({ webResearch: webResearchEnabled, localBash: false }),
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
		const planned = parsePlannedExperts(planner.text) as ExpertInput[] | null;
		if (planned) experts = planned;
		else {
			degraded = true;
			errors.push("Planner returned invalid or rejected expert JSON; falling back to fixed experts.");
		}
		onPanelEvent?.({ type: "planner_done", experts: experts.map((e) => e.name), path: planPath });
	}
	assertUniqueExpertNamesForArtifacts(experts.slice(0, 4), params.experts?.length ? "User-supplied expert" : "Workshop expert");
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
	scratchPolicyHandle = prototypingEnabled ? await writeScratchPolicy(workshopDir, experts, resolvedConfig.limits.globalTimeoutSeconds) : undefined;
	scratchPolicyForManifest = scratchPolicyHandle?.policy;
	const scratchNonceForExpert = (expert: Pick<ExpertInput, "name">) => scratchPolicyHandle?.noncesByExpert[expertArtifactSegment(expert)];
	const mainExpertsCanUseSubagents = experts.some((expert) => toolListIncludes(expert.tools, "subagent"));
	const subagentWorkflow = [
		`Config files: ${resolvedConfig.configPaths.length ? resolvedConfig.configPaths.join(", ") : "built-in defaults only"}`,
		`Profile: ${resolvedConfig.profile ?? "none"}`,
		`Scratch timeout: ${resolvedConfig.limits.scratchTimeoutSeconds}s default, ${resolvedConfig.limits.maxScratchTimeoutSeconds}s max before approval/escalation`,
		`Child timeout: ${resolvedConfig.limits.childTimeoutSeconds}s; global timeout: ${resolvedConfig.limits.globalTimeoutSeconds}s`,
		`Web research tools: ${webResearchEnabled ? "enabled" : "disabled"}`,
		`Local bash tools: ${localBashEnabled ? "enabled for main experts only" : "disabled"}`,
		`Workshop mode (--workshop): ${workshop ? "enabled" : "disabled"}`,
		`Parent-orchestrated assistant briefs (--subagents): ${parentBriefsEnabled ? "enabled via direct restricted child runners" : "disabled"}`,
		`Main expert direct subagent tool: ${mainExpertsCanUseSubagents ? "enabled" : "disabled"}`,
		`Scratch/prototype tool (${PROTOTYPE_TOOL}): ${prototypingEnabled ? "enabled" : "disabled"}`,
		`HTML report: ${htmlReportEnabled ? "enabled" : "disabled"}`,
		parentBriefsEnabled
			? "Before each expert critique, the parent runs direct restricted scout/researcher child runners and passes brief files to experts. No global /run scout|researcher agents or subagent tool are used for safe/public briefs."
			: "No parent-run junior briefs will be created unless --subagents/subagents=true is used.",
		parentBriefsEnabled
			? "Brief runner isolation: scout uses --no-extensions --no-skills --no-context-files with read/grep/find/ls only; researcher uses --no-skills --no-context-files plus read/grep/find/ls and configured web/search tools when web research is enabled."
			: "Brief runner isolation: n/a.",
		mainExpertsCanUseSubagents
			? "If an expert calls subagent directly, dashboard activity will show 'MAIN EXPERT called subagent tool' when JSON tool events expose it."
			: "In the default slash workflow, main experts cannot call subagents; use --expert-subagents/--workshop or explicit expert.tools='...,subagent' to allow that.",
		prototypingEnabled
			? `Experts can run throwaway experiments through ${PROTOTYPE_TOOL}; artifacts are under scratch/<expert>/ and included in report.html. Scratch calls require a per-expert run nonce; policy is revoked at run end. Scratch is artifact-contained, not sandboxed.`
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
						onToolEvent: emitToolEvent,
						onPanelEvent,
					});
					assistantBriefs.set(expert.name, [briefPath]);
					allRoundFiles.push(briefPath);
					onPanelEvent?.({ type: "brief_done", round, name: expert.name, path: briefPath });
				} catch (error) {
					degraded = true;
					errors.push(`Assistant brief failed for ${expert.name}: ${String((error as Error)?.message ?? error)}`);
					const safeName = expertArtifactSegment(expert);
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
					.map((e) => path.join(workshopDir, `round_${round - 1}_${expertArtifactSegment(e)}.md`))
					.filter((p) => fssync.existsSync(p))
				: [];

		if (round === 1) {
			await Promise.all(
				experts.map(async (expert) => {
					const out = path.join(workshopDir, `round_${round}_${expertArtifactSegment(expert)}.md`);
					onPanelEvent?.({ type: "expert_start", round, name: expert.name });
					const scratchNonce = scratchNonceForExpert(expert);
					const run = await runChildPi({
						name: expert.name,
						systemPrompt: expertSystemPrompt(expert, intensity, expert.tools ?? DEFAULT_TOOLS, parentBriefsEnabled, prototypingEnabled, workshopDir, scratchNonce),
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
				const out = path.join(workshopDir, `round_${round}_${expertArtifactSegment(expert)}.md`);
				onPanelEvent?.({ type: "expert_start", round, name: expert.name });
				const scratchNonce = scratchNonceForExpert(expert);
				const run = await runChildPi({
					name: expert.name,
					systemPrompt: expertSystemPrompt(expert, intensity, expert.tools ?? DEFAULT_TOOLS, parentBriefsEnabled, prototypingEnabled, workshopDir, scratchNonce),
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
			tools: defaultToolsFor({ webResearch: webResearchEnabled, localBash: false }),
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
				userAnswered = await askUserForQuestions({
					ctx,
					round,
					questions,
					answersPath,
					idea: params.idea,
					synthesisText: synth.text,
					baseCwd,
					model: juniorModel,
					workshopDir,
					signal: runSignal,
					timeoutMs: childTimeoutMs,
					onToolEvent: emitToolEvent,
				});
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
	await scanRunLocalFiles("workshop", "final", roundsRun);
	await revokeScratchPolicyForRun();
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
		observedFiles: runLocalFileAudit.files,
		errors,
		scratchPolicy: scratchPolicyForManifest ? { path: SCRATCH_POLICY_FILE, status: scratchPolicyForManifest.status, allowedExperts: scratchPolicyForManifest.allowedExperts.map((expert) => expert.name), expiresAt: scratchPolicyForManifest.expiresAt, revokedAt: scratchPolicyForManifest.revokedAt ?? null, artifactContainedNotSandboxed: true } : undefined,
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
	} finally {
		await revokeScratchPolicyForRun();
		signal?.removeEventListener("abort", onExternalAbort);
		stopGlobalTimer();
	}
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
	if (width <= 0) return "";
	const truncated = truncateToWidth(text, width, "…");
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function frameRule(
	left: string,
	right: string,
	width: number,
	theme: any,
	options: { leftCorner?: string; rightCorner?: string; fill?: string; color?: "accent" | "success" | "warning" | "muted" | "border" | "borderAccent" | "borderMuted" } = {},
): string {
	if (width <= 0) return "";
	const color = options.color ?? "borderAccent";
	const border = (text: string) => theme.fg(color, text);
	if (width === 1) return border(options.fill ?? "─");
	const inner = Math.max(0, width - 2);
	let leftText = truncateToWidth(left, inner, "");
	let rightText = truncateToWidth(right, Math.max(0, inner - visibleWidth(leftText)), "");
	while (visibleWidth(leftText) + visibleWidth(rightText) > inner && visibleWidth(rightText) > 0) {
		rightText = truncateToWidth(rightText, visibleWidth(rightText) - 1, "");
	}
	while (visibleWidth(leftText) + visibleWidth(rightText) > inner && visibleWidth(leftText) > 0) {
		leftText = truncateToWidth(leftText, visibleWidth(leftText) - 1, "");
	}
	const fill = options.fill ?? "─";
	const fillWidth = Math.max(0, inner - visibleWidth(leftText) - visibleWidth(rightText));
	return border(options.leftCorner ?? "├") + leftText + border(fill.repeat(fillWidth)) + rightText + border(options.rightCorner ?? "┤");
}

function frameContent(content: string, width: number, theme: any, color: "border" | "borderAccent" | "borderMuted" = "borderMuted"): string {
	if (width <= 0) return "";
	if (width === 1) return theme.fg(color, "│");
	const inner = Math.max(0, width - 2);
	return theme.fg(color, "│") + padAnsi(content, inner) + theme.fg(color, "│");
}

function framePanel(title: string, subtitle: string, body: string[], width: number, theme: any, maxBodyRows: number): string[] {
	const top = frameRule(title, subtitle, width, theme, { leftCorner: "╭", rightCorner: "╮", color: "borderAccent" });
	const bottom = frameRule("", "", width, theme, { leftCorner: "╰", rightCorner: "╯", color: "borderAccent" });
	const rows = body.slice(0, Math.max(0, maxBodyRows)).map((line) => frameContent(line, width, theme));
	return [top, ...rows, bottom];
}

function splitRule(width: number, leftWidth: number, rightWidth: number, theme: any): string {
	if (width <= 0) return "";
	if (width < 3) return frameRule("", "", width, theme, { color: "borderAccent" });
	return theme.fg("borderAccent", "├" + "─".repeat(Math.max(0, leftWidth)) + "┬" + "─".repeat(Math.max(0, rightWidth)) + "┤");
}

function splitContent(left: string, right: string, leftWidth: number, rightWidth: number, theme: any): string {
	return theme.fg("borderMuted", "│") + padAnsi(left, leftWidth) + theme.fg("borderAccent", "│") + padAnsi(right, rightWidth) + theme.fg("borderMuted", "│");
}

function boxLines(title: string, status: string, body: string[], width: number, theme: any, color: "accent" | "success" | "warning" | "muted"): string[] {
	if (width <= 0) return [];
	if (width === 1) return [theme.fg(color, "│")];
	const inner = Math.max(0, width - 2);
	const topLabel = truncateToWidth(` ${title} `, inner, "");
	const top = theme.fg(color, "╭" + "─".repeat(Math.max(0, inner - visibleWidth(topLabel))) + topLabel + "╮");
	const bottom = theme.fg(color, "╰" + "─".repeat(inner) + "╯");
	const rows = [theme.fg(color, status), ...body].slice(0, 5);
	while (rows.length < 5) rows.push("");
	return [top, ...rows.map((row) => theme.fg(color, "│") + padAnsi(row, inner) + theme.fg(color, "│")), bottom];
}

function dashboardStatsParts(state: DashboardState): string[] {
	const parentSubagents = state.subagents.filter((item) => item.phase === "assistant_brief").length;
	const directSubagents = state.subagents.filter((item) => item.phase === "direct_tool").length;
	const runningSubagents = state.subagents.filter((item) => item.status === "running").length;
	const savedFiles = state.downloads.length;
	const toolEvents = state.toolEvents.length;
	return [
		`${parentSubagents + directSubagents} brief/subagent${parentSubagents + directSubagents === 1 ? "" : "s"}${runningSubagents ? ` (${runningSubagents} running)` : ""}`,
		`${savedFiles} saved/artifact file${savedFiles === 1 ? "" : "s"}`,
		`${toolEvents} tool event${toolEvents === 1 ? "" : "s"}`,
	];
}

function dashboardStatsLine(state: DashboardState, theme: any): string {
	return theme.fg("accent", "observatory") + theme.fg("muted", `  ${dashboardStatsParts(state).join(" • ")}  •  /workshop-observatory or Ctrl+Alt+W to inspect`);
}

function dashboardPhaseText(state: DashboardState): string {
	return state.final
		? `${state.final.status} (${state.final.converged ? "converged" : "not converged"})`
		: `${state.phase} • round ${state.round || "?"}/${state.rounds || "?"}`;
}

function dashboardFlowLine(state: DashboardState, theme: any, width: number): string {
	const flow = [
		["plan", state.phase.includes("planning") || state.phase.includes("planned")],
		["briefs", state.phase.includes("brief")],
		["experts", state.phase.includes("expert")],
		["synthesis", state.phase.includes("synthesis")],
		["questions", state.phase.includes("question") || state.phase.includes("awaiting")],
		["final", Boolean(state.final)],
	] as const;
	return truncateToWidth(
		flow
			.map(([label, active]) => (active ? theme.fg("accent", `[${label}]`) : theme.fg("dim", `[${label}]`)))
			.join(theme.fg("borderMuted", " ─▶ ")),
		width,
	);
}

function renderDashboardLines(state: DashboardState, theme: any, width: number): string[] {
	if (width <= 0) return [];
	const w = width;
	const innerW = Math.max(0, w - 2);
	const lines: string[] = [];
	const phase = dashboardPhaseText(state);
	lines.push(truncateToWidth(theme.fg("accent", "live workshop control room") + theme.fg("muted", "  /workshop-observatory or Ctrl+Alt+W opens full-screen mode"), innerW));
	lines.push(dashboardFlowLine(state, theme, innerW));
	if (state.delegation.length) {
		lines.push(truncateToWidth(theme.fg("muted", `subagents: ${state.delegation.join(" • ")}`), innerW));
	}

	const lanes = Array.from(state.lanes.values());
	const cols = innerW >= 108 ? 2 : 1;
	const gap = cols === 2 ? 2 : 0;
	const colW = cols === 2 ? Math.floor((innerW - gap) / 2) : innerW;
	for (let i = 0; i < lanes.length; i += cols) {
		const group = lanes.slice(i, i + cols);
		const boxes = group.map((lane) => {
			const icon = lane.status === "done" ? "✓" : lane.status === "running" ? "●" : "○";
			const color = lane.status === "done" ? "success" : lane.status === "running" ? "warning" : "muted";
			const activity = lane.activity.length ? lane.activity.slice(-3) : ["queued"];
			return boxLines(lane.name, `${icon} ${lane.status}`, activity.map((a) => theme.fg("dim", a)), colW, theme, color);
		});
		if (boxes.length === 1) {
			lines.push(...boxes[0].map((line) => truncateToWidth(line, innerW)));
		} else {
			for (let row = 0; row < boxes[0].length; row++) {
				lines.push(truncateToWidth(padAnsi(boxes[0][row], colW) + " ".repeat(gap) + padAnsi(boxes[1][row], colW), innerW));
			}
		}
	}

	if (state.synthesis && (state.synthesis.activity.length || state.synthesis.status)) {
		const synthIcon = state.synthesis.converged ? "✓" : "◆";
		const synthText = state.synthesis.activity[state.synthesis.activity.length - 1] ?? "pending";
		lines.push(...boxLines("synthesis", `${synthIcon} ${state.synthesis.status ?? "running"}`, [theme.fg("dim", synthText)], innerW, theme, state.synthesis.converged ? "success" : "warning"));
	}
	if (state.questions.length) {
		const qLines = [`${state.questions.length} user question(s) — per-question Q&A can steer next round`, ...state.questions.slice(0, 3).map((q) => `Q: ${q}`)];
		lines.push(...boxLines("user steering", "? waiting", qLines.map((q) => theme.fg("dim", q)), innerW, theme, "warning"));
	}
	if (state.final) {
		lines.push(...boxLines("resolution", state.final.status, [theme.fg("dim", state.final.reportPath ?? state.final.resolutionPath)], innerW, theme, state.final.converged ? "success" : "warning"));
	}
	lines.push(truncateToWidth(dashboardStatsLine(state, theme), innerW));
	return framePanel(theme.fg("accent", ` ✦ ${theme.bold("Observatory")} `), theme.fg("muted", ` ${phase} `), lines, w, theme, 28);
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

type ObservatoryItem = { label: string; description: string; detail: (options?: { showActivity?: boolean }) => string };

function observatoryItems(state: DashboardState): ObservatoryItem[] {
	const items: ObservatoryItem[] = [];
	for (const lane of state.lanes.values()) {
		items.push({
			label: `expert: ${lane.name}`,
			description: `${lane.status}${lane.path ? ` • ${path.basename(lane.path)}` : ""}`,
			detail: (options) => [
				`# Expert lane: ${lane.name}`,
				`Status: ${lane.status}`,
				lane.path ? `Artifact: ${lane.path}` : "Artifact: not written yet",
				options?.showActivity === false ? undefined : "",
				options?.showActivity === false ? undefined : "## Recent activity / thinking",
				...(options?.showActivity === false ? [] : (lane.activity.length ? lane.activity.map((a) => `- ${a}`) : ["- none yet"])),
				"",
				lane.text ? `## Critique preview\n\n${lane.text.slice(0, 6000)}` : "Critique preview not available yet.",
			].filter((line): line is string => line !== undefined).join("\n"),
		});
	}
	if (state.synthesis?.path || state.synthesis?.activity.length) {
		items.push({
			label: "synthesis",
			description: `${state.synthesis.status ?? "running"}${state.synthesis.path ? ` • ${path.basename(state.synthesis.path)}` : ""}`,
			detail: (options) => [
				"# Synthesis",
				`Status: ${state.synthesis?.status ?? "running"}`,
				`Converged: ${state.synthesis?.converged ? "yes" : "no"}`,
				state.synthesis?.path ? `Artifact: ${state.synthesis.path}` : "Artifact: not written yet",
				"",
				state.synthesis?.text ? state.synthesis.text.slice(0, 6000) : (options?.showActivity === false ? "Activity hidden (press t to toggle)." : (state.synthesis?.activity ?? []).join("\n")),
			].join("\n"),
		});
	}
	for (const sub of state.subagents.slice().reverse()) {
		items.push({
			label: `subagent: ${sub.name}`,
			description: `${sub.status} • ${sub.phase}${sub.expert ? ` • ${sub.expert}` : ""}`,
			detail: (options) => [
				`# Brief/subagent thread: ${sub.name}`,
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
				options?.showActivity === false ? `## Live/recent activity\n(hidden — press t to toggle)` : (sub.activity?.length ? `## Live/recent activity / thinking\n${sub.activity.map((a) => `- ${a}`).join("\n")}` : undefined),
				sub.outputPreview ? `## Output preview\n${sub.outputPreview}` : undefined,
				sub.sessionExports?.length ? `## Session exports\n${sub.sessionExports.map((p) => `- ${p}`).join("\n")}` : undefined,
				sub.savedOutputs?.length ? `## Saved outputs\n${sub.savedOutputs.map((p) => `- ${p}`).join("\n")}` : undefined,
				sub.artifactOutputs?.length ? `## Artifact outputs\n${sub.artifactOutputs.map((p) => `- ${p}`).join("\n")}` : undefined,
			].filter(Boolean).join("\n"),
		});
	}
	for (const file of state.downloads.slice().reverse()) {
		items.push({
			label: `file: ${file.name}`,
			description: `${file.source} • ${formatBytes(file.bytes)}${file.owner ? ` • ${file.owner}` : ""}`,
			detail: () => [
				`# File: ${file.name}`,
				`Path: ${file.path}`,
				`Source: ${file.source}`,
				`Size: ${formatBytes(file.bytes)}`,
				file.mtimeMs ? `Modified: ${new Date(file.mtimeMs).toISOString()}` : undefined,
				`Detected: ${file.detectedAt}`,
				file.owner ? `Observed after child: ${file.owner}` : undefined,
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

type ObservatoryFocus = "list" | "detail";
type ObservatoryRenderState = { selected: number; listScroll: number; detailScroll: number; focus: ObservatoryFocus; showActivity: boolean };

function clampIndex(index: number, total: number): number {
	if (total <= 0) return 0;
	return Math.max(0, Math.min(total - 1, index));
}

function clampScroll(scroll: number, total: number, visibleRows: number): number {
	return Math.max(0, Math.min(scroll, Math.max(0, total - Math.max(1, visibleRows))));
}

function scrollIntoView(selected: number, scroll: number, visibleRows: number, total: number): number {
	if (visibleRows <= 0 || total <= 0) return 0;
	let next = clampScroll(scroll, total, visibleRows);
	if (selected < next) next = selected;
	else if (selected >= next + visibleRows) next = selected - visibleRows + 1;
	return clampScroll(next, total, visibleRows);
}

function observatoryItemTone(item: ObservatoryItem): "accent" | "success" | "warning" | "muted" {
	const text = `${item.label} ${item.description}`.toLowerCase();
	if (/running|waiting|queued/.test(text)) return "warning";
	if (/done|complete|converged|final/.test(text)) return "success";
	if (item.label.startsWith("file:") || item.label.startsWith("tool:")) return "accent";
	return "muted";
}

function observatoryItemIcon(item: ObservatoryItem): string {
	const text = `${item.label} ${item.description}`.toLowerCase();
	if (/running|waiting/.test(text)) return "●";
	if (/done|complete|converged|final/.test(text)) return "✓";
	if (item.label.startsWith("file:")) return "◆";
	if (item.label.startsWith("tool:")) return "◦";
	return "○";
}

function observatoryListRows(items: ObservatoryItem[], controls: ObservatoryRenderState, height: number, width: number, theme: any): string[] {
	if (height <= 0) return [];
	if (!items.length) return [theme.fg("muted", "No observable expert/subagent/file/tool events yet.")];
	controls.selected = clampIndex(controls.selected, items.length);
	controls.listScroll = scrollIntoView(controls.selected, controls.listScroll, height, items.length);
	const rows: string[] = [];
	const end = Math.min(items.length, controls.listScroll + height);
	for (let i = controls.listScroll; i < end; i++) {
		const item = items[i]!;
		const selected = i === controls.selected;
		const tone = observatoryItemTone(item);
		const prefix = selected ? "›" : " ";
		const index = String(i + 1).padStart(2, " ");
		const label = `${prefix} ${index} ${observatoryItemIcon(item)} ${item.label}`;
		const row = truncateToWidth(theme.fg(selected ? "accent" : tone, label) + theme.fg("dim", ` — ${item.description}`), width, "…");
		rows.push(selected ? theme.bg("selectedBg", padAnsi(row, width)) : row);
	}
	return rows;
}

function observatoryDetailRows(item: ObservatoryItem | undefined, controls: ObservatoryRenderState, height: number, width: number, theme: any): string[] {
	if (height <= 0) return [];
	const body = item?.detail({ showActivity: controls.showActivity }) ?? "# Observatory\n\nNo item selected yet.";
	const wrapped = body.split("\n").flatMap((line) => wrapTextWithAnsi(line || " ", Math.max(8, width)));
	const viewport = Math.max(0, height - 1);
	controls.detailScroll = clampScroll(controls.detailScroll, wrapped.length, viewport);
	const visible = viewport > 0 ? wrapped.slice(controls.detailScroll, controls.detailScroll + viewport) : [];
	const footer = theme.fg("dim", `${Math.min(controls.detailScroll + visible.length, wrapped.length)}/${wrapped.length} lines${controls.showActivity ? "" : " • activity hidden"}`);
	return [...visible.map((line) => truncateToWidth(line, width, "…")), footer];
}

function renderObservatoryMode(dashboard: DashboardState, controls: ObservatoryRenderState, theme: any, width: number, height: number): string[] {
	if (width <= 0 || height <= 0) return [];
	const w = width;
	const h = Math.max(1, height);
	const inner = Math.max(0, w - 2);
	const items = observatoryItems(dashboard);
	controls.selected = clampIndex(controls.selected, items.length);
	const lines: string[] = [];
	const phase = dashboardPhaseText(dashboard);
	const title = theme.fg("accent", ` ✦ ${theme.bold("Observatory")} `) + theme.fg("muted", "workshop control room ");
	lines.push(frameRule(title, theme.fg("muted", ` ${phase} `), w, theme, { leftCorner: "╭", rightCorner: "╮", color: "borderAccent" }));
	lines.push(frameContent(theme.fg("accent", "live ") + theme.fg("muted", dashboardStatsParts(dashboard).join(" • ")), w, theme));
	lines.push(frameContent(theme.fg("accent", `focus: ${controls.focus}`) + theme.fg("muted", "  ↑↓ select/scroll • Enter/→ detail • ←/Backspace list • PgUp/PgDn • t activity • Esc close"), w, theme));
	lines.push(frameContent(dashboardFlowLine(dashboard, theme, inner), w, theme));

	const twoPane = w >= 96;
	if (twoPane) {
		const leftW = Math.min(48, Math.max(30, Math.floor((inner - 1) * 0.34)));
		const rightW = Math.max(0, inner - leftW - 1);
		lines.push(splitRule(w, leftW, rightW, theme));
		const selectedItem = items[controls.selected];
		lines.push(splitContent(
			theme.fg(controls.focus === "list" ? "accent" : "muted", `${controls.focus === "list" ? "▸ " : "  "}INDEX`) + theme.fg("dim", ` ${items.length} items`),
			theme.fg(controls.focus === "detail" ? "accent" : "muted", `${controls.focus === "detail" ? "▸ " : "  "}DETAIL`) + theme.fg("dim", selectedItem ? ` ${selectedItem.label}` : " no selection"),
			leftW,
			rightW,
			theme,
		));
		const bodyRows = Math.max(0, h - lines.length - 1);
		const listRows = observatoryListRows(items, controls, bodyRows, leftW, theme);
		const detailRows = observatoryDetailRows(selectedItem, controls, bodyRows, rightW, theme);
		for (let row = 0; row < bodyRows; row++) {
			lines.push(splitContent(listRows[row] ?? "", detailRows[row] ?? "", leftW, rightW, theme));
		}
	} else {
		const selectedItem = items[controls.selected];
		lines.push(frameRule(theme.fg("accent", ` ${controls.focus === "list" ? "INDEX" : "DETAIL"} `), selectedItem ? theme.fg("dim", ` ${selectedItem.label} `) : "", w, theme, { color: "borderAccent" }));
		const bodyRows = Math.max(0, h - lines.length - 1);
		const body = controls.focus === "list"
			? observatoryListRows(items, controls, bodyRows, inner, theme)
			: observatoryDetailRows(selectedItem, controls, bodyRows, inner, theme);
		for (let row = 0; row < bodyRows; row++) lines.push(frameContent(body[row] ?? "", w, theme));
	}

	const bottom = frameRule(
		theme.fg("muted", ` ${items.length} observable item${items.length === 1 ? "" : "s"} `),
		theme.fg("dim", ` activity ${controls.showActivity ? "shown" : "hidden"} `),
		w,
		theme,
		{ leftCorner: "╰", rightCorner: "╯", color: "borderAccent" },
	);
	if (lines.length >= h) return [...lines.slice(0, h - 1), bottom].map((line) => truncateToWidth(line, w, ""));
	while (lines.length < h - 1) lines.push(frameContent("", w, theme));
	lines.push(bottom);
	return lines.map((line) => truncateToWidth(line, w, ""));
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
			const controls: ObservatoryRenderState = { selected: 0, listScroll: 0, detailScroll: 0, focus: "list", showActivity: true };
			const pageSize = () => Math.max(4, Math.floor((Number(tui?.terminal?.rows ?? 28) - 8) / 2));
			return {
				render: (width: number) => renderObservatoryMode(state, controls, theme, width, Number(tui?.terminal?.rows ?? 28)),
				invalidate: () => {},
				handleInput: (data: string) => {
					const items = observatoryItems(state);
					controls.selected = clampIndex(controls.selected, items.length);
					if (matchesKey(data, Key.escape)) { done(); return; }
					if (data === "t" || data === "T") { controls.showActivity = !controls.showActivity; tui.requestRender(); return; }
					if (matchesKey(data, Key.tab)) { controls.focus = controls.focus === "list" ? "detail" : "list"; tui.requestRender(); return; }
					if (matchesKey(data, Key.right) || matchesKey(data, Key.enter)) { controls.focus = "detail"; tui.requestRender(); return; }
					if (matchesKey(data, Key.left) || matchesKey(data, Key.backspace)) { controls.focus = "list"; controls.detailScroll = 0; tui.requestRender(); return; }
					if (controls.focus === "detail") {
						if (matchesKey(data, Key.up)) controls.detailScroll = Math.max(0, controls.detailScroll - 1);
						else if (matchesKey(data, Key.down)) controls.detailScroll += 1;
						else if (matchesKey(data, Key.pageUp)) controls.detailScroll = Math.max(0, controls.detailScroll - pageSize());
						else if (matchesKey(data, Key.pageDown)) controls.detailScroll += pageSize();
						else if (matchesKey(data, Key.home)) controls.detailScroll = 0;
						else if (matchesKey(data, Key.end)) controls.detailScroll += 10_000;
						tui.requestRender();
						return;
					}
					if (matchesKey(data, Key.up)) { controls.selected = Math.max(0, controls.selected - 1); controls.detailScroll = 0; }
					else if (matchesKey(data, Key.down)) { controls.selected = Math.min(Math.max(0, items.length - 1), controls.selected + 1); controls.detailScroll = 0; }
					else if (matchesKey(data, Key.pageUp)) { controls.selected = Math.max(0, controls.selected - pageSize()); controls.detailScroll = 0; }
					else if (matchesKey(data, Key.pageDown)) { controls.selected = Math.min(Math.max(0, items.length - 1), controls.selected + pageSize()); controls.detailScroll = 0; }
					else if (matchesKey(data, Key.home)) { controls.selected = 0; controls.detailScroll = 0; }
					else if (matchesKey(data, Key.end)) { controls.selected = Math.max(0, items.length - 1); controls.detailScroll = 0; }
					tui.requestRender();
				},
			};
		}, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 } });
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

async function restrictAssistantContextPaths(ctx: any, params: WorkshopInput): Promise<WorkshopInput> {
	if (!params.contextPaths?.length) return params;
	const realCwd = await fs.realpath(ctx.cwd);
	const contextPaths: string[] = [];
	for (const contextPath of params.contextPaths) {
		const resolved = resolveMaybe(ctx.cwd, contextPath);
		let realContext: string;
		try {
			realContext = await fs.realpath(resolved);
		} catch (error) {
			throw new Error(`Assistant workshop contextPath must exist and resolve inside the current cwd: ${contextPath} (${String((error as Error)?.message ?? error)})`);
		}
		try {
			assertInside(realCwd, realContext);
		} catch {
			throw new Error(`Assistant workshop contextPath must resolve inside the current cwd: ${contextPath}`);
		}
		contextPaths.push(realContext);
	}
	return { ...params, contextPaths };
}

function modelExists(ctx: any, ref: string | undefined): boolean {
	if (!ref) return true;
	const [provider, ...rest] = ref.split("/");
	const id = rest.join("/");
	if (!provider || !id) return true;
	try { return Boolean(ctx?.modelRegistry?.find?.(provider, id)); } catch (error) { logWarn(`modelExists(${ref})`, error); return false; }
}

type WorkshopModelResolution = {
	inheritedModel?: string;
	strongModel?: string;
	plannerModel?: string;
	expertModel?: string;
	synthModel?: string;
	juniorModel?: string;
	unknownModels: string[];
};

function missingStrongModelGuidance(): string {
	return [
		"pi-workshop: no strongModel available.",
		"Set models.strongModel in ~/.pi/agent/pi-workshop.config.json, pass --strong-model, or launch pi with a default model so the workshop can inherit it.",
		"",
		"List model IDs:",
		"  pi --list-models",
		"",
		"Minimal config:",
		"```json",
		"{",
		"  \"models\": {",
		"    \"strongModel\": \"provider/your-strong-model-id\",",
		"    \"juniorModel\": \"provider/your-cheap-model-id\"",
		"  }",
		"}",
		"```",
	].join("\n");
}

function resolveWorkshopModels(ctx: any, params: WorkshopInput): WorkshopModelResolution {
	const inheritedModel = activeModelRef(ctx);
	const inheritedProvider = activeProvider(ctx);
	const strongModel = params.strongModel ?? inheritedModel;
	const plannerModel = params.plannerModel ?? strongModel;
	const expertModel = params.expertModel ?? strongModel;
	const synthModel = params.synthModel ?? strongModel;
	const juniorModel = params.juniorModel ?? (strongModel && inheritedProvider ? providerQualifiedIfAvailable(ctx, inheritedProvider, strongModel) : undefined) ?? inheritedModel ?? strongModel;
	const unknownModels = [...new Set([strongModel, plannerModel, expertModel, synthModel, juniorModel].filter((model): model is string => Boolean(model)).filter((model) => !modelExists(ctx, model)))];
	return { inheritedModel, strongModel, plannerModel, expertModel, synthModel, juniorModel, unknownModels };
}

function modelResolutionLines(models: WorkshopModelResolution): string[] {
	return [
		`Inherited active model: ${models.inheritedModel ?? "none"}`,
		`strongModel: ${models.strongModel ?? "MISSING"}`,
		`plannerModel: ${models.plannerModel ?? "MISSING"}`,
		`expertModel: ${models.expertModel ?? "MISSING"}`,
		`synthModel: ${models.synthModel ?? "MISSING"}`,
		`juniorModel: ${models.juniorModel ?? "MISSING"}`,
	];
}

async function confirmUnknownConfiguredModels(ctx: any, params: WorkshopInput, commandName = "/workshop"): Promise<string | undefined> {
	const models = resolveWorkshopModels(ctx, params);
	if (!models.unknownModels.length) return undefined;
	const message = [
		`${commandName} references provider-qualified model ID(s) not found in the current model registry: ${models.unknownModels.join(", ")}.`,
		"This may fail after the run starts. Use pi --list-models to choose available IDs, or confirm that these IDs are intentionally provided by a custom provider.",
	].join("\n");
	if (!ctx.hasUI) return `${message}\n\nNon-interactive runs fail closed for unknown provider-qualified models.`;
	const ok = await ctx.ui.confirm("Confirm unknown workshop model", `${message}\n\nProceed anyway for this run?`);
	return ok ? undefined : `${message}\n\nUser declined unknown model ID(s).`;
}

const PROJECT_PRIVILEGED_FLAGS = ["localBash", "expertSubagents", "prototyping"] as const;

type ProjectPrivilegedFlag = typeof PROJECT_PRIVILEGED_FLAGS[number];

function projectPrivilegedDefaults(resolved: ResolvedWorkshopConfig, rawParams: Partial<WorkshopInput>): ProjectPrivilegedFlag[] {
	const projectConfig = resolved.projectConfig;
	if (!projectConfig) return [];
	const explicitProfileOrWorkshop = rawParams.profile !== undefined || rawParams.workshop === true;
	const projectDefaultProfile = selectRequestedProfile(projectConfig.defaults, {});
	return PROJECT_PRIVILEGED_FLAGS.filter((flag) => {
		if ((resolved.params as any)[flag] !== true) return false;
		if ((rawParams as any)[flag] === true || (rawParams as any)[flag] === false) return false;
		if (explicitProfileOrWorkshop) return false;
		const defaultsEnable = (projectConfig.defaults as any)?.[flag] === true;
		const selectedProfileEnables = resolved.profile ? (projectConfig.profiles?.[resolved.profile] as any)?.[flag] === true : false;
		const projectSelectedProfile = projectDefaultProfile !== undefined && projectDefaultProfile === resolved.profile;
		return defaultsEnable || selectedProfileEnables || projectSelectedProfile;
	});
}

function projectPrivilegedDefaultsMessage(resolved: ResolvedWorkshopConfig, rawParams: Partial<WorkshopInput>, commandName = "/workshop"): string | undefined {
	const flags = projectPrivilegedDefaults(resolved, rawParams);
	if (!flags.length || !resolved.projectConfigPath) return undefined;
	return [
		`Project config ${resolved.projectConfigPath} enables privileged workshop mode(s) without explicit per-run flags: ${flags.join(", ")}.`,
		`These project-derived privileges must be confirmed by the local user; project config cannot grant trusted execution on its own.`,
		`${commandName} fails closed in non-interactive mode for these project-derived privileges.`,
	].join("\n");
}

function enabledPrivilegedModes(resolved: ResolvedWorkshopConfig): ProjectPrivilegedFlag[] {
	return PROJECT_PRIVILEGED_FLAGS.filter((flag) => (resolved.params as any)[flag] === true);
}

function privilegedElevationMessage(resolved: ResolvedWorkshopConfig, _rawParams: Partial<WorkshopInput>, commandName = "/workshop"): string | undefined {
	const flags = enabledPrivilegedModes(resolved);
	if (!flags.length) return undefined;
	const projectNotice = projectPrivilegedDefaultsMessage(resolved, _rawParams, commandName);
	return [
		`${commandName} would enable privileged workshop mode(s): ${flags.join(", ")}.`,
		"Slash commands are a UX surface, not a proof of human provenance; confirm that you intend to grant local-user authority for this run.",
		"localBash/prototype/expert-subagent modes may expose environment credentials or mutate files if the child model/tool does so.",
		projectNotice ? `\nProject-config note:\n${projectNotice}` : undefined,
	].filter((line): line is string => Boolean(line)).join("\n");
}

async function confirmProjectPrivilegedDefaults(ctx: any, resolved: ResolvedWorkshopConfig, rawParams: Partial<WorkshopInput>, commandName = "/workshop"): Promise<string | undefined> {
	const message = privilegedElevationMessage(resolved, rawParams, commandName);
	if (!message) return undefined;
	if (!ctx.hasUI) return `${message}\n\nNon-interactive privileged runs fail closed unless a future user-global trust setting is added.`;
	const ok = await ctx.ui.confirm("Confirm privileged workshop run", `${message}\n\nAllow this run to proceed?`);
	return ok ? undefined : `${message}\n\nUser declined privileged workshop mode(s).`;
}

async function preflightWorkshop(pi: ExtensionAPI, ctx: any, params: WorkshopInput): Promise<{ ok: boolean; critical: string[]; warnings: string[]; content: string }> {
	const resolved = await resolveWorkshopConfig(resolveMaybe(ctx.cwd, params.cwd ?? "."), params);
	const resolvedParams = resolved.params;
	const webResearch = Boolean(resolvedParams.webResearch);
	const localBash = Boolean(resolvedParams.localBash);
	const allTools = new Set((pi.getAllTools?.() ?? []).map((tool: any) => String(tool.name)));
	const models = resolveWorkshopModels(ctx, resolvedParams);
	const critical: string[] = [];
	const warnings: string[] = [];
	try {
		if (params.experts?.length) assertUniqueExpertNamesForArtifacts(params.experts, "User-supplied expert");
	} catch (error) {
		critical.push(String((error as Error)?.message ?? error));
	}
	const projectPrivilegeNotice = projectPrivilegedDefaultsMessage(resolved, params);
	if (projectPrivilegeNotice) warnings.push(projectPrivilegeNotice);
	for (const tool of DEFAULT_TOOLS.split(",")) if (!allTools.has(tool)) warnings.push(`Built-in read/search tool not visible in parent: ${tool}`);
	if (webResearch) {
		for (const tool of WEB_RESEARCH_TOOLS.split(",")) if (!allTools.has(tool)) critical.push(`webResearch requested but tool is unavailable: ${tool}`);
	}
	if (resolvedParams.expertSubagents && !allTools.has("subagent")) critical.push("expertSubagents requested but the subagent tool is unavailable");
	if (localBash && !allTools.has("bash")) critical.push("localBash requested but bash tool is unavailable");
	if (resolvedParams.prototyping && !allTools.has(PROTOTYPE_TOOL)) critical.push(`${PROTOTYPE_TOOL} requested but the tool is unavailable`);
	if (!models.strongModel) critical.push(missingStrongModelGuidance());
	if (models.unknownModels.length) {
		const message = `Configured provider-qualified model ID(s) not found in the current model registry: ${models.unknownModels.join(", ")}`;
		if (ctx.hasUI) warnings.push(`${message}; /workshop will ask for confirmation before starting.`);
		else critical.push(`${message}. Non-interactive runs fail closed; use pi --list-models or run in the UI to confirm.`);
	}
	const privileged = enabledPrivilegedModes(resolved);
	if (privileged.length) {
		const message = `Privileged mode(s) enabled: ${privileged.join(", ")}. These run with local user authority and require UI confirmation unless a future user-global trust setting is added.`;
		if (ctx.hasUI) warnings.push(message);
		else critical.push(`${message} Non-interactive privileged runs fail closed.`);
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
		`Project config: ${resolved.projectConfigPath ?? "none"}`,
		`Web research: ${webResearch ? "enabled" : "disabled"}`,
		`Local bash: ${localBash ? "enabled" : "disabled"}`,
		`Subagents: ${resolvedParams.subagents ? "parent briefs" : "off"}; expert direct: ${resolvedParams.expertSubagents ? "enabled" : "disabled"}`,
		`Prototyping: ${resolvedParams.prototyping ? "enabled (artifact-contained, not sandboxed)" : "disabled"}`,
		"Output: cwd-local .pi/workshops/<run> (absolute/symlink escapes rejected)",
		"Home-directory download scan: disabled",
		"",
		"## Model resolution",
		...modelResolutionLines(models).map((line) => `- ${line}`),
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
			"Create/run small throwaway prototype experiments for a workshop expert inside an active workshop artifact directory. Requires an active, unrevoked per-expert nonce from the workshop prompt. This is artifact-contained, not a security sandbox.",
		promptSnippet: "Run scratch/prototype code experiments for pi-workshop and save outputs as artifacts; requires an active-workshop per-expert nonce.",
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
			const expertSegment = safeSegment(params.expertName);
			if (!validateScratchNonce(policy, expertSegment, params.nonce)) throw new Error("Invalid workshop_scratch nonce for this expert/run");
			const realScratchRoot = await ensureDirInsideNoSymlinks(realWorkshopDir, ["scratch", expertSegment]);
			const writtenFiles: string[] = [];
			let totalInputBytes = 0;
			for (const file of params.files ?? []) {
				if (path.isAbsolute(file.path)) throw new Error(`Scratch file path must be relative: ${file.path}`);
				if ((params.files?.length ?? 0) > 20) throw new Error("Too many scratch files requested; limit is 20");
				totalInputBytes += Buffer.byteLength(file.content);
				if (totalInputBytes > 256 * 1024) throw new Error("Scratch input files exceed 256KB total limit");
				const target = await writeScratchFileNoSymlink(realScratchRoot, file.path, file.content);
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
			const artifactFileName = `${timestampSlug()}-${label}.md`;
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
			const artifactPath = await writeScratchFileNoSymlink(realScratchRoot, artifactFileName, artifact);
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
			"Assistant-invoked workshop is restricted: it may use webResearch and parent-run briefs, and contextPaths only when they resolve inside the current cwd; it cannot grant bash, direct expert subagents, prototyping, cwd, outputDir, custom tools, or privileged workshop profiles. Tell the user to use /workshop for privileged modes.",
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
			const safeParams = await restrictAssistantContextPaths(ctx, sanitizePublicWorkshopParams(params as PublicWorkshopInput));
			const preflight = await preflightWorkshop(pi, ctx, safeParams);
			if (!preflight.ok) throw new Error(`workshop preflight failed:\n${preflight.critical.join("\n")}`);
			const unknownModels = resolveWorkshopModels(ctx, safeParams).unknownModels;
			if (unknownModels.length) throw new Error(`workshop preflight failed: unknown model ID(s) require explicit UI confirmation: ${unknownModels.join(", ")}`);
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
		const projectPrivilegeBlock = await confirmProjectPrivilegedDefaults(ctx, resolvedForUi, params, "/workshop");
		if (projectPrivilegeBlock) {
			pi.sendMessage({ customType: "pi-workshop", content: `# Workshop blocked\n\n${projectPrivilegeBlock}`, display: true, details: { projectPrivilegeBlock, resolved: resolvedForUi } });
			return;
		}
		const unknownModelBlock = await confirmUnknownConfiguredModels(ctx, resolvedForUi.params, "/workshop");
		if (unknownModelBlock) {
			pi.sendMessage({ customType: "pi-workshop", content: `# Workshop blocked\n\n${unknownModelBlock}`, display: true, details: { unknownModelBlock, resolved: resolvedForUi } });
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
			const message = String((error as Error)?.message ?? error);
			pi.sendMessage({ customType: "pi-workshop", content: `# Workshop failed\n\n${message}`, display: true, details: { error: message } });
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
			const projectPrivilegeNotice = projectPrivilegedDefaultsMessage(resolved, configPreviewParams, "/workshop");
			let checkReport: Awaited<ReturnType<typeof preflightWorkshop>> | undefined;
			try {
				if (parsed.check) checkReport = await preflightWorkshop(pi, ctx, { ...configPreviewParams, idea: "config preview" });
			} catch (error) {
				const message = `Workshop config preflight error: ${String((error as Error)?.message ?? error)}`;
				pi.sendMessage({ customType: "pi-workshop", content: `# ${message}`, display: true, details: { error: message, resolved } });
				return;
			}
			const content = [
				parsed.check ? "# Pi workshop config check" : "# Pi workshop config",
				"",
				parsed.check ? `Config validation: **ok**; preflight: **${checkReport?.ok ? "ok" : "blocked"}**` : "",
				`Config files: ${resolved.configPaths.length ? resolved.configPaths.join(", ") : "built-in defaults only"}`,
				`Project config: ${resolved.projectConfigPath ?? "none"}`,
				`Profile: ${resolved.profile ?? "none"}`,
				projectPrivilegeNotice ? `Privileged project defaults: ${projectPrivilegeNotice}` : "Privileged project defaults: none requiring confirmation",
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
				parsed.check && checkReport ? "## Preflight" : "",
				parsed.check && checkReport ? checkReport.content : "",
				"" ,
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
		description: "Open a navigable inspector for the active/latest workshop: experts, briefs, tool events, and saved artifact files",
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
			const projectPrivilegeBlock = await confirmProjectPrivilegedDefaults(ctx, resolvedForUi, pickupParams, "/workshop-pickup");
			if (projectPrivilegeBlock) {
				pi.sendMessage({ customType: "pi-workshop", content: `# Workshop pickup blocked\n\n${projectPrivilegeBlock}`, display: true, details: { projectPrivilegeBlock, resolved: resolvedForUi } });
				return;
			}
			const unknownModelBlock = await confirmUnknownConfiguredModels(ctx, resolvedForUi.params, "/workshop-pickup");
			if (unknownModelBlock) {
				pi.sendMessage({ customType: "pi-workshop", content: `# Workshop pickup blocked\n\n${unknownModelBlock}`, display: true, details: { unknownModelBlock, resolved: resolvedForUi } });
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
				const message = String((error as Error)?.message ?? error);
				pi.sendMessage({ customType: "pi-workshop", content: `# Workshop pickup failed\n\n${message}`, display: true, details: { error: message } });
			} finally {
				if (activeWorkshop?.controller === controller) activeWorkshop = undefined;
				ctx.ui.setStatus("pi-workshop", undefined);
				if (!keepDashboard) ctx.ui.setWidget("pi-workshop-dashboard", undefined);
			}
		},
	});
}
