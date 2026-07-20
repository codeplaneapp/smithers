import { z } from "zod";

/**
 * Delegation-chain output tables — the single source of truth for every
 * `dc*` row shape (see the delegation-chain contract). Core, components, and
 * UI builders import these; nothing redefines them.
 *
 * Register the whole set in `createSmithers` and hand the resulting
 * `outputs` subset to the delegation composites:
 *
 * ```ts
 * const { smithers, outputs } = createSmithers({ ...delegationSchemas, ...own });
 * <DelegationChain outputs={outputs} ... />
 * ```
 */

/** Intelligence tiers, strongest → cheapest. Labels only; each maps to an AgentLike via the `agents` prop. */
export const tierSchema = z.enum(["fable", "opus", "sonnet", "haiku"]);

/** Default tier ladder: fable plans root, opus plans chunks, sonnet executes leaves, haiku previews/probes. */
export const DEFAULT_TIER_ORDER = ["fable", "opus", "sonnet", "haiku"];

/** Durable signal event name for live user edits (fixed by contract — the UI submits to this key). */
export const DC_EDIT_SIGNAL = "dc-edit";
/** Durable signal event name for skipping the zero-backpressure preview phase. */
export const DC_SKIP_PREVIEW_SIGNAL = "dc-skip-preview";

/** A delegation node's predicted (or measured) resource envelope. */
export const estimateSchema = z.object({
	tokens: z.number(),
	costUsd: z.number(),
	minutes: z.number(),
});

/** Developer-preview gate kinds: what artifact proves the node's work is showable. */
export const devPreviewKindSchema = z.enum(["app", "terminal", "api", "throwaway-ui", "slideshow"]);

/**
 * A declared backpressure gate. Approval gates are only honored when an
 * approvalPolicy prompt was provided. A `preview` gate is a DEVELOPER
 * PREVIEW: it runs AFTER the node's execution, its successful build
 * (`builtOk`) is REQUIRED for the node to pass, and its artifact carries the
 * UI's invalidate / request-changes affordances (which emit dc-edit rounds).
 */
export const gateSchema = z.discriminatedUnion("method", [
	z.object({ method: z.literal("review"), tier: tierSchema, brief: z.string() }),
	z.object({ method: z.literal("check"), command: z.string() }),
	z.object({ method: z.literal("approval"), policyMatch: z.string() }),
	z.object({ method: z.literal("preview"), kind: devPreviewKindSchema, brief: z.string() }),
]);

/**
 * Final refined goal. Written by the goal-refinement agent, then re-written by
 * the human approval HumanTask. Defaults keep degraded agent output moving
 * toward the approval gate (where a human sees and can reject it) instead of
 * burning validation retries — the GrillMe precedent.
 */
export const dcGoalSchema = z.object({
	logicalId: z.string().default("goal"),
	refinedPrompt: z.string().default(""),
	assumptions: z.array(z.string()).default([]),
	questionsAsked: z.number().int().default(0),
});

/** Rendered form metadata for one goal-refinement question (haiku prefetch renders these ahead of the user). */
export const dcQuestionSchema = z.object({
	logicalId: z.string(),
	seq: z.number().int(),
	question: z.string(),
	header: z.string(),
	kind: z.enum(["select", "confirm", "text"]),
	options: z.array(z.object({ label: z.string(), description: z.string() })).optional(),
	recommended: z.string(),
	reason: z.string(),
	resolved: z.boolean(),
});

/**
 * The goal agent's upfront question forecast (raw JSON batch). Internal to the
 * components package: a smithers task writes exactly one row, so the batch of
 * questions rides one dcForecast row and per-question haiku tasks fan out
 * dcQuestion rows from it.
 */
export const dcForecastSchema = z.object({
	logicalId: z.string().default("goal"),
	total: z.number().int().default(0),
	questions: z.array(
		z.object({
			seq: z.number().int(),
			question: z.string(),
			kind: z.enum(["select", "confirm", "text"]),
			options: z.array(z.object({ label: z.string(), description: z.string() })).optional(),
			recommended: z.string(),
			reason: z.string(),
		}),
	).default([]),
});

/**
 * The human's refined-prompt approval (internal): the delegation UI submits
 * `{ approved, refinedPrompt }` to the `dc:<goal>:approve` HumanTask, and the
 * (possibly edited) refinedPrompt becomes the root planning brief.
 */
export const dcGoalApprovalSchema = z.object({
	approved: z.boolean(),
	refinedPrompt: z.string(),
});

/**
 * Path-style logical id: `[a-zA-Z0-9_-]` segments joined by "/". Agent-authored
 * ids must survive `physicalId`'s `/`→`:` encoding into the gateway node-id
 * charset (`[a-zA-Z0-9:_-]`, <=128 chars) — a space/dot/colon would produce a
 * physical id the gateway's getNodeOutput/getNodeDiff reject.
 */
const logicalIdSchema = z
	.string()
	.regex(
		/^[a-zA-Z0-9_-]+(\/[a-zA-Z0-9_-]+)*$/,
		'logicalId must be path-style with segments of [a-zA-Z0-9_-] joined by "/"',
	)
	.max(128);

/** One row per delegating node: its children, risks, and resource estimates. Replans append superseding rows. */
export const dcPlanSchema = z.object({
	logicalId: logicalIdSchema,
	tier: tierSchema,
	title: z.string(),
	brief: z.string(),
	children: z.array(
		z.object({
			logicalId: logicalIdSchema,
			tier: tierSchema,
			kind: z.enum(["chunk", "leaf"]),
			title: z.string(),
			brief: z.string(),
			estimate: estimateSchema,
		}),
	),
	subtreeEstimate: estimateSchema,
	risks: z.array(
		z.object({
			id: z.string(),
			description: z.string(),
			probe: z.enum(["poc", "research"]).nullable(),
			reason: z.string(),
		}),
	),
	// v2 higher-order orchestration: reserved. A "workflow" node will AUTHOR a
	// bespoke smithers workflow (its own state machine over the standard
	// component library) as its execution strategy instead of decomposing into
	// task subtrees. Deferred for UI/debuggability complexity; default "tasks".
	orchestration: z.enum(["tasks", "workflow"]).optional(),
});

/** Zero-backpressure haiku render of a leaf's expected output. NEVER executed — calibration only. */
export const dcPreviewSchema = z.object({
	logicalId: z.string(),
	expectedOutput: z.string(),
});

/** A node's declared backpressure gates and logical dependencies. */
export const dcGatesSchema = z.object({
	logicalId: z.string(),
	gates: z.array(gateSchema),
	depsLogical: z.array(logicalIdSchema),
});

/**
 * A developer-preview gate's built artifact (physical node phase
 * `dev-preview`). `builtOk: false` fails the gate like a failed review —
 * the node redelegates with the failure folded into the next attempt.
 */
export const dcDevPreviewSchema = z.object({
	logicalId: z.string(),
	kind: devPreviewKindSchema,
	title: z.string(),
	builtOk: z.boolean(),
	artifact: z.object({
		type: z.enum(["html", "url", "markdown"]),
		content: z.string().optional(),
		url: z.string().optional(),
	}),
	instructions: z.string().optional(),
	summary: z.string(),
});

/** A risk probe's finding. The report is delivered to the NEAREST PARENT only. */
export const dcProbeSchema = z.object({
	probeId: z.string(),
	parentLogicalId: z.string(),
	kind: z.enum(["poc", "research"]),
	question: z.string(),
	answer: z.string(),
	report: z.string(),
	planImpact: z.enum(["changes", "confirms", "none"]),
	proposedChange: z.string().optional(),
});

/** A replan decision for one affected node. `invalidated` bumps the node version; prior versions stay archived. */
export const dcReplanSchema = z.object({
	round: z.number().int(),
	logicalId: z.string(),
	decision: z.enum(["invalidated", "reaffirmed"]),
	reason: z.string(),
	trigger: z.object({
		type: z.enum(["probe", "user-edit", "review-fail"]),
		ref: z.string(),
	}),
});

/**
 * One execution attempt of a leaf. `actual` is best-effort self-reported
 * usage; `commitRange` is the working-copy commit measured before/after the
 * attempt (captured by the exec agent wrapper — omitted whenever capture
 * fails, never a reason to fail the exec).
 */
export const dcExecSchema = z.object({
	logicalId: z.string(),
	attempt: z.number().int(),
	summary: z.string(),
	artifacts: z.array(z.string()),
	actual: z
		.object({
			tokens: z.number().optional(),
			costUsd: z.number().optional(),
			minutes: z.number().optional(),
		})
		.optional(),
	commitRange: z
		.object({
			from: z.string(),
			to: z.string(),
			vcs: z.enum(["jj", "git"]),
		})
		.optional(),
});

/** A review/check gate verdict for one execution attempt. */
export const dcReviewSchema = z.object({
	logicalId: z.string(),
	attempt: z.number().int(),
	verdict: z.enum(["pass", "fail"]),
	feedback: z.string(),
});

/**
 * Approval-gate decision rows (only materialized when an approvalPolicy was
 * provided). Shape mirrors the stock `<Approval>` decision payload.
 */
export const dcApprovalSchema = z.object({
	approved: z.boolean(),
	note: z.string().nullable().optional(),
	decidedBy: z.string().nullable(),
	decidedAt: z.string().nullable(),
});

/** Live user-edit signal payload (event name `dc-edit`). Each edit triggers a replan round. */
export const dcEditSchema = z.object({
	editId: z.string(),
	logicalId: z.string(),
	editedOutput: z.unknown(),
	note: z.string().optional(),
});

/** Skip-previews signal payload (event name `dc-skip-preview`). */
export const dcSkipSchema = z.object({
	skipped: z.boolean(),
});

/** End-of-run satisfaction poll (HumanTask json form). */
export const dcPollSchema = z.object({
	answers: z.array(
		z.object({
			question: z.string(),
			rating: z.number().int().min(1).max(5),
		}),
	),
	comment: z.string().optional(),
});

/**
 * Budget-guard checkpoints (internal, written only when a `budget` prop is
 * set): rolled-up dcExec actuals compared against the caller's budget. A hard
 * breach fails the guard task (error into the run); >= 80% emits a `warn` row.
 */
export const dcBudgetSchema = z.object({
	logicalId: z.string(),
	level: z.enum(["ok", "warn"]),
	totalUsd: z.number(),
	maxUsd: z.number().nullable(),
	totalMinutes: z.number(),
	maxMinutes: z.number().nullable(),
});

/** Run-level scoring digest (internal): the row delegation run scorers evaluate. */
export const dcScoreSchema = z.object({
	logicalId: z.string(),
	summary: z.string(),
});

/**
 * All delegation-chain tables keyed by table name — spread into
 * `createSmithers({ ...delegationSchemas })` to register them.
 */
export const delegationSchemas = {
	dcGoal: dcGoalSchema,
	dcQuestion: dcQuestionSchema,
	dcForecast: dcForecastSchema,
	dcGoalApproval: dcGoalApprovalSchema,
	dcPlan: dcPlanSchema,
	dcPreview: dcPreviewSchema,
	dcDevPreview: dcDevPreviewSchema,
	dcGates: dcGatesSchema,
	dcProbe: dcProbeSchema,
	dcReplan: dcReplanSchema,
	dcExec: dcExecSchema,
	dcReview: dcReviewSchema,
	dcApproval: dcApprovalSchema,
	dcEdit: dcEditSchema,
	dcSkip: dcSkipSchema,
	dcPoll: dcPollSchema,
	dcBudget: dcBudgetSchema,
	dcScore: dcScoreSchema,
};
