// A gateway client configured with custom headers (an API key, a reverse
// proxy's auth header) must authorize identically on all three transports the
// provider drives: RPC, the `/v1/api/*` collection API, and the SSE change
// stream. Only RPC honoured them before, so the API and stream requests reached
// the gateway unauthenticated.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

try { GlobalRegistrator.register(); } catch { /* already registered */ }

import { describe, expect, test } from "bun:test";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SmithersGatewayClient, type SmithersDataClient } from "@smithers-orchestrator/gateway-client";
import { SmithersGatewayProvider, useSmithersCollections } from "../src/index.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Capture = { url: string; headers: Headers };

async function waitFor(predicate: () => boolean, timeoutMs = 3_000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function capturingFetch(calls: Capture[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, headers: new Headers(init?.headers) });
    if (href.includes("/v1/rpc/")) {
      return Response.json({ type: "res", id: "http", ok: true, payload: { runs: [] } });
    }
    if (href.includes("/v1/api/stream")) {
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return Response.json({ ok: true, data: [] });
  }) as unknown as typeof fetch;
}

async function mountRoot(element: ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(element);
  });
  return async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  };
}

describe("SmithersGatewayProvider custom headers", () => {
  test("wires the client's headers into RPC, the collection API, and the change stream", async () => {
    const calls: Capture[] = [];
    const client = new SmithersGatewayClient({
      baseUrl: "http://gateway.test",
      token: "tok",
      headers: { "x-api-key": "key-1" },
      fetch: capturingFetch(calls),
    });

    let dataClient: SmithersDataClient | undefined;
    function Probe() {
      dataClient = useSmithersCollections().client;
      return null;
    }

    const unmount = await mountRoot(
      createElement(SmithersGatewayProvider, { client }, createElement(Probe)),
    );
    expect(dataClient).toBeDefined();

    await client.rpcRaw("listRuns", {});
    await dataClient!.api.listRuns();
    const unsubscribe = dataClient!.stream.subscribe(() => {});
    await waitFor(() => calls.some((call) => call.url.includes("/v1/api/stream")));

    const rpc = calls.find((call) => call.url.includes("/v1/rpc/listRuns"))!;
    const api = calls.find((call) => call.url.includes("/v1/api/runs"))!;
    const stream = calls.find((call) => call.url.includes("/v1/api/stream"))!;
    for (const call of [rpc, api, stream]) {
      expect(call.headers.get("x-api-key")).toBe("key-1");
      expect(call.headers.get("authorization")).toBe("Bearer tok");
    }

    unsubscribe();
    dataClient!.close();
    await unmount();
  });
});
