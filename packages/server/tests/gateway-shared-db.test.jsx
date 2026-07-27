/** @jsxImportSource smithers-orchestrator */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { createSmithers } from "smithers-orchestrator";
import { Gateway } from "../src/gateway.js";

/**
 * Regression coverage for registering MANY workflows that SHARE one SQLite DB on
 * a single gateway (the shape of a whole init pack mounted for UIs). Before the
 * fix, the cross-workflow readers iterated once PER registered workflow against
 * the shared DB, so each run was returned once per adapter and attributed to
 * whichever adapter found it first — duplicated and mis-keyed. The gateway must
 * instead query each DB once and attribute every run to its TRUE workflow.
 */

const AUTH = { triggeredBy: "test", scopes: ["*"], role: "operator", tokenId: null };

/** Poll until `fn()` returns a truthy value or the timeout elapses. */
async function waitFor(fn, timeoutMs = 5000) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function makeDbPath(name) {
  return join(tmpdir(), `smithers-shared-db-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

/** Three workflows built from ONE createSmithers instance — they share `.db`. */
function createSharedDbWorkflows(dbPath) {
  const { smithers, Workflow, Task, outputs } = createSmithers({ out: z.object({ value: z.number() }) }, { dbPath });
  const make = (name) =>
    smithers(() => (
      <Workflow name={name}>
        <Task id="t" output={outputs.out}>
          {{ value: 1 }}
        </Task>
      </Workflow>
    ));
  return { alpha: make("alpha"), beta: make("beta"), gamma: make("gamma") };
}

describe("gateway — many workflows sharing one DB", () => {
  /** @type {Gateway | undefined} */
  let gateway;
  /** @type {string | undefined} */
  let dbPath;

  afterEach(async () => {
    try {
      await gateway?.close?.();
    } catch {}
    if (dbPath) {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
    }
    gateway = undefined;
    dbPath = undefined;
  });

  test("listRuns returns each run once, attributed to its true workflow", async () => {
    dbPath = makeDbPath("list");
    const wf = createSharedDbWorkflows(dbPath);
    gateway = new Gateway({ heartbeatMs: 1000 });
    gateway.register("alpha", wf.alpha);
    gateway.register("beta", wf.beta);
    gateway.register("gamma", wf.gamma);

    await gateway.startRun("alpha", {}, AUTH, "run-alpha", { resume: false });
    await gateway.startRun("beta", {}, AUTH, "run-beta", { resume: false });
    await gateway.startRun("gamma", {}, AUTH, "run-gamma", { resume: false });

    // startRun schedules the run and returns before its row is committed, so
    // poll until all three are listed (dedup means the count tops out at 3, never
    // 9 — if dedup regressed this would settle at 9 and the key assertions fail).
    const runs =
      (await waitFor(async () => {
        const listed = await gateway.listRunsAcrossWorkflows(50);
        return listed.length >= 3 ? listed : null;
      })) ?? [];

    // Exactly three runs — NOT 9 (3 runs × 3 shared-DB adapters).
    expect(runs.length).toBe(3);
    const keyByRun = new Map(runs.map((r) => [r.runId, r.workflowKey]));
    expect(keyByRun.get("run-alpha")).toBe("alpha");
    expect(keyByRun.get("run-beta")).toBe("beta");
    expect(keyByRun.get("run-gamma")).toBe("gamma");

    const filtered = await gateway.listRunsAcrossWorkflows(1, undefined, "beta");
    expect(filtered.map((run) => run.runId)).toEqual(["run-beta"]);

    const response = await gateway.routeRequest(
      { role: "operator", scopes: ["run:read"], userId: "test" },
      { id: "runs", method: "listRuns", params: { filter: { workflow: "beta", limit: 1 } } },
    );
    expect(response.ok).toBe(true);
    expect(response.payload.map((run) => run.runId)).toEqual(["run-beta"]);

    // Server-side pagination: offset skips rows after the newest-first sort,
    // so limit+offset walk the same order the un-paged call returns.
    const newestFirst = await gateway.listRunsAcrossWorkflows(50);
    const paged = await gateway.listRunsAcrossWorkflows(1, undefined, undefined, 1);
    expect(paged.map((run) => run.runId)).toEqual([newestFirst[1].runId]);
    const offsetResponse = await gateway.routeRequest(
      { role: "operator", scopes: ["run:read"], userId: "test" },
      { id: "runs-offset", method: "listRuns", params: { filter: { limit: 2, offset: 1 } } },
    );
    expect(offsetResponse.ok).toBe(true);
    expect(offsetResponse.payload.map((run) => run.runId)).toEqual(newestFirst.slice(1, 3).map((run) => run.runId));
    const badOffset = await gateway.routeRequest(
      { role: "operator", scopes: ["run:read"], userId: "test" },
      { id: "runs-bad-offset", method: "listRuns", params: { filter: { limit: 2, offset: -1 } } },
    );
    expect(badOffset.ok).toBe(false);

    for (const offset of [1.5, "2", Infinity, -1, Number.MAX_SAFE_INTEGER + 1]) {
      const invalid = await gateway.routeRequest(
        { role: "operator", scopes: ["run:read"], userId: "test" },
        { id: `runs-invalid-${String(offset)}`, method: "listRuns", params: { filter: { offset } } },
      );
      expect(invalid.ok).toBe(false);
      expect(invalid.error.code).toBe("INVALID_REQUEST");
    }
    for (const offset of [0, 1, Number.MAX_SAFE_INTEGER]) {
      const valid = await gateway.routeRequest(
        { role: "operator", scopes: ["run:read"], userId: "test" },
        { id: `runs-valid-${offset}`, method: "listRuns", params: { filter: { offset } } },
      );
      expect(valid.ok).toBe(true);
    }
  });

  test("lists a run's direct children and full descendant tree over the public API", async () => {
    dbPath = makeDbPath("descendants");
    const wf = createSharedDbWorkflows(dbPath);
    gateway = new Gateway({ heartbeatMs: 1000 });
    gateway.register("alpha", wf.alpha);
    const adapter = gateway.adapterForWorkflow(wf.alpha);
    const configJson = JSON.stringify({ gatewayWorkflowKey: "alpha", gatewaySystem: false });
    const insert = (runId, parentRunId, createdAtMs) =>
      adapter.insertRun({
        runId,
        parentRunId,
        workflowName: "alpha",
        status: "finished",
        createdAtMs,
        configJson,
      });
    await insert("root", null, 1);
    await insert("child-a", "root", 2);
    await insert("child-b", "root", 3);
    await insert("grandchild", "child-a", 4);

    const children = await gateway.routeRequest(
      { role: "operator", scopes: ["run:read"], userId: "test" },
      { id: "children", method: "listRuns", params: { filter: { parentRunId: "root" } } },
    );
    expect(children.ok).toBe(true);
    expect(children.payload.map((run) => run.runId).sort()).toEqual(["child-a", "child-b"]);

    const descendants = await gateway.routeRequest(
      { role: "operator", scopes: ["run:read"], userId: "test" },
      { id: "descendants", method: "listRunDescendants", params: { runId: "root" } },
    );
    expect(descendants.ok).toBe(true);
    expect(descendants.payload.map((row) => [row.runId, row.parentRunId, row.depth])).toEqual([
      ["root", null, 0],
      ["child-a", "root", 1],
      ["child-b", "root", 1],
      ["grandchild", "child-a", 2],
    ]);
  });

  test("resolveRun attributes a run to its true workflow, not the first adapter", async () => {
    dbPath = makeDbPath("resolve");
    const wf = createSharedDbWorkflows(dbPath);
    gateway = new Gateway({ heartbeatMs: 1000 });
    gateway.register("alpha", wf.alpha);
    gateway.register("beta", wf.beta);
    gateway.register("gamma", wf.gamma);

    await gateway.startRun("beta", {}, AUTH, "only-beta", { resume: false });

    const resolved = await waitFor(() => gateway.resolveRun("only-beta"));
    expect(resolved?.workflowKey).toBe("beta");
  });

  test("pending approvals dedupe descendants and use the child workflow and label", async () => {
    dbPath = makeDbPath("approvals");
    const wf = createSharedDbWorkflows(dbPath);
    gateway = new Gateway({ heartbeatMs: 1000 });
    gateway.register("alpha", wf.alpha);
    gateway.register("beta", wf.beta);
    const adapter = gateway.adapterForWorkflow(wf.alpha);
    const now = Date.now();
    await adapter.insertRun({
      runId: "approval-parent",
      workflowName: "alpha",
      status: "waiting-approval",
      createdAtMs: now - 2,
    });
    await adapter.insertRun({
      runId: "approval-child",
      parentRunId: "approval-parent",
      workflowName: "beta",
      status: "waiting-approval",
      createdAtMs: now - 1,
    });
    await adapter.insertNode({
      runId: "approval-child",
      nodeId: "child-gate",
      iteration: 0,
      state: "waiting-approval",
      updatedAtMs: now,
      outputTable: "",
      label: "Child approval label",
    });
    await adapter.insertOrUpdateApproval({
      runId: "approval-child",
      nodeId: "child-gate",
      iteration: 0,
      status: "requested",
      requestedAtMs: now,
      requestJson: JSON.stringify({}),
    });

    expect(await gateway.listPendingApprovals()).toEqual([
      expect.objectContaining({
        runId: "approval-child",
        workflowKey: "beta",
        nodeId: "child-gate",
        requestTitle: "Child approval label",
      }),
    ]);
  });

  test("pauseRun writes a durable pause request for a running run", async () => {
    dbPath = makeDbPath("pause");
    const wf = createSharedDbWorkflows(dbPath);
    gateway = new Gateway({ heartbeatMs: 1000 });
    gateway.register("alpha", wf.alpha);
    const adapter = gateway.adapterForWorkflow(wf.alpha);
    await adapter.insertRun({
      runId: "pause-me",
      workflowName: "alpha",
      status: "running",
      createdAtMs: Date.now(),
    });

    const response = await gateway.routeRequest(
      { role: "operator", scopes: ["run:write"], userId: "test" },
      { id: "p", method: "pauseRun", params: { runId: "pause-me" } },
    );

    expect(response.ok).toBe(true);
    expect(response.payload.status).toBe("pausing");
    const run = await adapter.getRun("pause-me");
    expect(typeof run.pauseRequestedAtMs).toBe("number");
  });

  test("pauseRun rejects a run that is not currently executing", async () => {
    dbPath = makeDbPath("pause-inactive");
    const wf = createSharedDbWorkflows(dbPath);
    gateway = new Gateway({ heartbeatMs: 1000 });
    gateway.register("alpha", wf.alpha);
    const adapter = gateway.adapterForWorkflow(wf.alpha);
    await adapter.insertRun({
      runId: "finished-run",
      workflowName: "alpha",
      status: "finished",
      createdAtMs: Date.now(),
    });

    const response = await gateway.routeRequest(
      { role: "operator", scopes: ["run:write"], userId: "test" },
      { id: "p", method: "pauseRun", params: { runId: "finished-run" } },
    );

    expect(response.ok).toBe(false);
    expect(response.error?.code ?? response.error).toBe("RUN_NOT_ACTIVE");
  });

  test("cancelRun finalizes a waiting-quota run and its parked work", async () => {
    dbPath = makeDbPath("cancel-quota");
    const wf = createSharedDbWorkflows(dbPath);
    gateway = new Gateway({ heartbeatMs: 1000 });
    gateway.register("alpha", wf.alpha);
    const adapter = gateway.adapterForWorkflow(wf.alpha);
    await adapter.insertRun({
      runId: "quota-run",
      workflowName: "alpha",
      status: "waiting-quota",
      createdAtMs: Date.now(),
      errorJson: JSON.stringify({ resetAtMs: Date.now() + 60_000 }),
    });
    await adapter.insertNode({
      runId: "quota-run",
      nodeId: "agent",
      iteration: 0,
      state: "waiting-quota",
      lastAttempt: 1,
      updatedAtMs: Date.now(),
      outputTable: "",
      label: "Agent",
    });
    await adapter.insertAttempt({
      runId: "quota-run",
      nodeId: "agent",
      iteration: 0,
      attempt: 1,
      state: "waiting-quota",
      startedAtMs: Date.now() - 5_000,
    });

    const response = await gateway.routeRequest(
      { role: "operator", scopes: ["run:write"], userId: "test" },
      { id: "cancel", method: "cancelRun", params: { runId: "quota-run" } },
    );

    expect(response.ok).toBe(true);
    expect(response.payload).toMatchObject({ runId: "quota-run", terminalStatus: "cancelled" });
    expect((await adapter.getRun("quota-run"))?.status).toBe("cancelled");
    expect((await adapter.getNode("quota-run", "agent", 0))?.state).toBe("cancelled");
    expect((await adapter.getAttempt("quota-run", "agent", 0, 1))?.state).toBe("cancelled");
  });

  test("getSchemaSignature exposes the migration head over RPC", async () => {
    dbPath = makeDbPath("schema-signature");
    const wf = createSharedDbWorkflows(dbPath);
    gateway = new Gateway({ heartbeatMs: 1000 });
    gateway.register("alpha", wf.alpha);

    const response = await gateway.routeRequest(
      { role: "operator", scopes: ["run:read"], userId: "test" },
      { id: "schema", method: "getSchemaSignature", params: {} },
    );

    expect(response.ok).toBe(true);
    expect(response.payload.schemaVersion).toBe("0032");
    expect(typeof response.payload.signature).toBe("string");
    expect(typeof response.payload.components._smithers_runs).toBe("string");
  });
});

describe("gateway — resolveRunWorkflowKey precedence", () => {
  test("prefers stored gateway key, then registered names, then recorded path or name", () => {
    const gateway = new Gateway({ heartbeatMs: 1000 });
    const registered = new Set(["alpha", "beta"]);

    // Stored gateway key wins even when workflowName disagrees.
    expect(
      gateway.resolveRunWorkflowKey(
        { configJson: JSON.stringify({ gatewayWorkflowKey: "beta" }), workflowName: "alpha" },
        registered,
        "zzz",
      ),
    ).toBe("beta");

    // No stored key (e.g. a CLI-started run): fall back to a registered workflowName.
    expect(gateway.resolveRunWorkflowKey({ configJson: "{}", workflowName: "beta" }, registered, "zzz")).toBe("beta");

    // Unknown workflowName but a registered entry-file basename: attribute by
    // path. This is the CLI-started run whose workflow crashed before it ever
    // announced a name — its row still records which file it ran.
    expect(
      gateway.resolveRunWorkflowKey(
        { configJson: "{}", workflowName: "workflow", workflowPath: "/ws/.smithers/workflows/beta.tsx" },
        registered,
        "zzz",
      ),
    ).toBe("beta");

    // A registered workflowName still beats the path-derived key.
    expect(
      gateway.resolveRunWorkflowKey(
        { configJson: "{}", workflowName: "alpha", workflowPath: "/ws/.smithers/workflows/beta.tsx" },
        registered,
        "zzz",
      ),
    ).toBe("alpha");

    // An unregistered path still identifies the run's real workflow. Returning
    // the adapter's first registered owner here makes `ui <runId>` silently
    // open a different workflow when this gateway predates the run's workflow.
    expect(
      gateway.resolveRunWorkflowKey(
        { configJson: "{}", workflowName: "ghost", workflowPath: "/elsewhere/ghost-flow.tsx" },
        registered,
        "zzz",
      ),
    ).toBe("ghost-flow");

    // Without path provenance, preserve the stored workflow name rather than
    // attributing the row to an unrelated registered workflow.
    expect(gateway.resolveRunWorkflowKey({ configJson: "{}", workflowName: "ghost" }, registered, "zzz")).toBe("ghost");

    // Rows with no workflow identity at all retain the adapter-owner fallback.
    expect(gateway.resolveRunWorkflowKey({ configJson: "{}" }, registered, "zzz")).toBe("zzz");
  });
});
