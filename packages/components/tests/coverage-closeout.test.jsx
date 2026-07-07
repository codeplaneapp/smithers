/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { SmithersRenderer } from "@smithers-orchestrator/react-reconciler/dom/renderer";
import { GeminiAgent } from "@smithers-orchestrator/agents/GeminiAgent";
import { SMITHERS_WORKFLOW_VIEW_KIND, TUI, UI } from "../src/components/index.js";
import { Loop as LoopFromModule, Ralph as RalphFromModule } from "../src/components/Loop.js";
import { Task } from "../src/components/index.js";
import { Saga, SagaStep } from "../src/components/Saga.js";
import { computeSidecarDelta } from "../src/components/computeSidecarDelta.ts";
import { zodSchemaToJsonExample } from "../src/zod-to-example.js";
import {
	actualTotals,
	agentForTier,
	chunkGateFailures,
	delegatingTierFor,
	dependentsOf,
	executionComplete,
	foldGates,
	foldPlans,
	frontierLeaves,
	latestRow,
	leafAttemptState,
	leafComplete,
	leavesUnder,
	nodeIndex,
	pendingTriggers,
	physicalId,
	planningComplete,
	planOwnerOf,
	probeIdFor,
	probesRequested,
	readRows,
	replanCountFor,
	rowsForNode,
	splitGates,
	synthesizeDelegationEvents,
	triggerTargetOf,
	unplannedChunks,
} from "../src/components/delegation/delegationState.js";
import { captureWorkingCopyCommit, withCommitRange } from "../src/components/delegation/withCommitRange.js";

describe("UI / TUI view markers", () => {
	test("UI and TUI render nothing and carry their view-kind symbol", () => {
		expect(UI({ view: "./view.tsx" })).toBeNull();
		expect(TUI({ view: "./tui.tsx" })).toBeNull();
		expect(UI[SMITHERS_WORKFLOW_VIEW_KIND]).toBe("ui");
		expect(TUI[SMITHERS_WORKFLOW_VIEW_KIND]).toBe("tui");
	});
});

describe("Loop.js re-export module", () => {
	test("re-exports Loop and Ralph from Ralph.js", () => {
		expect(typeof LoopFromModule).toBe("function");
		expect(typeof RalphFromModule).toBe("function");
	});
});

describe("computeSidecarDelta edge branches", () => {
	test("sorts multiple matching rows (missing scoredAtMs treated as 0) and ignores rows with no scorer", () => {
		const rows = [
			{ nodeId: "answer", scorerId: "quality", score: 0.9, scoredAtMs: 5 },
			// Same node+scorer, no scoredAtMs -> getScoredAtMs returns 0 in the sort comparator.
			{ nodeId: "answer", scorerId: "quality", score: 0.5 },
			// No scorer at all -> getScorerId returns undefined and the row is filtered out.
			{ nodeId: "answer", score: 0.3, scoredAtMs: 9 },
			{ nodeId: "answer-sidecar", scorerId: "quality", score: 0.7, scoredAtMs: 2 },
		];
		const result = computeSidecarDelta(rows, {
			primaryNodeId: "answer",
			sidecarNodeId: "answer-sidecar",
			scorerId: "quality",
		});
		expect(result.primaryScore).toBe(0.9); // scoredAtMs 5 beats the 0-defaulted row
		expect(result.sidecarScore).toBe(0.7);
		expect(result.delta).toBeCloseTo(0.2, 10);
		expect(result.cheaperWins).toBe(false);
	});

	test("returns null delta when a side has no score", () => {
		const result = computeSidecarDelta([], {
			primaryNodeId: "answer",
			sidecarNodeId: "answer-sidecar",
		});
		expect(result).toEqual({
			primaryScore: null,
			sidecarScore: null,
			delta: null,
			cheaperWins: false,
		});
	});
});

describe("zodSchemaToJsonExample default with undefined value", () => {
	test("falls back to the wrapped type's shape when a default carries no concrete value", () => {
		const example = zodSchemaToJsonExample(z.object({ a: z.string().default(undefined) }));
		expect(JSON.parse(example)).toEqual({ a: "string" });
	});
});

describe("delegationState helpers", () => {
	const planRows = [
		{
			logicalId: "root",
			tier: "fable",
			title: "Root",
			brief: "b",
			children: [
				{ logicalId: "root/a", tier: "opus", kind: "leaf", title: "A", brief: "ba" },
				{ logicalId: "root/b", tier: "opus", kind: "leaf", title: "B", brief: "bb" },
			],
			risks: [
				{ id: "r1", probe: "poc" },
				{ id: "r2", probe: "research" },
				{ id: "r3", probe: "none" },
			],
		},
	];
	const plans = foldPlans(planRows);

	test("leavesUnder expands a chunk id to every leaf beneath it, and matches an exact leaf", () => {
		expect(frontierLeaves(plans).map((l) => l.logicalId).sort()).toEqual(["root/a", "root/b"]);
		expect(leavesUnder("root", plans).map((l) => l.logicalId).sort()).toEqual(["root/a", "root/b"]);
		expect(leavesUnder("root/a", plans).map((l) => l.logicalId)).toEqual(["root/a"]);
	});

	test("probeIdFor is deterministic and probesRequested returns only poc/research risks", () => {
		expect(probeIdFor("root", "r1")).toBe("root#r1");
		const probes = probesRequested(plans);
		expect(probes.map((p) => p.probeId).sort()).toEqual(["root#r1", "root#r2"]);
		expect(probes.map((p) => p.kind).sort()).toEqual(["poc", "research"]);
		// A plan with no risks array exercises the `?? []` guard.
		const noRisk = foldPlans([{ logicalId: "solo", tier: "fable", title: "S", brief: "b" }]);
		expect(probesRequested(noRisk)).toEqual([]);
	});

	test("planOwnerOf walks to the nearest ancestor with a plan row, or null", () => {
		expect(planOwnerOf("root/a", plans)).toBe("root");
		expect(planOwnerOf("does/not/exist", plans)).toBeNull();
	});

	test("readRows returns [] for missing ctx/target and swallows resolveTableName failures", () => {
		expect(readRows(null, "t")).toEqual([]);
		expect(readRows({ resolveTableName: () => "t", outputs: () => [] }, null)).toEqual([]);
		const throwingCtx = {
			resolveTableName() {
				throw new Error("boom");
			},
			outputs: () => [],
		};
		expect(readRows(throwingCtx, "t")).toEqual([]);
		const okCtx = {
			resolveTableName: (t) => t,
			outputs: () => [{ nodeId: "x" }],
		};
		expect(readRows(okCtx, "t")).toEqual([{ nodeId: "x" }]);
	});

	test("agentForTier resolves direct, forward, and backward through the tier order", () => {
		const fable = { id: "fable" };
		const haiku = { id: "haiku" };
		expect(agentForTier({ haiku }, "haiku")).toBe(haiku); // direct
		expect(agentForTier({ haiku }, "fable")).toBe(haiku); // forward search
		expect(agentForTier({ fable }, "haiku")).toBe(fable); // backward search
		expect(agentForTier({}, "haiku")).toBeUndefined(); // nothing available
	});

	test("leafComplete gates on every approval row when an approval policy is set", () => {
		const leaf = { logicalId: "root/a", parentId: "root", tier: "opus", kind: "leaf", title: "A", brief: "b" };
		const gates = new Map([["root/a", { gates: [{ method: "approval", policyMatch: "x" }] }]]);
		const execRows = [{ nodeId: physicalId("dc", "root/a", "exec"), iteration: 0, logicalId: "root/a" }];
		const base = {
			idPrefix: "dc",
			leaf,
			gates,
			approvalPolicy: "approve everything",
			execRows,
			reviewRows: [],
		};
		// Approval present and approved -> complete.
		expect(
			leafComplete({
				...base,
				approvalRows: [{ nodeId: physicalId("dc", "root/a", "approval-1"), approved: true }],
			}),
		).toBe(true);
		// No approval row -> the every() callback returns false, so the leaf is incomplete.
		expect(leafComplete({ ...base, approvalRows: [] })).toBe(false);
	});
});

describe("delegationState exhaustive callback coverage", () => {
	// A chunk (root) that owns a leaf (root/a). root/a is a frontier leaf.
	const planRows = [
		{
			logicalId: "root",
			tier: "fable",
			title: "Root",
			brief: "b",
			children: [{ logicalId: "root/a", tier: "opus", kind: "leaf", title: "A", brief: "ba" }],
			risks: [{ id: "r1", probe: "poc" }],
		},
		// A non-string logicalId row is skipped by foldPlans.
		{ logicalId: 123, tier: "fable", title: "bad", brief: "b" },
	];
	const plans = foldPlans(planRows);
	const idPrefix = "dc";
	const reviewGate = { method: "review", tier: "opus", brief: "verify" };
	const gates = foldGates([
		{ logicalId: "root", gates: [reviewGate], depsLogical: ["root/a"] },
		{ logicalId: "root/a", gates: [reviewGate, { method: "approval", policyMatch: "x" }] },
		// A non-string logicalId is skipped by foldGates.
		{ logicalId: 7, gates: [] },
	]);

	test("row helpers, folds and indexes", () => {
		expect(rowsForNode([{ nodeId: "n@@1" }, { nodeId: "n" }, { nodeId: "other" }], "n")).toHaveLength(2);
		expect(latestRow([{ iteration: 0 }, { iteration: "2" }, { iteration: "x" }])).toEqual({ iteration: "2" });
		expect(latestRow([])).toBeUndefined();
		expect(nodeIndex(plans).get("root/a")?.kind).toBe("leaf");
		expect(unplannedChunks(plans)).toEqual([]);
		expect(planningComplete(plans)).toBe(true);
		expect(planningComplete(foldPlans([]))).toBe(false);
	});

	test("splitGates sorts each gate method and drops approvals without a policy", () => {
		const allMethods = {
			gates: [
				{ method: "review", tier: "opus", brief: "r" },
				{ method: "check", brief: "c" },
				{ method: "approval", policyMatch: "p" },
				{ method: "preview", kind: "ui", brief: "pv" },
			],
		};
		const withPolicy = splitGates(allMethods, "some policy");
		expect(withPolicy.reviews).toHaveLength(1);
		expect(withPolicy.checks).toHaveLength(1);
		expect(withPolicy.approvals).toHaveLength(1);
		expect(withPolicy.previews).toHaveLength(1);
		const withoutPolicy = splitGates(allMethods, undefined);
		expect(withoutPolicy.approvals).toHaveLength(0);
		expect(splitGates(undefined, undefined).reviews).toEqual([]);
	});

	test("dependentsOf cascades along child and reverse-dep edges", () => {
		const deps = dependentsOf("root/a", plans, gates);
		expect(deps).toContain("root"); // root depsLogical [root/a] -> reverse edge back to root
	});

	test("pendingTriggers folds probe/edit/review-fail flags, skipping addressed refs", () => {
		const probeRows = [
			{ probeId: "root#r1", parentLogicalId: "root", planImpact: "changes" },
			{ probeId: "root#r2", parentLogicalId: "root", planImpact: "none" },
		];
		const editRows = [
			{ editId: "edit-1", logicalId: "root/a" },
			{ notAnEdit: true },
		];
		const chunkFailures = [{ ref: "root:review-1#fail-1", logicalId: "root" }];
		const replanRows = [{ trigger: { ref: "root#r2" } }, { trigger: {} }];
		const triggers = pendingTriggers(probeRows, editRows, replanRows, chunkFailures);
		expect(triggers.map((t) => t.type).sort()).toEqual(["probe", "review-fail", "user-edit"]);
		expect(pendingTriggers([], [], [])).toEqual([]);
	});

	test("triggerTargetOf, replanCountFor and actualTotals", () => {
		expect(triggerTargetOf("root#r1", plans)).toBe("root");
		expect(triggerTargetOf("goal", plans)).toBe("root");
		expect(triggerTargetOf("root/a", plans)).toBe("root/a");
		expect(triggerTargetOf("goal", foldPlans([{ logicalId: "goal", tier: "fable", title: "g", brief: "b" }]))).toBe("goal");
		expect(replanCountFor([{ logicalId: "root" }, { logicalId: "root" }, { logicalId: "x" }], "root")).toBe(2);
		expect(
			actualTotals([
				{ actual: { tokens: 5, costUsd: 1, minutes: 2 } },
				{ actual: { tokens: 3 } },
				{ actual: "not-object" },
				{},
			]),
		).toEqual({ tokens: 8, costUsd: 1, minutes: 2 });
	});

	test("leafAttemptState folds gate verdicts and dev-preview build results", () => {
		const execId = physicalId(idPrefix, "root/a", "exec");
		const state = leafAttemptState({
			execRows: [{ nodeId: execId, iteration: 0 }],
			reviewRows: [{ nodeId: physicalId(idPrefix, "root/a", "review-1"), iteration: 0, verdict: "fail", feedback: "bad" }],
			execId,
			gateNodeIds: [physicalId(idPrefix, "root/a", "review-1")],
			devPreviewRows: [{ nodeId: physicalId(idPrefix, "root/a", "dev-preview"), iteration: 0, builtOk: false, summary: "boom" }],
			previewNodeIds: [physicalId(idPrefix, "root/a", "dev-preview")],
		});
		expect(state.allPass).toBe(false);
		expect(state.failedFeedback.length).toBeGreaterThan(0);
	});

	test("chunkGateFailures reports the latest failing chunk review", () => {
		const reviewRows = [
			{ nodeId: physicalId(idPrefix, "root", "review-1"), iteration: 0, verdict: "fail", feedback: "no" },
		];
		const failures = chunkGateFailures({ idPrefix, plans, gates, approvalPolicy: undefined, reviewRows });
		expect(failures).toHaveLength(1);
		expect(failures[0].logicalId).toBe("root");
	});

	test("executionComplete gates on leaves, chunk reviews, and derisk budget", () => {
		const execId = physicalId(idPrefix, "root/a", "exec");
		const passLeaf = {
			execRows: [{ nodeId: execId, iteration: 0 }],
			reviewRows: [{ nodeId: physicalId(idPrefix, "root/a", "review-1"), iteration: 0, verdict: "pass" }],
			approvalRows: [{ nodeId: physicalId(idPrefix, "root/a", "approval-1"), approved: true }],
		};
		// A failing chunk review that is NOT addressed and under budget -> incomplete.
		const chunkFail = [{ nodeId: physicalId(idPrefix, "root", "review-1"), iteration: 0, verdict: "fail", feedback: "x" }];
		const base = { idPrefix, plans, gates, approvalPolicy: "policy", ...passLeaf };
		expect(executionComplete({ ...base, reviewRows: [...passLeaf.reviewRows, ...chunkFail] })).toBe(false);
		// Addressed by a replan row -> the failure is terminal -> complete.
		expect(
			executionComplete({
				...base,
				reviewRows: [...passLeaf.reviewRows, ...chunkFail],
				replanRows: [{ trigger: { ref: `${physicalId(idPrefix, "root", "review-1")}#fail-1` } }, { trigger: {} }],
			}),
		).toBe(true);
		// No chunk failures at all -> complete.
		expect(executionComplete(base)).toBe(true);
		// Planning incomplete -> false.
		expect(executionComplete({ ...base, plans: foldPlans([]) })).toBe(false);
	});

	test("synthesizeDelegationEvents emits the full simulated event log", () => {
		const events = synthesizeDelegationEvents({
			planRows,
			probeRows: [{ probeId: "root#r1", parentLogicalId: "root", planImpact: "changes" }],
			replanRows: [
				{ logicalId: "root", reason: "probe changed", decision: "invalidated", trigger: { type: "probe" } },
				{ logicalId: "root", reason: "chunk failed", decision: "reaffirmed", trigger: { type: "review-fail" } },
			],
			execRows: [
				{ logicalId: "root/a" },
				{ logicalId: "root/a" }, // second attempt -> REDELEGATED
			],
			reviewRows: [
				{ logicalId: "root/a", verdict: "fail" },
				{ logicalId: "root/a", verdict: "pass" },
			],
			devPreviewRows: [{ logicalId: "root/a", builtOk: false }],
		});
		const types = new Set(events.map((e) => e.t));
		expect(types.has("RISK_FLAGGED")).toBe(true);
		expect(types.has("PROBE_SPAWNED")).toBe(true);
		expect(types.has("REDELEGATED")).toBe(true);
		expect(types.has("REPLAN_REQUESTED")).toBe(true);
		expect(types.has("NODE_DONE")).toBe(true);
	});

	test("leafComplete builds preview node ids and passes on a built preview", () => {
		const leaf = { logicalId: "root/a", parentId: "root", tier: "opus", kind: "leaf", title: "A", brief: "b" };
		const previewGates = new Map([["root/a", { gates: [{ method: "preview", kind: "ui", brief: "demo" }] }]]);
		const execId = physicalId(idPrefix, "root/a", "exec");
		const previewId = physicalId(idPrefix, "root/a", "dev-preview");
		expect(
			leafComplete({
				idPrefix,
				leaf,
				gates: previewGates,
				approvalPolicy: undefined,
				execRows: [{ nodeId: execId, iteration: 0 }],
				reviewRows: [],
				approvalRows: [],
				devPreviewRows: [{ nodeId: previewId, iteration: 0, builtOk: true }],
			}),
		).toBe(true);
	});

	test("delegatingTierFor resolves node, leaf-parent, and undefined cases", () => {
		const nodes = nodeIndex(plans);
		expect(delegatingTierFor(undefined, nodes)).toBe("fable"); // tierOrder[0]
		expect(delegatingTierFor(nodes.get("root"), nodes)).toBe("fable"); // chunk -> own tier
		expect(delegatingTierFor(nodes.get("root/a"), nodes)).toBe("fable"); // leaf -> parent tier
		const orphanLeaf = { logicalId: "x", parentId: null, tier: "opus", kind: "leaf", title: "x", brief: "b" };
		expect(delegatingTierFor(orphanLeaf, nodes)).toBe("fable"); // leaf, no parent -> tierOrder[0]
	});
});

describe("withCommitRange defensive probe failure", () => {
	test("captureWorkingCopyCommit returns null when the exec probe throws synchronously", async () => {
		// An invalid cwd makes execFile throw synchronously; the run() catch must
		// swallow it and resolve null for both the jj and git probes.
		expect(await captureWorkingCopyCommit(/** @type {any} */ (123))).toBeNull();
	});

	test("withCommitRange leaves a bare (non-generate) value untouched", () => {
		expect(withCommitRange(null)).toBeNull();
		const notAgent = { id: "x" };
		expect(withCommitRange(notAgent)).toBe(notAgent);
	});
});

describe("Saga invalid compensation", () => {
	test("throws when a step's compensation is not a valid element", async () => {
		const renderer = new SmithersRenderer();
		const el = (
			<Saga id="dirty-saga">
				<SagaStep id="step1" compensation={null}>
					<Task id="do-it" output="out">
						{{ ok: true }}
					</Task>
				</SagaStep>
			</Saga>
		);
		await expect(renderer.render(el)).rejects.toThrow(/invalid compensation/);
	});
});

describe("Task allowTools GeminiAgent cloning", () => {
	test("clones a GeminiAgent with the allowlist applied", async () => {
		const renderer = new SmithersRenderer();
		const graph = await renderer.render(
			<Task id="agent" output="out" agent={new GeminiAgent({ model: "gemini-test" })} allowTools={["read_file"]}>
				prompt
			</Task>,
		);
		const taskAgent = graph.tasks[0].agent;
		expect(taskAgent).toBeInstanceOf(GeminiAgent);
		expect(taskAgent.opts.allowedTools).toEqual(["read_file"]);
	});
});
