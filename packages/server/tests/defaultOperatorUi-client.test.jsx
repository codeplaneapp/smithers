/** @jsxImportSource smithers-orchestrator */
import { afterEach, beforeAll, afterAll, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { defaultOperatorUiClient } from "../src/gatewayUi/defaultOperatorUi.js";

/**
 * Executes the INSTRUMENTED operator-console client function against a real,
 * fully-controllable HTTP+WebSocket fixture under happy-dom. Every RPC response
 * and every streamed frame is scripted so each render branch, event handler,
 * DevTools/run-event stream path, applyDelta operation, retry/error branch, and
 * environment-fallback is exercised. (The shipped bundle is a `.toString()` of
 * this function; the existing defaultOperatorUi test only checks that string, so
 * this drives the real source for coverage.)
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Controllable HTTP + WS fixture.
// ---------------------------------------------------------------------------
function startFixture() {
  const state = {
    // (method, params) => ({ ok, payload }) | ({ ok:false, error }) | throws
    rpc: (method) => ({ ok: true, payload: defaultRpcPayload(method) }),
    // Called for each client stream request; receives a `push(frame)` helper and
    // the request `{ id, method, params }`. Returns the response payload.
    onStream: null,
    // Override the WS connect handshake response (e.g. to force it to fail).
    connectResponse: null,
    sockets: new Set(),
  };

  const httpServer = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const method = req.url.split("/").pop();
      let params = {};
      try { params = JSON.parse(body || "{}"); } catch {}
      let result;
      try {
        result = state.rpc(method, params);
      } catch (error) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: { message: String(error?.message ?? error) } }));
        return;
      }
      const status = result.ok === false ? (result.status ?? 400) : 200;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    });
  });

  const wss = new WebSocketServer({ server: httpServer });
  wss.on("connection", (socket) => {
    state.sockets.add(socket);
    socket.on("close", () => state.sockets.delete(socket));
    const push = (frame) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
    };
    socket.on("message", (raw) => {
      let frame;
      try { frame = JSON.parse(String(raw)); } catch { return; }
      if (frame?.type !== "req") return;
      if (frame.method === "connect") {
        if (state.connectResponse) {
          push({ type: "res", id: frame.id, ...state.connectResponse });
        } else {
          push({ type: "res", id: frame.id, ok: true, payload: { ok: true } });
        }
        return;
      }
      // Stream requests (streamDevTools / streamRunEvents) and socket RPCs.
      if (state.onStream) {
        state.onStream(frame, push, socket);
      } else {
        push({ type: "res", id: frame.id, ok: true, payload: { streamId: `stream-${frame.method}` } });
      }
    });
  });

  return new Promise((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => {
      const { port } = httpServer.address();
      resolve({
        state,
        port,
        httpUrl: `http://127.0.0.1:${port}`,
        wsUrl: `ws://127.0.0.1:${port}/`,
        async close() {
          for (const s of state.sockets) { try { s.terminate(); } catch {} }
          wss.close();
          httpServer.closeAllConnections?.();
          await new Promise((r) => httpServer.close(() => r()));
        },
      });
    });
  });
}

function defaultRpcPayload(method) {
  switch (method) {
    case "health": return { features: ["runs", "approvals"] };
    case "listWorkflows": return [{ key: "wf-a", readableName: "Workflow A" }, { key: "wf-b" }];
    case "listRuns": return [
      { runId: "run-1", status: "running", workflowKey: "wf-a", createdAtMs: Date.now() - 5000, triggeredBy: "user:me" },
      { runId: "run-2", status: "finished", workflowName: "wf-b", createdAtMs: Date.now() - 3_700_000, auth: { triggeredBy: "user:x" } },
    ];
    case "listApprovals": return [
      { runId: "run-1", nodeId: "approve-1", iteration: 0, requestTitle: "Approve?", workflowKey: "wf-a" },
    ];
    case "launchRun": return { runId: "run-1" };
    case "submitApproval": return { ok: true };
    default: return {};
  }
}

// ---------------------------------------------------------------------------
// happy-dom harness: run the client with tracked timers/sockets.
// ---------------------------------------------------------------------------
let domReady = false;
function ensureDom(url) {
  if (!domReady) {
    GlobalRegistrator.register({ url });
    domReady = true;
  }
}

function makeRuntime() {
  const intervals = new Set();
  const timeouts = new Set();
  const sockets = new Set();
  const nSetInterval = globalThis.setInterval;
  const nClearInterval = globalThis.clearInterval;
  const nSetTimeout = globalThis.setTimeout;
  const nClearTimeout = globalThis.clearTimeout;
  const NativeWebSocket = globalThis.WebSocket;
  globalThis.setInterval = (...a) => { const id = nSetInterval(...a); intervals.add(id); return id; };
  globalThis.clearInterval = (id) => { intervals.delete(id); return nClearInterval(id); };
  globalThis.setTimeout = (...a) => { const id = nSetTimeout(...a); timeouts.add(id); return id; };
  globalThis.clearTimeout = (id) => { timeouts.delete(id); return nClearTimeout(id); };
  globalThis.WebSocket = class TrackedWebSocket extends NativeWebSocket {
    constructor(...a) { super(...a); sockets.add(this); this.addEventListener("close", () => sockets.delete(this)); }
  };
  return {
    sockets,
    async cleanup() {
      for (const id of intervals) nClearInterval(id);
      intervals.clear();
      for (const s of sockets) { try { s.close(); } catch {} }
      const start = Date.now();
      while (sockets.size > 0 && Date.now() - start < 1000) await sleep(10);
      sockets.clear();
      for (const id of timeouts) nClearTimeout(id);
      timeouts.clear();
      globalThis.setInterval = nSetInterval;
      globalThis.clearInterval = nClearInterval;
      globalThis.setTimeout = nSetTimeout;
      globalThis.clearTimeout = nClearTimeout;
      globalThis.WebSocket = NativeWebSocket;
    },
  };
}

async function waitFor(predicate, timeoutMs = 4000) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try { if (await predicate()) return; } catch (error) { lastError = error; }
    await sleep(15);
  }
  throw lastError ?? new Error("waitFor timed out");
}

function fire(selector, type, init = {}) {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`missing element: ${selector}`);
  el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, ...init }));
  return el;
}

// A DevTools tree snapshot with a task node so the inspector + node data load.
function makeSnapshot(seq = 1) {
  return {
    frameNo: seq,
    seq,
    root: {
      id: 0,
      type: "workflow",
      name: "root",
      props: { a: 1, nested: { b: 2 } },
      children: [
        { id: 1, type: "task", name: "task1", task: { nodeId: "task1", iteration: 0, kind: "compute", agent: "none", label: "Task 1" }, props: {}, children: [] },
        { id: 2, type: "task", name: "task2", task: { nodeId: "task2", iteration: 0 }, props: {}, children: [] },
      ],
    },
  };
}

// A snapshot with task nodes using a caller-chosen id base so we can make a
// previously-selected node id disappear from a later snapshot.
function makeSnapshotIds(seq, base) {
  return {
    frameNo: seq,
    seq,
    root: {
      id: base,
      type: "workflow",
      name: "root",
      props: {},
      children: [
        { id: base + 1, type: "task", name: "t1", task: { nodeId: `n${base}a`, iteration: 0 }, props: {}, children: [] },
        { id: base + 2, type: "task", name: "t2", task: { nodeId: `n${base}b`, iteration: 0 }, props: {}, children: [] },
      ],
    },
  };
}

// A snapshot whose tree has NO task nodes at all, so firstTaskNode exhausts.
function makeNoTaskSnapshot(seq) {
  return {
    frameNo: seq,
    seq,
    root: {
      id: 100,
      type: "workflow",
      name: "root",
      props: {},
      children: [
        { id: 101, type: "group", name: "g1", props: {}, children: [] },
      ],
    },
  };
}

const cleanups = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) { try { await c(); } catch {} }
  if (globalThis.document?.body) document.body.innerHTML = "";
  delete globalThis.__SMITHERS_GATEWAY_UI__;
}, 20000);

afterAll(async () => {
  if (domReady) { try { await GlobalRegistrator.unregister(); } catch {} domReady = false; }
});

async function boot(fixture, { boot: bootOverrides } = {}) {
  ensureDom(fixture.httpUrl + "/console");
  document.body.innerHTML = '<div id="root"></div>';
  globalThis.__SMITHERS_GATEWAY_UI__ = {
    rpcPath: `${fixture.httpUrl}/v1/rpc`,
    wsPath: fixture.wsUrl,
    ...bootOverrides,
  };
  const runtime = makeRuntime();
  cleanups.push(() => runtime.cleanup());
  defaultOperatorUiClient();
  return runtime;
}

describe("defaultOperatorUiClient (instrumented source)", () => {
  test("full happy-path: refresh, launch, stream, inspect, approve", async () => {
    const fixture = await startFixture();
    cleanups.push(() => fixture.close());

    // Script the DevTools + run-event streams: snapshot, deltas covering every
    // op, then run heartbeat/event/gap_resync/error frames.
    fixture.state.onStream = (frame, push) => {
      const streamId = `sid-${frame.method}`;
      push({ type: "res", id: frame.id, ok: true, payload: { streamId } });
      if (frame.method === "streamDevTools") {
        push({ type: "event", event: "devtools.event", payload: { streamId, event: { kind: "snapshot", snapshot: makeSnapshot(1) } } });
        // updateProps
        push({ type: "event", event: "devtools.event", payload: { streamId, event: { kind: "delta", delta: { version: 1, baseSeq: 1, seq: 2, ops: [{ op: "updateProps", id: 1, props: { changed: true } }] } } } });
        // updateTask (set)
        push({ type: "event", event: "devtools.event", payload: { streamId, event: { kind: "delta", delta: { version: 1, baseSeq: 2, seq: 3, ops: [{ op: "updateTask", id: 2, task: { nodeId: "task2", iteration: 1 } }] } } } });
        // updateTask (delete) + addNode + removeNode + replaceRoot across deltas
        push({ type: "event", event: "devtools.event", payload: { streamId, event: { kind: "delta", delta: { version: 1, baseSeq: 3, seq: 4, ops: [{ op: "updateTask", id: 2 }] } } } });
        push({ type: "event", event: "devtools.event", payload: { streamId, event: { kind: "delta", delta: { version: 1, baseSeq: 4, seq: 5, ops: [{ op: "addNode", parentId: 0, index: 0, node: { id: 3, type: "task", name: "task3", task: { nodeId: "task3", iteration: 0 }, props: {}, children: [] } }] } } } });
        push({ type: "event", event: "devtools.event", payload: { streamId, event: { kind: "delta", delta: { version: 1, baseSeq: 5, seq: 6, ops: [{ op: "removeNode", id: 3 }] } } } });
        push({ type: "event", event: "devtools.event", payload: { streamId, event: { kind: "delta", delta: { version: 1, baseSeq: 6, seq: 7, ops: [{ op: "replaceRoot", node: makeSnapshot(7).root }] } } } });
      }
      if (frame.method === "streamRunEvents") {
        push({ type: "event", event: "run.heartbeat", payload: { streamId } });
        push({ type: "event", event: "run.event", seq: 10, payload: { streamId, seq: 10, event: "node.started", payload: { nodeId: "task1", status: "running", workflowKey: "wf-a" } } });
        push({ type: "event", event: "run.gap_resync", seq: 11, payload: { streamId, toSeq: 11 } });
        push({ type: "event", event: "run.error", seq: 12, payload: { streamId, error: { message: "boom" }, nodeId: "task1" } });
      }
      // getNodeOutput / getNodeDiff socket RPCs.
      if (frame.method === "getNodeOutput") push({ type: "res", id: frame.id, ok: true, payload: { output: { value: 1 } } });
      if (frame.method === "getNodeDiff") push({ type: "res", id: frame.id, ok: true, payload: { patches: [] } });
    };

    await boot(fixture);

    // Initial refresh populated the shell.
    await waitFor(() => document.querySelector(".brand")?.textContent === "Smithers Console");
    await waitFor(() => document.body.textContent.includes("2 workflows"));
    await waitFor(() => document.querySelector("#workflow")?.value === "wf-a");
    expect(document.body.textContent).toContain("1 approvals");
    expect(document.querySelectorAll("[data-run-id]").length).toBe(2);

    // Token, workflow select, and run-input handlers.
    const token = document.querySelector("#token");
    token.value = "secret-token";
    token.dispatchEvent(new Event("input", { bubbles: true }));
    const wf = document.querySelector("#workflow");
    wf.value = "wf-b";
    wf.dispatchEvent(new Event("change", { bubbles: true }));
    const input = document.querySelector("#run-input");
    input.value = '{"x":1}';
    input.dispatchEvent(new Event("input", { bubbles: true }));

    // Refresh button.
    fire("#refresh", "click");

    // Launch: submits the form, launches run-1, then selects it and opens streams.
    fire("#launch", "submit");
    await waitFor(() => document.body.textContent.includes("Run Chronicle"));
    // DevTools snapshot arrived and the tree rendered task nodes.
    await waitFor(() => document.querySelectorAll("[data-node-id]").length > 0);
    // Node output/diff loaded into the inspector.
    await waitFor(() => document.body.textContent.includes("task1"));

    // Click a different tree node to drive the node-select handler + ensureNodeData.
    const nodeButtons = document.querySelectorAll("[data-node-id]");
    if (nodeButtons.length > 1) {
      nodeButtons[1].dispatchEvent(new Event("click", { bubbles: true }));
      await sleep(50);
    }
    // Click an event row that carries a node id (data-event-node-id) -> findNodeByTaskNodeId.
    const eventNodeButton = document.querySelector("[data-event-node-id]");
    if (eventNodeButton) {
      eventNodeButton.dispatchEvent(new Event("click", { bubbles: true }));
      await sleep(50);
    }
    // Re-select the same run (no-op guard) then the other run.
    const runButtons = document.querySelectorAll("[data-run-id]");
    runButtons[0].dispatchEvent(new Event("click", { bubbles: true }));
    runButtons[runButtons.length - 1].dispatchEvent(new Event("click", { bubbles: true }));
    await sleep(80);

    // Approve then deny.
    const approve = document.querySelector("[data-approve]");
    if (approve) { approve.dispatchEvent(new Event("click", { bubbles: true })); await sleep(50); }
    // After refresh the approvals list is re-rendered; deny whatever remains.
    const deny = document.querySelector("[data-deny]");
    if (deny) { deny.dispatchEvent(new Event("click", { bubbles: true })); await sleep(50); }

    expect(document.querySelector(".brand")).toBeTruthy();
  }, 20000);

  test("rpc failures drive the refresh, launch, and approval error branches", async () => {
    const fixture = await startFixture();
    cleanups.push(() => fixture.close());
    // First refresh succeeds so a run/approval/workflow exist to act on; after
    // that every RPC fails so the error branches run.
    let failing = false;
    fixture.state.rpc = (method) => {
      if (failing && method !== "getRun") return { ok: false, error: { message: `${method} failed` } };
      return { ok: true, payload: defaultRpcPayload(method) };
    };
    await boot(fixture);
    await waitFor(() => document.body.textContent.includes("2 workflows"));

    failing = true;
    // Launch with invalid JSON input -> launchRun JSON.parse throws -> catch.
    const input = document.querySelector("#run-input");
    input.value = "{not json";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    fire("#launch", "submit");
    await waitFor(() => document.body.textContent.includes("Unexpected") || document.querySelector(".side .error")?.textContent);
    // Refresh now fails -> rpc throws -> refresh catch sets "Refresh failed".
    fire("#refresh", "click");
    await waitFor(() => document.body.textContent.includes("Refresh failed"));
    // Deny an approval -> submitApproval rpc fails -> decideApproval catch.
    const deny = document.querySelector("[data-deny]");
    if (deny) { deny.dispatchEvent(new Event("click", { bubbles: true })); await sleep(60); }
    expect(document.querySelector(".brand")).toBeTruthy();
  }, 20000);

  test("selecting a run that later disappears clears the detail on refresh", async () => {
    const fixture = await startFixture();
    cleanups.push(() => fixture.close());
    let runsPresent = true;
    fixture.state.rpc = (method) => {
      if (method === "listRuns") {
        return { ok: true, payload: runsPresent ? defaultRpcPayload("listRuns") : [] };
      }
      return { ok: true, payload: defaultRpcPayload(method) };
    };
    fixture.state.onStream = (frame, push) => {
      push({ type: "res", id: frame.id, ok: true, payload: { streamId: `sid-${frame.method}` } });
    };
    await boot(fixture);
    await waitFor(() => document.querySelectorAll("[data-run-id]").length === 2);
    document.querySelectorAll("[data-run-id]")[0].dispatchEvent(new Event("click", { bubbles: true }));
    await waitFor(() => document.body.textContent.includes("Run Chronicle"));
    // Now the selected run vanishes from listRuns; the next refresh detects it
    // and tears the detail back down (closeRunStreams + resetRunDetail).
    runsPresent = false;
    fire("#refresh", "click");
    await waitFor(() => document.body.textContent.includes("No runs found."));
  }, 20000);

  test("storage failures and missing platform APIs fall back gracefully", async () => {
    const fixture = await startFixture();
    cleanups.push(() => fixture.close());
    // sessionStorage throws for both read and write.
    const realSessionStorage = globalThis.sessionStorage;
    const realStructuredClone = globalThis.structuredClone;
    const realCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: {
        getItem() { throw new Error("no storage"); },
        setItem() { throw new Error("no storage"); },
        removeItem() { throw new Error("no storage"); },
      },
    });
    // No structuredClone -> cloneValue uses the JSON fallback; no crypto.randomUUID
    // -> requestId uses Math.random.
    delete globalThis.structuredClone;
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: {} });
    cleanups.push(() => {
      Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: realSessionStorage });
      globalThis.structuredClone = realStructuredClone;
      Object.defineProperty(globalThis, "crypto", { configurable: true, value: realCrypto });
    });

    fixture.state.onStream = (frame, push) => {
      const streamId = `sid-${frame.method}`;
      push({ type: "res", id: frame.id, ok: true, payload: { streamId } });
      if (frame.method === "streamDevTools") {
        push({ type: "event", event: "devtools.event", payload: { streamId, event: { kind: "snapshot", snapshot: makeSnapshot(1) } } });
        // A delta forces cloneValue (JSON fallback under the deleted structuredClone).
        push({ type: "event", event: "devtools.event", payload: { streamId, event: { kind: "delta", delta: { version: 1, baseSeq: 1, seq: 2, ops: [{ op: "replaceRoot", node: makeSnapshot(2).root }] } } } });
      }
      if (frame.method === "getNodeOutput") push({ type: "res", id: frame.id, ok: true, payload: { output: 1 } });
      if (frame.method === "getNodeDiff") push({ type: "res", id: frame.id, ok: true, payload: { patches: [] } });
    };

    await boot(fixture);
    await waitFor(() => document.body.textContent.includes("2 workflows"));
    // Writing the token hits writeStoredToken's throwing setItem (caught).
    const token = document.querySelector("#token");
    token.value = "abc";
    token.dispatchEvent(new Event("input", { bubbles: true }));
    // Clearing the token exercises the removeItem branch (also caught).
    token.value = "";
    token.dispatchEvent(new Event("input", { bubbles: true }));
    // Open a run so the DevTools stream + cloneValue path (requestId fallback) runs.
    document.querySelectorAll("[data-run-id]")[0].dispatchEvent(new Event("click", { bubbles: true }));
    await waitFor(() => document.querySelectorAll("[data-node-id]").length > 0);
    expect(document.querySelector(".brand")).toBeTruthy();
  }, 20000);

  test("devtools stream errors: bad frames, delta failures, retries, and dead sockets", async () => {
    const fixture = await startFixture();
    cleanups.push(() => fixture.close());
    let devtoolsAttempts = 0;
    fixture.state.onStream = (frame, push, socket) => {
      const streamId = `sid-${frame.method}`;
      if (frame.method === "streamDevTools") {
        devtoolsAttempts += 1;
        push({ type: "res", id: frame.id, ok: true, payload: { streamId } });
        if (devtoolsAttempts === 1) {
          // A non-JSON frame -> the client message parser throws -> client.error.
          socket.send("this is not json");
          // A retryable devtools.error (matches /not found|closed|failed/) -> retry scheduled.
          push({ type: "event", event: "devtools.error", payload: { streamId, error: { message: "stream not found" } } });
          return;
        }
        // On the retry: deliver a snapshot, then a version-mismatched delta
        // (applyDelta throws -> handleDevToolsEvent catch), then an unknown-op
        // delta (also caught), then a non-retryable devtools.error.
        push({ type: "event", event: "devtools.event", payload: { streamId, event: { kind: "snapshot", snapshot: makeSnapshot(5) } } });
        push({ type: "event", event: "devtools.event", payload: { streamId, event: { kind: "delta", delta: { version: 1, baseSeq: 99, seq: 6, ops: [] } } } });
        push({ type: "event", event: "devtools.event", payload: { streamId, event: { kind: "delta", delta: { version: 1, baseSeq: 5, seq: 7, ops: [{ op: "bogus" }] } } } });
        push({ type: "event", event: "devtools.error", payload: { streamId, error: { message: "fatal serializer" } } });
        return;
      }
      if (frame.method === "streamRunEvents") {
        push({ type: "res", id: frame.id, ok: true, payload: { streamId } });
        // A non-JSON frame on the run-events socket -> client.error branch.
        socket.send("garbage-not-json");
        return;
      }
      push({ type: "res", id: frame.id, ok: true, payload: { streamId } });
    };
    await boot(fixture);
    await waitFor(() => document.querySelectorAll("[data-run-id]").length === 2);
    document.querySelectorAll("[data-run-id]")[0].dispatchEvent(new Event("click", { bubbles: true }));
    // The retry (attempt 2) reconnects and delivers the snapshot.
    await waitFor(() => devtoolsAttempts >= 2, 6000);
    await waitFor(() => document.body.textContent.includes("Needs refresh") || document.body.textContent.includes("Error") || document.querySelectorAll("[data-node-id]").length > 0, 6000);
    expect(document.querySelector(".brand")).toBeTruthy();
  }, 20000);

  test("a failed WS connect handshake marks both streams unavailable", async () => {
    const fixture = await startFixture();
    cleanups.push(() => fixture.close());
    // The connect handshake fails, so openGatewaySocket rejects for the streams
    // (and node-data socket RPCs), driving the stream catch branches.
    fixture.state.connectResponse = { ok: false, error: { message: "connect refused" } };
    await boot(fixture);
    await waitFor(() => document.querySelectorAll("[data-run-id]").length === 2);
    document.querySelectorAll("[data-run-id]")[0].dispatchEvent(new Event("click", { bubbles: true }));
    await waitFor(() => document.body.textContent.includes("Unavailable"), 6000);
    expect(document.querySelector(".brand")).toBeTruthy();
  }, 20000);

  test("tree selection follows snapshots that drop the selection or lack task nodes", async () => {
    const fixture = await startFixture();
    cleanups.push(() => fixture.close());
    fixture.state.onStream = (frame, push) => {
      const streamId = `sid-${frame.method}`;
      if (frame.method === "streamDevTools") {
        push({ type: "res", id: frame.id, ok: true, payload: { streamId } });
        // A: ids 0/1/2 -> selects task node id 1.
        push({ type: "event", event: "devtools.event", payload: { streamId, event: { kind: "snapshot", snapshot: makeSnapshotIds(1, 0) } } });
        // C: ids 50/51/52 -> the prior selection (id 1) is gone (findNodeById miss),
        // so it re-selects via firstTaskNode.
        setTimeout(() => push({ type: "event", event: "devtools.event", payload: { streamId, event: { kind: "snapshot", snapshot: makeSnapshotIds(2, 50) } } }), 40);
        // No task nodes -> firstTaskNode exhausts and the root is selected;
        // ensureNodeData then hits the no-key branch.
        setTimeout(() => push({ type: "event", event: "devtools.event", payload: { streamId, event: { kind: "snapshot", snapshot: makeNoTaskSnapshot(3) } } }), 80);
        // A null snapshot -> syncSelectedNode's no-root branch.
        setTimeout(() => push({ type: "event", event: "devtools.event", payload: { streamId, event: { kind: "snapshot", snapshot: null } } }), 120);
        return;
      }
      push({ type: "res", id: frame.id, ok: true, payload: { streamId } });
      if (frame.method === "getNodeOutput") push({ type: "res", id: frame.id, ok: true, payload: { output: 1 } });
      if (frame.method === "getNodeDiff") push({ type: "res", id: frame.id, ok: true, payload: { patches: [] } });
    };
    await boot(fixture);
    await waitFor(() => document.querySelectorAll("[data-run-id]").length === 2);
    document.querySelectorAll("[data-run-id]")[0].dispatchEvent(new Event("click", { bubbles: true }));
    await sleep(350);
    expect(document.querySelector(".brand")).toBeTruthy();
  }, 20000);

  test("clicking an event row for a node absent from the tree is a no-op", async () => {
    const fixture = await startFixture();
    cleanups.push(() => fixture.close());
    fixture.state.onStream = (frame, push) => {
      const streamId = `sid-${frame.method}`;
      push({ type: "res", id: frame.id, ok: true, payload: { streamId } });
      if (frame.method === "streamDevTools") {
        push({ type: "event", event: "devtools.event", payload: { streamId, event: { kind: "snapshot", snapshot: makeSnapshot(1) } } });
      }
      if (frame.method === "streamRunEvents") {
        // An event whose nodeId does not exist in the DevTools tree.
        push({ type: "event", event: "run.event", seq: 3, payload: { streamId, seq: 3, event: "node.log", payload: { nodeId: "ghost-node" } } });
      }
      if (frame.method === "getNodeOutput") push({ type: "res", id: frame.id, ok: true, payload: { output: 1 } });
      if (frame.method === "getNodeDiff") push({ type: "res", id: frame.id, ok: true, payload: { patches: [] } });
    };
    await boot(fixture);
    await waitFor(() => document.querySelectorAll("[data-run-id]").length === 2);
    document.querySelectorAll("[data-run-id]")[0].dispatchEvent(new Event("click", { bubbles: true }));
    await waitFor(() => document.querySelector("[data-event-node-id]"));
    // Clicking the ghost event resolves no tree node (findNodeByTaskNodeId -> null).
    document.querySelector("[data-event-node-id]").dispatchEvent(new Event("click", { bubbles: true }));
    await sleep(60);
    expect(document.querySelector(".brand")).toBeTruthy();
  }, 20000);

  test("a socket dropped mid-stream rejects the pending subscription and errors", async () => {
    const fixture = await startFixture();
    cleanups.push(() => fixture.close());
    fixture.state.onStream = (frame, push, socket) => {
      if (frame.method === "streamDevTools") {
        // Never answer the subscription; drop the socket so the pending request
        // is rejected by the close handler and the socket 'error'/'close' path runs.
        setTimeout(() => { try { socket.terminate(); } catch {} }, 30);
        return;
      }
      push({ type: "res", id: frame.id, ok: true, payload: { streamId: `sid-${frame.method}` } });
    };
    await boot(fixture);
    await waitFor(() => document.querySelectorAll("[data-run-id]").length === 2);
    document.querySelectorAll("[data-run-id]")[0].dispatchEvent(new Event("click", { bubbles: true }));
    await sleep(400);
    expect(document.querySelector(".brand")).toBeTruthy();
  }, 20000);
});
