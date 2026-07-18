/** @jsxImportSource smithers-orchestrator */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { createSmithers } from "smithers-orchestrator";
import { Gateway } from "../src/gateway.js";

const AUTH = { triggeredBy: "test", scopes: ["*"], role: "operator", tokenId: null };
const CONNECTION = { role: "operator", scopes: ["run:read"], userId: "test" };

function pathForTest() { return join(tmpdir(), `smithers-list-summary-${Date.now()}-${Math.random().toString(36).slice(2)}.db`); }
async function eventually(read) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return undefined;
}
function workflow(dbPath, name) {
  const { smithers, Workflow, Task, outputs } = createSmithers({ out: z.object({ ok: z.boolean() }) }, { dbPath });
  return smithers(() => <Workflow name={name}><Task id="task" output={outputs.out}>{{ ok: true }}</Task></Workflow>);
}

describe("gateway listRuns node summaries", () => {
  let gateway;
  let dbPath;
  afterEach(async () => {
    await gateway?.close?.();
    if (dbPath) for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
  });

  test("listRuns RPC carries the same state-count summary as getRun, once per shared adapter", async () => {
    dbPath = pathForTest();
    gateway = new Gateway({ heartbeatMs: 1000 });
    const alpha = workflow(dbPath, "alpha");
    const beta = workflow(dbPath, "beta");
    gateway.register("alpha", alpha);
    gateway.register("beta", beta);
    await gateway.startRun("alpha", {}, AUTH, "summary-run", { resume: false });
    const resolved = await eventually(async () => {
      const candidate = await gateway.resolveRun("summary-run");
      return candidate && await candidate.adapter.getRun("summary-run") ? candidate : undefined;
    });
    expect(resolved).toBeDefined();
    await resolved.adapter.insertNode({ runId: "summary-run", nodeId: "failed-extra", iteration: 0, state: "failed", updatedAtMs: Date.now(), outputTable: "out", label: null });
    const original = resolved.adapter.countNodesByStateForRuns.bind(resolved.adapter);
    let calls = 0;
    resolved.adapter.countNodesByStateForRuns = async (ids) => { calls += 1; return original(ids); };

    const listedResponse = await gateway.routeRequest(CONNECTION, { id: "list", method: "listRuns", params: { filter: { limit: 10 } } });
    const getResponse = await gateway.routeRequest(CONNECTION, { id: "get", method: "getRun", params: { runId: "summary-run" } });
    expect(listedResponse.ok).toBe(true);
    expect(getResponse.ok).toBe(true);
    const listed = listedResponse.payload.find((row) => row.runId === "summary-run");
    expect(listed.summary).toEqual(getResponse.payload.summary);
    expect(listed.summary.failed).toBe(1);
    expect(calls).toBe(1);
  });

  test("older or failing adapters degrade to summary-less list rows", async () => {
    dbPath = pathForTest();
    gateway = new Gateway({ heartbeatMs: 1000 });
    const run = workflow(dbPath, "alpha");
    gateway.register("alpha", run);
    await gateway.startRun("alpha", {}, AUTH, "degrade-run", { resume: false });
    const resolved = await eventually(async () => {
      const candidate = await gateway.resolveRun("degrade-run");
      return candidate && await candidate.adapter.getRun("degrade-run") ? candidate : undefined;
    });
    for (const replacement of [undefined, async () => { throw new Error("counter unavailable"); }]) {
      resolved.adapter.countNodesByStateForRuns = replacement;
      const response = await gateway.routeRequest(CONNECTION, { id: `list-${String(replacement)}`, method: "listRuns", params: { filter: { limit: 10 } } });
      expect(response.ok).toBe(true);
      const listed = response.payload.find((row) => row.runId === "degrade-run");
      expect(listed.summary).toBeUndefined();
    }
  });
});
