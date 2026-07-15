/** @jsxImportSource smithers-orchestrator */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { sleep } from "../../smithers/tests/helpers.js";
let createSmithers;
let Gateway;
let SmithersDb;
/**
 * @param {string} name
 */
function makeDbPath(name) {
    return join(tmpdir(), `smithers-gateway-timers-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}
/**
 * A trivial workflow whose only job is to give the gateway a registered entry
 * (and a DB handle) to sweep. The timer runs are seeded directly so the sweep's
 * decision is what's under test, not the engine's render path.
 * @param {string} dbPath
 */
function createTimerHostWorkflow(dbPath) {
    const api = createSmithers({
        done: z.object({ ok: z.boolean() }),
    }, { dbPath });
    const workflow = api.smithers(() => (<api.Workflow name="gateway-timer-host">
      <api.Task id="noop" output={api.outputs.done}>
        {{ ok: true }}
      </api.Task>
    </api.Workflow>));
    return { workflow, db: api.db };
}
/**
 * Seed a run suspended on a `<Timer>` exactly the way the engine leaves it: run +
 * node in `waiting-timer`, with the fire time recorded on the attempt's metaJson.
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {string} workflowName
 * @param {number} firesAtMs
 * @param {{ runStatus?: "waiting-timer" | "waiting-approval" | "waiting-event"; metaJson?: string }} [options]
 */
async function seedWaitingTimerRun(adapter, runId, workflowName, firesAtMs, options = {}) {
    const now = Date.now();
    await adapter.insertRun({
        runId,
        workflowName,
        workflowHash: "timer-hash",
        status: options.runStatus ?? "waiting-timer",
        createdAtMs: now,
    });
    await adapter.insertNode({
        runId,
        nodeId: "cooldown",
        iteration: 0,
        state: "waiting-timer",
        lastAttempt: 1,
        updatedAtMs: now,
        outputTable: "",
        label: "cooldown",
    });
    await adapter.insertAttempt({
        runId,
        nodeId: "cooldown",
        iteration: 0,
        attempt: 1,
        state: "waiting-timer",
        startedAtMs: now,
        finishedAtMs: null,
        errorJson: null,
        metaJson: options.metaJson ?? JSON.stringify({
            timer: {
                timerId: "cooldown",
                timerType: "duration",
                createdAtMs: now,
                firesAtMs,
                firedAtMs: null,
                duration: "1h",
            },
        }),
        responseText: null,
        cached: false,
        jjPointer: null,
        jjCwd: null,
    });
}
/**
 * Seed a run parked on a provider usage/session limit exactly the way the engine
 * leaves it: run in `waiting-quota` with the reset time on the run's errorJson.
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {string} workflowName
 * @param {number | null} resetAtMs
 */
async function seedWaitingQuotaRun(adapter, runId, workflowName, resetAtMs) {
    const now = Date.now();
    await adapter.insertRun({
        runId,
        workflowName,
        workflowHash: "quota-hash",
        status: "waiting-quota",
        createdAtMs: now,
    });
    await adapter.updateRun(runId, {
        errorJson: JSON.stringify({
            quotaBlockedCount: 1,
            ...(resetAtMs != null ? { resetAtMs } : {}),
        }),
    });
}
describe("Gateway timer sweep", () => {
    let gateway;
    let dbPaths = [];
    beforeAll(async () => {
        createSmithers = (await import("smithers-orchestrator/create")).createSmithers;
        Gateway = (await import("../src/gateway.js")).Gateway;
        SmithersDb = (await import("@smithers-orchestrator/db/adapter")).SmithersDb;
    });
    beforeEach(() => {
        gateway = undefined;
        dbPaths = [];
    });
    afterEach(async () => {
        if (gateway) {
            await gateway.close();
        }
        for (const dbPath of dbPaths) {
            try {
                rmSync(dbPath, { force: true });
                rmSync(`${dbPath}-shm`, { force: true });
                rmSync(`${dbPath}-wal`, { force: true });
            }
            catch { }
        }
        gateway = undefined;
        dbPaths = [];
    });
    test("resumes a waiting-timer run once its fire time has passed", async () => {
        const dbPath = makeDbPath("due");
        dbPaths.push(dbPath);
        const { workflow, db } = createTimerHostWorkflow(dbPath);
        gateway = new Gateway();
        gateway.register("report", workflow);
        const resumed = [];
        gateway.resumeRunIfNeeded = async (runId, workflowKey) => {
            resumed.push({ runId, workflowKey });
        };
        const adapter = new SmithersDb(db);
        await seedWaitingTimerRun(adapter, "due-run", "report", Date.now() - 1_000);
        await gateway.processDueTimers();
        expect(resumed).toEqual([{ runId: "due-run", workflowKey: "report" }]);
    });
    test("leaves a waiting-timer run suspended until its fire time", async () => {
        const dbPath = makeDbPath("pending");
        dbPaths.push(dbPath);
        const { workflow, db } = createTimerHostWorkflow(dbPath);
        gateway = new Gateway();
        gateway.register("report", workflow);
        const resumed = [];
        gateway.resumeRunIfNeeded = async (runId, workflowKey) => {
            resumed.push({ runId, workflowKey });
        };
        const adapter = new SmithersDb(db);
        await seedWaitingTimerRun(adapter, "pending-run", "report", Date.now() + 3_600_000);
        await gateway.processDueTimers();
        expect(resumed).toEqual([]);
    });
    test("resumes due timers shadowed by approval and event run statuses once per shared DB", async () => {
        const dbPath = makeDbPath("shadow-due");
        dbPaths.push(dbPath);
        const first = createTimerHostWorkflow(dbPath);
        const second = createTimerHostWorkflow(dbPath);
        gateway = new Gateway();
        gateway.register("report", first.workflow);
        gateway.register("report-copy", second.workflow);
        const resumed = [];
        gateway.resumeRunIfNeeded = async (runId, workflowKey) => {
            resumed.push({ runId, workflowKey });
        };
        const adapter = new SmithersDb(first.db);
        await seedWaitingTimerRun(adapter, "approval-shadow", "report", Date.now() - 1_000, {
            runStatus: "waiting-approval",
        });
        await seedWaitingTimerRun(adapter, "event-shadow", "report", Date.now() - 1_000, {
            runStatus: "waiting-event",
        });

        await gateway.processDueTimers();

        expect(resumed).toEqual([
            { runId: "approval-shadow", workflowKey: "report" },
            { runId: "event-shadow", workflowKey: "report" },
        ]);
    });
    test("future timers shadowed by approval and event keep the gateway awake", async () => {
        const dbPath = makeDbPath("shadow-future");
        dbPaths.push(dbPath);
        const { workflow, db } = createTimerHostWorkflow(dbPath);
        gateway = new Gateway();
        gateway.register("report", workflow);
        const resumed = [];
        gateway.resumeRunIfNeeded = async (runId, workflowKey) => {
            resumed.push({ runId, workflowKey });
        };
        const adapter = new SmithersDb(db);
        await seedWaitingTimerRun(adapter, "approval-future", "report", Date.now() + 3_600_000, {
            runStatus: "waiting-approval",
        });
        await seedWaitingTimerRun(adapter, "event-future", "report", Date.now() + 3_600_000, {
            runStatus: "waiting-event",
        });

        await gateway.processDueTimers();

        expect(resumed).toEqual([]);
        expect(gateway.hasPendingTimers).toBe(true);
    });
    test("active shadowed timer runs stay fenced from the sweep", async () => {
        const dbPath = makeDbPath("shadow-active");
        dbPaths.push(dbPath);
        const { workflow, db } = createTimerHostWorkflow(dbPath);
        gateway = new Gateway();
        gateway.register("report", workflow);
        const resumed = [];
        gateway.resumeRunIfNeeded = async (runId, workflowKey) => {
            resumed.push({ runId, workflowKey });
        };
        const adapter = new SmithersDb(db);
        await seedWaitingTimerRun(adapter, "approval-active", "report", Date.now() - 1_000, {
            runStatus: "waiting-approval",
        });
        gateway.activeRuns.set("approval-active", { abort: { abort() { } } });

        await gateway.processDueTimers();

        expect(resumed).toEqual([]);
        expect(gateway.hasPendingTimers).toBe(true);
    });
    test("approval and event rows without a valid timer deadline do not pin idle shutdown", async () => {
        const dbPath = makeDbPath("shadow-invalid");
        dbPaths.push(dbPath);
        const { workflow, db } = createTimerHostWorkflow(dbPath);
        gateway = new Gateway();
        gateway.register("report", workflow);
        const resumed = [];
        gateway.resumeRunIfNeeded = async (runId, workflowKey) => {
            resumed.push({ runId, workflowKey });
        };
        const adapter = new SmithersDb(db);
        await adapter.insertRun({
            runId: "approval-no-timer",
            workflowName: "report",
            workflowHash: "timer-hash",
            status: "waiting-approval",
            createdAtMs: Date.now(),
        });
        await seedWaitingTimerRun(adapter, "event-malformed", "report", Date.now() + 3_600_000, {
            runStatus: "waiting-event",
            metaJson: JSON.stringify({ timer: { firesAtMs: "not-a-number" } }),
        });

        await gateway.processDueTimers();

        expect(resumed).toEqual([]);
        expect(gateway.hasPendingTimers).toBe(false);
        expect(gateway.isIdle()).toBe(true);
    });
    test("skips a run that is already being driven", async () => {
        const dbPath = makeDbPath("active");
        dbPaths.push(dbPath);
        const { workflow, db } = createTimerHostWorkflow(dbPath);
        gateway = new Gateway();
        gateway.register("report", workflow);
        const resumed = [];
        gateway.resumeRunIfNeeded = async (runId, workflowKey) => {
            resumed.push({ runId, workflowKey });
        };
        const adapter = new SmithersDb(db);
        await seedWaitingTimerRun(adapter, "active-run", "report", Date.now() - 1_000);
        gateway.activeRuns.set("active-run", { abort: { abort() { } } });
        await gateway.processDueTimers();
        expect(resumed).toEqual([]);
    });
    test("resumes a waiting-quota run once its reset time has passed", async () => {
        const dbPath = makeDbPath("quota-due");
        dbPaths.push(dbPath);
        const { workflow, db } = createTimerHostWorkflow(dbPath);
        gateway = new Gateway();
        gateway.register("report", workflow);
        const resumed = [];
        gateway.resumeRunIfNeeded = async (runId, workflowKey) => {
            resumed.push({ runId, workflowKey });
        };
        const adapter = new SmithersDb(db);
        await seedWaitingQuotaRun(adapter, "quota-due-run", "report", Date.now() - 1_000);
        await gateway.processDueTimers();
        expect(resumed).toEqual([{ runId: "quota-due-run", workflowKey: "report" }]);
    });
    test("leaves a waiting-quota run suspended until its reset time", async () => {
        const dbPath = makeDbPath("quota-pending");
        dbPaths.push(dbPath);
        const { workflow, db } = createTimerHostWorkflow(dbPath);
        gateway = new Gateway();
        gateway.register("report", workflow);
        const resumed = [];
        gateway.resumeRunIfNeeded = async (runId, workflowKey) => {
            resumed.push({ runId, workflowKey });
        };
        const adapter = new SmithersDb(db);
        await seedWaitingQuotaRun(adapter, "quota-pending-run", "report", Date.now() + 3_600_000);
        await gateway.processDueTimers();
        expect(resumed).toEqual([]);
    });
    test("never auto-resumes a quota run with no known reset time (credit exhaustion)", async () => {
        const dbPath = makeDbPath("quota-noreset");
        dbPaths.push(dbPath);
        const { workflow, db } = createTimerHostWorkflow(dbPath);
        gateway = new Gateway();
        gateway.register("report", workflow);
        const resumed = [];
        gateway.resumeRunIfNeeded = async (runId, workflowKey) => {
            resumed.push({ runId, workflowKey });
        };
        const adapter = new SmithersDb(db);
        await seedWaitingQuotaRun(adapter, "quota-noreset-run", "report", null);
        await gateway.processDueTimers();
        expect(resumed).toEqual([]);
        // A no-reset run is never auto-resumed, so it must not pin the gateway
        // awake: hasPendingTimers stays false and the gateway can idle out.
        expect(gateway.hasPendingTimers).toBe(false);
        expect(gateway.isIdle()).toBe(true);
    });
    test("keeps the gateway busy while a future-reset quota run is parked", async () => {
        const dbPath = makeDbPath("quota-future-busy");
        dbPaths.push(dbPath);
        const { workflow, db } = createTimerHostWorkflow(dbPath);
        gateway = new Gateway();
        gateway.register("report", workflow);
        gateway.resumeRunIfNeeded = async () => {};
        const adapter = new SmithersDb(db);
        await seedWaitingQuotaRun(adapter, "quota-future-busy-run", "report", Date.now() + 3_600_000);
        await gateway.processDueTimers();
        expect(gateway.hasPendingTimers).toBe(true);
    });
    test("fails a due run whose source changed instead of re-sweeping it forever", async () => {
        const dbPath = makeDbPath("source-changed");
        dbPaths.push(dbPath);
        const dir = mkdtempSync(join(tmpdir(), "smithers-gateway-timer-source-"));
        const entryFile = join(dir, "workflow.tsx");
        // The workflow source as it stands now: its content hash will not match the
        // run's recorded durability hash, exactly as when the source changed since
        // the run parked on its <Timer>.
        writeFileSync(entryFile, "export default 'v2';\n", "utf8");
        const { workflow, db } = createTimerHostWorkflow(dbPath);
        gateway = new Gateway();
        gateway.register("report", workflow, { entryFile });
        const adapter = new SmithersDb(db);
        await seedWaitingTimerRun(adapter, "source-changed-run", "report", Date.now() - 1_000);
        // Drive the REAL sweep chain (processDueTimers -> resumeRunIfNeeded ->
        // startRun -> engine runWorkflow), no monkeypatched resume. On the mismatch
        // the run must be persisted `failed`, not rethrown transiently while the row
        // stays `waiting-timer` for the next sweep to re-drive forever (issue #494).
        await gateway.processDueTimers();
        // startRun resolves before the background resume settles; poll for the row.
        let run = await adapter.getRun("source-changed-run");
        for (let i = 0; i < 200 && run?.status === "waiting-timer"; i += 1) {
            await sleep(25);
            run = await adapter.getRun("source-changed-run");
        }
        expect(run?.status).toBe("failed");
        expect(JSON.parse(run?.errorJson ?? "{}")?.code).toBe("RESUME_METADATA_MISMATCH");
        const eventTypes = (await adapter.listEvents("source-changed-run", -1, 50)).map((event) => event.type);
        expect(eventTypes).toContain("RunFailed");
        // A second sweep must not resurrect the now-failed run (no silent re-park loop).
        await gateway.processDueTimers();
        const after = await adapter.getRun("source-changed-run");
        expect(after?.status).toBe("failed");
        rmSync(dir, { recursive: true, force: true });
    });
});
