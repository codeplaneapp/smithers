/** @jsxImportSource smithers-orchestrator */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { createSmithers, approvalDecisionSchema } from "smithers-orchestrator";
import { Gateway } from "../src/gateway.js";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { sleep } from "../../smithers/tests/helpers.js";
/**
 * @param {Server} server
 * @returns {number}
 */
function getPort(server) {
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Gateway server did not expose a port");
  }
  return addr.port;
}
/**
 * @param {string} name
 */
function makeDbPath(name) {
  return join(tmpdir(), `smithers-gateway-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}
/**
 * A decision-mode approval restricted to a single user identity, with NO
 * allowedScopes — so the user branch is the only approval-level gate.
 * @param {string} dbPath
 * @param {string[]} [allowedScopes]
 */
function createAllowedUsersWorkflow(dbPath, allowedScopes = []) {
  const api = createSmithers({ approval: approvalDecisionSchema }, { dbPath });
  const workflow = api.smithers(() => (
    <api.Workflow name="gateway-allowed-users">
      <api.Approval
        id="ship"
        output={api.outputs.approval}
        request={{
          title: "Ship the release?",
        }}
        allowedUsers={["user:will"]}
        {...(allowedScopes.length > 0 ? { allowedScopes } : {})}
      />
    </api.Workflow>
  ));
  return { workflow, db: api.db };
}
class GatewayClient {
  ws;
  messages = [];
  /**
   * @param {WebSocket} ws
   */
  constructor(ws) {
    this.ws = ws;
    ws.on("message", (raw) => {
      this.messages.push(JSON.parse(String(raw)));
    });
  }
  /**
   * @param {(message: GatewayMessage) => boolean} predicate
   * @returns {Promise<GatewayMessage>}
   */
  async waitFor(predicate, timeoutMs = 5_000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const index = this.messages.findIndex(predicate);
      if (index >= 0) {
        return this.messages.splice(index, 1)[0];
      }
      await sleep(10);
    }
    throw new Error(
      `Timed out waiting for gateway message. Saw: ${JSON.stringify(
        this.messages.map((message) => ({
          type: message.type,
          event: message.event,
          id: message.id,
        })),
      )}`,
    );
  }
  /**
   * @param {string} method
   * @param {unknown} [params]
   */
  async request(method, params) {
    const id = `${method}-${Math.random().toString(36).slice(2)}`;
    this.ws.send(
      JSON.stringify({
        type: "req",
        id,
        method,
        params,
      }),
    );
    return this.waitFor((message) => message.type === "res" && message.id === id);
  }
  async close() {
    if (this.ws.readyState === this.ws.CLOSED) {
      return;
    }
    await new Promise((resolve) => {
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }
}
/**
 * @param {number} port
 * @param {string} token
 */
async function connectGateway(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const client = new GatewayClient(ws);
  await client.waitFor((message) => message.type === "event" && message.event === "connect.challenge");
  const hello = await client.request("connect", {
    minProtocol: 1,
    maxProtocol: 1,
    client: {
      id: "test-client",
      version: "1.0.0",
      platform: "bun-test",
    },
    auth: { token },
  });
  expect(hello.ok).toBe(true);
  return client;
}
const APPROVER_SCOPES = ["approve", "approvals.list", "runs.get"];
const TOKENS = {
  "operator-token": {
    role: "operator",
    scopes: ["*"],
    userId: "user:operator",
  },
  // Has every method scope the decide call needs, but the wrong identity.
  "wrong-user-token": {
    role: "approver",
    scopes: APPROVER_SCOPES,
    userId: "user:bob",
  },
  // Same scopes, but the token carries no user identity at all.
  "anonymous-approver-token": {
    role: "approver",
    scopes: APPROVER_SCOPES,
  },
  // The one identity the approval's allowedUsers admits.
  "will-token": {
    role: "approver",
    scopes: APPROVER_SCOPES,
    userId: "user:will",
  },
  // Right identity AND wildcard scopes — passes both approval-level gates.
  "will-admin-token": {
    role: "approver",
    scopes: ["*"],
    userId: "user:will",
  },
};
describe("Gateway approval allowedUsers enforcement", () => {
  let gateway;
  let server;
  let dbPaths = [];
  beforeEach(() => {
    dbPaths = [];
  });
  afterEach(async () => {
    if (gateway) {
      await gateway.close();
      gateway = undefined;
    }
    for (const dbPath of dbPaths) {
      for (const suffix of ["", "-shm", "-wal"]) {
        try {
          rmSync(`${dbPath}${suffix}`, { force: true });
        } catch {
          /* best-effort cleanup */
        }
      }
    }
  });
  /**
   * @param {{ workflow: unknown }} bundle
   * @param {string} key
   */
  async function startGateway(bundle, key) {
    gateway = new Gateway({
      protocol: 1,
      features: ["approvals", "runs"],
      heartbeatMs: 100,
      auth: { mode: "token", tokens: TOKENS },
    });
    gateway.register(key, bundle.workflow);
    server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    return getPort(server);
  }
  /**
   * @param {GatewayClient} client
   * @param {string} workflow
   */
  async function createRunAndAwaitApproval(client, workflow) {
    const create = await client.request("runs.create", { workflow, input: {} });
    expect(create.ok).toBe(true);
    const runId = create.payload.runId;
    await client.waitFor(
      (message) =>
        message.type === "event" && message.event === "approval.requested" && message.payload.runId === runId,
    );
    return runId;
  }
  /**
   * The approval.requested event can precede the node's waiting-approval state
   * write, so retry decisions that land in that window.
   * @param {GatewayClient} client
   * @param {Record<string, unknown>} params
   */
  async function decideWithRetry(client, params) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await client.request("approvals.decide", params);
      if (response.ok || !String(response.error?.message ?? "").includes("not waiting for approval")) {
        return response;
      }
      await sleep(50);
    }
    throw new Error("approvals.decide kept racing the waiting-approval state");
  }
  test("allowedUsers alone gates by identity: wrong-user and identity-less tokens are FORBIDDEN, the allowed user decides", async () => {
    const dbPath = makeDbPath("allowed-users");
    dbPaths.push(dbPath);
    const bundle = createAllowedUsersWorkflow(dbPath);
    const port = await startGateway(bundle, "allowed-users");
    const operator = await connectGateway(port, "operator-token");
    const wrongUser = await connectGateway(port, "wrong-user-token");
    const anonymous = await connectGateway(port, "anonymous-approver-token");
    const will = await connectGateway(port, "will-token");
    const runId = await createRunAndAwaitApproval(operator, "allowed-users");
    const decideParams = {
      runId,
      nodeId: "ship",
      iteration: 0,
      approved: true,
      note: "lgtm",
    };
    // A different identity is rejected by the user branch, not the scope one.
    const wrongUserResponse = await wrongUser.request("approvals.decide", decideParams);
    expect(wrongUserResponse.ok).toBe(false);
    expect(wrongUserResponse.error.code).toBe("FORBIDDEN");
    expect(wrongUserResponse.error.message).toContain("not allowed to decide");
    // A token without any user identity can never satisfy allowedUsers,
    // even with sufficient scopes.
    const anonymousResponse = await anonymous.request("approvals.decide", decideParams);
    expect(anonymousResponse.ok).toBe(false);
    expect(anonymousResponse.error.code).toBe("FORBIDDEN");
    expect(anonymousResponse.error.message).toContain("not allowed to decide");
    // The operator's wildcard scopes do not bypass the identity restriction.
    const operatorResponse = await operator.request("approvals.decide", decideParams);
    expect(operatorResponse.ok).toBe(false);
    expect(operatorResponse.error.code).toBe("FORBIDDEN");
    expect(operatorResponse.error.message).toContain("not allowed to decide");
    // None of the rejected decisions consumed the approval.
    const adapter = new SmithersDb(bundle.db);
    expect((await adapter.getApproval(runId, "ship", 0))?.status).toBe("requested");
    // The allowed identity decides, and is recorded as the decider.
    const decided = await decideWithRetry(will, decideParams);
    expect(decided.ok).toBe(true);
    const approval = await adapter.getApproval(runId, "ship", 0);
    expect(approval?.status).toBe("approved");
    expect(approval?.decidedBy).toBe("user:will");
    expect(approval?.note).toBe("lgtm");
    await operator.close();
    await wrongUser.close();
    await anonymous.close();
    await will.close();
  });
  test("passing allowedUsers does not bypass allowedScopes: both approval-level gates must pass", async () => {
    const dbPath = makeDbPath("users-and-scopes");
    dbPaths.push(dbPath);
    const bundle = createAllowedUsersWorkflow(dbPath, ["run:admin"]);
    const port = await startGateway(bundle, "users-and-scopes");
    const operator = await connectGateway(port, "operator-token");
    const will = await connectGateway(port, "will-token");
    const willAdmin = await connectGateway(port, "will-admin-token");
    const runId = await createRunAndAwaitApproval(operator, "users-and-scopes");
    const decideParams = {
      runId,
      nodeId: "ship",
      iteration: 0,
      approved: true,
    };
    // The right identity without run:admin is stopped by the scope branch —
    // its message names the scope, not the user restriction.
    const missingScope = await will.request("approvals.decide", decideParams);
    expect(missingScope.ok).toBe(false);
    expect(missingScope.error.code).toBe("FORBIDDEN");
    expect(missingScope.error.message).toContain("scope");
    const adapter = new SmithersDb(bundle.db);
    expect((await adapter.getApproval(runId, "ship", 0))?.status).toBe("requested");
    // The same identity with sufficient scopes passes both gates.
    const decided = await decideWithRetry(willAdmin, decideParams);
    expect(decided.ok).toBe(true);
    expect((await adapter.getApproval(runId, "ship", 0))?.status).toBe("approved");
    await operator.close();
    await will.close();
    await willAdmin.close();
  });
});
