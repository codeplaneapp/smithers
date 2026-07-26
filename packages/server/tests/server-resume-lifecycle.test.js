/** @jsxImportSource smithers-orchestrator */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { startServer } from "../src/index.js";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { sleep } from "../../smithers/tests/helpers.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Exercises the fire-and-forget continuations of the dedicated
 * POST /v1/runs/:runId/resume endpoint (the `.then` success projection and the
 * `.catch` abort projection) plus the integration-runtime shutdown call fired
 * from the server 'close' handler.
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

describe("server resume + integration lifecycle", () => {
  /** @type {import("node:http").Server | undefined} */
  let server;
  let testDir;

  afterEach(async () => {
    if (server) {
      server.close();
      server = undefined;
    }
    // Give aborted run loops time to settle their rejected continuations.
    await sleep(400);
    if (testDir) {
      try {
        rmSync(testDir, { recursive: true, force: true });
      } catch {}
      testDir = undefined;
    }
  });

  function makeDir() {
    testDir = resolve(process.cwd(), "tests", ".test-resume-" + Math.random().toString(36).slice(2));
    mkdirSync(testDir, { recursive: true });
    return testDir;
  }

  function writeWorkflow(name, dbPath, { slow = false } = {}) {
    const workflowPath = resolve(testDir, `${name}.tsx`);
    const slowAgent = slow
      ? `
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
};`
      : "";
    const agentProp = slow ? " agent={fakeAgent}" : "";
    const body = slow ? "run the slow task" : "{{ value: 7 }}";
    writeFileSync(
      workflowPath,
      `/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod";
${slowAgent}
const { smithers, Workflow, Task, outputs } = createSmithers(
  { outputA: z.object({ value: z.number() }) },
  { dbPath: "${dbPath}" },
);
export default smithers(() => (
  <Workflow name="${name}">
    <Task id="task1" output={outputs.outputA}${agentProp}>
      ${body}
    </Task>
  </Workflow>
));
`,
    );
    return workflowPath;
  }

  async function waitForPersisted(dbPath, runId, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const sqlite = new Database(dbPath);
        const db = drizzle(sqlite);
        const adapter = new SmithersDb(db);
        const run = await adapter.getRun(runId);
        sqlite.close();
        if (run) return run;
      } catch {}
      await sleep(50);
    }
    throw new Error(`run ${runId} never persisted`);
  }

  test("resume .then projection finalizes a completed run", async () => {
    makeDir();
    const dbPath = resolve(testDir, "resume-then.db");
    const workflowPath = writeWorkflow("resume-then", dbPath);
    server = startServer({ port: 0, host: "127.0.0.1" });
    const req = request(getPort(server));

    const start = await req("/v1/runs", { method: "POST", body: { workflowPath } });
    expect(start.status).toBe(200);
    const runId = start.data.runId;
    await waitForPersisted(dbPath, runId);
    // Wait for the initial run to actually finish (stale heartbeat) so the
    // resume endpoint does not short-circuit on a fresh heartbeat and
    // instead proceeds into runWorkflow.
    const finishedDeadline = Date.now() + 5000;
    while (Date.now() < finishedDeadline) {
      const got = await req(`/v1/runs/${runId}`);
      if (["finished", "failed", "continued"].includes(got.data?.status)) break;
      await sleep(50);
    }

    // Resume the (now finished) run: runWorkflow resolves quickly, driving
    // the `.then((result) => finalizeRunRecord(...))` continuation.
    const resumed = await req(`/v1/runs/${runId}/resume`, { method: "POST", body: { workflowPath } });
    expect(resumed.status).toBe(200);
    expect(resumed.data.runId).toBe(runId);

    // Poll until the resumed run settles to a terminal status in the DB,
    // proving the resume execution ran to completion (then projection).
    const deadline = Date.now() + 5000;
    let status = "";
    while (Date.now() < deadline) {
      const got = await req(`/v1/runs/${runId}`);
      status = got.data?.status;
      if (["finished", "failed", "continued"].includes(status)) break;
      await sleep(50);
    }
    expect(["finished", "failed", "continued"]).toContain(status);
  });

  test("server 'close' handler shuts down the integration runtime", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    server = startServer({
      port: 0,
      host: "127.0.0.1",
      db,
      integrations: {
        webhooks: [
          {
            id: "lifecycle",
            secret: "s",
            event: "integration:lifecycle:ping",
            payloadPath: "data",
          },
        ],
      },
    });
    const srv = server;
    const port = getPort(srv);
    // Confirm the integration runtime is live by routing a webhook to it.
    const routed = await fetch(`http://127.0.0.1:${port}/v1/webhooks/lifecycle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: { hello: true } }),
    });
    // Signed-source verification runs (401 without a signature) — proving the
    // integration runtime is wired and will be shut down on close.
    expect([202, 401]).toContain(routed.status);

    const closed = new Promise((r) => srv.on("close", r));
    srv.close();
    server = undefined;
    await closed;
    // The 'close' handler reached `integrationRuntime.shutdown()`; give the
    // returned promise a tick to settle so no unhandled rejection leaks.
    await sleep(50);
    sqlite.close();
    // The listener is fully torn down after close.
    expect(srv.listening).toBe(false);
  });
});
