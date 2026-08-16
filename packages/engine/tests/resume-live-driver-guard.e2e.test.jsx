/** @jsxImportSource smthrs */
import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { runWorkflow, Timer, Workflow } from "smthrs";
import { SmithersDb } from "@smthrs/db/adapter";
import { formatRuntimeOwnerId } from "@smthrs/db/runtime-owner";
import { nowMs } from "@smthrs/scheduler/nowMs";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";

// Issue #1056: attaching a second engine to a run whose driver is still alive
// splits scheduling in two and races run/attempt writes. The engine must refuse
// on EVIDENCE of a live driver, `force` must not be enough to get past it, and
// the refusal must leave the row exactly as it found it.
//
// Real backends and real OS processes throughout: the "other driver" is an
// actual child process, and liveness is decided by the real process table.

/** @type {Array<import("node:child_process").ChildProcess>} */
const spawned = [];
afterEach(() => {
  for (const child of spawned.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
});

function spawnLiveDriver() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  spawned.push(child);
  return child;
}

async function spawnDeadDriver() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  await new Promise((resolve) => child.once("exit", resolve));
  return pid;
}

function writeWorkflowFile(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const workflowPath = join(dir, "workflow.tsx");
  writeFileSync(workflowPath, "export default 'v1';\n", "utf8");
  return { dir, workflowPath };
}

/**
 * Park a real run at a timer, then rewrite its row to look like a run being
 * driven right now by `ownerPid`.
 */
async function parkRunOwnedBy(adapter, workflow, runId, workflowPath, ownerPid) {
  const first = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId, workflowPath }));
  expect(first.status).toBe("waiting-timer");
  const runtimeOwnerId = formatRuntimeOwnerId(ownerPid, hostname(), "other-driver");
  const heartbeatAtMs = nowMs();
  await Effect.runPromise(adapter.updateRun(runId, { status: "running", runtimeOwnerId, heartbeatAtMs }));
  return { runtimeOwnerId, heartbeatAtMs };
}

describe("resume refuses a live driver unless ownership is stolen by name (#1056)", () => {
  test("--force does NOT attach to a live driver, and the refusal changes nothing", async () => {
    const { dir, workflowPath } = writeWorkflowFile("smithers-live-driver-force-");
    const { smithers, db, cleanup } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    const runId = "resume-live-driver-force";
    const workflow = smithers(() => (
      <Workflow name="resume-live-driver">
        <Timer id="hold" duration="1h" />
      </Workflow>
    ));
    try {
      const driver = spawnLiveDriver();
      const owned = await parkRunOwnedBy(adapter, workflow, runId, workflowPath, driver.pid);
      const attemptsBefore = await adapter.listAttempts(runId, "hold", 0);

      const blocked = await Effect.runPromise(
        runWorkflow(workflow, { input: {}, runId, resume: true, force: true, workflowPath }),
      );
      expect(blocked.status).toBe("failed");
      expect(blocked.error?.code).toBe("RUN_OWNER_ALIVE");
      expect(blocked.error?.message).toContain("--steal-ownership");

      // Acceptance criterion 2: original owner, run state, and attempts intact.
      const untouched = await adapter.getRun(runId);
      expect(untouched?.status).toBe("running");
      expect(untouched?.runtimeOwnerId).toBe(owned.runtimeOwnerId);
      expect(untouched?.heartbeatAtMs).toBe(owned.heartbeatAtMs);
      expect(await adapter.listAttempts(runId, "hold", 0)).toEqual(attemptsBefore);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      cleanup();
    }
  });

  test("stealOwnership attaches to the same live driver", async () => {
    const { dir, workflowPath } = writeWorkflowFile("smithers-live-driver-steal-");
    const { smithers, db, cleanup } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    const runId = "resume-live-driver-steal";
    const workflow = smithers(() => (
      <Workflow name="resume-live-driver">
        <Timer id="hold" duration="1h" />
      </Workflow>
    ));
    try {
      const driver = spawnLiveDriver();
      await parkRunOwnedBy(adapter, workflow, runId, workflowPath, driver.pid);

      const stolen = await Effect.runPromise(
        runWorkflow(workflow, { input: {}, runId, resume: true, force: true, stealOwnership: true, workflowPath }),
      );
      expect(stolen.error?.code).toBeUndefined();
      expect(stolen.status).toBe("waiting-timer");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      cleanup();
    }
  });

  test("a dead driver still resumes with no extra flag (ordinary crash recovery)", async () => {
    const { dir, workflowPath } = writeWorkflowFile("smithers-live-driver-dead-");
    const { smithers, db, cleanup } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    const runId = "resume-dead-driver";
    const workflow = smithers(() => (
      <Workflow name="resume-live-driver">
        <Timer id="hold" duration="1h" />
      </Workflow>
    ));
    try {
      const deadPid = await spawnDeadDriver();
      // Stale heartbeat as well, exactly as a crashed engine leaves it.
      const first = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId, workflowPath }));
      expect(first.status).toBe("waiting-timer");
      await Effect.runPromise(
        adapter.updateRun(runId, {
          status: "running",
          runtimeOwnerId: formatRuntimeOwnerId(deadPid, hostname(), "crashed-driver"),
          heartbeatAtMs: nowMs() - 120_000,
        }),
      );

      const recovered = await Effect.runPromise(
        runWorkflow(workflow, { input: {}, runId, resume: true, workflowPath }),
      );
      expect(recovered.error?.code).toBeUndefined();
      expect(recovered.status).toBe("waiting-timer");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      cleanup();
    }
  });

  test("a heartbeating owner on another host is refused: its pid is not ours to probe", async () => {
    const { dir, workflowPath } = writeWorkflowFile("smithers-live-driver-remote-");
    const { smithers, db, cleanup } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    const runId = "resume-remote-owner";
    const workflow = smithers(() => (
      <Workflow name="resume-live-driver">
        <Timer id="hold" duration="1h" />
      </Workflow>
    ));
    try {
      const first = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId, workflowPath }));
      expect(first.status).toBe("waiting-timer");
      // A dead LOCAL pid number, but the owner lives on another host: only the
      // durable heartbeat can speak for it, so a local probe must not "clear" it.
      const deadPid = await spawnDeadDriver();
      const runtimeOwnerId = formatRuntimeOwnerId(deadPid, `${hostname()}.remote`, "elsewhere");
      const heartbeatAtMs = nowMs();
      await Effect.runPromise(adapter.updateRun(runId, { status: "running", runtimeOwnerId, heartbeatAtMs }));

      const blocked = await Effect.runPromise(
        runWorkflow(workflow, { input: {}, runId, resume: true, force: true, workflowPath }),
      );
      expect(blocked.status).toBe("failed");
      expect(blocked.error?.code).toBe("RUN_OWNER_ALIVE");
      const untouched = await adapter.getRun(runId);
      expect(untouched?.runtimeOwnerId).toBe(runtimeOwnerId);
      expect(untouched?.heartbeatAtMs).toBe(heartbeatAtMs);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      cleanup();
    }
  });

  test("a held durable resume claim blocks a second resumer, but its own holder passes", async () => {
    const { dir, workflowPath } = writeWorkflowFile("smithers-live-driver-claim-");
    const { smithers, db, cleanup } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    const runId = "resume-claim-held";
    const workflow = smithers(() => (
      <Workflow name="resume-live-driver">
        <Timer id="hold" duration="1h" />
      </Workflow>
    ));
    try {
      const first = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId, workflowPath }));
      expect(first.status).toBe("waiting-timer");
      const claimOwnerId = `cli-resume:${process.pid}:${nowMs()}`;
      const claimHeartbeatAtMs = nowMs();
      await Effect.runPromise(
        adapter.updateRun(runId, { runtimeOwnerId: claimOwnerId, heartbeatAtMs: claimHeartbeatAtMs }),
      );

      const outsider = await Effect.runPromise(
        runWorkflow(workflow, { input: {}, runId, resume: true, force: true, workflowPath }),
      );
      expect(outsider.status).toBe("failed");
      expect(outsider.error?.code).toBe("RUN_OWNER_ALIVE");
      const untouched = await adapter.getRun(runId);
      expect(untouched?.runtimeOwnerId).toBe(claimOwnerId);
      expect(untouched?.heartbeatAtMs).toBe(claimHeartbeatAtMs);

      // The process that WAS handed the claim is the owner, not a second
      // engine, so the handoff must still work.
      const holder = await Effect.runPromise(
        runWorkflow(workflow, {
          input: {},
          runId,
          resume: true,
          workflowPath,
          resumeClaim: { claimOwnerId, claimHeartbeatAtMs },
        }),
      );
      expect(holder.error?.code).toBeUndefined();
      expect(holder.status).toBe("waiting-timer");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      cleanup();
    }
  });
});
