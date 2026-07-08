/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Task, Workflow, runWorkflow } from "smithers-orchestrator";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { z } from "zod";
import { Effect } from "effect";

const TIMEOUT_MS = 30_000;

describe("JSON-repair and schema-retry generate calls carry the same execution context", () => {
    test("the JSON-repair follow-up generate call receives rootDir/maxOutputBytes/taskContext matching the primary call", async () => {
        const { smithers, outputs, cleanup } = createTestSmithers({
            out: z.object({ value: z.number() }),
        });
        const calls = [];
        const agent = {
            id: "forgets-json",
            tools: {},
            generate: async (args) => {
                calls.push(args);
                if (calls.length === 1) {
                    // No extractable JSON in the response: forces the repair turn.
                    return { text: "I finished the work but forgot to emit JSON." };
                }
                // The repair turn's response.
                return { text: '{"value":1}' };
            },
        };
        const workflow = smithers(() => (
            <Workflow name="json-repair-context">
                <Task id="t" output={outputs.out} agent={agent}>
                    do work
                </Task>
            </Workflow>
        ));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        expect(calls.length).toBe(2);
        const [primaryCall, repairCall] = calls;
        expect(primaryCall.rootDir).toBeDefined();
        expect(repairCall.rootDir).toBe(primaryCall.rootDir);
        expect(primaryCall.maxOutputBytes).toBeDefined();
        expect(repairCall.maxOutputBytes).toBe(primaryCall.maxOutputBytes);
        expect(primaryCall.taskContext).toBeDefined();
        expect(repairCall.taskContext).toEqual(primaryCall.taskContext);
        cleanup();
    }, TIMEOUT_MS);

    test("the schema-validation retry generate call receives taskContext matching the primary call", async () => {
        const { smithers, outputs, cleanup } = createTestSmithers({
            out: z.object({ value: z.number() }),
        });
        const calls = [];
        const agent = {
            id: "wrong-schema-then-right",
            tools: {},
            generate: async (args) => {
                calls.push(args);
                if (calls.length === 1) {
                    // Parseable JSON, but it fails the zod schema: forces the
                    // schema-validation retry turn.
                    return {
                        text: '{"value":"not-a-number"}',
                        output: { value: "not-a-number" },
                        response: { messages: [{ role: "assistant", content: '{"value":"not-a-number"}' }] },
                    };
                }
                return {
                    text: '{"value":1}',
                    output: { value: 1 },
                    response: { messages: [{ role: "assistant", content: '{"value":1}' }] },
                };
            },
        };
        const workflow = smithers(() => (
            <Workflow name="schema-retry-context">
                <Task id="t" output={outputs.out} agent={agent}>
                    do work
                </Task>
            </Workflow>
        ));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        expect(calls.length).toBe(2);
        const [primaryCall, retryCall] = calls;
        expect(primaryCall.taskContext).toBeDefined();
        expect(retryCall.taskContext).toEqual(primaryCall.taskContext);
        cleanup();
    }, TIMEOUT_MS);
});
