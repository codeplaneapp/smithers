/** @jsxImportSource smthrs */
import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import { resolve } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { sleep } from "../../smithers/tests/helpers.js";
import { createServeApp } from "../src/serve.js";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { Effect } from "effect";
import { runWorkflow } from "@smthrs/engine";
import { renderPrometheusMetrics } from "@smthrs/observability";
// ---------------------------------------------------------------------------
// Prometheus helpers
// ---------------------------------------------------------------------------
/** Parse prometheus text format into a map of metric line key → numeric value */
function parsePrometheusText(text) {
  const metrics = new Map();
  for (const line of text.split("\n")) {
    if (line.startsWith("#") || !line.trim()) continue;
    const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(.+)$/);
    if (match) {
      const key = match[2] ? `${match[1]}${match[2]}` : match[1];
      const value = Number(match[3]);
      if (!isNaN(value)) metrics.set(key, value);
    }
  }
  return metrics;
}
/** Return the difference for a metric between two snapshots (0 if absent). */
function metricValue(snapshot, name) {
  let total = 0;
  for (const [key, value] of snapshot) {
    if (key === name || key.startsWith(`${name}{`)) {
      total += value;
    }
  }
  return total;
}
/** Return the difference for a metric between two snapshots (0 if absent). */
function metricDelta(before, after, name) {
  return metricValue(after, name) - metricValue(before, name);
}
/**
 * @param {BunServer} server
 * @returns {number}
 */
function getPort(server) {
  if (server.port === undefined) {
    throw new Error("Bun server did not expose a port");
  }
  return server.port;
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
    const contentType = res.headers.get("content-type") ?? "";
    let data;
    if (contentType.includes("text/event-stream")) {
      data = await res.text();
    } else if (contentType.includes("application/json")) {
      data = await res.json();
    } else {
      data = await res.text();
    }
    return { status: res.status, data, headers: res.headers };
  };
}
describe("Hono Serve Mode", () => {
  let server = null;
  let testDir;
  let port;
  let request;
  let abort;
  let runPromises;
  let workflowDbs;
  beforeEach(() => {
    testDir = resolve(process.cwd(), "tests", ".test-serve-" + Math.random().toString(36).slice(2));
    mkdirSync(testDir, { recursive: true });
    abort = new AbortController();
    runPromises = [];
    workflowDbs = [];
  });
  afterEach(async () => {
    abort.abort();
    if (server) {
      server.stop(true);
      server = null;
    }
    await Promise.race([Promise.allSettled(runPromises), sleep(5_000)]);
    for (const db of workflowDbs.splice(0)) {
      try {
        db?.$client?.close?.();
      } catch {}
    }
    await sleep(50);
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });
  /**
   * @param {string} name
   * @param {string} dbPath
   * @param {{ needsApproval?: boolean; slow?: boolean }} [options]
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
    writeFileSync(
      workflowPath,
      `/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs";
import { z } from "zod";
${slowAgent}

const { smithers, Workflow, Task, outputs } = createSmithers(
  { outputA: z.object({ value: z.number() }) },
  { dbPath: ${JSON.stringify(dbPath)} },
);

export default smithers((ctx) => (
  <Workflow name="${name}">
    <Task id="task1" output={outputs.outputA}${agentProp}${approvalProp}>
      ${options.slow ? "run task" : "{{ value: 42 }}"}
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
      `/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
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
  /**
   * @param {string} workflowPath
   * @returns {Promise<SmithersWorkflow<any>>}
   */
  async function loadWorkflow(workflowPath) {
    const abs = resolve(process.cwd(), workflowPath);
    const mod = await import(pathToFileURL(abs).href);
    return mod.default;
  }
  /**
   * @param {string} workflowPath
   * @param {{ needsApproval?: boolean; slow?: boolean; authToken?: string; startRun?: boolean; metrics?: boolean; insecure?: boolean; }} [opts]
   */
  async function startServeApp(workflowPath, opts = {}) {
    const workflow = await loadWorkflow(workflowPath);
    workflowDbs.push(workflow.db);
    ensureSmithersTables(workflow.db);
    const adapter = new SmithersDb(workflow.db);
    const runId = `test-run-${Date.now()}`;
    const startRun = opts.startRun !== false;
    if (startRun) {
      const runPromise = Effect.runPromise(
        runWorkflow(workflow, {
          runId,
          input: {},
          workflowPath: resolve(process.cwd(), workflowPath),
          signal: abort.signal,
        }),
      ).catch(() => {});
      runPromises.push(runPromise);
      // Wait for the run row to exist instead of relying on a fixed startup delay.
      for (let i = 0; i < 40; i++) {
        const run = await adapter.getRun(runId);
        if (run) break;
        await sleep(50);
      }
    }
    const app = createServeApp({
      workflow,
      adapter,
      runId,
      abort,
      authToken: opts.authToken,
      metrics: opts.metrics,
      insecure: opts.insecure,
    });
    server = Bun.serve({ port: 0, fetch: app.fetch });
    port = getPort(server);
    request = makeRequest(port);
    return { workflow, adapter, runId, app };
  }
  /**
   * @param {string[]} statuses
   */
  async function waitForServeRunStatus(statuses, timeoutMs = 5_000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const { status, data } = await request("/");
      if (status === 200 && statuses.includes(data.status)) {
        return data;
      }
      await sleep(50);
    }
    throw new Error(`Timed out waiting for serve run to reach one of: ${statuses.join(", ")}`);
  }
  // =========================================================================
  // Status
  // =========================================================================
  describe("GET /", () => {
    test("returns run status for a running workflow", async () => {
      const dbPath = resolve(testDir, "status.db");
      const workflowPath = writeTestWorkflow("status", dbPath, { slow: true });
      const { runId } = await startServeApp(workflowPath, { slow: true });
      const { status, data } = await request("/");
      expect(status).toBe(200);
      expect(data.runId).toBe(runId);
      expect(data.status).toBeDefined();
      expect(data.workflowName).toBeDefined();
      expect(data.summary).toBeDefined();
    });
    test("returns status after workflow completes", async () => {
      const dbPath = resolve(testDir, "finished.db");
      const workflowPath = writeTestWorkflow("finished", dbPath);
      const { runId } = await startServeApp(workflowPath);
      // Wait for fast workflow to finish
      await sleep(2000);
      const { status, data } = await request("/");
      expect(status).toBe(200);
      expect(data.runId).toBe(runId);
      expect(["finished", "running"]).toContain(data.status);
    });
  });
  // =========================================================================
  // Health
  // =========================================================================
  describe("GET /health", () => {
    test("returns ok even when auth is configured", async () => {
      const dbPath = resolve(testDir, "health.db");
      const workflowPath = writeTestWorkflow("health", dbPath, { slow: true });
      await startServeApp(workflowPath, {
        slow: true,
        authToken: "secret-token",
      });
      const { status, data } = await request("/health");
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
    });
  });
  // =========================================================================
  // Auth
  // =========================================================================
  describe("Auth", () => {
    test("rejects requests without token when auth is set", async () => {
      const dbPath = resolve(testDir, "auth-reject.db");
      const workflowPath = writeTestWorkflow("auth-reject", dbPath, {
        slow: true,
      });
      await startServeApp(workflowPath, {
        slow: true,
        authToken: "secret",
      });
      const { status, data } = await request("/");
      expect(status).toBe(401);
      expect(data.error.code).toBe("UNAUTHORIZED");
    });
    test("accepts Authorization: Bearer header", async () => {
      const dbPath = resolve(testDir, "auth-bearer.db");
      const workflowPath = writeTestWorkflow("auth-bearer", dbPath, {
        slow: true,
      });
      const { runId } = await startServeApp(workflowPath, {
        slow: true,
        authToken: "secret",
      });
      const { status, data } = await request("/", {
        headers: { Authorization: "Bearer secret" },
      });
      expect(status).toBe(200);
      expect(data.runId).toBe(runId);
    });
    test("accepts x-smithers-key header", async () => {
      const dbPath = resolve(testDir, "auth-key.db");
      const workflowPath = writeTestWorkflow("auth-key", dbPath, {
        slow: true,
      });
      const { runId } = await startServeApp(workflowPath, {
        slow: true,
        authToken: "secret",
      });
      const { status, data } = await request("/", {
        headers: { "x-smithers-key": "secret" },
      });
      expect(status).toBe(200);
      expect(data.runId).toBe(runId);
    });
    test("all routes accessible without auth when no token configured", async () => {
      const dbPath = resolve(testDir, "no-auth.db");
      const workflowPath = writeTestWorkflow("no-auth", dbPath, {
        slow: true,
      });
      await startServeApp(workflowPath, { slow: true });
      const { status } = await request("/");
      expect(status).toBe(200);
      const { status: healthStatus } = await request("/health");
      expect(healthStatus).toBe(200);
    });
  });
  // =========================================================================
  // Host / Origin rebinding + CSRF defense (unauthenticated bind)
  // =========================================================================
  describe("Host / Origin defense", () => {
    test("rejects a non-loopback Host on run-control routes (DNS rebinding)", async () => {
      const dbPath = resolve(testDir, "host-defense.db");
      const workflowPath = writeTestWorkflow("host-defense", dbPath, { slow: true });
      await startServeApp(workflowPath, { slow: true });
      for (const [path, method] of [
        ["/", "GET"],
        ["/cancel", "POST"],
        ["/approve/task1", "POST"],
      ]) {
        const { status, data } = await request(path, { method, headers: { Host: "evil.com" } });
        expect(status).toBe(403);
        expect(data.error.code).toBe("FORBIDDEN");
        expect(data.error.message).toBe("Host is not allowed");
      }
    });
    test("rejects a cross-origin Origin even when the Host is loopback (simple-POST /cancel CSRF)", async () => {
      const dbPath = resolve(testDir, "origin-defense.db");
      const workflowPath = writeTestWorkflow("origin-defense", dbPath, { slow: true });
      await startServeApp(workflowPath, { slow: true });
      const { status, data } = await request("/cancel", {
        method: "POST",
        headers: { Origin: "http://evil.com" },
      });
      expect(status).toBe(403);
      expect(data.error.code).toBe("FORBIDDEN");
      expect(data.error.message).toBe("Origin is not allowed");
    });
    test("allows loopback Host variants and a same-origin (loopback) Origin", async () => {
      const dbPath = resolve(testDir, "loopback-allowed.db");
      const workflowPath = writeTestWorkflow("loopback-allowed", dbPath, { slow: true });
      const { runId } = await startServeApp(workflowPath, { slow: true });
      for (const host of ["127.0.0.1:9999", "localhost:1234", "[::1]:9999", "sub.localhost"]) {
        const { status, data } = await request("/", { headers: { Host: host } });
        expect(status).toBe(200);
        expect(data.runId).toBe(runId);
      }
      const okOrigin = await request("/", { headers: { Origin: "http://127.0.0.1:9999" } });
      expect(okOrigin.status).toBe(200);
      expect(okOrigin.data.runId).toBe(runId);
    });
    test("health check is exempt from the host defense", async () => {
      const dbPath = resolve(testDir, "host-health-exempt.db");
      const workflowPath = writeTestWorkflow("host-health-exempt", dbPath, { slow: true });
      await startServeApp(workflowPath, { slow: true });
      const { status, data } = await request("/health", { headers: { Host: "evil.com" } });
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
    });
    test("skips the host defense when a token is configured (token is the gate)", async () => {
      const dbPath = resolve(testDir, "host-auth.db");
      const workflowPath = writeTestWorkflow("host-auth", dbPath, { slow: true });
      const { runId } = await startServeApp(workflowPath, { slow: true, authToken: "secret" });
      const { status, data } = await request("/", {
        headers: { Host: "evil.com", "x-smithers-key": "secret" },
      });
      expect(status).toBe(200);
      expect(data.runId).toBe(runId);
    });
    test("opts.insecure opts out of the host defense", async () => {
      const dbPath = resolve(testDir, "host-insecure.db");
      const workflowPath = writeTestWorkflow("host-insecure", dbPath, { slow: true });
      const { runId } = await startServeApp(workflowPath, { slow: true, insecure: true });
      const { status, data } = await request("/", { headers: { Host: "evil.com" } });
      expect(status).toBe(200);
      expect(data.runId).toBe(runId);
    });
    test("SMITHERS_SERVE_TRUST_ANY_HOST=1 opts out of the host defense", async () => {
      const saved = process.env.SMITHERS_SERVE_TRUST_ANY_HOST;
      try {
        process.env.SMITHERS_SERVE_TRUST_ANY_HOST = "1";
        const dbPath = resolve(testDir, "host-trust-env.db");
        const workflowPath = writeTestWorkflow("host-trust-env", dbPath, { slow: true });
        const { runId } = await startServeApp(workflowPath, { slow: true });
        const { status, data } = await request("/", { headers: { Host: "evil.com" } });
        expect(status).toBe(200);
        expect(data.runId).toBe(runId);
      } finally {
        if (saved === undefined) delete process.env.SMITHERS_SERVE_TRUST_ANY_HOST;
        else process.env.SMITHERS_SERVE_TRUST_ANY_HOST = saved;
      }
    });
  });
  // =========================================================================
  // Approve / Deny
  // =========================================================================
  describe("POST /approve/:nodeId", () => {
    test("approves a waiting-approval task", async () => {
      const dbPath = resolve(testDir, "approve.db");
      const workflowPath = writeTestWorkflow("approve", dbPath, {
        needsApproval: true,
      });
      const { runId } = await startServeApp(workflowPath, {
        needsApproval: true,
      });
      await waitForServeRunStatus(["waiting-approval"]);
      const { status, data } = await request("/approve/task1", {
        method: "POST",
        body: {
          iteration: 0,
          note: "approved by test",
          decidedBy: "test-user",
        },
      });
      expect(status).toBe(200);
      expect(data.runId).toBe(runId);
    });
    test("persists a select decision", async () => {
      const dbPath = resolve(testDir, "approve-select.db");
      const workflowPath = writeSelectApprovalWorkflow("approve-select", dbPath);
      const { adapter, runId } = await startServeApp(workflowPath);
      await waitForServeRunStatus(["waiting-approval"]);
      const { status, data } = await request("/approve/task1", {
        method: "POST",
        body: { decision: { selected: "balanced", notes: "best fit" } },
      });
      expect(status).toBe(200);
      expect(data.runId).toBe(runId);
      const approval = await adapter.getApproval(runId, "task1", 0);
      expect(approval?.status).toBe("approved");
      expect(JSON.parse(approval?.decisionJson ?? "null")).toEqual({
        selected: "balanced",
        notes: "best fit",
      });
    });
    test("rejects a select approval without a usable decision", async () => {
      const dbPath = resolve(testDir, "approve-select-invalid.db");
      const workflowPath = writeSelectApprovalWorkflow("approve-select-invalid", dbPath);
      const { adapter, runId } = await startServeApp(workflowPath);
      await waitForServeRunStatus(["waiting-approval"]);
      const { status, data } = await request("/approve/task1", {
        method: "POST",
        body: { decision: { selected: "unknown" } },
      });
      expect(status).toBe(400);
      expect(data.error.code).toBe("INVALID_REQUEST");
      expect(data.error.message).toContain("unknown");
      expect((await adapter.getApproval(runId, "task1", 0))?.status).toBe("requested");
    });
    test("unwraps and persists a stable nested select decision", async () => {
      const dbPath = resolve(testDir, "approve-select-nested.db");
      const workflowPath = writeSelectApprovalWorkflow("approve-select-nested", dbPath);
      const { adapter, runId } = await startServeApp(workflowPath);
      await waitForServeRunStatus(["waiting-approval"]);
      const { status } = await request("/approve/task1", {
        method: "POST",
        body: {
          decision: {
            approved: true,
            value: { selected: "balanced", notes: "best fit" },
            note: "lgtm",
          },
        },
      });
      expect(status).toBe(200);
      const approval = await adapter.getApproval(runId, "task1", 0);
      expect(JSON.parse(approval?.decisionJson ?? "null")).toEqual({
        selected: "balanced",
        notes: "best fit",
      });
      expect(approval?.note).toBe("lgtm");
    });
  });
  describe("POST /deny/:nodeId", () => {
    test("denies a waiting-approval task", async () => {
      const dbPath = resolve(testDir, "deny.db");
      const workflowPath = writeTestWorkflow("deny", dbPath, {
        needsApproval: true,
      });
      const { adapter, runId } = await startServeApp(workflowPath, {
        needsApproval: true,
      });
      await waitForServeRunStatus(["waiting-approval"]);
      const { status, data } = await request("/deny/task1", {
        method: "POST",
        body: {
          iteration: 0,
          decision: { approved: false, value: { reason: "unsafe" }, note: "denied by test" },
          decidedBy: "test-user",
        },
      });
      expect(status).toBe(200);
      expect(data.runId).toBe(runId);
      const approval = await adapter.getApproval(runId, "task1", 0);
      expect(approval?.note).toBe("denied by test");
      expect(JSON.parse(approval?.decisionJson ?? "null")).toEqual({ reason: "unsafe" });
    });
  });
  // =========================================================================
  // Cancel
  // =========================================================================
  describe("POST /cancel", () => {
    test("cancels a running workflow", async () => {
      const dbPath = resolve(testDir, "cancel.db");
      const workflowPath = writeTestWorkflow("cancel", dbPath, { slow: true });
      const { runId } = await startServeApp(workflowPath, { slow: true });
      const { status, data } = await request("/cancel", { method: "POST" });
      expect(status).toBe(200);
      expect(data.runId).toBe(runId);
    });
    test("returns 409 for non-running workflow", async () => {
      const dbPath = resolve(testDir, "cancel-done.db");
      const workflowPath = writeTestWorkflow("cancel-done", dbPath);
      await startServeApp(workflowPath);
      // Wait for fast workflow to finish
      await sleep(2000);
      const { status, data } = await request("/cancel", { method: "POST" });
      expect(status).toBe(409);
      expect(data.error.code).toBe("RUN_NOT_ACTIVE");
    });
  });
  // =========================================================================
  // Events (SSE)
  // =========================================================================
  describe("GET /events", () => {
    test("returns text/event-stream content type", async () => {
      const dbPath = resolve(testDir, "events.db");
      const workflowPath = writeTestWorkflow("events", dbPath, { slow: true });
      await startServeApp(workflowPath, { slow: true });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1000);
      try {
        const res = await fetch(`http://localhost:${port}/events`, {
          signal: controller.signal,
        });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/event-stream");
      } catch (e) {
        if (e.name !== "AbortError") throw e;
      } finally {
        clearTimeout(timeout);
        controller.abort();
      }
    });
    test("streams real events", async () => {
      const dbPath = resolve(testDir, "events-stream.db");
      const workflowPath = writeTestWorkflow("events-stream", dbPath, {
        slow: true,
      });
      await startServeApp(workflowPath, { slow: true });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      let receivedData = "";
      try {
        const res = await fetch(`http://localhost:${port}/events`, {
          signal: controller.signal,
        });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          receivedData += decoder.decode(value, { stream: true });
          // Once we have some events, break
          if (receivedData.includes("event: smithers")) break;
        }
      } catch (e) {
        if (e.name !== "AbortError") throw e;
      } finally {
        clearTimeout(timeout);
        controller.abort();
      }
      expect(receivedData).toContain("event: smithers");
      expect(receivedData).toContain("data: ");
    });
    test("supports afterSeq query param", async () => {
      const dbPath = resolve(testDir, "events-seq.db");
      const workflowPath = writeTestWorkflow("events-seq", dbPath, {
        slow: true,
      });
      await startServeApp(workflowPath, { slow: true });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1000);
      try {
        const res = await fetch(`http://localhost:${port}/events?afterSeq=999999`, { signal: controller.signal });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/event-stream");
      } catch (e) {
        if (e.name !== "AbortError") throw e;
      } finally {
        clearTimeout(timeout);
        controller.abort();
      }
    });
  });
  // =========================================================================
  // Frames
  // =========================================================================
  describe("GET /frames", () => {
    test("returns array of rendered frames", async () => {
      const dbPath = resolve(testDir, "frames.db");
      const workflowPath = writeTestWorkflow("frames", dbPath, { slow: true });
      await startServeApp(workflowPath, { slow: true });
      const { status, data } = await request("/frames");
      expect(status).toBe(200);
      expect(Array.isArray(data)).toBe(true);
    });
    test("respects limit param", async () => {
      const dbPath = resolve(testDir, "frames-limit.db");
      const workflowPath = writeTestWorkflow("frames-limit", dbPath, {
        slow: true,
      });
      await startServeApp(workflowPath, { slow: true });
      const { status, data } = await request("/frames?limit=1");
      expect(status).toBe(200);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeLessThanOrEqual(1);
    });
  });
  // =========================================================================
  // Metrics
  // =========================================================================
  describe("GET /metrics", () => {
    test("returns prometheus text format", async () => {
      const dbPath = resolve(testDir, "metrics.db");
      const workflowPath = writeTestWorkflow("metrics", dbPath, {
        slow: true,
      });
      await startServeApp(workflowPath, { slow: true });
      const res = await fetch(`http://localhost:${port}/metrics`);
      expect(res.status).toBe(200);
      const contentType = res.headers.get("content-type") ?? "";
      expect(contentType).toContain("text/plain");
      const body = await res.text();
      expect(body.length).toBeGreaterThan(0);
    });
    test("returns 404 when metrics disabled", async () => {
      const dbPath = resolve(testDir, "no-metrics.db");
      const workflowPath = writeTestWorkflow("no-metrics", dbPath, {
        slow: true,
      });
      await startServeApp(workflowPath, { slow: true, metrics: false });
      const { status, data } = await request("/metrics");
      expect(status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });
  });
  // =========================================================================
  // Metrics validation — assert prometheus counters after real operations
  // =========================================================================
  describe("Metrics after operations", () => {
    test("completed workflow increments run and node counters", async () => {
      const before = parsePrometheusText(renderPrometheusMetrics());
      const dbPath = resolve(testDir, "m-complete.db");
      const workflowPath = writeTestWorkflow("m-complete", dbPath);
      await startServeApp(workflowPath);
      await sleep(2000);
      const res = await fetch(`http://localhost:${port}/metrics`);
      const after = parsePrometheusText(await res.text());
      // Run lifecycle
      expect(metricDelta(before, after, "smithers_runs_total")).toBeGreaterThanOrEqual(1);
      expect(metricDelta(before, after, "smithers_runs_finished_total")).toBeGreaterThanOrEqual(1);
      // Node lifecycle (the test workflow has one task)
      expect(metricDelta(before, after, "smithers_nodes_started")).toBeGreaterThanOrEqual(1);
      expect(metricDelta(before, after, "smithers_nodes_finished")).toBeGreaterThanOrEqual(1);
      // Events emitted
      expect(metricDelta(before, after, "smithers_events_emitted_total")).toBeGreaterThanOrEqual(1);
      // Duration histograms should have at least one observation
      expect(metricDelta(before, after, "smithers_run_duration_ms_count")).toBeGreaterThanOrEqual(1);
      expect(metricDelta(before, after, "smithers_node_duration_ms_count")).toBeGreaterThanOrEqual(1);
    });
    test("http request metrics increment across multiple requests", async () => {
      const dbPath = resolve(testDir, "m-http.db");
      const workflowPath = writeTestWorkflow("m-http", dbPath, { slow: true });
      await startServeApp(workflowPath, { slow: true });
      // Take baseline after server is up (metrics are global)
      const before = parsePrometheusText(renderPrometheusMetrics());
      // Make several requests through the Hono app
      await request("/");
      await request("/health");
      await request("/frames");
      const res = await fetch(`http://localhost:${port}/metrics`);
      const after = parsePrometheusText(await res.text());
      // HTTP request metrics are emitted with route/status labels, so sum the
      // matching series instead of looking for a single untagged sample.
      expect(metricDelta(before, after, "smithers_http_requests")).toBeGreaterThanOrEqual(2);
      // Duration histogram should also have observations
      expect(metricDelta(before, after, "smithers_http_request_duration_ms_count")).toBeGreaterThanOrEqual(2);
    });
    test("approved task increments approval counters", async () => {
      const before = parsePrometheusText(renderPrometheusMetrics());
      const dbPath = resolve(testDir, "m-approve.db");
      const workflowPath = writeTestWorkflow("m-approve", dbPath, {
        needsApproval: true,
      });
      await startServeApp(workflowPath, { needsApproval: true });
      await waitForServeRunStatus(["waiting-approval"]);
      await request("/approve/task1", {
        method: "POST",
        body: { iteration: 0, note: "approved", decidedBy: "test" },
      });
      await sleep(500);
      const res = await fetch(`http://localhost:${port}/metrics`);
      const after = parsePrometheusText(await res.text());
      expect(metricDelta(before, after, "smithers_approvals_requested")).toBeGreaterThanOrEqual(1);
      expect(metricDelta(before, after, "smithers_approvals_granted")).toBeGreaterThanOrEqual(1);
    });
    test("denied task increments denial counters", async () => {
      const before = parsePrometheusText(renderPrometheusMetrics());
      const dbPath = resolve(testDir, "m-deny.db");
      const workflowPath = writeTestWorkflow("m-deny", dbPath, {
        needsApproval: true,
      });
      await startServeApp(workflowPath, { needsApproval: true });
      await waitForServeRunStatus(["waiting-approval"]);
      await request("/deny/task1", {
        method: "POST",
        body: { iteration: 0, note: "denied", decidedBy: "test" },
      });
      await sleep(500);
      const res = await fetch(`http://localhost:${port}/metrics`);
      const after = parsePrometheusText(await res.text());
      expect(metricDelta(before, after, "smithers_approvals_requested")).toBeGreaterThanOrEqual(1);
      expect(metricDelta(before, after, "smithers_approvals_denied")).toBeGreaterThanOrEqual(1);
    });
    test("no run-failed or node-failed counters after clean completion", async () => {
      const before = parsePrometheusText(renderPrometheusMetrics());
      const dbPath = resolve(testDir, "m-clean.db");
      const workflowPath = writeTestWorkflow("m-clean", dbPath);
      await startServeApp(workflowPath);
      await sleep(2000);
      const res = await fetch(`http://localhost:${port}/metrics`);
      const after = parsePrometheusText(await res.text());
      // A clean run should not increment failure counters
      expect(metricDelta(before, after, "smithers_runs_failed_total")).toBe(0);
      expect(metricDelta(before, after, "smithers_nodes_failed")).toBe(0);
    });
  });
  // =========================================================================
  // 404
  // =========================================================================
  describe("404 handling", () => {
    test("returns 404 for unknown routes", async () => {
      const dbPath = resolve(testDir, "notfound.db");
      const workflowPath = writeTestWorkflow("notfound", dbPath, {
        slow: true,
      });
      await startServeApp(workflowPath, { slow: true });
      const { status, data } = await request("/v1/unknown-route");
      expect(status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });
  });
});
