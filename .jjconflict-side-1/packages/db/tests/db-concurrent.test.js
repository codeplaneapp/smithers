// Cross-adapter concurrency tests for SmithersDb.
//
// We share a single `bun:sqlite` Database between two SmithersDb instances
// to mimic two writers from different code paths racing on the same
// underlying file. In-memory sqlite is sufficient because all races resolve
// inside the bun:sqlite mutex; what we care about here is the adapter
// semantics on top: INSERT OR IGNORE upserts, transaction rollback isolation,
// and read-while-write fairness.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect } from "effect";
import { SmithersDb } from "../src/adapter.js";
import { ensureSmithersTables } from "../src/ensure.js";
import { toSmithersError } from "@smithers-orchestrator/errors/toSmithersError";

function createSharedDb() {
	const sqlite = new Database(":memory:");
	const db = drizzle(sqlite);
	ensureSmithersTables(db);
	return { sqlite, db };
}

/**
 * @param {string} runId
 * @param {Partial<Record<string, unknown>>} [extra]
 */
function runRow(runId, extra = {}) {
	return {
		runId,
		workflowName: "concurrent-test",
		workflowHash: "hash",
		status: "running",
		createdAtMs: Date.now(),
		...extra,
	};
}

describe("SmithersDb cross-adapter concurrency", () => {
	test("two adapters inserting same run_id concurrently — PRIMARY KEY upheld, one row, both calls succeed", async () => {
		const { sqlite, db } = createSharedDb();
		try {
			const a = new SmithersDb(db);
			const b = new SmithersDb(db);
			const runId = "race-pk";
			const rowA = runRow(runId, { workflowName: "wf-a" });
			const rowB = runRow(runId, { workflowName: "wf-b" });

			// insertRun uses INSERT OR IGNORE — so both promises must resolve
			// without throwing, but only the first row survives.
			const results = await Promise.allSettled([
				a.insertRun(rowA),
				b.insertRun(rowB),
			]);
			expect(results.every((r) => r.status === "fulfilled")).toBe(true);

			const stored = await a.getRun(runId);
			expect(stored).toBeDefined();
			expect(stored?.runId).toBe(runId);
			// First-writer-wins: workflowName is whichever insert hit the engine
			// first. We only assert it's one of the two — the OS scheduler picks.
			expect(["wf-a", "wf-b"]).toContain(stored?.workflowName);

			// Verify only one row exists.
			const allRuns = sqlite
				.query("SELECT COUNT(*) AS c FROM _smithers_runs WHERE run_id = ?")
				.get(runId);
			expect(allRuns?.c).toBe(1);
		} finally {
			sqlite.close();
		}
	});

	test("repeated parallel insertRun under N iterations preserves single-row invariant", async () => {
		const { sqlite, db } = createSharedDb();
		try {
			const adapters = Array.from({ length: 6 }, () => new SmithersDb(db));
			const ITERS = 25;
			for (let i = 0; i < ITERS; i += 1) {
				const runId = `race-iter-${i}`;
				await Promise.all(
					adapters.map((adapter) =>
						adapter.insertRun(runRow(runId, { workflowName: `wf-${i}` })),
					),
				);
				const count = sqlite
					.query("SELECT COUNT(*) AS c FROM _smithers_runs WHERE run_id = ?")
					.get(runId);
				expect(count?.c).toBe(1);
			}
		} finally {
			sqlite.close();
		}
	});

	test("transaction rollback in adapter A leaves adapter B's writes intact", async () => {
		const { sqlite, db } = createSharedDb();
		try {
			const a = new SmithersDb(db);
			const b = new SmithersDb(db);
			await a.insertRun(runRow("tx-rollback-a"));
			await b.insertRun(runRow("tx-rollback-b"));

			const failingTx = a
				.withTransaction(
					"failing-A",
					Effect.gen(function* () {
						yield* a.insertNodeEffect({
							runId: "tx-rollback-a",
							nodeId: "node-A",
							iteration: 0,
							state: "in-progress",
							lastAttempt: 1,
							updatedAtMs: Date.now(),
							outputTable: "output_a",
							label: "should-rollback",
						});
						// Wait so adapter B's parallel writes are clearly interleaved.
						yield* Effect.tryPromise({
							try: () => new Promise((r) => setTimeout(r, 25)),
							catch: (cause) =>
								toSmithersError(cause, "test sleep", {
									code: "DB_WRITE_FAILED",
								}),
						});
						yield* Effect.fail(
							toSmithersError(new Error("explode"), "explode", {
								code: "DB_WRITE_FAILED",
							}),
						);
					}),
				)
				.catch((err) => err);

			// While A is in-flight (and will rollback), do an independent
			// write through B. The transaction queue is global per-process,
			// so B will execute either before or after A's tx, but never
			// inside it.
			await new Promise((r) => setTimeout(r, 5));
			const bWrite = b.insertNode({
				runId: "tx-rollback-b",
				nodeId: "node-B",
				iteration: 0,
				state: "pending",
				lastAttempt: null,
				updatedAtMs: Date.now(),
				outputTable: "output_b",
				label: "should-survive",
			});

			const txErr = await failingTx;
			await bWrite;

			expect(String(txErr)).toContain("explode");
			// A's node was rolled back.
			const nodeA = await a.getNode("tx-rollback-a", "node-A", 0);
			expect(nodeA).toBeUndefined();
			// B's node persisted.
			const nodeB = await a.getNode("tx-rollback-b", "node-B", 0);
			expect(nodeB?.state).toBe("pending");
			expect(nodeB?.label).toBe("should-survive");
		} finally {
			sqlite.close();
		}
	});

	test("concurrent reads + writes on same row: writer wins, readers see consistent before/after states", async () => {
		const { sqlite, db } = createSharedDb();
		try {
			const writer = new SmithersDb(db);
			const reader = new SmithersDb(db);
			const runId = "concurrent-rw";
			await writer.insertRun(runRow(runId, { status: "running" }));

			// Fire many reads in parallel with a status update; every read
			// must observe a valid status (not corrupted, not undefined).
			const updates = (async () => {
				await writer.updateRun(runId, { status: "finished" });
			})();
			const reads = await Promise.all(
				Array.from({ length: 30 }, () => reader.getRun(runId)),
			);
			await updates;

			for (const row of reads) {
				expect(row).toBeDefined();
				expect(["running", "finished"]).toContain(row?.status);
			}
			const finalRow = await reader.getRun(runId);
			expect(finalRow?.status).toBe("finished");
		} finally {
			sqlite.close();
		}
	});

	test("transactions from two adapters serialise (no interleaving inside BEGIN..COMMIT)", async () => {
		const { sqlite, db } = createSharedDb();
		try {
			const a = new SmithersDb(db);
			const b = new SmithersDb(db);
			await a.insertRun(runRow("serial-run"));

			const order = [];
			const txA = a.withTransaction(
				"serial-A",
				Effect.gen(function* () {
					order.push("A:start");
					yield* a.insertNodeEffect({
						runId: "serial-run",
						nodeId: "n-A",
						iteration: 0,
						state: "in-progress",
						lastAttempt: 1,
						updatedAtMs: Date.now(),
						outputTable: "output",
						label: null,
					});
					yield* Effect.tryPromise({
						try: () => new Promise((r) => setTimeout(r, 30)),
						catch: (cause) =>
							toSmithersError(cause, "delay", { code: "DB_WRITE_FAILED" }),
					});
					order.push("A:end");
				}),
			);
			// Start a transaction on a *different* adapter shortly after.
			await new Promise((r) => setTimeout(r, 5));
			const txB = b.withTransaction(
				"serial-B",
				Effect.gen(function* () {
					order.push("B:start");
					yield* b.insertNodeEffect({
						runId: "serial-run",
						nodeId: "n-B",
						iteration: 0,
						state: "in-progress",
						lastAttempt: 1,
						updatedAtMs: Date.now(),
						outputTable: "output",
						label: null,
					});
					order.push("B:end");
				}),
			);

			await Promise.all([txA, txB]);

			// The invariant is: B never starts before A ends. (Or vice versa
			// if scheduling reversed them — but we forced A to begin first
			// with the sleep.)
			const aStart = order.indexOf("A:start");
			const aEnd = order.indexOf("A:end");
			const bStart = order.indexOf("B:start");
			const bEnd = order.indexOf("B:end");
			const aFinishedBeforeBStarted = aEnd < bStart;
			const bFinishedBeforeAStarted = bEnd < aStart;
			expect(aFinishedBeforeBStarted || bFinishedBeforeAStarted).toBe(true);
		} finally {
			sqlite.close();
		}
	});
});
