import { hashStableValue } from "./delegationV2Ids.js";

/** Trusted policy/grant semantics are versioned independently from prompts. */
export const DELEGATION_V2_CRITICAL_EXECUTION_POLICY_VERSION = "delegation-v2.critical-execution/1";
export const DELEGATION_V2_MAX_CRITICAL_CHANGED_LINES = 500;

export const DELEGATION_V2_CRITICAL_EXECUTION_CATEGORIES = Object.freeze([
	"security_boundary",
	"data_integrity",
	"concurrency_invariant",
	"protocol_core",
	"irreversible_migration",
]);

const CATEGORY_SET = new Set(DELEGATION_V2_CRITICAL_EXECUTION_CATEGORIES);
const DELEGATION_V2_ROLES = Object.freeze(["sol", "fable", "terra", "luna"]);
const HIGH_TIER_ROLES = Object.freeze(["sol", "fable"]);
const POLICY_KEYS = new Set([
	"policyVersion",
	"policyHash",
	"allowedCategories",
	"allowedPathPrefixes",
	"maxChangedLines",
]);

/** @param {unknown} value @param {string} name */
function configuredAgentChain(value, name) {
	const chain = Array.isArray(value) ? value : [value];
	if (chain.length < 1 || chain.some((agent) =>
		!agent || (typeof agent !== "object" && typeof agent !== "function") ||
		typeof agent.generate !== "function")) {
		throw new TypeError(`${name} must be an AgentLike or non-empty AgentLike failover chain`);
	}
	return chain;
}

/**
 * Same object identity is a definite alias. AgentLike.id is documented as a
 * unique identifier, so an equal non-empty id is also treated as the same
 * configured actor even when wrappers differ. Any overlap makes two failover
 * chains non-independent because runtime failover could select the overlap.
 *
 * @param {Record<string, any>[]} left
 * @param {Record<string, any>[]} right
 */
function configuredAgentChainsAlias(left, right) {
	return left.some((leftAgent) => right.some((rightAgent) => {
		if (leftAgent === rightAgent) return true;
		return typeof leftAgent.id === "string" && leftAgent.id.length > 0 &&
			typeof rightAgent.id === "string" && leftAgent.id === rightAgent.id;
	}));
}

/**
 * Derive the only cross-role reviewer choices Trellis may advertise or admit.
 * This is trusted runtime configuration, never model-authored policy.
 *
 * @param {Record<string, unknown>} agents
 * @returns {{sol: string[], fable: string[]}}
 */
export function deriveCriticalReviewIndependentRoles(agents) {
	if (!agents || typeof agents !== "object" || Array.isArray(agents)) {
		throw new TypeError("Trellis agents must be a role-indexed object");
	}
	const chains = Object.fromEntries(DELEGATION_V2_ROLES.map((role) => [
		role,
		configuredAgentChain(agents[role], `Trellis agents.${role}`),
	]));
	return Object.fromEntries(HIGH_TIER_ROLES.map((executorRole) => [
		executorRole,
		DELEGATION_V2_ROLES.filter((reviewerRole) =>
			reviewerRole !== executorRole &&
			!configuredAgentChainsAlias(chains[executorRole], chains[reviewerRole])),
	]));
}

/**
 * Validate the JSON-only independence matrix before semantic validation uses
 * it. Absence intentionally means only role-level independence can be proven;
 * the Trellis renderer always supplies its matrix derived from actual agents.
 *
 * @param {unknown} value
 * @returns {{sol: string[], fable: string[]} | null}
 */
export function normalizeCriticalReviewIndependentRoles(value) {
	if (value == null) return null;
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError("criticalReviewIndependentRoles must be an object");
	}
	const record = /** @type {Record<string, unknown>} */ (value);
	const unknown = Object.keys(record).filter((key) => !HIGH_TIER_ROLES.includes(key));
	if (unknown.length > 0) {
		throw new TypeError(`criticalReviewIndependentRoles contains unknown role '${unknown.sort()[0]}'`);
	}
	return Object.fromEntries(HIGH_TIER_ROLES.map((executorRole) => {
		const roles = record[executorRole];
		if (!Array.isArray(roles)) {
			throw new TypeError(`criticalReviewIndependentRoles.${executorRole} must be an array`);
		}
		if (roles.some((role) => !DELEGATION_V2_ROLES.includes(role) || role === executorRole) ||
			new Set(roles).size !== roles.length) {
			throw new TypeError(`criticalReviewIndependentRoles.${executorRole} must contain unique roles other than ${executorRole}`);
		}
		return [executorRole, [...roles].sort()];
	}));
}

/** @param {unknown} value @param {string} name */
function relativeScope(value, name) {
	if (typeof value !== "string" || value.length < 1 || value.length > 512) {
		throw new TypeError(`${name} must be a non-empty relative path of at most 512 characters`);
	}
	if (value !== value.trim() || value.startsWith("/") || value.startsWith("~") || value.includes("\\")) {
		throw new TypeError(`${name} must be a normalized workspace-relative POSIX path`);
	}
	if (value.normalize("NFC") !== value || /[\u0000-\u001f\u007f]/.test(value)) {
		throw new TypeError(`${name} cannot contain control characters or non-canonical Unicode`);
	}
	if (/[*?[\]{}]/.test(value)) {
		throw new TypeError(`${name} cannot contain glob syntax`);
	}
	const segments = value.split("/");
	if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
		throw new TypeError(`${name} cannot contain empty, '.' or '..' path segments`);
	}
	return value;
}

/** @param {unknown} values @param {string} name @param {(value: unknown, name: string) => string} parse */
function uniqueSortedList(values, name, parse) {
	if (!Array.isArray(values) || values.length < 1 || values.length > 32) {
		throw new TypeError(`${name} must contain between 1 and 32 entries`);
	}
	const normalized = values.map((value, index) => parse(value, `${name}[${index}]`));
	if (new Set(normalized).size !== normalized.length) {
		throw new TypeError(`${name} entries must be unique`);
	}
	return normalized.sort();
}

/**
 * Normalize the caller-owned permission boundary. Absence means high-tier
 * implementation is disabled; authored prose can never create this policy.
 *
 * @param {unknown} value
 * @returns {{
 *   policyVersion: string,
 *   allowedCategories: string[],
 *   allowedPathPrefixes: string[],
 *   maxChangedLines: number,
 *   policyHash: string,
 * } | null}
 */
export function normalizeCriticalExecutionPolicy(value) {
	if (value == null) return null;
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError("criticalExecutionPolicy must be an object");
	}
	const unknownKeys = Object.keys(value).filter((key) => !POLICY_KEYS.has(key));
	if (unknownKeys.length > 0) {
		throw new TypeError(`criticalExecutionPolicy contains unknown field '${unknownKeys.sort()[0]}'`);
	}
	const record = /** @type {Record<string, unknown>} */ (value);
	const allowedCategories = uniqueSortedList(
		record.allowedCategories,
		"criticalExecutionPolicy.allowedCategories",
		(category, name) => {
			if (typeof category !== "string" || !CATEGORY_SET.has(category)) {
				throw new TypeError(`${name} must be a registered critical-execution category`);
			}
			return category;
		},
	);
	const allowedPathPrefixes = uniqueSortedList(
		record.allowedPathPrefixes,
		"criticalExecutionPolicy.allowedPathPrefixes",
		relativeScope,
	);
	if (!Number.isSafeInteger(record.maxChangedLines) || Number(record.maxChangedLines) < 1 ||
		Number(record.maxChangedLines) > DELEGATION_V2_MAX_CRITICAL_CHANGED_LINES) {
		throw new TypeError(
			`criticalExecutionPolicy.maxChangedLines must be an integer between 1 and ${DELEGATION_V2_MAX_CRITICAL_CHANGED_LINES}`,
		);
	}
	const normalized = {
		policyVersion: DELEGATION_V2_CRITICAL_EXECUTION_POLICY_VERSION,
		allowedCategories,
		allowedPathPrefixes,
		maxChangedLines: Number(record.maxChangedLines),
	};
	const policyHash = hashStableValue({ type: "trellis-critical-execution-policy", ...normalized });
	if (record.policyVersion !== undefined && record.policyVersion !== normalized.policyVersion) {
		throw new TypeError(`criticalExecutionPolicy.policyVersion must be ${normalized.policyVersion}`);
	}
	if (record.policyHash !== undefined && record.policyHash !== policyHash) {
		throw new TypeError("criticalExecutionPolicy.policyHash does not match its normalized bounds");
	}
	return {
		...normalized,
		policyHash,
	};
}

/** @param {string} requested @param {string} allowedPrefix */
function isWithin(requested, allowedPrefix) {
	return requested === allowedPrefix || requested.startsWith(`${allowedPrefix}/`);
}

/**
 * Turn a model-authored request into a canonical grant only when it fits the
 * trusted caller policy. The grant is an admission decision, not a claim that
 * the current agent adapter can sandbox filesystem writes to these paths.
 *
 * @param {Record<string, any> | null | undefined} request
 * @param {ReturnType<typeof normalizeCriticalExecutionPolicy>} policy
 * @returns {{
 *   ok: boolean,
 *   grant: Record<string, any> | null,
 *   diagnostics: Array<{code: "criticality_ungranted" | "criticality_policy_mismatch", field: string, message: string}>,
 * }}
 */
export function deriveCriticalExecutionGrant(request, policy) {
	if (!request) {
		return {
			ok: false,
			grant: null,
			diagnostics: [{
				code: "criticality_ungranted",
				field: "criticality",
				message: "Direct Sol/Fable execution requires a structured criticality request.",
			}],
		};
	}
	if (!policy) {
		return {
			ok: false,
			grant: null,
			diagnostics: [{
				code: "criticality_ungranted",
				field: "criticality",
				message: "The trusted caller did not grant any direct Sol/Fable execution authority.",
			}],
		};
	}

	/** @type {Array<{code: "criticality_policy_mismatch", field: string, message: string}>} */
	const diagnostics = [];
	if (!policy.allowedCategories.includes(request.category)) {
		diagnostics.push({
			code: "criticality_policy_mismatch",
			field: "criticality.category",
			message: `Criticality category '${String(request.category)}' is outside the trusted policy.`,
		});
	}
	if (!Number.isSafeInteger(request.expectedChangedLines) || request.expectedChangedLines < 1 ||
		request.expectedChangedLines > policy.maxChangedLines) {
		diagnostics.push({
			code: "criticality_policy_mismatch",
			field: "criticality.expectedChangedLines",
			message: `Expected changed lines must be between 1 and the trusted cap ${policy.maxChangedLines}.`,
		});
	}

	const requestedPaths = [];
	if (!Array.isArray(request.allowedPaths) || request.allowedPaths.length < 1 || request.allowedPaths.length > 16) {
		diagnostics.push({
			code: "criticality_policy_mismatch",
			field: "criticality.allowedPaths",
			message: "Critical execution requires between 1 and 16 explicit relative path scopes.",
		});
	} else {
		for (const [index, rawPath] of request.allowedPaths.entries()) {
			let path;
			try {
				path = relativeScope(rawPath, `criticality.allowedPaths[${index}]`);
			} catch (error) {
				diagnostics.push({
					code: "criticality_policy_mismatch",
					field: `criticality.allowedPaths.${index}`,
					message: error instanceof Error ? error.message : String(error),
				});
				continue;
			}
			requestedPaths.push(path);
			if (!policy.allowedPathPrefixes.some((prefix) => isWithin(path, prefix))) {
				diagnostics.push({
					code: "criticality_policy_mismatch",
					field: `criticality.allowedPaths.${index}`,
					message: `Path '${path}' is outside every trusted critical-execution prefix.`,
				});
			}
		}
	}
	if (new Set(requestedPaths).size !== requestedPaths.length) {
		diagnostics.push({
			code: "criticality_policy_mismatch",
			field: "criticality.allowedPaths",
			message: "Critical-execution path scopes must be unique.",
		});
	}
	if (diagnostics.length > 0) return { ok: false, grant: null, diagnostics };

	const allowedPaths = [...requestedPaths].sort();
	const surroundingWorkDelegatedTo = Array.isArray(request.surroundingWorkDelegatedTo)
		? [...new Set(request.surroundingWorkDelegatedTo)].sort()
		: [];
	const grant = {
		policyVersion: policy.policyVersion,
		policyHash: policy.policyHash,
		category: request.category,
		invariant: request.invariant,
		whyHighTierIsRequired: request.whyHighTierIsRequired,
		whyTheCoreCannotBeDelegated: request.whyTheCoreCannotBeDelegated,
		allowedPaths,
		expectedChangedLines: request.expectedChangedLines,
		maxChangedLines: policy.maxChangedLines,
		lineSensitivity: request.lineSensitivity,
		surroundingWorkDelegatedTo,
		reviewNodeId: request.reviewNodeId,
	};
	return { ok: true, grant, diagnostics: [] };
}

/**
 * Bind an admitted request to one immutable compiled actor. A grant from one
 * program, invocation, or logical node therefore cannot authorize another.
 *
 * @param {Record<string, any>} grant
 * @param {{
 *   invocationKey: string,
 *   programId: string,
 *   programDigest: string,
 *   logicalId: string,
 *   role: "sol" | "fable",
 *   work: "execute",
 * }} actor
 */
export function bindCriticalExecutionGrant(grant, actor) {
	if (!grant || typeof grant !== "object" || typeof grant.policyHash !== "string") {
		throw new TypeError("critical execution grant must be an admitted canonical grant");
	}
	if (!actor || typeof actor !== "object" ||
		typeof actor.invocationKey !== "string" || !/^[a-zA-Z0-9:_-]{1,128}$/.test(actor.invocationKey) ||
		typeof actor.programId !== "string" || !/^[a-z][a-z0-9_-]{0,47}$/.test(actor.programId) ||
		typeof actor.programDigest !== "string" || !/^[a-f0-9]{64}$/.test(actor.programDigest) ||
		typeof actor.logicalId !== "string" || !/^[a-z][a-z0-9_-]{0,47}$/.test(actor.logicalId) ||
		!(["sol", "fable"].includes(actor.role)) || actor.work !== "execute") {
		throw new TypeError("critical execution grant requires an immutable Sol/Fable execute actor binding");
	}
	const actorBinding = {
		invocationKey: actor.invocationKey,
		programId: actor.programId,
		programDigest: actor.programDigest,
		logicalId: actor.logicalId,
		role: actor.role,
		work: actor.work,
	};
	const bound = { ...grant, actor: actorBinding };
	return {
		...bound,
		grantHash: hashStableValue({ type: "trellis-bound-critical-execution-grant", ...bound }),
	};
}

/** @param {unknown} value */
export function verifyBoundCriticalExecutionGrant(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError("criticalExecutionGrant must be a bound grant object");
	}
	const { grantHash, ...bound } = /** @type {Record<string, any>} */ (value);
	const expected = hashStableValue({ type: "trellis-bound-critical-execution-grant", ...bound });
	if (typeof grantHash !== "string" || grantHash !== expected) {
		throw new TypeError("criticalExecutionGrant hash does not match its actor and policy bounds");
	}
	if (!bound.actor || typeof bound.actor !== "object" ||
		!(["sol", "fable"].includes(bound.actor.role)) || bound.actor.work !== "execute" ||
		typeof bound.policyHash !== "string" || typeof bound.policyVersion !== "string") {
		throw new TypeError("criticalExecutionGrant has an invalid actor or policy binding");
	}
	return /** @type {Record<string, any>} */ (value);
}
