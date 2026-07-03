/** @jsxImportSource smithers-orchestrator */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod";
import { Gateway } from "../src/gateway.js";

/**
 * launchRun accepts a client-supplied `params.runId`. Without an idempotency
 * guard, reusing the id of an already-live run overwrites its in-memory record
 * in `runRegistry`/`activeRuns` and orphans the still-running run — its
 * AbortController becomes unreachable, so it can no longer be cancelled or
 * tracked. A non-resume start over an active id must be refused with CONFLICT;
 * resume (which intentionally re-targets an existing run) is exempt.
 */

const AUTH = { triggeredBy: "test", scopes: ["*"], role: "operator", tokenId: null };

function makeDbPath(name) {
  return join(tmpdir(), `smithers-idem-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function createWorkflow(dbPath) {
  const { smithers, Workflow, Task, outputs } = createSmithers(
    { out: z.object({ value: z.number() }) },
    { dbPath },
  );
  return smithers(() => (
    <Workflow name="idem">
      <Task id="a" output={outputs.out}>
        {{ value: 1 }}
      </Task>
    </Workflow>
  ));
}

describe("gateway — launchRun runId idempotency guard", () => {
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
    await expect(
      gateway.startRun("idem", {}, AUTH, "shared-id", { resume: false }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
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
});
