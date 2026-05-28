import * as fs from "node:fs/promises";
import * as fssync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_ROUNDS, DEFAULT_ROUNDS, type WorkshopInput } from "./schemas.ts";
import { selectRequestedProfile } from "./logic.js";

const DEFAULT_SCRATCH_TIMEOUT_SECONDS = 60;
const DEFAULT_MAX_SCRATCH_TIMEOUT_SECONDS = 300;
const DEFAULT_CHILD_TIMEOUT_SECONDS = 20 * 60;
const DEFAULT_GLOBAL_TIMEOUT_SECONDS = 2 * 60 * 60;

export type WorkshopConfig = {
	defaults?: Partial<Omit<WorkshopInput, "idea" | "experts" | "contextPaths" | "outputDir" | "cwd">> & { keepDashboard?: boolean; openObservatory?: boolean };
	profiles?: Record<string, Partial<Omit<WorkshopInput, "idea" | "experts" | "contextPaths" | "outputDir" | "cwd">> & { keepDashboard?: boolean; openObservatory?: boolean }>;
	models?: {
		strongModel?: string;
		plannerModel?: string;
		expertModel?: string;
		juniorModel?: string;
		synthModel?: string;
	};
	limits?: {
		maxRounds?: number;
		scratchTimeoutSeconds?: number;
		maxScratchTimeoutSeconds?: number;
		childTimeoutSeconds?: number;
		globalTimeoutSeconds?: number;
	};
};

export type ResolvedWorkshopConfig = {
	params: WorkshopInput & { keepDashboard?: boolean; openObservatory?: boolean };
	limits: Required<NonNullable<WorkshopConfig["limits"]>>;
	configPaths: string[];
	projectConfigPath?: string;
	projectConfig?: WorkshopConfig;
	profile?: string;
};

const BUILTIN_CONFIG: Required<Pick<WorkshopConfig, "defaults" | "profiles" | "models" | "limits">> = {
	defaults: {
		rounds: DEFAULT_ROUNDS,
		webResearch: false,
		localBash: false,
		planExperts: true,
		subagents: false,
		expertSubagents: false,
		prototyping: false,
		htmlReport: false,
		workshop: false,
		keepDashboard: false,
		openObservatory: false,
	},
	profiles: {
		workshop: {
			webResearch: true,
			localBash: true,
			subagents: true,
			expertSubagents: true,
			prototyping: true,
			htmlReport: true,
		},
		safe: {
			webResearch: true,
			localBash: false,
			subagents: true,
			expertSubagents: false,
			prototyping: false,
			htmlReport: true,
		},
	},
	models: {},
	limits: {
		maxRounds: MAX_ROUNDS,
		scratchTimeoutSeconds: DEFAULT_SCRATCH_TIMEOUT_SECONDS,
		maxScratchTimeoutSeconds: DEFAULT_MAX_SCRATCH_TIMEOUT_SECONDS,
		childTimeoutSeconds: DEFAULT_CHILD_TIMEOUT_SECONDS,
		globalTimeoutSeconds: DEFAULT_GLOBAL_TIMEOUT_SECONDS,
	},
};

function mergeConfig(a: WorkshopConfig, b: WorkshopConfig): WorkshopConfig {
	const profiles: NonNullable<WorkshopConfig["profiles"]> = { ...(a.profiles ?? {}) };
	for (const [name, profile] of Object.entries(b.profiles ?? {})) {
		profiles[name] = { ...(profiles[name] ?? {}), ...profile };
	}
	return {
		defaults: { ...(a.defaults ?? {}), ...(b.defaults ?? {}) },
		profiles,
		models: { ...(a.models ?? {}), ...(b.models ?? {}) },
		limits: { ...(a.limits ?? {}), ...(b.limits ?? {}) },
	};
}

export function definedOnly<T extends Record<string, any>>(obj: T): Partial<T> {
	return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function assertKnownKeys(obj: Record<string, unknown>, allowed: string[], where: string): void {
	for (const key of Object.keys(obj)) {
		if (!allowed.includes(key)) throw new Error(`Unknown pi-workshop config key ${where}.${key}`);
	}
}

function booleanOrUndefined(value: unknown, where: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new Error(`${where} must be a boolean`);
	return value;
}

function stringOrUndefined(value: unknown, where: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.trim()) throw new Error(`${where} must be a non-empty string`);
	return value;
}

function positiveIntegerOrUndefined(value: unknown, where: string, max = Number.MAX_SAFE_INTEGER): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > max) throw new Error(`${where} must be a finite integer between 1 and ${max}`);
	return Number(value);
}

const PARAM_CONFIG_KEYS = [
	"rounds", "profile", "interactive", "webResearch", "localBash", "planExperts", "subagents",
	"expertSubagents", "prototyping", "htmlReport", "workshop", "strongModel", "plannerModel", "expertModel",
	"juniorModel", "synthModel", "keepDashboard", "openObservatory",
];

function validateParamConfig(raw: unknown, where: string): Record<string, unknown> {
	if (raw === undefined) return {};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where} must be an object`);
	const obj = { ...(raw as Record<string, unknown>) };
	assertKnownKeys(obj, PARAM_CONFIG_KEYS, where);
	if (obj.rounds !== undefined) obj.rounds = positiveIntegerOrUndefined(obj.rounds, `${where}.rounds`, MAX_ROUNDS);
	for (const key of ["interactive", "webResearch", "localBash", "planExperts", "subagents", "expertSubagents", "prototyping", "htmlReport", "workshop", "keepDashboard", "openObservatory"]) {
		obj[key] = booleanOrUndefined(obj[key], `${where}.${key}`);
	}
	for (const key of ["profile", "strongModel", "plannerModel", "expertModel", "juniorModel", "synthModel"]) {
		obj[key] = stringOrUndefined(obj[key], `${where}.${key}`);
	}
	return definedOnly(obj);
}

export function validateWorkshopConfig(raw: unknown, filePath: string): WorkshopConfig {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`pi-workshop config ${filePath} must be an object`);
	const obj = raw as Record<string, unknown>;
	assertKnownKeys(obj, ["defaults", "profiles", "models", "limits"], filePath);
	const profiles: Record<string, Record<string, unknown>> = {};
	if (obj.profiles !== undefined) {
		if (!obj.profiles || typeof obj.profiles !== "object" || Array.isArray(obj.profiles)) throw new Error(`${filePath}.profiles must be an object`);
		for (const [name, profile] of Object.entries(obj.profiles as Record<string, unknown>)) {
			if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error(`${filePath}.profiles has invalid profile name ${name}`);
			profiles[name] = validateParamConfig(profile, `${filePath}.profiles.${name}`);
		}
	}
	let models: WorkshopConfig["models"] | undefined;
	if (obj.models !== undefined) {
		if (!obj.models || typeof obj.models !== "object" || Array.isArray(obj.models)) throw new Error(`${filePath}.models must be an object`);
		const modelObj = { ...(obj.models as Record<string, unknown>) };
		assertKnownKeys(modelObj, ["strongModel", "plannerModel", "expertModel", "juniorModel", "synthModel"], `${filePath}.models`);
		models = definedOnly(Object.fromEntries(Object.entries(modelObj).map(([key, value]) => [key, stringOrUndefined(value, `${filePath}.models.${key}`)]))) as WorkshopConfig["models"];
	}
	let limits: WorkshopConfig["limits"] | undefined;
	if (obj.limits !== undefined) {
		if (!obj.limits || typeof obj.limits !== "object" || Array.isArray(obj.limits)) throw new Error(`${filePath}.limits must be an object`);
		const limitsObj = { ...(obj.limits as Record<string, unknown>) };
		assertKnownKeys(limitsObj, ["maxRounds", "scratchTimeoutSeconds", "maxScratchTimeoutSeconds", "childTimeoutSeconds", "globalTimeoutSeconds"], `${filePath}.limits`);
		limits = definedOnly({
			maxRounds: positiveIntegerOrUndefined(limitsObj.maxRounds, `${filePath}.limits.maxRounds`, MAX_ROUNDS),
			scratchTimeoutSeconds: positiveIntegerOrUndefined(limitsObj.scratchTimeoutSeconds, `${filePath}.limits.scratchTimeoutSeconds`),
			maxScratchTimeoutSeconds: positiveIntegerOrUndefined(limitsObj.maxScratchTimeoutSeconds, `${filePath}.limits.maxScratchTimeoutSeconds`),
			childTimeoutSeconds: positiveIntegerOrUndefined(limitsObj.childTimeoutSeconds, `${filePath}.limits.childTimeoutSeconds`),
			globalTimeoutSeconds: positiveIntegerOrUndefined(limitsObj.globalTimeoutSeconds, `${filePath}.limits.globalTimeoutSeconds`),
		});
	}
	return definedOnly({
		defaults: validateParamConfig(obj.defaults, `${filePath}.defaults`) as WorkshopConfig["defaults"],
		profiles: Object.keys(profiles).length ? profiles as WorkshopConfig["profiles"] : undefined,
		models,
		limits,
	});
}

async function readConfigFile(filePath: string): Promise<WorkshopConfig | undefined> {
	try {
		const text = await fs.readFile(filePath, "utf8");
		const parsed = JSON.parse(text);
		return validateWorkshopConfig(parsed, filePath);
	} catch (error) {
		if ((error as any)?.code === "ENOENT") return undefined;
		throw new Error(`Failed to read pi-workshop config ${filePath}: ${String((error as Error)?.message ?? error)}`);
	}
}

async function findProjectConfig(cwd: string): Promise<string | undefined> {
	let probe = cwd;
	while (true) {
		const candidate = path.join(probe, ".pi", "pi-workshop.config.json");
		if (fssync.existsSync(candidate)) return candidate;
		const parent = path.dirname(probe);
		if (parent === probe || probe === os.homedir()) return undefined;
		probe = parent;
	}
}

function runtimeDefaults(defaults: WorkshopConfig["defaults"] | undefined): WorkshopConfig["defaults"] {
	const { profile: _profile, workshop: _workshop, ...rest } = defaults ?? {};
	return rest;
}

export async function resolveWorkshopConfig(cwd: string, params: WorkshopInput & { keepDashboard?: boolean; openObservatory?: boolean }): Promise<ResolvedWorkshopConfig> {
	let config: WorkshopConfig = BUILTIN_CONFIG;
	const configPaths: string[] = [];
	let projectConfigPath: string | undefined;
	let projectConfigForSource: WorkshopConfig | undefined;
	const globalPath = path.join(os.homedir(), ".pi", "agent", "pi-workshop.config.json");
	const globalConfig = await readConfigFile(globalPath);
	if (globalConfig) {
		config = mergeConfig(config, globalConfig);
		configPaths.push(globalPath);
	}
	const projectPath = await findProjectConfig(cwd);
	if (projectPath) {
		const projectConfig = await readConfigFile(projectPath);
		if (projectConfig) {
			config = mergeConfig(config, projectConfig);
			configPaths.push(projectPath);
			projectConfigPath = projectPath;
			projectConfigForSource = projectConfig;
		}
	}
	const requestedProfile = selectRequestedProfile(config.defaults, params);
	if (requestedProfile && !config.profiles?.[requestedProfile]) {
		throw new Error(`Unknown pi-workshop profile '${requestedProfile}'. Available profiles: ${Object.keys(config.profiles ?? {}).join(", ") || "(none)"}`);
	}
	const profileValues = requestedProfile ? (config.profiles?.[requestedProfile] ?? {}) : {};
	const modelValues = config.models ?? {};
	const explicitParams = definedOnly(params);
	const mergedParams = definedOnly({
		...(runtimeDefaults(config.defaults) ?? {}),
		...profileValues,
		...modelValues,
		...(params.profile === undefined && requestedProfile ? { profile: requestedProfile } : {}),
		...explicitParams,
	}) as WorkshopInput & { keepDashboard?: boolean; openObservatory?: boolean };
	const maxRounds = Math.max(1, Math.min(MAX_ROUNDS, Number(config.limits?.maxRounds ?? MAX_ROUNDS)));
	const rounds = Math.max(1, Math.min(maxRounds, Number(mergedParams.rounds ?? DEFAULT_ROUNDS)));
	const maxScratchTimeoutSeconds = Math.max(1, Number(config.limits?.maxScratchTimeoutSeconds ?? DEFAULT_MAX_SCRATCH_TIMEOUT_SECONDS));
	const scratchTimeoutSeconds = Math.max(1, Math.min(maxScratchTimeoutSeconds, Number(config.limits?.scratchTimeoutSeconds ?? DEFAULT_SCRATCH_TIMEOUT_SECONDS)));
	const childTimeoutSeconds = Math.max(1, Number(config.limits?.childTimeoutSeconds ?? DEFAULT_CHILD_TIMEOUT_SECONDS));
	const globalTimeoutSeconds = Math.max(childTimeoutSeconds, Number(config.limits?.globalTimeoutSeconds ?? DEFAULT_GLOBAL_TIMEOUT_SECONDS));
	return {
		params: { ...mergedParams, rounds } as WorkshopInput & { keepDashboard?: boolean; openObservatory?: boolean },
		limits: {
			maxRounds,
			scratchTimeoutSeconds,
			maxScratchTimeoutSeconds,
			childTimeoutSeconds,
			globalTimeoutSeconds,
		},
		configPaths,
		projectConfigPath,
		projectConfig: projectConfigForSource,
		profile: requestedProfile,
	};
}
