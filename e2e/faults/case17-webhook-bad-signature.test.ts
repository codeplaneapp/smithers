import { Database } from "bun:sqlite";
import { describe, expect, onTestFinished, test } from "bun:test";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

type SignalRow = {
  run_id: string;
  seq: number;
  signal_name: string;
  correlation_id: string | null;
  payload_json: string;
  received_at_ms: number;
  received_by: string | null;
};

type EventRow = {
  run_id: string;
  seq: number;
  timestamp_ms: number;
  type: string;
  payload_json: string;
};

type WebhookHarness = {
  port: number;
  db: Database;
  workflowKey: string;
  secret: string;
  signatureHeader: string;
  signaturePrefix: string;
  close: () => Promise<void>;
};

const WORKFLOW_KEY = "case17-deploy";
const SIGNAL_NAME = "deploy.requested";
const SIGNATURE_HEADER = "x-hub-signature-256";
const SIGNATURE_PREFIX = "sha256=";
const REJECTION_AUDIT_TYPE = "WebhookRejected";
const ACCEPT_AUDIT_TYPE = "WebhookAccepted";

function buildDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE _smithers_runs (
      run_id TEXT PRIMARY KEY,
      workflow_name TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      started_at_ms INTEGER,
      heartbeat_at_ms INTEGER,
      runtime_owner_id TEXT,
      cancel_requested_at_ms INTEGER
    );
    CREATE TABLE _smithers_signals (
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      signal_name TEXT NOT NULL,
      correlation_id TEXT,
      payload_json TEXT NOT NULL,
      received_at_ms INTEGER NOT NULL,
      received_by TEXT,
      PRIMARY KEY (run_id, seq)
    );
    CREATE TABLE _smithers_events (
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (run_id, seq)
    );
  `);
  return db;
}

function seedWaitingRun(db: Database, runId: string): void {
  const t0 = Date.now();
  db.query(
    `INSERT INTO _smithers_runs
       (run_id, workflow_name, status, created_at_ms, started_at_ms, heartbeat_at_ms, runtime_owner_id, cancel_requested_at_ms)
     VALUES (?, ?, 'waiting-event', ?, ?, ?, 'engine-1', NULL)`,
  ).run(runId, WORKFLOW_KEY, t0, t0, t0);
}

function nextEventSeq(db: Database, runId: string): number {
  const row = db
    .query("SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq FROM _smithers_events WHERE run_id = ?")
    .get(runId) as { next_seq: number };
  return row.next_seq;
}

function nextSignalSeq(db: Database, runId: string): number {
  const row = db
    .query("SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq FROM _smithers_signals WHERE run_id = ?")
    .get(runId) as { next_seq: number };
  return row.next_seq;
}

function recordEvent(
  db: Database,
  runId: string,
  type: string,
  payload: Record<string, unknown>,
): void {
  const seq = nextEventSeq(db, runId);
  const ts = Date.now();
  db.query(
    `INSERT INTO _smithers_events (run_id, seq, timestamp_ms, type, payload_json)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(runId, seq, ts, type, JSON.stringify({ ...payload, runId, timestampMs: ts }));
}

function computeSignature(rawBody: Buffer, secret: string, prefix: string): string {
  return `${prefix}${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

function isValidSignature(expected: string, provided: string | null): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function readRawBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > max) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
}

function startWebhookServer(db: Database, secret: string): Promise<WebhookHarness> {
  return new Promise((resolve, reject) => {
    const server = createHttpServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const match = url.pathname.match(/^\/webhooks\/([^/]+)$/);
      if ((req.method ?? "GET") !== "POST" || !match) {
        return sendJson(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "Route not found" } });
      }
      const workflowKey = decodeURIComponent(match[1]!);
      const sourceIp = req.socket.remoteAddress ?? null;
      const requestId = (req.headers["x-request-id"] as string | undefined) ?? `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      let rawBody: Buffer;
      try {
        rawBody = await readRawBody(req, 1_048_576);
      } catch {
        recordEvent(db, workflowKey, REJECTION_AUDIT_TYPE, {
          workflow: workflowKey,
          requestId,
          sourceIp,
          reason: "body_read_failed",
          status: 400,
        });
        return sendJson(res, 400, { ok: false, error: { code: "INVALID_REQUEST", message: "body read failed" } });
      }

      const providedSignature = (req.headers[SIGNATURE_HEADER] as string | undefined) ?? null;
      const expectedSignature = computeSignature(rawBody, secret, SIGNATURE_PREFIX);

      if (!providedSignature) {
        recordEvent(db, workflowKey, REJECTION_AUDIT_TYPE, {
          workflow: workflowKey,
          requestId,
          sourceIp,
          reason: "missing_signature",
          status: 401,
          providedSignature: null,
          bodyBytes: rawBody.length,
        });
        return sendJson(res, 401, { ok: false, error: { code: "UNAUTHORIZED", message: "Missing signature header" } });
      }

      if (!isValidSignature(expectedSignature, providedSignature)) {
        recordEvent(db, workflowKey, REJECTION_AUDIT_TYPE, {
          workflow: workflowKey,
          requestId,
          sourceIp,
          reason: "invalid_signature",
          status: 401,
          providedSignaturePrefix: providedSignature.slice(0, SIGNATURE_PREFIX.length),
          bodyBytes: rawBody.length,
        });
        return sendJson(res, 401, { ok: false, error: { code: "UNAUTHORIZED", message: "Webhook signature verification failed" } });
      }

      let payload: { runId?: string; correlationId?: string; data?: unknown };
      try {
        payload = JSON.parse(rawBody.toString("utf8"));
      } catch {
        recordEvent(db, workflowKey, REJECTION_AUDIT_TYPE, {
          workflow: workflowKey,
          requestId,
          sourceIp,
          reason: "invalid_json",
          status: 400,
        });
        return sendJson(res, 400, { ok: false, error: { code: "INVALID_REQUEST", message: "invalid JSON" } });
      }

      const runId = typeof payload.runId === "string" ? payload.runId : null;
      const correlationId = typeof payload.correlationId === "string" ? payload.correlationId : null;
      if (!runId) {
        recordEvent(db, workflowKey, REJECTION_AUDIT_TYPE, {
          workflow: workflowKey,
          requestId,
          sourceIp,
          reason: "missing_run_id",
          status: 400,
        });
        return sendJson(res, 400, { ok: false, error: { code: "INVALID_REQUEST", message: "runId required" } });
      }
      const run = db
        .query(`SELECT run_id FROM _smithers_runs WHERE run_id = ?`)
        .get(runId) as { run_id: string } | undefined;
      if (!run) {
        recordEvent(db, workflowKey, REJECTION_AUDIT_TYPE, {
          workflow: workflowKey,
          requestId,
          sourceIp,
          reason: "run_not_found",
          status: 404,
        });
        return sendJson(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "run not found" } });
      }

      const seq = nextSignalSeq(db, runId);
      const now = Date.now();
      db.query(
        `INSERT INTO _smithers_signals
           (run_id, seq, signal_name, correlation_id, payload_json, received_at_ms, received_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        runId,
        seq,
        SIGNAL_NAME,
        correlationId,
        JSON.stringify(payload.data ?? null),
        now,
        `webhook:${workflowKey}`,
      );
      recordEvent(db, runId, ACCEPT_AUDIT_TYPE, {
        workflow: workflowKey,
        requestId,
        sourceIp,
        signalName: SIGNAL_NAME,
        correlationId,
        seq,
      });
      return sendJson(res, 200, { ok: true, workflow: workflowKey, verified: true, seq, correlationId });
    });

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        port: address.port,
        db,
        workflowKey: WORKFLOW_KEY,
        secret,
        signatureHeader: SIGNATURE_HEADER,
        signaturePrefix: SIGNATURE_PREFIX,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

async function postWebhook(
  port: number,
  workflowKey: string,
  body: string,
  signature: string | null,
): Promise<{ status: number; body: { ok: boolean; error?: { code: string; message: string }; seq?: number; correlationId?: string | null } }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== null) headers[SIGNATURE_HEADER] = signature;
  const res = await fetch(`http://127.0.0.1:${port}/webhooks/${workflowKey}`, {
    method: "POST",
    headers,
    body,
  });
  const json = (await res.json()) as { ok: boolean; error?: { code: string; message: string }; seq?: number; correlationId?: string | null };
  return { status: res.status, body: json };
}

describe("case 17: webhook signal with invalid signature is rejected and audited", () => {
  test("valid signature: signal recorded with correlation_id and audit row appended", async () => {
    const db = buildDb();
    onTestFinished(() => db.close());
    const harness = await startWebhookServer(db, "shared-secret-correct");
    onTestFinished(() => harness.close());

    const runId = "case17-valid";
    seedWaitingRun(db, runId);
    const body = JSON.stringify({ runId, correlationId: "deploy:abc", data: { branch: "main" } });
    const sig = computeSignature(Buffer.from(body), harness.secret, harness.signaturePrefix);

    const result = await postWebhook(harness.port, harness.workflowKey, body, sig);
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.correlationId).toBe("deploy:abc");

    const signals = db
      .query(`SELECT * FROM _smithers_signals WHERE run_id = ?`)
      .all(runId) as SignalRow[];
    expect(signals.length).toBe(1);
    expect(signals[0]!.signal_name).toBe(SIGNAL_NAME);
    expect(signals[0]!.correlation_id).toBe("deploy:abc");
    expect(signals[0]!.received_by).toBe(`webhook:${harness.workflowKey}`);

    const acceptEvents = db
      .query(`SELECT * FROM _smithers_events WHERE run_id = ? AND type = ?`)
      .all(runId, ACCEPT_AUDIT_TYPE) as EventRow[];
    expect(acceptEvents.length).toBe(1);

    const rejections = db
      .query(`SELECT * FROM _smithers_events WHERE type = ?`)
      .all(REJECTION_AUDIT_TYPE) as EventRow[];
    expect(rejections.length).toBe(0);
  });

  test("invalid signature (signed with wrong secret): rejected 401 and rejection audit row written", async () => {
    const db = buildDb();
    onTestFinished(() => db.close());
    const harness = await startWebhookServer(db, "shared-secret-correct");
    onTestFinished(() => harness.close());

    const runId = "case17-invalid";
    seedWaitingRun(db, runId);
    const body = JSON.stringify({ runId, correlationId: "deploy:bad", data: { branch: "main" } });
    const wrongSig = computeSignature(Buffer.from(body), "shared-secret-wrong", harness.signaturePrefix);

    const result = await postWebhook(harness.port, harness.workflowKey, body, wrongSig);
    expect(result.status).toBe(401);
    expect(result.body.ok).toBe(false);
    expect(result.body.error?.code).toBe("UNAUTHORIZED");

    const signals = db
      .query(`SELECT * FROM _smithers_signals WHERE run_id = ?`)
      .all(runId) as SignalRow[];
    expect(signals.length).toBe(0);

    const rejections = db
      .query(`SELECT * FROM _smithers_events WHERE type = ?`)
      .all(REJECTION_AUDIT_TYPE) as EventRow[];
    expect(rejections.length).toBe(1);
    const audit = JSON.parse(rejections[0]!.payload_json) as Record<string, unknown>;
    expect(audit.reason).toBe("invalid_signature");
    expect(audit.status).toBe(401);
    expect(audit.workflow).toBe(harness.workflowKey);
    expect(typeof audit.requestId).toBe("string");
    expect(typeof audit.timestampMs).toBe("number");
    expect(audit.sourceIp).toBeDefined();
    expect(audit.providedSignaturePrefix).toBe(harness.signaturePrefix);
    expect(typeof audit.bodyBytes).toBe("number");
    expect(rejections[0]!.timestamp_ms).toBeGreaterThan(0);
  });

  test("missing signature header: rejected 401 and audit row records 'missing_signature'", async () => {
    const db = buildDb();
    onTestFinished(() => db.close());
    const harness = await startWebhookServer(db, "shared-secret-correct");
    onTestFinished(() => harness.close());

    const runId = "case17-missing";
    seedWaitingRun(db, runId);
    const body = JSON.stringify({ runId, correlationId: "deploy:nope", data: {} });

    const result = await postWebhook(harness.port, harness.workflowKey, body, null);
    expect(result.status).toBe(401);
    expect(result.body.ok).toBe(false);
    expect(result.body.error?.code).toBe("UNAUTHORIZED");

    const signals = db
      .query(`SELECT * FROM _smithers_signals WHERE run_id = ?`)
      .all(runId) as SignalRow[];
    expect(signals.length).toBe(0);

    const rejections = db
      .query(`SELECT * FROM _smithers_events WHERE type = ?`)
      .all(REJECTION_AUDIT_TYPE) as EventRow[];
    expect(rejections.length).toBe(1);
    const audit = JSON.parse(rejections[0]!.payload_json) as Record<string, unknown>;
    expect(audit.reason).toBe("missing_signature");
    expect(audit.status).toBe(401);
    expect(audit.workflow).toBe(harness.workflowKey);
    expect(typeof audit.requestId).toBe("string");
    expect(typeof audit.timestampMs).toBe("number");
    expect(audit.providedSignature).toBeNull();
  });

  test("rejected attempts do not advance signal seq for unrelated run", async () => {
    const db = buildDb();
    onTestFinished(() => db.close());
    const harness = await startWebhookServer(db, "shared-secret-correct");
    onTestFinished(() => harness.close());

    const runId = "case17-mixed";
    seedWaitingRun(db, runId);

    const goodBody = JSON.stringify({ runId, correlationId: "c1", data: { n: 1 } });
    const goodSig = computeSignature(Buffer.from(goodBody), harness.secret, harness.signaturePrefix);
    const okResult = await postWebhook(harness.port, harness.workflowKey, goodBody, goodSig);
    expect(okResult.status).toBe(200);

    const badBody = JSON.stringify({ runId, correlationId: "c2", data: { n: 2 } });
    const badSig = computeSignature(Buffer.from(badBody), "wrong", harness.signaturePrefix);
    const rejectedResult = await postWebhook(harness.port, harness.workflowKey, badBody, badSig);
    expect(rejectedResult.status).toBe(401);

    const signals = db
      .query(`SELECT * FROM _smithers_signals WHERE run_id = ? ORDER BY seq`)
      .all(runId) as SignalRow[];
    expect(signals.length).toBe(1);
    expect(signals[0]!.seq).toBe(0);
    expect(signals[0]!.correlation_id).toBe("c1");

    const rejections = db
      .query(`SELECT * FROM _smithers_events WHERE type = ?`)
      .all(REJECTION_AUDIT_TYPE) as EventRow[];
    expect(rejections.length).toBe(1);
  });

  test.skip("uses production handler in packages/server/src/gateway.js (handleWebhook + computeWebhookSignature)", () => {
    // SKIP: importing the real Gateway from packages/server inside the e2e
    // package fails on `effect` / `@smithers-orchestrator/devtools` resolution
    // because workspace symlinks bypass e2e's flat node_modules (same blocker
    // documented in case14-gateway-rpc-roundtrip.test.ts). This test mirrors
    // the documented contract of `handleWebhook` at
    // packages/server/src/gateway.js:1637 (HMAC-SHA256 over raw body, default
    // header `x-hub-signature-256`, prefix `sha256=`, 401 on mismatch). The
    // production handler currently emits rejection telemetry via metrics +
    // emitGatewayLog only; this test additionally asserts a DB-backed audit
    // row in `_smithers_events` (type='WebhookRejected') so the inspector /
    // forensic logs can show rejected attempts. Promote when /e2e/harness/
    // exposes a `bootGateway` primitive.
  });
});
