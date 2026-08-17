// S2: coverage for the run surface's concurrency machinery - the consecutive
// timeout circuit breaker (trip / fast-drop / half-open probe / re-arm /
// reset-on-success), the bounded `close()` drain deadline, the memoized workspace
// find-or-create with retry-after-transient-failure, and the cross-run event drop.
//
// The "dead herdr" side is a REAL unix-socket server that accepts a connection and
// then stays completely silent - it speaks no herdr protocol at all, so every RPC
// against it hits the client's own per-call timeout. This is a genuine fault path
// (in the spirit of e2e/faults), NOT a herdr protocol mock. The "responsive" side
// (used only where the breaker must RESET or a workspace must actually be created)
// is a real throwaway herdr server, so those tests skip cleanly when the binary is
// absent (e.g. in CI).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHerdrClient } from "../src/createHerdrClient.js";
import { createHerdrRunSurface } from "../src/index.js";
import { isCompatibleHerdrInstalled, randomSessionName, startHerdrServer } from "./herdr-server.js";

const herdrInstalled = isCompatibleHerdrInstalled();
const describeUnixSocket = process.platform === "win32" ? describe.skip : describe;
const describeRealHerdr = process.platform === "win32" || !herdrInstalled ? describe.skip : describe;

/** herdr's own default (fixed at 5000ms in the surface) - the wait between workspace retries. */
const WORKSPACE_RETRY_INTERVAL_MS = 5000;

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {() => boolean | Promise<boolean>} predicate
 * @param {number} timeoutMs
 * @param {number} intervalMs
 * @returns {Promise<boolean>}
 */
async function waitFor(predicate, timeoutMs = 5000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await sleep(intervalMs);
  }
  return Boolean(await predicate());
}

/** @returns {string} */
function makeRunId() {
  return `run-${Math.random().toString(36).slice(2, 12)}-0000000000`;
}

/**
 * @param {string} type
 * @param {string} runId
 * @param {Record<string, unknown>} [extra]
 */
function ev(type, runId, extra = {}) {
  return { type, runId, iteration: 0, attempt: 1, timestampMs: Date.now(), ...extra };
}

/**
 * A real unix-socket server that ACCEPTS connections and then stays silent - it
 * never writes a response frame and holds the connection open, so a client's RPC
 * blocks until its own per-call timeout fires (a timeout-class fault, not an early
 * close). Speaks no herdr protocol whatsoever.
 *
 * @returns {Promise<{ socketPath: string, close: () => Promise<void> }>}
 */
async function startSilentServer() {
  const dir = mkdtempSync(join(tmpdir(), "smithers-test-silent-"));
  const socketPath = join(dir, "herdr.sock");
  /** @type {import("node:net").Socket[]} */
  const conns = [];
  const server = createServer((socket) => {
    conns.push(socket);
    // Swallow socket errors (the client destroys its end on timeout).
    socket.on("error", () => {});
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve(undefined));
  });
  return {
    socketPath,
    async close() {
      for (const s of conns) {
        try {
          s.destroy();
        } catch {
          // ignore
        }
      }
      await new Promise((resolve) => server.close(() => resolve(undefined)));
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

/**
 * A HerdrClient wrapper that (a) records every RPC the surface routes through it
 * and (b) delegates to a SWAPPABLE underlying client, so a single surface's
 * breaker can be tripped against the silent fixture and then reset by pointing the
 * same surface at a live herdr. The surface routes both its hard `call`s and its
 * soft reports through the underlying `call`, so counting `call` captures the full
 * push sequence.
 *
 * @param {import("../src/HerdrClientOptions.ts").HerdrClient} initialInner
 */
function makeSwappableClient(initialInner) {
  let inner = initialInner;
  /** @type {{ method: string, params: Record<string, unknown> }[]} */
  const calls = [];
  /** @type {import("../src/HerdrClientOptions.ts").HerdrClient} */
  const client = {
    socketPath: initialInner.socketPath,
    call: (method, params) => {
      calls.push({ method, params: params ?? {} });
      return inner.call(method, params);
    },
    tryCall: (method, params) => {
      calls.push({ method, params: params ?? {} });
      return inner.tryCall(method, params);
    },
    subscribe: (subscriptions, onEvent) => inner.subscribe(subscriptions, onEvent),
    ping: () => inner.ping(),
  };
  return {
    client,
    /** @param {import("../src/HerdrClientOptions.ts").HerdrClient} next */
    setInner(next) {
      inner = next;
    },
    calls,
    /** @param {string} method */
    countOf(method) {
      return calls.filter((c) => c.method === method).length;
    },
  };
}

// Suite-level unhandled-rejection detector: none of the surface's fire-and-forget
// tasks may leak a rejection, even when every RPC times out.
/** @type {unknown[]} */
const suiteRejections = [];
const onSuiteRejection = (/** @type {unknown} */ reason) => suiteRejections.push(reason);
beforeAll(() => {
  process.on("unhandledRejection", onSuiteRejection);
});
afterAll(async () => {
  await sleep(200);
  process.removeListener("unhandledRejection", onSuiteRejection);
  expect(suiteRejections).toEqual([]);
});

describeUnixSocket("createHerdrRunSurface circuit breaker (silent real-socket fixture)", () => {
  test("trips after threshold consecutive timeouts and fast-drops further pushes", async () => {
    const silent = await startSilentServer();
    try {
      const callTimeoutMs = 300;
      const inner = createHerdrClient({ socketPath: silent.socketPath, callTimeoutMs, logger: () => {} });
      const rec = makeSwappableClient(inner);
      const surface = createHerdrRunSurface({ client: rec.client, callTimeoutMs, logger: () => {} });
      const runId = makeRunId();

      // One approval event drives THREE timeout-class calls before any pane can
      // exist: workspace.list, workspace.create (both time out), then
      // notification.show - the third consecutive timeout trips the breaker.
      surface.onEvent(ev("NodeWaitingApproval", runId, { nodeId: "n1" }));
      expect(await waitFor(() => rec.countOf("notification.show") === 1, 5000)).toBe(true);
      const afterTrip = rec.countOf("notification.show");

      // A second approval WITHIN the cooldown must fast-drop: the breaker is open,
      // so notification.show short-circuits and never reaches the silent server.
      surface.onEvent(ev("NodeWaitingApproval", runId, { nodeId: "n1" }));
      // A non-short-circuited call would have reached the server (and timed out)
      // within callTimeoutMs; give it well over that and confirm it never did.
      await sleep(callTimeoutMs * 2);
      expect(rec.countOf("notification.show")).toBe(afterTrip);

      await surface.close();
    } finally {
      await silent.close();
    }
  }, 20000);

  test("admits a single half-open probe after the cooldown, then re-arms when it fails", async () => {
    const silent = await startSilentServer();
    try {
      const callTimeoutMs = 250;
      const inner = createHerdrClient({ socketPath: silent.socketPath, callTimeoutMs, logger: () => {} });
      const rec = makeSwappableClient(inner);
      const logs = [];
      const surface = createHerdrRunSurface({
        client: rec.client,
        callTimeoutMs,
        logger: (_level, message) => logs.push(message),
      });
      const runId = makeRunId();

      // Trip the breaker.
      surface.onEvent(ev("NodeWaitingApproval", runId, { nodeId: "n1" }));
      expect(await waitFor(() => rec.countOf("notification.show") === 1, 5000)).toBe(true);
      // Seeing the RPC start is not enough: the breaker opens only after that
      // RPC times out. Wait for its observable transition before measuring the
      // cooldown, otherwise coverage overhead can consume the assumed margin.
      expect(await waitFor(() => logs.some((message) => message.includes("pausing mirror pushes")), 5000)).toBe(true);

      // After the cooldown (2×callTimeoutMs) exactly ONE probe is admitted; it hits
      // the silent server, times out, and re-arms the cooldown.
      await sleep(callTimeoutMs * 2);
      surface.onEvent(ev("NodeWaitingApproval", runId, { nodeId: "n1" }));
      expect(await waitFor(() => rec.countOf("notification.show") === 2, 5000)).toBe(true);
      expect(
        await waitFor(
          () => logs.filter((message) => message.includes("herdr notification.show failed (soft)")).length === 2,
          5000,
        ),
      ).toBe(true);
      const afterProbe = rec.countOf("notification.show");

      // The failed-probe log above is emitted after the breaker re-arms. Drain the
      // next queued push and assert that it fast-dropped without another RPC.
      surface.onEvent(ev("NodeWaitingApproval", runId, { nodeId: "n1" }));
      await surface.close();
      expect(rec.countOf("notification.show")).toBe(afterProbe);
    } finally {
      await silent.close();
    }
  }, 20000);

  test("close() abandons a hung herdr within the bounded 2×callTimeoutMs drain deadline", async () => {
    const silent = await startSilentServer();
    try {
      const callTimeoutMs = 400;
      const deadlineMs = callTimeoutMs * 2;
      const inner = createHerdrClient({ socketPath: silent.socketPath, callTimeoutMs, logger: () => {} });
      const rec = makeSwappableClient(inner);
      const surface = createHerdrRunSurface({ client: rec.client, callTimeoutMs, logger: () => {} });
      const runId = makeRunId();

      // Queue work that blocks on the silent server (the first task alone spends
      // two full timeouts inside workspace find-or-create).
      surface.onEvent(ev("NodeStarted", runId, { nodeId: "n1" }));
      surface.onEvent(ev("NodeWaitingApproval", runId, { nodeId: "n1" }));
      surface.onEvent(ev("NodeStarted", runId, { nodeId: "n2" }));

      const started = Date.now();
      await surface.close();
      const elapsed = Date.now() - started;

      // The documented guarantee: close() never blocks host shutdown beyond
      // 2×callTimeoutMs. Allow generous slack for a slow CI host.
      expect(elapsed).toBeLessThanOrEqual(deadlineMs + 1500);
      // It genuinely blocked on the hung server up to the deadline (the queue could
      // not drain first), so the bound is what released it - not an instant return.
      expect(elapsed).toBeGreaterThanOrEqual(callTimeoutMs);
    } finally {
      await silent.close();
    }
  }, 20000);
});

describeRealHerdr("createHerdrRunSurface breaker reset + workspace retry (real herdr server)", () => {
  /** @type {Awaited<ReturnType<typeof startHerdrServer>>} */
  let server;
  /** @type {import("../src/HerdrClientOptions.ts").HerdrClient} */
  let liveQuery;

  beforeAll(async () => {
    server = await startHerdrServer();
    liveQuery = createHerdrClient({ socketPath: server.socketPath, callTimeoutMs: 4000, logger: () => {} });
  });

  afterAll(async () => {
    await server?.dispose();
  });

  /**
   * @param {string} label
   * @returns {Promise<any[]>}
   */
  async function workspacesWithLabel(label) {
    const res = /** @type {any} */ (await liveQuery.call("workspace.list", {}).catch(() => undefined));
    const list = res && Array.isArray(res.workspaces) ? res.workspaces : [];
    return list.filter((/** @type {any} */ w) => w && w.label === label);
  }

  test("a half-open probe against a now-responsive herdr closes the breaker (reset-on-success)", async () => {
    const silent = await startSilentServer();
    try {
      const callTimeoutMs = 250;
      const silentClient = createHerdrClient({ socketPath: silent.socketPath, callTimeoutMs, logger: () => {} });
      const liveClient = createHerdrClient({ socketPath: server.socketPath, callTimeoutMs: 4000, logger: () => {} });
      const rec = makeSwappableClient(silentClient);
      const surface = createHerdrRunSurface({ client: rec.client, callTimeoutMs, logger: () => {} });
      const runId = makeRunId();

      // Trip the breaker against the silent fixture.
      surface.onEvent(ev("NodeWaitingApproval", runId, { nodeId: "n1" }));
      expect(await waitFor(() => rec.countOf("notification.show") === 1, 5000)).toBe(true);

      // A push within the cooldown fast-drops (breaker open).
      surface.onEvent(ev("NodeWaitingApproval", runId, { nodeId: "n1" }));
      await sleep(300);
      expect(rec.countOf("notification.show")).toBe(1);

      // Point the SAME surface at a LIVE herdr, wait past the cooldown, and push:
      // the admitted half-open probe (notification.show) now SUCCEEDS, which resets
      // the breaker (consecutive-timeout counter cleared, breaker closed).
      rec.setInner(liveClient);
      await sleep(callTimeoutMs * 2 + 250);
      surface.onEvent(ev("NodeWaitingApproval", runId, { nodeId: "n1" }));
      expect(await waitFor(() => rec.countOf("notification.show") === 2, 5000)).toBe(true);

      // With the breaker CLOSED, the very next push goes through immediately - no
      // cooldown wait. Proof the successful probe RESET the breaker rather than the
      // breaker merely admitting another periodic probe.
      surface.onEvent(ev("NodeWaitingApproval", runId, { nodeId: "n1" }));
      expect(await waitFor(() => rec.countOf("notification.show") === 3, 5000)).toBe(true);

      await surface.close();
    } finally {
      await silent.close();
    }
  }, 30000);

  test("the workspace is created on a later event after the first attempt hit a dead herdr (retry after transient failure)", async () => {
    const silent = await startSilentServer();
    const runId = makeRunId();
    const label = `smithers-test-retry-${randomSessionName()}`;
    const callTimeoutMs = 300;
    const silentClient = createHerdrClient({ socketPath: silent.socketPath, callTimeoutMs, logger: () => {} });
    const liveClient = createHerdrClient({ socketPath: server.socketPath, callTimeoutMs: 4000, logger: () => {} });
    const rec = makeSwappableClient(silentClient);
    const surface = createHerdrRunSurface({
      client: rec.client,
      workspaceLabel: label,
      callTimeoutMs,
      logger: () => {},
      // Stub tail so the pane created after recovery runs a harmless command
      // instead of trying to resolve a real `smithers` binary.
      tailCommand: () => ["bash", "-c", "sleep 30"],
    });
    try {
      // First attempt hits the DEAD (silent) fixture. Both the optimistic list
      // and the list inside the creation barrier time out. An indeterminate list
      // must NOT be followed by create: the timed-out response could have hidden
      // an existing same-run workspace.
      surface.onEvent(ev("RunStarted", runId));
      expect(await waitFor(() => rec.countOf("workspace.list") >= 2, 5000)).toBe(true);
      expect(rec.countOf("workspace.create")).toBe(0);
      expect(await workspacesWithLabel(label)).toHaveLength(0);

      // Point at the LIVE herdr and wait past the workspace retry interval so the
      // memoized failure is retried; a later event must now create the workspace.
      rec.setInner(liveClient);
      await sleep(WORKSPACE_RETRY_INTERVAL_MS + 500);
      surface.onEvent(ev("NodeStarted", runId, { nodeId: "n1" }));
      expect(await waitFor(async () => (await workspacesWithLabel(label)).length === 1, 10000)).toBe(true);

      await surface.close();
    } finally {
      for (const w of await workspacesWithLabel(label).catch(() => [])) {
        await liveQuery.call("workspace.close", { workspace_id: w.workspace_id }).catch(() => {});
      }
      await silent.close();
    }
  }, 30000);
});

describeUnixSocket("createHerdrRunSurface cross-run event drop (silent real-socket fixture)", () => {
  test("an event for a run other than the one the surface bound issues zero RPCs", async () => {
    const silent = await startSilentServer();
    try {
      const callTimeoutMs = 200;
      const inner = createHerdrClient({ socketPath: silent.socketPath, callTimeoutMs, logger: () => {} });
      const rec = makeSwappableClient(inner);
      const surface = createHerdrRunSurface({
        client: rec.client,
        callTimeoutMs,
        logger: () => {},
        tailCommand: () => ["bash", "-c", "sleep 30"],
      });
      const runA = makeRunId();
      const runB = makeRunId();

      // The FIRST event binds the surface to runA (and drives a couple of RPCs
      // against the silent fixture, which time out).
      surface.onEvent(ev("NodeStarted", runA, { nodeId: "n1" }));
      await sleep(callTimeoutMs * 3);
      const baseline = rec.calls.length;
      expect(baseline).toBeGreaterThan(0);

      // Foreign-run events are DROPPED synchronously in onEvent (before any enqueue),
      // so they issue zero RPCs: no new call at all, and nothing referencing runB.
      surface.onEvent(ev("NodeStarted", runB, { nodeId: "n1" }));
      surface.onEvent(ev("NodeWaitingApproval", runB, { nodeId: "n1" }));
      surface.onEvent({ type: "RunFinished", runId: runB, timestampMs: Date.now() });
      await sleep(callTimeoutMs * 2);

      expect(rec.calls.length).toBe(baseline);
      expect(rec.calls.some((c) => JSON.stringify(c.params).includes(runB))).toBe(false);

      await surface.close();
    } finally {
      await silent.close();
    }
  }, 20000);
});
