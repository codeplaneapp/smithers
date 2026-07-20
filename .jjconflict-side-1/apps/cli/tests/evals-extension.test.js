import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { createEvalsExtension } from "../src/evals-extension.js";

function createExtension(workflows = { basic: { id: "basic", entryFile: "/repo/.smithers/workflows/basic.tsx", packDir: "/repo/.smithers" } }) {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);
    const extension = createEvalsExtension({
        adapter,
        resolveWorkflowKey: (key) => workflows[key],
        workspace: "/repo",
    });
    return { sqlite, adapter, extension };
}

const VALID_DATASET = JSON.stringify([{ id: "a", input: { prompt: "hi" } }, { id: "b", input: { prompt: "bye" } }]);

describe("evals-extension: listSuites / saveSuite", () => {
    test("listSuites on an empty DB returns a bare empty array", async () => {
        const { sqlite, extension } = createExtension();
        const result = await extension.resources.listSuites.handler({}, /** @type {any} */ ({}));
        expect(result).toEqual([]);
        sqlite.close();
    });

    test("saveSuite without a suiteId mints one, persists, and a follow-up listSuites shows the caseCount", async () => {
        const { sqlite, extension } = createExtension();
        const saved = await extension.actions.saveSuite.handler({
            name: "Smoke",
            workflowKey: "basic",
            datasetText: VALID_DATASET,
        }, /** @type {any} */ ({}));
        expect(typeof saved.suiteId).toBe("string");
        expect(saved.suiteId.length).toBeGreaterThan(0);

        const suites = await extension.resources.listSuites.handler({}, /** @type {any} */ ({}));
        expect(suites).toEqual([{
            suiteId: saved.suiteId,
            name: "Smoke",
            workflowKey: "basic",
            caseCount: 2,
            updatedAtMs: expect.any(Number),
        }]);
        sqlite.close();
    });

    test("saveSuite with the same suiteId UPDATES the row instead of creating a duplicate", async () => {
        const { sqlite, extension } = createExtension();
        const first = await extension.actions.saveSuite.handler({
            name: "Smoke",
            workflowKey: "basic",
            datasetText: VALID_DATASET,
        }, /** @type {any} */ ({}));

        const second = await extension.actions.saveSuite.handler({
            suiteId: first.suiteId,
            name: "Renamed",
            workflowKey: "basic",
            datasetText: JSON.stringify([{ id: "a", input: {} }]),
        }, /** @type {any} */ ({}));
        expect(second.suiteId).toBe(first.suiteId);

        const suites = await extension.resources.listSuites.handler({}, /** @type {any} */ ({}));
        expect(suites).toHaveLength(1);
        expect(suites[0].name).toBe("Renamed");
        expect(suites[0].caseCount).toBe(1);
        sqlite.close();
    });

    test("an unknown workflowKey is a typed INVALID_INPUT with a human message", async () => {
        const { sqlite, extension } = createExtension();
        await expect(extension.actions.saveSuite.handler({
            name: "Smoke",
            workflowKey: "does-not-exist",
            datasetText: VALID_DATASET,
        }, /** @type {any} */ ({}))).rejects.toMatchObject({
            code: "INVALID_INPUT",
        });
        try {
            await extension.actions.saveSuite.handler({ name: "Smoke", workflowKey: "does-not-exist", datasetText: VALID_DATASET }, /** @type {any} */ ({}));
        }
        catch (error) {
            expect(String(error.message ?? error)).toContain("does-not-exist");
        }
        sqlite.close();
    });

    test("unparseable datasetText is an honest error, not a crash", async () => {
        const { sqlite, extension } = createExtension();
        await expect(extension.actions.saveSuite.handler({
            name: "Smoke",
            workflowKey: "basic",
            datasetText: "{not: valid json,,,",
        }, /** @type {any} */ ({}))).rejects.toMatchObject({ code: "INVALID_INPUT" });
        sqlite.close();
    });

    test("zero cases is an honest error", async () => {
        const { sqlite, extension } = createExtension();
        await expect(extension.actions.saveSuite.handler({
            name: "Smoke",
            workflowKey: "basic",
            datasetText: "[]",
        }, /** @type {any} */ ({}))).rejects.toMatchObject({ code: "INVALID_INPUT" });
        sqlite.close();
    });

    test("a blank name or workflowKey is rejected before touching the dataset", async () => {
        const { sqlite, extension } = createExtension();
        await expect(extension.actions.saveSuite.handler({
            name: "  ",
            workflowKey: "basic",
            datasetText: VALID_DATASET,
        }, /** @type {any} */ ({}))).rejects.toMatchObject({ code: "INVALID_INPUT" });
        await expect(extension.actions.saveSuite.handler({
            name: "Smoke",
            workflowKey: "",
            datasetText: VALID_DATASET,
        }, /** @type {any} */ ({}))).rejects.toMatchObject({ code: "INVALID_INPUT" });
        sqlite.close();
    });
});

describe("evals-extension: listCases", () => {
    test("an unknown evalRunId returns a bare empty array, never an error", async () => {
        const { sqlite, extension } = createExtension();
        const result = await extension.resources.listCases.handler({ evalRunId: "no-such-run" }, /** @type {any} */ ({}));
        expect(result).toEqual([]);
        sqlite.close();
    });

    test("composes scorerVerdict from seeded _smithers_scorers rows keyed by node_id = case-<id>, and every row matches the EvalCaseResult key set exactly", async () => {
        const { sqlite, adapter, extension } = createExtension();
        const evalRunId = "eval-run-1";
        await adapter.insertRun({
            runId: evalRunId,
            parentRunId: null,
            workflowName: "eval-suite-run",
            workflowPath: null,
            workflowHash: null,
            status: "running",
            createdAtMs: 1000,
            startedAtMs: 1000,
            finishedAtMs: null,
            heartbeatAtMs: 1000,
            runtimeOwnerId: null,
            cancelRequestedAtMs: null,
            hijackRequestedAtMs: null,
            hijackTarget: null,
            vcsType: null,
            vcsRoot: null,
            vcsRevision: null,
            errorJson: null,
            configJson: null,
        });
        await adapter.upsertEvalCaseResult({
            id: `${evalRunId}:a`,
            evalRunId,
            suiteId: "suite-1",
            caseId: "a",
            caseIndex: 0,
            name: null,
            status: "ok",
            caseRunId: "child-run-a",
            inputJson: JSON.stringify({ prompt: "hi" }),
            expectedJson: null,
            actualJson: JSON.stringify({ reply: "hi there" }),
            assertionsJson: JSON.stringify([{ description: "case run finished", passed: true }]),
            error: null,
            startedAtMs: 1000,
            finishedAtMs: 1200,
            durationMs: 200,
        });
        await adapter.insertScorerResult({
            id: "score-1",
            runId: evalRunId,
            nodeId: "case-a",
            iteration: 0,
            attempt: 0,
            scorerId: "eval-assertions",
            scorerName: "Eval Assertions",
            source: "async",
            score: 1,
            reason: "All 1 assertion(s) passed.",
            metaJson: null,
            inputJson: null,
            outputJson: null,
            groundTruthJson: null,
            contextJson: null,
            latencyMs: null,
            scoredAtMs: 1200,
            durationMs: null,
        });

        const rows = await extension.resources.listCases.handler({ evalRunId }, /** @type {any} */ ({}));
        expect(rows).toHaveLength(1);
        const row = rows[0];
        expect(row.caseId).toBe("a");
        expect(row.status).toBe("ok");
        expect(row.caseRunId).toBe("child-run-a");
        expect(row.input).toEqual({ prompt: "hi" });
        expect(row.actual).toEqual({ reply: "hi there" });
        expect(row.assertions).toEqual([{ description: "case run finished", passed: true }]);
        expect(row.scorerVerdict).toEqual([{ scorer: "Eval Assertions", score: 1, reason: "All 1 assertion(s) passed." }]);
        expect(row.durationMs).toBe(200);
        // Bare EvalCaseResult keys only — no envelope, no extraneous fields.
        const allowedKeys = new Set(["caseId", "name", "status", "caseRunId", "input", "expected", "actual", "assertions", "scorerVerdict", "durationMs", "error"]);
        for (const key of Object.keys(row)) {
            expect(allowedKeys.has(key)).toBe(true);
        }
        sqlite.close();
    });

    test("reconciles a still-running case under a failed _smithers_runs row to cancelled", async () => {
        const { sqlite, adapter, extension } = createExtension();
        const evalRunId = "eval-run-2";
        await adapter.insertRun({
            runId: evalRunId,
            parentRunId: null,
            workflowName: "eval-suite-run",
            workflowPath: null,
            workflowHash: null,
            status: "failed",
            createdAtMs: 1000,
            startedAtMs: 1000,
            finishedAtMs: 1500,
            heartbeatAtMs: 1500,
            runtimeOwnerId: null,
            cancelRequestedAtMs: null,
            hijackRequestedAtMs: null,
            hijackTarget: null,
            vcsType: null,
            vcsRoot: null,
            vcsRevision: null,
            errorJson: JSON.stringify({ message: "boom" }),
            configJson: null,
        });
        await adapter.upsertEvalCaseResult({
            id: `${evalRunId}:a`,
            evalRunId,
            suiteId: "suite-1",
            caseId: "a",
            caseIndex: 0,
            name: null,
            status: "running",
            caseRunId: "child-run-a",
            inputJson: null,
            expectedJson: null,
            actualJson: null,
            assertionsJson: null,
            error: null,
            startedAtMs: 1000,
            finishedAtMs: null,
            durationMs: null,
        });
        await adapter.upsertEvalCaseResult({
            id: `${evalRunId}:b`,
            evalRunId,
            suiteId: "suite-1",
            caseId: "b",
            caseIndex: 1,
            name: null,
            status: "ok",
            caseRunId: "child-run-b",
            inputJson: null,
            expectedJson: null,
            actualJson: null,
            assertionsJson: null,
            error: null,
            startedAtMs: 1000,
            finishedAtMs: 1100,
            durationMs: 100,
        });

        const rows = await extension.resources.listCases.handler({ evalRunId }, /** @type {any} */ ({}));
        const byId = Object.fromEntries(rows.map((row) => [row.caseId, row]));
        expect(byId.a.status).toBe("cancelled");
        // A terminal (non-queued/running) case is left as-is.
        expect(byId.b.status).toBe("ok");
        sqlite.close();
    });
});
