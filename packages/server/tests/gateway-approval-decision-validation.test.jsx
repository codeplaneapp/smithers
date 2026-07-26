/** @jsxImportSource smithers-orchestrator */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { z } from "zod";
import { createSmithers } from "smithers-orchestrator";
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
 * A select-mode approval with no allowedUsers restriction, so the scope branch
 * is what gates.
 * @param {string} dbPath
 * @param {string[]} [allowedScopes]
 */
function createSelectApprovalWorkflow(dbPath, allowedScopes = ["run:admin"]) {
  const api = createSmithers(
    {
      selection: z.object({
        selected: z.string(),
        notes: z.string().nullable(),
      }),
    },
    { dbPath },
  );
  const workflow = api.smithers(() => (
    <api.Workflow name="gateway-select-approval">
      <api.Approval
        id="pick-plan"
        mode="select"
        output={api.outputs.selection}
        request={{
          title: "Pick a plan",
          summary: "Choose the best option.",
        }}
        options={[
          { key: "light", label: "Light" },
          { key: "balanced", label: "Balanced" },
        ]}
        allowedScopes={allowedScopes}
        continueOnFail
      />
    </api.Workflow>
  ));
  return { workflow, db: api.db };
}
/**
 * @param {string} dbPath
 */
function createRankApprovalWorkflow(dbPath) {
  const api = createSmithers(
    {
      ranking: z.object({
        ranked: z.array(z.string()),
        notes: z.string().nullable(),
      }),
    },
    { dbPath },
  );
  const workflow = api.smithers(() => (
    <api.Workflow name="gateway-rank-approval">
      <api.Approval
        id="rank-plans"
        mode="rank"
        output={api.outputs.ranking}
        request={{ title: "Rank the plans" }}
        options={[
          { key: "canary", label: "Canary" },
          { key: "regional", label: "Regional" },
          { key: "global", label: "Global" },
        ]}
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
const TOKENS = {
  "operator-token": {
    role: "operator",
    scopes: ["*"],
    userId: "user:operator",
  },
  // Can submit approvals in general, but lacks the run:admin scope that the
  // select approval's allowedScopes demand.
  "approver-token": {
    role: "approver",
    scopes: ["approve", "approvals.list", "runs.get"],
    userId: "user:will",
  },
  "deployment-approver-token": {
    role: "approver",
    scopes: ["approve", "approvals.list", "runs.get", "deploy:approve"],
    userId: "user:deployer",
  },
};
describe("Gateway approval decision validation", () => {
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
  test("select approvals: missing approval-level scope is FORBIDDEN; malformed decisions are rejected before persisting", async () => {
    const dbPath = makeDbPath("select-validation");
    dbPaths.push(dbPath);
    const bundle = createSelectApprovalWorkflow(dbPath);
    const port = await startGateway(bundle, "select-approval");
    const operator = await connectGateway(port, "operator-token");
    const approver = await connectGateway(port, "approver-token");
    const runId = await createRunAndAwaitApproval(operator, "select-approval");
    // The approver can submit approvals in general but lacks run:admin, which
    // this approval's allowedScopes demand.
    const forbidden = await approver.request("approvals.decide", {
      runId,
      nodeId: "pick-plan",
      iteration: 0,
      approved: true,
      decision: { selected: "light" },
    });
    expect(forbidden.ok).toBe(false);
    expect(forbidden.error.code).toBe("FORBIDDEN");
    expect(forbidden.error.message).toContain("scope");
    // Approving without a decision payload cannot satisfy a select approval.
    const missingDecision = await operator.request("approvals.decide", {
      runId,
      nodeId: "pick-plan",
      iteration: 0,
      approved: true,
    });
    expect(missingDecision.ok).toBe(false);
    expect(missingDecision.error.code).toBe("INVALID_REQUEST");
    expect(missingDecision.error.message).toContain("decision.selected");
    // Selections must come from the declared options.
    const unknownSelection = await operator.request("approvals.decide", {
      runId,
      nodeId: "pick-plan",
      iteration: 0,
      approved: true,
      decision: { selected: "turbo" },
    });
    expect(unknownSelection.ok).toBe(false);
    expect(unknownSelection.error.code).toBe("INVALID_REQUEST");
    expect(unknownSelection.error.message).toContain("turbo");
    // Rejected decisions must not have consumed the approval.
    const adapter = new SmithersDb(bundle.db);
    expect((await adapter.getApproval(runId, "pick-plan", 0))?.status).toBe("requested");
    // A valid selection is accepted and persisted.
    const decided = await decideWithRetry(operator, {
      runId,
      nodeId: "pick-plan",
      iteration: 0,
      approved: true,
      decision: { selected: "balanced", notes: "best fit" },
    });
    expect(decided.ok).toBe(true);
    const approval = await adapter.getApproval(runId, "pick-plan", 0);
    expect(approval?.status).toBe("approved");
    expect(JSON.parse(approval?.decisionJson ?? "{}")).toEqual({
      selected: "balanced",
      notes: "best fit",
    });
    await operator.close();
    await approver.close();
  });
  test("custom allowedScopes require a literal grant instead of falling back to run:read", async () => {
    const dbPath = makeDbPath("custom-scope");
    dbPaths.push(dbPath);
    const bundle = createSelectApprovalWorkflow(dbPath, ["deploy:approve"]);
    const port = await startGateway(bundle, "custom-scope-approval");
    const operator = await connectGateway(port, "operator-token");
    const approver = await connectGateway(port, "approver-token");
    const deploymentApprover = await connectGateway(port, "deployment-approver-token");
    const runId = await createRunAndAwaitApproval(operator, "custom-scope-approval");
    const decision = {
      runId,
      nodeId: "pick-plan",
      iteration: 0,
      approved: true,
      decision: { selected: "balanced" },
    };
    const forbidden = await approver.request("approvals.decide", decision);
    expect(forbidden.ok).toBe(false);
    expect(forbidden.error.code).toBe("FORBIDDEN");
    const adapter = new SmithersDb(bundle.db);
    expect((await adapter.getApproval(runId, "pick-plan", 0))?.status).toBe("requested");
    const decided = await decideWithRetry(deploymentApprover, decision);
    expect(decided.ok).toBe(true);
    expect((await adapter.getApproval(runId, "pick-plan", 0))?.status).toBe("approved");
    await operator.close();
    await approver.close();
    await deploymentApprover.close();
  });
  test("malformed durable approval restrictions cannot be decided", async () => {
    const dbPath = makeDbPath("malformed-restrictions");
    dbPaths.push(dbPath);
    const bundle = createSelectApprovalWorkflow(dbPath);
    const port = await startGateway(bundle, "malformed-restrictions-approval");
    const operator = await connectGateway(port, "operator-token");
    const runId = await createRunAndAwaitApproval(operator, "malformed-restrictions-approval");
    const adapter = new SmithersDb(bundle.db);
    const approval = await adapter.getApproval(runId, "pick-plan", 0);
    expect(approval).toBeDefined();
    const originalRequest = JSON.parse(approval?.requestJson ?? "{}");
    const cases = [
      { field: "allowedUsers", value: "user:operator" },
      { field: "allowedUsers", value: ["user:operator", 42] },
      { field: "allowedScopes", value: ["*", ""] },
    ];
    for (const { field, value } of cases) {
      await adapter.insertOrUpdateApproval({
        ...approval,
        requestJson: JSON.stringify({
          ...originalRequest,
          [field]: value,
        }),
      });
      const response = await operator.request("approvals.decide", {
        runId,
        nodeId: "pick-plan",
        iteration: 0,
        approved: true,
        decision: { selected: "balanced" },
      });
      expect(response.ok).toBe(false);
      expect(response.error.code).toBe("INVALID_REQUEST");
      expect(response.error.message).toContain(`${field} must be an array of non-empty strings`);
      expect((await adapter.getApproval(runId, "pick-plan", 0))?.status).toBe("requested");
    }
    await operator.close();
  });
  test("select approvals: denials skip decision-schema validation", async () => {
    const dbPath = makeDbPath("select-deny");
    dbPaths.push(dbPath);
    const bundle = createSelectApprovalWorkflow(dbPath);
    const port = await startGateway(bundle, "select-approval");
    const operator = await connectGateway(port, "operator-token");
    const runId = await createRunAndAwaitApproval(operator, "select-approval");
    // Denying needs no decision payload even for select approvals.
    const denied = await decideWithRetry(operator, {
      runId,
      nodeId: "pick-plan",
      iteration: 0,
      approved: false,
      note: "none of these",
    });
    expect(denied.ok).toBe(true);
    const adapter = new SmithersDb(bundle.db);
    const approval = await adapter.getApproval(runId, "pick-plan", 0);
    expect(approval?.status).toBe("denied");
    expect(approval?.note).toBe("none of these");
    await operator.close();
  });
  test("rank approvals: empty and unknown rankings are rejected; a full ranking is persisted", async () => {
    const dbPath = makeDbPath("rank-validation");
    dbPaths.push(dbPath);
    const bundle = createRankApprovalWorkflow(dbPath);
    const port = await startGateway(bundle, "rank-approval");
    const operator = await connectGateway(port, "operator-token");
    const runId = await createRunAndAwaitApproval(operator, "rank-approval");
    // The smallest ranking we accept is one entry; empty is rejected.
    const emptyRanking = await operator.request("approvals.decide", {
      runId,
      nodeId: "rank-plans",
      iteration: 0,
      approved: true,
      decision: { ranked: [] },
    });
    expect(emptyRanking.ok).toBe(false);
    expect(emptyRanking.error.code).toBe("INVALID_REQUEST");
    expect(emptyRanking.error.message).toContain("decision.ranked");
    // Every ranked key must be a declared option.
    const unknownOption = await operator.request("approvals.decide", {
      runId,
      nodeId: "rank-plans",
      iteration: 0,
      approved: true,
      decision: { ranked: ["canary", "warp-drive"] },
    });
    expect(unknownOption.ok).toBe(false);
    expect(unknownOption.error.code).toBe("INVALID_REQUEST");
    expect(unknownOption.error.message).toContain("unknown options");
    const adapter = new SmithersDb(bundle.db);
    expect((await adapter.getApproval(runId, "rank-plans", 0))?.status).toBe("requested");
    const decided = await decideWithRetry(operator, {
      runId,
      nodeId: "rank-plans",
      iteration: 0,
      approved: true,
      decision: { ranked: ["global", "canary", "regional"], notes: "big bang" },
    });
    expect(decided.ok).toBe(true);
    const approval = await adapter.getApproval(runId, "rank-plans", 0);
    expect(approval?.status).toBe("approved");
    expect(JSON.parse(approval?.decisionJson ?? "{}")).toEqual({
      ranked: ["global", "canary", "regional"],
      notes: "big bang",
    });
    await operator.close();
  });
});
