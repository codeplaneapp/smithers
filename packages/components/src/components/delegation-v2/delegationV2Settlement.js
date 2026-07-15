import {
	acceptanceCriterionSchema,
	criticalitySchema,
	delegationV2OutputContractAllowed,
	dv2OutcomeSchema,
	goalContractSchema,
	outputContractIdSchema,
	roleSchema,
	workKindSchema,
	DELEGATION_V2_REGISTRY_VERSION,
} from "./delegationV2Schemas.ts";
import { hashStableValue } from "./delegationV2Ids.js";
import { DELEGATION_V2_COMPILER_VERSION } from "./delegationV2Compiler.js";
import {
	DELEGATION_V2_PROMPT_CONTRACT_VERSION,
	DELEGATION_V2_PROTOCOL_VERSION,
} from "./delegationV2Prompts.js";
import { verifyBoundCriticalExecutionGrant } from "./delegationV2CriticalExecution.js";

export const DELEGATION_V2_RUNTIME_VERSION = "delegation-v2.runtime-7";
export const DELEGATION_V2_SETTLEMENT_VERSION = "delegation-v2.settlement-2";

/** @param {unknown} value */
function boundedMessage(value) {
	return String(value ?? "The agent returned an invalid terminal envelope.").slice(0, 2_048);
}

/** @param {import("zod").ZodError} error */
function issueSummary(error) {
	return error.issues
		.slice(0, 8)
		.map((issue) => `${issue.path.join(".") || "outcome"}: ${issue.message}`)
		.join("; ")
		.slice(0, 1_900);
}

/**
 * Convert an untrusted agent envelope into the one trusted settlement shape.
 * The persisted row contains the assigned criterion ids and assignment digest,
 * allowing its own Zod contract to audit exact criterion/evidence coverage on
 * insert, replay, and final nesting.
 *
 * @param {Record<string, any>} assignment
 */
function normalizeAssignment(assignment) {
	if (!assignment || typeof assignment !== "object") throw new TypeError("trusted Trellis assignment must be an object");
	const role = roleSchema.parse(assignment.role);
	const work = workKindSchema.parse(assignment.work);
	const outputContract = outputContractIdSchema.parse(assignment.outputContract);
	if (!delegationV2OutputContractAllowed(work, outputContract)) {
		throw new TypeError(`trusted Trellis assignment cannot bind ${work} to ${outputContract}`);
	}
	const goal = goalContractSchema.parse(assignment.goal);
	const acceptance = acceptanceCriterionSchema.array().min(1).max(32).parse(assignment.acceptance);
	if (new Set(acceptance.map((criterion) => criterion.id)).size !== acceptance.length) {
		throw new TypeError("trusted Trellis assignment acceptance ids must be unique");
	}
	const criticality = assignment.criticality == null ? null : criticalitySchema.parse(assignment.criticality);
	const criticalExecutionGrant = assignment.criticalExecutionGrant == null
		? null
		: verifyBoundCriticalExecutionGrant(assignment.criticalExecutionGrant);
	if (criticalExecutionGrant && (role !== criticalExecutionGrant.actor.role || work !== "execute")) {
		throw new TypeError("trusted Trellis assignment does not match its critical execution actor");
	}
	if (criticalExecutionGrant && !criticality) {
		throw new TypeError("trusted Trellis critical execution grant requires its normalized request");
	}
	return {
		role,
		work,
		outputContract,
		goal,
		instructions: assignment.instructions ?? null,
		acceptance,
		criticality,
		criticalExecutionGrant,
		directExecutionAllowed: criticalExecutionGrant !== null,
	};
}

/** @param {Record<string, any>} assignment */
export function delegationV2AssignmentDigest(assignment) {
	const normalized = normalizeAssignment(assignment);
	return hashStableValue({
		type: "trellis-assignment",
		runtimeVersion: DELEGATION_V2_RUNTIME_VERSION,
		settlementVersion: DELEGATION_V2_SETTLEMENT_VERSION,
		protocolVersion: DELEGATION_V2_PROTOCOL_VERSION,
		promptContractVersion: DELEGATION_V2_PROMPT_CONTRACT_VERSION,
		registryVersion: DELEGATION_V2_REGISTRY_VERSION,
		compilerVersion: DELEGATION_V2_COMPILER_VERSION,
		...normalized,
	});
}

/**
 * @param {{
 *   envelope?: Record<string, any>,
 *   assignment: Record<string, any>,
 *   identity: Record<string, any>,
 *   taskFailure?: {code: "crash"|"timeout"|"invalid_return"|"cancelled"|"budget_exhausted"|"invalid_subworkflow", message: string},
 * }} options
 */
export function settleDelegationV2Envelope({ envelope, assignment, identity, taskFailure }) {
	const trustedAssignment = normalizeAssignment(assignment);
	const trustedIdentity = {
		...identity,
		role: trustedAssignment.role,
		work: trustedAssignment.work,
		outputContract: trustedAssignment.outputContract,
		assignmentDigest: delegationV2AssignmentDigest(trustedAssignment),
		acceptanceCriterionIds: trustedAssignment.acceptance.map((criterion) => criterion.id),
	};
	const grantActor = trustedAssignment.criticalExecutionGrant?.actor;
	const grantMismatch = grantActor && (
		grantActor.invocationKey !== identity.invocationKey ||
		grantActor.logicalId !== identity.logicalId ||
		grantActor.role !== trustedAssignment.role ||
		grantActor.work !== trustedAssignment.work ||
		(identity.programDigest !== undefined && grantActor.programDigest !== identity.programDigest)
	);
	const ungrantedDirectCompletion = envelope?.outcome?.tag === "complete" &&
		["sol", "fable"].includes(trustedAssignment.role) &&
		trustedAssignment.work === "execute" && !trustedAssignment.criticalExecutionGrant;
	let candidate;
	if (grantMismatch || ungrantedDirectCompletion) {
		candidate = {
			...trustedIdentity,
			status: "runtime_failed",
			runtimeFailure: {
				code: "invalid_return",
				message: grantMismatch
					? "The critical execution grant did not match this immutable actor identity."
					: "Sol/Fable cannot complete execute work without a trusted critical execution grant.",
			},
		};
	} else if (envelope?.outcome?.tag === "complete") {
		candidate = { ...trustedIdentity, status: "complete", product: envelope.outcome.value };
	} else if (envelope?.outcome?.tag === "blocked") {
		candidate = { ...trustedIdentity, status: "blocked", blockage: envelope.outcome.value };
	} else {
		candidate = {
			...trustedIdentity,
			status: "runtime_failed",
			runtimeFailure: taskFailure ?? {
				code: "invalid_return",
				message: "The agent task failed or did not persist a valid terminal envelope.",
			},
		};
	}

	const parsed = dv2OutcomeSchema.safeParse(candidate);
	if (parsed.success) return parsed.data;
	if (candidate.status === "runtime_failed") {
		throw new TypeError(`trusted Trellis outcome identity is invalid: ${issueSummary(parsed.error)}`);
	}
	const rejected = {
		...trustedIdentity,
		status: "runtime_failed",
		runtimeFailure: {
			code: "invalid_return",
			message: boundedMessage(`Agent terminal claim failed assignment settlement: ${issueSummary(parsed.error)}`),
		},
	};
	const fallback = dv2OutcomeSchema.safeParse(rejected);
	if (!fallback.success) {
		throw new TypeError(`trusted Trellis outcome identity is invalid: ${issueSummary(fallback.error)}`);
	}
	return fallback.data;
}
