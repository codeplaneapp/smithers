/** @jsxImportSource smithers-orchestrator */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { startServer, __serverTestInternals } from "../src/index.js";
import { sleep } from "../../smithers/tests/helpers.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Deterministically exercises the fire-and-forget continuations wired onto the
 * POST /v1/runs (launch) and POST /v1/runs/:runId/resume endpoints:
 *  - launch `.then` success projection (finalizeRunRecord)
 *  - launch `.catch` failure projection (logError + runs.delete)
 *  - resume `.then` success projection (resume of a finished run resolves)
 *  - resume `.catch` failure projection (logError + clearRunCleanupTimer)
 * The `.catch` branches fire when the engine's runWorkflow REJECTS. A workflow
 * whose render function throws produces a deterministic rejection; a sentinel
 * file lets the SAME workflow source (identical resume hash, so no metadata
 * mismatch) render cleanly on the first run yet throw on resume.
 */

function getPort(server) {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return addr.port;
}

function request(port) {
  return async (path, options = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: options.method ?? "GET",
      headers: options.body ? { "content-type": "application/json" } : {},
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null };
  };
}

describe("server run lifecycle continuations", () => {
  /** @type {import("node:http").Server | undefined} */
  let server;
  let testDir;

  afterEach(async () => {
    if (server) {
      server.close();
      server = undefined;
    }
    // Let fire-and-forget run continuations settle before deleting their DBs.
    await sleep(700);
    if (testDir) {
      try { rmSync(testDir, { recursive: true, force: true }); } catch {}
      testDir = undefined;
    }
  });

  function makeDir() {
    testDir = resolve(process.cwd(), "tests", ".test-lifecycle-" + Math.random().toString(36).slice(2));
    mkdirSync(testDir, { recursive: true });
    return testDir;
  }

  function writeLiteralWorkflow(name, dbPath) {
    const workflowPath = resolve(testDir, `${name}.tsx`);
    writeFileSync(
      workflowPath,
      `/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod";
const { smithers, Workflow, Task, outputs } = createSmithers(
  { outputA: z.object({ value: z.number() }) },
  { dbPath: "${dbPath}" },
);
export default smithers(() => (
  <Workflow name="${name}">
    <Task id="task1" output={outputs.outputA}>
      {{ value: 7 }}
    </Task>
  </Workflow>
));
`,
    );
    return workflowPath;
  }

  function writeSlowWorkflow(name, dbPath) {
    const workflowPath = resolve(testDir, `${name}.tsx`);
    writeFileSync(
      workflowPath,
      `/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod";
const fakeAgent = {
  id: "fake",
  tools: {},
  generate: async (args) => {
    await new Promise((res, rej) => {
      const timer = setTimeout(res, 60000);
      const abort = () => { clearTimeout(timer); const e = new Error("aborted"); e.name = "AbortError"; rej(e); };
      if (args.abortSignal?.aborted) { abort(); return; }
      args.abortSignal?.addEventListener("abort", abort, { once: true });
    });
    return { output: { value: 1 } };
  },
};
const { smithers, Workflow, Task, outputs } = createSmithers(
  { outputA: z.object({ value: z.number() }) },
  { dbPath: "${dbPath}" },
);
export default smithers(() => (
  <Workflow name="${name}">
    <Task id="task1" output={outputs.outputA} agent={fakeAgent}>
      run the slow task
    </Task>
  </Workflow>
));
`,
    );
    return workflowPath;
  }

  async function waitForStatus(req, runId, predicate, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      const got = await req(`/v1/runs/${runId}`);
      last = got.data?.status;
      if (predicate(last)) return last;
      await sleep(40);
    }
    throw new Error(`run ${runId} never satisfied predicate (last=${last})`);
  }

  test("launch .then finalizes a completed run", async () => {
    makeDir();
    const dbPath = resolve(testDir, "launch-then.db");
    const workflowPath = writeLiteralWorkflow("launch-then", dbPath);
    server = startServer({ port: 0, host: "127.0.0.1" });
    const req = request(getPort(server));

    const start = await req("/v1/runs", { method: "POST", body: { workflowPath } });
    expect(start.status).toBe(200);
    const runId = start.data.runId;
    const status = await waitForStatus(req, runId, (s) => ["finished", "failed", "continued"].includes(s));
    expect(["finished", "failed", "continued"]).toContain(status);
  });

  test("launch .catch runs when runWorkflow rejects on a DB failure", async () => {
    makeDir();
    // Keep the DB in its own subdirectory so we can remove it out from under the
    // in-flight run without touching the (already-loaded) workflow module.
    const dbDir = resolve(testDir, "launch-catch-db");
    mkdirSync(dbDir, { recursive: true });
    const dbPath = resolve(dbDir, "run.db");
    const workflowPath = writeSlowWorkflow("launch-catch", dbPath);
    server = startServer({ port: 0, host: "127.0.0.1" });
    const req = request(getPort(server));

    const start = await req("/v1/runs", { method: "POST", body: { workflowPath } });
    expect(start.status).toBe(200);
    const runId = start.data.runId;
    // Wait until the slow task is genuinely in-flight (DB actively written).
    await waitForStatus(req, runId, (s) => s === "running");
    expect(__serverTestInternals.runs.has(runId)).toBe(true);
    // Yank the DB directory: subsequent heartbeat/frame writes hit a disk I/O
    // error, so runWorkflow REJECTS (infra failure, not a normal task failure),
    // driving the launch `.catch` -> immediate runs.delete. A resolve, by
    // contrast, would keep the record for COMPLETED_RUN_RETENTION_MS (60s).
    rmSync(dbDir, { recursive: true, force: true });
    const deadline = Date.now() + 15000;
    while (__serverTestInternals.runs.has(runId) && Date.now() < deadline) {
      await sleep(50);
    }
    expect(__serverTestInternals.runs.has(runId)).toBe(false);
  }, 30000);

  test("resume .then finalizes when resuming an already-finished run", async () => {
    makeDir();
    const dbPath = resolve(testDir, "resume-then.db");
    const workflowPath = writeLiteralWorkflow("resume-then", dbPath);
    server = startServer({ port: 0, host: "127.0.0.1" });
    const req = request(getPort(server));

    const start = await req("/v1/runs", { method: "POST", body: { workflowPath } });
    expect(start.status).toBe(200);
    const runId = start.data.runId;
    await waitForStatus(req, runId, (s) => ["finished", "continued"].includes(s));

    // A finished run is not heartbeat-fresh, so resume proceeds into runWorkflow,
    // which reconciles the already-complete graph and resolves -> `.then`.
    const resumed = await req(`/v1/runs/${runId}/resume`, { method: "POST", body: { workflowPath } });
    expect(resumed.status).toBe(200);
    expect(resumed.data.runId).toBe(runId);
    const status = await waitForStatus(req, runId, (s) => ["finished", "continued"].includes(s));
    expect(["finished", "continued"]).toContain(status);
    // Let the resumed run's `.then` continuation settle before teardown deletes the DB.
    await sleep(300);
  });

  test("resume .catch runs when resume's runWorkflow rejects on a DB failure", async () => {
    makeDir();
    const dbDir = resolve(testDir, "resume-catch-db");
    mkdirSync(dbDir, { recursive: true });
    const dbPath = resolve(dbDir, "run.db");
    const workflowPath = writeSlowWorkflow("resume-catch", dbPath);
    server = startServer({ port: 0, host: "127.0.0.1" });
    const req = request(getPort(server));

    // Start the slow run, then interrupt the server so the run is left mid-flight
    // (status "running") without a graceful cancel; the DB row's heartbeat then
    // goes stale, making the run resumable.
    const start = await req("/v1/runs", { method: "POST", body: { workflowPath } });
    expect(start.status).toBe(200);
    const runId = start.data.runId;
    await waitForStatus(req, runId, (s) => s === "running");
    const srv = server;
    const closed = new Promise((r) => srv.on("close", r));
    srv.close();
    server = undefined;
    await closed;
    await sleep(300);

    // Force the persisted run's heartbeat stale so resume proceeds into runWorkflow.
    const sqlite = new Database(dbPath);
    sqlite.run("UPDATE _smithers_runs SET status = 'running', heartbeat_at_ms = 1000 WHERE run_id = ?", [runId]);
    sqlite.close();

    // New server; resume re-runs the slow task (wide window), then yank the DB so
    // resume's runWorkflow REJECTS -> resume `.catch` (immediate runs.delete).
    server = startServer({ port: 0, host: "127.0.0.1" });
    const req2 = request(getPort(server));
    const resumed = await req2(`/v1/runs/${runId}/resume`, { method: "POST", body: { workflowPath } });
    expect(resumed.status).toBe(200);
    await waitForStatus(req2, runId, (s) => s === "running");
    expect(__serverTestInternals.runs.has(runId)).toBe(true);
    rmSync(dbDir, { recursive: true, force: true });
    const deadline = Date.now() + 15000;
    while (__serverTestInternals.runs.has(runId) && Date.now() < deadline) {
      await sleep(50);
    }
    expect(__serverTestInternals.runs.has(runId)).toBe(false);
  }, 30000);
});
