import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { enforceDispatchBudget } from "../src/aspects/enforceDispatchBudget.js";

/**
 * @param {Partial<import("../src/aspects/enforceDispatchBudget.js")>} overrides
 */
function makeArgs(overrides = {}) {
	const insertNodeCalls = [];
	const emittedEvents = [];
	const warnings = [];
	const adapter = {
		insertNode: (args) => {
			insertNodeCalls.push(args);
			return Effect.succeed(undefined);
		},
	};
	const eventBus = {
		emitEventWithPersist: (event) => {
			emittedEvents.push(event);
			return Effect.succeed(undefined);
		},
	};
	const logWarning = (message, context, scope) => {
		warnings.push({ message, context, scope });
	};
	const args = {
		desc: {
			nodeId: "t1",
			iteration: 0,
			outputTableName: "t1_out",
			label: null,
			aspects: undefined,
		},
		snapshot: { tokens: 0, elapsedMs: 0 },
		adapter,
		runId: "run-1",
		eventBus,
		budgetSkippedKeys: new Set(),
		stateKey: "t1::0",
		nowMs: () => 12345,
		logWarning,
		...overrides,
	};
	return { args, insertNodeCalls, emittedEvents, warnings };
}

describe("enforceDispatchBudget", () => {
	test("short-circuits to skip when the state key was already recorded as skipped, without touching the adapter or event bus", async () => {
		const { args, insertNodeCalls, emittedEvents } = makeArgs({
			desc: {
				nodeId: "t1",
				iteration: 0,
				outputTableName: "t1_out",
				label: null,
				aspects: { tokenBudget: { max: 1000 } },
			},
			snapshot: { tokens: 0, elapsedMs: 0 },
			budgetSkippedKeys: new Set(["t1::0"]),
		});

		const decision = await enforceDispatchBudget(args);

		expect(decision).toBe("skip");
		expect(insertNodeCalls).toEqual([]);
		expect(emittedEvents).toEqual([]);
	});

	test("returns run when there is no aspects config", async () => {
		const { args } = makeArgs();
		await expect(enforceDispatchBudget(args)).resolves.toBe("run");
	});

	test("returns run when usage is within the configured token budget", async () => {
		const { args } = makeArgs({
			desc: {
				nodeId: "t1",
				iteration: 0,
				outputTableName: "t1_out",
				label: null,
				aspects: { tokenBudget: { max: 100 } },
			},
			snapshot: { tokens: 50, elapsedMs: 0 },
		});
		await expect(enforceDispatchBudget(args)).resolves.toBe("run");
	});

	test("onExceeded: warn — dispatches the task and logs a warning with breach details", async () => {
		const { args, warnings } = makeArgs({
			desc: {
				nodeId: "t1",
				iteration: 2,
				outputTableName: "t1_out",
				label: null,
				aspects: { tokenBudget: { max: 100, onExceeded: "warn" } },
			},
			snapshot: { tokens: 150, elapsedMs: 0 },
		});

		const decision = await enforceDispatchBudget(args);

		expect(decision).toBe("run");
		expect(warnings).toEqual([
			{
				message: "aspect budget exceeded; continuing (onExceeded: warn)",
				context: {
					runId: "run-1",
					nodeId: "t1",
					iteration: 2,
					kind: "tokens",
					limit: 100,
					current: 150,
				},
				scope: "engine:aspects",
			},
		]);
	});

	test("onExceeded: skip-remaining — persists a skipped node, emits NodeSkipped, and records the state key", async () => {
		const { args, insertNodeCalls, emittedEvents, warnings } = makeArgs({
			desc: {
				nodeId: "t2",
				iteration: 1,
				outputTableName: "t2_out",
				label: "Second task",
				aspects: { tokenBudget: { max: 100, onExceeded: "skip-remaining" } },
			},
			snapshot: { tokens: 200, elapsedMs: 0 },
			stateKey: "t2::1",
		});

		const decision = await enforceDispatchBudget(args);

		expect(decision).toBe("skip");
		expect(args.budgetSkippedKeys.has("t2::1")).toBe(true);
		expect(insertNodeCalls).toEqual([
			{
				runId: "run-1",
				nodeId: "t2",
				iteration: 1,
				state: "skipped",
				lastAttempt: null,
				updatedAtMs: 12345,
				outputTable: "t2_out",
				label: "Second task",
			},
		]);
		expect(emittedEvents).toEqual([
			{
				type: "NodeSkipped",
				runId: "run-1",
				nodeId: "t2",
				iteration: 1,
				timestampMs: 12345,
			},
		]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0].message).toBe(
			"aspect budget exceeded; skipping task (onExceeded: skip-remaining)",
		);
	});

	test("onExceeded: fail (default) — throws ASPECT_BUDGET_EXCEEDED without touching the adapter or event bus", async () => {
		const { args, insertNodeCalls, emittedEvents } = makeArgs({
			desc: {
				nodeId: "t3",
				iteration: 0,
				outputTableName: "t3_out",
				label: null,
				aspects: { tokenBudget: { max: 100 } },
			},
			snapshot: { tokens: 100, elapsedMs: 0 },
		});

		let error;
		try {
			await enforceDispatchBudget(args);
		}
		catch (err) {
			error = err;
		}

		expect(error?.code).toBe("ASPECT_BUDGET_EXCEEDED");
		// SmithersError appends the docs-reference suffix to every message.
		expect(error?.message).toStartWith(
			'Aspects tokens budget exceeded for task "t3": 100 >= 100',
		);
		expect(error?.details).toEqual({ kind: "tokens", limit: 100, current: 100 });
		expect(insertNodeCalls).toEqual([]);
		expect(emittedEvents).toEqual([]);
	});

	test("a latency SLO breach flows through with the same onExceeded semantics", async () => {
		const { args, warnings } = makeArgs({
			desc: {
				nodeId: "t4",
				iteration: 0,
				outputTableName: "t4_out",
				label: null,
				aspects: { latencySlo: { maxMs: 1000, onExceeded: "warn" } },
			},
			snapshot: { tokens: 0, elapsedMs: 1500 },
		});

		const decision = await enforceDispatchBudget(args);

		expect(decision).toBe("run");
		expect(warnings[0].context).toEqual({
			runId: "run-1",
			nodeId: "t4",
			iteration: 0,
			kind: "latency",
			limit: 1000,
			current: 1500,
		});
	});
});
