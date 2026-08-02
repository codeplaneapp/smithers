/** @jsxImportSource smthrs */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSmithers } from "smthrs";
import { retryTask } from "@smthrs/time-travel/retry-task";
import { z } from "zod";
import { Gateway } from "../src/gateway.js";

/**
 * Run-id ownership regressions. A new launch must not overwrite an active run,
 * concurrent resume triggers must share one engine start, and a settling run
 * must only remove the registry entries that belong to its own invocation.
 */

const AUTH = { triggeredBy: "test", scopes: ["*"], role: "operator", tokenId: null };

function makeDbPath(name) {
  return join(tmpdir(), `smithers-idem-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function createWorkflow(dbPath) {
  const { smithers, Workflow, Task, outputs } = createSmithers({ out: z.object({ value: z.number() }) }, { dbPath });
  return smithers(() => (
    <Workflow name="idem">
      <Task id="a" output={outputs.out}>
        {{ value: 1 }}
      </Task>
    </Workflow>
  ));
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createSequencedWorkflow(dbPath) {
  const api = createSmithers({ out: z.object({ value: z.number() }) }, { dbPath });
  const started = [deferred(), deferred()];
  const releases = [deferred(), deferred()];
  let taskInvocations = 0;
  const workflow = api.smithers(() => (
    <api.Workflow name="sequenced-idem">
      <api.Task id="a" output={api.outputs.out}>
        {async () => {
          const invocation = taskInvocations;
          taskInvocations += 1;
          const gate = Math.min(invocation, 1);
          started[gate].resolve();
          await releases[gate].promise;
          return { value: invocation + 1 };
        }}
      </api.Task>
    </api.Workflow>
  ));
  return {
    workflow,
    started,
    releases,
    taskInvocations: () => taskInvocations,
  };
}

describe("gateway run-id ownership", () => {
  /** @type {Gateway | undefined} */
  let gateway;
  /** @type {string | undefined} */
  let dbPath;

  afterEach(async () => {
    try {
      await gateway?.close?.();
    } catch {}
    if (dbPath) for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
    gateway = undefined;
    dbPath = undefined;
  });

  test("starting a NEW run over an already-active runId is refused with CONFLICT", async () => {
    dbPath = makeDbPath("dup");
    gateway = new Gateway({ heartbeatMs: 1000 });
    gateway.register("idem", createWorkflow(dbPath));
    // A run is already live under this id (seeded to avoid a launch race).
    gateway.activeRuns.set("shared-id", { workflowKey: "idem" });
    await expect(gateway.startRun("idem", {}, AUTH, "shared-id", { resume: false })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    // The original record is intact — the guard fired before clobbering it.
    expect(gateway.activeRuns.get("shared-id")).toEqual({ workflowKey: "idem" });
  });

  test("resume is exempt from the guard (does not throw CONFLICT)", async () => {
    dbPath = makeDbPath("resume");
    gateway = new Gateway({ heartbeatMs: 1000 });
    gateway.register("idem", createWorkflow(dbPath));
    gateway.activeRuns.set("resume-id", { workflowKey: "idem" });
    let err;
    try {
      await gateway.startRun("idem", {}, AUTH, "resume-id", { resume: true });
    } catch (e) {
      err = e;
    }
    expect(err?.code).not.toBe("CONFLICT");
  });

  test("distinct runIds start independently", async () => {
    dbPath = makeDbPath("distinct");
    gateway = new Gateway({ heartbeatMs: 1000 });
    gateway.register("idem", createWorkflow(dbPath));
    const a = await gateway.startRun("idem", {}, AUTH, "run-a", { resume: false });
    const b = await gateway.startRun("idem", {}, AUTH, "run-b", { resume: false });
    expect(a.runId).toBe("run-a");
    expect(b.runId).toBe("run-b");
  });

  test("concurrent resume requests share one adapter lookup and one engine start", async () => {
    dbPath = makeDbPath("concurrent-resume");
    const sequenced = createSequencedWorkflow(dbPath);
    gateway = new Gateway({ heartbeatMs: 1000 });
    gateway.register("idem", sequenced.workflow);
    const runId = "concurrent-resume-id";

    await gateway.startRun("idem", {}, AUTH, runId, { resume: false });
    await sequenced.started[0].promise;
    const initialInflight = gateway.inflightRuns.get(runId);
    expect(initialInflight).toBeDefined();
    sequenced.releases[0].resolve();
    await initialInflight;

    const adapter = gateway.adapterForWorkflow(sequenced.workflow);
    const retried = await retryTask(adapter, {
      runId,
      nodeId: "a",
      iteration: 0,
      resetDependents: true,
    });
    expect(retried.success).toBe(true);

    const lookupStarted = deferred();
    const releaseLookup = deferred();
    let lookupCalls = 0;
    const yieldingAdapter = {
      async getRun(id) {
        lookupCalls += 1;
        lookupStarted.resolve();
        await releaseLookup.promise;
        return adapter.getRun(id);
      },
    };

    const originalStartRun = gateway.startRun.bind(gateway);
    let resumeStarts = 0;
    gateway.startRun = (...args) => {
      resumeStarts += 1;
      return originalStartRun(...args);
    };

    const resumes = Array.from({ length: 8 }, () => gateway.resumeRunIfNeeded(runId, "idem", yieldingAdapter, AUTH));
    await lookupStarted.promise;
    const lookupCallsWhileYielded = lookupCalls;
    releaseLookup.resolve();
    const outcomes = await Promise.allSettled(resumes);
    await sequenced.started[1].promise;
    // Registration is async now (the run's visibility stamp persists before
    // activeRuns registration), so capture the controller once the resumed
    // workflow has demonstrably started rather than at startRun call time.
    const resumedAbort = gateway.activeRuns.get(runId)?.abort;
    const resumedInflight = gateway.inflightRuns.get(runId);

    try {
      expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
      expect(lookupCallsWhileYielded).toBe(1);
      expect(lookupCalls).toBe(1);
      expect(resumeStarts).toBe(1);
      expect(resumedAbort).toBeDefined();
      expect(sequenced.taskInvocations()).toBe(2);
      expect(gateway.runRegistry.size).toBe(1);
      expect(gateway.activeRuns.size).toBe(1);
      expect(gateway.inflightRuns.size).toBe(1);
      expect(gateway.runRegistry.get(runId)).toBe(gateway.activeRuns.get(runId));
      expect(gateway.activeRuns.get(runId)?.abort).toBe(resumedAbort);
      expect(gateway.inflightResumes.has(runId)).toBe(false);
    } finally {
      sequenced.releases[1].resolve();
      await resumedInflight;
    }
  }, 20_000);

  test("a failed resume gate is cleared so a later attempt can proceed", async () => {
    gateway = new Gateway({ heartbeatMs: 1000 });
    const lookupError = new Error("lookup failed");
    let lookupCalls = 0;
    const adapter = {
      async getRun() {
        lookupCalls += 1;
        if (lookupCalls === 1) throw lookupError;
        return null;
      },
    };

    const outcomes = await Promise.allSettled([
      gateway.resumeRunIfNeeded("retryable-resume", "idem", adapter, AUTH),
      gateway.resumeRunIfNeeded("retryable-resume", "idem", adapter, AUTH),
    ]);
    expect(outcomes).toEqual([
      { status: "rejected", reason: lookupError },
      { status: "rejected", reason: lookupError },
    ]);
    expect(lookupCalls).toBe(1);
    expect(gateway.inflightResumes.has("retryable-resume")).toBe(false);

    await gateway.resumeRunIfNeeded("retryable-resume", "idem", adapter, AUTH);
    expect(lookupCalls).toBe(2);
    expect(gateway.inflightResumes.has("retryable-resume")).toBe(false);
  });

  test("an older settling invocation preserves newer same-run tracking", async () => {
    dbPath = makeDbPath("owned-cleanup-replacement");
    const sequenced = createSequencedWorkflow(dbPath);
    gateway = new Gateway({ heartbeatMs: 1000 });
    gateway.register("idem", sequenced.workflow);
    const runId = "owned-cleanup-replacement-id";

    await gateway.startRun("idem", {}, AUTH, runId, { resume: false });
    await sequenced.started[0].promise;
    const olderRecord = gateway.activeRuns.get(runId);
    const olderInflight = gateway.inflightRuns.get(runId);
    expect(olderRecord).toBeDefined();
    expect(olderInflight).toBeDefined();

    const newerAbort = new AbortController();
    const newerRecord = {
      workflowKey: "idem",
      workflow: sequenced.workflow,
      abort: newerAbort,
      input: { replacement: true },
    };
    const newerInflight = Promise.resolve();
    gateway.runRegistry.set(runId, newerRecord);
    gateway.activeRuns.set(runId, newerRecord);
    gateway.inflightRuns.set(runId, newerInflight);

    sequenced.releases[0].resolve();
    await olderInflight;
    try {
      expect(gateway.runRegistry.get(runId)).toBe(newerRecord);
      expect(gateway.activeRuns.get(runId)).toBe(newerRecord);
      expect(gateway.inflightRuns.get(runId)).toBe(newerInflight);
      expect(newerAbort.signal.aborted).toBe(false);
    } finally {
      gateway.runRegistry.delete(runId);
      gateway.activeRuns.delete(runId);
      gateway.inflightRuns.delete(runId);
    }
  }, 10_000);

  test("ordinary completion removes every entry owned by that invocation", async () => {
    dbPath = makeDbPath("owned-cleanup-complete");
    const sequenced = createSequencedWorkflow(dbPath);
    gateway = new Gateway({ heartbeatMs: 1000 });
    gateway.register("idem", sequenced.workflow);
    const runId = "owned-cleanup-complete-id";

    await gateway.startRun("idem", {}, AUTH, runId, { resume: false });
    await sequenced.started[0].promise;
    const ownedRecord = gateway.activeRuns.get(runId);
    const ownedInflight = gateway.inflightRuns.get(runId);
    expect(gateway.runRegistry.get(runId)).toBe(ownedRecord);
    expect(ownedInflight).toBeDefined();

    sequenced.releases[0].resolve();
    await ownedInflight;
    expect(gateway.runRegistry.has(runId)).toBe(false);
    expect(gateway.activeRuns.has(runId)).toBe(false);
    expect(gateway.inflightRuns.has(runId)).toBe(false);
  }, 10_000);
});
