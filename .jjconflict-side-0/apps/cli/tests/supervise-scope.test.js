import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "../../../packages/db/src/adapter.js";
import { ensureSmithersTables } from "../../../packages/db/src/ensure.js";
import { createTempRepo, pinSqliteBackend, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";

const TIMEOUT_MS = 120_000;

function openRepoDb(repo) {
    pinSqliteBackend(repo.dir);
    const sqlite = new Database(repo.path("smithers.db"));
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    return { sqlite, adapter: new SmithersDb(db) };
}

async function insertStaleRun(adapter, runId, workflowPath) {
    const now = Date.now();
    await adapter.insertRun({
        runId,
        workflowName: "supervisor-scope-fixture",
        workflowPath,
        status: "running",
        createdAtMs: now - 120_000,
        startedAtMs: now - 120_000,
        heartbeatAtMs: now - 60_000,
        runtimeOwnerId: "pid:999999:dead-owner",
    });
}

describe("smithers supervise scope", () => {
    test("rejects an implicit workspace-wide sweep", () => {
        const repo = createTempRepo();
        const result = runSmithers(["supervise"], { cwd: repo.dir, format: "json", timeoutMs: TIMEOUT_MS });
        expect(result.exitCode).toBe(4);
        expect(result.json?.code).toBe("SUPERVISOR_SCOPE_REQUIRED");
        expect(result.json?.message).toContain("--run");
        expect(result.json?.message).toContain("--all");
    }, TIMEOUT_MS);

    test("--run scopes dry-run candidates and --all lists the sweep set", async () => {
        const repo = createTempRepo();
        const workflowPath = repo.write("workflow.tsx", "export default {};\n");
        const { sqlite, adapter } = openRepoDb(repo);
        try {
            await insertStaleRun(adapter, "run-x", workflowPath);
            await insertStaleRun(adapter, "run-y", workflowPath);

            const scoped = runSmithers(["supervise", "--run", "run-x", "--dry-run"], { cwd: repo.dir, format: "json", timeoutMs: TIMEOUT_MS });
            expect(scoped.exitCode, `${scoped.stdout}\n${scoped.stderr}`).toBe(0);
            expect(scoped.json?.wouldResume).toEqual(["run-x"]);

            const all = runSmithers(["supervise", "--all", "--dry-run"], { cwd: repo.dir, format: "json", timeoutMs: TIMEOUT_MS });
            expect(all.exitCode, `${all.stdout}\n${all.stderr}`).toBe(0);
            expect(new Set(all.json?.wouldResume)).toEqual(new Set(["run-x", "run-y"]));
        }
        finally {
            sqlite.close();
        }
    }, TIMEOUT_MS);
});
