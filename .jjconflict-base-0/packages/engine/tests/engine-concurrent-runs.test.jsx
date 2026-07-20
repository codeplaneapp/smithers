/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Task, Workflow, runWorkflow } from "smithers-orchestrator";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { createTestSmithers, sleep } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import { Effect } from "effect";
describe("Concurrent runs", () => {
    test("starting a second run does not cancel the first run's in-progress attempt", async () => {
        const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
        let active = 0;
        const slowAgent = {
            id: "slow-agent",
            tools: {},
            generate: async () => {
                active += 1;
                try {
                    await sleep(750);
                    return { output: { value: 1 } };
                }
                finally {
                    active -= 1;
                }
            },
        };
        const workflow = smithers(() => (<Workflow name="concurrent-runs">
        <Task id="slow" output={outputs.outputA} agent={slowAgent}>
          run slow task
        </Task>
      </Workflow>));
        ensureSmithersTables(db);
        const adapter = new SmithersDb(db);
        const firstRunId = "run-a";
        const secondRunId = "run-b";
        const waitForAttemptState = async (runId, expectedState) => {
            let attempts = [];
            for (let i = 0; i < 100; i++) {
                attempts = await adapter.listAttempts(runId, "slow", 0);
                if (attempts.some((attempt) => attempt.state === expectedState))
                    return;
                await sleep(10);
            }
            const states = attempts.map((attempt) => attempt.state).join(", ") || "none";
            throw new Error(`Timed out waiting for ${runId} slow attempt to be ${expectedState}; last states: ${states}`);
        };
        let firstPromise;
        let secondPromise;
        try {
            firstPromise = Effect.runPromise(runWorkflow(workflow, { input: {}, runId: firstRunId }));
            await waitForAttemptState(firstRunId, "in-progress");
            secondPromise = Effect.runPromise(runWorkflow(workflow, { input: {}, runId: secondRunId }));
            await waitForAttemptState(secondRunId, "in-progress");
            const firstAttemptsAfterSecondStart = await adapter.listAttempts(firstRunId, "slow", 0);
            expect(firstAttemptsAfterSecondStart.some((attempt) => attempt.state === "in-progress")).toBe(true);
            const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);
            expect(firstResult.status).toBe("finished");
            expect(secondResult.status).toBe("finished");
            expect(active).toBe(0);
        }
        finally {
            await Promise.allSettled([firstPromise, secondPromise].filter(Boolean));
            cleanup();
        }
    });
});
