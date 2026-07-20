import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "../src/adapter.js";
import { ensureSmithersTables } from "../src/ensure.js";

function createAdapter() {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    return { sqlite, adapter: new SmithersDb(db) };
}

function suiteRow(extra = {}) {
    return {
        suiteId: "suite-1",
        name: "Smoke Suite",
        workflowKey: "hello",
        workflowPath: "/repo/.smithers/workflows/hello.tsx",
        workflowRoot: "/repo/.smithers",
        datasetJson: JSON.stringify([{ id: "c1", input: {} }]),
        caseCount: 1,
        createdAtMs: 1000,
        updatedAtMs: 1000,
        ...extra,
    };
}

function caseRow(extra = {}) {
    return {
        id: "run-1:c1",
        evalRunId: "run-1",
        suiteId: "suite-1",
        caseId: "c1",
        caseIndex: 0,
        name: null,
        status: "queued",
        caseRunId: null,
        inputJson: "{}",
        expectedJson: null,
        actualJson: null,
        assertionsJson: null,
        error: null,
        startedAtMs: null,
        finishedAtMs: null,
        durationMs: null,
        ...extra,
    };
}

describe("SmithersDb eval suite store", () => {
    test("upsertEvalSuite inserts, then updates the same row (bumped updatedAtMs, no dupe)", async () => {
        const { sqlite, adapter } = createAdapter();
        await adapter.upsertEvalSuite(suiteRow());
        let all = await adapter.listEvalSuites();
        expect(all).toHaveLength(1);
        expect(all[0].name).toBe("Smoke Suite");

        await adapter.upsertEvalSuite(suiteRow({ name: "Renamed Suite", caseCount: 2, updatedAtMs: 2000 }));
        all = await adapter.listEvalSuites();
        expect(all).toHaveLength(1);
        expect(all[0].name).toBe("Renamed Suite");
        expect(all[0].caseCount).toBe(2);
        expect(all[0].updatedAtMs).toBe(2000);
        sqlite.close();
    });

    test("listEvalSuites orders by updatedAtMs descending", async () => {
        const { sqlite, adapter } = createAdapter();
        await adapter.upsertEvalSuite(suiteRow({ suiteId: "a", updatedAtMs: 1000 }));
        await adapter.upsertEvalSuite(suiteRow({ suiteId: "b", updatedAtMs: 3000 }));
        await adapter.upsertEvalSuite(suiteRow({ suiteId: "c", updatedAtMs: 2000 }));
        const all = await adapter.listEvalSuites();
        expect(all.map((row) => row.suiteId)).toEqual(["b", "c", "a"]);
        sqlite.close();
    });

    test("getEvalSuite returns undefined for a miss", async () => {
        const { sqlite, adapter } = createAdapter();
        expect(await adapter.getEvalSuite("nope")).toBeUndefined();
        await adapter.upsertEvalSuite(suiteRow());
        const row = await adapter.getEvalSuite("suite-1");
        expect(row?.suiteId).toBe("suite-1");
        expect(row?.workflowKey).toBe("hello");
        sqlite.close();
    });

    test("upsertEvalCaseResult transitions queued -> running -> ok, keyed by `${evalRunId}:${caseId}`", async () => {
        const { sqlite, adapter } = createAdapter();
        await adapter.upsertEvalCaseResult(caseRow());
        let row = (await adapter.listEvalCaseResults("run-1"))[0];
        expect(row.status).toBe("queued");

        await adapter.upsertEvalCaseResult(caseRow({ status: "running", caseRunId: "child-run-1", startedAtMs: 500 }));
        row = (await adapter.listEvalCaseResults("run-1"))[0];
        expect(row.status).toBe("running");
        expect(row.caseRunId).toBe("child-run-1");

        await adapter.upsertEvalCaseResult(caseRow({
            status: "ok",
            caseRunId: "child-run-1",
            startedAtMs: 500,
            finishedAtMs: 900,
            durationMs: 400,
            actualJson: JSON.stringify({ result: "4" }),
            assertionsJson: JSON.stringify([{ description: "case run finished", passed: true }]),
        }));
        const rows = await adapter.listEvalCaseResults("run-1");
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe("ok");
        expect(rows[0].durationMs).toBe(400);
        expect(JSON.parse(rows[0].actualJson)).toEqual({ result: "4" });
        sqlite.close();
    });

    test("listEvalCaseResults orders by caseIndex and scopes to one evalRunId", async () => {
        const { sqlite, adapter } = createAdapter();
        await adapter.upsertEvalCaseResult(caseRow({ id: "run-1:c2", caseId: "c2", caseIndex: 1 }));
        await adapter.upsertEvalCaseResult(caseRow({ id: "run-1:c1", caseId: "c1", caseIndex: 0 }));
        await adapter.upsertEvalCaseResult(caseRow({ id: "run-1:c3", caseId: "c3", caseIndex: 2 }));
        // A different eval run's rows must never leak into another run's list.
        await adapter.upsertEvalCaseResult(caseRow({ id: "run-2:c1", evalRunId: "run-2", caseId: "c1", caseIndex: 0 }));

        const rows = await adapter.listEvalCaseResults("run-1");
        expect(rows.map((row) => row.caseId)).toEqual(["c1", "c2", "c3"]);
        expect(rows.every((row) => row.evalRunId === "run-1")).toBe(true);

        const otherRun = await adapter.listEvalCaseResults("run-2");
        expect(otherRun).toHaveLength(1);
        sqlite.close();
    });

    test("listEvalCaseResults for an unknown evalRunId is an empty array, never an error", async () => {
        const { sqlite, adapter } = createAdapter();
        const rows = await adapter.listEvalCaseResults("does-not-exist");
        expect(rows).toEqual([]);
        sqlite.close();
    });
});
