import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { startServer } from "../src/index.js";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { sleep } from "../../smithers/tests/helpers.js";

const SECRET = "integration-webhook-secret";
const EVENT_NAME = "integration:test:ping";

function createDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { db, adapter: new SmithersDb(db) };
}

/**
 * Seed a run parked on `WaitForEvent(EVENT_NAME, correlationId)` the way the
 * engine records it (waiting-event node + attempt with waitForEvent meta).
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {string | null} correlationId
 */
async function seedWaitingEventRun(adapter, runId, correlationId) {
  const now = Date.now();
  await adapter.insertRun({
    runId,
    workflowName: "webhook-wait-flow",
    status: "waiting-event",
    createdAtMs: now,
  });
  await adapter.insertNode({
    runId,
    nodeId: "wait-ping",
    iteration: 0,
    state: "waiting-event",
    lastAttempt: 1,
    updatedAtMs: now,
    outputTable: "",
    label: null,
  });
  await adapter.insertAttempt({
    runId,
    nodeId: "wait-ping",
    iteration: 0,
    attempt: 1,
    state: "waiting-event",
    startedAtMs: now,
    finishedAtMs: null,
    errorJson: null,
    metaJson: JSON.stringify({
      kind: "wait-for-event",
      waitForEvent: { signalName: EVENT_NAME, correlationId, waitAsync: false },
    }),
    responseText: null,
    cached: false,
    jjPointer: null,
    jjCwd: null,
  });
}

/**
 * @param {import("node:http").Server} server
 */
function getPort(server) {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server did not expose a port");
  }
  return address.port;
}

/**
 * @param {number} port
 * @param {string} sourceId
 * @param {string} body
 * @param {string | undefined} signature
 */
function postWebhook(port, sourceId, body, signature) {
  return fetch(`http://127.0.0.1:${port}/v1/webhooks/${sourceId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(signature ? { "x-hub-signature-256": signature } : {}),
    },
    body,
  });
}

/**
 * @param {string} body
 */
function sign(body, secret = SECRET) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/**
 * Poll until the run has `count` signals for EVENT_NAME (delivery is async
 * behind the 202) or the deadline passes.
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {number} count
 */
async function waitForSignals(adapter, runId, count, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let signals = [];
  while (Date.now() < deadline) {
    signals = await adapter.listSignals(runId, { signalName: EVENT_NAME });
    if (signals.length >= count) {
      return signals;
    }
    await sleep(25);
  }
  return signals;
}

describe("POST /v1/webhooks/:sourceId", () => {
  /** @type {import("node:http").Server | undefined} */
  let server;
  afterEach(async () => {
    server?.close();
    server = undefined;
    await sleep(200);
  });
  function startWebhookServer(db, integrations) {
    server = startServer({
      port: 0,
      db,
      integrations: integrations ?? {
        webhooks: [
          {
            id: "test",
            secret: SECRET,
            event: EVENT_NAME,
            correlationIdPath: "corr",
            payloadPath: "data",
            dedupeKeyPath: "deliveryId",
          },
        ],
      },
    });
    return getPort(server);
  }
  test("delivers a signed webhook to a waiting run (202 → signal row + wait resolved)", async () => {
    const { db, adapter } = createDb();
    await seedWaitingEventRun(adapter, "run-hook", "corr-1");
    const port = startWebhookServer(db);
    const body = JSON.stringify({
      corr: "corr-1",
      deliveryId: "d-1",
      data: { hello: "world" },
    });
    const res = await postWebhook(port, "test", body, sign(body));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true });
    const signals = await waitForSignals(adapter, "run-hook", 1);
    expect(signals).toHaveLength(1);
    expect(JSON.parse(signals[0].payloadJson)).toEqual({ hello: "world" });
    expect(signals[0].correlationId).toBe("corr-1");
    expect(signals[0].receivedBy).toBe("integration:test");
    // The waiting attempt was resolved (resolvedSignalSeq stamped).
    const attempts = await adapter.listAttempts("run-hook", "wait-ping", 0);
    const meta = JSON.parse(attempts[0].metaJson ?? "{}");
    expect(meta.waitForEvent.resolvedSignalSeq).toBe(signals[0].seq);
  });
  test("rejects a bad signature with 401 and delivers no signal", async () => {
    const { db, adapter } = createDb();
    await seedWaitingEventRun(adapter, "run-bad-sig", "corr-1");
    const port = startWebhookServer(db);
    const body = JSON.stringify({ corr: "corr-1", deliveryId: "d-1", data: {} });
    const wrongSecret = await postWebhook(port, "test", body, sign(body, "wrong-secret"));
    expect(wrongSecret.status).toBe(401);
    const missing = await postWebhook(port, "test", body, undefined);
    expect(missing.status).toBe(401);
    await sleep(150);
    expect(await adapter.listSignals("run-bad-sig", { signalName: EVENT_NAME })).toHaveLength(0);
  });
  test("returns 404 for an unknown source id", async () => {
    const { db } = createDb();
    const port = startWebhookServer(db);
    const body = JSON.stringify({ deliveryId: "d-1" });
    const res = await postWebhook(port, "nope", body, sign(body));
    expect(res.status).toBe(404);
  });
  test("dedupes redeliveries with the same dedupe key to a single signal", async () => {
    const { db, adapter } = createDb();
    await seedWaitingEventRun(adapter, "run-dedupe", "corr-1");
    const port = startWebhookServer(db);
    const body = JSON.stringify({
      corr: "corr-1",
      deliveryId: "same-delivery",
      data: { n: 1 },
    });
    const first = await postWebhook(port, "test", body, sign(body));
    const second = await postWebhook(port, "test", body, sign(body));
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const signals = await waitForSignals(adapter, "run-dedupe", 1);
    expect(signals).toHaveLength(1);
    await sleep(150);
    expect(await adapter.listSignals("run-dedupe", { signalName: EVENT_NAME })).toHaveLength(1);
  });
  test("returns 400 for a non-JSON body", async () => {
    const { db } = createDb();
    const port = startWebhookServer(db);
    const body = "not json";
    const res = await postWebhook(port, "test", body, sign(body));
    expect(res.status).toBe(400);
  });
  test("returns 503 when the webhook ingress queue has no capacity", async () => {
    const { db } = createDb();
    const port = startWebhookServer(db, {
      webhooks: [
        {
          id: "full",
          secret: SECRET,
          event: EVENT_NAME,
          capacity: 0,
        },
      ],
    });
    const body = JSON.stringify({ deliveryId: "d-full" });
    const res = await postWebhook(port, "full", body, sign(body));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: {
        code: "SERVER_ERROR",
        message: "Webhook delivery is temporarily unavailable",
      },
    });
  });
});
