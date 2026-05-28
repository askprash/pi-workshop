export function safeSegment(text) {
	return String(text).toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "item";
}

export function expertArtifactSegment(expert) {
	return safeSegment(expert.name);
}

export function assertUniqueExpertNamesForArtifacts(experts, source = "Expert") {
	const seen = new Map();
	for (const expert of experts) {
		const segment = expertArtifactSegment(expert);
		const previous = seen.get(segment);
		if (previous !== undefined) {
			throw new Error(`${source} names must be unique after canonicalization; '${previous}' and '${expert.name}' both map to '${segment}'. Rename one expert.`);
		}
		seen.set(segment, expert.name);
	}
}

export function selectRequestedProfile(defaults, params) {
	const defaultSelectedProfile = defaults?.workshop ? "workshop" : defaults?.profile;
	if (params.workshop === true) return "workshop";
	if (params.profile !== undefined) return params.profile;
	if (params.workshop === false && defaultSelectedProfile === "workshop") return undefined;
	return defaultSelectedProfile;
}

function assertOnlyKeys(obj, allowed, where) {
	for (const key of Object.keys(obj)) {
		if (!allowed.includes(key)) throw new Error(`${where} contains unsupported key '${key}'`);
	}
}

function objectRecord(value, where) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} must be an object`);
	return value;
}

export function parsePlannedExperts(text) {
	const jsonText = text.match(/\{[\s\S]*\}/)?.[0];
	if (!jsonText) return null;
	try {
		const parsed = objectRecord(JSON.parse(jsonText), "planner JSON");
		assertOnlyKeys(parsed, ["experts"], "planner JSON");
		if (!Array.isArray(parsed.experts)) return null;
		const experts = [];
		for (const [index, rawExpert] of parsed.experts.entries()) {
			const expertObj = objectRecord(rawExpert, `planner JSON experts[${index}]`);
			assertOnlyKeys(expertObj, ["name", "stance", "assistantBriefs"], `planner JSON experts[${index}]`);
			if (typeof expertObj.name !== "string" || typeof expertObj.stance !== "string") return null;
			const name = safeSegment(expertObj.name);
			const stance = expertObj.stance.trim();
			if (!name || !stance) continue;
			let assistantBriefs;
			if (expertObj.assistantBriefs !== undefined) {
				if (!Array.isArray(expertObj.assistantBriefs)) return null;
				assistantBriefs = [];
				for (const [briefIndex, rawBrief] of expertObj.assistantBriefs.entries()) {
					const briefObj = objectRecord(rawBrief, `planner JSON experts[${index}].assistantBriefs[${briefIndex}]`);
					assertOnlyKeys(briefObj, ["agent", "task"], `planner JSON experts[${index}].assistantBriefs[${briefIndex}]`);
					if (briefObj.agent !== undefined && briefObj.agent !== "scout" && briefObj.agent !== "researcher") {
						throw new Error(`planner JSON experts[${index}].assistantBriefs[${briefIndex}] has unsupported agent '${String(briefObj.agent)}'`);
					}
					if (typeof briefObj.task !== "string") return null;
					const task = briefObj.task.trim();
					if (task) assistantBriefs.push({ agent: briefObj.agent ?? "scout", task });
				}
				assistantBriefs = assistantBriefs.slice(0, 3);
			}
			experts.push({ name, stance, assistantBriefs: assistantBriefs?.length ? assistantBriefs : undefined });
			if (experts.length >= 4) break;
		}
		if (experts.length < 2) return null;
		assertUniqueExpertNamesForArtifacts(experts, "Planner expert");
		return experts;
	} catch {
		return null;
	}
}
