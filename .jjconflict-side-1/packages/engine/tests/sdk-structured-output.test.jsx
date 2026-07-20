/** @jsxImportSource smithers-orchestrator */
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { Task, Workflow, runWorkflow } from "smithers-orchestrator";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";

test("SDK agents with native structured output skip JSON code-fence prompt injection", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers(outputSchemas);
    const prompts = [];
    const agent = {
        id: "fake-sdk-agent",
        hijackEngine: "openai-sdk",
        supportsNativeStructuredOutput: true,
        tools: {},
        /**
         * @param {any} args
         */
        async generate(args) {
            prompts.push(args.prompt);
            return {
                text: "All set.",
                output: { value: 42 },
                response: {
                    messages: [{ role: "assistant", content: "All set." }],
                },
            };
        },
    };
    const workflow = smithers(() => (<Workflow name="sdk-structured-output">
      <Task id="plan" output={outputs.outputA} agent={agent}>
        produce a value
      </Task>
    </Workflow>));
    const result = await Effect.runPromise(runWorkflow(workflow, {
        input: {},
        runId: "sdk-structured-output",
    }));
    expect(result.status).toBe("finished");
    expect(prompts).toEqual(["produce a value"]);
    expect(db.select().from(tables.outputA).all()).toEqual([
        expect.objectContaining({
            nodeId: "plan",
            value: 42,
        }),
    ]);
    cleanup();
});

test("SDK agents with native structured output retry through outputSchema", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers(outputSchemas);
    const calls = [];
    const agent = {
        id: "fake-sdk-agent-retry",
        hijackEngine: "openai-sdk",
        supportsNativeStructuredOutput: true,
        tools: {},
        /**
         * @param {any} args
         */
        async generate(args) {
            calls.push(args);
            if (calls.length === 1) {
                return {
                    text: "All set.",
                    output: { value: "not-a-number" },
                    response: {
                        messages: [{ role: "assistant", content: "All set." }],
                    },
                };
            }
            return {
                text: "",
                output: { value: 42 },
                response: {
                    messages: [{ role: "assistant", content: "" }],
                },
            };
        },
    };
    const workflow = smithers(() => (<Workflow name="sdk-structured-output-retry">
      <Task id="plan" output={outputs.outputA} agent={agent}>
        produce a value
      </Task>
    </Workflow>));
    const result = await Effect.runPromise(runWorkflow(workflow, {
        input: {},
        runId: "sdk-structured-output-retry",
    }));
    expect(result.status).toBe("finished");
    expect(calls).toHaveLength(2);
    expect(calls[0].prompt).toBe("produce a value");
    expect(calls[0].outputSchema).toBeDefined();
    expect(calls[1].outputSchema).toBeDefined();
    const retryPrompt = calls[1].messages.at(-1).content;
    expect(retryPrompt).toContain("structured output");
    expect(retryPrompt).not.toContain("```json");
    expect(db.select().from(tables.outputA).all()).toEqual([
        expect.objectContaining({
            nodeId: "plan",
            value: 42,
        }),
    ]);
    cleanup();
});
