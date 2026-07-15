import {
	DELEGATION_V2_OUTPUT_CONTRACTS_BY_WORK,
	DELEGATION_V2_REGISTRY_VERSION,
	workflowProgramSchema,
} from "./delegationV2Schemas.ts";
import { hashStableValue } from "./delegationV2Ids.js";
import {
	deriveCriticalExecutionGrant,
	normalizeCriticalExecutionPolicy,
	normalizeCriticalReviewIndependentRoles,
} from "./delegationV2CriticalExecution.js";

export const DEFAULT_DELEGATION_V2_LIMITS = Object.freeze({
	maxNodes: 64,
	maxDepth: 8,
	maxFanout: 16,
	maxConcurrency: 8,
	maxAuthors: 16,
	maxPromptBytes: 16_384,
	maxTotalPromptBytes: 131_072,
});

const RESERVED_IDS = new Set(["dv2", "smithers", "system", "trellis"]);
const RESERVED_PREFIXES = ["dv2-", "dv2_", "smithers-", "smithers_", "system-", "system_", "trellis-", "trellis_"];
const MUTATING_WORK = new Set(["execute", "poc", "preview"]);
const AUTHOR_ROLES = new Set(["sol", "fable"]);
const CONTRACTS_BY_WORK = Object.freeze(Object.fromEntries(
	Object.entries(DELEGATION_V2_OUTPUT_CONTRACTS_BY_WORK).map(([work, contracts]) => [work, new Set(contracts)]),
));
const MAX_DIAGNOSTICS = 128;
const MAX_DIAGNOSTIC_PATH = 512;
const MAX_DIAGNOSTIC_MESSAGE = 2_048;
const WORK_BY_ROLE = Object.freeze({
	sol: new Set(["refine_goal", "plan", "research", "poc", "execute", "review", "preview", "synthesize"]),
	fable: new Set(["refine_goal", "plan", "research", "poc", "execute", "review", "preview", "synthesize"]),
	terra: new Set(["plan", "research", "poc", "execute", "review", "preview", "synthesize"]),
	luna: new Set(["research", "poc", "execute", "review", "preview"]),
});

/** @param {unknown} value */
function byteLength(value) {
	return new TextEncoder().encode(String(value)).byteLength;
}

/** @param {unknown} raw @returns {string} */
function diagnosticDigest(raw) {
	try {
		return hashStableValue(raw);
	} catch {
		const record = raw && typeof raw === "object" ? raw : null;
		return hashStableValue({
			invalidProposalType: Object.prototype.toString.call(raw),
			keys: record ? Object.keys(record).sort().slice(0, 64) : [],
		});
	}
}

/** @param {string} left @param {string} right */
function compareCodePoints(left, right) {
	return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Canonical semantic identity keeps sequence order but treats Parallel branch
 * order and declared-output order as sets. This prevents a cosmetic sibling
 * reorder from invalidating every descendant physical id.
 * @param {import("./delegationV2Schemas.ts").WorkflowExpr} expr
 * @returns {import("./delegationV2Schemas.ts").WorkflowExpr}
 */
function exprForIdentity(expr) {
	if (expr.tag === "agent") return expr;
	if (expr.tag === "sequence") {
		return { ...expr, steps: expr.steps.map(exprForIdentity) };
	}
	return {
		...expr,
		branches: expr.branches.map(exprForIdentity).sort((left, right) => compareCodePoints(left.id, right.id)),
	};
}

/** @param {import("./delegationV2Schemas.ts").WorkflowProgram} program */
export function delegationV2ProgramDigest(program) {
	return hashStableValue({
		...program,
		root: exprForIdentity(program.root),
		outputs: [...program.outputs].sort((left, right) =>
			compareCodePoints(left.from, right.from) || compareCodePoints(left.contract, right.contract)),
	});
}

/** @param {unknown} value @param {number} max @param {string} fallback */
function boundedText(value, max, fallback) {
	const text = String(value ?? fallback).slice(0, max);
	return text.length > 0 ? text : fallback;
}

/**
 * Reject hostile depth/size before recursive Zod parsing or semantic walks.
 * This is intentionally iterative and understands only the three IR tags;
 * malformed shapes remain the schema validator's responsibility.
 * @param {unknown} rawRoot
 * @param {typeof DEFAULT_DELEGATION_V2_LIMITS} limits
 */
function preflightShape(rawRoot, limits) {
	if (!rawRoot || typeof rawRoot !== "object") return null;
	const stack = [{ value: rawRoot, depth: 1 }];
	const seen = new WeakSet();
	let nodes = 0;
	while (stack.length > 0) {
		const { value, depth } = stack.pop();
		if (!value || typeof value !== "object") continue;
		if (seen.has(value)) {
			return { code: "schema_invalid", message: "Program graph must be acyclic JSON data.", nodes, maxDepth: depth };
		}
		seen.add(value);
		nodes += 1;
		if (nodes > limits.maxNodes) {
			return { code: "node_limit", message: `Program exceeds the ${limits.maxNodes}-node limit.`, nodes, maxDepth: depth };
		}
		if (depth > limits.maxDepth) {
			return { code: "depth_limit", message: `Program exceeds the depth limit ${limits.maxDepth}.`, nodes, maxDepth: depth };
		}
		const tag = value.tag;
		const children = tag === "sequence" ? value.steps : tag === "parallel" ? value.branches : null;
		if (!Array.isArray(children)) continue;
		for (let index = children.length - 1; index >= 0; index -= 1) {
			stack.push({ value: children[index], depth: depth + 1 });
		}
	}
	return null;
}

/** @param {unknown} value @param {string} name */
function positiveSafeInteger(value, name) {
	if (!Number.isSafeInteger(value) || Number(value) < 1) {
		throw new TypeError(`${name} must be a positive safe integer`);
	}
	return Number(value);
}

/**
 * Validate and normalize the model-authored v1 program without side effects.
 * Accepted digests are always over the strict Zod-normalized program.
 *
 * @param {unknown} rawProgram
 * @param {{
 *   limits?: Partial<typeof DEFAULT_DELEGATION_V2_LIMITS>,
 *   rootMaxConcurrency?: number,
 *   allowParallelWrites?: boolean,
 *   reservedIds?: readonly string[],
 *   registryVersion?: string,
 *   expectedRegistryVersion?: string,
 *   criticalExecutionPolicy?: unknown,
 *   criticalReviewIndependentRoles?: unknown,
 *   allowAuthorChildren?: boolean,
 *   hasCappedParallelAncestor?: boolean,
 * }} [options]
 * @returns {{
 *   ok: boolean,
 *   status: "accepted" | "rejected",
 *   programDigest: string,
 *   normalizedProgram?: import("./delegationV2Schemas.ts").WorkflowProgram,
 *   diagnostics: Array<{code: string, path: string, message: string, nodeId?: string}>,
 *   stats: {nodes: number, agents: number, authors: number, maxDepth: number, maxFanout: number, totalPromptBytes: number},
 * }}
 */
export function validateWorkflowProgram(rawProgram, options = {}) {
	const limits = { ...DEFAULT_DELEGATION_V2_LIMITS, ...(options.limits ?? {}) };
	for (const [name, value] of Object.entries(limits)) positiveSafeInteger(value, `limits.${name}`);
	const rootMaxConcurrency = positiveSafeInteger(
		options.rootMaxConcurrency ?? limits.maxConcurrency,
		"rootMaxConcurrency",
	);
	const reservedIds = new Set([...RESERVED_IDS, ...(options.reservedIds ?? [])]);
	const expectedRegistryVersion = options.expectedRegistryVersion ?? options.registryVersion ?? DELEGATION_V2_REGISTRY_VERSION;
	if (typeof expectedRegistryVersion !== "string" || expectedRegistryVersion.length < 1) {
		throw new TypeError("expectedRegistryVersion must be a non-empty string");
	}
	const criticalExecutionPolicy = normalizeCriticalExecutionPolicy(options.criticalExecutionPolicy);
	const criticalReviewIndependentRoles = normalizeCriticalReviewIndependentRoles(
		options.criticalReviewIndependentRoles,
	);
	const allowAuthorChildren = options.allowAuthorChildren !== false;
	const hasCappedParallelAncestor = options.hasCappedParallelAncestor === true;
	const emptyStats = { nodes: 0, agents: 0, authors: 0, maxDepth: 0, maxFanout: 0, totalPromptBytes: 0 };
	const preflight = preflightShape(rawProgram && typeof rawProgram === "object" ? rawProgram.root : undefined, limits);
	if (preflight) {
		return {
			ok: false,
			status: "rejected",
			programDigest: diagnosticDigest(rawProgram),
			diagnostics: [{ code: preflight.code, path: "root.root", message: preflight.message }],
			stats: { ...emptyStats, nodes: preflight.nodes, maxDepth: preflight.maxDepth },
		};
	}

	let parsed;
	try {
		parsed = workflowProgramSchema.safeParse(rawProgram);
	} catch (error) {
		return {
			ok: false,
			status: "rejected",
			programDigest: diagnosticDigest(rawProgram),
			diagnostics: [{
				code: "schema_invalid",
				path: "root",
				message: `Program schema parsing failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2_048),
			}],
			stats: emptyStats,
		};
	}
	if (!parsed.success) {
		return {
			ok: false,
			status: "rejected",
			programDigest: diagnosticDigest(rawProgram),
			diagnostics: parsed.error.issues.slice(0, MAX_DIAGNOSTICS).map((issue) => ({
				code: "schema_invalid",
				path: boundedText(issue.path.length > 0 ? `root.${issue.path.join(".")}` : "root", MAX_DIAGNOSTIC_PATH, "root"),
				message: boundedText(issue.message, MAX_DIAGNOSTIC_MESSAGE, "Program schema is invalid."),
			})),
			stats: emptyStats,
		};
	}

	const program = parsed.data;
	const programDigest = delegationV2ProgramDigest(program);
	/** @type {Array<{code: string, path: string, message: string, nodeId?: string}>} */
	const diagnostics = [];
	const stats = { ...emptyStats };
	/** @type {Map<string, {expr: import("./delegationV2Schemas.ts").WorkflowExpr, path: string}>} */
	const allNodes = new Map();
	/** @type {Map<string, {expr: import("./delegationV2Schemas.ts").WorkflowAgentExpr, path: string}>} */
	const agents = new Map();
	/** @type {WeakMap<object, Set<string>>} */
	const descendantAgentCache = new WeakMap();

	/** @param {string} code @param {string} path @param {string} message @param {string | undefined} [nodeId] */
	function add(code, path, message, nodeId) {
		if (diagnostics.length >= MAX_DIAGNOSTICS) return;
		const diagnostic = {
			code,
			path: boundedText(path, MAX_DIAGNOSTIC_PATH, "root"),
			message: boundedText(message, MAX_DIAGNOSTIC_MESSAGE, "Program validation failed."),
			...(nodeId ? { nodeId } : {}),
		};
		diagnostics.push(diagnostic);
	}

	/** @param {string} id @param {string} path */
	function checkId(id, path) {
		if (reservedIds.has(id) || RESERVED_PREFIXES.some((prefix) => id.startsWith(prefix))) {
			add("reserved_id", path, `ID '${id}' is reserved for trusted runtime nodes`, id);
		}
	}

	checkId(program.id, "root.id");
	if (program.registryVersion !== expectedRegistryVersion) {
		add(
			"registry_mismatch",
			"root.registryVersion",
			`Program selected registry '${program.registryVersion}'; runtime requires '${expectedRegistryVersion}'`,
		);
	}

	/** @param {import("./delegationV2Schemas.ts").WorkflowExpr} expr @param {number} depth @param {string} path @param {boolean} underCappedParallel */
	function inventory(expr, depth, path, underCappedParallel) {
		stats.nodes += 1;
		stats.maxDepth = Math.max(stats.maxDepth, depth);
		checkId(expr.id, `${path}.id`);
		if (allNodes.has(expr.id) || expr.id === program.id) {
			add("duplicate_id", `${path}.id`, `ID '${expr.id}' is not unique within the program`, expr.id);
		} else {
			allNodes.set(expr.id, { expr, path });
		}

		if (expr.tag === "agent") {
			stats.agents += 1;
			if (AUTHOR_ROLES.has(expr.role)) {
				stats.authors += 1;
				if (!allowAuthorChildren) {
					add("author_depth_limit", `${path}.role`, "No nested Sol/Fable author depth remains in the trusted runtime budget", expr.id);
				}
			}
			if (!agents.has(expr.id)) agents.set(expr.id, { expr, path });
			const promptBytes = byteLength(expr.prompt.instructions);
			stats.totalPromptBytes += promptBytes;
			if (promptBytes > limits.maxPromptBytes) {
				add("prompt_limit", `${path}.prompt.instructions`, `Prompt is ${promptBytes} bytes; limit is ${limits.maxPromptBytes}`, expr.id);
			}
			if (!WORK_BY_ROLE[expr.role].has(expr.work)) {
				add("role_work_forbidden", `${path}.work`, `${expr.role} cannot perform '${expr.work}'`, expr.id);
			}
			if (!CONTRACTS_BY_WORK[expr.work].has(expr.outputContract)) {
				add("output_contract_forbidden", `${path}.outputContract`, `${expr.work} cannot produce '${expr.outputContract}' in this registry`, expr.id);
			}
			const acceptanceIds = new Set();
			expr.acceptance.forEach((criterion, index) => {
				if (acceptanceIds.has(criterion.id)) {
					add("acceptance_duplicate", `${path}.acceptance.${index}.id`, `Acceptance criterion '${criterion.id}' is assigned more than once`, expr.id);
				}
				acceptanceIds.add(criterion.id);
			});
			const isAuthorExecution = AUTHOR_ROLES.has(expr.role) && expr.work === "execute";
			if (isAuthorExecution && !expr.criticality) {
				add("criticality_required", `${path}.criticality`, "Direct Sol/Fable execution requires a criticality contract", expr.id);
			} else if (isAuthorExecution) {
				const decision = deriveCriticalExecutionGrant(expr.criticality, criticalExecutionPolicy);
				for (const diagnostic of decision.diagnostics) {
					add(diagnostic.code, `${path}.${diagnostic.field}`, diagnostic.message, expr.id);
					if (diagnostic.code === "criticality_ungranted") {
						add(
							"criticality_ungranted",
							`${path}.role`,
							"Without trusted high-tier execution authority, repair must move this execute work to Terra/Luna and remove criticality.",
							expr.id,
						);
					}
				}
			} else if (!isAuthorExecution && expr.criticality) {
				add("criticality_forbidden", `${path}.criticality`, "Criticality is allowed only for direct Sol/Fable execution", expr.id);
			}
			return;
		}

		const children = expr.tag === "sequence" ? expr.steps : expr.branches;
		if (expr.tag === "parallel") {
			stats.maxFanout = Math.max(stats.maxFanout, expr.branches.length);
			if (underCappedParallel) {
				add(
					"unsupported_nested_concurrency",
					expr.maxConcurrency === undefined ? `${path}.branches` : `${path}.maxConcurrency`,
					"A nested Parallel would replace its authored ancestor's local concurrency scope in this release",
					expr.id,
				);
			}
			if (expr.branches.length > limits.maxFanout) {
				add("fanout_limit", `${path}.branches`, `Parallel fan-out ${expr.branches.length} exceeds ${limits.maxFanout}`, expr.id);
			}
			if (expr.maxConcurrency !== undefined) {
				const effectiveCap = Math.min(limits.maxConcurrency, rootMaxConcurrency);
				if (expr.maxConcurrency > effectiveCap) {
					add("concurrency_limit", `${path}.maxConcurrency`, `Local concurrency ${expr.maxConcurrency} exceeds trusted cap ${effectiveCap}`, expr.id);
				}
			}
		}
		children.forEach((child, index) => inventory(
			child,
			depth + 1,
			`${path}.${expr.tag === "sequence" ? "steps" : "branches"}.${index}`,
			underCappedParallel || (expr.tag === "parallel" && expr.maxConcurrency !== undefined),
		));
	}

	inventory(program.root, 1, "root.root", hasCappedParallelAncestor);
	if (stats.nodes > limits.maxNodes) add("node_limit", "root.root", `Program has ${stats.nodes} nodes; limit is ${limits.maxNodes}`);
	if (stats.maxDepth > limits.maxDepth) add("depth_limit", "root.root", `Program depth ${stats.maxDepth} exceeds ${limits.maxDepth}`);
	if (stats.authors > limits.maxAuthors) add("node_limit", "root.root", `Program has ${stats.authors} author nodes; limit is ${limits.maxAuthors}`);
	if (stats.totalPromptBytes > limits.maxTotalPromptBytes) {
		add("total_prompt_limit", "root.root", `Total prompt bytes ${stats.totalPromptBytes} exceed ${limits.maxTotalPromptBytes}`);
	}

	/** @param {import("./delegationV2Schemas.ts").WorkflowExpr} expr @returns {Set<string>} */
	function descendantAgents(expr) {
		const cached = descendantAgentCache.get(expr);
		if (cached) return cached;
		const result = new Set();
		if (expr.tag === "agent") result.add(expr.id);
		else {
			const children = expr.tag === "sequence" ? expr.steps : expr.branches;
			for (const child of children) for (const id of descendantAgents(child)) result.add(id);
		}
		descendantAgentCache.set(expr, result);
		return result;
	}

	/** @param {import("./delegationV2Schemas.ts").WorkflowExpr} expr */
	function containsMutableWork(expr) {
		if (expr.tag === "agent") return AUTHOR_ROLES.has(expr.role) || MUTATING_WORK.has(expr.work);
		const children = expr.tag === "sequence" ? expr.steps : expr.branches;
		return children.some(containsMutableWork);
	}

	/**
	 * @param {import("./delegationV2Schemas.ts").WorkflowExpr} expr
	 * @param {Map<string, import("./delegationV2Schemas.ts").WorkflowAgentExpr>} available
	 * @param {Set<string>} siblingForbidden
	 * @param {string} path
	 * @returns {Map<string, import("./delegationV2Schemas.ts").WorkflowAgentExpr>}
	 */
	function validateAvailability(expr, available, siblingForbidden, path) {
		if (expr.tag === "agent") {
			const declaredInputs = new Set(expr.inputs.map((input) => input.from));
			expr.prompt.contextRefs.forEach((ref, index) => {
				if (!declaredInputs.has(ref)) {
					add("prompt_context_missing", `${path}.prompt.contextRefs.${index}`, `Prompt context '${ref}' is not a declared input`, expr.id);
				}
			});
			expr.inputs.forEach((input, index) => {
				const inputPath = `${path}.inputs.${index}`;
				const source = agents.get(input.from)?.expr;
				if (!source) {
					add("reference_missing", `${inputPath}.from`, `Input '${input.from}' does not reference an agent output`, expr.id);
					return;
				}
				if (!available.has(input.from)) {
					if (siblingForbidden.has(input.from)) {
						add("parallel_sibling_reference", `${inputPath}.from`, `Parallel sibling '${input.from}' is not available inside this branch`, expr.id);
					} else {
						add("reference_forward", `${inputPath}.from`, `Input '${input.from}' is not available before '${expr.id}'`, expr.id);
					}
					return;
				}
				if (source.outputContract !== input.contract) {
					add("reference_contract_mismatch", `${inputPath}.contract`, `Input expects '${input.contract}' but '${input.from}' produces '${source.outputContract}'`, expr.id);
				}
			});
			const next = new Map(available);
			next.set(expr.id, expr);
			return next;
		}

		if (expr.tag === "sequence") {
			let current = new Map(available);
			expr.steps.forEach((step, index) => {
				current = validateAvailability(step, current, siblingForbidden, `${path}.steps.${index}`);
			});
			return current;
		}

		if (!options.allowParallelWrites) {
			const mutableBranches = expr.branches.filter(containsMutableWork).length;
			if (mutableBranches > 1) {
				add("parallel_write_conflict", `${path}.branches`, `${mutableBranches} parallel branches may mutate the shared workspace`, expr.id);
			}
		}
		const combined = new Map(available);
		expr.branches.forEach((branch, branchIndex) => {
			const otherSiblingIds = new Set(siblingForbidden);
			expr.branches.forEach((other, otherIndex) => {
				if (otherIndex !== branchIndex) for (const id of descendantAgents(other)) otherSiblingIds.add(id);
			});
			const branchResult = validateAvailability(branch, new Map(available), otherSiblingIds, `${path}.branches.${branchIndex}`);
			for (const [id, agent] of branchResult) combined.set(id, agent);
		});
		return combined;
	}

	const finalAvailable = validateAvailability(program.root, new Map(), new Set(), "root.root");
	/** @type {Map<string, Set<string>>} */
	const transitiveInputs = new Map();
	/** @param {string} agentId @param {Set<string>} [active] */
	function inputAncestors(agentId, active = new Set()) {
		const cached = transitiveInputs.get(agentId);
		if (cached) return cached;
		if (active.has(agentId)) return new Set();
		active.add(agentId);
		const result = new Set();
		const agent = agents.get(agentId)?.expr;
		for (const input of agent?.inputs ?? []) {
			result.add(input.from);
			for (const ancestor of inputAncestors(input.from, active)) result.add(ancestor);
		}
		active.delete(agentId);
		transitiveInputs.set(agentId, result);
		return result;
	}

	for (const { expr, path } of agents.values()) {
		if (!expr.criticality) continue;
		for (const [index, delegatedId] of expr.criticality.surroundingWorkDelegatedTo.entries()) {
			if (delegatedId === expr.id || !agents.has(delegatedId)) {
				add(
					"criticality_policy_mismatch",
					`${path}.criticality.surroundingWorkDelegatedTo.${index}`,
					`Surrounding-work reference '${delegatedId}' must identify a distinct agent in this program`,
					expr.id,
				);
			}
		}
		const reviewer = agents.get(expr.criticality.reviewNodeId)?.expr;
		if (!reviewer) {
			add("critical_review_missing", `${path}.criticality.reviewNodeId`, `Review node '${expr.criticality.reviewNodeId}' does not exist`, expr.id);
			continue;
		}
		const consumesExecution = reviewer.inputs.some((input) => input.from === expr.id && input.contract === expr.outputContract);
		if (reviewer.id === expr.id || reviewer.work !== "review" || !consumesExecution) {
			add("critical_review_invalid", `${path}.criticality.reviewNodeId`, "Critical execution must feed a distinct review node with a matching input contract", expr.id);
			continue;
		}
		const configuredIndependentRoles = criticalReviewIndependentRoles?.[expr.role];
		if (reviewer.role === expr.role ||
			(configuredIndependentRoles && !configuredIndependentRoles.includes(reviewer.role))) {
			const reviewerPath = agents.get(reviewer.id)?.path ?? path;
			add(
				"critical_review_not_independent",
				`${reviewerPath}.role`,
				`Critical ${expr.role} execution must be reviewed by a different, non-aliased configured agent role${configuredIndependentRoles ? `; allowed roles: ${configuredIndependentRoles.join(", ") || "none"}` : ""}`,
				expr.id,
			);
		}
		const reviewJoinsOutput = program.outputs.some((output) =>
			output.from === reviewer.id || inputAncestors(output.from).has(reviewer.id));
		if (!reviewJoinsOutput) {
			add(
				"critical_review_not_joined",
				`${path}.criticality.reviewNodeId`,
				"A declared program output must be the critical review or consume it, so continuation cannot race the review",
				expr.id,
			);
		}
	}

	const seenOutputs = new Set();
	program.outputs.forEach((output, index) => {
		const path = `root.outputs.${index}`;
		const key = `${output.from}:${output.contract}`;
		if (seenOutputs.has(key)) add("output_duplicate", path, `Output '${key}' is declared more than once`);
		seenOutputs.add(key);
		const source = finalAvailable.get(output.from);
		if (!source) {
			add("output_missing", `${path}.from`, `Output '${output.from}' does not reference a settled agent`);
		} else if (source.outputContract !== output.contract) {
			add("output_contract_mismatch", `${path}.contract`, `Output expects '${output.contract}' but '${output.from}' produces '${source.outputContract}'`, output.from);
		}
	});

	diagnostics.sort((left, right) => compareCodePoints(left.path, right.path) || compareCodePoints(left.code, right.code));
	const ok = diagnostics.length === 0;
	return {
		ok,
		status: ok ? "accepted" : "rejected",
		programDigest,
		...(ok ? { normalizedProgram: program } : {}),
		diagnostics,
		stats,
	};
}
