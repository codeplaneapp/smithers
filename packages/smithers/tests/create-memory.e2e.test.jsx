/** @jsxImportSource smithers-orchestrator */
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { Memory, Task, Workflow, runWorkflow } from "../src/index.js";
import { createSmithers } from "../src/create.js";

test("createSmithers persists and recalls local memory", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "smithers-create-memory-"));
	const dbPath = join(tempDir, "smithers.db");
	const previousHindsightUrl = process.env.HINDSIGHT_URL;
	delete process.env.HINDSIGHT_URL;
	const prompts = [];
	const sentinel = "create-smithers-memory-regression-sentinel";
	const api = createSmithers({ answer: z.object({ value: z.string() }) }, { dbPath });
	const agent = {
		id: "create-memory-test-agent",
		supportsNativeStructuredOutput: true,
		async generate({ prompt }) {
			prompts.push(prompt);
			return {
				output: { value: sentinel },
				text: JSON.stringify({ value: sentinel }),
				response: { messages: [] },
			};
		},
	};
	const workflow = api.smithers(() => (
		<Workflow name="create-memory-regression">
			<Memory bank="create-memory-regression" recall="auto" retain="on-complete">
				<Task id="answer" output={api.outputs.answer} agent={agent}>
					Find the durable launch lesson.
				</Task>
			</Memory>
		</Workflow>
	));

	try {
		expect(workflow.memoryService).toBeDefined();
		expect(workflow.memoryService.constructor.name).toBe("LocalMemoryRuntime");
		const first = await Effect.runPromise(runWorkflow(workflow, {
			input: {},
			rootDir: dirname(dbPath),
			runId: "create-memory-first",
		}));
		expect(first.status).toBe("finished");
		expect(prompts[0]).not.toContain(sentinel);

		const facts = await workflow.memoryService.store.listFacts({
			kind: "workflow",
			id: "create-memory-regression",
		});
		expect(facts.some((fact) => fact.valueJson.includes(sentinel))).toBe(true);

		const second = await Effect.runPromise(runWorkflow(workflow, {
			input: {},
			rootDir: dirname(dbPath),
			runId: "create-memory-second",
		}));
		expect(second.status).toBe("finished");
		expect(prompts[1]).toContain(sentinel);
	}
	finally {
		if (previousHindsightUrl === undefined)
			delete process.env.HINDSIGHT_URL;
		else
			process.env.HINDSIGHT_URL = previousHindsightUrl;
		api.db.$client?.close?.();
		rmSync(tempDir, { recursive: true, force: true });
	}
});
