import { describe, expect, test } from "bun:test";

import { GatewayRpcError } from "../../src/GatewayRpcError.ts";
import { createSmithersDataClient } from "../../src/data/createSmithersDataClient.ts";

/**
 * Every `api.*` method is exercised against a capturing fetch that returns a
 * real `{ ok, data, seq?, txid? }` envelope `Response`. This drives the client's
 * genuine request/mutate builders, query-string assembly, and envelope parsing
 * — the same injected-fetch pattern the existing data-client tests establish.
 */
type Capture = { method: string; url: string; body: unknown; headers: Headers };

function capturingClient(envelope: Record<string, unknown> = { ok: true, data: [] }, token?: string) {
  const calls: Capture[] = [];
  const client = createSmithersDataClient({
    mode: { kind: "local", apiBaseUrl: "http://gateway.test/", token },
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? "GET",
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        headers: new Headers(init?.headers),
      });
      return new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch,
  });
  return { client, calls };
}

function urlOf(call: Capture) {
  return new URL(call.url);
}

describe("createSmithersDataClient api requests", () => {
  test("GET builders assemble the query string from filters", async () => {
    const { client, calls } = capturingClient({ ok: true, data: [] }, "tok");

    await client.api.listRuns({
      filter: { status: "finished", workflow: "deploy", parentRunId: "parent", limit: 5 },
    });
    await client.api.listWorkflows({ filter: { hasUi: true } });
    await client.api.listApprovals({ filter: { runId: "r1", workflow: "deploy", limit: 3 } });
    await client.api.listDocs({ filter: { kind: "doc", includeDeleted: true, updatedAfterMs: 100, limit: 2 } });
    await client.api.cronList({ filter: { workflow: "deploy" } });
    await client.api.listScores({ runId: "r1", nodeId: "n1" });
    await client.api.listTickets({ kind: "ticket" });
    await client.api.listMemoryFacts({ namespace: "workspace" });
    await client.api.getRun({ runId: "r 1" });
    await client.api.listRunTokenUsage({ runId: "r 1" });
    await client.api.listRunDescendants({ runId: "r 1", limit: 25 });
    await client.api.listUsageReports({ fresh: true });
    await client.api.getNodeOutput({ runId: "r1", nodeId: "n1" });
    await client.api.getNodeDiff({ runId: "r1", nodeId: "n1", iteration: 2 });
    await client.api.listPrompts();
    await client.api.getSchemaSignature();

    const byPath = (path: string) => calls.find((call) => urlOf(call).pathname === path)!;
    expect(urlOf(byPath("/v1/api/runs")).searchParams.get("status")).toBe("finished");
    expect(urlOf(byPath("/v1/api/runs")).searchParams.get("workflow")).toBe("deploy");
    expect(urlOf(byPath("/v1/api/runs")).searchParams.get("parentRunId")).toBe("parent");
    expect(urlOf(byPath("/v1/api/runs")).searchParams.get("limit")).toBe("5");
    expect(urlOf(byPath("/v1/api/workflows")).searchParams.get("hasUi")).toBe("true");
    expect(urlOf(byPath("/v1/api/approvals")).searchParams.get("runId")).toBe("r1");
    expect(urlOf(byPath("/v1/api/docs")).searchParams.get("kind")).toBe("doc");
    expect(urlOf(byPath("/v1/api/docs")).searchParams.get("includeDeleted")).toBe("true");
    expect(urlOf(byPath("/v1/api/crons")).searchParams.get("workflow")).toBe("deploy");
    expect(urlOf(byPath("/v1/api/scores")).searchParams.get("nodeId")).toBe("n1");
    expect(urlOf(byPath("/v1/api/tickets")).searchParams.get("kind")).toBe("ticket");
    expect(urlOf(byPath("/v1/api/memory-facts")).searchParams.get("namespace")).toBe("workspace");
    // runId is URL-encoded into the path.
    expect(calls.some((call) => urlOf(call).pathname === "/v1/api/runs/r%201")).toBe(true);
    expect(calls.some((call) => urlOf(call).pathname === "/v1/api/runs/r%201/token-usage")).toBe(true);
    const descendants = byPath("/v1/api/runs/r%201/descendants");
    expect(urlOf(descendants).searchParams.get("limit")).toBe("25");
    expect(urlOf(byPath("/v1/api/usage")).searchParams.get("fresh")).toBe("true");
    expect(calls.some((call) => urlOf(call).pathname === "/v1/api/nodes/r1/n1/output")).toBe(true);
    expect(urlOf(byPath("/v1/api/nodes/r1/n1/diff")).searchParams.get("iteration")).toBe("2");
    // The bearer token rides on the request headers.
    expect(byPath("/v1/api/prompts").headers.get("authorization")).toBe("Bearer tok");
    expect(calls.some((call) => urlOf(call).pathname === "/v1/api/schema-signature")).toBe(true);
    client.close();
  });

  test("listScores with no runId short-circuits to an empty array without a request", async () => {
    const { client, calls } = capturingClient();
    expect(await client.api.listScores()).toEqual([]);
    expect(calls).toHaveLength(0);
    client.close();
  });

  test("listScoresForRuns repeats runId values and encodes every filter, order, and page field with auth", async () => {
    const { client, calls } = capturingClient({ ok: true, data: { rows: [], total: 0 } }, "score-token");

    expect(
      await client.api.listScoresForRuns({
        runIds: ["run one", "run/two", "run-three"],
        nodeId: "node/one",
        scorerId: "score:exact",
        scorerName: "Exact match",
        source: "batch",
        order: "scoredAtDesc",
        offset: 0,
        limit: 25,
      }),
    ).toEqual({ rows: [], total: 0 });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    const url = urlOf(call);
    expect(call.method).toBe("GET");
    expect(url.pathname).toBe("/v1/api/scores/compare");
    expect(url.searchParams.getAll("runId")).toEqual(["run one", "run/two", "run-three"]);
    expect(url.searchParams.get("nodeId")).toBe("node/one");
    expect(url.searchParams.get("scorerId")).toBe("score:exact");
    expect(url.searchParams.get("scorerName")).toBe("Exact match");
    expect(url.searchParams.get("source")).toBe("batch");
    expect(url.searchParams.get("order")).toBe("scoredAtDesc");
    expect(url.searchParams.get("offset")).toBe("0");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(call.headers.get("authorization")).toBe("Bearer score-token");
    client.close();
  });

  test("listScoresForRuns with no runIds still authenticates and validates through the gateway", async () => {
    const { client, calls } = capturingClient({ ok: true, data: { rows: [], total: 0 } }, "score-token");
    expect(await client.api.listScoresForRuns({ runIds: [] })).toEqual({ rows: [], total: 0 });
    expect(calls).toHaveLength(1);
    expect(urlOf(calls[0]!).pathname).toBe("/v1/api/scores/compare");
    expect(urlOf(calls[0]!).searchParams.getAll("runId")).toEqual([]);
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer score-token");
    client.close();
  });

  test("listScoresForRuns leaves server defaults untouched when optional fields are omitted", async () => {
    const { client, calls } = capturingClient({ ok: true, data: { rows: [], total: 0 } });
    await client.api.listScoresForRuns({ runIds: ["run-1"] });
    const search = urlOf(calls[0]!).searchParams;
    expect(search.getAll("runId")).toEqual(["run-1"]);
    expect(search.has("order")).toBe(false);
    expect(search.has("offset")).toBe(false);
    expect(search.has("limit")).toBe(false);
    client.close();
  });

  test("getScoreDetail URL-encodes both persisted identities and returns decoded detail", async () => {
    const persisted = {
      scoreId: "score /?#",
      runId: "run /?#",
      nodeId: "node-1",
      iteration: 0,
      attempt: 1,
      scorerId: "exact",
      scorerName: "Exact",
      source: "eval",
      score: 1,
      reason: null,
      scoredAtMs: 123,
      latencyMs: null,
      durationMs: 10,
      meta: { model: "judge" },
      input: { prompt: "hello" },
      output: "hello",
      groundTruth: "hello",
      context: null,
    };
    const { client, calls } = capturingClient({ ok: true, data: persisted }, "detail-token");

    const detail = await client.api.getScoreDetail({ runId: "run /?#", scoreId: "score /?#" });
    expect(detail).toEqual(persisted);
    expect(detail.context).toBeNull();
    expect(calls).toHaveLength(1);
    expect(urlOf(calls[0]!).pathname).toBe("/v1/api/scores/run%20%2F%3F%23/score%20%2F%3F%23");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer detail-token");
    client.close();
  });

  test("listScores keeps its original per-run endpoint and array response", async () => {
    const { client, calls } = capturingClient({ ok: true, data: [] });
    expect(await client.api.listScores({ runId: "run-1", nodeId: "node-1" })).toEqual([]);
    expect(calls).toHaveLength(1);
    const url = urlOf(calls[0]!);
    expect(url.pathname).toBe("/v1/api/scores");
    expect(url.searchParams.get("runId")).toBe("run-1");
    expect(url.searchParams.get("nodeId")).toBe("node-1");
    client.close();
  });

  test("listRunEvents normalizes and filters raw event rows", async () => {
    const { client } = capturingClient({
      ok: true,
      data: [
        { run_id: "r1", seq: 2, type: "node.output", payloadJson: JSON.stringify({ v: 1 }) },
        { runId: "r1" }, // missing seq -> dropped by normalizeGatewayRunEventRow
        "garbage", // non-object -> dropped
      ],
    });
    const rows = await client.api.listRunEvents({ runId: "r1", afterSeq: 1, limit: 10 });
    expect(rows).toEqual([{ runId: "r1", seq: 2, event: "node.output", payload: { v: 1 } }]);
    client.close();
  });

  test("listRunEvents forwards nodeId with its history cursor", async () => {
    const { client, calls } = capturingClient({ ok: true, data: [] });
    await client.api.listRunEvents({
      runId: "run one",
      nodeId: "node:early",
      iteration: 3,
      attempt: 2,
      afterSeq: 41,
      limit: 25,
    });
    const url = urlOf(calls[0]!);
    expect(url.pathname).toBe("/v1/api/events");
    expect(url.searchParams.get("runId")).toBe("run one");
    expect(url.searchParams.get("nodeId")).toBe("node:early");
    expect(url.searchParams.get("iteration")).toBe("3");
    expect(url.searchParams.get("attempt")).toBe("2");
    expect(url.searchParams.get("afterSeq")).toBe("41");
    expect(url.searchParams.get("limit")).toBe("25");
    client.close();
  });

  test("getRunTree flattens a devtools snapshot into keyed run-node rows", async () => {
    const { client, calls } = capturingClient({
      ok: true,
      data: {
        runId: "r1",
        root: {
          id: "root",
          name: "root",
          status: "running",
          children: [{ id: "task-a", name: "Task A", status: "completed", children: [] }],
        },
      },
    });
    const rows = await client.api.getRunTree({ runId: "r1", frameNo: 3 });
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.every((row) => typeof row.key === "string")).toBe(true);
    expect(urlOf(calls[0]).searchParams.get("frameNo")).toBe("3");
    client.close();
  });

  test("mutation methods POST/PATCH/DELETE with bodies and return the envelope data plus txid", async () => {
    // No seq in the envelope here so mutate() does not block on waitForSeq; the
    // seq-await branch is covered in the stream test where a real SSE frame
    // delivers the matching seq.
    const { client, calls } = capturingClient({ ok: true, data: { runId: "r1" }, txid: "77" });

    const launched = await client.api.launchRun({
      workflow: "value",
      input: { v: 1 },
      options: { startedBy: { harness: "codex", sessionId: "thread-1", prompt: "explicit only" } },
    } as never);
    expect(launched).toMatchObject({ data: { runId: "r1" }, txid: "77" });

    await client.api.resumeRun({ runId: "r1" } as never);
    await client.api.cancelRun({ runId: "r1" } as never);
    await client.api.hijackRun({ runId: "r1" } as never);
    await client.api.rewindRun({ runId: "r1" } as never);
    await client.api.submitApproval({ runId: "r1", nodeId: "n1", iteration: 0, approved: true } as never);
    await client.api.submitApproval({ runId: "r1", nodeId: "n1", approvalId: "explicit-id", approved: true } as never);
    await client.api.submitSignal({ runId: "r1", signal: "go" } as never);
    await client.api.cronCreate({ cronId: "c1", workflow: "value", pattern: "* * * * *", enabled: true } as never);
    await client.api.cronDelete({ cronId: "c1" } as never);
    await client.api.cronRun({ cronId: "c1" } as never);
    await client.api.createTicket({ path: "tickets/t.md", content: "x" } as never);
    await client.api.updateTicket({ path: "tickets/t.md", content: "y" } as never);
    await client.api.deleteTicket({ path: "tickets/t.md" } as never);

    const find = (method: string, path: string) =>
      calls.find((call) => call.method === method && urlOf(call).pathname === path)!;
    expect(find("POST", "/v1/api/runs").body).toEqual({
      workflow: "value",
      input: { v: 1 },
      options: { startedBy: { harness: "codex", sessionId: "thread-1", prompt: "explicit only" } },
    });
    expect(find("POST", "/v1/api/runs/r1/resume")).toBeDefined();
    expect(find("POST", "/v1/api/runs/r1/cancel")).toBeDefined();
    expect(find("POST", "/v1/api/runs/r1/hijack")).toBeDefined();
    expect(find("POST", "/v1/api/runs/r1/rewind")).toBeDefined();
    // Default approvalId is derived from run/node/iteration (colons encoded).
    expect(find("POST", "/v1/api/approvals/r1%3An1%3A0")).toBeDefined();
    // An explicit approvalId overrides the derived one.
    expect(find("POST", "/v1/api/approvals/explicit-id")).toBeDefined();
    expect(find("POST", "/v1/api/signals")).toBeDefined();
    expect(find("POST", "/v1/api/crons")).toBeDefined();
    expect(find("DELETE", "/v1/api/crons/c1")).toBeDefined();
    expect(find("POST", "/v1/api/crons/run")).toBeDefined();
    expect(find("POST", "/v1/api/tickets")).toBeDefined();
    expect(find("PATCH", "/v1/api/tickets/tickets%2Ft.md")).toBeDefined();
    expect(find("DELETE", "/v1/api/tickets/tickets%2Ft.md")).toBeDefined();
    client.close();
  });
});

describe("createSmithersDataClient envelope errors", () => {
  test("throws GatewayRpcError with the gateway code/message when the envelope is not ok", async () => {
    const client = createSmithersDataClient({
      mode: { kind: "local", apiBaseUrl: "http://gateway.test/" },
      fetch: (async () =>
        new Response(
          JSON.stringify({ ok: false, error: { code: "RUN_NOT_FOUND", message: "no run", requiredScope: "run:read" } }),
          {
            status: 404,
            headers: { "content-type": "application/json" },
          },
        )) as unknown as typeof fetch,
    });
    await expect(client.api.getRun({ runId: "missing" })).rejects.toBeInstanceOf(GatewayRpcError);
    await client.api.getRun({ runId: "missing" }).catch((error: GatewayRpcError) => {
      expect(error.code).toBe("RUN_NOT_FOUND");
      expect(error.message).toContain("no run");
    });
    client.close();
  });

  test("falls back to an HTTP error code when the body is not JSON", async () => {
    const client = createSmithersDataClient({
      mode: { kind: "local", apiBaseUrl: "http://gateway.test/" },
      fetch: (async () => new Response("<html>oops</html>", { status: 500 })) as unknown as typeof fetch,
    });
    await client.api.listRuns().catch((error: GatewayRpcError) => {
      expect(error.code).toBe("HTTP_ERROR");
      expect(error.message).toContain("500");
    });
    client.close();
  });

  test("falls back to an unavailable-fetch stub when no fetch exists in the environment", async () => {
    const originalFetch = globalThis.fetch;
    // Remove the global fetch and provide none: the client must install the
    // unavailable-fetch stub that rejects on use.
    (globalThis as { fetch?: typeof fetch }).fetch = undefined;
    try {
      const client = createSmithersDataClient({ mode: { kind: "local", apiBaseUrl: "http://gateway.test/" } });
      await expect(client.api.listRuns()).rejects.toThrow(/fetch is not available/i);
      client.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a mutation whose seq never streams back resolves after the waitForSeq timeout drains", async () => {
    // The envelope carries a seq the stream never delivers, so mutate() awaits
    // waitForSeq, whose internal timeout fires and rejects — mutate swallows
    // that rejection and still returns the data. Exercises both the waiter
    // timeout path and mutate's defensive catch.
    const client = createSmithersDataClient({
      mode: { kind: "local", apiBaseUrl: "http://gateway.test/" },
      fetch: (async (url: string | URL | Request) => {
        if (String(url).includes("/v1/api/stream")) {
          // A never-ending, non-SSE body keeps a live transport without ever
          // advancing lastSeq, so the mutation's waiter can only time out.
          return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response(JSON.stringify({ ok: true, data: { runId: "r1" }, seq: 999 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });
    const result = await client.api.launchRun({ workflow: "value", input: {} } as never);
    expect(result).toMatchObject({ data: { runId: "r1" }, seq: 999 });
    client.close();
  }, 8_000);

  test("flips the stream status to unauthorized on a 401 envelope", async () => {
    const client = createSmithersDataClient({
      mode: { kind: "local", apiBaseUrl: "http://gateway.test/" },
      fetch: (async () =>
        new Response(JSON.stringify({ ok: false, error: { code: "UNAUTHORIZED", message: "nope" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });
    await client.api.listRuns().catch(() => undefined);
    expect(client.stream.status().status).toBe("unauthorized");
    client.close();
  });
});
