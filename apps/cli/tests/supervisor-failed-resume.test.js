import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { parseSupervisorClaimAttempts, supervisorPollEffect } from "../src/supervisor.js";

const START = Date.now();

function createTestDb() {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);
    return { adapter, sqlite };
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
        createdAtMs: START - 120_000,
        startedAtMs: START - 120_000,
        heartbeatAtMs: START - 60_000,
        runtimeOwnerId: "pid:11111:dead-driver",
        ...extra,
    };
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {string} type
 */
async function eventPayloads(adapter, runId, type) {
    const events = await adapter.listEvents(runId, -1, 100);
    return events
        .filter((event) => event.type === type)
        .map((event) => JSON.parse(event.payloadJson));
}

// Real supervisor poll + real SmithersDb; only the process-spawning seam is a
// recording stub. These tests pin the issue #1361 fix: a detached auto-resume
// that dies before the engine activates must not wedge the run forever (the
// leftover `supervisor:` claim owner used to skip as owner-unverified) and
// must not hot-loop forever either — after maxResumeAttempts consecutive dead
// resumes the run fails visibly with AUTO_RESUME_GAVE_UP diagnostics.
describe("supervisor bounded failed-resume recovery (issue #1361)", () => {
    test("parseSupervisorClaimAttempts reads the attempt count out of claim owners", () => {
        expect(parseSupervisorClaimAttempts(null)).toBe(0);
        expect(parseSupervisorClaimAttempts(undefined)).toBe(0);
        expect(parseSupervisorClaimAttempts("")).toBe(0);
        expect(parseSupervisorClaimAttempts("pid:123:engine")).toBe(0);
        expect(parseSupervisorClaimAttempts("host-abc:session")).toBe(0);
        expect(parseSupervisorClaimAttempts("supervisor:abc")).toBe(1);
        expect(parseSupervisorClaimAttempts("supervisor:abc#a2")).toBe(2);
        expect(parseSupervisorClaimAttempts("supervisor:abc#a17")).toBe(17);
    });

    test("re-claims a stale run wedged behind a leftover supervisor claim instead of skipping it as owner-unverified", async () => {
        const { adapter, sqlite } = createTestDb();
        const resumed = [];
        // A prior supervisor claimed this run, spawned a resume, and that
        // resume died at startup: the claim owner never got replaced by an
        // engine `pid:` owner and the heartbeat went stale again.
        await adapter.insertRun(runRow("run-wedged", {
            runtimeOwnerId: "supervisor:previous-supervisor",
        }));
        const summary = await Effect.runPromise(supervisorPollEffect({
            adapter,
            staleThresholdMs: 30_000,
            supervisorId: "sup-2",
            deps: {
                now: () => START,
                workflowExists: () => true,
                spawnResumeDetached: (_workflowPath, runId, claim) => {
                    resumed.push({ runId, claimOwnerId: claim?.claimOwnerId });
                    return 4242;
                },
            },
        }));
        expect(summary.resumedCount).toBe(1);
        expect(resumed).toEqual([
            { runId: "run-wedged", claimOwnerId: "supervisor:sup-2#a2" },
        ]);
        const run = await adapter.getRun("run-wedged");
        expect(run?.runtimeOwnerId).toBe("supervisor:sup-2#a2");
        const autoResumes = await eventPayloads(adapter, "run-wedged", "RunAutoResumed");
        expect(autoResumes).toHaveLength(1);
        expect(autoResumes[0].resumeAttempt).toBe(2);
        sqlite.close();
    });

    test("gives up after maxResumeAttempts consecutive dead resumes: fails the run with AUTO_RESUME_GAVE_UP and stops looping", async () => {
        const { adapter, sqlite } = createTestDb();
        let now = START;
        const spawned = [];
        await adapter.insertRun(runRow("run-loop"));
        const poll = () => Effect.runPromise(supervisorPollEffect({
            adapter,
            staleThresholdMs: 30_000,
            supervisorId: "failsup",
            deps: {
                now: () => now,
                workflowExists: () => true,
                // Spawn "succeeds" but the detached resume dies before the
                // engine activates, so the claim owner is never replaced.
                spawnResumeDetached: (_workflowPath, runId, claim) => {
                    spawned.push(claim?.claimOwnerId);
                    return 9999;
                },
                readDetachedLogTail: () => "cli load workflow: repro startup crash",
            },
        }));

        // Attempts 1..3 each claim, spawn, and make no progress.
        for (const expectedOwner of [
            "supervisor:failsup",
            "supervisor:failsup#a2",
            "supervisor:failsup#a3",
        ]) {
            const summary = await poll();
            expect(summary.resumedCount).toBe(1);
            const run = await adapter.getRun("run-loop");
            expect(run?.status).toBe("running");
            expect(run?.runtimeOwnerId).toBe(expectedOwner);
            now += 60_000;
        }
        expect(spawned).toEqual([
            "supervisor:failsup",
            "supervisor:failsup#a2",
            "supervisor:failsup#a3",
        ]);

        // Fourth detection: attempts exhausted. No spawn; the run fails with
        // durable diagnostics instead.
        const giveUpSummary = await poll();
        expect(giveUpSummary.resumedCount).toBe(0);
        expect(spawned).toHaveLength(3);
        const run = await adapter.getRun("run-loop");
        expect(run?.status).toBe("failed");
        expect(run?.runtimeOwnerId).toBeNull();
        expect(run?.finishedAtMs).toBeGreaterThan(0);
        const errorInfo = JSON.parse(run?.errorJson ?? "null");
        expect(errorInfo?.code).toBe("AUTO_RESUME_GAVE_UP");
        expect(errorInfo?.message).toContain("run-loop");
        expect(errorInfo?.details?.attempts).toBe(3);
        expect(errorInfo?.details?.lastClaimOwnerId).toBe("supervisor:failsup#a3");
        expect(String(errorInfo?.details?.logFile)).toContain("run-loop.log");
        expect(errorInfo?.details?.logTail).toBe("cli load workflow: repro startup crash");
        const failedEvents = await eventPayloads(adapter, "run-loop", "RunFailed");
        expect(failedEvents).toHaveLength(1);
        expect(failedEvents[0].error?.code).toBe("AUTO_RESUME_GAVE_UP");
        const skips = await eventPayloads(adapter, "run-loop", "RunAutoResumeSkipped");
        expect(skips.map((skip) => skip.reason)).toContain("resume-attempts-exhausted");
        const autoResumes = await eventPayloads(adapter, "run-loop", "RunAutoResumed");
        expect(autoResumes.map((event) => event.resumeAttempt)).toEqual([1, 2, 3]);

        // The failed run leaves the stale-running sweep entirely.
        now += 60_000;
        const idleSummary = await poll();
        expect(idleSummary.staleCount).toBe(0);
        expect(spawned).toHaveLength(3);
        sqlite.close();
    });

    test("a quota-parked run whose resumes keep dying is failed instead of retried every poll", async () => {
        const { adapter, sqlite } = createTestDb();
        const quotaRun = runRow("run-quota", {
            status: "waiting-quota",
            runtimeOwnerId: "supervisor:quota-sup#a3",
            heartbeatAtMs: START - 5_000,
            errorJson: JSON.stringify({ resetAtMs: START - 1_000 }),
        });
        await adapter.insertRun(quotaRun);
        const summary = await Effect.runPromise(supervisorPollEffect({
            adapter,
            staleThresholdMs: 30_000,
            supervisorId: "quota-sup",
            deps: {
                now: () => START,
                workflowExists: () => true,
                spawnResumeDetached: () => {
                    throw new Error("must NOT spawn once resume attempts are exhausted");
                },
                runsDueForQuotaResume: () => Promise.resolve([quotaRun]),
                readDetachedLogTail: () => null,
            },
        }));
        expect(summary.resumedCount).toBe(0);
        const run = await adapter.getRun("run-quota");
        expect(run?.status).toBe("failed");
        const errorInfo = JSON.parse(run?.errorJson ?? "null");
        expect(errorInfo?.code).toBe("AUTO_RESUME_GAVE_UP");
        expect(errorInfo?.details?.logTail).toBeUndefined();
        sqlite.close();
    });

    test("dry-run reports the give-up without mutating the run", async () => {
        const { adapter, sqlite } = createTestDb();
        await adapter.insertRun(runRow("run-dry", {
            runtimeOwnerId: "supervisor:dry-sup#a3",
        }));
        const summary = await Effect.runPromise(supervisorPollEffect({
            adapter,
            staleThresholdMs: 30_000,
            dryRun: true,
            deps: {
                now: () => START,
                workflowExists: () => true,
                spawnResumeDetached: () => {
                    throw new Error("dry-run must never spawn");
                },
            },
        }));
        expect(summary.resumedCount).toBe(0);
        const run = await adapter.getRun("run-dry");
        expect(run?.status).toBe("running");
        expect(run?.runtimeOwnerId).toBe("supervisor:dry-sup#a3");
        sqlite.close();
    });
});
