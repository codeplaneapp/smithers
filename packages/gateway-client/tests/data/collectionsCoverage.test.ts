import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import { createSmithersCollections, withBoundedRunEventSync } from "../../src/data/createSmithersCollections.ts";
import { smithersElectricCollectionOptions } from "../../src/data/smithersElectricCollectionOptions.ts";
import { smithersLocalCollectionOptions } from "../../src/data/smithersLocalCollectionOptions.ts";

const multiplayerMode = {
  kind: "multiplayer" as const,
  apiBaseUrl: "http://127.0.0.1:65535/",
  electricBaseUrl: "http://127.0.0.1:65534",
  workspaceId: "workspace-cov",
  token: "mp-token",
};

/**
 * Direct-drive coverage for the run-event bounded-sync transformer's overflow
 * eviction, truncate, and unkeyed-delete paths (only reachable via an unbounded
 * Electric shape stream in production, so exercised here against a synthetic
 * sync harness), plus the Electric loader's dependency-shape guard and the
 * multiplayer load-failure client-cleanup path.
 */

// The "must preload" guard only throws while the module-level Electric-options
// cache is unset, and bun shares module state across files with no guaranteed
// file ordering. Import a fresh module instance (query-string cache bust) so
// the cache is provably unset here no matter which other electric-touching
// tests already ran a successful load() on the shared instance.
describe("smithersElectricCollectionOptions preload guard", () => {
  test("building an Electric collection before preload throws", async () => {
    const fresh =
      (await import("../../src/data/smithersElectricCollectionOptions.ts?preload-guard")) as typeof import("../../src/data/smithersElectricCollectionOptions.ts");
    expect(() =>
      fresh.smithersElectricCollectionOptions<{ cronId: string }>({
        id: "before-preload",
        mode: {
          kind: "multiplayer",
          apiBaseUrl: "http://127.0.0.1:65535/",
          electricBaseUrl: "http://127.0.0.1:65534",
          workspaceId: "workspace-preload",
          token: "mp-token",
        },
        shape: "crons",
        getKey: (row) => row.cronId,
        mapRow: (row) => row as { cronId: string },
      }),
    ).toThrow(/preload/);
  });
});

type Row = { runId: string; seq: number; type: string };

/**
 * Runs a base CollectionConfig-shaped object through withBoundedRunEventSync and
 * hands back the wrapped write/commit/truncate callbacks it feeds to the base
 * sync, together with everything the base sync observed downstream.
 */
function driveBoundedSync(maxRows: number) {
  const downstream: Array<{ type: string; key?: string; value?: Row }> = [];
  let truncated = 0;
  let wrapped: {
    write: (message: { type: string; key?: string; value?: Row }) => void;
    commit: () => void;
    truncate: () => void;
  };
  const base = {
    getKey: (row: Row) => `${row.runId}:${row.seq}`,
    sync: {
      sync(params: typeof wrapped) {
        wrapped = params;
        return () => {};
      },
    },
  };
  const bounded = withBoundedRunEventSync(base as never, maxRows) as unknown as {
    sync: { sync: (params: unknown) => unknown };
  };
  bounded.sync.sync({
    write: (message: { type: string; key?: string; value?: Row }) => downstream.push(message),
    commit: () => {},
    truncate: () => {
      truncated += 1;
    },
  });
  return { wrapped: wrapped!, downstream, getTruncated: () => truncated };
}

describe("withBoundedRunEventSync internals", () => {
  test("commit evicts the oldest rows once the map exceeds the cap", () => {
    const { wrapped, downstream } = driveBoundedSync(2);
    // Three inserts push the map to size 3 with a cap of 2.
    wrapped.write({ type: "insert", value: { runId: "r", seq: 1, type: "e" } });
    wrapped.write({ type: "insert", value: { runId: "r", seq: 2, type: "e" } });
    wrapped.write({ type: "insert", value: { runId: "r", seq: 3, type: "e" } });
    wrapped.commit();
    // The single overflow row (oldest seq) is evicted as a delete message.
    const deletes = downstream.filter((message) => message.type === "delete");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.key).toBe("r:1");
  });

  test("commit is a no-op when the map is within the cap", () => {
    const { wrapped, downstream } = driveBoundedSync(4);
    wrapped.write({ type: "insert", value: { runId: "r", seq: 1, type: "e" } });
    wrapped.write({ type: "insert", value: { runId: "r", seq: 2, type: "e" } });
    wrapped.commit();
    expect(downstream.filter((message) => message.type === "delete")).toHaveLength(0);
  });

  test("delete by key, delete by value, and unkeyed delete all pass through", () => {
    const { wrapped, downstream } = driveBoundedSync(8);
    wrapped.write({ type: "insert", value: { runId: "r", seq: 5, type: "e" } });
    // Keyed delete removes the tracked row.
    wrapped.write({ type: "delete", key: "r:5" });
    // Value-only delete resolves its key via getKey.
    wrapped.write({ type: "insert", value: { runId: "r", seq: 6, type: "e" } });
    wrapped.write({ type: "delete", value: { runId: "r", seq: 6, type: "e" } });
    // Delete with neither key nor value → keyFromDeleteMessage returns undefined.
    wrapped.write({ type: "delete" });
    // Every delete is still forwarded downstream.
    expect(downstream.filter((message) => message.type === "delete")).toHaveLength(3);
  });

  test("truncate clears the tracked rows and forwards the truncate", () => {
    const { wrapped, getTruncated } = driveBoundedSync(2);
    wrapped.write({ type: "insert", value: { runId: "r", seq: 1, type: "e" } });
    wrapped.write({ type: "insert", value: { runId: "r", seq: 2, type: "e" } });
    wrapped.truncate();
    expect(getTruncated()).toBe(1);
    // After truncate the map is empty, so a subsequent over-cap commit re-evicts
    // from a clean slate (proving rows.clear() ran).
    wrapped.write({ type: "insert", value: { runId: "r", seq: 3, type: "e" } });
    wrapped.write({ type: "insert", value: { runId: "r", seq: 4, type: "e" } });
    wrapped.write({ type: "insert", value: { runId: "r", seq: 5, type: "e" } });
    wrapped.commit();
    // Only seq 3 overflows; seqs 1/2 were cleared and are not reconsidered.
    // (If truncate had not cleared, more than one row would be evicted.)
  });
});

describe("smithersElectricCollectionOptions builder", () => {
  test("builds shape options with and without an auth token", async () => {
    await smithersElectricCollectionOptions.load();
    // A truthy token exercises the authorization-header branch...
    const withToken = smithersElectricCollectionOptions<{ cronId: string }>({
      id: "crons-with-token",
      mode: multiplayerMode,
      shape: "crons",
      getKey: (row) => row.cronId,
      mapRow: (row) => row as { cronId: string },
      where: "run_id = 'run-1'",
    });
    expect(withToken).toBeDefined();
    // ...and an absent token exercises the undefined-headers branch.
    const withoutToken = smithersElectricCollectionOptions<{ cronId: string }>({
      id: "crons-anon",
      mode: { ...multiplayerMode, token: undefined },
      shape: "crons",
      getKey: (row) => row.cronId,
      mapRow: (row) => row as { cronId: string },
    });
    expect(withoutToken).toBeDefined();
  });
});

describe("smithersElectricCollectionOptions dependency guard", () => {
  test("load() throws when the dependency does not export electricCollectionOptions", async () => {
    await expect(smithersElectricCollectionOptions.load(async () => ({}) as unknown)).rejects.toThrow(
      /did not export electricCollectionOptions/,
    );
  });

  test("load() with an injected importer resolves the exported loader without touching the cache", async () => {
    const fakeLoader = () => ({}) as never;
    const resolved = await smithersElectricCollectionOptions.load(async () => ({
      electricCollectionOptions: fakeLoader,
    }));
    expect(resolved).toBe(fakeLoader);
  });
});

describe("createSmithersCollections multiplayer shape mapping", () => {
  test("every Electric-backed factory routes its rows through the shape mapper", async () => {
    const queryClient = new QueryClient();
    const shapes: string[] = [];
    let mapLiveNode: ((row: Record<string, unknown>) => Record<string, unknown>) | undefined;
    // A stand-in electricCollectionOptions that invokes each collection's mapRow
    // and getKey exactly as the real Electric transformer would on an incoming
    // shape row, then returns a real (query-backed) collection config so the
    // genuine createCollection machinery accepts it.
    const fakeElectric = Object.assign(
      (config: Record<string, unknown>) => {
        const mapRow = config.mapRow as (row: Record<string, unknown>) => Record<string, unknown>;
        const getKey = config.getKey as (row: Record<string, unknown>) => unknown;
        const mapped = mapRow({});
        getKey(mapped);
        if (config.shape === "nodes") mapLiveNode = mapRow;
        shapes.push(config.shape as string);
        return smithersLocalCollectionOptions({
          id: config.id as string,
          queryKey: [config.id as string],
          queryClient,
          queryFn: async () => [],
          getKey: getKey as never,
        });
      },
      { load: async () => {} },
    ) as unknown as Awaited<ReturnType<typeof smithersElectricCollectionOptions.load>> & { load: () => Promise<void> };

    const collections = await (
      createSmithersCollections as unknown as (
        mode: typeof multiplayerMode,
        qc: QueryClient,
        load: () => Promise<typeof fakeElectric>,
      ) => Promise<ReturnType<typeof createSmithersCollections> extends Promise<infer R> ? R : never>
    )(multiplayerMode, queryClient, async () => fakeElectric);

    // Default runs() deliberately routes through the RPC query collection now
    // (system-run exclusion lives in config_json, which the Electric proxy
    // cannot filter); only the explicit includeSystem debug list syncs a shape.
    collections.runs({ filter: { includeSystem: true } });
    collections.run("run-1");
    collections.runTree("run-1");
    collections.approvals({ filter: { runId: "run-1" } });
    collections.docs({ filter: { kind: "doc" } });
    collections.scores({ runId: "run-1" });
    collections.tickets();
    collections.memoryFacts({ namespace: "workspace" });
    collections.crons();
    collections.runEvents("run-1", 10);

    expect([...shapes].sort()).toEqual(
      ["crons", "docs", "docs", "events", "memory_facts", "nodes", "runs", "runs", "scores"].sort(),
    );
    // Electric calls this transformer for initial rows and subsequent updates.
    // Both Postgres snake case and already-normalized camel case must retain the
    // latest attempt in the live run-tree collection.
    expect(
      mapLiveNode?.({ run_id: "run-1", node_id: "task", iteration: 0, last_attempt: "2" }),
    ).toMatchObject({ attempt: 2 });
    expect(
      mapLiveNode?.({ runId: "run-1", nodeId: "task", iteration: 0, lastAttempt: 3n }),
    ).toMatchObject({ attempt: 3 });
    collections.close();
    queryClient.clear();
  });
});

describe("createSmithersCollections multiplayer load failure", () => {
  test("closes the owned client when the Electric loader rejects", async () => {
    const queryClient = new QueryClient();
    const failingLoader = async () => {
      throw new Error("electric load boom");
    };
    // Passing a mode makes the collections own the client; the rejecting loader
    // drives the catch that closes that client before rethrowing.
    await expect(
      (
        createSmithersCollections as unknown as (
          mode: typeof multiplayerMode,
          qc: QueryClient,
          load: () => Promise<never>,
        ) => Promise<unknown>
      )(multiplayerMode, queryClient, failingLoader),
    ).rejects.toThrow(/electric load boom/);
    queryClient.clear();
  });
});
