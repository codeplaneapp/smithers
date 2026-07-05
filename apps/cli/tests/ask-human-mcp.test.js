import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { createSemanticToolDefinitions } from "../src/mcp/semantic-tools.js";

function makeHarness() {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);
    const defs = createSemanticToolDefinitions({
        cwd: () => "/tmp",
        openDb: async () => ({ adapter, cleanup: () => {} }),
    });
    const askHuman = defs.find((def) => def.name === "ask_human");
    return { sqlite, adapter, askHuman };
}

describe("ask_human semantic tool", () => {
    test("is registered as a semantic tool", () => {
        const { sqlite, askHuman } = makeHarness();
        try {
            expect(askHuman).toBeTruthy();
            expect(typeof askHuman.handler).toBe("function");
        } finally {
            sqlite.close();
        }
    });

    test("blocks then returns the human's decision when answered", async () => {
        const { sqlite, adapter, askHuman } = makeHarness();
        try {
            const callPromise = askHuman.handler(
                askHuman.inputSchema.parse({
                    prompt: "Deploy to prod?",
                    runId: "run-1",
                    nodeId: "deploy",
                    iteration: 0,
                    pollSeconds: 0.25,
                }),
            );

            // Wait for the durable pending request to appear, then answer it.
            let requestId;
            for (let i = 0; i < 60 && !requestId; i += 1) {
                const pending = await adapter.listPendingHumanRequests();
                if (pending.length > 0) {
                    requestId = pending[0].requestId;
                } else {
                    await new Promise((r) => setTimeout(r, 25));
                }
            }
            expect(requestId).toBeTruthy();

            await adapter.answerHumanRequest(
                requestId,
                JSON.stringify({ decision: "approve", reason: "looks good" }),
                Date.now(),
                "operator:test",
            );

            const result = await callPromise;
            expect(result.structuredContent.ok).toBe(true);
            const data = result.structuredContent.data;
            expect(data.status).toBe("answered");
            expect(data.decision).toBe("approved");
            expect(data.response).toEqual({ decision: "approve", reason: "looks good" });
            expect(data.answeredBy).toBe("operator:test");
        } finally {
            sqlite.close();
        }
    });

    test("returns decision 'blocked' when the request expires", async () => {
        const { sqlite, askHuman } = makeHarness();
        try {
            const result = await askHuman.handler(
                askHuman.inputSchema.parse({
                    prompt: "Proceed?",
                    runId: "run-1",
                    nodeId: "n",
                    iteration: 0,
                    timeoutSeconds: 0.001,
                    pollSeconds: 0.25,
                }),
            );
            expect(result.structuredContent.ok).toBe(true);
            expect(result.structuredContent.data.status).toBe("expired");
            expect(result.structuredContent.data.decision).toBe("blocked");
        } finally {
            sqlite.close();
        }
    });

    test("stops waiting when the caller aborts", async () => {
        const { sqlite, adapter, askHuman } = makeHarness();
        try {
            const abort = new AbortController();
            const callPromise = askHuman.handler(
                askHuman.inputSchema.parse({
                    prompt: "Proceed?",
                    runId: "run-1",
                    nodeId: "n",
                    iteration: 0,
                    pollSeconds: 60,
                }),
                { signal: abort.signal },
            );

            let requestId;
            for (let i = 0; i < 60 && !requestId; i += 1) {
                const pending = await adapter.listPendingHumanRequests();
                if (pending.length > 0) {
                    requestId = pending[0].requestId;
                } else {
                    await new Promise((r) => setTimeout(r, 25));
                }
            }
            expect(requestId).toBeTruthy();

            abort.abort();
            const result = await callPromise;
            expect(result.structuredContent.ok).toBe(true);
            expect(result.structuredContent.data.requestId).toBe(requestId);
            expect(result.structuredContent.data.status).toBe("aborted");
            expect(result.structuredContent.data.decision).toBe("blocked");

            // The orphaned request must be cancelled, not left pending for a
            // human to answer after the caller has gone.
            const stillPending = await adapter.listPendingHumanRequests();
            expect(stillPending).toHaveLength(0);
            const cancelled = await adapter.getHumanRequest(requestId);
            expect(cancelled?.status).toBe("cancelled");
        } finally {
            sqlite.close();
        }
    });
});
