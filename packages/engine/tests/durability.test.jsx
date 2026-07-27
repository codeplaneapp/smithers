/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventBus } from "../src/events.js";
import { Task } from "../../components/src/components/Task.js";
import { Timer } from "../../components/src/components/Timer.js";
import { Workflow } from "../../components/src/components/Workflow.js";
import { runWorkflow } from "../src/engine.js";
import { readWorkflowEntryHash, readWorkflowGraphHash } from "../src/workflow-hash.js";
import { retryTask } from "../../time-travel/src/retry-task.js";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { nowMs } from "@smithers-orchestrator/scheduler/nowMs";
import { createTestDb, createTestSmithers, sleep } from "../../smithers/tests/helpers.js";
import { ddl, outputSchemas, schema } from "../../smithers/tests/schema.js";
import { Effect } from "effect";
describe("Durability", () => {
  /**
   * @param {() => Promise<boolean>} predicate
   * @param {{ timeoutMs?: number; intervalMs?: number }} [options]
   */
  async function waitFor(predicate, options) {
    const timeoutMs = options?.timeoutMs ?? 5_000;
    const intervalMs = options?.intervalMs ?? 50;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (await predicate()) return;
      } catch {}
      await sleep(intervalMs);
    }
    throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
  }
  test("persists streamed NodeOutput events to SQLite", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
    const runId = "durable-node-output";
    const noisyAgent = {
      id: "noisy",
      tools: {},
      generate: async (args) => {
        args.onStdout?.("hello stdout");
        args.onStderr?.("hello stderr");
        return { output: { value: 1 } };
      },
    };
    const workflow = smithers(() => (
      <Workflow name="durable-output">
        <Task id="task" output={outputs.outputA} agent={noisyAgent}>
          run noisy task
        </Task>
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
    expect(result.status).toBe("finished");
    const adapter = new SmithersDb(db);
    const events = await adapter.listEvents(runId, -1, 50);
    const nodeOutputs = events.filter((event) => event.type === "NodeOutput");
    expect(nodeOutputs.length).toBe(2);
    expect(JSON.parse(nodeOutputs[0].payloadJson).text).toContain("hello");
    expect(JSON.parse(nodeOutputs[1].payloadJson).text).toContain("hello");
    cleanup();
  });
  test("log file failures do not break SQLite event persistence", async () => {
    const { db, cleanup } = createTestDb(schema, ddl);
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);
    const dir = mkdtempSync(join(tmpdir(), "smithers-eventbus-"));
    const badLogDir = join(dir, "stream.ndjson");
    writeFileSync(badLogDir, "not a directory", "utf8");
    const bus = new EventBus({
      db: adapter,
      logDir: badLogDir,
    });
    await Effect.runPromise(
      bus.emitEventWithPersist({
        type: "RunStarted",
        runId: "eventbus-run",
        timestampMs: 1,
      }),
    );
    const events = await adapter.listEvents("eventbus-run", -1, 10);
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("RunStarted");
    rmSync(dir, { recursive: true, force: true });
    cleanup();
  });
  test("persistent cancel requests abort active runs", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    const runId = "persistent-cancel";
    const slowAbortableAgent = {
      id: "slow-abortable",
      tools: {},
      generate: async (args) => {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 2_000);
          const abort = () => {
            clearTimeout(timer);
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          };
          if (args.abortSignal?.aborted) {
            abort();
            return;
          }
          args.abortSignal?.addEventListener("abort", abort, { once: true });
        });
        return { output: { value: 1 } };
      },
    };
    const workflow = smithers(() => (
      <Workflow name="persistent-cancel">
        <Task id="slow" output={outputs.outputA} agent={slowAbortableAgent}>
          run slow task
        </Task>
      </Workflow>
    ));
    const runPromise = Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
    await waitFor(
      async () => {
        try {
          return Boolean(await adapter.getRun(runId));
        } catch {
          return false;
        }
      },
      { timeoutMs: 5_000, intervalMs: 10 },
    );
    await adapter.requestRunCancel(runId, nowMs());
    const result = await runPromise;
    expect(result.status).toBe("cancelled");
    const run = await adapter.getRun(runId);
    expect(run?.status).toBe("cancelled");
    expect(run?.runtimeOwnerId).toBeNull();
    cleanup();
  });
  test("resume fails when workflow file contents changed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-resume-metadata-"));
    const workflowPath = join(dir, "workflow.tsx");
    writeFileSync(workflowPath, "export default 'v1';\n", "utf8");
    const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
    const runId = "resume-metadata";
    const workflow = smithers(() => (
      <Workflow name="resume-metadata">
        <Task id="task" output={outputs.outputA}>
          {{ value: 1 }}
        </Task>
      </Workflow>
    ));
    const first = await Effect.runPromise(
      runWorkflow(workflow, {
        input: {},
        runId,
        workflowPath,
      }),
    );
    expect(first.status).toBe("finished");
    writeFileSync(workflowPath, "export default 'v2';\n", "utf8");
    const resumed = await Effect.runPromise(
      runWorkflow(workflow, {
        input: {},
        runId,
        resume: true,
        workflowPath,
      }),
    );
    expect(resumed.status).toBe("failed");
    expect(resumed.error?.code).toBe("RESUME_METADATA_MISMATCH");
    const adapter = new SmithersDb(db);
    const run = await adapter.getRun(runId);
    expect(run?.status).toBe("finished");
    rmSync(dir, { recursive: true, force: true });
    cleanup();
  });
  test("resume fails when an imported workflow module changed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-resume-graph-"));
    const workflowPath = join(dir, "workflow.tsx");
    const helperPath = join(dir, "helper.ts");
    writeFileSync(helperPath, "export const version = 'v1';\n", "utf8");
    writeFileSync(workflowPath, "import { version } from './helper';\nexport default version;\n", "utf8");
    const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
    const runId = "resume-graph-metadata";
    const workflow = smithers(() => (
      <Workflow name="resume-graph-metadata">
        <Task id="task" output={outputs.outputA}>
          {{ value: 1 }}
        </Task>
      </Workflow>
    ));
    const first = await Effect.runPromise(
      runWorkflow(workflow, {
        input: {},
        runId,
        workflowPath,
      }),
    );
    expect(first.status).toBe("finished");
    writeFileSync(helperPath, "export const version = 'v2';\n", "utf8");
    const resumed = await Effect.runPromise(
      runWorkflow(workflow, {
        input: {},
        runId,
        resume: true,
        workflowPath,
      }),
    );
    expect(resumed.status).toBe("failed");
    expect(resumed.error?.code).toBe("RESUME_METADATA_MISMATCH");
    const adapter = new SmithersDb(db);
    const run = await adapter.getRun(runId);
    expect(run?.status).toBe("finished");
    rmSync(dir, { recursive: true, force: true });
    cleanup();
  });
  test("acceptWorkflowChange resumes the same run and re-stamps current workflow hashes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-accept-workflow-change-"));
    const workflowPath = join(dir, "workflow.tsx");
    writeFileSync(workflowPath, "export default 'v1';\n", "utf8");
    const { smithers, db, cleanup } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    const runId = "accept-workflow-change-same-run";
    const workflow = smithers(() => (
      <Workflow name="accept-workflow-change">
        <Timer id="hold" duration="1h" />
      </Workflow>
    ));
    try {
      const first = await Effect.runPromise(
        runWorkflow(workflow, {
          input: {},
          runId,
          workflowPath,
        }),
      );
      expect(first.status).toBe("waiting-timer");
      const before = await adapter.getRun(runId);

      writeFileSync(workflowPath, "export default 'v2';\n", "utf8");
      const rejected = await Effect.runPromise(
        runWorkflow(workflow, {
          input: {},
          runId,
          resume: true,
          workflowPath,
        }),
      );
      expect(rejected.status).toBe("failed");
      expect(rejected.error?.code).toBe("RESUME_METADATA_MISMATCH");
      expect((await adapter.getRun(runId))?.workflowHash).toBe(before?.workflowHash);

      const accepted = await Effect.runPromise(
        runWorkflow(workflow, {
          input: {},
          runId,
          resume: true,
          workflowPath,
          acceptWorkflowChange: true,
        }),
      );
      expect(accepted.runId).toBe(runId);
      expect(accepted.status).toBe("waiting-timer");

      const currentWorkflowHash = await readWorkflowGraphHash(workflowPath);
      const currentEntryHash = await readWorkflowEntryHash(workflowPath);
      const restamped = await adapter.getRun(runId);
      expect(restamped?.workflowHash).toBe(currentWorkflowHash);
      const durability = Object.values(JSON.parse(restamped?.configJson ?? "{}")).find(
        (value) => value && typeof value === "object" && "entryWorkflowHash" in value,
      );
      expect(durability?.entryWorkflowHash).toBe(currentEntryHash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      cleanup();
    }
  });
  test("acceptWorkflowChange permits a workflow name edit", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    const runId = "accept-workflow-name-change";
    let calls = 0;
    const task = () => {
      calls += 1;
      if (calls === 1) throw new Error("first attempt fails");
      return { value: 1 };
    };
    const original = smithers(() => (
      <Workflow name="workflow-name-before">
        <Task id="task" output={outputs.outputA} retries={0}>
          {task}
        </Task>
      </Workflow>
    ));
    const renamed = smithers(() => (
      <Workflow name="workflow-name-after">
        <Task id="task" output={outputs.outputA} retries={0}>
          {task}
        </Task>
      </Workflow>
    ));
    try {
      expect((await Effect.runPromise(runWorkflow(original, { input: {}, runId }))).status).toBe("failed");
      expect((await retryTask(adapter, { runId, nodeId: "task" })).success).toBe(true);
      const resumed = await Effect.runPromise(
        runWorkflow(renamed, {
          input: {},
          runId,
          resume: true,
          acceptWorkflowChange: true,
        }),
      );
      expect(resumed.status).toBe("finished");
      expect(calls).toBe(2);
      expect((await adapter.getRun(runId))?.workflowName).toBe("workflow-name-after");
    } finally {
      cleanup();
    }
  });
  test("workflow-name mismatch rejects a foreign graph without erasing the original failure", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    const runId = "resume-legitimate-workflow-name";
    let foreignCalls = 0;
    const original = smithers(() => (
      <Workflow name="workflow">
        <Task id="original" output={outputs.outputA} retries={0}>
          {() => {
            throw new Error("original failure must survive");
          }}
        </Task>
      </Workflow>
    ));
    const foreign = smithers(() => (
      <Workflow name="foreign-workflow">
        <Task id="foreign" output={outputs.outputA} retries={0}>
          {() => {
            foreignCalls += 1;
            return { value: 1 };
          }}
        </Task>
      </Workflow>
    ));
    try {
      expect((await Effect.runPromise(runWorkflow(original, { input: {}, runId }))).status).toBe("failed");
      const before = await adapter.getRun(runId);
      const resumed = await Effect.runPromise(runWorkflow(foreign, { input: {}, runId, resume: true }));
      const after = await adapter.getRun(runId);

      expect(resumed.status).toBe("failed");
      expect(resumed.error?.code).toBe("RESUME_METADATA_MISMATCH");
      expect(resumed.error?.details).toMatchObject({
        mismatches: ["workflow name changed"],
        existing: { workflowName: "workflow" },
        current: { workflowName: "foreign-workflow" },
      });
      expect(foreignCalls).toBe(0);
      expect(after?.workflowName).toBe("workflow");
      expect(after?.status).toBe("failed");
      expect(after?.errorJson).toBe(before?.errorJson);
      expect(after?.errorJson).toContain("original failure must survive");
    } finally {
      cleanup();
    }
  });
  test("resume stamps a placeholder workflow name when graph extraction previously failed", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    const runId = "resume-unstamped-workflow-name";
    let graphAvailable = false;
    const workflow = smithers(() => {
      if (!graphAvailable) throw new Error("graph extraction failed before workflow name stamping");
      return (
        <Workflow name="actual-workflow-name">
          <Task id="task" output={outputs.outputA}>
            {() => ({ value: 1 })}
          </Task>
        </Workflow>
      );
    });
    try {
      expect((await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }))).status).toBe("failed");
      expect((await adapter.getRun(runId))?.workflowName).toBe("workflow");
      expect(await adapter.listNodes(runId)).toEqual([]);

      graphAvailable = true;
      const resumed = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId, resume: true }));
      const resumedRun = await adapter.getRun(runId);

      expect(resumed.status, JSON.stringify({ resumed, resumedRun })).toBe("finished");
      expect(resumedRun?.workflowName).toBe("actual-workflow-name");
      expect((await adapter.getNode(runId, "task", 0))?.state).toBe("finished");
    } finally {
      cleanup();
    }
  });
  test("supervised timer resume mismatch fails the parked run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-timer-resume-metadata-"));
    const workflowPath = join(dir, "workflow.tsx");
    writeFileSync(workflowPath, "export default 'v1';\n", "utf8");
    const { smithers, db, cleanup } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    const runId = "timer-resume-metadata";
    const workflow = smithers(() => (
      <Workflow name="timer-resume-metadata">
        <Timer id="hold" duration="1h" />
      </Workflow>
    ));
    const first = await Effect.runPromise(
      runWorkflow(workflow, {
        input: {},
        runId,
        workflowPath,
      }),
    );
    expect(first.status).toBe("waiting-timer");
    const claimOwnerId = "supervisor:timer-test";
    const claimHeartbeatAtMs = nowMs();
    const claimed = await adapter.claimRunForResume({
      runId,
      expectedStatus: "waiting-timer",
      expectedRuntimeOwnerId: null,
      expectedHeartbeatAtMs: null,
      staleBeforeMs: claimHeartbeatAtMs,
      claimOwnerId,
      claimHeartbeatAtMs,
      requireStale: true,
    });
    expect(claimed).toBe(true);
    writeFileSync(workflowPath, "export default 'v2';\n", "utf8");
    const resumed = await Effect.runPromise(
      runWorkflow(workflow, {
        input: {},
        runId,
        resume: true,
        workflowPath,
        resumeClaim: {
          claimOwnerId,
          claimHeartbeatAtMs,
          restoreRuntimeOwnerId: null,
          restoreHeartbeatAtMs: null,
        },
      }),
    );
    expect(resumed.status).toBe("failed");
    expect(resumed.error?.code).toBe("RESUME_METADATA_MISMATCH");
    const run = await adapter.getRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.runtimeOwnerId).toBeNull();
    expect(JSON.parse(run?.errorJson ?? "{}")?.code).toBe("RESUME_METADATA_MISMATCH");
    const node = await adapter.getNode(runId, "hold", 0);
    expect(node?.state).toBe("cancelled");
    const eventTypes = (await adapter.listEvents(runId, -1, 50)).map((event) => event.type);
    expect(eventTypes).toContain("TimerCancelled");
    expect(eventTypes).toContain("NodeCancelled");
    expect(eventTypes).toContain("RunFailed");
    rmSync(dir, { recursive: true, force: true });
    cleanup();
  });
  test("supervised resume mismatch of a stale running run fails the run durably (issue #1361)", async () => {
    // Before the unattended-mismatch fail covered every resumable status,
    // this scenario hot-looped forever: the mismatch threw inside the
    // supervisor's invisible detached child, the claim release restored
    // the stale heartbeat, and the next poll re-claimed the run.
    const dir = mkdtempSync(join(tmpdir(), "smithers-running-resume-metadata-"));
    const workflowPath = join(dir, "workflow.tsx");
    writeFileSync(workflowPath, "export default 'v1';\n", "utf8");
    const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    const runId = "running-resume-metadata";
    const workflow = smithers(() => (
      <Workflow name="running-resume-metadata">
        <Task id="task" output={outputs.outputA}>
          {{ value: 1 }}
        </Task>
      </Workflow>
    ));
    const first = await Effect.runPromise(
      runWorkflow(workflow, {
        input: {},
        runId,
        workflowPath,
      }),
    );
    expect(first.status).toBe("finished");
    // Recreate the wild state: engine process died mid-run, leaving the
    // run `running` with a stale heartbeat and a dead owner pid.
    const staleHeartbeatAtMs = nowMs() - 120_000;
    await Effect.runPromise(
      adapter.updateRun(runId, {
        status: "running",
        finishedAtMs: null,
        heartbeatAtMs: staleHeartbeatAtMs,
        runtimeOwnerId: "pid:11111:dead-driver",
      }),
    );
    const claimOwnerId = "supervisor:running-test";
    const claimHeartbeatAtMs = nowMs();
    const claimed = await adapter.claimRunForResume({
      runId,
      expectedStatus: "running",
      expectedRuntimeOwnerId: "pid:11111:dead-driver",
      expectedHeartbeatAtMs: staleHeartbeatAtMs,
      staleBeforeMs: claimHeartbeatAtMs,
      claimOwnerId,
      claimHeartbeatAtMs,
      requireStale: true,
    });
    expect(claimed).toBe(true);
    writeFileSync(workflowPath, "export default 'v2';\n", "utf8");
    const resumed = await Effect.runPromise(
      runWorkflow(workflow, {
        input: {},
        runId,
        resume: true,
        workflowPath,
        resumeClaim: {
          claimOwnerId,
          claimHeartbeatAtMs,
          restoreRuntimeOwnerId: "pid:11111:dead-driver",
          restoreHeartbeatAtMs: staleHeartbeatAtMs,
        },
      }),
    );
    expect(resumed.status).toBe("failed");
    expect(resumed.error?.code).toBe("RESUME_METADATA_MISMATCH");
    const run = await adapter.getRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.runtimeOwnerId).toBeNull();
    expect(JSON.parse(run?.errorJson ?? "{}")?.code).toBe("RESUME_METADATA_MISMATCH");
    const eventTypes = (await adapter.listEvents(runId, -1, 50)).map((event) => event.type);
    expect(eventTypes).toContain("RunFailed");
    rmSync(dir, { recursive: true, force: true });
    cleanup();
  });
  test("gateway timer-sweep resume mismatch fails the parked run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-gateway-timer-resume-metadata-"));
    const workflowPath = join(dir, "workflow.tsx");
    writeFileSync(workflowPath, "export default 'v1';\n", "utf8");
    const { smithers, db, cleanup } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    const runId = "gateway-timer-resume-metadata";
    const workflow = smithers(() => (
      <Workflow name="gateway-timer-resume-metadata">
        <Timer id="hold" duration="1h" />
      </Workflow>
    ));
    const first = await Effect.runPromise(
      runWorkflow(workflow, {
        input: {},
        runId,
        workflowPath,
      }),
    );
    expect(first.status).toBe("waiting-timer");
    // The gateway timer sweep (packages/server/src/gateway.js processDueTimers ->
    // resumeRunIfNeeded -> startRun) resumes with NO resumeClaim, only
    // config.gatewayTriggeredBy === "timer:gateway". A source change since the
    // run parked must fail it loudly rather than leave it on `waiting-timer` for
    // the default-active sweep to re-drive forever (issue #494).
    writeFileSync(workflowPath, "export default 'v2';\n", "utf8");
    const resumed = await Effect.runPromise(
      runWorkflow(workflow, {
        input: {},
        runId,
        resume: true,
        workflowPath,
        config: { gatewayTriggeredBy: "timer:gateway" },
      }),
    );
    expect(resumed.status).toBe("failed");
    expect(resumed.error?.code).toBe("RESUME_METADATA_MISMATCH");
    const run = await adapter.getRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.runtimeOwnerId).toBeNull();
    expect(JSON.parse(run?.errorJson ?? "{}")?.code).toBe("RESUME_METADATA_MISMATCH");
    const node = await adapter.getNode(runId, "hold", 0);
    expect(node?.state).toBe("cancelled");
    const eventTypes = (await adapter.listEvents(runId, -1, 50)).map((event) => event.type);
    expect(eventTypes).toContain("TimerCancelled");
    expect(eventTypes).toContain("NodeCancelled");
    expect(eventTypes).toContain("RunFailed");
    rmSync(dir, { recursive: true, force: true });
    cleanup();
  });
});
