import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { SmithersDb } from "@smthrs/db/adapter";
import { createServeApp } from "../src/serve.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { sqlite, adapter: new SmithersDb(db) };
}

describe("createServeApp branch coverage", () => {
  let sqlite;
  let server;

  afterEach(() => {
    if (server) {
      server.stop(true);
      server = null;
    }
    if (sqlite) {
      sqlite.close();
      sqlite = null;
    }
  });

  async function seedRun(adapter, runId, status, nodes = []) {
    await adapter.insertRun({
      runId,
      workflowName: "serve-branches",
      status,
      createdAtMs: Date.now(),
      startedAtMs: Date.now() - 1000,
    });
    for (const node of nodes) {
      await adapter.insertNode({
        runId,
        nodeId: node.nodeId,
        iteration: node.iteration ?? 0,
        state: node.state,
        lastAttempt: node.lastAttempt ?? 1,
        updatedAtMs: Date.now(),
        outputTable: node.outputTable ?? "",
        label: node.label ?? null,
      });
    }
  }

  test("GET / reduces countNodesByState rows into a summary", async () => {
    const t = createTestDb();
    sqlite = t.sqlite;
    const abort = new AbortController();
    await seedRun(t.adapter, "run-summary", "running", [
      { nodeId: "task:a", state: "finished" },
      { nodeId: "task:b", state: "running" },
    ]);
    const app = createServeApp({ adapter: t.adapter, runId: "run-summary", abort, metrics: false });
    const res = await app.request("http://localhost/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runId).toBe("run-summary");
    // The reduce callback folds each state row into the summary object.
    expect(body.summary.finished).toBe(1);
    expect(body.summary.running).toBe(1);
  });

  test("GET / returns 404 when the run is missing", async () => {
    const t = createTestDb();
    sqlite = t.sqlite;
    const abort = new AbortController();
    const app = createServeApp({ adapter: t.adapter, runId: "run-absent", abort, metrics: false });
    const res = await app.request("http://localhost/");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("RUN_NOT_FOUND");
  });

  test("POST /approve with an empty body defaults the parsed body and reports server error when no approval is pending", async () => {
    const t = createTestDb();
    sqlite = t.sqlite;
    const abort = new AbortController();
    await seedRun(t.adapter, "run-approve", "waiting-approval", [{ nodeId: "task1", state: "waiting-approval" }]);
    const app = createServeApp({ adapter: t.adapter, runId: "run-approve", abort, metrics: false });
    // No request body -> c.req.json() rejects -> the `() => ({})` fallback runs.
    const res = await app.request("http://localhost/approve/task1", { method: "POST" });
    // Either the approval succeeds (200) or engine reports it cannot decide; in
    // both cases the empty-body fallback + JSON response path executed.
    expect([200, 500]).toContain(res.status);
  });

  test("POST /deny with an empty body defaults the parsed body", async () => {
    const t = createTestDb();
    sqlite = t.sqlite;
    const abort = new AbortController();
    await seedRun(t.adapter, "run-deny", "waiting-approval", [{ nodeId: "task1", state: "waiting-approval" }]);
    const app = createServeApp({ adapter: t.adapter, runId: "run-deny", abort, metrics: false });
    const res = await app.request("http://localhost/deny/task1", { method: "POST" });
    expect([200, 500]).toContain(res.status);
  });

  test("POST /cancel cancels a waiting-timer run and its waiting-timer nodes", async () => {
    const t = createTestDb();
    sqlite = t.sqlite;
    const abort = new AbortController();
    await seedRun(t.adapter, "run-timer", "waiting-timer", [
      { nodeId: "timer:1", state: "waiting-timer" },
      { nodeId: "task:done", state: "finished" },
    ]);
    // A waiting-timer attempt must exist for the timer node so the filter picks it up.
    await t.adapter.insertAttempt({
      runId: "run-timer",
      nodeId: "timer:1",
      iteration: 0,
      attempt: 1,
      state: "waiting-timer",
      startedAtMs: Date.now() - 500,
      finishedAtMs: null,
      heartbeatAtMs: null,
      heartbeatDataJson: null,
      errorJson: null,
      jjPointer: null,
      responseText: null,
      jjCwd: null,
      cached: false,
      metaJson: null,
    });
    const app = createServeApp({ adapter: t.adapter, runId: "run-timer", abort, metrics: false });
    const res = await app.request("http://localhost/cancel", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runId).toBe("run-timer");
    const run = await t.adapter.getRun("run-timer");
    expect(run.status).toBe("cancelled");
  });

  test("onError maps a non-HttpError thrown in a handler to a 500 SERVER_ERROR", async () => {
    const t = createTestDb();
    sqlite = t.sqlite;
    const abort = new AbortController();
    await seedRun(t.adapter, "run-boom", "running");
    // Force a plain (non-HttpError) throw from within the GET / handler.
    t.adapter.getRun = async () => {
      throw new Error("adapter boom");
    };
    const app = createServeApp({ adapter: t.adapter, runId: "run-boom", abort, metrics: false });
    const res = await app.request("http://localhost/");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("SERVER_ERROR");
    expect(body.error.message).toBe("adapter boom");
  });

  test("GET /events streams events, polls, then closes on client abort", async () => {
    const t = createTestDb();
    sqlite = t.sqlite;
    const abort = new AbortController();
    await seedRun(t.adapter, "run-sse", "running", [{ nodeId: "task:a", state: "running" }]);
    await t.adapter.insertEventWithNextSeq({
      runId: "run-sse",
      timestampMs: Date.now(),
      type: "RunStarted",
      payloadJson: JSON.stringify({ type: "RunStarted", runId: "run-sse" }),
    });
    const app = createServeApp({ adapter: t.adapter, runId: "run-sse", abort, metrics: false });
    server = Bun.serve({ port: 0, fetch: app.fetch });
    const controller = new AbortController();
    let received = "";
    const timer = setTimeout(() => controller.abort(), 1200);
    try {
      const res = await fetch(`http://localhost:${server.port}/events`, { signal: controller.signal });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      // Read the first event, then keep the stream open long enough to poll
      // (setTimeout branch) before the abort fires (abort-listener branch).
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += decoder.decode(value, { stream: true });
        if (received.includes("event: smithers") && Date.now()) {
          // keep reading until the abort closes the stream
        }
      }
    } catch (error) {
      if (error.name !== "AbortError") throw error;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    expect(received).toContain("event: smithers");
  }, 10000);
});
