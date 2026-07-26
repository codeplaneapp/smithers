/** @jsxImportSource smithers-orchestrator */
import { afterEach, describe, expect, test } from "bun:test";
import { startServer } from "../src/index.js";
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
      try {
        rmSync(testDir, { recursive: true, force: true });
      } catch {}
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

  async function waitForRunRemoval(req, runId, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const got = await req(`/v1/runs/${runId}`);
      if (got.status === 404) return;
      await sleep(40);
    }
    throw new Error(`run ${runId} remained in the server registry`);
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

  test("launch .catch runs when runWorkflow rejects", async () => {
    makeDir();
    const dbPath = resolve(testDir, "launch-catch.db");
    const workflowPath = writeLiteralWorkflow("launch-catch", dbPath);
    server = startServer({ port: 0, host: "127.0.0.1" });
    const req = request(getPort(server));

    // An input object whose nested array exceeds the engine's per-run input
    // bound passes the server's shape checks and body parse, but trips
    // validateRunOptions at the very top of runWorkflow -> the Effect FAILS, so
    // Effect.runPromise REJECTS and the launch `.catch` runs (logError +
    // clearRunCleanupTimer + runs.delete). A resolve would instead keep the
    // record for COMPLETED_RUN_RETENTION_MS (60s), so a fast removal proves the
    // `.catch` fired.
    const start = await req("/v1/runs", {
      method: "POST",
      body: { workflowPath, input: { oversized: Array(600).fill(0) } },
    });
    expect(start.status).toBe(200);
    const runId = start.data.runId;
    await waitForRunRemoval(req, runId);
  });

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

  test("resume .catch runs when resume's runWorkflow rejects", async () => {
    makeDir();
    const dbPath = resolve(testDir, "resume-catch.db");
    const workflowPath = writeLiteralWorkflow("resume-catch", dbPath);
    server = startServer({ port: 0, host: "127.0.0.1" });
    const req = request(getPort(server));

    const start = await req("/v1/runs", { method: "POST", body: { workflowPath } });
    expect(start.status).toBe(200);
    const runId = start.data.runId;
    await waitForStatus(req, runId, (s) => ["finished", "continued"].includes(s));

    // The finished run is resumable; an oversized input trips validateRunOptions
    // inside resume's runWorkflow, so the Effect FAILS and resume's `.catch`
    // fires (logError + clearRunCleanupTimer + runs.delete).
    const resumed = await req(`/v1/runs/${runId}/resume`, {
      method: "POST",
      body: { workflowPath, input: { oversized: Array(600).fill(0) } },
    });
    expect(resumed.status).toBe(200);
    await waitForRunRemoval(req, runId);
  });
});
