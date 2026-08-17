/** @jsxImportSource smthrs */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { sleep } from "../../smithers/tests/helpers.js";
let createSmithers;
/** Assigned with `createSmithers`; see ./fixtures/tracked-smithers.js. */
let closeTrackedSmithers = () => {};
let Gateway;
let SmithersDb;
let WaitForEvent;

afterAll(() => closeTrackedSmithers());
/**
 * @param {Server} server
 * @returns {number}
 */
function getPort(server) {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Gateway server did not expose a port");
  }
  return address.port;
}
/**
 * @param {string} name
 */
function makeDbPath(name) {
  return join(tmpdir(), `smithers-gateway-webhooks-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}
/**
 * @param {string} payload
 * @param {string} secret
 */
function signWebhookPayload(payload, secret, prefix = "sha256=") {
  return `${prefix}${createHmac("sha256", secret).update(payload).digest("hex")}`;
}
/**
 * @param {number} port
 * @param {string} workflowKey
 * @param {Record<string, unknown>} payload
 * @param {string} secret
 */
async function postWebhook(port, workflowKey, payload, secret) {
  const body = JSON.stringify(payload);
  return fetch(`http://127.0.0.1:${port}/webhooks/${workflowKey}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": signWebhookPayload(body, secret),
    },
    body,
  });
}
async function postGitHubWebhook(port, workflowKey, payload, secret, deliveryId) {
  const body = JSON.stringify(payload);
  return fetch(`http://127.0.0.1:${port}/webhooks/${workflowKey}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "issues",
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": signWebhookPayload(body, secret),
    },
    body,
  });
}
/**
 * Current value of one Prometheus counter sample, or 0 when it is absent.
 *
 * Effect's metric registry is a process-global singleton and its counters are
 * cumulative, so every `Gateway` built in this test process shares one
 * `smithers_gateway_webhooks_received_total{workflow="github"}` — `/metrics`
 * reports the whole process's total, not this gateway's. Any earlier test that
 * posted a `github` webhook (`gateway-webhook-explicit-run-coverage.test.jsx`
 * posts two) has therefore already advanced it, so asserting an absolute `1`
 * passes only when this file happens to run first and otherwise burns the full
 * poll deadline and fails with no SQLite error anywhere near it — the surviving
 * shard-3 failure in #1577. Assert the DELTA across the request under test,
 * matching `metricDelta` in serve.test.js and `metricValue` in
 * streamDevTools.test.tsx.
 *
 * @param {string} metrics raw Prometheus exposition text
 * @param {RegExp} pattern must capture the sample value in group 1
 * @returns {number}
 */
function counterValue(metrics, pattern) {
  const match = metrics.match(pattern);
  return match ? Number(match[1]) : 0;
}
/**
 * @param {number} port
 * @returns {Promise<string>}
 */
async function fetchMetrics(port) {
  return fetch(`http://127.0.0.1:${port}/metrics`).then((res) => res.text());
}
const WEBHOOKS_RECEIVED_GITHUB =
  /smithers_gateway_webhooks_received_total\{[^}]*workflow="github"[^}]*\}\s+(\d+(?:\.\d+)?)/;
const WEBHOOKS_REJECTED_BAD_SIGNATURE =
  /smithers_gateway_webhooks_rejected_total\{[^}]*reason="invalid_signature"[^}]*workflow="github"[^}]*\}\s+(\d+(?:\.\d+)?)/;
/**
 * @param {string} dbPath
 */
function createWebhookWaitWorkflow(dbPath) {
  const api = createSmithers(
    {
      webhookEvent: z.object({
        body: z.string(),
      }),
    },
    { dbPath },
  );
  const workflow = api.smithers(() => (
    <api.Workflow name="gateway-webhook-wait">
      <WaitForEvent id="wait" event="github.comment.created" correlationId="42" output={api.outputs.webhookEvent} />
    </api.Workflow>
  ));
  return { workflow, db: api.db, tables: api.tables };
}
/**
 * @param {string} dbPath
 */
function createWebhookTriggerWorkflow(dbPath) {
  const api = createSmithers(
    {
      result: z.object({
        issueId: z.number(),
        body: z.string(),
      }),
    },
    { dbPath },
  );
  const workflow = api.smithers((ctx) => (
    <api.Workflow name="gateway-webhook-trigger">
      <api.Task id="record" output={api.outputs.result}>
        {{
          issueId: Number(ctx.input.issue?.id ?? 0),
          body: String(ctx.input.comment?.body ?? ""),
        }}
      </api.Task>
    </api.Workflow>
  ));
  return { workflow, db: api.db, tables: api.tables };
}
describe("Gateway webhook ingestion", () => {
  let gateway;
  let server;
  let dbPaths = [];
  beforeAll(async () => {
    const tracked = await import("./fixtures/tracked-smithers.js");
    createSmithers = tracked.createTrackedSmithers;
    closeTrackedSmithers = tracked.closeTrackedSmithers;
    Gateway = (await import("../src/gateway.js")).Gateway;
    SmithersDb = (await import("@smthrs/db/adapter")).SmithersDb;
    WaitForEvent = (await import("@smthrs/components/components/WaitForEvent")).WaitForEvent;
  });
  beforeEach(() => {
    gateway = undefined;
    server = undefined;
    dbPaths = [];
  });
  afterEach(async () => {
    if (gateway) {
      await gateway.close();
    }
    for (const dbPath of dbPaths) {
      try {
        rmSync(dbPath, { force: true });
        rmSync(`${dbPath}-shm`, { force: true });
        rmSync(`${dbPath}-wal`, { force: true });
      } catch {}
    }
    gateway = undefined;
    server = undefined;
    dbPaths = [];
  });
  test("rejects invalid webhook signatures and records rejection metrics", async () => {
    const dbPath = makeDbPath("signature");
    dbPaths.push(dbPath);
    const { workflow } = createWebhookTriggerWorkflow(dbPath);
    gateway = new Gateway();
    gateway.register("github", workflow, {
      webhook: {
        secret: "correct-secret",
      },
    });
    server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    const port = getPort(server);
    // Baseline BEFORE the request: the counters are process-global and may
    // already be non-zero. See counterValue().
    const metricsBefore = await fetchMetrics(port);
    const receivedBefore = counterValue(metricsBefore, WEBHOOKS_RECEIVED_GITHUB);
    const rejectedBefore = counterValue(metricsBefore, WEBHOOKS_REJECTED_BAD_SIGNATURE);
    const payload = JSON.stringify({
      issue: { id: 7 },
      comment: { body: "bad signature" },
    });
    const response = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signWebhookPayload(payload, "wrong-secret"),
      },
      body: payload,
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      ok: false,
      error: {
        code: "UNAUTHORIZED",
        message: "Webhook signature verification failed",
      },
    });
    // Metric updates run on forked fibers with no ordering guarantee, so poll
    // until BOTH counters advance instead of sleeping once: a loaded runner can
    // schedule the forks late and in either order.
    let received = receivedBefore;
    let rejected = rejectedBefore;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const metrics = await fetchMetrics(port);
      received = counterValue(metrics, WEBHOOKS_RECEIVED_GITHUB);
      rejected = counterValue(metrics, WEBHOOKS_REJECTED_BAD_SIGNATURE);
      if (received > receivedBefore && rejected > rejectedBefore) break;
      await sleep(50);
    }
    // Exactly one of each: this request is the only one either counter saw
    // between the baseline and now, whatever the process-wide totals are.
    expect(received).toBe(receivedBefore + 1);
    expect(rejected).toBe(rejectedBefore + 1);
  }, 30_000);
  test("uses the GitHub decoder and durable delivery ledger for registry-backed launches", async () => {
    const dbPath = makeDbPath("github-source");
    dbPaths.push(dbPath);
    const { workflow } = createWebhookTriggerWorkflow(dbPath);
    gateway = new Gateway();
    gateway.register("github-issues", workflow, {
      webhook: { secret: "registry-secret", source: "github" },
    });
    server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    const port = getPort(server);
    const payload = {
      action: "opened",
      issue: { id: 1437, number: 1437 },
      repository: { full_name: "smithersai/smithers" },
    };
    const first = await postGitHubWebhook(port, "github-issues", payload, "registry-secret", "delivery-registry-1");
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.started?.runId).toBeString();
    const repeated = await postGitHubWebhook(port, "github-issues", payload, "registry-secret", "delivery-registry-1");
    expect(repeated.status).toBe(200);
    const repeatedBody = await repeated.json();
    expect(repeatedBody.started).toBeNull();
    expect(repeatedBody.deduped).toBe(true);
  });
  test("delivers matching webhooks as signals to waiting runs", async () => {
    const dbPath = makeDbPath("signal");
    dbPaths.push(dbPath);
    const { workflow, db, tables } = createWebhookWaitWorkflow(dbPath);
    gateway = new Gateway();
    gateway.resumeRunIfNeeded = async () => {};
    gateway.register("github", workflow, {
      webhook: {
        secret: "signal-secret",
        signal: {
          name: "github.comment.created",
          correlationIdPath: "issue.id",
          payloadPath: "comment",
        },
        run: {
          enabled: false,
        },
      },
    });
    server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    const port = getPort(server);
    const adapter = new SmithersDb(db);
    const runId = "webhook-signal-run";
    await adapter.insertRun({
      runId,
      workflowName: "gateway-webhook-wait",
      workflowHash: "workflow-hash",
      status: "waiting-event",
      createdAtMs: Date.now(),
    });
    await adapter.insertNode({
      runId,
      nodeId: "wait",
      iteration: 0,
      state: "waiting-event",
      lastAttempt: 1,
      updatedAtMs: Date.now(),
      outputTable: tables.webhookEvent._?.name ?? "webhook_event",
      label: "wait",
    });
    await adapter.insertAttempt({
      runId,
      nodeId: "wait",
      iteration: 0,
      attempt: 1,
      state: "waiting-event",
      startedAtMs: Date.now(),
      finishedAtMs: null,
      errorJson: null,
      metaJson: JSON.stringify({
        waitForEvent: {
          signalName: "github.comment.created",
          correlationId: "42",
          waitAsync: false,
        },
      }),
      responseText: null,
      cached: false,
      jjPointer: null,
      jjCwd: null,
    });
    const response = await postWebhook(
      port,
      "github",
      {
        issue: { id: 42 },
        comment: { body: "ship it" },
      },
      "signal-secret",
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.ok).toBe(true);
    expect(payload.matchedRunIds).toEqual([runId]);
    expect(payload.delivered).toHaveLength(1);
    expect(payload.started).toBeNull();
    expect(
      await adapter.listSignals(runId, {
        signalName: "github.comment.created",
        correlationId: "42",
      }),
    ).toHaveLength(1);
    const attempts = await adapter.listAttempts(runId, "wait", 0);
    const waitForEvent = JSON.parse(attempts[0]?.metaJson ?? "{}").waitForEvent;
    expect(waitForEvent).toEqual(
      expect.objectContaining({
        signalName: "github.comment.created",
        correlationId: "42",
        resolvedSignalSeq: payload.delivered[0].seq,
        receivedAtMs: payload.delivered[0].receivedAtMs,
      }),
    );
  });
  test("starts a new run when a webhook has no matching waiting run", async () => {
    const dbPath = makeDbPath("run");
    dbPaths.push(dbPath);
    const { workflow } = createWebhookTriggerWorkflow(dbPath);
    gateway = new Gateway();
    const startedRuns = [];
    gateway.startRun = async (workflowKey, input, auth) => {
      startedRuns.push({ workflowKey, input, auth });
      return {
        runId: "webhook-started-run",
        workflow: workflowKey,
      };
    };
    gateway.register("github", workflow, {
      webhook: {
        secret: "run-secret",
        signal: {
          name: "github.comment.created",
          correlationIdPath: "issue.id",
        },
      },
    });
    server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    const port = getPort(server);
    const response = await postWebhook(
      port,
      "github",
      {
        issue: { id: 99 },
        comment: { body: "open a run" },
      },
      "run-secret",
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.ok).toBe(true);
    expect(payload.delivered).toEqual([]);
    expect(payload.started).toEqual({
      workflow: "github",
      runId: "webhook-started-run",
    });
    expect(startedRuns).toEqual([
      {
        workflowKey: "github",
        input: {
          issue: { id: 99 },
          comment: { body: "open a run" },
        },
        auth: expect.objectContaining({
          triggeredBy: "webhook:github",
          role: "system",
          scopes: ["*"],
        }),
      },
    ]);
  });
});
