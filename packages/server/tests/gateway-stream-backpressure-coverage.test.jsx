/** @jsxImportSource smthrs */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { z } from "zod";
import { closeTrackedSmithers, createTrackedSmithers as createSmithers } from "./fixtures/tracked-smithers.js";
import { Gateway } from "../src/gateway.js";

afterAll(closeTrackedSmithers);

/**
 * Covers the WS outbound-queue re-drain timers on the extension and DevTools
 * streams: when a subscriber's socket buffer is above the high-water mark, the
 * drain re-schedules itself with setTimeout; once the buffer clears it flushes.
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getPort(server) {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return addr.port;
}

function fakeConnection({ bufferedAmount = 0 } = {}) {
  const sent = [];
  const ws = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount,
    send(data) {
      sent.push(JSON.parse(data));
    },
  };
  return {
    connection: {
      transport: "ws",
      ws,
      authenticated: true,
      scopes: ["*"],
      seq: 0,
      role: "operator",
      userId: "user:test",
      tokenId: "tok",
      connectionId: "conn-bp",
    },
    sent,
  };
}

function reqFrame(method, params = {}) {
  return { type: "req", id: `${method}-1`, method, params };
}

const cleanups = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    try {
      await c();
    } catch {}
  }
});

describe("stream outbound-queue re-drain timers", () => {
  test("extension stream re-drains after the socket buffer clears", async () => {
    const gateway = new Gateway({});
    cleanups.push(() => gateway.close());
    gateway.extend("bp", {
      streams: {
        feed: {
          subscribe: (_params, ctx) => {
            // Emit a handful of events (well under the overflow limit) shortly
            // after subscription so the drain runs while the buffer is congested.
            setTimeout(() => {
              for (let i = 0; i < 3; i += 1) ctx.send({ i });
            }, 0);
            return () => {};
          },
        },
      },
    });
    const { connection, sent } = fakeConnection({ bufferedAmount: 9 * 1024 * 1024 });
    const res = await gateway.routeRequest(connection, reqFrame("ext.stream.bp.feed"));
    expect(res.ok).toBe(true);
    // The congested buffer forces the drain to re-schedule via setTimeout(10ms).
    await sleep(40);
    expect(sent.some((e) => e.event === "ext.stream.event")).toBe(false);
    // Clear the buffer; the next re-drain flushes the queued events.
    connection.ws.bufferedAmount = 0;
    await sleep(60);
    expect(sent.some((e) => e.event === "ext.stream.event")).toBe(true);
  }, 15000);

  test("devtools stream re-drains after the socket buffer clears", async () => {
    const dbPath = join(tmpdir(), `smithers-bp-devtools-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    cleanups.push(() => {
      for (const s of ["", "-shm", "-wal"]) {
        try {
          rmSync(`${dbPath}${s}`, { force: true });
        } catch {}
      }
    });
    const { smithers, Workflow, Task, outputs } = createSmithers(
      { result: z.object({ value: z.number() }) },
      { dbPath },
    );
    const workflow = smithers(() => (
      <Workflow name="bp-dt">
        <Task id="task1" output={outputs.result}>
          {{ value: 1 }}
        </Task>
      </Workflow>
    ));
    const gateway = new Gateway({});
    cleanups.push(() => gateway.close());
    gateway.register("bp-dt", workflow);
    const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    const port = getPort(server);

    // Launch and finish a run over a real WS client so a DevTools snapshot exists.
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    cleanups.push(() => {
      try {
        client.close();
      } catch {}
    });
    const messages = [];
    client.on("message", (raw) => messages.push(JSON.parse(String(raw))));
    const waitMsg = async (predicate) => {
      const start = Date.now();
      while (Date.now() - start < 5000) {
        const i = messages.findIndex(predicate);
        if (i >= 0) return messages.splice(i, 1)[0];
        await sleep(10);
      }
      throw new Error("client message timeout");
    };
    const request = async (method, params) => {
      const id = `${method}-${Math.random().toString(36).slice(2)}`;
      client.send(JSON.stringify({ type: "req", id, method, params }));
      return waitMsg((m) => m.type === "res" && m.id === id);
    };
    await waitMsg((m) => m.type === "event" && m.event === "connect.challenge");
    await request("connect", { minProtocol: 1, maxProtocol: 1, client: { id: "bp", version: "1", platform: "test" } });
    const launched = await request("launchRun", { workflow: "bp-dt", input: {} });
    const runId = launched.payload.runId;
    await waitFor(async () => {
      const got = await request("getRun", { runId });
      return got.ok && ["finished", "failed"].includes(got.payload?.status);
    });

    // Subscribe to the DevTools stream on a SEPARATE congested fake connection so
    // the initial snapshot enqueues while bufferedAmount is above the high-water
    // mark, forcing the drain's setTimeout re-schedule.
    const { connection, sent } = fakeConnection({ bufferedAmount: 9 * 1024 * 1024 });
    const res = await gateway.routeRequest(connection, reqFrame("streamDevTools", { runId, fromSeq: 0 }));
    expect(res.ok).toBe(true);
    await sleep(40);
    connection.ws.bufferedAmount = 0;
    await sleep(80);
    expect(sent.some((e) => e.event === "devtools.event")).toBe(true);
  }, 20000);
});

async function waitFor(predicate, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await sleep(20);
  }
  throw new Error("waitFor timed out");
}
