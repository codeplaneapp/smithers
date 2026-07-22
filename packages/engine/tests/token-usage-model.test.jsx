/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Workflow, Task, runWorkflow } from "smithers-orchestrator";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { z } from "zod";
import { Effect } from "effect";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";

const schemas = { a: z.object({ v: z.number() }) };

/**
 * Fake agent that reports token usage and a resolved response.modelId, the
 * authoritative id the engine should attribute the usage to.
 *
 * @param {string} id
 * @param {string | undefined} model
 * @param {string} responseModelId
 */
function usageAgent(id, model, responseModelId) {
    return {
        id,
        ...(model !== undefined ? { model } : {}),
        tools: {},
        generate: async () => ({
            output: { v: 1 },
            usage: { inputTokens: 10, outputTokens: 5 },
            response: { modelId: responseModelId },
        }),
    };
}

/**
 * @param {string} dbPath
 * @returns {Array<Record<string, unknown>>}
 */
function readTokenUsageEvents(dbPath) {
    const db = new Database(dbPath, { readonly: true });
    try {
        const rows = db.query("SELECT payload_json FROM _smithers_events WHERE type = 'TokenUsageReported'").all();
        return rows.map((r) => JSON.parse(r.payload_json));
    } finally {
        db.close();
    }
}

describe("TokenUsageReported model attribution", () => {
    test("attributes usage to the resolved response.modelId", async () => {
        const { smithers, outputs, dbPath, cleanup } = createTestSmithers(schemas);
        try {
            const workflow = smithers(() => (<Workflow name="token-usage-model">
        <Task id="t" output={outputs.a} agent={usageAgent("agent-1", undefined, "claude-opus-test")}>
          compute
        </Task>
      </Workflow>));
            const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
            expect(result.status).toBe("finished");
            const events = readTokenUsageEvents(dbPath);
            expect(events.length).toBeGreaterThan(0);
            expect(events.every((e) => e.model === "claude-opus-test")).toBe(true);
        }
        finally {
            cleanup();
        }
    });

    test("does not attribute usage to a CLI agent's random-UUID id", async () => {
        const { smithers, outputs, dbPath, cleanup } = createTestSmithers(schemas);
        const uuidId = "5f65b75c-e0c0-4780-d037-080678a6d78f";
        try {
            const workflow = smithers(() => (<Workflow name="token-usage-uuid">
        <Task id="t" output={outputs.a} agent={usageAgent(uuidId, undefined, "gpt-5.4-codex")}>
          compute
        </Task>
      </Workflow>));
            const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
            expect(result.status).toBe("finished");
            const events = readTokenUsageEvents(dbPath);
            expect(events.length).toBeGreaterThan(0);
            for (const e of events) {
                expect(e.model).toBe("gpt-5.4-codex");
                expect(e.model).not.toBe(uuidId);
            }
        }
        finally {
            cleanup();
        }
    });

    test("emits usage carried by a failed attempt's partial result", async () => {
        const { smithers, outputs, dbPath, cleanup } = createTestSmithers(schemas);
        try {
            const agent = {
                id: "failed-agent",
                model: "fallback-model",
                tools: {},
                async generate() {
                    const error = /** @type {any} */ (new SmithersError("AGENT_CONFIG_INVALID", "provider failed after reporting usage", {
                        failureRetryable: false,
                    }));
                    error.result = {
                        usage: {
                            promptTokens: 17,
                            completionTokens: 4,
                            inputTokenDetails: { cacheReadTokens: 8, cacheWriteTokens: 2 },
                            outputTokenDetails: { reasoningTokens: 3 },
                        },
                        response: { modelId: "failed-response-model" },
                    };
                    throw error;
                },
            };
            const workflow = smithers(() => (<Workflow name="token-usage-failed-attempt">
        <Task id="t" output={outputs.a} agent={agent} retries={3}>
          fail after provider usage
        </Task>
      </Workflow>));
            const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
            expect(result.status).toBe("failed");
            const events = readTokenUsageEvents(dbPath);
            expect(events).toHaveLength(1);
            expect(events[0]).toMatchObject({
                runId: result.runId,
                nodeId: "t",
                iteration: 0,
                attempt: 1,
                model: "failed-response-model",
                agent: "failed-agent",
                inputTokens: 17,
                outputTokens: 4,
                cacheReadTokens: 8,
                cacheWriteTokens: 2,
                reasoningTokens: 3,
            });
        }
        finally {
            cleanup();
        }
    });

    test("a throwing usage getter never replaces the provider error", async () => {
        const { smithers, outputs, dbPath, cleanup } = createTestSmithers(schemas);
        try {
            const agent = {
                id: "exotic-error-agent",
                tools: {},
                async generate() {
                    const error = new SmithersError("AGENT_CONFIG_INVALID", "original provider failure", {
                        failureRetryable: false,
                    });
                    Object.defineProperty(error, "usage", {
                        get() { throw new Error("telemetry getter exploded"); },
                    });
                    throw error;
                },
            };
            const workflow = smithers(() => (<Workflow name="token-usage-throwing-getter">
        <Task id="t" output={outputs.a} agent={agent}>
          fail with exotic error
        </Task>
      </Workflow>));

            const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
            expect(result.status).toBe("failed");
            expect(result.error?.cause).toMatchObject({
                code: "AGENT_CONFIG_INVALID",
                message: expect.stringContaining("original provider failure"),
            });
            expect(JSON.stringify(result.error)).not.toContain("telemetry getter exploded");
            expect(readTokenUsageEvents(dbPath)).toEqual([]);
        }
        finally {
            cleanup();
        }
    });
});
