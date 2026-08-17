/** @jsxImportSource smthrs */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";

/**
 * Covers the webhook signal path that targets a SPECIFIC run via `runIdPath`
 * (findMatchingWebhookRuns' explicit-runId branch), which delegates to
 * runWaitsForSignal + parseWebhookWaitForEventSnapshot. A single seeded run
 * carries several waiting-event nodes whose attempt metadata exercises every
 * branch (missing meta, empty waitForEvent, invalid JSON, signal mismatch,
 * correlation mismatch) before the final node matches and returns true.
 */

let createSmithers;
/** Assigned with `createSmithers`; see ./fixtures/tracked-smithers.js. */
let closeTrackedSmithers = () => {};
let Gateway;
let SmithersDb;
let WaitForEvent;

afterAll(() => closeTrackedSmithers());

function getPort(server) {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

function makeDbPath(name) {
  return join(tmpdir(), `smithers-webhook-explicit-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function signWebhookPayload(payload, secret, prefix = "sha256=") {
  return `${prefix}${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

async function postWebhook(port, workflowKey, payload, secret) {
  const body = JSON.stringify(payload);
  return fetch(`http://127.0.0.1:${port}/webhooks/${workflowKey}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": signWebhookPayload(body, secret) },
    body,
  });
}

let gateway;
const dbPaths = [];

afterEach(async () => {
  if (gateway) await gateway.close();
  gateway = undefined;
  for (const dbPath of dbPaths.splice(0)) {
    for (const suffix of ["", "-shm", "-wal"]) {
      try {
        rmSync(`${dbPath}${suffix}`, { force: true });
      } catch {}
    }
  }
});

describe("Gateway webhook explicit-run signal targeting", () => {
  beforeAll(async () => {
    const tracked = await import("./fixtures/tracked-smithers.js");
    createSmithers = tracked.createTrackedSmithers;
    closeTrackedSmithers = tracked.closeTrackedSmithers;
    Gateway = (await import("../src/gateway.js")).Gateway;
    SmithersDb = (await import("@smthrs/db/adapter")).SmithersDb;
    WaitForEvent = (await import("@smthrs/components/components/WaitForEvent")).WaitForEvent;
  });

  test("runIdPath targets a run and runWaitsForSignal scans every node branch", async () => {
    const dbPath = makeDbPath("scan");
    dbPaths.push(dbPath);
    const api = createSmithers({ webhookEvent: z.object({ body: z.string() }) }, { dbPath });
    const workflow = api.smithers(() => (
      <api.Workflow name="explicit-wait">
        <WaitForEvent id="wait" event="github.comment.created" correlationId="42" output={api.outputs.webhookEvent} />
      </api.Workflow>
    ));
    gateway = new Gateway();
    // Avoid resuming the seeded (frame-less) run; runWaitsForSignal is the unit
    // under test, not the resume machinery.
    gateway.resumeRunIfNeeded = async () => {};
    gateway.register("github", workflow, {
      webhook: {
        secret: "explicit-secret",
        signal: {
          name: "github.comment.created",
          runIdPath: "target.runId",
          correlationIdPath: "issue.id",
          payloadPath: "comment",
        },
        run: { enabled: false },
      },
    });
    const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    const port = getPort(server);
    const adapter = new SmithersDb(api.db);
    const runId = "explicit-run";
    await adapter.insertRun({
      runId,
      workflowName: "explicit-wait",
      workflowHash: "h",
      status: "waiting-event",
      createdAtMs: Date.now(),
    });

    // Nodes are iterated in insertion order; the matching node is inserted LAST
    // so every non-matching `continue` branch runs before the function returns true.
    const outputTable = api.tables.webhookEvent._?.name ?? "webhook_event";
    let attemptSeq = 1;
    async function seedNode(nodeId, state, metaJson) {
      await adapter.insertNode({
        runId,
        nodeId,
        iteration: 0,
        state,
        lastAttempt: 1,
        updatedAtMs: Date.now(),
        outputTable,
        label: nodeId,
      });
      await adapter.insertAttempt({
        runId,
        nodeId,
        iteration: 0,
        attempt: 1,
        state,
        startedAtMs: Date.now(),
        finishedAtMs: null,
        errorJson: null,
        metaJson,
        responseText: null,
        cached: false,
        jjPointer: null,
        jjCwd: null,
      });
      attemptSeq += 1;
    }

    // 1. non-waiting node -> skipped by the state guard.
    await seedNode(
      "done-node",
      "finished",
      JSON.stringify({ waitForEvent: { signalName: "github.comment.created", correlationId: "42" } }),
    );
    // 2. waiting node with NO meta -> parseWebhookWaitForEventSnapshot returns null (!metaJson).
    await seedNode("no-meta", "waiting-event", null);
    // 3. waiting node whose waitForEvent has no signalName -> snapshot null (!signalName).
    await seedNode("empty-wait", "waiting-event", JSON.stringify({ waitForEvent: {} }));
    // 4. waiting node with invalid JSON meta -> snapshot null (JSON.parse throws / caught).
    await seedNode("bad-json", "waiting-event", "{not valid json");
    // 5. waiting node whose signal name differs -> signalName mismatch continue.
    await seedNode(
      "wrong-signal",
      "waiting-event",
      JSON.stringify({ waitForEvent: { signalName: "other.event", correlationId: "42" } }),
    );
    // 6. waiting node whose correlation differs -> correlationId mismatch continue.
    await seedNode(
      "wrong-corr",
      "waiting-event",
      JSON.stringify({ waitForEvent: { signalName: "github.comment.created", correlationId: "999" } }),
    );
    // 7. matching node (LAST) -> returns true.
    await seedNode(
      "wait",
      "waiting-event",
      JSON.stringify({ waitForEvent: { signalName: "github.comment.created", correlationId: "42", waitAsync: false } }),
    );

    const response = await postWebhook(
      port,
      "github",
      {
        target: { runId },
        issue: { id: 42 },
        comment: { body: "ship it" },
      },
      "explicit-secret",
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.ok).toBe(true);
    expect(payload.matchedRunIds).toEqual([runId]);
    expect(payload.delivered).toHaveLength(1);
  });

  test("explicit runIdPath that resolves to a non-waiting run matches nothing", async () => {
    const dbPath = makeDbPath("nomatch");
    dbPaths.push(dbPath);
    const api = createSmithers({ webhookEvent: z.object({ body: z.string() }) }, { dbPath });
    const workflow = api.smithers(() => (
      <api.Workflow name="explicit-wait">
        <WaitForEvent id="wait" event="github.comment.created" correlationId="42" output={api.outputs.webhookEvent} />
      </api.Workflow>
    ));
    gateway = new Gateway();
    gateway.register("github", workflow, {
      webhook: {
        secret: "explicit-secret",
        signal: {
          name: "github.comment.created",
          runIdPath: "target.runId",
          correlationIdPath: "issue.id",
          payloadPath: "comment",
        },
        run: { enabled: false },
      },
    });
    const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    const port = getPort(server);
    const adapter = new SmithersDb(api.db);
    // A finished run: the status guard rejects it before runWaitsForSignal.
    await adapter.insertRun({
      runId: "finished-run",
      workflowName: "explicit-wait",
      workflowHash: "h",
      status: "finished",
      createdAtMs: Date.now(),
    });

    const response = await postWebhook(
      port,
      "github",
      {
        target: { runId: "finished-run" },
        issue: { id: 42 },
        comment: { body: "late" },
      },
      "explicit-secret",
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.matchedRunIds).toEqual([]);
  });
});
