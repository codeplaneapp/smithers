/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { z } from "zod";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { Sidecar, Task, Workflow, computeSidecarDelta, runWorkflow } from "smithers-orchestrator";
import { createTestSmithers, sleep } from "./helpers.js";

async function waitForScores(adapter, runId, count) {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const rows = await adapter.listScorerResults(runId);
		if (rows.length >= count) return rows;
		await sleep(25);
	}
	return adapter.listScorerResults(runId);
}

describe("Sidecar e2e", () => {
	test("records scorer rows for primary and sidecar while downstream consumes primary output", async () => {
		const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
			answer: z.object({ text: z.string() }),
			summary: z.object({ text: z.string() }),
		});
		const primary = { id: "primary", generate: async () => ({ output: { text: "primary answer" } }) };
		const cheap = { id: "cheap", generate: async () => ({ output: { text: "cheap answer" } }) };
		const scorers = {
			quality: {
				scorer: {
					id: "quality",
					name: "Quality",
					description: "Scores answer text",
					score: async ({ output }) => ({
						score: output?.text === "primary answer" ? 0.9 : 0.7,
					}),
				},
				sampling: { type: "all" },
			},
		};
		const workflow = smithers((ctx) => {
			const primaryOutput = ctx.outputMaybe("answer", { nodeId: "answer" });
			return (
				<Workflow name="sidecar-e2e">
					<Sidecar id="answer" agent={primary} sidecar={cheap} output={outputs.answer} scorers={scorers}>
						Answer with the best response.
					</Sidecar>
					{primaryOutput ? (
						<Task id="summary" output={outputs.summary}>
							{{ text: primaryOutput.text }}
						</Task>
					) : null}
				</Workflow>
			);
		});
		const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "sidecar-e2e" }));
		expect(result.status).toBe("finished");
		const answerRows = db.select().from(tables.answer).all();
		const summaryRows = db.select().from(tables.summary).all();
		expect(summaryRows).toHaveLength(1);
		expect(summaryRows[0].text).toBe("primary answer");
		expect(answerRows.map((row) => row.text).sort()).toEqual(["cheap answer", "primary answer"]);
		const adapter = new SmithersDb(db);
		const rows = await waitForScores(adapter, "sidecar-e2e", 2);
		expect(rows).toHaveLength(2);
		expect(new Set(rows.map((row) => row.nodeId))).toEqual(new Set(["answer", "answer-sidecar"]));
		expect(computeSidecarDelta(rows, { primaryNodeId: "answer", sidecarNodeId: "answer-sidecar", scorerId: "quality" })).toEqual({
			primaryScore: 0.9,
			sidecarScore: 0.7,
			delta: 0.2,
			cheaperWins: false,
		});
		cleanup();
	});

	test("sidecar failure does not fail the run", async () => {
		const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
			answer: z.object({ text: z.string() }),
			summary: z.object({ text: z.string() }),
		});
		const primary = { id: "primary", generate: async () => ({ output: { text: "primary answer" } }) };
		const failingCheap = {
			id: "cheap-fails",
			generate: async () => {
				throw new Error("cheap model unavailable");
			},
		};
		const workflow = smithers((ctx) => {
			const primaryOutput = ctx.outputMaybe("answer", { nodeId: "answer" });
			return (
				<Workflow name="sidecar-failure">
					<Sidecar id="answer" agent={primary} sidecar={failingCheap} output={outputs.answer}>
						Answer with the best response.
					</Sidecar>
					{primaryOutput ? (
						<Task id="summary" output={outputs.summary}>
							{{ text: primaryOutput.text }}
						</Task>
					) : null}
				</Workflow>
			);
		});
		const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "sidecar-failure" }));
		expect(result.status).toBe("finished");
		expect(db.select().from(tables.summary).all()[0].text).toBe("primary answer");
		cleanup();
	});
});
