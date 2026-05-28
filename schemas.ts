import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

export const MAX_ROUNDS = 8;
export const DEFAULT_ROUNDS = 4;
export const DEFAULT_TOOLS = "read,grep,find,ls";

export type Intensity = "normal" | "hard" | "ruthless";
export type ResolutionStatus = "ACCEPT" | "ITERATE" | "REJECT" | "ILL_POSED" | "UNRESOLVED" | "DEGRADED" | "FAILED" | "CANCELLED";

export const AssistantBriefSchema = Type.Object({
	agent: Type.Optional(StringEnum(["scout", "researcher"] as const, { default: "scout" })),
	task: Type.String({ description: "Narrow task for the junior assistant/subagent to investigate for this expert" }),
	model: Type.Optional(Type.String({ description: "Optional model for this assistant brief" })),
});

export const ExpertSchema = Type.Object({
	name: Type.String({ description: "Short expert name, e.g. 'aero' or 'scientific-programmer'" }),
	stance: Type.String({ description: "What this expert owns and how they should attack the idea" }),
	model: Type.Optional(Type.String({ description: "Privileged-only optional pi model id for this expert, e.g. anthropic/claude-sonnet-4" })),
	tools: Type.Optional(Type.String({ description: `Privileged-only comma-separated pi tools for this expert. Default: ${DEFAULT_TOOLS}` })),
	assistantBriefs: Type.Optional(Type.Array(AssistantBriefSchema, { description: "Tailored junior assistant brief tasks for this expert" })),
});

export const PublicExpertSchema = Type.Object({
	name: Type.String({ description: "Short expert name, e.g. 'aero' or 'scientific-programmer'" }),
	stance: Type.String({ description: "What this expert owns and how they should attack the idea" }),
});

export const WorkshopParams = Type.Object({
	idea: Type.String({ description: "Technical idea, proposal, PRD excerpt, architecture, or question to workshop" }),
	rounds: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_ROUNDS, default: DEFAULT_ROUNDS })),
	profile: Type.Optional(Type.String({ description: "Named config profile to apply, e.g. workshop or safe. --workshop is shorthand for profile=workshop." })),
	experts: Type.Optional(Type.Array(ExpertSchema, { minItems: 2, maxItems: 4 })),
	contextPaths: Type.Optional(
		Type.Array(Type.String(), { description: "Files/directories experts should inspect before making codebase claims" }),
	),
	interactive: Type.Optional(Type.Boolean({ description: "Ask the user to answer blocking open questions between rounds" })),
	outputDir: Type.Optional(Type.String({ description: "Directory for workshop artifacts. Default: .pi/workshops/<timestamp-slug>" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for child pi expert processes. Default: current pi cwd" })),
	strongModel: Type.Optional(Type.String({ description: "Model for meta-planner, main experts, and synthesizer when role-specific model is omitted. Defaults to the parent pi session's active model; required (either here or via pi-workshop.config.json models.strongModel) if no parent model is inherited." })),
	plannerModel: Type.Optional(Type.String({ description: "Optional pi model id for the panel-designer/meta-planner. Falls back to strongModel." })),
	expertModel: Type.Optional(Type.String({ description: "Optional default pi model id for main experts. Falls back to strongModel." })),
	juniorModel: Type.Optional(Type.String({ description: "Model for junior scout/researcher subagents. Defaults to the parent pi session's active model when not set in pi-workshop.config.json." })),
	synthModel: Type.Optional(Type.String({ description: "Optional pi model id for the synthesizer" })),
	webResearch: Type.Optional(
		Type.Boolean({
			description:
				"Grant default experts web/doc/code search tools without local shell access. Default false.",
		}),
	),
	localBash: Type.Optional(
		Type.Boolean({
			description:
				"Privileged slash/config-only: grant child experts local bash in addition to read/search tools. Default false.",
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
				"Run controlled parent-orchestrated pi-subagents briefing passes (scout, and researcher when webResearch=true) for each expert before critique. Main experts still do not launch subagents unless expertSubagents is true or explicit expert tools include subagent. Default false.",
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
				"Give experts a workshop_scratch tool for isolated throwaway code/timing experiments under the workshop artifact directory. Default false.",
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
				"Convenience shorthand for profile=workshop. The actual behavior is configurable in pi-workshop.config.json.",
		}),
	),
});

export const PublicWorkshopParams = Type.Object({
	idea: Type.String({ description: "Technical idea, proposal, PRD excerpt, architecture, or question to workshop" }),
	rounds: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_ROUNDS, default: DEFAULT_ROUNDS })),
	profile: Type.Optional(Type.String({ description: "Restricted named config profile. Assistant tool calls may use only safe non-privileged profiles such as 'safe'." })),
	experts: Type.Optional(Type.Array(PublicExpertSchema, { minItems: 2, maxItems: 4 })),
	contextPaths: Type.Optional(
		Type.Array(Type.String(), { description: "Files/directories experts should inspect before making codebase claims. Assistant tool calls must resolve existing paths inside the current cwd." }),
	),
	interactive: Type.Optional(Type.Boolean({ description: "Ask the user to answer blocking open questions between rounds" })),
	webResearch: Type.Optional(Type.Boolean({ description: "Allow web/doc/code-search tools for experts. Does not grant bash." })),
	planExperts: Type.Optional(Type.Boolean({ description: "When experts are not provided, run a panel-designer pass to choose 2-4 expert roles. Default true." })),
	subagents: Type.Optional(Type.Boolean({ description: "Run parent-orchestrated scout/researcher briefs. Does not grant experts direct subagent access." })),
	htmlReport: Type.Optional(Type.Boolean({ description: "Write a self-contained HTML report. Default false for assistant tool calls." })),
});

export type ExpertInput = Static<typeof ExpertSchema>;
export type WorkshopInput = Static<typeof WorkshopParams>;
export type PublicWorkshopInput = Static<typeof PublicWorkshopParams>;
