import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { z } from "zod";
import { createSmithers } from "smithers-orchestrator";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { Gateway, type SmithersWorkflow } from "@smithers-orchestrator/server/gateway";

const WORKFLOW_KEY = "case17-webhook";
const SECRET = "shared-secret-correct";
const SIGNATURE_HEADER = "x-hub-signature-256";
const SIGNATURE_PREFIX = "sha256=";

type WebhookBody = {
  ok: boolean;
  error?: { code: string; message: string };
  verified?: boolean;
};

function makeDbPath(): string {
  return join(
    tmpdir(),
    `smithers-case17-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function createWebhookWorkflow(dbPath: string) {
  const { smithers, Workflow, Task, outputs, db } = createSmithers(
    {
      input: z.object({ branch: z.string().optional() }),
      done: z.object({ ok: z.boolean() }),
    },
    { dbPath },
  );
  const workflow = smithers(() =>
    React.createElement(
      Workflow,
      { name: WORKFLOW_KEY },
      React.createElement(Task, {
        id: "record-webhook",
        output: outputs.done,
        children: { ok: true },
      }),
    ),
  );
  return { workflow, db };
}

function getPort(server: { address(): unknown }): number {
  const address = server.address();
  if (!address || typeof address === "string" || typeof (address as { port?: unknown }).port !== "number") {
    throw new Error("Gateway server did not expose a port");
  }
  return (address as { port: number }).port;
}

function computeSignature(body: string, secret: string): string {
  return `${SIGNATURE_PREFIX}${createHmac("sha256", secret).update(Buffer.from(body)).digest("hex")}`;
}

async function postWebhook(
  port: number,
  body: string,
  signature: string | null,
): Promise<{ status: number; body: WebhookBody }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== null) headers[SIGNATURE_HEADER] = signature;
  const response = await fetch(`http://127.0.0.1:${port}/webhooks/${WORKFLOW_KEY}`, {
    method: "POST",
    headers,
    body,
  });
  return { status: response.status, body: (await response.json()) as WebhookBody };
}

describe("case 17: webhook signal with invalid signature is rejected by the real Gateway", () => {
  let gateway: Gateway | undefined;
  let server: { address(): unknown } | undefined;
  let port = 0;
  const dbPaths: string[] = [];

  beforeEach(async () => {
    const dbPath = makeDbPath();
    dbPaths.push(dbPath);
    const { workflow, db } = createWebhookWorkflow(dbPath);
    ensureSmithersTables(db);

    gateway = new Gateway();
    gateway.register(WORKFLOW_KEY, workflow as SmithersWorkflow, {
      webhook: {
        secret: SECRET,
        signatureHeader: SIGNATURE_HEADER,
        signaturePrefix: SIGNATURE_PREFIX,
        run: { enabled: true },
      },
    });
    server = (await gateway.listen({ port: 0, host: "127.0.0.1" })) as { address(): unknown };
    port = getPort(server);
  });

  afterEach(async () => {
    if (gateway) {
      await gateway.close();
      gateway = undefined;
      server = undefined;
    }
    for (const dbPath of dbPaths) {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
    }
    dbPaths.length = 0;
  });

  test("uses production handleWebhook + HMAC verification and rejects a wrong secret", async () => {
    const body = JSON.stringify({ branch: "main" });
    const wrongSignature = computeSignature(body, "shared-secret-wrong");

    const rejected = await postWebhook(port, body, wrongSignature);
    expect(rejected.status).toBe(401);
    expect(rejected.body.ok).toBe(false);
    expect(rejected.body.error?.code).toBe("UNAUTHORIZED");
    expect(rejected.body.error?.message).toContain("signature");
  });

  test("uses production computeWebhookSignature path for a valid HMAC", async () => {
    const body = JSON.stringify({ branch: "main" });
    const signature = computeSignature(body, SECRET);

    const accepted = await postWebhook(port, body, signature);
    expect(accepted.status).toBe(200);
    expect(accepted.body.ok).toBe(true);
    expect(accepted.body.verified).toBe(true);
  });
});
