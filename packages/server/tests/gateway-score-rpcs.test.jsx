/** @jsxImportSource smithers-orchestrator */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { z } from "zod";
import { createSmithers } from "smithers-orchestrator";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { Gateway } from "../src/gateway.js";
import { sleep } from "../../smithers/tests/helpers.js";

const cleanups = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch {}
  }
});

function dbPath(name) {
  return join(tmpdir(), `smithers-score-rpc-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function createWorkflow(path, name) {
  const api = createSmithers({ result: z.object({ value: z.number() }) }, { dbPath: path });
  const workflow = api.smithers(() => (
    <api.Workflow name={name}>
      <api.Task id="task" output={api.outputs.result}>
        {{ value: 1 }}
      </api.Task>
    </api.Workflow>
  ));
  return { api, workflow };
}

async function seedScore(adapter, row) {
  await adapter.insertScorerResult({
    iteration: 0,
    attempt: 1,
    reason: null,
    latencyMs: null,
    durationMs: null,
    metaJson: null,
    inputJson: null,
    outputJson: null,
    groundTruthJson: null,
    contextJson: null,
    ...row,
  });
}

async function boot() {
  const pathA = dbPath("a");
  const pathB = dbPath("b");
  const a = createWorkflow(pathA, "wf-a");
  const aShared = a.api.smithers(() => (
    <a.api.Workflow name="wf-a-shared">
      <a.api.Task id="task" output={a.api.outputs.result}>
        {{ value: 1 }}
      </a.api.Task>
    </a.api.Workflow>
  ));
  const b = createWorkflow(pathB, "wf-b");
  ensureSmithersTables(a.workflow.db);
  ensureSmithersTables(b.workflow.db);
  const adapterA = new SmithersDb(a.workflow.db);
  const adapterB = new SmithersDb(b.workflow.db);
  await adapterA.insertRun({ runId: "run-a", workflowName: "wf-a", status: "finished", createdAtMs: 1 });
  await adapterB.insertRun({ runId: "run-b", workflowName: "wf-b", status: "finished", createdAtMs: 2 });

  await seedScore(adapterA, {
    id: "score-a-early",
    runId: "run-a",
    nodeId: "alpha",
    scorerId: "judge",
    scorerName: "Quality",
    source: "live",
    score: 0.91,
    reason: "good",
    scoredAtMs: 100,
    latencyMs: 12,
    durationMs: 34,
    metaJson: '{"rubric":"quality"}',
    inputJson: '["prompt"]',
    outputJson: '"pass"',
    groundTruthJson: "null",
  });
  await seedScore(adapterA, {
    id: "score-a-tie",
    runId: "run-a",
    nodeId: "beta",
    scorerId: "judge",
    scorerName: "Quality",
    source: "live",
    score: 0.8,
    scoredAtMs: 200,
  });
  await seedScore(adapterA, {
    id: "score-malformed",
    runId: "run-a",
    nodeId: "gamma",
    scorerId: "judge",
    scorerName: "Quality",
    source: "batch",
    score: 0.1,
    scoredAtMs: 250,
    metaJson: "{not-json",
  });
  await seedScore(adapterB, {
    id: "score-b-middle",
    runId: "run-b",
    nodeId: "alpha",
    scorerId: "judge",
    scorerName: "quality",
    source: "batch",
    score: 0.7,
    scoredAtMs: 150,
  });
  await seedScore(adapterB, {
    id: "score-b-tie",
    runId: "run-b",
    nodeId: "alpha",
    scorerId: "judge",
    scorerName: "Quality",
    source: "live",
    score: 0.85,
    scoredAtMs: 200,
  });

  const gateway = new Gateway({
    auth: {
      mode: "token",
      tokens: {
        "score-token": { role: "viewer", scopes: ["score:read"] },
        "run-token": { role: "viewer", scopes: ["run:read"] },
      },
    },
  });
  gateway.register("wf-a", a.workflow);
  // A second workflow on the same physical store exercises adapter/store dedupe.
  gateway.register("wf-a-shared", aShared);
  gateway.register("wf-b", b.workflow);
  const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("gateway has no port");
  cleanups.push(() => {
    a.workflow.db.$client?.close?.();
    b.workflow.db.$client?.close?.();
    for (const path of [pathA, pathB]) {
      rmSync(path, { force: true });
      rmSync(`${path}-shm`, { force: true });
      rmSync(`${path}-wal`, { force: true });
    }
  });
  cleanups.push(() => gateway.close());
  return { baseUrl: `http://127.0.0.1:${address.port}`, port: address.port };
}

async function rpc(baseUrl, method, params, token = "score-token") {
  const response = await fetch(`${baseUrl}/v1/rpc/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  return { status: response.status, json: await response.json() };
}

async function rest(baseUrl, path, token = "score-token") {
  const response = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: response.status, json: await response.json() };
}

class WsClient {
  messages = [];
  constructor(ws) {
    this.ws = ws;
    ws.on("message", (raw) => this.messages.push(JSON.parse(String(raw))));
  }
  async waitFor(predicate) {
    for (let i = 0; i < 500; i += 1) {
      const index = this.messages.findIndex(predicate);
      if (index >= 0) return this.messages.splice(index, 1)[0];
      await sleep(10);
    }
    throw new Error(`timed out waiting for WS message: ${JSON.stringify(this.messages)}`);
  }
  async request(method, params) {
    const id = `${method}-${Math.random()}`;
    this.ws.send(JSON.stringify({ type: "req", id, method, params }));
    return this.waitFor((message) => message.type === "res" && message.id === id);
  }
  async close() {
    if (this.ws.readyState === this.ws.CLOSED) return;
    await new Promise((resolve) => {
      this.ws.once("close", resolve);
      this.ws.close();
    });
  }
}

async function wsClient(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const client = new WsClient(ws);
  await client.waitFor((message) => message.type === "event" && message.event === "connect.challenge");
  const hello = await client.request("connect", {
    minProtocol: 1,
    maxProtocol: 1,
    client: { id: "score-rpc-test", version: "1", platform: "bun" },
    auth: { token: "score-token" },
  });
  expect(hello.ok).toBe(true);
  cleanups.push(() => client.close());
  return client;
}

describe("Gateway cross-run score RPCs", () => {
  test("globally orders/pages real rows across distinct and shared SQLite stores", async () => {
    const { baseUrl, port } = await boot();
    const compared = await rpc(baseUrl, "listScoresForRuns", {
      runIds: [" run-b ", "run-a", "run-b"],
    });
    expect(compared.status).toBe(200);
    expect(compared.json.payload.total).toBe(5);
    expect(compared.json.payload.rows.map((row) => row.scoreId)).toEqual([
      "score-a-early",
      "score-b-middle",
      "score-a-tie",
      "score-b-tie",
      "score-malformed",
    ]);
    expect(compared.json.payload.rows[0]).not.toHaveProperty("meta");
    expect(compared.json.payload.rows[0]).not.toHaveProperty("metaJson");
    expect(compared.json.payload.rows[0]).not.toHaveProperty("input");

    const page = await rpc(baseUrl, "listScoresForRuns", {
      runIds: ["run-a", "run-b"],
      offset: 1,
      limit: 2,
    });
    expect(page.json.payload.total).toBe(5);
    expect(page.json.payload.rows.map((row) => row.scoreId)).toEqual(["score-b-middle", "score-a-tie"]);

    const descending = await rpc(baseUrl, "listScoresForRuns", {
      runIds: ["run-a", "run-b"],
      order: "scoredAtDesc",
      offset: 1,
      limit: 3,
    });
    // Timestamp direction flips, but ties remain ascending by runId and fields.
    expect(descending.json.payload.rows.map((row) => row.scoreId)).toEqual([
      "score-a-tie",
      "score-b-tie",
      "score-b-middle",
    ]);

    const filtered = await rpc(baseUrl, "listScoresForRuns", {
      runIds: ["run-a", "run-b"],
      nodeId: "alpha",
      scorerId: "judge",
      scorerName: "Quality",
      source: "live",
    });
    expect(filtered.json.payload.rows.map((row) => row.scoreId)).toEqual(["score-a-early", "score-b-tie"]);
    const caseSensitive = await rpc(baseUrl, "listScoresForRuns", {
      runIds: ["run-a", "run-b"],
      scorerName: "quality",
      source: "batch",
    });
    expect(caseSensitive.json.payload.rows.map((row) => row.scoreId)).toEqual(["score-b-middle"]);

    const empty = await rpc(baseUrl, "listScoresForRuns", { runIds: [] });
    expect(empty.json.payload).toEqual({ rows: [], total: 0 });

    const detail = await rpc(baseUrl, "getScoreDetail", { runId: " run-a ", scoreId: " score-a-early " });
    expect(detail.json.payload).toMatchObject({
      scoreId: "score-a-early",
      runId: "run-a",
      meta: { rubric: "quality" },
      input: ["prompt"],
      output: "pass",
      groundTruth: null,
      context: null,
    });
    const nullDetail = await rpc(baseUrl, "getScoreDetail", { runId: "run-a", scoreId: "score-a-tie" });
    expect(nullDetail.json.payload).toMatchObject({
      meta: null,
      input: null,
      output: null,
      groundTruth: null,
      context: null,
    });

    // listScores remains the legacy per-run array and does not gain identity/detail fields.
    const legacy = await rpc(baseUrl, "listScores", { runId: "run-a" });
    expect(legacy.json.payload.map((row) => row.scoredAtMs)).toEqual([100, 200, 250]);
    expect(legacy.json.payload[0]).not.toHaveProperty("scoreId");
    expect(legacy.json.payload[0]).not.toHaveProperty("meta");

    const restCompare = await rest(baseUrl, "/v1/api/scores/compare?runId=run-b&runId=run-a&offset=1&limit=2");
    expect(restCompare.status).toBe(200);
    expect(restCompare.json.data).toEqual(page.json.payload);
    const restDetail = await rest(baseUrl, "/v1/api/scores/run-a/score-a-early");
    expect(restDetail.json.data).toEqual(detail.json.payload);

    const ws = await wsClient(port);
    const wsCompared = await ws.request("listScoresForRuns", { runIds: ["run-a", "run-b"], limit: 1 });
    expect(wsCompared.ok).toBe(true);
    expect(wsCompared.payload).toMatchObject({ total: 5, rows: [{ scoreId: "score-a-early" }] });
    const wsDetail = await ws.request("getScoreDetail", { runId: "run-a", scoreId: "score-a-early" });
    expect(wsDetail.ok).toBe(true);
    expect(wsDetail.payload.meta).toEqual({ rubric: "quality" });
  });

  test("rejects invalid/auth requests and returns typed atomic not-found/internal errors", async () => {
    const { baseUrl } = await boot();
    const forbidden = await rpc(baseUrl, "listScoresForRuns", { runIds: ["run-a"] }, "run-token");
    expect(forbidden.status).toBe(403);
    expect(forbidden.json.error.code).toBe("FORBIDDEN");
    const restForbidden = await rest(baseUrl, "/v1/api/scores/compare?runId=run-a", "run-token");
    expect(restForbidden.status).toBe(403);

    for (const params of [
      {},
      { runIds: "run-a" },
      { runIds: [1] },
      { runIds: [" "] },
      { runIds: ["run-a"], source: "eval" },
      { runIds: ["run-a"], order: "newest" },
      { runIds: ["run-a"], offset: -1 },
      { runIds: ["run-a"], offset: 10_000 },
      { runIds: ["run-a"], limit: 0 },
      { runIds: ["run-a"], limit: 501 },
      { runIds: ["run-a"], limit: 1.5 },
      { runIds: ["run-a"], offset: 9_999, limit: 2 },
      { runIds: [], limit: 0 },
      { runIds: ["run-a"], extra: true },
      { runIds: ["x".repeat(257)] },
    ]) {
      const invalid = await rpc(baseUrl, "listScoresForRuns", params);
      expect(invalid.status, JSON.stringify(params)).toBe(400);
    }
    const tooMany = await rpc(baseUrl, "listScoresForRuns", {
      runIds: Array.from({ length: 31 }, (_, index) => `run-${index}`),
    });
    expect(tooMany.status).toBe(400);
    // Thirty repeated entries normalize to one first-seen id and remain valid.
    const duplicates = await rpc(baseUrl, "listScoresForRuns", { runIds: Array(30).fill(" run-a "), limit: 1 });
    expect(duplicates.status).toBe(200);

    const unknown = await rpc(baseUrl, "listScoresForRuns", { runIds: ["run-a", "missing"] });
    expect(unknown.status).toBe(404);
    expect(unknown.json.error.code).toBe("RunNotFound");
    const missingRun = await rpc(baseUrl, "getScoreDetail", { runId: "missing", scoreId: "score-a-early" });
    expect(missingRun.json.error.code).toBe("RunNotFound");
    const missingScore = await rpc(baseUrl, "getScoreDetail", { runId: "run-b", scoreId: "score-a-early" });
    expect(missingScore.json.error.code).toBe("ScoreNotFound");
    const blankDetail = await rpc(baseUrl, "getScoreDetail", { runId: " ", scoreId: " " });
    expect(blankDetail.status).toBe(400);
    const longDetail = await rpc(baseUrl, "getScoreDetail", { runId: "run-a", scoreId: "x".repeat(257) });
    expect(longDetail.status).toBe(400);

    const malformed = await rpc(baseUrl, "getScoreDetail", { runId: "run-a", scoreId: "score-malformed" });
    expect(malformed.status).toBe(500);
    expect(malformed.json.error.code).toBe("Internal");

    // REST uses strict integer parsing too; it never floors a decimal limit.
    const decimalRest = await rest(baseUrl, "/v1/api/scores/compare?runId=run-a&limit=1.5");
    expect(decimalRest.status).toBe(400);
    const invalidEmptyRest = await rest(baseUrl, "/v1/api/scores/compare?limit=0");
    expect(invalidEmptyRest.status).toBe(400);
    const precedence = await rest(baseUrl, "/v1/api/scores/compare");
    expect(precedence.status).toBe(200);
    expect(precedence.json.data).toEqual({ rows: [], total: 0 });
  });
});
