import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import { GatewayRpcError } from "../../src/GatewayRpcError.ts";
import { isGatewayUnavailableError } from "../../src/isGatewayUnavailableError.ts";
import { createSmithersCollections } from "../../src/data/createSmithersCollections.ts";
import { createSmithersDataClient } from "../../src/data/createSmithersDataClient.ts";
import { resetGatewayUnavailableNotice } from "../../src/data/gatewayUnavailableNotice.ts";

/**
 * A UI booted without a gateway gets its `/v1/api/*` requests answered by the
 * host app's SPA fallback: HTTP 200 with `index.html`. That is not an error a
 * user can act on, so the client classifies it as GATEWAY_UNAVAILABLE and the
 * QueryCollection layer degrades to empty rows instead of rejecting, which
 * kept `@tanstack/query-db-collection` spamming
 * `[QueryCollection] Error observing query ...` on every collection at boot
 * (observed in the Smithers Code app with no gateway wired).
 */

const HTML_FALLBACK = "<!doctype html><html><head><title>App</title></head><body></body></html>";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function htmlFallbackFetch(status = 200) {
  return (async () =>
    new Response(HTML_FALLBACK, {
      status,
      headers: { "content-type": "text/html; charset=utf-8" },
    })) as unknown as typeof fetch;
}

function clientWith(fetchImpl: typeof fetch) {
  const client = createSmithersDataClient({
    mode: { kind: "local", apiBaseUrl: "http://gateway.test/" },
    fetch: fetchImpl,
  });
  cleanups.push(() => client.close());
  return client;
}

describe("HTML-fallback responses classify as GATEWAY_UNAVAILABLE", () => {
  test("a 2xx non-envelope response rejects with GATEWAY_UNAVAILABLE", async () => {
    const client = clientWith(htmlFallbackFetch());
    const error = await client.api.listRuns().then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(GatewayRpcError);
    expect((error as GatewayRpcError).code).toBe("GATEWAY_UNAVAILABLE");
    expect(isGatewayUnavailableError(error)).toBe(true);
  });

  test("a 2xx JSON body that is not an envelope also classifies unavailable", async () => {
    const client = clientWith(
      (async () =>
        new Response(JSON.stringify({ hello: "world" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    );
    const error = await client.api.listWorkflows().then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(isGatewayUnavailableError(error)).toBe(true);
  });

  test("a fetch-level rejection (dead endpoint, nothing listening) classifies unavailable", async () => {
    const client = clientWith((async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch);
    const error = await client.api.listRuns().then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(GatewayRpcError);
    expect((error as GatewayRpcError).code).toBe("GATEWAY_UNAVAILABLE");
    expect((error as GatewayRpcError).message).toContain("fetch failed");
    expect(isGatewayUnavailableError(error)).toBe(true);
  });

  test("non-2xx responses keep their HTTP error classification", async () => {
    const client = clientWith(htmlFallbackFetch(502));
    const error = await client.api.listRuns().then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(GatewayRpcError);
    expect((error as GatewayRpcError).code).toBe("HTTP_ERROR");
    expect((error as GatewayRpcError).status).toBe(502);
    expect(isGatewayUnavailableError(error)).toBe(false);
  });

  test("a real gateway error envelope is not misclassified", async () => {
    const client = clientWith(
      (async () =>
        new Response(JSON.stringify({ ok: false, error: { code: "RUN_NOT_FOUND", message: "no such run" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    );
    const error = await client.api.getRun({ runId: "r1" }).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect((error as GatewayRpcError).code).toBe("RUN_NOT_FOUND");
    expect(isGatewayUnavailableError(error)).toBe(false);
  });
});

describe("collections degrade quietly when no gateway answers", () => {
  test("preload settles empty with zero console.error noise", async () => {
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    cleanups.push(() => {
      console.error = original;
    });

    const queryClient = new QueryClient();
    const client = createSmithersDataClient({
      mode: { kind: "local", apiBaseUrl: "http://gateway.test/" },
      fetch: htmlFallbackFetch(),
    });
    const collections = createSmithersCollections(client, queryClient);
    cleanups.push(() => {
      collections.close();
      client.close();
      queryClient.clear();
    });

    const runs = collections.runs();
    await runs.preload();
    expect(runs.size).toBe(0);

    const workflows = collections.workflows();
    await workflows.preload();
    expect(workflows.size).toBe(0);

    const approvals = collections.approvals();
    await approvals.preload();
    expect(approvals.size).toBe(0);

    expect(errors).toEqual([]);
  });

  test("real gateway errors still surface loudly through collections", async () => {
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    cleanups.push(() => {
      console.error = original;
    });

    const queryClient = new QueryClient();
    const client = createSmithersDataClient({
      mode: { kind: "local", apiBaseUrl: "http://gateway.test/" },
      fetch: (async () =>
        new Response(JSON.stringify({ ok: false, error: { code: "INTERNAL", message: "boom" } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });
    const collections = createSmithersCollections(client, queryClient);
    cleanups.push(() => {
      collections.close();
      client.close();
      queryClient.clear();
    });

    const runs = collections.runs();
    await runs.preload();
    expect(errors.length).toBeGreaterThan(0);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 3_000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function captureConsole(level: "info" | "error") {
  const lines: unknown[][] = [];
  const original = console[level];
  console[level] = (...args: unknown[]) => {
    lines.push(args);
  };
  cleanups.push(() => {
    console[level] = original;
  });
  return lines;
}

function makeCollections(fetchImpl: typeof fetch) {
  const queryClient = new QueryClient();
  const client = createSmithersDataClient({
    mode: { kind: "local", apiBaseUrl: "http://gateway.test/" },
    fetch: fetchImpl,
  });
  const collections = createSmithersCollections(client, queryClient);
  cleanups.push(() => {
    collections.close();
    client.close();
    queryClient.clear();
  });
  return collections;
}

describe("unavailable-gateway notice and recovery", () => {
  test("logs exactly one info notice per session across collections and retries", async () => {
    resetGatewayUnavailableNotice();
    const infos = captureConsole("info");
    const errors = captureConsole("error");
    let requests = 0;
    const collections = makeCollections((async () => {
      requests += 1;
      return new Response(HTML_FALLBACK, { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch);

    // Four collections fail on boot, then invalidation retries every live one:
    // the notice must not repeat per query or per retry.
    await collections.crons().preload();
    await collections.approvals().preload();
    await collections.memoryFacts().preload();
    await collections.prompts().preload();
    const afterBoot = requests;
    await collections.invalidate();
    await waitFor(() => requests > afterBoot);
    await waitFor(() => infos.length > 0);

    expect(infos.length).toBe(1);
    expect(String(infos[0]![0])).toContain("[smithers-gateway]");
    expect(errors).toEqual([]);
  });

  test("collections recover when a gateway appears and keep last rows through a later outage", async () => {
    resetGatewayUnavailableNotice();
    captureConsole("info");
    const errors = captureConsole("error");
    let gatewayUp = false;
    const collections = makeCollections((async (input: string | URL | Request) => {
      if (!gatewayUp) {
        return new Response(HTML_FALLBACK, { status: 200, headers: { "content-type": "text/html" } });
      }
      const url = new URL(String(input));
      if (url.pathname === "/v1/api/stream") {
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(
        JSON.stringify({
          ok: true,
          data: [{ cronId: "cron-1", workflow: "value", pattern: "* * * * *", enabled: true }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch);

    // Booted without a gateway: quiet and empty.
    const crons = collections.crons();
    await crons.preload();
    expect(crons.size).toBe(0);

    // A gateway appears; the next refetch (in production driven by the stream
    // reset on reconnect) delivers real rows.
    gatewayUp = true;
    await collections.invalidate();
    await waitFor(() => crons.size === 1);
    expect(crons.get("cron-1")?.enabled).toBe(true);

    // The gateway dies again: observers keep the last known rows instead of
    // blanking, still without console noise.
    gatewayUp = false;
    await collections.invalidate();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(crons.size).toBe(1);
    expect(errors).toEqual([]);
  });

  test("a dead endpoint (fetch itself rejects) degrades collections just as quietly", async () => {
    resetGatewayUnavailableNotice();
    const infos = captureConsole("info");
    const errors = captureConsole("error");
    const collections = makeCollections((async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch);

    const runs = collections.runs();
    await runs.preload();
    expect(runs.size).toBe(0);

    const workflows = collections.workflows();
    await workflows.preload();
    expect(workflows.size).toBe(0);

    await waitFor(() => infos.length > 0);
    expect(infos.length).toBe(1);
    expect(errors).toEqual([]);
  });
});

describe("change stream against an HTML fallback", () => {
  test("parks offline without ever reporting online or emitting a reset", async () => {
    const client = clientWith(htmlFallbackFetch());
    const statuses: string[] = [];
    const unsubscribeStatus = client.stream.subscribeStatus(() => {
      statuses.push(client.stream.status().status);
    });
    const events: unknown[] = [];
    const unsubscribe = client.stream.subscribe((event) => events.push(event));
    cleanups.push(() => {
      unsubscribe();
      unsubscribeStatus();
    });

    await waitFor(() => client.stream.status().status === "offline");
    // A 200+HTML answer must never count as a live gateway: no online flap,
    // no reset (each bogus reset would refetch every collection).
    expect(statuses).not.toContain("online");
    expect(events).toEqual([]);
  });
});
