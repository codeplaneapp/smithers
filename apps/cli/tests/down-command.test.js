import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { createTempRepo, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";

const CLI_ENTRY = resolve(import.meta.dir, "../src/index.js");

/**
 * @param {ReturnType<typeof createTempRepo>} repo
 */
function openRepoDb(repo) {
    const sqlite = new Database(repo.path("smithers.db"));
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    return {
        sqlite,
        adapter: new SmithersDb(db),
    };
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {Record<string, unknown>} [overrides]
 */
async function insertRunningRun(adapter, runId, overrides = {}) {
    const now = Date.now();
    await adapter.insertRun({
        runId,
        workflowName: "down-fixture",
        workflowPath: "workflow.tsx",
        status: "running",
        createdAtMs: now - 10_000,
        startedAtMs: now - 9_000,
        finishedAtMs: null,
        // Default to a fresh heartbeat (isRunHeartbeatFresh => true).
        heartbeatAtMs: now,
        ...overrides,
    });
}

describe("smithers down --force staleness check", () => {
    // Regression: `down` declared a `--force` flag but never read it, so it
    // unconditionally cancelled every active run. A run whose heartbeat is
    // still fresh must be treated as live and skipped unless --force is passed.
    test("without --force, a run with a FRESH heartbeat is skipped (not cancelled)", async () => {
        const repo = createTempRepo();
        const { sqlite, adapter } = openRepoDb(repo);
        try {
            await insertRunningRun(adapter, "fresh-run", { heartbeatAtMs: Date.now() });

            const result = runSmithers(["down"], { cwd: repo.dir, format: "json" });

            expect(result.exitCode).toBe(0);
            expect(result.json).toMatchObject({ cancelled: 0, skipped: 1 });
            expect(result.stderr).toContain("Skipped (still live): fresh-run");

            // The fresh run must remain untouched.
            const after = await adapter.getRun("fresh-run");
            expect(after?.status).toBe("running");
        }
        finally {
            sqlite.close();
        }
    }, 60_000);

    test("with --force, a run with a FRESH heartbeat IS cancelled", async () => {
        const repo = createTempRepo();
        const { sqlite, adapter } = openRepoDb(repo);
        try {
            await insertRunningRun(adapter, "fresh-run", { heartbeatAtMs: Date.now() });

            const result = runSmithers(["down", "--force"], { cwd: repo.dir, format: "json" });

            expect(result.exitCode).toBe(0);
            expect(result.json).toMatchObject({ cancelled: 1, skipped: 0 });

            const after = await adapter.getRun("fresh-run");
            expect(after?.status).toBe("cancelled");
        }
        finally {
            sqlite.close();
        }
    }, 60_000);

    test("without --force, a run with a STALE heartbeat is still cancelled", async () => {
        const repo = createTempRepo();
        const { sqlite, adapter } = openRepoDb(repo);
        try {
            // Heartbeat well past the staleness threshold (30s).
            await insertRunningRun(adapter, "stale-run", { heartbeatAtMs: Date.now() - 120_000 });

            const result = runSmithers(["down"], { cwd: repo.dir, format: "json" });

            expect(result.exitCode).toBe(0);
            expect(result.json).toMatchObject({ cancelled: 1, skipped: 0 });

            const after = await adapter.getRun("stale-run");
            expect(after?.status).toBe("cancelled");
        }
        finally {
            sqlite.close();
        }
    }, 60_000);
});

describe("smithers logs --follow waiting-state CTA", () => {
    // Regression: the waiting-approval/event/timer CTA branches keyed off
    // `currentStatus`, but the follow loop only exits once the run is NOT in a
    // waiting state, so currentStatus could never be a waiting status inside the
    // exit block — the hints were dead code. The fix tracks the last waiting
    // status observed and bases the CTA hints on that.
    test("a run ending in waiting-approval emits the approve CTA hint", async () => {
        const repo = createTempRepo();
        const { sqlite, adapter } = openRepoDb(repo);
        try {
            const now = Date.now();
            await adapter.insertRun({
                runId: "wa-run",
                workflowName: "down-fixture",
                workflowPath: "workflow.tsx",
                status: "waiting-approval",
                createdAtMs: now - 10_000,
                startedAtMs: now - 9_000,
                finishedAtMs: null,
                heartbeatAtMs: now,
            });
            // Seed an event so the follow loop emits a recognizable line once it
            // has started — our deterministic signal that the loop is running.
            await adapter.insertEventWithNextSeq({
                runId: "wa-run",
                type: "STARTUP_MARKER",
                timestampMs: now,
                payloadJson: JSON.stringify({ marker: true }),
            });

            const proc = Bun.spawn(
                [process.execPath, "run", CLI_ENTRY, "logs", "wa-run", "--follow"],
                { cwd: repo.dir, stdout: "pipe", stderr: "pipe", env: { ...process.env } },
            );

            // Read stdout incrementally. Only once the marker line appears (the
            // loop is confirmed running while the run is waiting-approval) do we
            // transition the run to a terminal state, so the loop exits through
            // the waiting-state CTA branch deterministically.
            const decoder = new TextDecoder();
            let stdout = "";
            const reader = proc.stdout.getReader();
            const deadline = Date.now() + 40_000;
            let transitioned = false;
            while (Date.now() < deadline) {
                const { value, done } = await reader.read();
                if (done) {
                    break;
                }
                stdout += decoder.decode(value, { stream: true });
                if (!transitioned && stdout.includes("STARTUP_MARKER")) {
                    transitioned = true;
                    await adapter.updateRun("wa-run", {
                        status: "cancelled",
                        finishedAtMs: Date.now(),
                    });
                }
            }
            await proc.exited;

            expect(transitioned).toBe(true);
            expect(proc.exitCode).toBe(0);
            // The fixed CTA must surface the approve hint for the prior waiting state.
            expect(stdout).toContain("approve wa-run");
            expect(stdout).toContain("inspect wa-run");
        }
        finally {
            sqlite.close();
        }
    }, 60_000);
});
