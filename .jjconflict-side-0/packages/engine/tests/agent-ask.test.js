import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import {
    buildAgentAskRequestId,
    buildAgentAskRequestRow,
    isResolvedHumanRequestStatus,
    waitForHumanAnswer,
} from "../src/human-requests.js";

function createAdapter() {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    return { sqlite, adapter: new SmithersDb(db) };
}

describe("agent ask request builders", () => {
    test("buildAgentAskRequestId appends the uniqueness token", () => {
        expect(buildAgentAskRequestId("run-1", "node-a", 2, "ask-abc")).toBe(
            "human:run-1:node-a:2:ask-abc",
        );
    });

    test("two asks for the same node/iteration get distinct ids", () => {
        const a = buildAgentAskRequestId("run-1", "node-a", 0, "ask-1");
        const b = buildAgentAskRequestId("run-1", "node-a", 0, "ask-2");
        expect(a).not.toBe(b);
    });

    test("buildAgentAskRequestRow defaults to a pending free-form ask", () => {
        const row = buildAgentAskRequestRow({
            runId: "run-1",
            nodeId: "node-a",
            iteration: 0,
            prompt: "Delete the prod bucket?",
            unique: "ask-1",
            requestedAtMs: 1_000,
        });
        expect(row).toEqual({
            requestId: "human:run-1:node-a:0:ask-1",
            runId: "run-1",
            nodeId: "node-a",
            iteration: 0,
            kind: "ask",
            status: "pending",
            prompt: "Delete the prod bucket?",
            schemaJson: null,
            optionsJson: null,
            responseJson: null,
            requestedAtMs: 1_000,
            answeredAtMs: null,
            answeredBy: null,
            timeoutAtMs: null,
        });
    });

    test("isResolvedHumanRequestStatus", () => {
        expect(isResolvedHumanRequestStatus("pending")).toBe(false);
        expect(isResolvedHumanRequestStatus("answered")).toBe(true);
        expect(isResolvedHumanRequestStatus("cancelled")).toBe(true);
        expect(isResolvedHumanRequestStatus("expired")).toBe(true);
    });
});

describe("waitForHumanAnswer", () => {
    test("resolves with the answer once a human responds", async () => {
        const { sqlite, adapter } = createAdapter();
        try {
            const row = buildAgentAskRequestRow({
                runId: "run-1",
                nodeId: "agent-ask",
                iteration: 0,
                prompt: "Proceed?",
                unique: "ask-1",
                requestedAtMs: Date.now(),
            });
            await adapter.insertHumanRequest(row);

            let ticks = 0;
            const sleep = async () => {
                ticks += 1;
                if (ticks === 1) {
                    await adapter.answerHumanRequest(
                        row.requestId,
                        JSON.stringify({ decision: "approve" }),
                        Date.now(),
                        "operator:test",
                    );
                }
            };

            const outcome = await waitForHumanAnswer(adapter, row.requestId, {
                sleep,
                pollIntervalMs: 1,
            });
            expect(outcome.status).toBe("answered");
            expect(outcome.answeredBy).toBe("operator:test");
            expect(JSON.parse(String(outcome.responseJson))).toEqual({
                decision: "approve",
            });
        } finally {
            sqlite.close();
        }
    });

    test("resolves as expired when the request is past its timeout", async () => {
        const { sqlite, adapter } = createAdapter();
        try {
            const now = 10_000;
            const row = buildAgentAskRequestRow({
                runId: "run-1",
                nodeId: "agent-ask",
                iteration: 0,
                prompt: "Proceed?",
                unique: "ask-1",
                requestedAtMs: now - 5_000,
                timeoutAtMs: now - 1,
            });
            await adapter.insertHumanRequest(row);

            const outcome = await waitForHumanAnswer(adapter, row.requestId, {
                now: () => now,
                sleep: async () => {
                    throw new Error("should not sleep when already expired");
                },
            });
            expect(outcome.status).toBe("expired");
        } finally {
            sqlite.close();
        }
    });

    test("resolves as cancelled when the operator cancels", async () => {
        const { sqlite, adapter } = createAdapter();
        try {
            const row = buildAgentAskRequestRow({
                runId: "run-1",
                nodeId: "agent-ask",
                iteration: 0,
                prompt: "Proceed?",
                unique: "ask-1",
                requestedAtMs: Date.now(),
            });
            await adapter.insertHumanRequest(row);
            await adapter.cancelHumanRequest(row.requestId);

            const outcome = await waitForHumanAnswer(adapter, row.requestId, {
                sleep: async () => {
                    throw new Error("should not sleep when already cancelled");
                },
            });
            expect(outcome.status).toBe("cancelled");
        } finally {
            sqlite.close();
        }
    });

    test("reports missing when the request does not exist", async () => {
        const { sqlite, adapter } = createAdapter();
        try {
            const outcome = await waitForHumanAnswer(adapter, "human:nope:nope:0:x", {
                sleep: async () => {
                    throw new Error("should not sleep for a missing request");
                },
            });
            expect(outcome.status).toBe("missing");
        } finally {
            sqlite.close();
        }
    });

    test("returns aborted when the signal is already aborted", async () => {
        const { sqlite, adapter } = createAdapter();
        try {
            const outcome = await waitForHumanAnswer(adapter, "human:any:any:0:x", {
                signal: AbortSignal.abort(),
                sleep: async () => {
                    throw new Error("should not sleep when aborted");
                },
            });
            expect(outcome.status).toBe("aborted");
        } finally {
            sqlite.close();
        }
    });
});
