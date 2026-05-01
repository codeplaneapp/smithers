/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Task, Workflow, runWorkflow } from "smithers-orchestrator";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { z } from "zod";
import { Effect } from "effect";

// MAX_SCHEMA_RETRIES is hard-coded to 3 in engine.js. The retry mechanism
// re-invokes the SAME agent with a corrective prompt up to 3 times before
// giving up. These attempts are NOT counted as task retries.
const MAX_SCHEMA_RETRIES = 3;
const TIMEOUT_MS = 30_000;

/**
 * Build an agent that returns invalid JSON (fails the zod schema) `failures`
 * times, then valid output. Counts the total number of generate() calls.
 * @param {number} failures
 */
function makeFlakyAgent(failures) {
    const counter = { calls: 0 };
    const agent = {
        id: "flaky",
        tools: {},
        generate: async (_args) => {
            counter.calls += 1;
            if (counter.calls <= failures) {
                // Returns parseable JSON but it doesn't match the zod schema
                // (schema expects { value: number }; we return { wrong: "x" }).
                return {
                    text: '{"wrong":"x"}',
                    output: { wrong: "x" },
                    response: { messages: [{ role: "assistant", content: '{"wrong":"x"}' }] },
                };
            }
            return {
                text: '{"value":42}',
                output: { value: 42 },
                response: { messages: [{ role: "assistant", content: '{"value":42}' }] },
            };
        },
    };
    return { agent, counter };
}

describe("MAX_SCHEMA_RETRIES (3) - schema-retry mechanism", () => {
    test("agent recovers within retry budget (failures=2 < MAX) succeeds", async () => {
        const { smithers, outputs, cleanup } = createTestSmithers({
            out: z.object({ value: z.number() }),
        });
        const { agent, counter } = makeFlakyAgent(MAX_SCHEMA_RETRIES - 1);
        const workflow = smithers(() => (
            <Workflow name="schema-retry-recovers">
                <Task id="t" output={outputs.out} agent={agent}>
                    do work
                </Task>
            </Workflow>
        ));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        // Initial call + (MAX-1) retries = MAX calls.
        expect(counter.calls).toBe(MAX_SCHEMA_RETRIES);
        cleanup();
    }, TIMEOUT_MS);

    test("agent recovers exactly at the boundary (failures=MAX) succeeds", async () => {
        const { smithers, outputs, cleanup } = createTestSmithers({
            out: z.object({ value: z.number() }),
        });
        const { agent, counter } = makeFlakyAgent(MAX_SCHEMA_RETRIES);
        const workflow = smithers(() => (
            <Workflow name="schema-retry-boundary">
                <Task id="t" output={outputs.out} agent={agent}>
                    do work
                </Task>
            </Workflow>
        ));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        // Initial call + MAX retries = MAX+1 calls.
        expect(counter.calls).toBe(MAX_SCHEMA_RETRIES + 1);
        cleanup();
    }, TIMEOUT_MS);

    test("agent never recovers (failures=MAX+1) exhausts retries and the task fails INVALID_OUTPUT", async () => {
        const { smithers, outputs, db, cleanup } = createTestSmithers({
            out: z.object({ value: z.number() }),
        });
        // Always-bad agent: returns invalid output on every call.
        const calls = { count: 0 };
        const badAgent = {
            id: "always-bad",
            tools: {},
            generate: async () => {
                calls.count += 1;
                return {
                    text: '{"wrong":"x"}',
                    output: { wrong: "x" },
                    response: { messages: [{ role: "assistant", content: '{"wrong":"x"}' }] },
                };
            },
        };
        const workflow = smithers(() => (
            <Workflow name="schema-retry-exhausts">
                <Task id="t" output={outputs.out} agent={badAgent} noRetry>
                    do work
                </Task>
            </Workflow>
        ));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("failed");
        // Initial call + MAX retries = MAX+1 calls.
        expect(calls.count).toBe(MAX_SCHEMA_RETRIES + 1);
        const adapter = new SmithersDb(db);
        const attempts = await adapter.listAttempts(result.runId, "t", 0);
        const errorJson = JSON.parse(attempts[attempts.length - 1]?.errorJson ?? "{}");
        expect(errorJson.code).toBe("INVALID_OUTPUT");
        cleanup();
    }, TIMEOUT_MS);

    test("schema retries renew per task attempt", async () => {
        const { smithers, outputs, cleanup } = createTestSmithers({
            out: z.object({ value: z.number() }),
        });
        // Track each generate() call. A schema-retry call passes `messages`;
        // a fresh task attempt passes `prompt` (and no `messages` from the
        // engine's inner conversation). Use that to distinguish.
        let taskAttempts = 0;
        let schemaRetriesThisAttempt = 0;
        const totalCalls = { value: 0 };
        const agent = {
            id: "exhaust-then-recover",
            tools: {},
            generate: async (args) => {
                totalCalls.value += 1;
                // The engine's main generate() call passes outputSchema/onStepFinish/
                // onEvent. The schema-retry generate() omits all of those.
                const isFreshAttempt =
                    "outputSchema" in (args ?? {}) ||
                    "onStepFinish" in (args ?? {}) ||
                    "onEvent" in (args ?? {});
                if (isFreshAttempt) {
                    taskAttempts += 1;
                    schemaRetriesThisAttempt = 0;
                } else {
                    schemaRetriesThisAttempt += 1;
                }
                // First task attempt: always invalid (exhaust schema retries).
                if (taskAttempts === 1) {
                    return {
                        text: '{"wrong":"x"}',
                        output: { wrong: "x" },
                        response: { messages: [{ role: "assistant", content: '{"wrong":"x"}' }] },
                    };
                }
                // Second task attempt: valid on first try.
                return {
                    text: '{"value":7}',
                    output: { value: 7 },
                    response: { messages: [{ role: "assistant", content: '{"value":7}' }] },
                };
            },
        };
        const workflow = smithers(() => (
            <Workflow name="schema-retry-vs-task-retry">
                <Task id="t" output={outputs.out} agent={agent} retries={1}>
                    do work
                </Task>
            </Workflow>
        ));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        // Attempt 1: 1 initial + MAX_SCHEMA_RETRIES retries = 4 calls (all bad).
        // Attempt 2: 1 initial (valid) = 1 call. Total = 5.
        expect(totalCalls.value).toBe(MAX_SCHEMA_RETRIES + 1 + 1);
        expect(taskAttempts).toBe(2);
        cleanup();
    }, TIMEOUT_MS);
});
