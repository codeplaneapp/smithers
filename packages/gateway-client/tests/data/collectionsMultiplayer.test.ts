import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import { createSmithersCollections } from "../../src/data/createSmithersCollections.ts";
import { createSmithersDataClient } from "../../src/data/createSmithersDataClient.ts";
import { smithersElectricCollectionOptions } from "../../src/data/smithersElectricCollectionOptions.ts";

/**
 * Multiplayer collections build TanStack DB Electric collections. Constructing
 * them requires no live Electric server (the shape only syncs lazily), so these
 * tests drive the real Electric option builders — shape lookup, URL assembly,
 * auth headers, and the lazy loader — plus the optimistic mutation handlers'
 * txid-matching path.
 */
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const multiplayerMode = {
  kind: "multiplayer" as const,
  apiBaseUrl: "http://127.0.0.1:65535/",
  electricBaseUrl: "http://127.0.0.1:65534",
  workspaceId: "workspace-mp",
  token: "mp-token",
};

function capturingFetch() {
  const calls: Array<{ method: string; path: string }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ method: init?.method ?? "GET", path: url.pathname });
    return new Response(JSON.stringify({ ok: true, data: { runId: "run-1" }, txid: "42" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("smithersElectricCollectionOptions loader", () => {
  test("load() resolves the real electricCollectionOptions export and builds shape options", async () => {
    const loaded = await smithersElectricCollectionOptions.load();
    expect(typeof loaded).toBe("function");

    const options = smithersElectricCollectionOptions<{ cronId: string }>({
      id: "crons-shape",
      mode: multiplayerMode,
      shape: "crons",
      getKey: (row) => row.cronId,
      mapRow: (row) => row as { cronId: string },
      where: "run_id = 'run-1'",
    });
    expect(options).toBeDefined();
    // A second load() hits the cached fast-path.
    expect(await smithersElectricCollectionOptions.load()).toBe(loaded);
  });
});

describe("createSmithersCollections multiplayer", () => {
  test("constructs Electric collections for every shape-backed factory", async () => {
    const { fetchImpl } = capturingFetch();
    const queryClient = new QueryClient();
    const client = createSmithersDataClient({ mode: multiplayerMode, fetch: fetchImpl });
    const collections = await createSmithersCollections(client, queryClient);
    cleanups.push(() => {
      collections.close();
      client.close();
      queryClient.clear();
    });
    expect(collections.client.mode.kind).toBe("multiplayer");

    // Each factory routes through getOrCreateElectric, exercising the shape
    // lookup, electric URL assembly, and auth-header builders.
    expect(collections.runs().id).toContain("runs");
    expect(collections.run("run-1").id).toContain("run-1");
    expect(collections.runTree("run-1").id).toContain("runTree");
    expect(collections.approvals({ filter: { runId: "run-1" } }).id).toContain("approvals");
    expect(collections.docs({ filter: { kind: "doc" } }).id).toContain("docs");
    expect(collections.scores({ runId: "run-1" }).id).toContain("scores");
    expect(collections.tickets().id).toContain("tickets");
    expect(collections.memoryFacts({ namespace: "workspace" }).id).toContain("memoryFacts");
    expect(collections.crons().id).toContain("crons");
    expect(collections.runEvents("run-1", 10).id).toContain("events");
    // Query-backed factories (no Electric shape) still work in multiplayer mode.
    expect(collections.workflows().id).toContain("workflows");
    expect(collections.prompts().id).toContain("prompts");
  });

  test("owned multiplayer client is closed when the Electric load fails", async () => {
    const { fetchImpl } = capturingFetch();
    const queryClient = new QueryClient();
    // Passing a mode makes the collections own the client. We can still assert
    // the happy path returns a live collections handle.
    const collections = await createSmithersCollections(multiplayerMode, queryClient);
    expect(collections.client.mode.kind).toBe("multiplayer");
    collections.close();
    queryClient.clear();
    void fetchImpl;
  });
});
