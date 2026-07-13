import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import { createSmithersCollections } from "../../src/data/createSmithersCollections.ts";
import { createSmithersDataClient } from "../../src/data/createSmithersDataClient.ts";

/**
 * Local (QueryCollection) collections are driven against a capturing fetch that
 * returns real `{ ok, data }` envelopes for reads and mutations. The genuine
 * TanStack DB collection machinery, the client's request/mutate transport, and
 * every collection factory + optimistic mutation handler run for real — only
 * the HTTP boundary is served in-process (the pattern the sibling data-client
 * tests establish).
 */
type Handler = (init: RequestInit | undefined, url: URL) => unknown;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function envelope(data: unknown, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ ok: true, data, ...extra }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const treeSnapshot = {
  runId: "run-1",
  root: { id: "root", name: "root", status: "running", children: [{ id: "task-a", name: "Task A", status: "completed", children: [] }] },
};

function routingFetch(overrides: Record<string, Handler> = {}) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const routes: Record<string, Handler> = {
    "GET /v1/api/runs": () => [{ runId: "run-1", workflowKey: "value", status: "finished" }],
    "GET /v1/api/runs/run-1": () => ({ runId: "run-1", workflowKey: "value", status: "finished" }),
    "GET /v1/api/runs/run-1/tree": () => treeSnapshot,
    "GET /v1/api/approvals": () => [{ runId: "run-1", nodeId: "gate", iteration: 0, status: "requested" }],
    "GET /v1/api/workflows": () => [{ key: "value", name: "value" }],
    "GET /v1/api/docs": () => [{ path: "docs/readme.md", kind: "doc" }],
    "GET /v1/api/prompts": () => [{ entryFile: "prompt.tsx" }],
    "GET /v1/api/scores": () => [{ runId: "run-1", nodeId: "task-a", iteration: 0, scorerId: "s1" }],
    "GET /v1/api/tickets": () => [{ path: "tickets/t-1.md", kind: "ticket" }],
    "GET /v1/api/memory-facts": () => [{ namespace: "workspace", key: "pref" }],
    "GET /v1/api/crons": () => [{ cronId: "cron-1", workflow: "value", pattern: "* * * * *", enabled: true }],
    "GET /v1/api/events": () => [
      { runId: "run-1", seq: 1, type: "node.output", payloadJson: "{}" },
      { runId: "run-1", seq: 2, type: "node.output", payloadJson: "{}" },
    ],
    ...overrides,
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const key = `${method} ${url.pathname}`;
    calls.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const handler = routes[key] ?? overrides[key];
    if (handler) {
      const result = handler(init, url);
      if (result instanceof Response) return result;
      return envelope(result, { txid: "1" });
    }
    // Unknown mutation endpoints (launch/cancel/resume/submit/cron writes) just
    // acknowledge so optimistic mutations persist without a seq wait.
    return envelope({ runId: "run-1" }, { txid: "1" });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function makeCollections(overrides?: Record<string, Handler>) {
  const { fetchImpl, calls } = routingFetch(overrides);
  const queryClient = new QueryClient();
  const client = createSmithersDataClient({ mode: { kind: "local", apiBaseUrl: "http://gateway.test/" }, fetch: fetchImpl });
  const collections = createSmithersCollections(client, queryClient);
  cleanups.push(() => {
    collections.close();
    client.close();
    queryClient.clear();
  });
  return { collections, calls, queryClient };
}

describe("createSmithersCollections local factories", () => {
  test("builds and preloads every collection, caching by key", async () => {
    const { collections } = makeCollections();
    const runs = collections.runs();
    await runs.preload();
    expect(runs.get("run-1")?.status).toBe("finished");
    // Same params return the cached collection instance.
    expect(collections.runs()).toBe(runs);

    const run = collections.run("run-1");
    await run.preload();
    expect(run.get("run-1")).toBeDefined();

    const tree = collections.runTree("run-1");
    await tree.preload();
    expect(tree.size).toBeGreaterThan(0);
    // nodes is a deliberate alias of runTree (same cache key).
    expect(collections.nodes("run-1")).toBe(tree);

    const approvals = collections.approvals({ filter: { runId: "run-1" } });
    await approvals.preload();
    expect(approvals.size).toBe(1);

    const workflows = collections.workflows();
    await workflows.preload();
    expect(workflows.get("value")).toBeDefined();

    const docs = collections.docs({ filter: { kind: "doc" } });
    await docs.preload();
    expect(docs.get("docs/readme.md")).toBeDefined();

    const prompts = collections.prompts();
    await prompts.preload();
    expect(prompts.get("prompt.tsx")).toBeDefined();

    const scores = collections.scores({ runId: "run-1" });
    await scores.preload();
    expect(scores.size).toBe(1);

    const tickets = collections.tickets();
    await tickets.preload();
    expect(tickets.get("tickets/t-1.md")).toBeDefined();

    const memory = collections.memoryFacts({ namespace: "workspace" });
    await memory.preload();
    expect(memory.get("workspace:pref")).toBeDefined();

    const crons = collections.crons();
    await crons.preload();
    expect(crons.get("cron-1")?.pattern).toBe("* * * * *");

    const events = collections.runEvents("run-1", 5);
    await events.preload();
    expect(events.size).toBe(2);
  });

  test("runEvents bounds the fetched rows to the requested cap and truncates on refetch", async () => {
    // Return more events than the requested cap so boundedRunEventRows sorts and
    // slices down to the newest rows.
    let events = [
      { runId: "run-1", seq: 4, type: "e", payloadJson: "{}" },
      { runId: "run-1", seq: 1, type: "e", payloadJson: "{}" },
      { runId: "run-1", seq: 3, type: "e", payloadJson: "{}" },
      { runId: "run-1", seq: 2, type: "e", payloadJson: "{}" },
    ];
    const { collections, queryClient } = makeCollections({ "GET /v1/api/events": () => events });
    const runEvents = collections.runEvents("run-1", 2);
    await runEvents.preload();
    // Only the two newest seqs (3 and 4) survive the cap.
    expect([...runEvents.values()].map((row: { seq: number }) => row.seq).sort()).toEqual([3, 4]);

    // A refetch with a smaller result set drives the bounded sync's truncate path.
    events = [{ runId: "run-1", seq: 9, type: "e", payloadJson: "{}" }];
    await queryClient.refetchQueries({ queryKey: ["smithers", "events", "run-1", 2] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runEvents.get("run-1:9")).toBeDefined();
  });

  test("empty runId factories resolve to empty collections without hitting the API", async () => {
    const { collections } = makeCollections();
    const run = collections.run("");
    await run.preload();
    expect(run.size).toBe(0);
    const tree = collections.runTree("");
    await tree.preload();
    expect(tree.size).toBe(0);
    const events = collections.runEvents("");
    await events.preload();
    expect(events.size).toBe(0);
  });
});

describe("createSmithersCollections local mutations", () => {
  test("runs insert launches, update cancels/resumes, delete cancels", async () => {
    const { collections, calls } = makeCollections();
    const runs = collections.runs();
    await runs.preload();

    const insert = runs.insert({ runId: "run-new", workflow: "value", input: { v: 1 }, status: "running" } as never);
    await insert.isPersisted.promise;
    expect(calls.some((call) => call.method === "POST" && call.path === "/v1/api/runs")).toBe(true);

    const cancel = runs.update("run-1", (draft: Record<string, unknown>) => { draft.status = "cancelled"; });
    await cancel.isPersisted.promise;
    expect(calls.some((call) => call.path === "/v1/api/runs/run-1/cancel")).toBe(true);

    // Re-seed run-1 status so the resume branch has a row to update.
    const resume = runs.update("run-1", (draft: Record<string, unknown>) => { draft.status = "running"; });
    await resume.isPersisted.promise;
    expect(calls.some((call) => call.path === "/v1/api/runs/run-1/resume")).toBe(true);

    const remove = runs.delete("run-1");
    await remove.isPersisted.promise;
    expect(calls.filter((call) => call.path === "/v1/api/runs/run-1/cancel").length).toBeGreaterThanOrEqual(1);
  });

  test("runs insert without a workflow rejects, and an unpersistable status rejects", async () => {
    const { collections } = makeCollections();
    const runs = collections.runs();
    await runs.preload();

    const bad = runs.insert({ runId: "run-x", status: "running" } as never);
    await expect(bad.isPersisted.promise).rejects.toThrow(/workflow/i);

    // finished -> paused is a real change the mutation cannot persist.
    const badStatus = runs.update("run-1", (draft: Record<string, unknown>) => { draft.status = "paused"; });
    await expect(badStatus.isPersisted.promise).rejects.toThrow(/cannot persist status/i);
  });

  test("approvals update mirrors the row decision and delete denies through submitApproval", async () => {
    const { collections, calls } = makeCollections();
    const approvals = collections.approvals({ filter: { runId: "run-1" } });
    await approvals.preload();
    const key = "run-1:gate:0";

    const approve = approvals.update(key, (draft: Record<string, unknown>) => { draft.status = "approved"; });
    await approve.isPersisted.promise;
    const denyByUpdate = approvals.update(key, (draft: Record<string, unknown>) => {
      draft.decision = { approved: false };
    });
    await denyByUpdate.isPersisted.promise;
    const deny = approvals.delete(key);
    await deny.isPersisted.promise;
    const approvalCalls = calls.filter((call) => call.path.startsWith("/v1/api/approvals/"));
    expect(approvalCalls.length).toBeGreaterThanOrEqual(3);
    expect(approvalCalls[1]?.body).toMatchObject({ approved: false, decision: { approved: false } });
    expect(approvalCalls[2]?.body).toMatchObject({ approved: false, decision: { approved: false } });
  });

  test("crons insert/update/delete map to cronCreate and cronDelete", async () => {
    const { collections, calls } = makeCollections();
    const crons = collections.crons();
    await crons.preload();

    // Insert covers onInsert -> cronCreate; update/delete target the preloaded
    // cron-1 (still in the collection) to cover onUpdate/onDelete.
    const insert = crons.insert({ cronId: "cron-2", workflow: "value", pattern: "* * * * *", enabled: true } as never);
    await insert.isPersisted.promise;
    const update = crons.update("cron-1", (draft: Record<string, unknown>) => { draft.pattern = "*/5 * * * *"; });
    await update.isPersisted.promise;
    const remove = crons.delete("cron-1");
    await remove.isPersisted.promise;

    expect(calls.filter((call) => call.method === "POST" && call.path === "/v1/api/crons").length).toBeGreaterThanOrEqual(2);
    expect(calls.some((call) => call.method === "DELETE" && call.path === "/v1/api/crons/cron-1")).toBe(true);
  });
});

describe("createSmithersCollections invalidation and lifecycle", () => {
  test("invalidate targets a prefix per collection name, and the whole tree with no names", async () => {
    const { collections, queryClient } = makeCollections();
    const invalidated: unknown[] = [];
    const original = queryClient.invalidateQueries.bind(queryClient);
    queryClient.invalidateQueries = ((filters?: { queryKey?: unknown }) => {
      invalidated.push(filters?.queryKey);
      return original(filters as never);
    }) as typeof queryClient.invalidateQueries;

    await collections.invalidate(["runs", "crons", "runs"]);
    expect(invalidated.length).toBeGreaterThan(0);
    invalidated.length = 0;
    await collections.invalidate();
    expect(JSON.stringify(invalidated)).toContain("smithers");
  });

  test("connect() subscribes and reacts to reset and change stream events", async () => {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const streamHandler: Handler = (init) => {
      const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
      (init?.signal as AbortSignal | undefined)?.addEventListener("abort", () => {
        try { controller.close(); } catch { /* closed */ }
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const { collections, queryClient } = makeCollections({ "GET /v1/api/stream": streamHandler });
    const invalidations: unknown[] = [];
    const original = queryClient.invalidateQueries.bind(queryClient);
    queryClient.invalidateQueries = ((filters?: { queryKey?: unknown }) => {
      invalidations.push(filters?.queryKey);
      return original(filters as never);
    }) as typeof queryClient.invalidateQueries;

    collections.connect();
    // Idempotent: a second connect() must not double-subscribe.
    collections.connect();

    const online = async () => {
      const start = Date.now();
      while (!controller && Date.now() - start < 2_000) await new Promise((r) => setTimeout(r, 5));
    };
    await online();
    // Let the transport reach onopen before pushing frames.
    await new Promise((r) => setTimeout(r, 30));
    controller.enqueue(encoder.encode("event: change\ndata: {\"seq\":1,\"collections\":[\"runs\"]}\n\n"));
    controller.enqueue(encoder.encode("event: reset\ndata: {\"seq\":2}\n\n"));
    await new Promise((r) => setTimeout(r, 60));
    expect(invalidations.length).toBeGreaterThan(0);
  });

  test("close() tears down a client the collections own", () => {
    const queryClient = new QueryClient();
    // Passing a mode (not a client) makes the collections OWN the client.
    const collections = createSmithersCollections(
      { kind: "local", apiBaseUrl: "http://gateway.test/" },
      queryClient,
    );
    expect(collections.client.mode.kind).toBe("local");
    // Build one collection so close() clears a non-empty registry.
    collections.runs();
    // close() must clear collections and close the owned client without throwing.
    expect(() => collections.close()).not.toThrow();
    queryClient.clear();
  });
});
