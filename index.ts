import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as fssync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, truncateHead, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Markdown, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

const MAX_ROUNDS = 8;
const DEFAULT_ROUNDS = 4;
const DEFAULT_TOOLS = "read,grep,find,ls";
const RESEARCH_TOOLS = "read,grep,find,ls,bash,web_search,fetch_content,get_search_content,code_search";
const PROTOTYPE_TOOL = "debate_scratch";
const OUTPUT_CAP_BYTES = 80 * 1024;
const DEFAULT_STRONG_MODEL = "gpt-5.5";
const DEFAULT_JUNIOR_MODEL = "gpt-5.4-mini";

type Intensity = "normal" | "hard" | "ruthless";
type ResolutionStatus = "ACCEPT" | "ITERATE" | "REJECT" | "ILL_POSED" | "UNRESOLVED";

const AssistantBriefSchema = Type.Object({
	agent: Type.Optional(StringEnum(["scout", "researcher", "oracle", "delegate"] as const, { default: "scout" })),
	task: Type.String({ description: "Narrow task for the junior assistant/subagent to investigate for this expert" }),
	model: Type.Optional(Type.String({ description: "Optional model for this assistant brief" })),
});

const ExpertSchema = Type.Object({
	name: Type.String({ description: "Short expert name, e.g. 'aero' or 'scientific-programmer'" }),
	stance: Type.String({ description: "What this expert owns and how they should attack the idea" }),
	model: Type.Optional(Type.String({ description: "Optional pi model id for this expert, e.g. anthropic/claude-sonnet-4" })),
	tools: Type.Optional(Type.String({ description: `Comma-separated pi tools for this expert. Default: ${DEFAULT_TOOLS}` })),
	assistantBriefs: Type.Optional(Type.Array(AssistantBriefSchema, { description: "Tailored junior assistant brief tasks for this expert" })),
});

const DebateParams = Type.Object({
	idea: Type.String({ description: "Technical idea, proposal, PRD excerpt, architecture, or question to debate" }),
	rounds: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_ROUNDS, default: DEFAULT_ROUNDS })),
	intensity: Type.Optional(StringEnum(["normal", "hard", "ruthless"] as const, { default: "ruthless" })),
	experts: Type.Optional(Type.Array(ExpertSchema, { minItems: 2, maxItems: 4 })),
	contextPaths: Type.Optional(
		Type.Array(Type.String(), { description: "Files/directories experts should inspect before making codebase claims" }),
	),
	interactive: Type.Optional(Type.Boolean({ description: "Ask the user to answer blocking open questions between rounds" })),
	outputDir: Type.Optional(Type.String({ description: "Directory for debate artifacts. Default: .pi/technical-debates/<timestamp-slug>" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for child pi expert processes. Default: current pi cwd" })),
	strongModel: Type.Optional(Type.String({ description: `Model for meta-planner, main experts, and synthesizer when role-specific model is omitted. Default: current active parent model, else ${DEFAULT_STRONG_MODEL}` })),
	plannerModel: Type.Optional(Type.String({ description: "Optional pi model id for the panel-designer/meta-planner" })),
	expertModel: Type.Optional(Type.String({ description: "Optional default pi model id for main experts" })),
	juniorModel: Type.Optional(Type.String({ description: `Model for junior scout/researcher subagents. Default: current active provider's ${DEFAULT_JUNIOR_MODEL} when available, else current active parent model` })),
	synthModel: Type.Optional(Type.String({ description: "Optional pi model id for the synthesizer" })),
	research: Type.Optional(
		Type.Boolean({
			description:
				"Grant default experts bash in addition to read/search tools so they can do controlled external research (e.g. curl docs/pages) and deeper local inspection. Default false.",
		}),
	),
	planExperts: Type.Optional(
		Type.Boolean({
			description:
				"When experts are not provided, run a panel-designer pass to choose 2-4 expert roles for this idea. Default true.",
		}),
	),
	subagents: Type.Optional(
		Type.Boolean({
			description:
				"Run controlled parent-orchestrated pi-subagents briefing passes (scout, and researcher when research=true) for each expert before critique. Main experts still do not launch subagents unless expertSubagents is true or explicit expert tools include subagent. Default false.",
		}),
	),
	expertSubagents: Type.Optional(
		Type.Boolean({
			description:
				"Allow main expert agents to call the subagent tool directly by adding subagent to their tool list. Default false; --subagents alone only runs parent-orchestrated briefing subagents.",
		}),
	),
	prototyping: Type.Optional(
		Type.Boolean({
			description:
				"Give experts a debate_scratch tool for isolated throwaway code/timing experiments under the debate artifact directory. Default false.",
		}),
	),
	htmlReport: Type.Optional(
		Type.Boolean({
			description:
				"Write a self-contained HTML report with workflow, research/prototype artifacts, critiques, synthesis, and final resolution. Default false for tool calls; --workshop enables it for slash commands.",
		}),
	),
	workshop: Type.Optional(
		Type.Boolean({
			description:
				"Convenience mode for RLM-style ideation: enables parent briefs, direct expert subagents, prototyping, research, and HTML report unless explicitly overridden. Slash command flag: --workshop.",
		}),
	),
});

type ExpertInput = Static<typeof ExpertSchema>;
type DebateInput = Static<typeof DebateParams>;

type ChildRun = {
	name: string;
	text: string;
	stderr: string;
	exitCode: number;
	model?: string;
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number };
};

type DebateResult = {
	summary: string;
	status: ResolutionStatus;
	converged: boolean;
	roundsRun: number;
	debateDir: string;
	transcriptPath: string;
	resolutionPath: string;
	workflowPath: string;
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
	| { type: "final"; result: DebateResult };

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
	return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
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

async function writeFileQueued(filePath: string, content: string): Promise<void> {
	await withFileMutationQueue(filePath, async () => {
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, content, "utf8");
	});
}

function safeSegment(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "item";
}

function assertInside(parent: string, child: string): void {
	const rel = path.relative(parent, child);
	if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`Path escapes scratch directory: ${child}`);
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

async function listFilesRecursive(root: string): Promise<string[]> {
	const files: string[] = [];
	async function walk(dir: string) {
		let entries: fssync.Dirent[] = [];
		try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) await walk(full);
			else files.push(full);
		}
	}
	await walk(root);
	return files.sort();
}

function extractAssistantText(message: any): string {
	if (!message?.content || !Array.isArray(message.content)) return "";
	return message.content.filter((p: any) => p?.type === "text" && typeof p.text === "string").map((p: any) => p.text).join("\n");
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

async function runPiJsonPrompt(options: {
	name: string;
	prompt: string;
	cwd: string;
	tools?: string;
	signal?: AbortSignal;
	onProgress?: (text: string) => void;
}): Promise<ChildRun> {
	const args = ["--mode", "json", "-p", "--no-session"];
	if (options.tools) args.push("--tools", options.tools);
	args.push(options.prompt);
	const result: ChildRun = {
		name: options.name,
		text: "",
		stderr: "",
		exitCode: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
	};
	let wasAborted = false;
	const exitCode = await new Promise<number>((resolve) => {
		const invocation = getPiInvocation(args);
		const proc = spawn(invocation.command, invocation.args, { cwd: options.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		let stdoutBuffer = "";
		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try { event = JSON.parse(line); } catch { return; }
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
		proc.on("close", (code) => { if (stdoutBuffer.trim()) processLine(stdoutBuffer); resolve(code ?? 0); });
		proc.on("error", (err) => { result.stderr += String(err?.message ?? err); resolve(1); });
		const kill = () => { wasAborted = true; proc.kill("SIGTERM"); setTimeout(() => proc.kill("SIGKILL"), 5000).unref?.(); };
		if (options.signal?.aborted) kill();
		else options.signal?.addEventListener("abort", kill, { once: true });
	});
	result.exitCode = exitCode;
	if (wasAborted) result.stderr += "\nAborted.";
	if (!result.text.trim() && result.stderr.trim()) result.text = `[no output]\n\nSTDERR:\n${result.stderr}`;
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
	runDir: string;
	onProgress?: (text: string) => void;
	onActivity?: (text: string) => void;
}): Promise<ChildRun> {
	const safeName = options.name.replace(/[^\w.-]+/g, "_");
	const systemPath = path.join(options.runDir, `_system_${safeName}_${Date.now()}.md`);
	await writeFileQueued(systemPath, options.systemPrompt);

	const args = ["--mode", "json", "-p", "--no-session", "--tools", options.tools ?? DEFAULT_TOOLS];
	if (options.model) args.push("--model", options.model);
	args.push("--append-system-prompt", systemPath, options.userPrompt);

	const result: ChildRun = {
		name: options.name,
		text: "",
		stderr: "",
		exitCode: 0,
		model: options.model,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
	};

	let wasAborted = false;
	const exitCode = await new Promise<number>((resolve) => {
		const invocation = getPiInvocation(args);
		const proc = spawn(invocation.command, invocation.args, {
			cwd: options.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdoutBuffer = "";

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			const eventType = String(event.type ?? "");
			const toolName = event.toolName ?? event.name ?? event.message?.toolName;
			if ((eventType.includes("tool") || eventType.includes("Tool")) && toolName) {
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

		proc.stdout.on("data", (data) => {
			stdoutBuffer += data.toString();
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		});
		proc.stderr.on("data", (data) => {
			result.stderr += data.toString();
		});
		proc.on("close", (code) => {
			if (stdoutBuffer.trim()) processLine(stdoutBuffer);
			resolve(code ?? 0);
		});
		proc.on("error", (err) => {
			result.stderr += String(err?.message ?? err);
			resolve(1);
		});

		const kill = () => {
			wasAborted = true;
			proc.kill("SIGTERM");
			setTimeout(() => proc.kill("SIGKILL"), 5000).unref?.();
		};
		if (options.signal?.aborted) kill();
		else options.signal?.addEventListener("abort", kill, { once: true });
	});

	result.exitCode = exitCode;
	if (wasAborted) result.stderr += "\nAborted.";
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

function expertSystemPrompt(expert: ExpertInput, intensity: Intensity, tools: string, parentBriefsEnabled: boolean, prototypingEnabled: boolean, debateDir?: string): string {
	const canCallSubagents = toolListIncludes(tools, "subagent");
	const canPrototype = prototypingEnabled && toolListIncludes(tools, PROTOTYPE_TOOL);
	return `# Expert Ideation Panelist: ${expert.name}

${expert.stance}

Goal: help a panel of world-class experts reach a useful shared resolution. Do not merely criticize. Bring your expertise to improve the idea, identify the strongest viable version, and decide whether it should be accepted, iterated, rejected, or declared too poorly posed.

${intensityRules(intensity)}

Available tools for this run: ${tools}

Subagent / delegation policy:
- Parent-orchestrated assistant briefs: ${parentBriefsEnabled ? "ENABLED. Any assistant-brief files were run by the parent orchestrator before you speak; they are junior input, not your own tool calls." : "DISABLED. No parent-run assistant briefs are expected."}
- Main-expert direct subagent calls: ${canCallSubagents ? "ENABLED because the subagent tool is in your available tools. Use it only for narrow research/verification; report when you used it and remain responsible for judgment." : "DISABLED. You cannot launch subagents in this run. Do not claim you used them."}
- Scratch/prototype experiments: ${canPrototype ? `ENABLED via ${PROTOTYPE_TOOL}. Use it for throwaway code, timing checks, small simulations, parsing experiments, or executable sanity checks. Debate dir: ${debateDir ?? "(not supplied)"}` : "DISABLED. Do not claim you ran code experiments unless you actually used a tool."}

Tool policy:
- Default tools are read/search only: read, grep, find, ls.
- If bash is granted, you may use it for local inspection and controlled research commands. Do not mutate project state.
- If a web/search tool is installed and explicitly included in available tools, you may use it.
- If subagent is explicitly included in available tools, you may delegate only narrow research/verification tasks; you remain responsible for final judgment.
- If subagent is not in available tools, do not pretend you used it.
- If debate_scratch is included, keep generated code/data small and disposable. Cite the scratch artifact paths and important command output in your critique.

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
	return `# Expert Ideation Synthesizer

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
- Mark ILL_POSED if key terms/goals/constraints are too undefined to debate productively.
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
	debateDir: string;
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
${args.prototyping ? `- Enabled. Use ${PROTOTYPE_TOOL} with debateDir=${args.debateDir} and expertName=${args.expertName}. Cite generated artifact paths and key outputs.` : "- Disabled."}

Write your answer in the strict format. End with exactly one VERDICT line.`;
}

function plannerSystemPrompt(intensity: Intensity): string {
	return `# Expert Panel Designer

You design a small, high-signal expert panel for technical ideation.

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
	return `Read the idea and choose the best expert panel.

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
				tools?: unknown;
				model?: unknown;
				assistantBriefs?: Array<{ agent?: unknown; task?: unknown; model?: unknown }>;
			}>;
		};
		const experts = (parsed.experts ?? [])
			.map((e) => ({
				name: String(e.name ?? "").toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-|-$/g, ""),
				stance: String(e.stance ?? "").trim(),
				tools: typeof e.tools === "string" ? e.tools : undefined,
				model: typeof e.model === "string" ? e.model : undefined,
				assistantBriefs: Array.isArray(e.assistantBriefs)
					? e.assistantBriefs
						.map((b) => ({
							agent: ["scout", "researcher", "oracle", "delegate"].includes(String(b.agent ?? "")) ? (String(b.agent) as any) : "scout",
							task: String(b.task ?? "").trim(),
							model: typeof b.model === "string" ? b.model : undefined,
						}))
						.filter((b) => b.task)
						.slice(0, 3)
					: undefined,
			}))
			.filter((e) => e.name && e.stance)
			.slice(0, 4);
		return experts.length >= 2 ? experts : null;
	} catch {
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
	debateDir: string;
	research: boolean;
	juniorModel: string;
	signal?: AbortSignal;
	onUpdate?: (text: string) => void;
}): Promise<string> {
	const safeName = args.expert.name.replace(/[^\w.-]+/g, "_");
	const out = path.join(args.debateDir, `round_${args.round}_${safeName}_assistant_brief.md`);
	const context = args.contextPaths.length ? args.contextPaths.map((p) => `- ${p}`).join("\n") : "- none supplied";
	const fallbackBriefs = [
		{
			agent: "scout" as const,
			task: `Create a local/code/context scouting brief for expert ${args.expert.name}.\n\nExpert stance:\n${args.expert.stance}\n\nIdea file: ${args.ideaPath}\nWorking synthesis: ${args.workingPath}\nContext paths:\n${context}\n\nFocus on facts this expert should know before critique. Cite files/paths. Do not edit project files.`,
		},
		...(args.research
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
		if (agent === "researcher" && !args.research) {
			content += `\n\n## ${i + 1}. researcher subagent skipped\n\nResearch brief requested by planner, but --research was not enabled. Re-run with --research --subagents for web-backed research.\n\nTask:\n${brief.task}\n`;
			continue;
		}
		const model = brief.model ?? args.juniorModel;
		const agentSpec = model ? `${agent}[model=${model}]` : agent;
		const task = `${brief.task}\n\nExpert receiving this brief: ${args.expert.name}\nExpert stance:\n${args.expert.stance}\n\nIdea file: ${args.ideaPath}\nWorking synthesis: ${args.workingPath}\nContext paths:\n${context}\n\nOutput a concise evidence brief. Do not decide the final verdict; the main expert owns judgment.`;
		const run = await runPiJsonPrompt({
			name: `${args.expert.name}-${agent}-subagent`,
			prompt: `/run ${agentSpec} ${shellQuoteForSlash(task)}`,
			cwd: args.baseCwd,
			tools: "subagent",
			signal: args.signal,
			onProgress: args.onUpdate,
		});
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
	const match = text.match(/^STATUS:\s*(ACCEPT|ITERATE|REJECT|ILL_POSED|UNRESOLVED)\s*$/im);
	return (match?.[1] as ResolutionStatus | undefined) ?? "UNRESOLVED";
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
	const chunks: string[] = ["# Expert panel transcript", "", `Final synthesis: ${finalSynthesis}`, ""];
	for (const file of roundFiles) {
		chunks.push("---", "", `## ${path.basename(file)}`, "", `Path: ${file}`, "");
		chunks.push(await fs.readFile(file, "utf8").catch((err) => `[could not read: ${String(err)}]`));
		chunks.push("");
	}
	return chunks.join("\n");
}

async function generateHtmlReport(args: {
	debateDir: string;
	ideaPath: string;
	workflowPath: string;
	answersPath: string;
	finalPath: string;
	transcriptPath: string;
	roundFiles: string[];
	result: Omit<DebateResult, "summary" | "reportPath">;
}): Promise<string> {
	const reportPath = path.join(args.debateDir, "report.html");
	const scratchRoot = path.join(args.debateDir, "scratch");
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
			parts.push(`<details><summary>${escapeHtml(title)}: ${escapeHtml(path.relative(args.debateDir, file))}</summary><pre>${escapeHtml(content)}</pre></details>`);
		}
		return parts.join("\n");
	};
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Technical debate report — ${escapeHtml(args.result.status)}</title>
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
<h1>Technical debate report <span class="badge">${escapeHtml(args.result.status)}</span></h1>
<p class="path">${escapeHtml(args.debateDir)}</p>
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
		`Technical debate round ${round}: answer blocking questions (optional)`,
		`${prefill}\n\nLeave blank/close to skip. Your answers become authoritative.`,
	);
	if (!answer?.trim()) return false;
	await writeFileQueued(answersPath, `${await fs.readFile(answersPath, "utf8").catch(() => "")}\n\n## Round ${round} user answers\n\n${answer.trim()}\n`);
	return true;
}

async function runDebate(
	pi: ExtensionAPI,
	params: DebateInput,
	ctx: any,
	signal?: AbortSignal,
	onUpdate?: (text: string) => void,
	onArtifact?: (artifact: { kind: "critique" | "synthesis"; round: number; name: string; path: string; text: string }) => void,
	onPanelEvent?: (event: PanelEvent) => void,
): Promise<DebateResult> {
	const baseCwd = resolveMaybe(ctx.cwd, params.cwd ?? ".");
	const rounds = Math.max(1, Math.min(MAX_ROUNDS, params.rounds ?? DEFAULT_ROUNDS));
	const intensity = (params.intensity ?? "ruthless") as Intensity;
	const workshop = Boolean(params.workshop);
	const researchEnabled = Boolean(params.research || workshop);
	const parentBriefsEnabled = Boolean(params.subagents || workshop);
	const expertSubagentsEnabled = Boolean(params.expertSubagents || workshop);
	const prototypingEnabled = Boolean(params.prototyping || workshop);
	const htmlReportEnabled = Boolean(params.htmlReport || workshop);
	const inheritedModel = activeModelRef(ctx);
	const inheritedProvider = activeProvider(ctx);
	const strongModel = params.strongModel ?? inheritedModel ?? DEFAULT_STRONG_MODEL;
	const plannerModel = params.plannerModel ?? strongModel;
	const expertModel = params.expertModel ?? strongModel;
	const synthModel = params.synthModel ?? strongModel;
	const juniorModel = params.juniorModel ?? providerQualifiedIfAvailable(ctx, inheritedProvider, DEFAULT_JUNIOR_MODEL) ?? inheritedModel ?? DEFAULT_JUNIOR_MODEL;
	const contextPaths = (params.contextPaths ?? []).map((p) => resolveMaybe(baseCwd, p));
	const debateDir = params.outputDir
		? resolveMaybe(baseCwd, params.outputDir)
		: path.join(baseCwd, ".pi", "technical-debates", `${timestampSlug()}-${slugify(params.idea)}`);
	await fs.mkdir(debateDir, { recursive: true });

	const ideaPath = path.join(debateDir, "idea.md");
	const workingPath = path.join(debateDir, "working-resolution.md");
	const answersPath = path.join(debateDir, "user-answers.md");
	const transcriptPath = path.join(debateDir, "transcript.md");
	const finalPath = path.join(debateDir, "resolution.md");
	const workflowPath = path.join(debateDir, "workflow.md");
	await writeFileQueued(ideaPath, `# Technical idea under debate\n\n${params.idea.trim()}\n`);
	await writeFileQueued(
		workingPath,
		`# Working resolution\n\nInitial idea is untested. Experts must converge on ACCEPT, ITERATE, REJECT, ILL_POSED, or UNRESOLVED.\n`,
	);
	await writeFileQueued(answersPath, "# User answers / rulings\n");

	const allRoundFiles: string[] = [];
	let experts: ExpertInput[] = params.experts?.length ? params.experts : DEFAULT_EXPERTS;
	if (!params.experts?.length && params.planExperts !== false) {
		onUpdate?.("Planning expert panel");
		onPanelEvent?.({ type: "planner_start" });
		const planPath = path.join(debateDir, "panel-plan.md");
		const planner = await runChildPi({
			name: "panel-designer",
			systemPrompt: plannerSystemPrompt(intensity),
			userPrompt: buildPlannerPrompt(ideaPath, contextPaths),
			cwd: baseCwd,
			model: plannerModel,
			tools: researchEnabled ? RESEARCH_TOOLS : DEFAULT_TOOLS,
			signal,
			runDir: debateDir,
			onProgress: onUpdate,
		});
		await writeFileQueued(planPath, planner.text);
		allRoundFiles.push(planPath);
		const planned = parsePlannedExperts(planner.text);
		if (planned) experts = planned;
		onPanelEvent?.({ type: "planner_done", experts: experts.map((e) => e.name), path: planPath });
	}
	const baseExpertTools = researchEnabled ? RESEARCH_TOOLS : DEFAULT_TOOLS;
	experts = experts.slice(0, 4).map((expert) => {
		let tools = expert.tools ?? baseExpertTools;
		if (expertSubagentsEnabled) tools = withTool(tools, "subagent");
		if (prototypingEnabled) tools = withTool(tools, PROTOTYPE_TOOL);
		return {
			...expert,
			model: expert.model ?? expertModel,
			tools,
		};
	});
	const mainExpertsCanUseSubagents = experts.some((expert) => toolListIncludes(expert.tools, "subagent"));
	const subagentWorkflow = [
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
			? `Experts can run throwaway experiments through ${PROTOTYPE_TOOL}; artifacts are under scratch/<expert>/ and included in report.html.`
			: `Experts cannot run scratch experiments unless --prototype/--workshop or prototyping=true is used.`,
	];
	await writeFileQueued(workflowPath, `# Technical debate workflow\n\n${subagentWorkflow.map((line) => `- ${line}`).join("\n")}\n\n## Expert tools\n\n${experts.map((expert) => `- ${expert.name}: ${expert.tools}`).join("\n")}\n`);
	allRoundFiles.push(workflowPath);
	onPanelEvent?.({ type: "delegation_policy", lines: subagentWorkflow });
	onUpdate?.(`Workflow: parent briefs ${parentBriefsEnabled ? "enabled" : "disabled"}; main expert subagents ${mainExpertsCanUseSubagents ? "enabled" : "disabled"}; prototypes ${prototypingEnabled ? "enabled" : "disabled"}; HTML ${htmlReportEnabled ? "enabled" : "disabled"}.`);

	let previousSynthesisPath: string | undefined;
	let status: ResolutionStatus = "UNRESOLVED";
	let converged = false;
	let roundsRun = 0;

	for (let round = 1; round <= rounds; round++) {
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
						debateDir,
						research: researchEnabled,
						juniorModel,
						signal,
						onUpdate,
					});
					assistantBriefs.set(expert.name, [briefPath]);
					allRoundFiles.push(briefPath);
					onPanelEvent?.({ type: "brief_done", round, name: expert.name, path: briefPath });
				} catch (error) {
					const safeName = expert.name.replace(/[^\w.-]+/g, "_");
					const briefPath = path.join(debateDir, `round_${round}_${safeName}_assistant_brief_error.md`);
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
					.map((e) => path.join(debateDir, `round_${round - 1}_${e.name.replace(/[^\w.-]+/g, "_")}.md`))
					.filter((p) => fssync.existsSync(p))
				: [];

		if (round === 1) {
			await Promise.all(
				experts.map(async (expert) => {
					const out = path.join(debateDir, `round_${round}_${expert.name.replace(/[^\w.-]+/g, "_")}.md`);
					onPanelEvent?.({ type: "expert_start", round, name: expert.name });
					const run = await runChildPi({
						name: expert.name,
						systemPrompt: expertSystemPrompt(expert, intensity, expert.tools ?? DEFAULT_TOOLS, parentBriefsEnabled, prototypingEnabled, debateDir),
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
							debateDir,
						}),
						cwd: baseCwd,
						model: expert.model,
						tools: expert.tools,
						signal,
						runDir: debateDir,
						onProgress: onUpdate,
						onActivity: (text) => onPanelEvent?.({ type: "expert_activity", round, name: expert.name, text }),
					});
					await writeFileQueued(out, run.text);
					onPanelEvent?.({ type: "expert_done", round, name: expert.name, path: out, text: run.text });
					onArtifact?.({ kind: "critique", round, name: expert.name, path: out, text: run.text });
					critiquePaths.push(out);
				}),
			);
		} else {
			for (const expert of experts) {
				const out = path.join(debateDir, `round_${round}_${expert.name.replace(/[^\w.-]+/g, "_")}.md`);
				onPanelEvent?.({ type: "expert_start", round, name: expert.name });
				const run = await runChildPi({
					name: expert.name,
					systemPrompt: expertSystemPrompt(expert, intensity, expert.tools ?? DEFAULT_TOOLS, parentBriefsEnabled, prototypingEnabled, debateDir),
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
						debateDir,
					}),
					cwd: baseCwd,
					model: expert.model,
					tools: expert.tools,
					signal,
					runDir: debateDir,
					onProgress: onUpdate,
					onActivity: (text) => onPanelEvent?.({ type: "expert_activity", round, name: expert.name, text }),
				});
				await writeFileQueued(out, run.text);
				onPanelEvent?.({ type: "expert_done", round, name: expert.name, path: out, text: run.text });
				onArtifact?.({ kind: "critique", round, name: expert.name, path: out, text: run.text });
				critiquePaths.push(out);
			}
		}

		critiquePaths.sort();
		allRoundFiles.push(...critiquePaths);
		onUpdate?.(`Round ${round}/${rounds}: synthesis`);
		onPanelEvent?.({ type: "synth_start", round });
		const synthOut = path.join(debateDir, `round_${round}_synthesis.md`);
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
			tools: researchEnabled ? RESEARCH_TOOLS : DEFAULT_TOOLS,
			signal,
			runDir: debateDir,
			onProgress: onUpdate,
		});
		await writeFileQueued(synthOut, synth.text);
		onArtifact?.({ kind: "synthesis", round, name: "synthesizer", path: synthOut, text: synth.text });
		await writeFileQueued(workingPath, synth.text);
		allRoundFiles.push(synthOut);
		previousSynthesisPath = synthOut;
		status = parseStatus(synth.text);
		converged = parseConverged(synth.text);
		onPanelEvent?.({ type: "synth_done", round, path: synthOut, text: synth.text, status, converged });

		const questions = extractQuestions(synth.text);
		if (questions.length) onPanelEvent?.({ type: "questions", round, questions });
		const userAnswered = params.interactive ? await askUserForQuestions(ctx, round, questions, answersPath) : false;
		if (userAnswered && round < rounds) converged = false;
		if (converged) break;
	}

	const finalText = await fs.readFile(workingPath, "utf8");
	const truncation = truncateHead(finalText, { maxBytes: OUTPUT_CAP_BYTES, maxLines: 2000 });
	await writeFileQueued(finalPath, finalText);
	await writeFileQueued(transcriptPath, await formatTranscript(allRoundFiles, finalPath));

	let reportPath: string | undefined;
	const resultBase = {
		status,
		converged,
		roundsRun,
		debateDir,
		transcriptPath,
		resolutionPath: finalPath,
		workflowPath,
		experts: experts.map((e) => e.name),
		subagentWorkflow,
	};
	if (htmlReportEnabled) {
		reportPath = await generateHtmlReport({
			debateDir,
			ideaPath,
			workflowPath,
			answersPath,
			finalPath,
			transcriptPath,
			roundFiles: allRoundFiles,
			result: resultBase,
		});
	}

	const summary = [
		`# Expert panel resolution`,
		``,
		`Status: **${status}**`,
		`Converged: **${converged ? "yes" : "no"}** after ${roundsRun} round${roundsRun === 1 ? "" : "s"}`,
		`Experts: ${experts.map((e) => e.name).join(", ")}`,
		``,
		`Artifacts:`,
		`- Resolution: ${finalPath}`,
		`- Workflow: ${workflowPath}`,
		reportPath ? `- HTML report: ${reportPath}` : undefined,
		`- Transcript: ${transcriptPath}`,
		`- Debate dir: ${debateDir}`,
		``,
		`Subagent workflow:`,
		...subagentWorkflow.map((line) => `- ${line}`),
		``,
		`---`,
		``,
		truncation.content,
		truncation.truncated ? `\n\n[Resolution truncated in tool output; full file at ${finalPath}]` : "",
	].filter((line): line is string => line !== undefined).join("\n");

	const result: DebateResult = {
		summary,
		...resultBase,
		reportPath,
	};
	onPanelEvent?.({ type: "final", result });
	return result;
}

type LaneState = { name: string; status: "queued" | "running" | "done"; activity: string[]; path?: string };
type DashboardState = {
	round: number;
	rounds: number;
	phase: string;
	lanes: Map<string, LaneState>;
	synthesis?: { status?: ResolutionStatus; converged?: boolean; activity: string[]; path?: string };
	questions: string[];
	delegation: string[];
	final?: DebateResult;
};

function createDashboardState(): DashboardState {
	return { round: 0, rounds: 0, phase: "starting", lanes: new Map(), synthesis: { activity: [] }, questions: [], delegation: [] };
}

function pushActivity(items: string[], text: string, limit = 4): void {
	const trimmed = text.replace(/\s+/g, " ").trim();
	if (!trimmed) return;
	items.push(trimmed);
	while (items.length > limit) items.shift();
}

function updateDashboardState(state: DashboardState, event: PanelEvent): void {
	if (event.type === "planner_start") {
		state.phase = "planning expert panel";
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
		state.synthesis = { status: event.status, converged: event.converged, activity: [], path: event.path };
		pushActivity(state.synthesis.activity, `${event.status} / converged=${event.converged ? "yes" : "no"}`);
		return;
	}
	if (event.type === "questions") {
		state.questions = event.questions;
		state.phase = "awaiting user input";
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

function renderDashboardLines(state: DashboardState, theme: any, width: number): string[] {
	const w = Math.max(50, width);
	const lines: string[] = [];
	const phase = state.final
		? `${state.final.status} (${state.final.converged ? "converged" : "not converged"})`
		: `${state.phase} • round ${state.round || "?"}/${state.rounds || "?"}`;
	lines.push(truncateToWidth(theme.fg("accent", theme.bold("expert panel observatory")) + theme.fg("muted", `  ${phase}`), w));

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
	return lines.slice(0, 28);
}

function installDashboardWidget(ctx: any, state: DashboardState): void {
	ctx.ui.setWidget(
		"technical-debate-dashboard",
		(_tui: any, theme: any) => ({
			render: (width: number) => renderDashboardLines(state, theme, width),
			invalidate: () => {},
		}),
		{ placement: "aboveEditor" },
	);
}

async function listDebateSessions(cwd: string): Promise<Array<{ dir: string; label: string; mtimeMs: number; status?: string }>> {
	const roots: string[] = [];
	let probe = cwd;
	while (true) {
		const root = path.join(probe, ".pi", "technical-debates");
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

function parseDebateCommand(args: string): Pick<DebateInput, "idea" | "rounds" | "intensity" | "research" | "planExperts" | "subagents" | "expertSubagents" | "prototyping" | "htmlReport" | "workshop" | "strongModel" | "plannerModel" | "expertModel" | "juniorModel" | "synthModel"> & { keepDashboard?: boolean } {
	const parts = args.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
	let rounds = DEFAULT_ROUNDS;
	let intensity: Intensity = "ruthless";
	let research = false;
	let planExperts = true;
	let keepDashboard = false;
	let subagents = false;
	let expertSubagents = false;
	let prototyping = false;
	let htmlReport = false;
	let workshop = false;
	let strongModel: string | undefined;
	let plannerModel: string | undefined;
	let expertModel: string | undefined;
	let juniorModel: string | undefined;
	let synthModel: string | undefined;
	const ideaParts: string[] = [];
	for (let i = 0; i < parts.length; i++) {
		const raw = parts[i].replace(/^"|"$/g, "");
		if (raw === "--rounds" && parts[i + 1]) {
			rounds = Number(parts[++i].replace(/^"|"$/g, ""));
			continue;
		}
		if (raw.startsWith("--rounds=")) {
			rounds = Number(raw.slice("--rounds=".length));
			continue;
		}
		if (raw === "--intensity" && parts[i + 1]) {
			intensity = parts[++i].replace(/^"|"$/g, "") as Intensity;
			continue;
		}
		if (raw.startsWith("--intensity=")) {
			intensity = raw.slice("--intensity=".length) as Intensity;
			continue;
		}
		if (raw === "--research" || raw === "--web") {
			research = true;
			continue;
		}
		if (raw === "--fixed-experts" || raw === "--no-plan") {
			planExperts = false;
			continue;
		}
		if (raw === "--keep-dashboard") {
			keepDashboard = true;
			continue;
		}
		if (raw === "--subagents" || raw === "--briefs") {
			subagents = true;
			continue;
		}
		if (raw === "--expert-subagents" || raw === "--allow-expert-subagents") {
			expertSubagents = true;
			continue;
		}
		if (raw === "--prototype" || raw === "--prototypes" || raw === "--prototyping") {
			prototyping = true;
			continue;
		}
		if (raw === "--html-report" || raw === "--report") {
			htmlReport = true;
			continue;
		}
		if (raw === "--workshop" || raw === "--rlm") {
			workshop = true;
			research = true;
			subagents = true;
			expertSubagents = true;
			prototyping = true;
			htmlReport = true;
			continue;
		}
		const readValue = (prefix: string): string | undefined => {
			if (raw === prefix && parts[i + 1]) return parts[++i].replace(/^"|"$/g, "");
			if (raw.startsWith(`${prefix}=`)) return raw.slice(prefix.length + 1);
			return undefined;
		};
		const strong = readValue("--strong-model");
		if (strong) { strongModel = strong; continue; }
		const planner = readValue("--planner-model");
		if (planner) { plannerModel = planner; continue; }
		const expert = readValue("--expert-model");
		if (expert) { expertModel = expert; continue; }
		const junior = readValue("--junior-model");
		if (junior) { juniorModel = junior; continue; }
		const synth = readValue("--synth-model");
		if (synth) { synthModel = synth; continue; }
		ideaParts.push(raw);
	}
	return { idea: ideaParts.join(" ").trim(), rounds, intensity, research, planExperts, subagents, expertSubagents, prototyping, htmlReport, workshop, strongModel, plannerModel, expertModel, juniorModel, synthModel, keepDashboard };
}

export default function technicalDebate(pi: ExtensionAPI) {
	pi.registerMessageRenderer("technical-debate", (message, _options, _theme) => {
		return new Markdown(String(message.content ?? ""), 0, 0, getMarkdownTheme());
	});

	pi.registerTool({
		name: PROTOTYPE_TOOL,
		label: "Debate Scratchpad",
		description:
			"Create/run small throwaway prototype experiments for a technical_debate expert inside the debate artifact directory. Enforces all files stay under <debateDir>/scratch/<expertName> and records command output for the final report.",
		promptSnippet: "Run isolated scratch/prototype code experiments for expert-panel debates and save outputs as artifacts.",
		promptGuidelines: [
			"Use debate_scratch only when technical_debate/workshop prompts provide a debateDir; keep experiments small, cite artifact paths, and do not use it for project mutations.",
		],
		parameters: Type.Object({
			debateDir: Type.String({ description: "Absolute or cwd-relative .pi/technical-debates/<run> artifact directory" }),
			expertName: Type.String({ description: "Expert lane/name using this scratchpad" }),
			label: Type.Optional(Type.String({ description: "Short label for this run, e.g. timing-check or parser-prototype" })),
			files: Type.Optional(Type.Array(Type.Object({
				path: Type.String({ description: "Relative path under this expert's scratch directory" }),
				content: Type.String(),
			}), { description: "Optional files to create before running the command" })),
			command: Type.Optional(Type.String({ description: "Optional shell command to run from the expert scratch directory" })),
			timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 120, default: 20 })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const debateDir = resolveMaybe(ctx.cwd, params.debateDir);
			if (!debateDir.includes(`${path.sep}.pi${path.sep}technical-debates${path.sep}`)) {
				throw new Error("debateDir must point inside a .pi/technical-debates run directory");
			}
			const scratchRoot = path.join(debateDir, "scratch", safeSegment(params.expertName));
			await fs.mkdir(scratchRoot, { recursive: true });
			const writtenFiles: string[] = [];
			for (const file of params.files ?? []) {
				if (path.isAbsolute(file.path)) throw new Error(`Scratch file path must be relative: ${file.path}`);
				const target = path.resolve(scratchRoot, file.path);
				assertInside(scratchRoot, target);
				await writeFileQueued(target, file.content);
				writtenFiles.push(target);
			}
			let stdout = "";
			let stderr = "";
			let code: number | undefined;
			let killed: boolean | undefined;
			if (params.command?.trim()) {
				const run = await pi.exec("bash", ["-lc", params.command], {
					cwd: scratchRoot,
					signal,
					timeout: (params.timeoutSeconds ?? 20) * 1000,
				});
				stdout = run.stdout ?? "";
				stderr = run.stderr ?? "";
				code = run.code;
				killed = run.killed;
			}
			const label = safeSegment(params.label ?? params.command?.split("\n")[0] ?? "scratch-run");
			const artifactPath = path.join(scratchRoot, `${timestampSlug()}-${label}.md`);
			const outTrunc = truncateHead(stdout, { maxBytes: 20 * 1024, maxLines: 500 });
			const errTrunc = truncateHead(stderr, { maxBytes: 10 * 1024, maxLines: 300 });
			const artifact = [
				`# Scratch run: ${params.label ?? label}`,
				``,
				`Expert: ${params.expertName}`,
				`Directory: ${scratchRoot}`,
				``,
				`## Files written`,
				...(writtenFiles.length ? writtenFiles.map((file) => `- ${file}`) : ["- none"]),
				``,
				`## Command`,
				"```bash",
				params.command ?? "(none)",
				"```",
				`Exit code: ${code ?? "not run"}${killed ? " (killed/timeout)" : ""}`,
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
				content: [{ type: "text", text: `Scratch artifact: ${artifactPath}\nExit code: ${code ?? "not run"}\n\nstdout:\n${outTrunc.content || "(empty)"}\n\nstderr:\n${errTrunc.content || "(empty)"}` }],
				details: { scratchRoot, artifactPath, writtenFiles, code, killed, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr) },
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("debate_scratch ")) + theme.fg("accent", args.expertName ?? "expert") + "\n" + theme.fg("dim", args.label ?? args.command ?? "scratch run"), 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as { artifactPath?: string; code?: number } | undefined;
			return new Text(`${theme.fg("success", "✓")} ${theme.fg("toolTitle", "scratch")}: ${theme.fg("accent", String(details?.code ?? "not run"))}\n${theme.fg("dim", details?.artifactPath ?? "")}`, 0, 0);
		},
	});

	pi.registerTool({
		name: "technical_debate",
		label: "Expert Ideation Panel",
		description:
			"Run an intense multi-agent expert ideation/debate panel over an idea until experts converge on ACCEPT, ITERATE, REJECT, ILL_POSED, or hit the round cap. Writes artifacts under .pi/technical-debates by default.",
		promptSnippet: "Ideate and stress-test technical ideas with independent world-class expert subprocesses until a shared resolution or round cap.",
		promptGuidelines: [
			"Use technical_debate when the user asks to debate, ideate, stress-test, grill, or resolve a technical idea with multiple expert viewpoints.",
			"technical_debate can improve an idea, conclude it needs iteration, reject it, or declare it too poorly posed to proceed.",
			"Set technical_debate workshop=true when the user wants RLM-style recursive delegation, expert subagent calls, executable scratch prototypes, background research, and an HTML report of evidence.",
		],
		parameters: DebateParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const result = await runDebate(
				pi,
				params,
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
				theme.fg("toolTitle", theme.bold("expert_panel ")) +
					theme.fg("accent", `${args.rounds ?? DEFAULT_ROUNDS} rounds`) +
					"\n" +
					theme.fg("dim", preview),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const details = result.details as DebateResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			const icon = details.converged ? theme.fg("success", "✓") : theme.fg("warning", "◐");
			return new Text(
				`${icon} ${theme.fg("toolTitle", theme.bold("expert panel"))} ${theme.fg("accent", details.status)}\n` +
					`${theme.fg("muted", `${details.roundsRun} rounds • ${details.experts.join(", ")}`)}\n` +
					`${theme.fg("dim", details.reportPath ?? details.resolutionPath)}`,
				0,
				0,
			);
		},
	});

	const runIdeationCommand = async (args: string, ctx: any, commandName: "debate" | "ideate") => {
		const parsed = parseDebateCommand(args);
		let idea = parsed.idea;
		if (!idea) {
			if (!ctx.hasUI) {
				ctx.ui.notify(`Usage: /${commandName} <technical idea>`, "warning");
				return;
			}
			const edited = await ctx.ui.editor(
				"Technical idea for expert panel",
				"Paste proposal / PRD excerpt / architecture here...\n\nFlags: --workshop --rounds 4 --intensity ruthless --research --subagents --expert-subagents --prototype --html-report --fixed-experts",
			);
			idea = edited?.trim() ?? "";
		}
		if (!idea) {
			ctx.ui.notify("Expert panel canceled: no idea provided", "warning");
			return;
		}
		const dashboard = createDashboardState();
		if (ctx.hasUI) installDashboardWidget(ctx, dashboard);
		ctx.ui.setStatus("technical-debate", "expert panel starting...");
		try {
			const result = await runDebate(
				pi,
				{ ...parsed, idea, interactive: true },
				ctx,
				undefined,
				(text) => ctx.ui.setStatus("technical-debate", text),
				(artifact) => {
					const title =
						artifact.kind === "critique"
							? `# Round ${artifact.round}: ${artifact.name} critique`
							: `# Round ${artifact.round}: synthesis`;
					pi.sendMessage({
						customType: "technical-debate",
						content: `${title}\n\nPath: ${artifact.path}\n\n---\n\n${artifact.text}`,
						display: true,
						details: artifact,
					});
				},
				(event) => {
					updateDashboardState(dashboard, event);
					if (ctx.hasUI) installDashboardWidget(ctx, dashboard);
				},
			);
			pi.sendMessage({ customType: "technical-debate", content: result.summary, display: true, details: result });
		} finally {
			ctx.ui.setStatus("technical-debate", undefined);
			if (!parsed.keepDashboard) ctx.ui.setWidget("technical-debate-dashboard", undefined);
		}
	};

	pi.registerCommand("debate", {
		description:
			"Run an adversarial expert panel. Usage: /debate [--workshop] [--rounds 4] [--intensity ruthless] [--research] [--subagents] [--expert-subagents] [--prototype] [--html-report] [--fixed-experts] <idea>",
		handler: async (args, ctx) => runIdeationCommand(args, ctx, "debate"),
	});

	pi.registerCommand("ideate", {
		description:
			"Run a world-class expert ideation panel. Usage: /ideate [--workshop] [--rounds 4] [--intensity ruthless] [--research] [--subagents] [--expert-subagents] [--prototype] [--html-report] [--fixed-experts] <idea>",
		handler: async (args, ctx) => runIdeationCommand(args, ctx, "ideate"),
	});

	pi.registerCommand("ideate-hide", {
		description: "Hide the persistent expert-panel observatory widget",
		handler: async (_args, ctx) => {
			ctx.ui.setWidget("technical-debate-dashboard", undefined);
			ctx.ui.notify("Expert panel observatory hidden", "info");
		},
	});

	pi.registerCommand("ideate-sessions", {
		description: "Pick a previous ideation/debate session and show its saved resolution",
		handler: async (_args, ctx) => {
			const sessions = await listDebateSessions(ctx.cwd);
			if (sessions.length === 0) {
				ctx.ui.notify("No previous .pi/technical-debates sessions found", "warning");
				return;
			}
			const chosen = ctx.hasUI
				? await ctx.ui.select("Previous expert-panel sessions", sessions.map((s) => s.label))
				: sessions[0].label;
			const session = sessions.find((s) => s.label === chosen);
			if (!session) return;
			const resolutionPath = path.join(session.dir, "resolution.md");
			const resolution = await fs.readFile(resolutionPath, "utf8").catch(() => "(could not read resolution.md)");
			pi.sendMessage({
				customType: "technical-debate",
				content: `# Previous expert-panel session\n\nPath: ${session.dir}\n\n---\n\n${resolution}`,
				display: true,
				details: { dir: session.dir, resolutionPath },
			});
		},
	});

	pi.registerCommand("ideate-pickup", {
		description:
			"Continue from a previous expert-panel session. Usage: /ideate-pickup [--rounds 2] [--research] [optional session-dir or instructions]",
		handler: async (args, ctx) => {
			const parsed = parseDebateCommand(args);
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
				const sessions = await listDebateSessions(ctx.cwd);
				if (sessions.length === 0) {
					ctx.ui.notify("No previous .pi/technical-debates sessions found", "warning");
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
					"Continue previous expert-panel session",
					`${extraInstructions || "Answer open questions, tighten scope, or ask for next-round critique."}\n\nPrevious session:\n${targetDir}`,
				);
				extraInstructions = edited?.trim() ?? extraInstructions;
			}

			const idea = `Continue this previous expert-panel ideation session.\n\nPrevious session dir: ${targetDir}\nPrevious resolution:\n\n${previousResolution}\n\nUser continuation instructions:\n${extraInstructions || "Continue from remaining open questions and produce a sharper next resolution."}`;
			const dashboard = createDashboardState();
			if (ctx.hasUI) installDashboardWidget(ctx, dashboard);
			ctx.ui.setStatus("technical-debate", "picking up previous session...");
			try {
				const result = await runDebate(
					pi,
					{
						...parsed,
						idea,
						interactive: true,
						contextPaths: [resolutionPath, transcriptPath].filter((p) => fssync.existsSync(p)),
					},
					ctx,
					undefined,
					(text) => ctx.ui.setStatus("technical-debate", text),
					(artifact) => {
						const title = artifact.kind === "critique" ? `# Round ${artifact.round}: ${artifact.name} critique` : `# Round ${artifact.round}: synthesis`;
						pi.sendMessage({
							customType: "technical-debate",
							content: `${title}\n\nPath: ${artifact.path}\n\n---\n\n${artifact.text}`,
							display: true,
							details: artifact,
						});
					},
					(event) => {
						updateDashboardState(dashboard, event);
						if (ctx.hasUI) installDashboardWidget(ctx, dashboard);
					},
				);
				pi.sendMessage({ customType: "technical-debate", content: result.summary, display: true, details: result });
			} finally {
				ctx.ui.setStatus("technical-debate", undefined);
				if (!parsed.keepDashboard) ctx.ui.setWidget("technical-debate-dashboard", undefined);
			}
		},
	});
}
