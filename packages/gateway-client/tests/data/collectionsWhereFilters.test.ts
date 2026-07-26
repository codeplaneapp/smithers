import { afterEach, describe, expect, test } from "bun:test";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { createSmithersElectricProxy, type SmithersElectricAuthContext } from "@smithers-orchestrator/electric-proxy";
import { serializeCronRow, serializeScoreRow } from "@smithers-orchestrator/gateway/api";
import { QueryClient } from "@tanstack/react-query";
import { createSmithersPostgres } from "smithers-orchestrator";

import type { SmithersCollections } from "../../src/data/SmithersCollections.ts";
import type { SmithersDataClient } from "../../src/data/SmithersDataClient.ts";
import { createSmithersCollections, cronsWhere, scoresWhere } from "../../src/data/createSmithersCollections.ts";
import { createSmithersDataClient } from "../../src/data/createSmithersDataClient.ts";
import { mapSmithersElectricRow } from "../../src/data/mapSmithersElectricRow.ts";
import { smithersElectricCollectionOptions } from "../../src/data/smithersElectricCollectionOptions.ts";

// The injectable Electric-options loader is deliberately not part of the
// public createSmithersCollections overloads (see the source comment), so the
// implementation signature is reached through a cast.
const createCollectionsWithLoader = createSmithersCollections as unknown as (
  client: SmithersDataClient,
  queryClient: QueryClient,
  loadElectric: () => Promise<typeof smithersElectricCollectionOptions>,
) => Promise<SmithersCollections>;

/**
 * Multiplayer collections must honor the same filters the RPC-backed local
 * collections apply server-side: scores filter by runId AND the optional
 * nodeId, crons filter by workflow. These tests pin the compiled Electric
 * predicates, prove they flow into the Electric collection builder for
 * filtered and unfiltered requests, prove the real Electric proxy accepts
 * them as safe where clauses, and prove local and multiplayer results match
 * on a seeded multi-row PGlite dataset.
 */
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const multiplayerMode = {
  kind: "multiplayer" as const,
  apiBaseUrl: "http://127.0.0.1:65535/",
  electricBaseUrl: "http://127.0.0.1:65534",
  workspaceId: "workspace-where",
  token: "mp-token",
};

describe("scoresWhere / cronsWhere compilation", () => {
  test("scores compile runId and the optional nodeId into one predicate", () => {
    expect(scoresWhere({ runId: "run-1" })).toBe("run_id = 'run-1'");
    expect(scoresWhere({ runId: "run-1", nodeId: "task-a" })).toBe("run_id = 'run-1' AND node_id = 'task-a'");
    // No runId means no filter (matches the pre-existing shape behavior).
    expect(scoresWhere({ runId: "" })).toBeUndefined();
    // Empty nodeId is "no node filter", mirroring the server's truthy check.
    expect(scoresWhere({ runId: "run-1", nodeId: "" })).toBe("run_id = 'run-1'");
  });

  test("crons compile the workflow filter against both workflow_path storages", () => {
    expect(cronsWhere({})).toBeUndefined();
    expect(cronsWhere({ filter: {} })).toBeUndefined();
    expect(cronsWhere({ filter: { workflow: "value" } })).toBe("workflow_path IN ('gateway:value', 'value')");
    // A filter that itself starts with gateway: only matches the prefixed
    // storage — the bare path would serialize with its prefix stripped.
    expect(cronsWhere({ filter: { workflow: "gateway:value" } })).toBe("workflow_path = 'gateway:gateway:value'");
  });

  test("values the proxy grammar cannot express request the RPC fallback", () => {
    expect(scoresWhere({ runId: "run'1" })).toBeNull();
    expect(scoresWhere({ runId: "run-1", nodeId: "it's" })).toBeNull();
    expect(scoresWhere({ runId: "run-1", nodeId: "back\\slash" })).toBeNull();
    expect(cronsWhere({ filter: { workflow: "o'clock" } })).toBeNull();
    expect(cronsWhere({ filter: { workflow: "back\\slash" } })).toBeNull();
  });
});

describe("multiplayer collections wire the compiled filters into Electric shapes", () => {
  async function collectionsWithCapture() {
    const captured: Array<{ id: string; where?: string }> = [];
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: true, data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const queryClient = new QueryClient();
    const client = createSmithersDataClient({ mode: multiplayerMode, fetch: fetchImpl });
    // Wrap the REAL Electric option builder through the injectable loader seam
    // so the where each factory hands to Electric is observable.
    const loadElectric = async () => {
      await smithersElectricCollectionOptions.load();
      const capture = (config: { id: string; where?: string }) => {
        captured.push({ id: config.id, where: config.where });
        return smithersElectricCollectionOptions(config as never);
      };
      return Object.assign(capture, {
        load: smithersElectricCollectionOptions.load,
      }) as unknown as typeof smithersElectricCollectionOptions;
    };
    const collections = await createCollectionsWithLoader(client, queryClient, loadElectric);
    cleanups.push(() => {
      collections.close();
      client.close();
      queryClient.clear();
    });
    return { collections, captured };
  }

  test("scores pass runId and nodeId; crons pass the workflow filter", async () => {
    const { collections, captured } = await collectionsWithCapture();

    collections.scores({ runId: "run-1", nodeId: "task-a" });
    collections.scores({ runId: "run-1" });
    collections.crons({ filter: { workflow: "value" } });
    collections.crons();

    const wheres = captured.map((entry) => entry.where);
    expect(wheres).toEqual([
      "run_id = 'run-1' AND node_id = 'task-a'",
      "run_id = 'run-1'",
      "workflow_path IN ('gateway:value', 'value')",
      undefined,
    ]);
  });

  test("inexpressible filters fall back to RPC-backed collections", async () => {
    const { collections, captured } = await collectionsWithCapture();

    const scores = collections.scores({ runId: "run-1", nodeId: "it's" });
    const crons = collections.crons({ filter: { workflow: "o'clock" } });

    // Neither collection was built through the Electric builder…
    expect(captured).toHaveLength(0);
    // …both are query-backed (refetch is the query-collection util) so the
    // filter is applied server-side by the RPC instead of being dropped.
    expect("refetch" in (scores.utils as Record<string, unknown>)).toBe(true);
    expect("refetch" in (crons.utils as Record<string, unknown>)).toBe(true);
  });
});

describe("compiled predicates pass the real Electric proxy where validation", () => {
  function proxyWithCapture(auth: SmithersElectricAuthContext) {
    const forwarded: Array<string | null> = [];
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      authenticate: () => auth,
      fetchClient: (async (url: string | URL | Request) => {
        forwarded.push(new URL(String(url)).searchParams.get("where"));
        return new Response("[]");
      }) as unknown as typeof fetch,
    });
    return { proxy, forwarded };
  }

  test("scores predicate with runId and nodeId is authorized and forwarded intact", async () => {
    const { proxy, forwarded } = proxyWithCapture({
      principalId: "user-1",
      userId: "user-1",
      scopes: ["run:read"],
      grantedRunIds: ["run-1"],
    });
    const where = scoresWhere({ runId: "run-1", nodeId: "task-a" });
    expect(typeof where).toBe("string");
    const response = await proxy.fetch(
      new Request(
        `http://proxy.local/v1/shape?table=_smithers_scorers&shape=scores&where=${encodeURIComponent(String(where))}`,
      ),
    );
    expect(response.status).toBe(200);
    expect(forwarded).toEqual(["run_id = 'run-1' AND node_id = 'task-a'"]);
  });

  test("crons workflow predicate is accepted by the where grammar and forwarded intact", async () => {
    const { proxy, forwarded } = proxyWithCapture({
      principalId: "user-1",
      userId: "user-1",
      scopes: ["run:read"],
      unscoped: true,
    });
    const where = cronsWhere({ filter: { workflow: "value" } });
    expect(typeof where).toBe("string");
    const response = await proxy.fetch(
      new Request(
        `http://proxy.local/v1/shape?table=_smithers_cron&shape=crons&where=${encodeURIComponent(String(where))}`,
      ),
    );
    expect(response.status).toBe(200);
    expect(forwarded).toEqual(["workflow_path IN ('gateway:value', 'value')"]);
  });
});

describe("local and multiplayer results match on a seeded multi-row dataset", () => {
  test("scores honor runId + optional nodeId and crons honor workflow", async () => {
    const api = await createSmithersPostgres({}, { provider: "pglite" });
    cleanups.push(() => api.close());
    const adapter = new SmithersDb(api.db);
    const connection = (
      api.db as unknown as {
        connection: {
          query: (query: { text: string; values?: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }>;
        };
      }
    ).connection;
    const now = 1_718_000_000_000;

    const insertScore = (id: string, runId: string, nodeId: string, atMs: number) =>
      connection.query({
        text: `INSERT INTO _smithers_scorers
          (id, run_id, node_id, iteration, attempt, scorer_id, scorer_name, source, score, reason, scored_at_ms, latency_ms, duration_ms)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        values: [id, runId, nodeId, 0, 0, "score:exact", "Exact", "eval", 1, null, atMs, 12, 34],
      });
    await insertScore("score-a1", "run-a", "task-1", now + 1);
    await insertScore("score-a2", "run-a", "task-2", now + 2);
    await insertScore("score-b1", "run-b", "task-1", now + 3);

    const insertCron = (cronId: string, workflowPath: string, atMs: number) =>
      adapter.upsertCron({
        cronId,
        pattern: "*/5 * * * *",
        workflowPath,
        enabled: true,
        createdAtMs: atMs,
        lastRunAtMs: null,
        nextRunAtMs: atMs + 60_000,
        errorJson: null,
      });
    await insertCron("cron-1", "gateway:value", now + 10);
    await insertCron("cron-2", "gateway:other", now + 11);
    await insertCron("cron-3", "plain-path", now + 12);

    const electricRows = async (table: string, where: string | undefined) => {
      const result = await connection.query({
        text: `SELECT * FROM ${table}${where ? ` WHERE ${where}` : ""}`,
      });
      return result.rows;
    };
    const sortByKey = <T>(rows: T[], key: (row: T) => string) =>
      [...rows].sort((left, right) => key(left).localeCompare(key(right)));
    const scoreKey = (row: Record<string, unknown>) => `${row.runId}:${row.nodeId}:${row.scorerId}`;

    // Scores filtered by runId + nodeId: only run-a/task-1 comes back.
    const filteredLocal = (await adapter.listScorerResults("run-a", "task-1")).map((row) =>
      serializeScoreRow(row as Record<string, unknown>),
    );
    const filteredElectric = (
      await electricRows("_smithers_scorers", scoresWhere({ runId: "run-a", nodeId: "task-1" }) ?? undefined)
    ).map((row) => mapSmithersElectricRow("scores", row) as unknown as Record<string, unknown>);
    expect(filteredElectric).toHaveLength(1);
    expect(sortByKey(filteredElectric, scoreKey)).toEqual(sortByKey(filteredLocal, scoreKey));

    // Scores filtered by runId only: both run-a rows, never run-b's.
    const runLocal = (await adapter.listScorerResults("run-a")).map((row) =>
      serializeScoreRow(row as Record<string, unknown>),
    );
    const runElectric = (await electricRows("_smithers_scorers", scoresWhere({ runId: "run-a" }) ?? undefined)).map(
      (row) => mapSmithersElectricRow("scores", row) as unknown as Record<string, unknown>,
    );
    expect(runElectric).toHaveLength(2);
    expect(sortByKey(runElectric, scoreKey)).toEqual(sortByKey(runLocal, scoreKey));

    // Crons: local semantics are cron.list's post-serialization workflow match.
    const allLocalCrons = (await adapter.listCrons(false)).map((row) =>
      serializeCronRow(row as Record<string, unknown>),
    );
    const cronKey = (row: Record<string, unknown>) => String(row.cronId);
    for (const workflow of ["value", "plain-path"]) {
      const local = allLocalCrons.filter((row) => row.workflow === workflow);
      const electric = (await electricRows("_smithers_cron", cronsWhere({ filter: { workflow } }) ?? undefined)).map(
        (row) => mapSmithersElectricRow("crons", row) as unknown as Record<string, unknown>,
      );
      expect(electric).toHaveLength(1);
      expect(sortByKey(electric, cronKey)).toEqual(sortByKey(local, cronKey));
    }

    // Unfiltered crons: both surfaces return every row.
    const unfilteredElectric = (await electricRows("_smithers_cron", cronsWhere({}) ?? undefined)).map(
      (row) => mapSmithersElectricRow("crons", row) as unknown as Record<string, unknown>,
    );
    expect(sortByKey(unfilteredElectric, cronKey)).toEqual(sortByKey(allLocalCrons, cronKey));
  }, 120_000);
});
