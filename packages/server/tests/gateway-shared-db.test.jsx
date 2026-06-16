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
  const { smithers, Workflow, Task, outputs } = createSmithers(
    { out: z.object({ value: z.number() }) },
    { dbPath },
  );
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
    const runs = await waitFor(async () => {
      const listed = await gateway.listRunsAcrossWorkflows(50);
      return listed.length >= 3 ? listed : null;
    }) ?? [];

    // Exactly three runs — NOT 9 (3 runs × 3 shared-DB adapters).
    expect(runs.length).toBe(3);
    const keyByRun = new Map(runs.map((r) => [r.runId, r.workflowKey]));
    expect(keyByRun.get("run-alpha")).toBe("alpha");
    expect(keyByRun.get("run-beta")).toBe("beta");
    expect(keyByRun.get("run-gamma")).toBe("gamma");
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
    expect(response.payload.schemaVersion).toBe("0017");
    expect(typeof response.payload.signature).toBe("string");
    expect(typeof response.payload.components._smithers_runs).toBe("string");
  });
});

describe("gateway — resolveRunWorkflowKey precedence", () => {
  test("prefers stored gateway key, then a registered workflowName, then fallback", () => {
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
    expect(
      gateway.resolveRunWorkflowKey({ configJson: "{}", workflowName: "beta" }, registered, "zzz"),
    ).toBe("beta");

    // Unknown workflowName: last-resort fallback (the adapter's first owner).
    expect(
      gateway.resolveRunWorkflowKey({ configJson: "{}", workflowName: "ghost" }, registered, "zzz"),
    ).toBe("zzz");
  });
});
