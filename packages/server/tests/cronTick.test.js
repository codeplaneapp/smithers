import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { computeNextRunAtMs, runCronTick } from "../src/cronTick.js";

/**
 * Opens a fresh in-memory `SmithersDb` (schema-migrated), matching the
 * pattern used elsewhere in this repo's test suite (e.g.
 * `apps/cli/tests/cron-command-scheduler.test.js`'s `openAdapter`).
 */
function openAdapter() {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    return { adapter: new SmithersDb(db), sqlite };
}

/** @param {SmithersDb} adapter */
async function insertCron(adapter, row) {
    await adapter.upsertCron({
        cronId: row.cronId,
        pattern: row.pattern,
        workflowPath: row.workflowPath,
        enabled: row.enabled ?? true,
        createdAtMs: row.createdAtMs ?? Date.now(),
        lastRunAtMs: row.lastRunAtMs ?? null,
        nextRunAtMs: row.nextRunAtMs ?? null,
        errorJson: row.errorJson ?? null,
    });
}

describe("runCronTick", () => {
    test("fires a due cron and advances its next run time", async () => {
        const { adapter, sqlite } = openAdapter();
        try {
            const now = Date.parse("2026-06-17T12:00:00.000Z");
            await insertCron(adapter, {
                cronId: "due-cron",
                pattern: "*/5 * * * *",
                workflowPath: "due.tsx",
                nextRunAtMs: now - 1,
            });
            const started = [];
            const result = await runCronTick(adapter, {
                now,
                workerId: "test-worker",
                startWorkflowRun: async (job) => {
                    started.push(job.cronId);
                },
            });

            expect(started).toEqual(["due-cron"]);
            expect(result.claimedCount).toBe(1);
            expect(result.fired).toHaveLength(1);
            expect(result.fired[0].cronId).toBe("due-cron");
            expect(result.fired[0].nextRunAtMs).toBeGreaterThan(now);
            expect(result.errors).toHaveLength(0);

            const [row] = await adapter.listCrons(false);
            expect(row.lastRunAtMs).toBe(now);
            expect(row.nextRunAtMs).toBe(result.fired[0].nextRunAtMs);
            // The lease must be released once the tick finishes processing the job.
            expect(row.claimedAtMs).toBeNull();
            expect(row.claimedBy).toBeNull();
        }
        finally {
            sqlite.close();
        }
    });

    test("does not fire a cron whose next run is in the future", async () => {
        const { adapter, sqlite } = openAdapter();
        try {
            const now = Date.parse("2026-06-17T12:00:00.000Z");
            await insertCron(adapter, {
                cronId: "future-cron",
                pattern: "*/5 * * * *",
                workflowPath: "future.tsx",
                nextRunAtMs: now + 60_000,
            });
            const started = [];
            const result = await runCronTick(adapter, {
                now,
                workerId: "test-worker",
                startWorkflowRun: async (job) => {
                    started.push(job.cronId);
                },
            });

            expect(started).toEqual([]);
            expect(result.claimedCount).toBe(0);
            expect(result.fired).toHaveLength(0);
        }
        finally {
            sqlite.close();
        }
    });

    test("catch-up semantics: a cron missed for multiple periods fires once and advances from now, not from the missed schedule", async () => {
        const { adapter, sqlite } = openAdapter();
        try {
            const now = Date.parse("2026-06-17T12:00:00.000Z");
            // Never run, and long overdue (pattern is every 5 minutes but
            // nextRunAtMs is over an hour in the past).
            await insertCron(adapter, {
                cronId: "missed-cron",
                pattern: "*/5 * * * *",
                workflowPath: "missed.tsx",
                nextRunAtMs: now - 60 * 60_000,
            });
            const started = [];
            const result = await runCronTick(adapter, {
                now,
                workerId: "test-worker",
                startWorkflowRun: async (job) => {
                    started.push(job.cronId);
                },
            });

            // Exactly one fire for the whole catch-up window (no burst of 12 runs).
            expect(started).toEqual(["missed-cron"]);
            expect(result.fired).toHaveLength(1);
            // The computed next run is relative to `now`, not the stale schedule.
            expect(result.fired[0].nextRunAtMs).toBe(computeNextRunAtMs("*/5 * * * *", now));
        }
        finally {
            sqlite.close();
        }
    });

    test("records a failure without leaving the cron claimed forever", async () => {
        const { adapter, sqlite } = openAdapter();
        try {
            const now = Date.parse("2026-06-17T12:00:00.000Z");
            await insertCron(adapter, {
                cronId: "failing-cron",
                pattern: "*/5 * * * *",
                workflowPath: "failing.tsx",
                nextRunAtMs: now - 1,
            });
            const result = await runCronTick(adapter, {
                now,
                workerId: "test-worker",
                startWorkflowRun: async () => {
                    throw new Error("boom");
                },
            });

            expect(result.fired).toHaveLength(0);
            expect(result.errors).toEqual([{ cronId: "failing-cron", error: "boom" }]);

            const [row] = await adapter.listCrons(false);
            expect(row.claimedAtMs).toBeNull();
            expect(row.errorJson).toBe("boom");
        }
        finally {
            sqlite.close();
        }
    });

    test("concurrent-tick safety: two overlapping tick() calls only let one claim (and fire) a due cron", async () => {
        const { adapter, sqlite } = openAdapter();
        try {
            const now = Date.parse("2026-06-17T12:00:00.000Z");
            await insertCron(adapter, {
                cronId: "contested-cron",
                pattern: "*/5 * * * *",
                workflowPath: "contested.tsx",
                nextRunAtMs: now - 1,
            });

            const started = [];
            // Simulate two overlapping serverless invocations racing the same
            // due cron. Each `startWorkflowRun` yields to the microtask queue
            // before resolving, widening the race window as much as possible
            // within a single-threaded test.
            const tick = (workerId) => runCronTick(adapter, {
                now,
                workerId,
                startWorkflowRun: async (job) => {
                    await Promise.resolve();
                    started.push(job.cronId);
                },
            });

            const [resultA, resultB] = await Promise.all([tick("worker-a"), tick("worker-b")]);

            const totalClaimed = resultA.claimedCount + resultB.claimedCount;
            const totalFired = resultA.fired.length + resultB.fired.length;
            expect(totalClaimed).toBe(1);
            expect(totalFired).toBe(1);
            expect(started).toEqual(["contested-cron"]);
        }
        finally {
            sqlite.close();
        }
    });
});
