import {
	canonicalJson,
	invocationOutcomeNodeId,
	isGatewaySafeNodeId,
	programNodeId,
} from "./delegationV2Ids.js";
import { delegationV2ProgramDigest, validateWorkflowProgram } from "./delegationV2Validate.js";
import {
	bindCriticalExecutionGrant,
	deriveCriticalExecutionGrant,
	normalizeCriticalExecutionPolicy,
	normalizeCriticalReviewIndependentRoles,
} from "./delegationV2CriticalExecution.js";

/**
 * Version of the pure Phase A IR lowerer. Persist this beside accepted IR so a
 * resumed run never silently changes the meaning of an older program.
 */
export const DELEGATION_V2_COMPILER_VERSION = "delegation-v2.compiler-3";

const AUTHOR_ROLES = new Set(["sol", "fable"]);

/** @param {unknown} value @param {string} name */
function assertGatewayNodeId(value, name) {
	if (typeof value !== "string" || !isGatewaySafeNodeId(value)) {
		throw new TypeError(`${name} must be a gateway-safe node id`);
	}
	return value;
}

/** @param {unknown} value */
function assertGeneration(value) {
	if (!Number.isSafeInteger(value) || Number(value) < 0) {
		throw new TypeError("generation must be a non-negative safe integer");
	}
	return Number(value);
}

/** @param {unknown} value */
function assertRootMaxConcurrency(value) {
	if (!Number.isSafeInteger(value) || Number(value) < 1) {
		throw new TypeError("rootMaxConcurrency must be a positive safe integer");
	}
	return Number(value);
}

/** @param {readonly string[]} values */
function unique(values) {
	return [...new Set(values)];
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string[]}
 */
function nodeIdList(value, name) {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
	return unique(value.map((entry, index) => assertGatewayNodeId(entry, `${name}[${index}]`)));
}

/**
 * Lower one accepted `agent | sequence | parallel` program into a deterministic,
 * JSON-only render plan. The caller renders this plan with trusted Smithers
 * components; the model never supplies React props, agents, tools, callbacks,
 * schemas, commands, or providers.
 *
	 * `programDigest` must be the semantic digest of the normalized persisted program. The
 * check is intentional: otherwise changed prompt semantics could accidentally
 * reuse physical task IDs from a different accepted fragment.
 *
 * @param {{
 *   program: unknown,
 *   invocationKey: string,
 *   authorNodeId: string,
 *   generation: number,
 *   programDigest: string,
 *   rootMaxConcurrency: number,
 *   prefix?: string,
 *   authorLineage?: string[],
 *   entryDependsOn?: string[],
 *   validationLimits?: Record<string, number>,
 *   allowParallelWrites?: boolean,
 *   criticalExecutionPolicy?: unknown,
 *   criticalReviewIndependentRoles?: unknown,
 *   allowAuthorChildren?: boolean,
 *   hasCappedParallelAncestor?: boolean,
 * }} options
 */
export function compileDelegationV2Program(options) {
	if (!options || typeof options !== "object") {
		throw new TypeError("delegation v2 compiler options must be an object");
	}

	const invocationKey = assertGatewayNodeId(options.invocationKey, "invocationKey");
	const authorNodeId = assertGatewayNodeId(options.authorNodeId, "authorNodeId");
	const generation = assertGeneration(options.generation);
	const rootMaxConcurrency = assertRootMaxConcurrency(options.rootMaxConcurrency);
	const criticalExecutionPolicy = normalizeCriticalExecutionPolicy(options.criticalExecutionPolicy);
	const criticalReviewIndependentRoles = normalizeCriticalReviewIndependentRoles(
		options.criticalReviewIndependentRoles,
	);
	const hasCappedParallelAncestor = options.hasCappedParallelAncestor === true;
	const prefix = options.prefix ?? "trellis";
	const entryDependsOn = nodeIdList(options.entryDependsOn, "entryDependsOn");
	const suppliedLineage = nodeIdList(options.authorLineage, "authorLineage");
	const authorLineage = suppliedLineage.at(-1) === invocationKey
		? suppliedLineage
		: [...suppliedLineage, invocationKey];
	const validation = validateWorkflowProgram(options.program, {
		rootMaxConcurrency,
		...(options.validationLimits ? { limits: options.validationLimits } : {}),
		allowParallelWrites: options.allowParallelWrites === true,
		criticalExecutionPolicy,
		criticalReviewIndependentRoles,
		allowAuthorChildren: options.allowAuthorChildren,
		hasCappedParallelAncestor,
	});
	if (!validation.ok || !validation.normalizedProgram) {
		const codes = validation.diagnostics.map((diagnostic) => diagnostic.code).join(", ");
		throw new TypeError(`compiler requires an accepted delegation v2 program${codes ? ` (${codes})` : ""}`);
	}
	const program = validation.normalizedProgram;

	const computedDigest = delegationV2ProgramDigest(program);
	if (options.programDigest !== computedDigest) {
		throw new TypeError("programDigest must equal delegationV2ProgramDigest(normalizedProgram)");
	}
	const programDigest = computedDigest;

	/** @type {Map<string, Record<string, any>>} */
	const identityByLogicalId = new Map();
	/** @type {Map<string, import("./delegationV2Schemas.ts").WorkflowAgentExpr>} */
	const agentExprByLogicalId = new Map();
	/** @type {Record<string, any>[]} */
	const nodeIndex = [];

	/**
	 * Pre-index the entire accepted fragment before lowering any references.
	 * Physical identity depends on trusted lineage and logical ids, never array
	 * position, so the renderer can wire every dependency to a canonical outcome.
	 *
	 * @param {import("./delegationV2Schemas.ts").WorkflowExpr} expr
	 * @param {string[]} containerLineage
	 * @param {string | null} parentLogicalId
	 */
	function indexExpr(expr, containerLineage, parentLogicalId) {
		if (identityByLogicalId.has(expr.id)) {
			throw new TypeError(`duplicate logical id reached compiler: ${expr.id}`);
		}
		const source = {
			invocationKey,
			authorNodeId,
			authorLineage: [...authorLineage],
			generation,
			programId: program.id,
			programDigest,
			registryVersion: program.registryVersion,
			logicalId: expr.id,
			parentLogicalId,
			containerLineage: [...containerLineage],
		};

		/** @type {Record<string, any>} */
		let identity;
		if (expr.tag === "agent") {
			agentExprByLogicalId.set(expr.id, expr);
			const nestedAuthor = AUTHOR_ROLES.has(expr.role);
			if (nestedAuthor) {
				const nestedInvocationKey = programNodeId({
					prefix,
					invocationKey,
					generation,
					programDigest,
					localId: expr.id,
					phase: "invoke",
				});
				identity = {
					logicalId: expr.id,
					tag: expr.tag,
					physicalNodeId: nestedInvocationKey,
					rawNodeId: null,
					outcomeNodeId: invocationOutcomeNodeId({ prefix, invocationKey: nestedInvocationKey }),
					nestedAuthor: true,
					nestedInvocationKey,
					outputContract: expr.outputContract,
					source,
				};
			} else {
				const rawNodeId = programNodeId({
					prefix,
					invocationKey,
					generation,
					programDigest,
					localId: expr.id,
					phase: "worker",
				});
				identity = {
					logicalId: expr.id,
					tag: expr.tag,
					physicalNodeId: rawNodeId,
					rawNodeId,
					outcomeNodeId: programNodeId({
						prefix,
						invocationKey,
						generation,
						programDigest,
						localId: expr.id,
						phase: "outcome",
					}),
					nestedAuthor: false,
					nestedInvocationKey: null,
					outputContract: expr.outputContract,
					source,
				};
			}
		} else {
			identity = {
				logicalId: expr.id,
				tag: expr.tag,
				physicalNodeId: programNodeId({
					prefix,
					invocationKey,
					generation,
					programDigest,
					localId: expr.id,
					phase: expr.tag,
				}),
				source,
			};
		}

		identityByLogicalId.set(expr.id, identity);
		nodeIndex.push(identity);
		if (expr.tag === "sequence") {
			for (const child of expr.steps) {
				indexExpr(child, [...containerLineage, expr.id], expr.id);
			}
		} else if (expr.tag === "parallel") {
			for (const child of expr.branches) {
				indexExpr(child, [...containerLineage, expr.id], expr.id);
			}
		}
	}

	indexExpr(program.root, [], null);

	/** @param {string} logicalId @param {string} use */
	function requireAgentIdentity(logicalId, use) {
		const identity = identityByLogicalId.get(logicalId);
		if (!identity || identity.tag !== "agent") {
			throw new TypeError(`${use} references missing or non-agent logical id: ${logicalId}`);
		}
		return identity;
	}

	/**
	 * @param {import("./delegationV2Schemas.ts").WorkflowExpr} expr
	 * @param {string[]} inheritedDependencies
	 * @param {boolean} underCappedParallel
	 * @returns {{ node: Record<string, any>, completionOutcomeNodeIds: string[] }}
	 */
	function lower(expr, inheritedDependencies, underCappedParallel) {
		const identity = identityByLogicalId.get(expr.id);
		if (!identity) throw new TypeError(`compiler identity missing for ${expr.id}`);

		if (expr.tag === "agent") {
			const inputBindings = expr.inputs.map((input) => {
				const sourceIdentity = requireAgentIdentity(input.from, `input ${expr.id}`);
				if (sourceIdentity.outputContract !== input.contract) {
					throw new TypeError(
						`input ${expr.id} contract ${input.contract} does not match ${input.from} contract ${sourceIdentity.outputContract}`,
					);
				}
				return {
					from: input.from,
					contract: input.contract,
					purpose: input.purpose,
					outcomeNodeId: sourceIdentity.outcomeNodeId,
				};
			});
			const inputOutcomeNodeIds = unique(inputBindings.map((binding) => binding.outcomeNodeId));
			const sequenceDependencyNodeIds = unique(inheritedDependencies);
			const dependsOn = unique([...sequenceDependencyNodeIds, ...inputOutcomeNodeIds]);
			let criticalExecutionGrant;
			if (AUTHOR_ROLES.has(expr.role) && expr.work === "execute") {
				const decision = deriveCriticalExecutionGrant(expr.criticality, criticalExecutionPolicy);
				if (!decision.ok || !decision.grant) {
					throw new TypeError("accepted direct Sol/Fable execution is missing a trusted critical-execution grant");
				}
				const reviewerExpr = agentExprByLogicalId.get(expr.criticality.reviewNodeId);
				const reviewerIdentity = requireAgentIdentity(expr.criticality.reviewNodeId, `critical review ${expr.id}`);
				if (!reviewerExpr || reviewerExpr.work !== "review") {
					throw new TypeError("accepted direct Sol/Fable execution is missing its validated reviewer");
				}
				criticalExecutionGrant = bindCriticalExecutionGrant({
					...decision.grant,
					reviewer: {
						logicalId: reviewerExpr.id,
						role: reviewerExpr.role,
						work: reviewerExpr.work,
						outcomeNodeId: reviewerIdentity.outcomeNodeId,
					},
				}, {
					invocationKey: identity.nestedInvocationKey ?? invocationKey,
					programId: program.id,
					programDigest,
					logicalId: expr.id,
					role: expr.role,
					work: expr.work,
				});
			}
			const node = {
				kind: "agent",
				logicalId: expr.id,
				physicalNodeId: identity.physicalNodeId,
				rawNodeId: identity.rawNodeId,
				outcomeNodeId: identity.outcomeNodeId,
				nestedAuthor: identity.nestedAuthor,
				nestedInvocationKey: identity.nestedInvocationKey,
				role: expr.role,
				work: expr.work,
				goal: expr.goal,
				prompt: expr.prompt,
				acceptance: expr.acceptance,
				outputContract: expr.outputContract,
				inputBindings,
				inputOutcomeNodeIds,
				sequenceDependencyNodeIds,
				dependsOn,
				settlementDependsOn: identity.rawNodeId ? [identity.rawNodeId] : [],
				hasCappedParallelAncestor: underCappedParallel,
				source: identity.source,
				...(expr.criticality === undefined ? {} : { criticality: expr.criticality }),
				...(criticalExecutionGrant === undefined ? {} : { criticalExecutionGrant }),
			};
			return { node, completionOutcomeNodeIds: [identity.outcomeNodeId] };
		}

		if (expr.tag === "sequence") {
			const steps = [];
			let cursorDependencies = unique(inheritedDependencies);
			for (const step of expr.steps) {
				const compiled = lower(step, cursorDependencies, underCappedParallel);
				steps.push(compiled.node);
				cursorDependencies = compiled.completionOutcomeNodeIds;
			}
			return {
				node: {
					kind: "sequence",
					logicalId: expr.id,
					physicalNodeId: identity.physicalNodeId,
					entryDependencyNodeIds: unique(inheritedDependencies),
					completionOutcomeNodeIds: [...cursorDependencies],
					steps,
					source: identity.source,
				},
				completionOutcomeNodeIds: cursorDependencies,
			};
		}

		const requestedMaxConcurrency = expr.maxConcurrency ?? null;
		// An omitted local cap remains omitted. Synthesizing a cap here would make
		// an otherwise uncapped nested Parallel the nearest scheduler scope and
		// could silently replace (rather than compose with) an ancestor cap.
		if (requestedMaxConcurrency !== null && requestedMaxConcurrency > rootMaxConcurrency) {
			throw new TypeError("accepted local concurrency cannot exceed rootMaxConcurrency");
		}
		const maxConcurrency = requestedMaxConcurrency;
		const branches = expr.branches.map((branch) => lower(
			branch,
			inheritedDependencies,
			underCappedParallel || requestedMaxConcurrency !== null,
		));
		const completionOutcomeNodeIds = unique(
			branches.flatMap((branch) => branch.completionOutcomeNodeIds),
		);
		return {
			node: {
				kind: "parallel",
				logicalId: expr.id,
				physicalNodeId: identity.physicalNodeId,
				requestedMaxConcurrency,
				maxConcurrency,
				clamped: false,
				entryDependencyNodeIds: unique(inheritedDependencies),
				completionOutcomeNodeIds: [...completionOutcomeNodeIds],
				branches: branches.map((branch) => branch.node),
				source: identity.source,
			},
			completionOutcomeNodeIds,
		};
	}

	const lowered = lower(program.root, entryDependsOn, hasCappedParallelAncestor);
	const declaredOutputs = program.outputs.map((output) => {
		const identity = requireAgentIdentity(output.from, "program output");
		if (identity.outputContract !== output.contract) {
			throw new TypeError(
				`program output ${output.from} contract ${output.contract} does not match ${identity.outputContract}`,
			);
		}
		return {
			from: output.from,
			contract: output.contract,
			outcomeNodeId: identity.outcomeNodeId,
		};
	});

	const plan = {
		kind: "program",
		compilerVersion: DELEGATION_V2_COMPILER_VERSION,
		schemaVersion: program.schemaVersion,
		registryVersion: program.registryVersion,
		invocationKey,
		authorNodeId,
		authorLineage,
		generation,
		programId: program.id,
		programDigest,
		rootMaxConcurrency,
		hasCappedParallelAncestor,
		criticalExecutionPolicyHash: criticalExecutionPolicy?.policyHash ?? null,
		criticalReviewIndependentRoles,
		objective: program.objective,
		rationale: program.rationale,
		entryDependencyNodeIds: entryDependsOn,
		completionOutcomeNodeIds: lowered.completionOutcomeNodeIds,
		declaredOutputs,
		declaredOutputNodeIds: declaredOutputs.map((output) => output.outcomeNodeId),
		nodeIndex,
		root: lowered.node,
	};

	// Defense-in-depth assertion: the compiler contract itself stays inside the
	// canonical JSON data model. This rejects future accidental callbacks,
	// class instances, symbols, or undefined fields before the renderer sees it.
	canonicalJson(plan);
	return plan;
}
