/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Workflow, Task, runWorkflow } from "smithers-orchestrator";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { z } from "zod";
import { Effect } from "effect";

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
});
