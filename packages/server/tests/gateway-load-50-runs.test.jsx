/** @jsxImportSource smithers-orchestrator */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { createSmithers } from "smithers-orchestrator";
import { Gateway } from "../src/gateway.js";

/**
 * Scale coverage for the singleton-gateway model (spec decision 15): one
 * gateway owning one store must execute 50 concurrent runs to completion
 * without loss or cross-run corruption. This is the counterpart to the bug it
 * exists to fix — 50 SEPARATE `smithers up` processes contend on the same
 * SQLite WAL and surface intermittent write failures (SQLITE_IOERR_VNODE on
 * macOS) once the retry budget is exhausted, and on pglite collide outright.
 * Routing every run through ONE owner removes the cross-process contention.
 *
 * In-process, per-PR layer: literal-output tasks (no agent subprocess) so it is
 * fast and CI-safe. The fd/process dimension lives in the e2e soak variant.
 */

const AUTH = { triggeredBy: "test", scopes: ["*"], role: "operator", tokenId: null };
const RUN_COUNT = 50;

function makeDbPath(name) {
  return join(tmpdir(), `smithers-load-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

/** One workflow with a couple of nodes so each run writes several events. */
function createLoadWorkflow(dbPath) {
  const { smithers, Workflow, Task, outputs } = createSmithers({ out: z.object({ value: z.number() }) }, { dbPath });
  const workflow = smithers(() => (
    <Workflow name="load">
      <Task id="a" output={outputs.out}>
        {{ value: 1 }}
      </Task>
      <Task id="b" needs={["a"]} output={outputs.out}>
        {{ value: 2 }}
      </Task>
    </Workflow>
  ));
  return workflow;
}

describe("gateway — 50 concurrent runs through one owner", () => {
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

  test("all 50 runs finish, each attributed once, no cross-run corruption", async () => {
    dbPath = makeDbPath("50");
    const workflow = createLoadWorkflow(dbPath);
    gateway = new Gateway({ heartbeatMs: 1000 });
    gateway.register("load", workflow);

    const runIds = Array.from({ length: RUN_COUNT }, (_, i) => `run-${i.toString().padStart(3, "0")}`);

    // Launch all 50 concurrently — this is the contention the bug is about.
    await Promise.all(runIds.map((runId) => gateway.startRun("load", {}, AUTH, runId, { resume: false })));

    // Poll until every run reaches a terminal state. Generous budget: the
    // single-owner FIFO write lane makes 50 runs a latency story, not a
    // deadlock — if this times out, contention or a leak regressed.
    const deadline = Date.now() + 60_000;
    /** @type {Map<string, string>} */
    let byRun = new Map();
    for (;;) {
      const listed = await gateway.listRunsAcrossWorkflows(RUN_COUNT * 2);
      byRun = new Map(listed.map((r) => [r.runId, r.status]));
      const terminal = runIds.filter((id) => {
        const s = byRun.get(id);
        return s === "finished" || s === "failed" || s === "cancelled";
      });
      if (terminal.length >= RUN_COUNT) break;
      if (Date.now() > deadline) {
        throw new Error(
          `only ${terminal.length}/${RUN_COUNT} runs reached terminal state; ` +
            `statuses: ${JSON.stringify([...byRun.entries()])}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Every run listed exactly once (no shared-DB duplication under load) and
    // every one finished cleanly — none failed or cancelled from a write error.
    expect(byRun.size).toBe(RUN_COUNT);
    for (const id of runIds) {
      expect(byRun.get(id)).toBe("finished");
    }

    // Event integrity per run: seqs contiguous from 0 and every event belongs
    // to its own run (no cross-run bleed from a seq collision or a dropped row).
    const adapter = gateway.adapterForWorkflow(workflow);
    for (const id of runIds) {
      const events = await adapter.listEventHistory(id, { limit: 10_000 });
      expect(events.length).toBeGreaterThan(0);
      const seqs = events.map((e) => Number(e.seq));
      for (let i = 0; i < seqs.length; i++) {
        expect(seqs[i]).toBe(i);
        expect(String(events[i].run_id ?? events[i].runId)).toBe(id);
      }
    }
  }, 90_000);
});
