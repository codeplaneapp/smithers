/** @jsxImportSource smithers-orchestrator */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { z } from "zod";
import { createSmithers } from "smithers-orchestrator";
import { Gateway } from "../src/gateway.js";

/**
 * Unit-level coverage for a few gateway internals that a normal request flow
 * does not reach deterministically: the SSE api-stream backpressure drain
 * handlers, the post-listen HTTP/WS error handlers, the idle-monitor timer
 * setup, and the relative `<UI source>` reference resolution.
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getPort(server) {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return addr.port;
}

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup(); } catch {}
  }
});

function makeDbPath(name) {
  const dbPath = join(tmpdir(), `smithers-internal-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  cleanups.push(() => {
    for (const suffix of ["", "-shm", "-wal"]) {
      try { rmSync(`${dbPath}${suffix}`, { force: true }); } catch {}
    }
  });
  return dbPath;
}

describe("gateway internal coverage", () => {
  test("drainApiStreamSubscriber registers a drain handler when the reset write backs up", () => {
    const gateway = new Gateway({});
    const drainHandlers = [];
    const subscriber = {
      id: "reset",
      closed: false,
      flushing: false,
      needsReset: true,
      queue: [],
      queueBytes: 0,
      res: {
        write: () => false, // signal backpressure so the drain path is taken
        once: (event, cb) => { if (event === "drain") drainHandlers.push(cb); },
      },
    };
    gateway.drainApiStreamSubscriber(subscriber);
    // The reset write backed up: a drain listener is registered and the method returns early.
    expect(subscriber.needsReset).toBe(false);
    expect(drainHandlers).toHaveLength(1);
    // Firing the drain callback resets flushing and re-enters the drain (no reset left, empty queue).
    drainHandlers[0]();
    expect(subscriber.flushing).toBe(false);
  });

  test("drainApiStreamSubscriber registers a drain handler when a queued write backs up", () => {
    const gateway = new Gateway({});
    const drainHandlers = [];
    const subscriber = {
      id: "queue",
      closed: false,
      flushing: false,
      needsReset: false,
      queue: [{ text: "data: {}\n\n", bytes: 10 }],
      queueBytes: 10,
      res: {
        write: () => false,
        once: (event, cb) => { if (event === "drain") drainHandlers.push(cb); },
      },
    };
    gateway.drainApiStreamSubscriber(subscriber);
    expect(drainHandlers).toHaveLength(1);
    // The queued item was shifted off before the write backed up.
    expect(subscriber.queue).toHaveLength(0);
    drainHandlers[0]();
    expect(subscriber.flushing).toBe(false);
  });

  test("post-listen HTTP server 'error' events are logged, not fatal", async () => {
    const gateway = new Gateway({});
    const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    cleanups.push(() => gateway.close());
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.join(" ")); };
    try {
      gateway.server.emit("error", new Error("post-listen boom"));
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.some((line) => line.includes("http server error") && line.includes("post-listen boom"))).toBe(true);
  });

  test("a socket 'error' event tears the connection down", async () => {
    const gateway = new Gateway({});
    const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    cleanups.push(() => gateway.close());
    const port = getPort(server);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    cleanups.push(() => { try { ws.close(); } catch {} });
    // Wait for the server side to register the connection.
    for (let i = 0; i < 100 && gateway.connections.size === 0; i += 1) await sleep(10);
    expect(gateway.connections.size).toBeGreaterThan(0);
    const connection = [...gateway.connections][0];
    const before = gateway.connections.size;
    // The server-side socket has an 'error' listener (cleanup); emitting drives it.
    connection.ws.emit("error", new Error("socket boom"));
    for (let i = 0; i < 100 && gateway.connections.size >= before; i += 1) await sleep(10);
    expect(gateway.connections.has(connection)).toBe(false);
  });

  test("idle monitor arms a timer and fires onIdle after the idle window", async () => {
    let idleFired = 0;
    // A short idle window: checkMs clamps to 1000ms, so the interval callback
    // (checkIdle) runs within ~1s and, finding the daemon idle, invokes onIdle.
    const gateway = new Gateway({ idleTimeoutMs: 1000, onIdle: () => { idleFired += 1; } });
    const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    cleanups.push(() => gateway.close());
    getPort(server);
    expect(gateway.idleTimer).toBeTruthy();
    for (let i = 0; i < 60 && idleFired === 0; i += 1) await sleep(50);
    expect(idleFired).toBeGreaterThan(0);
  });

  test("registering a workflow with a relative <UI source> resolves the reference", async () => {
    const dbPath = makeDbPath("relsource");
    const { smithers, Workflow, Task, UI, outputs } = createSmithers(
      { result: z.object({ value: z.number() }) },
      { dbPath },
    );
    const workflow = smithers(() => (
      <Workflow name="rel-source">
        <UI source="./relative-ui.jsx" title="Relative UI" props={{ label: "Relative" }} />
        <Task id="task1" output={outputs.result}>{{ value: 1 }}</Task>
      </Workflow>
    ));
    const gateway = new Gateway({});
    // register() eagerly discovers workflow views, resolving the relative source
    // ref (isRelativeFilePath) even though the file need not exist.
    expect(() => gateway.register("rel-source", workflow)).not.toThrow();
    cleanups.push(() => gateway.close());
    await gateway.listen({ port: 0, host: "127.0.0.1" });
  });
});
