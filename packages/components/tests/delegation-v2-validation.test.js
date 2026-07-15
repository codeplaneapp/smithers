import { describe, expect, test } from "bun:test";
import { validateWorkflowProgram } from "../src/components/delegation-v2/delegationV2Validate.js";
import { hashStableValue } from "../src/components/delegation-v2/delegationV2Ids.js";
import { DELEGATION_V2_COMPILER_VERSION } from "../src/components/delegation-v2/delegationV2Compiler.js";
import {
	DELEGATION_V2_REGISTRY_VERSION,
	dv2ValidationSchema,
	validationDiagnosticCodeSchema,
} from "../src/components/delegation-v2/delegationV2Schemas.ts";

const goal = {
	objective: "Produce a bounded result.",
	context: [],
	constraints: [],
	nonGoals: [],
};

function agent(overrides = {}) {
	return {
		tag: "agent",
		id: "worker",
		role: "luna",
		work: "research",
		goal,
		prompt: { instructions: "Do the assigned work and return evidence.", contextRefs: [] },
		inputs: [],
		acceptance: [{ id: "done", requirement: "Produce the result.", verification: "Inspect the evidence." }],
		outputContract: "work_product",
		...overrides,
	};
}

function program(root, outputs = undefined) {
	const leaves = [];
	function collect(expr) {
		if (expr.tag === "agent") leaves.push(expr);
		else for (const child of expr.tag === "sequence" ? expr.steps : expr.branches) collect(child);
	}
	collect(root);
	const last = leaves.at(-1);
	return {
		schemaVersion: 1,
		registryVersion: DELEGATION_V2_REGISTRY_VERSION,
		id: "program",
		objective: goal,
		rationale: "This is the smallest topology that proves the goal.",
		root,
		outputs: outputs ?? [{ from: last.id, contract: last.outputContract }],
	};
}

function codes(result) {
	return new Set(result.diagnostics.map((diagnostic) => diagnostic.code));
}

describe("delegation v2 semantic validation", () => {
	test("accepts direct, pipeline, and fan-out/fan-in programs with a normalized digest", () => {
		const direct = validateWorkflowProgram(program(agent()));
		expect(direct.ok).toBe(true);
		expect(direct.programDigest).toBe(hashStableValue(direct.normalizedProgram));

		const source = agent({ id: "source" });
		const synth = agent({
			id: "synth",
			role: "terra",
			work: "synthesize",
			inputs: [{ from: "source", contract: "work_product", purpose: "Synthesize the finding." }],
			prompt: { instructions: "Synthesize the finding.", contextRefs: ["source"] },
		});
		expect(validateWorkflowProgram(program({ tag: "sequence", id: "pipeline", steps: [source, synth] })).ok).toBe(true);

		const left = agent({ id: "left" });
		const right = agent({ id: "right" });
		const join = agent({
			id: "join",
			role: "terra",
			work: "synthesize",
			inputs: [
				{ from: "left", contract: "work_product", purpose: "Compare the first result." },
				{ from: "right", contract: "work_product", purpose: "Compare the second result." },
			],
			prompt: { instructions: "Reconcile the independent findings.", contextRefs: ["left", "right"] },
		});
		const fanIn = program({
			tag: "sequence",
			id: "gather",
			steps: [{ tag: "parallel", id: "fanout", branches: [left, right], maxConcurrency: 2 }, join],
		});
		expect(validateWorkflowProgram(fanIn, { rootMaxConcurrency: 2 }).ok).toBe(true);
	});

	test("rejects duplicate and reserved logical IDs", () => {
		const duplicate = program({ tag: "sequence", id: "pipeline", steps: [agent({ id: "same" }), agent({ id: "same" })] });
		expect(codes(validateWorkflowProgram(duplicate))).toContain("duplicate_id");
		expect(codes(validateWorkflowProgram(program(agent({ id: "trellis-worker" }))))).toContain("reserved_id");
		expect(codes(validateWorkflowProgram(program(agent({ id: "trellis_worker" }))))).toContain("reserved_id");
	});

	test("bounds hostile diagnostics so every rejection remains persistable", () => {
		const noisy = Array.from({ length: 30 }, (_, index) => agent({
			id: `worker-${index}`,
			inputs: Array.from({ length: 16 }, (__, inputIndex) => ({
				from: `missing-${index}-${inputIndex}`,
				contract: "work_product",
				purpose: "Exercise bounded rejection diagnostics.",
			})),
			prompt: {
				instructions: "Exercise bounded rejection diagnostics.",
				contextRefs: Array.from({ length: 16 }, (__, inputIndex) => `missing-${index}-${inputIndex}`),
			},
		}));
		const result = validateWorkflowProgram(program(
			{ tag: "sequence", id: "noisy", steps: noisy },
			[{ from: noisy.at(-1).id, contract: "work_product" }],
		));
		expect(result.ok).toBe(false);
		expect(result.diagnostics).toHaveLength(128);
		expect(result.diagnostics.every((diagnostic) => diagnostic.path.length <= 512 && diagnostic.message.length <= 2_048)).toBe(true);
		expect(dv2ValidationSchema.safeParse({
			invocationKey: "trellis:root",
			generation: 0,
			authorNodeId: "trellis:root:author",
			status: result.status,
			programDigest: result.programDigest,
			registryVersion: DELEGATION_V2_REGISTRY_VERSION,
			compilerVersion: DELEGATION_V2_COMPILER_VERSION,
			diagnostics: result.diagnostics,
			stats: result.stats,
		}).success).toBe(true);
	});

	test("preflights hostile depth iteratively before recursive schema parsing", () => {
		let root = agent({ id: "deep-worker" });
		for (let depth = 0; depth < 10_000; depth += 1) {
			root = { tag: "sequence", id: `deep-${depth}`, steps: [root] };
		}
		const result = validateWorkflowProgram({
			schemaVersion: 1,
			registryVersion: DELEGATION_V2_REGISTRY_VERSION,
			id: "deep-program",
			objective: goal,
			rationale: "Hostile depth must become a bounded rejection.",
			root,
			outputs: [{ from: "deep-worker", contract: "work_product" }],
		});
		expect(result.ok).toBe(false);
		expect(result.diagnostics).toEqual([expect.objectContaining({ code: "depth_limit", path: "root.root" })]);
	});

	test("binds programs to the trusted runtime registry version", () => {
		const selectedByModel = { ...program(agent()), registryVersion: "model-selected.registry" };
		expect(codes(validateWorkflowProgram(selectedByModel))).toContain("registry_mismatch");
		expect(validateWorkflowProgram(selectedByModel, { expectedRegistryVersion: "model-selected.registry" }).ok).toBe(true);
	});

	test("enforces the role/work matrix and critical author execution contract", () => {
		expect(codes(validateWorkflowProgram(program(agent({ work: "plan" }))))).toContain("role_work_forbidden");
		expect(codes(validateWorkflowProgram(program(agent({ role: "terra", work: "refine_goal" }))))).toContain("role_work_forbidden");
		expect(codes(validateWorkflowProgram(program(agent({ role: "sol", work: "execute" }))))).toContain("criticality_required");

		const execute = agent({
			id: "critical-code",
			role: "fable",
			work: "execute",
			criticality: {
				category: "concurrency_invariant",
				invariant: "One durable state transition wins.",
				whyHighTierIsRequired: "The proof spans scheduler and persistence code.",
				whyTheCoreCannotBeDelegated: "Splitting the transaction loses the ordering invariant.",
				allowedPaths: ["packages/scheduler/src/state.js"],
				expectedChangedLines: 24,
				lineSensitivity: "Every branch participates in the transition proof.",
				surroundingWorkDelegatedTo: [],
				reviewNodeId: "independent-review",
			},
		});
		const review = agent({
			id: "independent-review",
			work: "review",
			inputs: [{ from: "critical-code", contract: "work_product", purpose: "Review the critical implementation." }],
			prompt: { instructions: "Independently review every changed invariant.", contextRefs: ["critical-code"] },
		});
		const policy = {
			allowedCategories: ["concurrency_invariant"],
			allowedPathPrefixes: ["packages/scheduler"],
			maxChangedLines: 40,
		};
		const criticalProgram = program({ tag: "sequence", id: "critical-flow", steps: [execute, review] });
		expect(codes(validateWorkflowProgram(criticalProgram))).toContain("criticality_ungranted");
		expect(validateWorkflowProgram(criticalProgram, { criticalExecutionPolicy: policy }).ok).toBe(true);
		const sameRoleReview = program({
			tag: "sequence",
			id: "critical-flow",
			steps: [execute, { ...review, role: "fable" }],
		});
		expect(codes(validateWorkflowProgram(sameRoleReview, { criticalExecutionPolicy: policy }))).toContain(
			"critical_review_not_independent",
		);
		expect(validationDiagnosticCodeSchema.parse("critical_review_not_independent")).toBe(
			"critical_review_not_independent",
		);
		expect(codes(validateWorkflowProgram(criticalProgram, {
			criticalExecutionPolicy: policy,
			criticalReviewIndependentRoles: { sol: ["fable", "terra", "luna"], fable: ["sol", "terra"] },
		}))).toContain("critical_review_not_independent");
		expect(validateWorkflowProgram(criticalProgram, {
			criticalExecutionPolicy: policy,
			criticalReviewIndependentRoles: { sol: ["fable", "terra", "luna"], fable: ["sol", "terra", "luna"] },
		}).ok).toBe(true);
		const racesReview = program(
			{ tag: "sequence", id: "critical-flow", steps: [execute, review] },
			[{ from: "critical-code", contract: "work_product" }],
		);
		expect(codes(validateWorkflowProgram(racesReview, { criticalExecutionPolicy: policy }))).toContain("critical_review_not_joined");
		expect(codes(validateWorkflowProgram(program(execute), { criticalExecutionPolicy: policy }))).toContain("critical_review_missing");
		expect(codes(validateWorkflowProgram(criticalProgram, {
			criticalExecutionPolicy: { ...policy, allowedPathPrefixes: ["packages/engine"] },
		}))).toContain("criticality_policy_mismatch");
	});

	test("rejects missing, forward, sibling, and contract-incompatible references", () => {
		const missing = agent({
			id: "consumer",
			inputs: [{ from: "absent", contract: "work_product", purpose: "Use missing evidence." }],
			prompt: { instructions: "Consume the evidence.", contextRefs: ["absent"] },
		});
		expect(codes(validateWorkflowProgram(program(missing)))).toContain("reference_missing");

		const later = agent({ id: "later", outputContract: "evaluation" });
		const earlier = agent({
			id: "earlier",
			inputs: [{ from: "later", contract: "work_product", purpose: "Use future evidence." }],
			prompt: { instructions: "Consume the evidence.", contextRefs: ["later"] },
		});
		const forward = program({ tag: "sequence", id: "forward-flow", steps: [earlier, later] });
		expect(codes(validateWorkflowProgram(forward))).toContain("reference_forward");

		const siblingConsumer = agent({
			id: "consumer",
			inputs: [{ from: "producer", contract: "work_product", purpose: "Read a sibling." }],
			prompt: { instructions: "Consume sibling evidence.", contextRefs: ["producer"] },
		});
		const sibling = program({ tag: "parallel", id: "siblings", branches: [agent({ id: "producer" }), siblingConsumer] });
		expect(codes(validateWorkflowProgram(sibling))).toContain("parallel_sibling_reference");

		const mismatchConsumer = agent({
			id: "mismatch",
			inputs: [{ from: "later", contract: "work_product", purpose: "Read the result." }],
			prompt: { instructions: "Consume evidence.", contextRefs: ["later"] },
		});
		const mismatch = program({ tag: "sequence", id: "mismatch-flow", steps: [later, mismatchConsumer] });
		expect(codes(validateWorkflowProgram(mismatch))).toContain("reference_contract_mismatch");
	});

	test("enforces resource limits and rejects unsupported nested authored caps", () => {
		const nested = {
			tag: "parallel",
			id: "outer",
			maxConcurrency: 2,
			branches: [
				{ tag: "parallel", id: "inner", maxConcurrency: 2, branches: [agent({ id: "a" }), agent({ id: "b" })] },
				agent({ id: "c" }),
			],
		};
		const nestedResult = validateWorkflowProgram(program(nested), { rootMaxConcurrency: 2 });
		expect(codes(nestedResult)).toContain("unsupported_nested_concurrency");
		const uncappedInner = {
			...nested,
			branches: [{ tag: "parallel", id: "inner", branches: [agent({ id: "a" }), agent({ id: "b" })] }, agent({ id: "c" })],
		};
		expect(codes(validateWorkflowProgram(program(uncappedInner), { rootMaxConcurrency: 2 }))).toContain("unsupported_nested_concurrency");
		const recursiveInner = program({
			tag: "parallel",
			id: "recursive-inner",
			branches: [agent({ id: "a" }), agent({ id: "b" })],
			maxConcurrency: 2,
		});
		expect(codes(validateWorkflowProgram(recursiveInner, {
			rootMaxConcurrency: 2,
			hasCappedParallelAncestor: true,
		}))).toContain("unsupported_nested_concurrency");
		expect(codes(validateWorkflowProgram(program({ tag: "parallel", id: "wide", maxConcurrency: 4, branches: [agent({ id: "a" }), agent({ id: "b" })] }), { rootMaxConcurrency: 2 }))).toContain("concurrency_limit");
		expect(codes(validateWorkflowProgram(program(agent({ prompt: { instructions: "🙂🙂🙂", contextRefs: [] } })), { limits: { maxPromptBytes: 4 } }))).toContain("prompt_limit");
		expect(codes(validateWorkflowProgram(program(agent()), { limits: { maxDepth: 1, maxNodes: 1, maxFanout: 1, maxConcurrency: 1, maxAuthors: 1, maxPromptBytes: 100, maxTotalPromptBytes: 100 } }))).not.toContain("depth_limit");
	});

	test("rejects nested authors before mounting when recursive author depth is exhausted", () => {
		const nestedAuthor = program(agent({ id: "nested", role: "sol", work: "research" }));
		expect(codes(validateWorkflowProgram(nestedAuthor, { allowAuthorChildren: false }))).toContain("author_depth_limit");
		expect(validateWorkflowProgram(program(agent({ id: "leaf", role: "luna" })), {
			allowAuthorChildren: false,
		}).ok).toBe(true);
	});

	test("rejects parallel shared-workspace writes unless trusted isolation permits them", () => {
		const writes = program({
			tag: "parallel",
			id: "writes",
			branches: [agent({ id: "write-a", work: "execute" }), agent({ id: "write-b", work: "execute" })],
		});
		expect(codes(validateWorkflowProgram(writes))).toContain("parallel_write_conflict");
		expect(codes(validateWorkflowProgram(writes, { allowParallelWrites: true }))).not.toContain("parallel_write_conflict");

		const nestedAuthors = program({
			tag: "parallel",
			id: "author-wave",
			branches: [
				agent({ id: "sol-author", role: "sol", work: "plan" }),
				agent({ id: "fable-author", role: "fable", work: "research" }),
			],
		}, [
			{ from: "sol-author", contract: "work_product" },
			{ from: "fable-author", contract: "work_product" },
		]);
		expect(codes(validateWorkflowProgram(nestedAuthors))).toContain("parallel_write_conflict");
	});

	test("requires declared outputs to exist once, with the source contract", () => {
		const root = agent({ id: "result", outputContract: "evaluation" });
		expect(codes(validateWorkflowProgram(program(root, [{ from: "missing", contract: "evaluation" }])))).toContain("output_missing");
		expect(codes(validateWorkflowProgram(program(root, [{ from: "result", contract: "work_product" }])))).toContain("output_contract_mismatch");
		expect(codes(validateWorkflowProgram(program(root, [
			{ from: "result", contract: "evaluation" },
			{ from: "result", contract: "evaluation" },
		])))).toContain("output_duplicate");
	});
});
