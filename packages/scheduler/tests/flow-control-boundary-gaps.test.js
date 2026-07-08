import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { buildPlanTree } from "../src/buildPlanTree.js";
import { buildStateKey } from "../src/buildStateKey.js";
import { makeWorkflowSession } from "../src/makeWorkflowSession.js";
import { scheduleTasks } from "../src/scheduleTasks.js";

function el(tag, props = {}, children = []) {
	return { kind: "element", tag, props, children };
}

function descriptor(nodeId, overrides = {}) {
	return {
		nodeId,
		iteration: 0,
		ordinal: 0,
		outputTable: null,
		outputTableName: "",
		continueOnFail: false,
		retries: 0,
		retryPolicy: undefined,
		...overrides,
	};
}

function graph(tasks, xml) {
	return {
		xml:
			xml ??
			el(
				"smithers:workflow",
				{},
				tasks.map((task) => el("smithers:task", { id: task.nodeId })),
			),
		tasks,
		mountedTaskIds: new Set(tasks.map((task) => `${task.nodeId}::${task.iteration}`)),
	};
}

function run(effect) {
	return Effect.runSync(effect);
}

describe("parallel maxConcurrency=0 boundary", () => {
	test("a zero cap admits no tasks and leaves the group pending", () => {
		// The scheduler treats 0 as "no slots" rather than clamping or
		// rejecting it, so a <Parallel maxConcurrency={0}> group can never
		// make progress — the run parks as pending instead of crashing.
		const plan = {
			kind: "parallel",
			children: [
				{ kind: "task", nodeId: "a" },
				{ kind: "task", nodeId: "b" },
			],
		};
		const descriptors = new Map(
			["a", "b"].map((nodeId) => [
				nodeId,
				descriptor(nodeId, { parallelGroupId: "g", parallelMaxConcurrency: 0 }),
			]),
		);
		const states = new Map([
			[buildStateKey("a", 0), "pending"],
			[buildStateKey("b", 0), "pending"],
		]);
		const result = scheduleTasks(plan, states, descriptors, new Map(), new Map(), 0);
		expect(result.runnable).toEqual([]);
		expect(result.pendingExists).toBe(true);
		expect(result.fatalError).toBeUndefined();
	});
});

describe("ralph maxIterations attribute parsing boundaries", () => {
	test('"0" parses as a real zero cap instead of falling back to the default', () => {
		const { plan } = buildPlanTree(
			el("smithers:ralph", { id: "loop", maxIterations: "0" }, [
				el("smithers:task", { id: "body" }),
			]),
		);
		expect(plan.kind).toBe("ralph");
		expect(plan.maxIterations).toBe(0);
	});

	test("a non-numeric cap falls back to the default of 5", () => {
		const { plan } = buildPlanTree(
			el("smithers:ralph", { id: "loop", maxIterations: "soon" }, [
				el("smithers:task", { id: "body" }),
			]),
		);
		expect(plan.maxIterations).toBe(5);
	});

	test("a negative cap is preserved unclamped", () => {
		// No lower clamp today: a negative cap behaves like maxIterations=1
		// (the first completed iteration trips the max-reached check).
		const { plan } = buildPlanTree(
			el("smithers:ralph", { id: "loop", maxIterations: "-3" }, [
				el("smithers:task", { id: "body" }),
			]),
		);
		expect(plan.maxIterations).toBe(-3);
	});

	test('a fractional cap "2.5" is preserved un-floored, unlike continueAsNewEvery', () => {
		// parseNum(maxIterations) has no Math.floor, while continueAsNewEvery
		// is deliberately floored — pin both halves of that asymmetry.
		const { plan, ralphs } = buildPlanTree(
			el(
				"smithers:ralph",
				{ id: "loop", maxIterations: "2.5", continueAsNewEvery: "2.5" },
				[el("smithers:task", { id: "body" })],
			),
		);
		expect(plan.maxIterations).toBe(2.5);
		expect(ralphs[0].maxIterations).toBe(2.5);
		expect(plan.continueAsNewEvery).toBe(2);
		expect(ralphs[0].continueAsNewEvery).toBe(2);
	});
});

describe("ralph maxIterations=0 session behavior", () => {
	const ralphXml = (attrs) =>
		el("smithers:workflow", {}, [
			el("smithers:ralph", { id: "loop", ...attrs }, [el("smithers:task", { id: "body" })]),
		]);

	test("a zero cap with onMaxReached=fail fails loudly after the first iteration", () => {
		// The body still runs once (iteration 0 renders before the cap is
		// checked), so 0 behaves like 1 — but it must terminate, not loop.
		const session = makeWorkflowSession();
		const first = run(
			session.submitGraph(graph([descriptor("body")], ralphXml({ maxIterations: "0", onMaxReached: "fail" }))),
		);
		expect(first._tag).toBe("Execute");
		const decision = run(session.taskCompleted({ nodeId: "body", iteration: 0, output: 1 }));
		expect(decision._tag).toBe("Failed");
		expect(decision.error.code).toBe("RALPH_MAX_REACHED");
		expect(decision.error.message).toContain("maxIterations 0");
	});

	test("a zero cap with the default return-last marks the loop done after one iteration", () => {
		const session = makeWorkflowSession();
		run(session.submitGraph(graph([descriptor("body")], ralphXml({ maxIterations: "0" }))));
		const decision = run(session.taskCompleted({ nodeId: "body", iteration: 0, output: 1 }));
		expect(decision._tag).toBe("ReRender");
		expect(decision.context.trigger.reason).toBe("loop-advanced");
	});
});

describe("ralph fractional maxIterations session behavior", () => {
	const ralphXml = (attrs) =>
		el("smithers:workflow", {}, [
			el("smithers:ralph", { id: "loop", ...attrs }, [el("smithers:task", { id: "body" })]),
		]);
	const bodyAt = (iteration, attrs) =>
		graph([descriptor("body", { iteration })], ralphXml(attrs));

	test("a cap of 2.5 with onMaxReached=fail runs 3 body iterations before failing", () => {
		// The advancement check is `nextIteration >= maxIterations`, so a
		// fractional cap rounds the effective limit UP (ceil-like): 1 < 2.5
		// and 2 < 2.5 both advance, and only nextIteration=3 trips the max.
		// Iterations 0, 1 and 2 all run — not the 2 a floor would allow.
		const attrs = { maxIterations: "2.5", onMaxReached: "fail" };
		const session = makeWorkflowSession();
		for (const iteration of [0, 1]) {
			const submitted = run(session.submitGraph(bodyAt(iteration, attrs)));
			expect(submitted._tag).toBe("Execute");
			expect(submitted.tasks.map((task) => task.iteration)).toEqual([iteration]);
			const advanced = run(session.taskCompleted({ nodeId: "body", iteration, output: 1 }));
			expect(advanced._tag).toBe("ReRender");
			expect(advanced.context.trigger.reason).toBe("loop-advanced");
		}
		const third = run(session.submitGraph(bodyAt(2, attrs)));
		expect(third._tag).toBe("Execute");
		expect(third.tasks.map((task) => task.iteration)).toEqual([2]);
		const decision = run(session.taskCompleted({ nodeId: "body", iteration: 2, output: 1 }));
		expect(decision._tag).toBe("Failed");
		expect(decision.error.code).toBe("RALPH_MAX_REACHED");
		expect(decision.error.message).toContain("maxIterations 2.5");
	});

	test("a cap of 2.5 with the default return-last finishes after 3 body iterations", () => {
		const attrs = { maxIterations: "2.5" };
		const session = makeWorkflowSession();
		for (const iteration of [0, 1]) {
			run(session.submitGraph(bodyAt(iteration, attrs)));
			const advanced = run(session.taskCompleted({ nodeId: "body", iteration, output: 1 }));
			expect(advanced._tag).toBe("ReRender");
			expect(advanced.context.trigger.reason).toBe("loop-advanced");
		}
		run(session.submitGraph(bodyAt(2, attrs)));
		const capped = run(session.taskCompleted({ nodeId: "body", iteration: 2, output: 1 }));
		expect(capped._tag).toBe("ReRender");
		expect(capped.context.trigger.reason).toBe("loop-advanced");
		// The loop is now done: re-rendering the same graph finishes the run
		// instead of mounting a fourth iteration.
		const finished = run(session.submitGraph(bodyAt(2, attrs)));
		expect(finished._tag).toBe("Finished");
	});
});
