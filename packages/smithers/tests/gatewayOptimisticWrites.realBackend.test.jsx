/** @jsxImportSource smithers-orchestrator */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createSmithers } from "../src/create.js";
import { Gateway } from "@smithers-orchestrator/server/gateway";
import { createGatewaySyncSource } from "@smithers-orchestrator/gateway-client";
import { createGatewayCollections } from "@smithers-orchestrator/gateway-react";

/**
 * Real-backend coverage for the unified optimistic-write path (milestone 5).
 *
 * No fakes: a real `Gateway` over a real `SmithersDb` (bun:sqlite), the real
 * `createGatewaySyncSource` transport seam, and the real
 * `createGatewayCollections` registry. The only glue is a `SyncTransport` that
 * forwards to `gateway.routeRequest` — the same RPC dispatch the WS/HTTP
 * transports drive. A real `launchRun` actually starts a run and commits a row;
 * `listRuns` reads it back through `SmithersDb`. This exercises the live timing
 * the fake-transport tests cannot: a real gateway returns from `launchRun`
 * before the run row commits, so the optimistic transaction must hold open and
 * poll until the server of record confirms — and the row must stay continuously
 * visible the whole time (no flicker, `$synced` flips false → true on confirm).
 */

setDefaultTimeout(60_000);

const CONNECTION = { userId: "test", scopes: ["*"], role: "operator", tokenId: null };

function makeDbPath(name) {
  return join(tmpdir(), `smithers-optimistic-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

/** A trivial DB-backed workflow registered on the gateway. */
function createWorkflow(dbPath) {
  const { smithers, Workflow, Task, outputs } = createSmithers(
    { out: z.object({ value: z.number().int() }) },
    { dbPath },
  );
  return smithers(() => (
    <Workflow name="deploy">
      <Task id="t" output={outputs.out}>
        {{ value: 1 }}
      </Task>
    </Workflow>
  ));
}

/** A real SyncTransport that dispatches through the gateway's real RPC router. */
function gatewayTransport(gateway) {
  let seq = 0;
  return {
    async rpc(method, params) {
      const response = await gateway.routeRequest(CONNECTION, {
        id: `rpc-${(seq += 1)}`,
        method,
        params: params ?? {},
      });
      if (!response || response.ok === false) {
        throw new Error(response?.error?.message ?? response?.error?.code ?? `rpc ${method} failed`);
      }
      return response.payload;
    },
  };
}

function makeRegistry(gateway) {
  const source = createGatewaySyncSource({ transport: gatewayTransport(gateway) });
  return createGatewayCollections({ source });
}

async function waitFor(predicate, timeoutMs = 30_000) {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) {
      expect(await predicate()).toBe(true);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("optimistic writes over a real gateway + SmithersDb", () => {
  /** @type {Gateway | undefined} */
  let gateway;
  /** @type {string | undefined} */
  let dbPath;

  afterEach(async () => {
    try {
      await gateway?.close?.();
    } catch {}
    if (dbPath) {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
    }
    gateway = undefined;
    dbPath = undefined;
  });

  test("launchRun stays visible until the real gateway confirms it, then flips $synced", async () => {
    dbPath = makeDbPath("launch");
    gateway = new Gateway({ heartbeatMs: 1000 });
    gateway.register("deploy", createWorkflow(dbPath));
    const registry = makeRegistry(gateway);

    const runs = registry.runs();
    await runs.preload();
    expect(runs.size).toBe(0);

    const runId = "opt-run-1";
    // Record every change to the runs collection. A "delete" for our key between
    // the optimistic insert and the synced confirm is the flicker the reviewer
    // found — with the fix the row is only ever inserted then updated.
    const changes = [];
    const subscription = runs.subscribeChanges((batch) => {
      for (const change of batch) changes.push({ type: change.type, key: change.key, synced: change.value?.$synced });
    });

    const pending = registry.optimisticMutation({
      method: "launchRun",
      vars: { workflow: "deploy", input: {}, options: { runId } },
      commit: (vars) => registry.rpc("launchRun", vars),
    });
    expect(pending).toBeDefined();

    // Instant optimistic state: visible synchronously, unconfirmed.
    const optimistic = runs.get(runId);
    expect(optimistic).toBeDefined();
    expect(optimistic.$synced).toBe(false);
    expect(optimistic.status).toBe("queued");
    // The mutation must NOT resolve before the gateway confirms the write.
    let resolved = false;
    void pending.then(() => {
      resolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolved).toBe(false);
    expect(runs.has(runId)).toBe(true);

    await pending;
    subscription.unsubscribe();

    // Confirmed: still present, now synced.
    expect(runs.has(runId)).toBe(true);
    const confirmed = runs.get(runId);
    expect(confirmed.$synced).toBe(true);

    // No flicker: our key was inserted, never deleted before confirmation.
    const ours = changes.filter((change) => change.key === runId);
    expect(ours.length).toBeGreaterThan(0);
    expect(ours[0].type).toBe("insert");
    expect(ours.some((change) => change.type === "delete")).toBe(false);
    expect(ours[ours.length - 1].synced).toBe(true);

    // The run really exists on the server of record.
    const listed = await registry.rpc("listRuns", {});
    expect(Array.isArray(listed) && listed.some((row) => row.runId === runId)).toBe(true);
  });

  test("a rejected launchRun rolls the optimistic run back", async () => {
    dbPath = makeDbPath("rollback");
    gateway = new Gateway({ heartbeatMs: 1000 });
    gateway.register("deploy", createWorkflow(dbPath));
    const registry = makeRegistry(gateway);

    const runs = registry.runs();
    await runs.preload();

    const runId = "opt-run-rollback";
    const pending = registry.optimisticMutation({
      // An unregistered workflow makes the real gateway reject with NOT_FOUND.
      method: "launchRun",
      vars: { workflow: "does-not-exist", input: {}, options: { runId } },
      commit: (vars) => registry.rpc("launchRun", vars),
    });

    // Optimistic row is visible immediately…
    expect(runs.get(runId)?.$synced).toBe(false);

    await expect(pending).rejects.toBeInstanceOf(Error);

    // …then rolled back once the gateway rejects.
    expect(runs.has(runId)).toBe(false);
  });
});
