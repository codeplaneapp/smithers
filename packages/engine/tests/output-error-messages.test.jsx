/** @jsxImportSource smithers-orchestrator */
import { expect, test } from "bun:test";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { Effect } from "effect";
import { Task, Workflow, runWorkflow } from "smithers-orchestrator";
import { z } from "zod";
import { createTestSmithers } from "../../smithers/tests/helpers.js";

async function readAttemptError(db, runId, nodeId) {
    const adapter = new SmithersDb(db);
    const attempts = await adapter.listAttempts(runId, nodeId, 0);
    const raw = attempts.at(-1)?.errorJson;
    expect(raw).toBeTruthy();
    return JSON.parse(raw);
}

test("native structured output parse failures explain OpenAI-compatible local model guidance", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers({
        out: z.object({ value: z.number() }),
    });
    const agent = {
        id: "openai-like-local-model",
        hijackEngine: "openai-sdk",
        supportsNativeStructuredOutput: true,
        tools: {},
        async generate() {
            return {
                text: "[]",
                get output() {
                    throw new Error("SDK structured output parse failure");
                },
                response: {
                    messages: [
                        {
                            role: "assistant",
                            content: "[]",
                        },
                    ],
                },
            };
        },
    };

    try {
        const workflow = smithers(() => (
            <Workflow name="native-structured-output-parse-error">
                {/* noRetry keeps this focused on formatting guidance, not task retry timing. */}
                <Task id="t" output={outputs.out} agent={agent} noRetry>
                    produce a value
                </Task>
            </Workflow>
        ));
        const result = await Effect.runPromise(
            runWorkflow(workflow, {
                input: {},
                runId: "native-structured-output-parse-error",
            }),
        );

        expect(result.status).toBe("failed");
        const errorJson = await readAttemptError(db, result.runId, "t");
        expect(errorJson.code).toBe("INVALID_OUTPUT");
        expect(errorJson.message).toContain("structured JSON");
        expect(errorJson.message).toContain("OpenAI-compatible");
        expect(errorJson.message).toContain("local model");
        expect(errorJson.message).toContain("opt out");
        expect(errorJson.details).toMatchObject({
            attempt: 1,
            iteration: 0,
            nodeId: "t",
            outputTable: "out",
        });
    } finally {
        cleanup();
    }
});

test("native structured output getter failures explain local model guidance for plain text", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers({
        out: z.object({ value: z.number() }),
    });
    const agent = {
        id: "openai-like-plain-text-local-model",
        supportsNativeStructuredOutput: true,
        tools: {},
        async generate() {
            return {
                text: "done",
                get output() {
                    throw new Error("SDK structured output parse failure");
                },
                response: {
                    messages: [{ role: "assistant", content: "done" }],
                },
            };
        },
    };

    try {
        const workflow = smithers(() => (
            <Workflow name="native-structured-output-plain-text-error">
                {/* noRetry keeps this focused on formatting guidance, not task retry timing. */}
                <Task id="t" output={outputs.out} agent={agent} noRetry>
                    produce a value
                </Task>
            </Workflow>
        ));
        const result = await Effect.runPromise(
            runWorkflow(workflow, {
                input: {},
                runId: "native-structured-output-plain-text-error",
            }),
        );

        expect(result.status).toBe("failed");
        const errorJson = await readAttemptError(db, result.runId, "t");
        expect(errorJson.code).toBe("INVALID_OUTPUT");
        expect(errorJson.message).toContain("structured JSON");
        expect(errorJson.message).toContain("OpenAI-compatible");
        expect(errorJson.message).not.toContain("Plain text cannot be passed through deps directly");
    } finally {
        cleanup();
    }
});

test("schema retries clear stale structured output getter failures", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers({
        out: z.object({ value: z.number() }),
    });
    let calls = 0;
    const agent = {
        id: "schema-retry-stale-structured-error",
        supportsNativeStructuredOutput: true,
        tools: {},
        async generate() {
            calls++;
            if (calls === 1) {
                return {
                    text: JSON.stringify({ value: "wrong" }),
                    get output() {
                        throw new Error("SDK structured output parse failure");
                    },
                    response: {
                        messages: [{ role: "assistant", content: JSON.stringify({ value: "wrong" }) }],
                    },
                };
            }
            return {
                text: JSON.stringify({ value: "still wrong" }),
                response: {
                    messages: [{ role: "assistant", content: JSON.stringify({ value: "still wrong" }) }],
                },
            };
        },
    };

    try {
        const workflow = smithers(() => (
            <Workflow name="schema-retry-clears-structured-output-error">
                {/* noRetry keeps this focused on schema-retry attribution, not task retry timing. */}
                <Task id="t" output={outputs.out} agent={agent} noRetry>
                    produce a value
                </Task>
            </Workflow>
        ));
        const result = await Effect.runPromise(
            runWorkflow(workflow, {
                input: {},
                runId: "schema-retry-clears-structured-output-error",
            }),
        );

        expect(result.status).toBe("failed");
        const errorJson = await readAttemptError(db, result.runId, "t");
        expect(errorJson.message).toContain("Task output failed validation");
        expect(errorJson.message).not.toContain("structured JSON");
        expect(errorJson.details).toMatchObject({
            schemaRetryAttempts: 3,
            nodeId: "t",
            outputTable: "out",
        });
    } finally {
        cleanup();
    }
});

test("plain text object outputs explain JSON object shape and dependency access", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers({
        out: z.object({ value: z.number() }),
    });
    const agent = {
        id: "plain-text-agent",
        tools: {},
        async generate() {
            return {
                text: "done",
                output: "done",
                response: {
                    messages: [{ role: "assistant", content: "done" }],
                },
            };
        },
    };

    try {
        const workflow = smithers(() => (
            <Workflow name="plain-text-object-output">
                {/* noRetry keeps this focused on formatting guidance, not task retry timing. */}
                <Task id="summarize" output={outputs.out} agent={agent} noRetry>
                    summarize this
                </Task>
            </Workflow>
        ));
        const result = await Effect.runPromise(
            runWorkflow(workflow, {
                input: {},
                runId: "plain-text-object-output",
            }),
        );

        expect(result.status).toBe("failed");
        const errorJson = await readAttemptError(db, result.runId, "summarize");
        expect(errorJson.code).toBe("INVALID_OUTPUT");
        expect(errorJson.message).toContain("Smithers task outputs must be JSON objects");
        expect(errorJson.message).toContain("z.object({ text: z.string() })");
        expect(errorJson.message).toContain("deps.summarize.text");
        expect(errorJson.details).toMatchObject({
            attempt: 1,
            iteration: 0,
            nodeId: "summarize",
            outputTable: "out",
        });
    } finally {
        cleanup();
    }
});
