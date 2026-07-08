import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, onTestFinished, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect } from "effect";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { SUPERVISOR_EVENT_RUN_ID, supervisorPollEffect, } from "../src/supervisor.js";
import { createTempRepo, pinSqliteBackend } from "../../../packages/smithers/tests/e2e-helpers.js";
const now = 1_750_000_000_000;
const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.js");

function createTestDb() {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);
    return { adapter, sqlite };
}
/**
 * @param {ReturnType<typeof createTempRepo>} repo
 */
function createRepoDb(repo) {
    pinSqliteBackend(repo.dir);
    const sqlite = new Database(repo.path("smithers.db"));
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);
    return { adapter, sqlite };
}
function createWorkflowDir() {
    const dir = mkdtempSync(join(tmpdir(), "smithers-supervisor-e2e-"));
    return {
        dir,
        /**
     * @param {string} name
     */
        workflowPath(name, exists = true) {
            const path = join(dir, `${name}.tsx`);
            if (exists) {
                writeFileSync(path, `export const workflowName = "${name}";\n`);
            }
            return path;
        },
        cleanup() {
            rmSync(dir, { recursive: true, force: true });
        },
    };
}
/**
 * @param {string} runId
 * @param {any} [extra]
 */
function runRow(runId, extra = {}) {
    return {
        runId,
        workflowName: "test-workflow",
        workflowPath: `/tmp/${runId}.tsx`,
        status: "running",
        createdAtMs: now - 120_000,
        startedAtMs: now - 120_000,
        heartbeatAtMs: now - 60_000,
        runtimeOwnerId: "pid:99999:owner",
        ...extra,
    };
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {string} workflowPath
 * @param {number} firesAtMs
 */
async function insertDueTimerRun(adapter, runId, workflowPath, firesAtMs) {
    await adapter.insertRun(runRow(runId, {
        workflowPath,
        status: "waiting-timer",
        heartbeatAtMs: null,
        runtimeOwnerId: null,
    }));
    await adapter.insertNode({
        runId,
        nodeId: "cooldown",
        iteration: 0,
        state: "waiting-timer",
        lastAttempt: 1,
        updatedAtMs: now - 1_000,
        outputTable: "",
        label: "timer:cooldown",
    });
    await adapter.insertAttempt({
        runId,
        nodeId: "cooldown",
        iteration: 0,
        attempt: 1,
        state: "waiting-timer",
        startedAtMs: now - 1_000,
        finishedAtMs: null,
        errorJson: null,
        jjPointer: null,
        jjCwd: null,
        cached: false,
        metaJson: JSON.stringify({
            kind: "timer",
            timer: {
                timerId: "cooldown",
                timerType: "duration",
                createdAtMs: now - 1_000,
                firesAtMs,
                firedAtMs: null,
            },
        }),
        responseText: null,
    });
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {string} workflowPath
 */
async function insertWaitingApprovalRun(adapter, runId, workflowPath) {
    await adapter.insertRun(runRow(runId, {
        workflowPath,
        status: "waiting-approval",
        heartbeatAtMs: null,
        runtimeOwnerId: null,
    }));
    await adapter.insertNode({
        runId,
        nodeId: "review",
        iteration: 0,
        state: "waiting-approval",
        lastAttempt: 1,
        updatedAtMs: now - 2_000,
        outputTable: "",
        label: "approval:review",
    });
    await adapter.insertOrUpdateApproval({
        runId,
        nodeId: "review",
        iteration: 0,
        status: "requested",
        requestedAtMs: now - 2_000,
        decidedAtMs: null,
        note: null,
        decidedBy: null,
    });
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 */
async function listEvents(adapter, runId) {
    return (await adapter.listEvents(runId, -1, 200));
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {string} type
 */
async function eventPayloads(adapter, runId, type) {
    const events = await listEvents(adapter, runId);
    return events
        .filter((event) => event.type === type)
        .map((event) => JSON.parse(event.payloadJson));
}
/**
 * @param {number} ms
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * @param {string} label
 * @param {() => boolean | Promise<boolean>} predicate
 * @param {number} [timeoutMs]
 */
async function waitForCondition(label, predicate, timeoutMs = 5_000) {
    const startedAt = Date.now();
    let lastError;
    while (Date.now() - startedAt < timeoutMs) {
        try {
            if (await predicate()) {
                return;
            }
        }
        catch (error) {
            lastError = error;
        }
        await sleep(50);
    }
    const suffix = lastError instanceof Error ? `: ${lastError.message}` : "";
    throw new Error(`Timed out waiting for ${label}${suffix}`);
}
/**
 * @param {string[]} args
 * @param {{ cwd: string; env?: Record<string, string | undefined> }} options
 */
function spawnCli(args, options) {
    const child = spawn(process.execPath, ["run", CLI_ENTRY, ...args], {
        cwd: options.cwd,
        env: {
            ...process.env,
            NO_COLOR: "1",
            FORCE_COLOR: "0",
            CI: "1",
            SMITHERS_NO_SKILL_REFRESH: "1",
            SMITHERS_BACKEND: "sqlite",
            ...options.env,
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
        stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
        stderr += chunk;
    });
    const closePromise = new Promise((resolve) => {
        child.once("close", (code, signal) => resolve({ code, signal }));
    });
    onTestFinished(async () => {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
            await Promise.race([closePromise, sleep(1_000)]);
        }
    });
    return { child, closePromise, stdout: () => stdout, stderr: () => stderr };
}
/**
 * @param {string} dbPath
 */
function readSupervisorEventTypes(dbPath) {
    const sqlite = new Database(dbPath, { readonly: true });
    try {
        return sqlite
            .query("SELECT type FROM _smithers_events WHERE run_id = ? ORDER BY seq ASC")
            .all(SUPERVISOR_EVENT_RUN_ID)
            .map((row) => String(row.type));
    }
    finally {
        sqlite.close();
    }
}
/**
 * @param {string} dbPath
 * @param {string} runId
 */
function readEventRows(dbPath, runId) {
    const sqlite = new Database(dbPath, { readonly: true });
    try {
        return sqlite
            .query("SELECT type, payload_json AS payloadJson FROM _smithers_events WHERE run_id = ? ORDER BY seq ASC")
            .all(runId)
            .map((row) => ({
                type: String(row.type),
                payload: JSON.parse(String(row.payloadJson)),
            }));
    }
    finally {
        sqlite.close();
    }
}
/**
 * @param {string} dbPath
 * @param {string[]} runIds
 */
function readRunRows(dbPath, runIds) {
    const sqlite = new Database(dbPath, { readonly: true });
    try {
        return new Map(runIds.map((runId) => {
            const row = sqlite
                .query("SELECT run_id AS runId, heartbeat_at_ms AS heartbeatAtMs, runtime_owner_id AS runtimeOwnerId FROM _smithers_runs WHERE run_id = ?")
                .get(runId);
            return [runId, row];
        }));
    }
    finally {
        sqlite.close();
    }
}
/**
 * @param {string} stdout
 */
function parseJsonStdout(stdout) {
    const trimmed = stdout.trim();
    expect(trimmed.length, "stdout should contain a JSON document").toBeGreaterThan(0);
    try {
        return JSON.parse(trimmed);
    }
    catch (error) {
        throw new Error(`stdout is not parseable JSON:\n${stdout}`, { cause: error });
    }
}
/**
 * @param {unknown} value
 */
function stoppedStatus(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }
    const record = /** @type {Record<string, any>} */ (value);
    if (record.status !== undefined) {
        return record.status;
    }
    if (record.data && typeof record.data === "object" && !Array.isArray(record.data)) {
        return record.data.status;
    }
    return undefined;
}
describe("supervisor e2e", () => {
    test("standalone supervise dry-run exits cleanly on SIGTERM and persists supervisor events", async () => {
        const repo = createTempRepo();
        const { sqlite } = createRepoDb(repo);
        sqlite.close();
        const dbPath = repo.path("smithers.db");
        const supervisor = spawnCli([
            "supervise",
            "--dry-run",
            "--interval",
            "100ms",
            "--stale-threshold",
            "1s",
            "--max-concurrent",
            "1",
            "--format",
            "json",
        ], { cwd: repo.dir });
        let eventTypes = [];
        try {
            await waitForCondition("supervisor startup stderr", () => supervisor.stderr().includes("Supervisor started"));
            await waitForCondition("persisted supervisor event", () => {
                eventTypes = readSupervisorEventTypes(dbPath);
                return eventTypes.includes("SupervisorStarted") || eventTypes.includes("SupervisorPollCompleted");
            });
            supervisor.child.kill("SIGTERM");
            const exit = await Promise.race([
                supervisor.closePromise,
                sleep(3_000).then(() => ({ timedOut: true })),
            ]);
            expect(exit, `${supervisor.stdout()}\n${supervisor.stderr()}`).not.toMatchObject({ timedOut: true });
            expect(exit, `${supervisor.stdout()}\n${supervisor.stderr()}`).toMatchObject({ code: 0 });
            const parsed = parseJsonStdout(supervisor.stdout());
            expect(stoppedStatus(parsed)).toBe("stopped");
            eventTypes = readSupervisorEventTypes(dbPath);
            expect(eventTypes.some((type) => type === "SupervisorStarted" || type === "SupervisorPollCompleted")).toBe(true);
        }
        finally {
            if (supervisor.child.exitCode === null && supervisor.child.signalCode === null) {
                supervisor.child.kill("SIGKILL");
                await Promise.race([supervisor.closePromise, sleep(1_000)]);
            }
        }
    }, 20_000);

    test("standalone supervise dry-run polls real stale rows without claiming them", async () => {
        const repo = createTempRepo();
        const workflows = createWorkflowDir();
        const { adapter, sqlite } = createRepoDb(repo);
        const dbPath = repo.path("smithers.db");
        const runs = [
            {
                runId: "run-cli-dry-stalest",
                heartbeatAtMs: now - 120_000,
                workflowPath: workflows.workflowPath("run-cli-dry-stalest"),
            },
            {
                runId: "run-cli-dry-stale",
                heartbeatAtMs: now - 90_000,
                workflowPath: workflows.workflowPath("run-cli-dry-stale"),
            },
        ];
        try {
            for (const run of runs) {
                await adapter.insertRun(runRow(run.runId, {
                    workflowPath: run.workflowPath,
                    heartbeatAtMs: run.heartbeatAtMs,
                    runtimeOwnerId: null,
                }));
            }
            sqlite.close();
            const supervisor = spawnCli([
                "supervise",
                "--dry-run",
                "--interval",
                "100ms",
                "--stale-threshold",
                "1s",
                "--max-concurrent",
                "1",
                "--format",
                "json",
            ], { cwd: repo.dir });
            try {
                let pollPayload;
                await waitForCondition("supervisor startup stderr", () => supervisor.stderr().includes("Supervisor started"));
                await waitForCondition("dry-run stale poll event", () => {
                    const pollEvents = readEventRows(dbPath, SUPERVISOR_EVENT_RUN_ID)
                        .filter((event) => event.type === "SupervisorPollCompleted")
                        .map((event) => event.payload);
                    pollPayload = pollEvents.find((payload) => payload.staleCount === 2 &&
                        payload.resumedCount === 0 &&
                        payload.skippedCount === 2);
                    return Boolean(pollPayload);
                });
                expect(pollPayload).toMatchObject({
                    type: "SupervisorPollCompleted",
                    runId: SUPERVISOR_EVENT_RUN_ID,
                    staleCount: 2,
                    resumedCount: 0,
                    skippedCount: 2,
                });
                const runEvents = runs.flatMap((run) => readEventRows(dbPath, run.runId));
                expect(runEvents.some((event) => event.type === "RunAutoResumeSkipped" &&
                    event.payload.reason === "rate-limited")).toBe(true);
                supervisor.child.kill("SIGTERM");
                const exit = await Promise.race([
                    supervisor.closePromise,
                    sleep(3_000).then(() => ({ timedOut: true })),
                ]);
                expect(exit, `${supervisor.stdout()}\n${supervisor.stderr()}`).not.toMatchObject({ timedOut: true });
                expect(exit, `${supervisor.stdout()}\n${supervisor.stderr()}`).toMatchObject({ code: 0 });
                expect(stoppedStatus(parseJsonStdout(supervisor.stdout()))).toBe("stopped");
                const rows = readRunRows(dbPath, runs.map((run) => run.runId));
                for (const run of runs) {
                    expect(rows.get(run.runId)).toMatchObject({
                        runId: run.runId,
                        heartbeatAtMs: run.heartbeatAtMs,
                        runtimeOwnerId: null,
                    });
                }
            }
            finally {
                if (supervisor.child.exitCode === null && supervisor.child.signalCode === null) {
                    supervisor.child.kill("SIGKILL");
                    await Promise.race([supervisor.closePromise, sleep(1_000)]);
                }
            }
        }
        finally {
            if (sqlite.open) {
                sqlite.close();
            }
            workflows.cleanup();
        }
    }, 20_000);

    test("supervisor detects and resumes multiple stale runs in priority order", async () => {
        const { adapter, sqlite } = createTestDb();
        const workflows = createWorkflowDir();
        const resumed = [];
        const originalHeartbeats = {
            "run-stalest": now - 120_000,
            "run-staler": now - 110_000,
            "run-stale": now - 100_000,
            "run-fresher": now - 90_000,
            "run-freshest": now - 80_000,
        };
        try {
            await adapter.insertRun(runRow("run-stalest", {
                workflowPath: workflows.workflowPath("run-stalest"),
                heartbeatAtMs: originalHeartbeats["run-stalest"],
            }));
            await adapter.insertRun(runRow("run-staler", {
                workflowPath: workflows.workflowPath("run-staler"),
                heartbeatAtMs: originalHeartbeats["run-staler"],
            }));
            await adapter.insertRun(runRow("run-stale", {
                workflowPath: workflows.workflowPath("run-stale"),
                heartbeatAtMs: originalHeartbeats["run-stale"],
            }));
            await adapter.insertRun(runRow("run-fresher", {
                workflowPath: workflows.workflowPath("run-fresher"),
                heartbeatAtMs: originalHeartbeats["run-fresher"],
            }));
            await adapter.insertRun(runRow("run-freshest", {
                workflowPath: workflows.workflowPath("run-freshest"),
                heartbeatAtMs: originalHeartbeats["run-freshest"],
            }));
            const summary = await Effect.runPromise(supervisorPollEffect({
                adapter,
                staleThresholdMs: 30_000,
                maxConcurrent: 3,
                supervisorId: "priority-e2e",
                deps: {
                    now: () => now,
                    isPidAlive: () => false,
                    spawnResumeDetached: (_workflowPath, runId) => {
                        resumed.push(runId);
                        return 4_000 + resumed.length;
                    },
                },
            }));
            expect(summary).toEqual({
                staleCount: 5,
                resumedCount: 3,
                skippedCount: 2,
                durationMs: 0,
            });
            expect(resumed.slice().sort()).toEqual([
                "run-stale",
                "run-staler",
                "run-stalest",
            ]);
            for (const runId of ["run-stalest", "run-staler", "run-stale"]) {
                expect(await eventPayloads(adapter, runId, "RunAutoResumed")).toEqual([
                    {
                        type: "RunAutoResumed",
                        runId,
                        lastHeartbeatAtMs: originalHeartbeats[runId],
                        staleDurationMs: now - originalHeartbeats[runId],
                        timestampMs: now,
                    },
                ]);
                const run = await adapter.getRun(runId);
                expect(run?.heartbeatAtMs).toBe(now);
                expect(run?.runtimeOwnerId).toBe("supervisor:priority-e2e");
            }
            for (const runId of ["run-fresher", "run-freshest"]) {
                expect(await eventPayloads(adapter, runId, "RunAutoResumeSkipped")).toEqual([
                    {
                        type: "RunAutoResumeSkipped",
                        runId,
                        reason: "rate-limited",
                        timestampMs: now,
                    },
                ]);
                expect(await eventPayloads(adapter, runId, "RunAutoResumed")).toEqual([]);
                const run = await adapter.getRun(runId);
                expect(run?.heartbeatAtMs).toBe(originalHeartbeats[runId]);
            }
        }
        finally {
            sqlite.close();
            workflows.cleanup();
        }
    });
    test("supervisor handles mixed run states correctly", async () => {
        const { adapter, sqlite } = createTestDb();
        const workflows = createWorkflowDir();
        const resumed = [];
        try {
            await adapter.insertRun(runRow("run-stale", {
                workflowPath: workflows.workflowPath("run-stale"),
                heartbeatAtMs: now - 90_000,
            }));
            await adapter.insertRun(runRow("run-fresh", {
                workflowPath: workflows.workflowPath("run-fresh"),
                heartbeatAtMs: now - 1_000,
            }));
            await adapter.insertRun(runRow("run-failed", {
                workflowPath: workflows.workflowPath("run-failed"),
                status: "failed",
                heartbeatAtMs: now - 120_000,
            }));
            await adapter.insertRun(runRow("run-cancelled", {
                workflowPath: workflows.workflowPath("run-cancelled"),
                status: "cancelled",
                heartbeatAtMs: now - 120_000,
            }));
            await insertDueTimerRun(adapter, "run-timer-due", workflows.workflowPath("run-timer-due"), now - 10);
            await insertWaitingApprovalRun(adapter, "run-waiting-approval", workflows.workflowPath("run-waiting-approval"));
            const summary = await Effect.runPromise(supervisorPollEffect({
                adapter,
                staleThresholdMs: 30_000,
                maxConcurrent: 5,
                deps: {
                    now: () => now,
                    isPidAlive: () => false,
                    spawnResumeDetached: (_workflowPath, runId) => {
                        resumed.push(runId);
                        return 5_000 + resumed.length;
                    },
                },
            }));
            expect(summary).toEqual({
                staleCount: 1,
                resumedCount: 2,
                skippedCount: 0,
                durationMs: 0,
            });
            expect(resumed.slice().sort()).toEqual(["run-stale", "run-timer-due"]);
            expect(await eventPayloads(adapter, "run-stale", "RunAutoResumed")).toHaveLength(1);
            expect(await eventPayloads(adapter, "run-fresh", "RunAutoResumed")).toEqual([]);
            expect(await eventPayloads(adapter, "run-failed", "RunAutoResumed")).toEqual([]);
            expect(await eventPayloads(adapter, "run-cancelled", "RunAutoResumed")).toEqual([]);
            expect(await eventPayloads(adapter, "run-waiting-approval", "RunAutoResumed")).toEqual([]);
        }
        finally {
            sqlite.close();
            workflows.cleanup();
        }
    });
    test("consecutive polls dont double-resume", async () => {
        const { adapter, sqlite } = createTestDb();
        const workflows = createWorkflowDir();
        const resumed = [];
        try {
            await adapter.insertRun(runRow("run-idempotent", {
                workflowPath: workflows.workflowPath("run-idempotent"),
                heartbeatAtMs: now - 75_000,
            }));
            const options = {
                adapter,
                staleThresholdMs: 30_000,
                supervisorId: "idempotent-e2e",
                deps: {
                    now: () => now,
                    isPidAlive: () => false,
                    spawnResumeDetached: (_workflowPath, runId) => {
                        resumed.push(runId);
                        return 6_000 + resumed.length;
                    },
                },
            };
            const first = await Effect.runPromise(supervisorPollEffect(options));
            const second = await Effect.runPromise(supervisorPollEffect(options));
            expect(first).toEqual({
                staleCount: 1,
                resumedCount: 1,
                skippedCount: 0,
                durationMs: 0,
            });
            expect(second).toEqual({
                staleCount: 0,
                resumedCount: 0,
                skippedCount: 0,
                durationMs: 0,
            });
            expect(resumed).toEqual(["run-idempotent"]);
            const run = await adapter.getRun("run-idempotent");
            expect(run?.heartbeatAtMs).toBe(now);
            expect(run?.runtimeOwnerId).toBe("supervisor:idempotent-e2e");
            expect(await eventPayloads(adapter, "run-idempotent", "RunAutoResumed")).toHaveLength(1);
            const supervisorEvents = await eventPayloads(adapter, SUPERVISOR_EVENT_RUN_ID, "SupervisorPollCompleted");
            expect(supervisorEvents).toEqual([
                {
                    type: "SupervisorPollCompleted",
                    runId: SUPERVISOR_EVENT_RUN_ID,
                    staleCount: 1,
                    resumedCount: 1,
                    skippedCount: 0,
                    durationMs: 0,
                    timestampMs: now,
                },
                {
                    type: "SupervisorPollCompleted",
                    runId: SUPERVISOR_EVENT_RUN_ID,
                    staleCount: 0,
                    resumedCount: 0,
                    skippedCount: 0,
                    durationMs: 0,
                    timestampMs: now,
                },
            ]);
        }
        finally {
            sqlite.close();
            workflows.cleanup();
        }
    });
    test("consecutive polls dont double-resume due waiting-timer runs", async () => {
        const { adapter, sqlite } = createTestDb();
        const workflows = createWorkflowDir();
        const resumed = [];
        try {
            await insertDueTimerRun(adapter, "run-timer-idempotent", workflows.workflowPath("run-timer-idempotent"), now - 10);
            const options = {
                adapter,
                staleThresholdMs: 30_000,
                supervisorId: "timer-idempotent-e2e",
                deps: {
                    now: () => now,
                    isPidAlive: () => false,
                    spawnResumeDetached: (_workflowPath, runId) => {
                        resumed.push(runId);
                        return 7_000 + resumed.length;
                    },
                },
            };
            const first = await Effect.runPromise(supervisorPollEffect(options));
            const second = await Effect.runPromise(supervisorPollEffect(options));
            expect(first).toEqual({
                staleCount: 0,
                resumedCount: 1,
                skippedCount: 0,
                durationMs: 0,
            });
            expect(second).toEqual({
                staleCount: 0,
                resumedCount: 0,
                skippedCount: 0,
                durationMs: 0,
            });
            expect(resumed).toEqual(["run-timer-idempotent"]);
            const run = await adapter.getRun("run-timer-idempotent");
            expect(run?.runtimeOwnerId).toBe("supervisor:timer-idempotent-e2e");
            expect(run?.heartbeatAtMs).toBe(now);
            expect(await eventPayloads(adapter, "run-timer-idempotent", "RunAutoResumed")).toHaveLength(1);
        }
        finally {
            sqlite.close();
            workflows.cleanup();
        }
    });
    test("supervisor emits accurate summary metrics", async () => {
        const { adapter, sqlite } = createTestDb();
        const workflows = createWorkflowDir();
        const resumed = [];
        try {
            await adapter.insertRun(runRow("run-dead-a", {
                workflowPath: workflows.workflowPath("run-dead-a"),
                heartbeatAtMs: now - 120_000,
                runtimeOwnerId: "pid:2001:dead-a",
            }));
            await adapter.insertRun(runRow("run-dead-b", {
                workflowPath: workflows.workflowPath("run-dead-b"),
                heartbeatAtMs: now - 110_000,
                runtimeOwnerId: "pid:2002:dead-b",
            }));
            await adapter.insertRun(runRow("run-alive", {
                workflowPath: workflows.workflowPath("run-alive"),
                heartbeatAtMs: now - 100_000,
                runtimeOwnerId: "pid:1111:alive",
            }));
            await adapter.insertRun(runRow("run-missing-a", {
                workflowPath: workflows.workflowPath("run-missing-a", false),
                heartbeatAtMs: now - 90_000,
                runtimeOwnerId: "pid:3001:dead-missing-a",
            }));
            const summary = await Effect.runPromise(supervisorPollEffect({
                adapter,
                staleThresholdMs: 30_000,
                maxConcurrent: 10,
                deps: {
                    now: () => now,
                    isPidAlive: (pid) => pid === 1111,
                    spawnResumeDetached: (_workflowPath, runId) => {
                        resumed.push(runId);
                        return 7_000 + resumed.length;
                    },
                },
            }));
            expect(summary).toEqual({
                staleCount: 4,
                resumedCount: 2,
                skippedCount: 2,
                durationMs: 0,
            });
            expect(resumed.slice().sort()).toEqual(["run-dead-a", "run-dead-b"]);
            expect(await eventPayloads(adapter, "run-alive", "RunAutoResumeSkipped")).toEqual([
                {
                    type: "RunAutoResumeSkipped",
                    runId: "run-alive",
                    reason: "pid-alive",
                    timestampMs: now,
                },
            ]);
            expect(await eventPayloads(adapter, "run-missing-a", "RunAutoResumeSkipped")).toEqual([
                {
                    type: "RunAutoResumeSkipped",
                    runId: "run-missing-a",
                    reason: "missing-workflow",
                    timestampMs: now,
                },
            ]);
            const supervisorEvents = await eventPayloads(adapter, SUPERVISOR_EVENT_RUN_ID, "SupervisorPollCompleted");
            expect(supervisorEvents).toEqual([
                {
                    type: "SupervisorPollCompleted",
                    runId: SUPERVISOR_EVENT_RUN_ID,
                    staleCount: 4,
                    resumedCount: 2,
                    skippedCount: 2,
                    durationMs: 0,
                    timestampMs: now,
                },
            ]);
        }
        finally {
            sqlite.close();
            workflows.cleanup();
        }
    });
});
