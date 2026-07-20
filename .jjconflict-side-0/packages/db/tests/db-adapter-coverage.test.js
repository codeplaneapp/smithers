import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "../src/adapter.js";
import { ensureSmithersTables } from "../src/ensure.js";

function createAdapter() {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    return { adapter: new SmithersDb(db), sqlite };
}

function humanRequestRow(extra = {}) {
    return {
        requestId: "req-1",
        runId: "run-1",
        nodeId: "human",
        iteration: 0,
        kind: "approval",
        status: "pending",
        prompt: "Approve?",
        schemaJson: null,
        optionsJson: null,
        responseJson: null,
        requestedAtMs: 100,
        answeredAtMs: null,
        answeredBy: null,
        timeoutAtMs: null,
        ...extra,
    };
}

async function expectRejects(effect, pattern) {
    try {
        await effect;
        throw new Error("Expected effect to reject");
    }
    catch (error) {
        expect(String(error)).toMatch(pattern);
    }
}

describe("SmithersDb rawQuery guard", () => {
    test("allows read-only statements", async () => {
        const { adapter } = createAdapter();

        const selectRows = await adapter.rawQuery("SELECT 1 AS value");
        const valuesRows = await adapter.rawQuery("VALUES (2)");
        const explainRows = await adapter.rawQuery("EXPLAIN SELECT 1");

        expect(selectRows).toEqual([{ value: 1 }]);
        expect(valuesRows).toEqual([{ column1: 2 }]);
        expect(explainRows.length).toBeGreaterThan(0);
    });

    test("rejects writes, multiple statements, and non-read prefixes", async () => {
        const { adapter } = createAdapter();

        await expectRejects(adapter.rawQuery("DELETE FROM _smithers_runs"), /DELETE/);
        await expectRejects(adapter.rawQuery("SELECT 1; UPDATE _smithers_runs SET status = 'failed'"), /single read-only/);
        await expectRejects(adapter.rawQuery("PRAGMA table_info('_smithers_runs')"), /PRAGMA/);
    });

    test("ignores forbidden words inside comments and literals", async () => {
        const { adapter } = createAdapter();

        const rows = await adapter.rawQuery("SELECT 'delete' AS word -- update later");

        expect(rows).toEqual([{ word: "delete" }]);
    });
});

describe("SmithersDb human requests", () => {
    test("expires stale pending requests before listing pending rows", async () => {
        const { adapter } = createAdapter();
        await adapter.insertRun({
            runId: "run-1",
            workflowName: "workflow",
            status: "running",
            createdAtMs: 1,
        });
        await adapter.insertNode({
            runId: "run-1",
            nodeId: "human",
            iteration: 0,
            state: "waiting",
            updatedAtMs: 2,
            outputTable: "out",
            label: "Human gate",
        });
        await adapter.insertHumanRequest(humanRequestRow({ requestId: "expired", timeoutAtMs: 50 }));
        await adapter.insertHumanRequest(humanRequestRow({ requestId: "pending", requestedAtMs: 200, timeoutAtMs: 500 }));

        const pending = await adapter.listPendingHumanRequests(100);
        const expired = await adapter.getHumanRequest("expired");

        expect(pending.map((row) => row.requestId)).toEqual(["pending"]);
        expect(pending[0].workflowName).toBe("workflow");
        expect(pending[0].nodeLabel).toBe("Human gate");
        expect(expired?.status).toBe("expired");
    });

    test("answers, reopens, and cancels pending human requests", async () => {
        const { adapter } = createAdapter();
        await adapter.insertHumanRequest(humanRequestRow());

        await adapter.answerHumanRequest("req-1", "{\"ok\":true}", 300, "will");
        let row = await adapter.getHumanRequest("req-1");
        expect(row?.status).toBe("answered");
        expect(row?.responseJson).toBe("{\"ok\":true}");
        expect(row?.answeredBy).toBe("will");

        await adapter.reopenHumanRequest("req-1");
        row = await adapter.getHumanRequest("req-1");
        expect(row?.status).toBe("pending");
        expect(row?.responseJson).toBeNull();

        await adapter.cancelHumanRequest("req-1");
        row = await adapter.getHumanRequest("req-1");
        expect(row?.status).toBe("cancelled");
    });
});
