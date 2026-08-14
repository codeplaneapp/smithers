/** @jsxImportSource smthrs */
import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { startServer } from "../src/index.js";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { createTestDb, sleep } from "../../smithers/tests/helpers.js";
import { ddl, schema } from "../../smithers/tests/schema.js";
import { SmithersDb } from "@smthrs/db/adapter";
import { resolve } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
function buildDb() {
  return createTestDb(schema, ddl);
}
/**
 * @param {Server} server
 * @returns {number}
 */
function getPort(server) {
  const addr = server.address();
  return addr.port;
}
/**
 * @param {number} port
 */
function makeRequest(port) {
  return async function request(path, options = {}) {
    const headers = { ...options.headers };
    if (options.body && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    const res = await fetch(`http://localhost:${port}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const data = await res.json();
    return { status: res.status, data };
  };
}
describe("HTTP Server", () => {
  let server;
  let testDir;
  let port;
  let request;
  beforeEach(() => {
    testDir = resolve(process.cwd(), "tests", ".test-workflows-" + Math.random().toString(36).slice(2));
    mkdirSync(testDir, { recursive: true });
  });
  afterEach(async () => {
    if (server) {
      server.close();
    }
    await sleep(500);
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });
  /**
   * @param {ServerOptions} [opts]
   */
  function startTestServer(opts = {}) {
    server = startServer({ port: 0, ...opts });
    port = getPort(server);
    request = makeRequest(port);
  }
  /**
   * @param {string} runId
   * @param {string[]} statuses
   */
  async function waitForRunStatus(runId, statuses, timeoutMs = 5_000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const { status, data } = await request(`/v1/runs/${runId}`);
      if (status === 200 && statuses.includes(data.status)) {
        return data;
      }
      await sleep(50);
    }
    throw new Error(`Timed out waiting for run ${runId} to reach one of: ${statuses.join(", ")}`);
  }
  /**
   * @param {string} dbPath
   * @param {string} runId
   */
  async function waitForPersistedRun(dbPath, runId, timeoutMs = 5_000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      let db = null;
      try {
        db = new Database(dbPath, { readonly: true });
        const row = db.query("SELECT run_id AS runId FROM _smithers_runs WHERE run_id = ? LIMIT 1").get(runId);
        if (row) {
          return row;
        }
      } catch {
      } finally {
        db?.close();
      }
      await sleep(50);
    }
    throw new Error(`Timed out waiting for run ${runId} to be persisted`);
  }
  /**
   * @param {string} dbPath
   * @param {string} runId
   */
  function readOutputValue(dbPath, runId) {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.query("SELECT value FROM output_a WHERE run_id = ? AND node_id = 'task1' LIMIT 1").get(runId);
      return row?.value;
    } finally {
      db.close();
    }
  }
  /**
   * @param {SmithersDb} adapter
   * @param {string} runId
   * @param {string} workflowName
   */
  async function seedWaitingTimerRun(adapter, runId, workflowName) {
    const now = Date.now();
    await adapter.insertRun({
      runId,
      workflowName,
      status: "waiting-timer",
      createdAtMs: now,
    });
    await adapter.insertNode({
      runId,
      nodeId: "cooldown",
      iteration: 0,
      state: "waiting-timer",
      lastAttempt: 1,
      updatedAtMs: now,
      outputTable: "",
      label: "Cooldown",
    });
    await adapter.insertAttempt({
      runId,
      nodeId: "cooldown",
      iteration: 0,
      attempt: 1,
      state: "waiting-timer",
      startedAtMs: now,
      finishedAtMs: null,
      errorJson: null,
      metaJson: JSON.stringify({
        timer: {
          timerId: "cooldown",
          timerType: "duration",
          createdAtMs: now,
          firesAtMs: now + 60_000,
          firedAtMs: null,
          duration: "1m",
        },
      }),
      responseText: null,
      cached: false,
      jjPointer: null,
      jjCwd: null,
    });
  }
  /**
   * @param {string} name
   * @param {string} dbPath
   * @param {{ needsApproval?: boolean; slow?: boolean; value?: number }} [options]
   */
  function writeTestWorkflow(name, dbPath, options = {}) {
    const workflowPath = resolve(testDir, `${name}.tsx`);
    const slowAgent = options.slow
      ? `
const fakeAgent = {
  id: "fake",
  tools: {},
  generate: async (args) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 60000);
      const abort = () => {
        clearTimeout(timer);
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      };
      if (args.abortSignal?.aborted) {
        abort();
        return;
      }
      args.abortSignal?.addEventListener("abort", abort, { once: true });
    });
    return { output: { value: 1 } };
  },
};`
      : "";
    const agentProp = options.slow ? " agent={fakeAgent}" : "";
    const approvalProp = options.needsApproval ? " needsApproval" : "";
    const outputValue = options.value ?? 42;
    writeFileSync(
      workflowPath,
      `/** @jsxImportSource smthrs */
	import { createSmithers } from "smthrs";
	import { z } from "zod";
	${slowAgent}
	
	const { smithers, Workflow, Task, outputs } = createSmithers(
	  { outputA: z.object({ value: z.number() }) },
	  { dbPath: "${dbPath}" },
	);
	
	export default smithers((ctx) => (
	  <Workflow name="${name}">
	    <Task id="task1" output={outputs.outputA}${agentProp}${approvalProp}>
	      ${options.slow ? "run task" : `{{ value: ${outputValue} }}`}
	    </Task>
	  </Workflow>
	));
	`,
    );
    return workflowPath;
  }
  function writeSelectApprovalWorkflow(name, dbPath) {
    const workflowPath = resolve(testDir, `${name}.tsx`);
    writeFileSync(
      workflowPath,
      `/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs";
import { z } from "zod";

const { smithers, Workflow, Approval, outputs } = createSmithers(
  { selection: z.object({ selected: z.string(), notes: z.string().nullable() }) },
  { dbPath: ${JSON.stringify(dbPath)} },
);

export default smithers(() => (
  <Workflow name="${name}">
    <Approval
      id="task1"
      mode="select"
      output={outputs.selection}
      request={{ title: "Pick a plan" }}
      options={[
        { key: "balanced", label: "Balanced" },
        { key: "light", label: "Light" },
      ]}
    />
  </Workflow>
));
`,
    );
    return workflowPath;
  }
  describe("host/origin defense", () => {
    test("rejects a non-loopback Host without authToken", async () => {
      startTestServer();
      const { status, data } = await request("/v1/runs", {
        headers: { Host: "evil.com" },
      });
      expect(status).toBe(403);
      expect(data.error.code).toBe("FORBIDDEN");
      expect(data.error.message).toBe("Host is not allowed");
    });
    test("rejects a non-loopback Origin without authToken", async () => {
      startTestServer();
      const { status, data } = await request("/v1/runs", {
        method: "POST",
        headers: { Origin: "http://evil.com" },
        body: { workflowPath: "x" },
      });
      expect(status).toBe(403);
      expect(data.error.code).toBe("FORBIDDEN");
      expect(data.error.message).toBe("Origin is not allowed");
    });
    test("allows loopback Host without authToken", async () => {
      const { db, cleanup } = buildDb();
      ensureSmithersTables(db);
      startTestServer({ db });
      const { status } = await request("/v1/runs", {
        headers: { Host: "127.0.0.1:9999" },
      });
      expect(status).toBe(200);
      cleanup();
    });
    test("skips the host defense when authToken is configured", async () => {
      const { db, cleanup } = buildDb();
      ensureSmithersTables(db);
      startTestServer({ authToken: "secret", db });
      const { status } = await request("/v1/runs", {
        headers: { Host: "evil.com", "x-smithers-key": "secret" },
      });
      expect(status).toBe(200);
      cleanup();
    });
    test("SMITHERS_SERVER_TRUST_ANY_HOST=1 opts out of the host defense", async () => {
      const saved = process.env.SMITHERS_SERVER_TRUST_ANY_HOST;
      try {
        process.env.SMITHERS_SERVER_TRUST_ANY_HOST = "1";
        const { db, cleanup } = buildDb();
        ensureSmithersTables(db);
        startTestServer({ db });
        const { status } = await request("/v1/runs", {
          headers: { Host: "evil.com" },
        });
        expect(status).toBe(200);
        cleanup();
      } finally {
        if (saved === undefined) delete process.env.SMITHERS_SERVER_TRUST_ANY_HOST;
        else process.env.SMITHERS_SERVER_TRUST_ANY_HOST = saved;
      }
    });
  });
  describe("POST /v1/runs", () => {
    test("starts a new run and returns runId", async () => {
      const dbPath = resolve(testDir, "test1.db");
      const workflowPath = writeTestWorkflow("test1", dbPath);
      startTestServer();
      const { status, data } = await request("/v1/runs", {
        method: "POST",
        body: { workflowPath },
      });
      expect(status).toBe(200);
      expect(data.runId).toBeDefined();
      expect(typeof data.runId).toBe("string");
    });
    test("accepts custom runId", async () => {
      const dbPath = resolve(testDir, "test2.db");
      const workflowPath = writeTestWorkflow("test2", dbPath);
      startTestServer();
      const customRunId = "custom-run-id-123";
      const { status, data } = await request("/v1/runs", {
        method: "POST",
        body: { workflowPath, runId: customRunId },
      });
      expect(status).toBe(200);
      expect(data.runId).toBe(customRunId);
    });
    test("returns 500 for invalid workflow path", async () => {
      startTestServer();
      const { status, data } = await request("/v1/runs", {
        method: "POST",
        body: { workflowPath: "/nonexistent/workflow.ts" },
      });
      expect(status).toBe(500);
      expect(data.error).toBeDefined();
      expect(data.error.code).toBe("SERVER_ERROR");
    });
    test("reloads a workflow file after it changes on disk", async () => {
      const dbPath = resolve(testDir, "reload.db");
      const workflowPath = writeTestWorkflow("reload", dbPath, { value: 42 });
      startTestServer();
      const firstRun = await request("/v1/runs", {
        method: "POST",
        body: { workflowPath },
      });
      expect(firstRun.status).toBe(200);
      await waitForRunStatus(firstRun.data.runId, ["finished"]);
      expect(readOutputValue(dbPath, firstRun.data.runId)).toBe(42);
      await sleep(25);
      writeTestWorkflow("reload", dbPath, { value: 7 });
      const secondRun = await request("/v1/runs", {
        method: "POST",
        body: { workflowPath },
      });
      expect(secondRun.status).toBe(200);
      await waitForRunStatus(secondRun.data.runId, ["finished"]);
      expect(readOutputValue(dbPath, secondRun.data.runId)).toBe(7);
    }, 15_000);
    test("returns 400 for invalid JSON body", async () => {
      const dbPath = resolve(testDir, "test-invalid-json.db");
      writeTestWorkflow("test-invalid-json", dbPath);
      startTestServer();
      const res = await fetch(`http://localhost:${port}/v1/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      });
      const data = await res.json();
      expect(res.status).toBe(400);
      expect(data.error.code).toBe("INVALID_JSON");
    });
    test("returns 413 when body exceeds limit", async () => {
      const dbPath = resolve(testDir, "test-large-body.db");
      const workflowPath = writeTestWorkflow("test-large-body", dbPath);
      startTestServer({ maxBodyBytes: 100 });
      const largeInput = { workflowPath, input: { payload: "x".repeat(1000) } };
      const { status, data } = await request("/v1/runs", {
        method: "POST",
        body: largeInput,
      });
      expect(status).toBe(413);
      expect(data.error.code).toBe("PAYLOAD_TOO_LARGE");
    });
    test("requires runId when resume is true", async () => {
      const dbPath = resolve(testDir, "resume-requires-id.db");
      const workflowPath = writeTestWorkflow("resume-requires-id", dbPath);
      startTestServer();
      const { status, data } = await request("/v1/runs", {
        method: "POST",
        body: { workflowPath, resume: true },
      });
      expect(status).toBe(400);
      expect(data.error.code).toBe("RUN_ID_REQUIRED");
    });
    test("rejects duplicate run ids without resume", async () => {
      const dbPath = resolve(testDir, "duplicate-run.db");
      const workflowPath = writeTestWorkflow("duplicate-run", dbPath);
      const runId = "duplicate-run-id";
      startTestServer();
      const first = await request("/v1/runs", {
        method: "POST",
        body: { workflowPath, runId },
      });
      expect(first.status).toBe(200);
      await waitForPersistedRun(dbPath, runId);
      const second = await request("/v1/runs", {
        method: "POST",
        body: { workflowPath, runId },
      });
      expect(second.status).toBe(409);
      expect(second.data.error.code).toBe("RUN_ALREADY_EXISTS");
    });
    test("resume returns running for a fresh persisted heartbeat", async () => {
      const dbPath = resolve(testDir, "fresh-heartbeat.db");
      const workflowPath = writeTestWorkflow("fresh-heartbeat", dbPath);
      const db = new Database(dbPath);
      ensureSmithersTables(db);
      const adapter = new SmithersDb(db);
      const runId = "fresh-heartbeat-run";
      await adapter.insertRun({
        runId,
        workflowName: "fresh-heartbeat",
        status: "running",
        createdAtMs: Date.now(),
        startedAtMs: Date.now(),
        heartbeatAtMs: Date.now(),
        runtimeOwnerId: "worker-1",
      });
      startTestServer();
      const { status, data } = await request("/v1/runs", {
        method: "POST",
        body: { workflowPath, runId, resume: true },
      });
      expect(status).toBe(200);
      expect(data).toEqual({ runId, status: "running" });
    });
  });
  describe("GET /v1/runs/:runId", () => {
    test("returns run status after starting", async () => {
      const dbPath = resolve(testDir, "test3.db");
      const workflowPath = writeTestWorkflow("test3", dbPath, { slow: true });
      startTestServer();
      const { status: startStatus, data: startData } = await request("/v1/runs", {
        method: "POST",
        body: { workflowPath },
      });
      expect(startStatus).toBe(200);
      await waitForPersistedRun(dbPath, startData.runId);
      const { status, data } = await request(`/v1/runs/${startData.runId}`);
      expect(status).toBe(200);
      expect(data.runId).toBe(startData.runId);
      expect(data.workflowName).toBeDefined();
      expect(data.status).toBeDefined();
      expect(["running", "finished", "failed", "waiting-approval"]).toContain(data.status);
    });
    test("isolates active runs between server instances", async () => {
      const firstDbPath = resolve(testDir, "first-server.db");
      const secondDbPath = resolve(testDir, "second-server.db");
      const firstWorkflowPath = writeTestWorkflow("first-server", firstDbPath, { slow: true });
      const secondWorkflowPath = writeTestWorkflow("second-server", secondDbPath, { slow: true });
      server = startServer({ port: 0, host: "127.0.0.1" });
      const firstRequest = makeRequest(getPort(server));
      const secondServer = startServer({ port: 0, host: "127.0.0.1" });
      const secondRequest = makeRequest(getPort(secondServer));
      try {
        const firstRun = await firstRequest("/v1/runs", {
          method: "POST",
          body: { workflowPath: firstWorkflowPath },
        });
        const secondRun = await secondRequest("/v1/runs", {
          method: "POST",
          body: { workflowPath: secondWorkflowPath },
        });
        expect(firstRun.status).toBe(200);
        expect(secondRun.status).toBe(200);
        await Promise.all([
          waitForPersistedRun(firstDbPath, firstRun.data.runId),
          waitForPersistedRun(secondDbPath, secondRun.data.runId),
        ]);

        const crossServerLookup = await firstRequest(`/v1/runs/${secondRun.data.runId}`);
        expect(crossServerLookup.status).toBe(404);

        await new Promise((resolveClose) => server.close(resolveClose));
        server = undefined;

        const survivingRun = await secondRequest(`/v1/runs/${secondRun.data.runId}`);
        expect(survivingRun.status).toBe(200);
        expect(survivingRun.data.runId).toBe(secondRun.data.runId);
        expect(survivingRun.data.status).toBe("running");
      } finally {
        secondServer.close();
      }
    }, 15_000);
    test("returns 404 for non-existent run", async () => {
      startTestServer();
      const { status, data } = await request("/v1/runs/non-existent-run-id");
      expect(status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });
  });
  describe("Auth", () => {
    test("rejects requests without token when auth is enabled", async () => {
      const dbPath = resolve(testDir, "test-auth.db");
      const workflowPath = writeTestWorkflow("test-auth", dbPath);
      startTestServer({ authToken: "secret" });
      const { status, data } = await request("/v1/runs", {
        method: "POST",
        body: { workflowPath },
      });
      expect(status).toBe(401);
      expect(data.error.code).toBe("UNAUTHORIZED");
    });
    test("accepts requests with valid token", async () => {
      const dbPath = resolve(testDir, "test-auth-ok.db");
      const workflowPath = writeTestWorkflow("test-auth-ok", dbPath);
      startTestServer({ authToken: "secret" });
      const { status, data } = await request("/v1/runs", {
        method: "POST",
        body: { workflowPath },
        headers: { Authorization: "Bearer secret" },
      });
      expect(status).toBe(200);
      expect(data.runId).toBeDefined();
    });
    test("accepts requests via the x-smithers-key header", async () => {
      const dbPath = resolve(testDir, "test-auth-key.db");
      const workflowPath = writeTestWorkflow("test-auth-key", dbPath);
      startTestServer({ authToken: "secret" });
      const { status, data } = await request("/v1/runs", {
        method: "POST",
        body: { workflowPath },
        headers: { "x-smithers-key": "secret" },
      });
      expect(status).toBe(200);
      expect(data.runId).toBeDefined();
    });
  });
  describe("POST /v1/runs/:runId/cancel", () => {
    test("cancels an active run", async () => {
      const dbPath = resolve(testDir, "slow.db");
      const workflowPath = writeTestWorkflow("slow", dbPath, { slow: true });
      startTestServer();
      const { data: startData } = await request("/v1/runs", {
        method: "POST",
        body: { workflowPath },
      });
      await waitForPersistedRun(dbPath, startData.runId);
      const { status, data } = await request(`/v1/runs/${startData.runId}/cancel`, {
        method: "POST",
      });
      expect(status).toBe(200);
      expect(data.runId).toBe(startData.runId);
    });
    test("returns 404 for non-existent run", async () => {
      startTestServer();
      const { status, data } = await request("/v1/runs/non-existent-run-id/cancel", {
        method: "POST",
      });
      expect(status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });
    test("cancels waiting timers and records TimerCancelled", async () => {
      const { db, cleanup } = buildDb();
      ensureSmithersTables(db);
      const adapter = new SmithersDb(db);
      const runId = "waiting-timer-cancel";
      await seedWaitingTimerRun(adapter, runId, "timer-flow");
      startTestServer({ db });
      const { status, data } = await request(`/v1/runs/${runId}/cancel`, {
        method: "POST",
      });
      expect(status).toBe(200);
      expect(data.runId).toBe(runId);
      const run = await adapter.getRun(runId);
      expect(run?.status).toBe("cancelled");
      const attempts = await adapter.listAttempts(runId, "cooldown", 0);
      expect(attempts[0]?.state).toBe("cancelled");
      const events = await adapter.listEventsByType(runId, "TimerCancelled");
      expect(events).toHaveLength(1);
      cleanup();
    });
    test("cancels a waiting-quota run", async () => {
      const { db, cleanup } = buildDb();
      ensureSmithersTables(db);
      const adapter = new SmithersDb(db);
      const runId = "waiting-quota-cancel";
      await adapter.insertRun({
        runId,
        workflowName: "quota-flow",
        workflowPath: null,
        status: "waiting-quota",
        createdAtMs: Date.now() - 5_000,
        startedAtMs: Date.now() - 4_000,
        heartbeatAtMs: null,
        runtimeOwnerId: null,
        errorJson: JSON.stringify({ resetAtMs: Date.now() + 60_000 }),
      });
      startTestServer({ db });

      const { status, data } = await request(`/v1/runs/${runId}/cancel`, {
        method: "POST",
      });

      expect(status).toBe(200);
      expect(data.runId).toBe(runId);
      expect((await adapter.getRun(runId))?.status).toBe("cancelled");
      cleanup();
    });
  });
  describe("POST /v1/runs/:runId/resume", () => {
    test("resumes a run with given runId", async () => {
      const dbPath = resolve(testDir, "resume.db");
      const workflowPath = writeTestWorkflow("resume", dbPath);
      startTestServer();
      const { data: startData } = await request("/v1/runs", {
        method: "POST",
        body: { workflowPath },
      });
      await waitForPersistedRun(dbPath, startData.runId);
      const { status, data } = await request(`/v1/runs/${startData.runId}/resume`, {
        method: "POST",
        body: { workflowPath },
      });
      expect(status).toBe(200);
      expect(data.runId).toBe(startData.runId);
    });
  });
  describe("GET /v1/runs/:runId/frames", () => {
    test("returns frames for a run", async () => {
      const dbPath = resolve(testDir, "frames.db");
      const workflowPath = writeTestWorkflow("frames", dbPath, { slow: true });
      startTestServer();
      const { data: startData } = await request("/v1/runs", {
        method: "POST",
        body: { workflowPath },
      });
      await waitForPersistedRun(dbPath, startData.runId);
      const { status, data } = await request(`/v1/runs/${startData.runId}/frames`);
      expect(status).toBe(200);
      expect(Array.isArray(data)).toBe(true);
    });
    test("returns 404 for non-existent run", async () => {
      startTestServer();
      const { status, data } = await request("/v1/runs/non-existent-run-id/frames");
      expect(status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });
    test("respects limit and afterFrameNo params", async () => {
      const dbPath = resolve(testDir, "frames2.db");
      const workflowPath = writeTestWorkflow("frames2", dbPath, { slow: true });
      startTestServer();
      const { data: startData } = await request("/v1/runs", {
        method: "POST",
        body: { workflowPath },
      });
      await waitForPersistedRun(dbPath, startData.runId);
      const { status, data } = await request(`/v1/runs/${startData.runId}/frames?limit=10&afterFrameNo=0`);
      expect(status).toBe(200);
      expect(Array.isArray(data)).toBe(true);
    });
  });
  describe("POST /v1/runs/:runId/nodes/:nodeId/approve", () => {
    test("approves a node", async () => {
      const dbPath = resolve(testDir, "approval.db");
      const workflowPath = writeTestWorkflow("approval", dbPath, { needsApproval: true });
      startTestServer();
      const { data: startData } = await request("/v1/runs", {
        method: "POST",
        body: { workflowPath },
      });
      await waitForRunStatus(startData.runId, ["waiting-approval"]);
      const { status, data } = await request(`/v1/runs/${startData.runId}/nodes/task1/approve`, {
        method: "POST",
        body: { iteration: 0, note: "approved by test", decidedBy: "test-user" },
      });
      expect(status).toBe(200);
      expect(data.runId).toBe(startData.runId);
    });
    test("persists a stable select decision and audit note", async () => {
      const dbPath = resolve(testDir, "approval-select.db");
      const workflowPath = writeSelectApprovalWorkflow("approval-select", dbPath);
      startTestServer();
      const { data: startData } = await request("/v1/runs", {
        method: "POST",
        body: { workflowPath },
      });
      await waitForRunStatus(startData.runId, ["waiting-approval"]);
      const adapterDb = new Database(dbPath, { readonly: true });
      const adapter = new SmithersDb(adapterDb);
      try {
        const accepted = await request(`/v1/runs/${startData.runId}/nodes/task1/approve`, {
          method: "POST",
          body: {
            decision: {
              approved: true,
              value: { selected: "balanced", notes: "best fit" },
              note: "lgtm",
            },
          },
        });
        expect(accepted.status).toBe(200);
        const approval = await adapter.getApproval(startData.runId, "task1", 0);
        expect(JSON.parse(approval?.decisionJson ?? "null")).toEqual({
          selected: "balanced",
          notes: "best fit",
        });
        expect(approval?.note).toBe("lgtm");
      } finally {
        adapterDb.close();
      }
    });
    test("rejects a select approval without a usable decision", async () => {
      const dbPath = resolve(testDir, "approval-select-invalid.db");
      const workflowPath = writeSelectApprovalWorkflow("approval-select-invalid", dbPath);
      startTestServer();
      const { data: startData } = await request("/v1/runs", {
        method: "POST",
        body: { workflowPath },
      });
      await waitForRunStatus(startData.runId, ["waiting-approval"]);
      const adapterDb = new Database(dbPath, { readonly: true });
      const adapter = new SmithersDb(adapterDb);
      try {
        const rejected = await request(`/v1/runs/${startData.runId}/nodes/task1/approve`, {
          method: "POST",
          body: { decision: { selected: "unknown" } },
        });
        expect(rejected.status).toBe(400);
        expect(rejected.data.error.code).toBe("INVALID_REQUEST");
        expect(rejected.data.error.message).toContain("unknown");
        expect((await adapter.getApproval(startData.runId, "task1", 0))?.status).toBe("requested");
      } finally {
        adapterDb.close();
      }
    });
    test("returns 404 for non-existent run", async () => {
      startTestServer();
      const { status, data } = await request("/v1/runs/non-existent-run-id/nodes/some-node/approve", {
        method: "POST",
        body: { iteration: 0 },
      });
      expect(status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });
    test("returns 404 for non-existent run when server DB is configured", async () => {
      const { db, cleanup } = buildDb();
      ensureSmithersTables(db);
      startTestServer({ db: db });
      const { status, data } = await request("/v1/runs/non-existent-run-id/nodes/some-node/approve", {
        method: "POST",
        body: { iteration: 0 },
      });
      expect(status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
      cleanup();
    });
  });
  describe("POST /v1/runs/:runId/nodes/:nodeId/deny", () => {
    test("denies a node", async () => {
      const dbPath = resolve(testDir, "deny.db");
      const workflowPath = writeTestWorkflow("deny", dbPath, { needsApproval: true });
      startTestServer();
      const { data: startData } = await request("/v1/runs", {
        method: "POST",
        body: { workflowPath },
      });
      await waitForRunStatus(startData.runId, ["waiting-approval"]);
      const adapterDb = new Database(dbPath, { readonly: true });
      const adapter = new SmithersDb(adapterDb);
      try {
        const { status, data } = await request(`/v1/runs/${startData.runId}/nodes/task1/deny`, {
          method: "POST",
          body: {
            iteration: 0,
            decision: { approved: false, value: { reason: "unsafe" }, note: "denied by test" },
            decidedBy: "test-user",
          },
        });
        expect(status).toBe(200);
        expect(data.runId).toBe(startData.runId);
        const approval = await adapter.getApproval(startData.runId, "task1", 0);
        expect(approval?.note).toBe("denied by test");
        expect(JSON.parse(approval?.decisionJson ?? "null")).toEqual({ reason: "unsafe" });
      } finally {
        adapterDb.close();
      }
    });
    test("returns 404 for non-existent run", async () => {
      startTestServer();
      const { status, data } = await request("/v1/runs/non-existent-run-id/nodes/some-node/deny", {
        method: "POST",
        body: { iteration: 0 },
      });
      expect(status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });
    test("returns 404 for non-existent run when server DB is configured", async () => {
      const { db, cleanup } = buildDb();
      ensureSmithersTables(db);
      startTestServer({ db: db });
      const { status, data } = await request("/v1/runs/non-existent-run-id/nodes/some-node/deny", {
        method: "POST",
        body: { iteration: 0 },
      });
      expect(status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
      cleanup();
    });
  });
  describe("GET /v1/runs/:runId/events (SSE)", () => {
    test("returns SSE stream for valid run", async () => {
      const dbPath = resolve(testDir, "events.db");
      const workflowPath = writeTestWorkflow("events", dbPath, { slow: true });
      startTestServer();
      const { data: startData } = await request("/v1/runs", {
        method: "POST",
        body: { workflowPath },
      });
      await waitForPersistedRun(dbPath, startData.runId);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1000);
      try {
        const res = await fetch(`http://localhost:${port}/v1/runs/${startData.runId}/events`, {
          signal: controller.signal,
        });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("text/event-stream");
      } catch (e) {
        if (e.name !== "AbortError") throw e;
      } finally {
        clearTimeout(timeout);
        controller.abort();
      }
    });
    test("returns 400 for an invalid afterSeq before opening the SSE stream", async () => {
      const dbPath = resolve(testDir, "events-invalid-seq.db");
      const workflowPath = writeTestWorkflow("events-invalid-seq", dbPath, { slow: true });
      startTestServer();
      const { data: startData } = await request("/v1/runs", {
        method: "POST",
        body: { workflowPath },
      });
      await waitForPersistedRun(dbPath, startData.runId);

      const res = await fetch(`http://localhost:${port}/v1/runs/${startData.runId}/events?afterSeq=abc`);
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("application/json");
      const data = await res.json();
      expect(data.error.code).toBe("INVALID_REQUEST");
    });
    test("returns 404 for non-existent run", async () => {
      startTestServer();
      const res = await fetch(`http://localhost:${port}/v1/runs/non-existent-run-id/events`);
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error.code).toBe("NOT_FOUND");
    });
  });
  describe("POST /v1/runs/:runId/signals/:signalName", () => {
    test("delivers a signal to a persisted run", async () => {
      const { db, cleanup } = buildDb();
      ensureSmithersTables(db);
      const adapter = new SmithersDb(db);
      const runId = "http-signal-run";
      await adapter.insertRun({
        runId,
        workflowName: "signal-flow",
        status: "waiting-event",
        createdAtMs: Date.now(),
      });
      startTestServer({ db });
      const { status, data } = await request(`/v1/runs/${runId}/signals/${encodeURIComponent("deploy.ready")}`, {
        method: "POST",
        body: {
          data: { ok: true },
          correlationId: "ticket-42",
          receivedBy: "http-test",
        },
      });
      expect(status).toBe(200);
      expect(data).toMatchObject({
        runId,
        signalName: "deploy.ready",
        correlationId: "ticket-42",
      });
      const signals = await adapter.listSignals(runId, { signalName: "deploy.ready" });
      expect(signals).toHaveLength(1);
      expect(JSON.parse(signals[0].payloadJson)).toEqual({ ok: true });
      expect(signals[0].receivedBy).toBe("http-test");
      cleanup();
    });
  });
  describe("GET /metrics", () => {
    test("returns Prometheus metrics from the real HTTP server", async () => {
      startTestServer();
      const res = await fetch(`http://localhost:${port}/metrics`);
      const text = await res.text();
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/plain");
      expect(text).toContain("smithers_");
    });
  });
  describe("GET /v1/runs (list runs)", () => {
    test("returns 400 when server DB not configured", async () => {
      startTestServer();
      const { status, data } = await request("/v1/runs");
      expect(status).toBe(400);
      expect(data.error.code).toBe("DB_NOT_CONFIGURED");
    });
    test("returns runs list when server DB is configured", async () => {
      const { db, cleanup } = buildDb();
      ensureSmithersTables(db);
      startTestServer({ db: db });
      const { status, data } = await request("/v1/runs");
      expect(status).toBe(200);
      expect(Array.isArray(data)).toBe(true);
      cleanup();
    });
    test("respects limit and status params", async () => {
      const { db, cleanup } = buildDb();
      ensureSmithersTables(db);
      startTestServer({ db: db });
      const { status, data } = await request("/v1/runs?limit=10&status=running");
      expect(status).toBe(200);
      expect(Array.isArray(data)).toBe(true);
      cleanup();
    });
    test("keeps stale persisted status and exposes derived runState in the runs API", async () => {
      const { db, cleanup } = buildDb();
      ensureSmithersTables(db);
      const adapter = new SmithersDb(db);
      await adapter.insertRun({
        runId: "stale-running",
        workflowName: "stale-flow",
        status: "running",
        createdAtMs: Date.now() - 60_000,
        startedAtMs: Date.now() - 60_000,
        heartbeatAtMs: Date.now() - 60_000,
        runtimeOwnerId: "worker-1",
      });
      startTestServer({ db: db });
      const { status, data } = await request("/v1/runs?limit=10");
      expect(status).toBe(200);
      expect(Array.isArray(data)).toBe(true);
      expect(data[0]?.runId).toBe("stale-running");
      expect(data[0]?.status).toBe("running");
      expect(data[0]?.runState?.state).toBe("stale");
      expect(data[0]?.runState?.unhealthy?.kind).toBe("engine-heartbeat-stale");
      cleanup();
    });
  });
  describe("GET /v1/approval/list", () => {
    test("returns 400 when server DB is not configured", async () => {
      startTestServer();
      const { status, data } = await request("/v1/approval/list");
      expect(status).toBe(400);
      expect(data.error.code).toBe("DB_NOT_CONFIGURED");
    });
    test("returns pending approvals sorted by wait time", async () => {
      const { db, cleanup } = buildDb();
      ensureSmithersTables(db);
      const adapter = new SmithersDb(db);
      await adapter.insertRun({
        runId: "run-older",
        workflowName: "release-flow",
        status: "waiting-approval",
        createdAtMs: Date.now() - 10_000,
      });
      await adapter.insertRun({
        runId: "run-newer",
        workflowName: "qa-flow",
        status: "waiting-approval",
        createdAtMs: Date.now() - 9_000,
      });
      await adapter.insertNode({
        runId: "run-older",
        nodeId: "deploy",
        iteration: 0,
        state: "waiting-approval",
        lastAttempt: null,
        updatedAtMs: Date.now(),
        outputTable: "",
        label: "Deploy gate",
      });
      await adapter.insertNode({
        runId: "run-newer",
        nodeId: "review",
        iteration: 0,
        state: "waiting-approval",
        lastAttempt: null,
        updatedAtMs: Date.now(),
        outputTable: "",
        label: "Review gate",
      });
      await adapter.insertOrUpdateApproval({
        runId: "run-newer",
        nodeId: "review",
        iteration: 0,
        status: "requested",
        requestedAtMs: Date.now() - 2_000,
      });
      await adapter.insertOrUpdateApproval({
        runId: "run-older",
        nodeId: "deploy",
        iteration: 0,
        status: "requested",
        requestedAtMs: Date.now() - 8_000,
      });
      await adapter.insertOrUpdateApproval({
        runId: "run-older",
        nodeId: "cleanup",
        iteration: 0,
        status: "approved",
        decidedAtMs: Date.now(),
      });
      startTestServer({ db: db });
      const { status, data } = await request("/v1/approval/list");
      expect(status).toBe(200);
      expect(Array.isArray(data.approvals)).toBe(true);
      expect(data.approvals).toHaveLength(2);
      expect(data.approvals[0]).toMatchObject({
        runId: "run-older",
        nodeId: "deploy",
        workflowName: "release-flow",
        label: "Deploy gate",
      });
      expect(data.approvals[1]).toMatchObject({
        runId: "run-newer",
        nodeId: "review",
        workflowName: "qa-flow",
        label: "Review gate",
      });
      expect(typeof data.approvals[0].waitingMs).toBe("number");
      cleanup();
    });
  });
  describe("404 handling", () => {
    test("returns 404 for unknown routes", async () => {
      startTestServer();
      const { status, data } = await request("/v1/unknown-route");
      expect(status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
      expect(data.error.message).toBe("Route not found");
    });
    test("returns 404 for root path", async () => {
      startTestServer();
      const { status, data } = await request("/");
      expect(status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });
  });
  describe("Error handling", () => {
    test("returns 500 with error details on server error", async () => {
      startTestServer();
      const { status, data } = await request("/v1/runs", {
        method: "POST",
        body: { workflowPath: "/this/path/does/not/exist.ts" },
      });
      expect(status).toBe(500);
      expect(data.error.code).toBe("SERVER_ERROR");
      expect(data.error.message).toBeDefined();
    });
  });
});
