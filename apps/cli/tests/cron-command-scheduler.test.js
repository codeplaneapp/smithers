import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as nodeChildProcess from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { createTempRepo, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";

const { spawnSync } = nodeChildProcess;
// Snapshot the REAL child_process module up front. Bun's mock.restore() does NOT
// undo a mock.module(), so afterAll must re-install this snapshot — otherwise the
// fake spawn leaks to every test file that runs after this one (ui-command,
// --watch) and crashes their `child.once(...)` / `child.stdout.setEncoding(...)`.
const REAL_CHILD_PROCESS = { ...nodeChildProcess };
const spawnCalls = [];
const CLI_ENTRY = resolve(import.meta.dir, "../src/index.js");

let schedulerModule;

// NOTE: mock the child_process module inside beforeAll (not at module top level).
// A top-level mock.module is applied by Bun at collection time and leaks GLOBALLY
// to every other test file — its bare `{ unref() }` child has no `.once`/`.stdout`,
// which crashed every spawn-based test in the suite (devtools, --watch). Scoping it
// to this file's run window (beforeAll → afterAll restore) keeps the mock local.
beforeAll(async () => {
    mock.module("node:child_process", () => ({
        spawn(command, args, options) {
            spawnCalls.push({ command, args, options });
            return { unref() {} };
        },
        spawnSync,
    }));
    schedulerModule = await import("../src/scheduler.js");
});

afterAll(() => {
    // Re-install the real module first — mock.restore() does not undo mock.module().
    mock.module("node:child_process", () => REAL_CHILD_PROCESS);
    mock.restore();
});

beforeEach(() => {
    spawnCalls.length = 0;
});

afterEach(() => {
    mock.restore();
});

/**
 * @param {string} dbPath
 */
function openAdapter(dbPath) {
    const sqlite = new Database(dbPath);
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    return {
        adapter: new SmithersDb(db),
        close: () => sqlite.close(),
    };
}

describe("smithers cron commands", () => {
    test("add, list, and rm manage persisted cron rows", async () => {
        const repo = createTempRepo();
        mkdirSync(repo.path(".smithers"));
        const { close } = openAdapter(repo.path("smithers.db"));
        close();

        const add = runSmithers(["cron", "add", "*/5 * * * *", "workflow.tsx"], {
            cwd: repo.dir,
            format: "json",
        });
        expect(add.exitCode).toBe(0);
        expect(add.json).toMatchObject({
            pattern: "*/5 * * * *",
            workflowPath: "workflow.tsx",
        });
        expect(typeof add.json?.cronId).toBe("string");

        const list = runSmithers(["cron", "list"], {
            cwd: repo.dir,
            format: "json",
        });
        expect(list.exitCode).toBe(0);
        expect(list.json?.crons).toHaveLength(1);
        expect(list.json?.crons[0]).toMatchObject({
            cronId: add.json.cronId,
            pattern: "*/5 * * * *",
            workflowPath: "workflow.tsx",
            enabled: true,
        });

        const rm = runSmithers(["cron", "rm", add.json.cronId], {
            cwd: repo.dir,
            format: "json",
        });
        expect(rm.exitCode).toBe(0);
        expect(rm.json).toMatchObject({ deleted: add.json.cronId });

        const afterRm = runSmithers(["cron", "list"], {
            cwd: repo.dir,
            format: "json",
        });
        expect(afterRm.exitCode).toBe(0);
        expect(afterRm.json).toMatchObject({ crons: [] });
    }, 30_000);

    test("start delegates to the scheduler entrypoint", async () => {
        const repo = createTempRepo();
        mkdirSync(repo.path(".smithers"));
        const { close } = openAdapter(repo.path("smithers.db"));
        close();

        const result = spawnSync(process.execPath, ["run", CLI_ENTRY, "cron", "start"], {
            cwd: repo.dir,
            env: process.env,
            encoding: "utf8",
            timeout: 10_000,
            killSignal: "SIGTERM",
        });

        expect(result.status ?? 0).toBe(0);
        expect(result.stderr + result.stdout).toContain("[smithers-cron] Starting background scheduler loop...");
    }, 30_000);
});

describe("scheduler tick effects", () => {
    test("processes due cron jobs and skips future jobs", async () => {
        const now = Date.parse("2026-06-17T12:00:00.000Z");
        const updates = [];
        const adapter = {
            listCronsEffect(enabledOnly) {
                expect(enabledOnly).toBe(true);
                return Effect.succeed([
                    {
                        cronId: "due-cron",
                        pattern: "*/5 * * * *",
                        workflowPath: "due.tsx",
                        enabled: true,
                        nextRunAtMs: now - 1,
                    },
                    {
                        cronId: "future-cron",
                        pattern: "*/5 * * * *",
                        workflowPath: "future.tsx",
                        enabled: true,
                        nextRunAtMs: now + 60_000,
                    },
                ]);
            },
            updateCronRunTimeEffect(cronId, lastRunAtMs, nextRunAtMs, errorJson) {
                updates.push({ cronId, lastRunAtMs, nextRunAtMs, errorJson });
                return Effect.void;
            },
        };
        const originalNow = Date.now;
        Date.now = () => now;
        try {
            await Effect.runPromise(schedulerModule.schedulerTickEffect(adapter));
        }
        finally {
            Date.now = originalNow;
        }

        expect(spawnCalls).toEqual([
            {
                command: process.execPath,
                args: [CLI_ENTRY, "up", "due.tsx", "-d"],
                options: {
                    cwd: process.cwd(),
                    detached: true,
                    stdio: "ignore",
                },
            },
        ]);
        expect(updates).toHaveLength(1);
        expect(updates[0].cronId).toBe("due-cron");
        expect(updates[0].lastRunAtMs).toBe(now);
        expect(updates[0].nextRunAtMs).toBeGreaterThan(now);
        expect(updates[0].errorJson).toBeUndefined();
    });

    test("records cron processing errors without failing the tick", async () => {
        const now = Date.parse("2026-06-17T12:00:00.000Z");
        const updates = [];
        const adapter = {
            listCronsEffect() {
                return Effect.succeed([
                    {
                        cronId: "bad-cron",
                        pattern: "not a cron pattern",
                        workflowPath: "bad.tsx",
                        enabled: true,
                        nextRunAtMs: now - 1,
                    },
                ]);
            },
            updateCronRunTimeEffect(cronId, lastRunAtMs, nextRunAtMs, errorJson) {
                updates.push({ cronId, lastRunAtMs, nextRunAtMs, errorJson });
                return Effect.void;
            },
        };
        const originalNow = Date.now;
        Date.now = () => now;
        try {
            await Effect.runPromise(schedulerModule.schedulerTickEffect(adapter));
        }
        finally {
            Date.now = originalNow;
        }

        expect(spawnCalls).toHaveLength(1);
        expect(updates).toEqual([
            {
                cronId: "bad-cron",
                lastRunAtMs: now,
                nextRunAtMs: now - 1,
                errorJson: expect.stringContaining("calculate next run for cron bad-cron"),
            },
        ]);
    });

    test("continues when listing crons fails", async () => {
        const adapter = {
            listCronsEffect() {
                return Effect.fail(new Error("db unavailable"));
            },
            updateCronRunTimeEffect() {
                throw new Error("should not update when list fails");
            },
        };

        await Effect.runPromise(schedulerModule.schedulerTickEffect(adapter));

        expect(spawnCalls).toEqual([]);
    });
});
