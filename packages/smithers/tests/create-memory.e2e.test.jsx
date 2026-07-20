/** @jsxImportSource smithers-orchestrator */
import { expect, test } from "bun:test";
import { z } from "zod";
import { Effect } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Memory, Task, Workflow, runWorkflow } from "../src/index.js";
import { createSmithers } from "../src/create.js";

test("createSmithers attaches local memory for retain and recall", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "smithers-create-memory-"));
    const dbPath = join(tempDir, "smithers.db");
    const api = createSmithers({ answer: z.object({ value: z.string() }) }, { dbPath });
    const prompts = [];
    const agent = {
        id: "create-memory-test-agent",
        supportsNativeStructuredOutput: true,
        async generate({ prompt }) {
            prompts.push(prompt);
            return {
                output: { value: "durable launch lesson" },
                text: JSON.stringify({ value: "durable launch lesson" }),
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
        const first = await Effect.runPromise(runWorkflow(workflow, {
            input: {},
            rootDir: dirname(dbPath),
            runId: "create-memory-first",
        }));
        expect(first.status).toBe("finished");
        await Bun.sleep(25);

        const facts = await workflow.memoryService.store.listFacts({
            kind: "workflow",
            id: "create-memory-regression",
        });
        expect(facts).toHaveLength(1);
        expect(facts[0].valueJson).toContain("durable launch lesson");

        const second = await Effect.runPromise(runWorkflow(workflow, {
            input: {},
            rootDir: dirname(dbPath),
            runId: "create-memory-second",
        }));
        expect(second.status).toBe("finished");
        expect(prompts[1]).toContain("durable launch lesson");
    } finally {
        api.db.$client?.close?.();
        rmSync(tempDir, { recursive: true, force: true });
    }
});
