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
    const sentinel = "create-smithers-only-memory-sentinel-7f2d";
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
        const first = await Effect.runPromise(runWorkflow(workflow, {
            input: {},
            rootDir: dirname(dbPath),
            runId: "create-memory-first",
        }));
        expect(first.status).toBe("finished");
        expect(prompts[0]).not.toContain(sentinel);
        const deadline = Date.now() + 2_000;
        let facts = [];
        while (Date.now() < deadline) {
            facts = await workflow.memoryService.store.listFacts({
                kind: "workflow",
                id: "create-memory-regression",
            });
            if (facts.length > 0)
                break;
            await Bun.sleep(25);
        }
        expect(facts).toHaveLength(1);
        expect(facts[0].valueJson).toContain(sentinel);

        const second = await Effect.runPromise(runWorkflow(workflow, {
            input: {},
            rootDir: dirname(dbPath),
            runId: "create-memory-second",
        }));
        expect(second.status).toBe("finished");
        expect(prompts[1]).toContain(sentinel);
    } finally {
        api.db.$client?.close?.();
        rmSync(tempDir, { recursive: true, force: true });
    }
});

test("createSmithers selects Hindsight when configured", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "smithers-create-hindsight-"));
    const dbPath = join(tempDir, "smithers.db");
    const previous = {
        url: process.env.HINDSIGHT_URL,
        apiKey: process.env.HINDSIGHT_API_KEY,
        bankPrefix: process.env.HINDSIGHT_BANK_PREFIX,
    };
    process.env.HINDSIGHT_URL = "http://127.0.0.1:18888/";
    process.env.HINDSIGHT_API_KEY = "create-memory-test-key";
    process.env.HINDSIGHT_BANK_PREFIX = "create-test-";
    try {
        const api = createSmithers({}, { dbPath });
        const workflow = api.smithers(() => null);
        expect(workflow.memoryService.constructor.name).toBe("HindsightMemoryStore");
        expect(workflow.memoryService.baseUrl).toBe("http://127.0.0.1:18888");
        expect(workflow.memoryService.apiKey).toBe("create-memory-test-key");
        expect(workflow.memoryService.bankPrefix).toBe("create-test-");
        api.db.$client?.close?.();
    }
    finally {
        if (previous.url === undefined)
            delete process.env.HINDSIGHT_URL;
        else
            process.env.HINDSIGHT_URL = previous.url;
        if (previous.apiKey === undefined)
            delete process.env.HINDSIGHT_API_KEY;
        else
            process.env.HINDSIGHT_API_KEY = previous.apiKey;
        if (previous.bankPrefix === undefined)
            delete process.env.HINDSIGHT_BANK_PREFIX;
        else
            process.env.HINDSIGHT_BANK_PREFIX = previous.bankPrefix;
        rmSync(tempDir, { recursive: true, force: true });
    }
});
