import { afterEach, describe, expect, test } from "bun:test";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { serializeRunRow } from "@smithers-orchestrator/gateway/api";
import { QueryClient } from "@tanstack/react-query";
import { createSmithersPostgres } from "smithers-orchestrator";

import {
  approvalsShapeWhere,
  createSmithersCollections,
  runsShapeWhere,
} from "../../src/data/createSmithersCollections.ts";
import { createSmithersDataClient } from "../../src/data/createSmithersDataClient.ts";
import { mapSmithersElectricRow } from "../../src/data/mapSmithersElectricRow.ts";
import { smithersElectricCollectionOptions } from "../../src/data/smithersElectricCollectionOptions.ts";
import type { SmithersCollections } from "../../src/data/SmithersCollections.ts";

/**
 * Issue #1014: multiplayer run and approval collections must honor the
 * documented RPC filters. Two layers are exercised here, both for real:
 *
 * 1. The pushed-down run-shape `where` predicates are executed as actual SQL
 *    over a seeded PGlite database (the same evaluation Electric performs in
 *    Postgres) and compared row-for-row with the local RPC data source. The
 *    approval case proves why a single-table shape is insufficient and must
 *    fall back to the RPC.
 *
 * 2. The collection factories route each documented filter either to a real
 *    Electric collection carrying the validated predicate, or — when the
 *    filter cannot be represented in a shape (limit, workflow, unsafe
 *    literals) — to the RPC-backed query collection that local mode uses, so
 *    multiplayer and local collections return identical rows.
 */
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

type PgConnection = {
  query: (query: { text: string; values?: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }>;
};

async function seededPglite() {
  const api = await createSmithersPostgres({}, { provider: "pglite" });
  cleanups.push(() => api.close());
  const adapter = new SmithersDb(api.db);
  const connection = (api.db as unknown as { connection: PgConnection }).connection;
  const now = 1_718_000_000_000;

  const runs = [
    { runId: "run-running", status: "running", createdAtMs: now },
    { runId: "run-continued", status: "continued", createdAtMs: now + 1 },
    { runId: "run-finished", status: "finished", createdAtMs: now + 2 },
    { runId: "run-failed", status: "failed", createdAtMs: now + 3 },
  ];
  for (const run of runs) {
    await adapter.insertRun({
      runId: run.runId,
      workflowName: "value",
      status: run.status,
      createdAtMs: run.createdAtMs,
      configJson: JSON.stringify({ gatewayWorkflowKey: "value" }),
    });
  }

  const approvals = [
    { runId: "run-running", nodeId: "gate-pending", status: "requested" },
    { runId: "run-running", nodeId: "gate-decided", status: "approved" },
    { runId: "run-finished", nodeId: "gate-other-run", status: "requested" },
  ];
  for (const [index, approval] of approvals.entries()) {
    await connection.query({
      text: `INSERT INTO _smithers_approvals
        (run_id, node_id, iteration, status, requested_at_ms, request_json, auto_approved)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      values: [approval.runId, approval.nodeId, 0, approval.status, now + 10 + index, JSON.stringify({
        title: approval.nodeId,
        mode: "manual",
      }), 0],
    });
  }

  const shapeRows = async (table: string, where: string | undefined) => {
    const result = await connection.query({
      text: `SELECT * FROM ${table}${where ? ` WHERE ${where}` : ""}`,
    });
    return result.rows;
  };
  return { adapter, shapeRows };
}

const sortByRunId = (rows: Array<{ runId?: unknown }>) =>
  [...rows].sort((a, b) => String(a.runId).localeCompare(String(b.runId)));
const approvalKey = (row: { runId?: unknown; nodeId?: unknown; iteration?: unknown }) =>
  `${row.runId}:${row.nodeId}:${row.iteration ?? 0}`;

describe("Electric pushdown predicates match the RPC rows on a seeded dataset", () => {
  test("runs status filters return identical rows and exclude non-matching statuses", async () => {
    const { adapter, shapeRows } = await seededPglite();

    // status: "finished" — a plain equality pushdown.
    const finishedWhere = runsShapeWhere({ filter: { status: "finished" } });
    expect(finishedWhere).toEqual({ where: "status = 'finished'" });
    const electricFinished = sortByRunId(
      (await shapeRows("_smithers_runs", finishedWhere?.where)).map((row) => mapSmithersElectricRow("runs", row)),
    );
    const localFinished = sortByRunId(
      (await adapter.listRuns(50, "finished")).map((row) => serializeRunRow(row as Record<string, unknown>)),
    );
    expect(electricFinished).toEqual(localFinished);
    expect(electricFinished.map((row) => row.runId)).toEqual(["run-finished"]);

    // status: "running" — the adapter's special case also matches "continued".
    const runningWhere = runsShapeWhere({ filter: { status: "running" } });
    expect(runningWhere).toEqual({ where: "(status = 'running' OR status = 'continued')" });
    const electricRunning = sortByRunId(
      (await shapeRows("_smithers_runs", runningWhere?.where)).map((row) => mapSmithersElectricRow("runs", row)),
    );
    const localRunning = sortByRunId(
      (await adapter.listRuns(50, "running")).map((row) => serializeRunRow(row as Record<string, unknown>)),
    );
    expect(electricRunning).toEqual(localRunning);
    expect(electricRunning.map((row) => row.runId)).toEqual(["run-continued", "run-running"]);

    // No filter — every run syncs (no where clause at all).
    const allWhere = runsShapeWhere({});
    expect(allWhere).toEqual({});
    const electricAll = sortByRunId(
      (await shapeRows("_smithers_runs", undefined)).map((row) => mapSmithersElectricRow("runs", row)),
    );
    const localAll = sortByRunId(
      (await adapter.listRuns(50)).map((row) => serializeRunRow(row as Record<string, unknown>)),
    );
    expect(electricAll).toEqual(localAll);
  }, 120_000);

  test("approvals stay RPC-backed because requested rows on terminal runs are not pending", async () => {
    const { adapter, shapeRows } = await seededPglite();

    // A status-only shape sees both requested rows, including the stranded row
    // on the finished run. The DB correctly exposes only the actionable one.
    const shapeRequested = (await shapeRows("_smithers_approvals", "status = 'requested'"))
      .map((row) => mapSmithersElectricRow("approvals", row));
    expect(new Set(shapeRequested.map(approvalKey))).toEqual(new Set([
      "run-running:gate-pending:0",
      "run-finished:gate-other-run:0",
    ]));
    expect((await adapter.listPendingApprovals("run-running")).map(approvalKey))
      .toEqual(["run-running:gate-pending:0"]);
    expect(await adapter.listPendingApprovals("run-finished")).toEqual([]);

    expect(approvalsShapeWhere({})).toBeUndefined();
    expect(approvalsShapeWhere({ filter: { runId: "run-running" } })).toBeUndefined();
  }, 120_000);
});

describe("pushdown validation falls back to the RPC-backed collection", () => {
  test("filters an Electric shape cannot represent return no pushdown", () => {
    // Shapes have no ORDER BY/LIMIT.
    expect(runsShapeWhere({ filter: { limit: 5 } })).toBeUndefined();
    expect(runsShapeWhere({ filter: { offset: 0 } })).toBeUndefined();
    expect(runsShapeWhere({ filter: { offset: 10 } })).toBeUndefined();
    expect(approvalsShapeWhere({ filter: { limit: 1 } })).toBeUndefined();
    // Workflow matching resolves gateway workflow keys in JS.
    expect(runsShapeWhere({ filter: { workflow: "deploy" } })).toBeUndefined();
    expect(approvalsShapeWhere({ filter: { workflow: "deploy" } })).toBeUndefined();
    // Values outside the conservative literal charset are never interpolated.
    expect(runsShapeWhere({ filter: { status: "fin'ished" } })).toBeUndefined();
    expect(runsShapeWhere({ filter: { status: "has space" } })).toBeUndefined();
    expect(approvalsShapeWhere({ filter: { runId: "run' OR 1=1 --" } })).toBeUndefined();
    // Safe run values push down. Approval reads remain RPC-backed because run
    // liveness and waiting-node fallback cannot be expressed by their shape.
    expect(runsShapeWhere({ filter: { status: "waiting-approval" } }))
      .toEqual({ where: "status = 'waiting-approval'" });
    expect(approvalsShapeWhere({ filter: { runId: "wf_18a3.run:1" } }))
      .toBeUndefined();
  });
});

const multiplayerMode = {
  kind: "multiplayer" as const,
  apiBaseUrl: "http://127.0.0.1:65535/",
  electricBaseUrl: "http://127.0.0.1:65534",
  workspaceId: "workspace-mp",
  token: "mp-token",
};

const apiRuns = [
  { runId: "run-1", workflowKey: "value", status: "finished" },
  { runId: "run-2", workflowKey: "value", status: "failed" },
];
const apiApprovals = [{ runId: "run-1", nodeId: "gate", iteration: 0 }];

function routingFetch() {
  const calls: Array<{ method: string; path: string; search: URLSearchParams }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ method: init?.method ?? "GET", path: url.pathname, search: url.searchParams });
    const data = url.pathname === "/v1/api/runs" ? apiRuns : url.pathname === "/v1/api/approvals" ? apiApprovals : [];
    return new Response(JSON.stringify({ ok: true, data, txid: "1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

async function recordingCollections(fetchImpl: typeof fetch) {
  // Wrap the REAL Electric option builder through the injectable loader seam so
  // the shape `where` each Electric-backed collection is created with is
  // observable without a live Electric server (shapes sync lazily).
  const shapes: Array<{ shape: string; where?: string }> = [];
  await smithersElectricCollectionOptions.load();
  const recordingElectric = Object.assign(
    (config: { shape: string; where?: string }) => {
      shapes.push({ shape: config.shape, ...(config.where === undefined ? {} : { where: config.where }) });
      return smithersElectricCollectionOptions(config as never);
    },
    { load: smithersElectricCollectionOptions.load },
  ) as unknown as typeof smithersElectricCollectionOptions;

  const queryClient = new QueryClient();
  const client = createSmithersDataClient({ mode: multiplayerMode, fetch: fetchImpl });
  const collections = await (createSmithersCollections as unknown as (
    client: ReturnType<typeof createSmithersDataClient>,
    qc: QueryClient,
    load: () => Promise<typeof recordingElectric>,
  ) => Promise<SmithersCollections>)(client, queryClient, async () => recordingElectric);
  cleanups.push(() => {
    collections.close();
    client.close();
    queryClient.clear();
  });
  return { collections, shapes };
}

describe("multiplayer collections honor run and approval filters", () => {
  test("safe run filters use Electric while approvals preserve RPC semantics", async () => {
    const { fetchImpl, calls } = routingFetch();
    const { collections, shapes } = await recordingCollections(fetchImpl);

    collections.runs();
    collections.runs({ filter: { status: "failed" } });
    collections.runs({ filter: { status: "running" } });
    const approvals = collections.approvals();
    const runApprovals = collections.approvals({ filter: { runId: "run-1" } });

    expect(shapes).toEqual([
      { shape: "runs" },
      { shape: "runs", where: "status = 'failed'" },
      { shape: "runs", where: "(status = 'running' OR status = 'continued')" },
    ]);

    await approvals.preload();
    await runApprovals.preload();
    expect(calls.filter((call) => call.path === "/v1/api/approvals").map((call) => call.search.toString()))
      .toEqual(["", "runId=run-1"]);
  });

  test("limit, workflow, and unsafe filters use the RPC-backed collection with the filter forwarded", async () => {
    const { fetchImpl, calls } = routingFetch();
    const { collections, shapes } = await recordingCollections(fetchImpl);

    const limited = collections.runs({ filter: { limit: 2 } });
    const byWorkflow = collections.runs({ filter: { workflow: "deploy" } });
    const unsafeStatus = collections.runs({ filter: { status: "fin'ished" } });
    const limitedApprovals = collections.approvals({ filter: { limit: 1 } });
    const workflowApprovals = collections.approvals({ filter: { workflow: "deploy" } });
    // None of these may create an Electric shape — Electric cannot enforce them.
    expect(shapes).toEqual([]);

    await limited.preload();
    await byWorkflow.preload();
    await unsafeStatus.preload();
    await limitedApprovals.preload();
    await workflowApprovals.preload();

    // Every filter reaches the RPC, which enforces it server-side.
    const runCalls = calls.filter((call) => call.path === "/v1/api/runs");
    expect(runCalls.map((call) => call.search.toString())).toEqual([
      "limit=2",
      "workflow=deploy",
      "status=fin%27ished",
    ]);
    const approvalCalls = calls.filter((call) => call.path === "/v1/api/approvals");
    expect(approvalCalls.map((call) => call.search.toString())).toEqual(["limit=1", "workflow=deploy"]);

    // The RPC rows are the collection rows — identical to local mode, which
    // uses the same endpoint for these params.
    expect(limited.toArray.map((row) => row.runId)).toEqual(["run-1", "run-2"]);
    expect(limitedApprovals.toArray.map((row) => `${row.runId}:${row.nodeId}`)).toEqual(["run-1:gate"]);
  });

  test("local mode returns the same rows for a filter multiplayer cannot push down", async () => {
    const { fetchImpl, calls } = routingFetch();
    const queryClient = new QueryClient();
    const client = createSmithersDataClient({ mode: { kind: "local", apiBaseUrl: "http://gateway.test/" }, fetch: fetchImpl });
    // The client is local-mode, so the client overload's union collapses to the
    // synchronous SmithersCollections.
    const collections = createSmithersCollections(client, queryClient) as SmithersCollections;
    cleanups.push(() => {
      collections.close();
      client.close();
      queryClient.clear();
    });

    const limited = collections.runs({ filter: { limit: 2 } });
    await limited.preload();
    expect(limited.toArray.map((row) => row.runId)).toEqual(["run-1", "run-2"]);
    expect(calls.filter((call) => call.path === "/v1/api/runs").map((call) => call.search.toString())).toEqual(["limit=2"]);
  });
});
