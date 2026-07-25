// The provider builds two clients from `options` — the RPC client and the data
// client behind the collections — and used to abandon both. A rotated token or
// an unmounted tree left the old data client holding its SSE socket and, once
// a mutation waiter kept the stream alive, re-entering `openStream()` from a
// reconnect timer nobody could clear. These pin the ownership contract:
// provider-built clients are closed when replaced and on unmount, and a
// caller-supplied client is never touched.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

try { GlobalRegistrator.register(); } catch { /* already registered */ }

import { describe, expect, test } from "bun:test";
import { act, createElement, StrictMode, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  SmithersGatewayClient,
  type SmithersDataClient,
  type SmithersGatewayClientOptions,
} from "@smithers-orchestrator/gateway-client";
import { SmithersGatewayProvider, useSmithersCollections, useSmithersGateway } from "../src/index.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RECONNECT_WINDOW_MS = 600;

type Gateway = { rpc: SmithersGatewayClient; data: SmithersDataClient };

/**
 * Answers collection reads with an empty envelope and fails every change-stream
 * request, so the data client takes its reconnect path. Stream requests are
 * counted: a reconnect after unmount shows up as an extra one.
 */
function streamFailingFetch(streamUrls: string[]): typeof fetch {
  return (async (url: string | URL | Request) => {
    const target = String(url);
    if (target.includes("/v1/api/stream")) {
      streamUrls.push(target);
      return new Response("", { status: 503 });
    }
    return Response.json({ type: "res", id: "http", ok: true, payload: {}, data: [], seq: 0 });
  }) as unknown as typeof fetch;
}

async function mountHarness() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
  });
  let captured: Gateway | undefined;
  function Capture() {
    captured = { rpc: useSmithersGateway(), data: useSmithersCollections().client };
    return null;
  }
  const render = async (element: ReactElement) => {
    await act(async () => {
      root.render(element);
    });
    return captured!;
  };
  return {
    Capture,
    renderOptions: (options: SmithersGatewayClientOptions, strict = false) => {
      const provider = createElement(SmithersGatewayProvider, { options }, createElement(Capture));
      return render(strict ? createElement(StrictMode, null, provider) : provider);
    },
    renderClient: (client: SmithersGatewayClient) =>
      render(createElement(SmithersGatewayProvider, { client }, createElement(Capture))),
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/**
 * Resolves "closed" only if the data client settles the waiter — which is what
 * `SmithersDataClient.close()` does. An abandoned client leaves it pending
 * until its own 5s timeout, so the race reports "open" long before that.
 */
async function waiterOutcome(client: SmithersDataClient) {
  const waited = client.stream.waitForSeq(9_999).then(() => "closed" as const, () => "timeout" as const);
  const raced = await Promise.race([
    waited,
    new Promise<"open">((resolve) => { setTimeout(() => { resolve("open"); }, 250); }),
  ]);
  return raced;
}

function sleep(ms: number) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

describe("SmithersGatewayProvider client lifecycle", () => {
  test("closes the clients it owns when options rotate them", async () => {
    const harness = await mountHarness();
    const fetchImpl = streamFailingFetch([]);

    const first = await harness.renderOptions({ baseUrl: "http://gateway.test", token: "tok-1", fetch: fetchImpl });
    const firstClosed = waiterOutcome(first.data);

    const second = await harness.renderOptions({ baseUrl: "http://gateway.test", token: "tok-2", fetch: fetchImpl });
    expect(second.rpc).not.toBe(first.rpc);
    expect(second.data).not.toBe(first.data);

    expect(first.rpc.closed).toBe(true);
    expect(await firstClosed).toBe("closed");

    // The replacement is live, not collateral damage.
    expect(second.rpc.closed).toBe(false);
    await expect(second.rpc.rpcRaw("listRuns", {})).resolves.toBeDefined();

    await harness.unmount();
  });

  test("closes both owned clients on unmount and leaves no reconnect timer", async () => {
    const streamUrls: string[] = [];
    const harness = await mountHarness();
    const gateway = await harness.renderOptions({ baseUrl: "http://gateway.test", fetch: streamFailingFetch(streamUrls) });

    // A mutation awaiting its own change is the documented leak: the waiter
    // keeps the stream open, so the failing stream schedules a reconnect that
    // nothing but the data client's own close() can cancel.
    const pending = gateway.data.stream.waitForSeq(9_999).then(() => "closed" as const, () => "timeout" as const);
    await sleep(50);
    expect(streamUrls.length).toBeGreaterThan(0);
    const openedBeforeUnmount = streamUrls.length;

    await harness.unmount();

    expect(gateway.rpc.closed).toBe(true);
    expect(await pending).toBe("closed");
    await sleep(RECONNECT_WINDOW_MS);
    expect(streamUrls).toHaveLength(openedBeforeUnmount);
  });

  test("never closes a caller-supplied client, while still closing the owned data client", async () => {
    const streamUrls: string[] = [];
    const caller = new SmithersGatewayClient({ baseUrl: "http://gateway.test", fetch: streamFailingFetch(streamUrls) });
    const harness = await mountHarness();

    const first = await harness.renderClient(caller);
    expect(first.rpc).toBe(caller);

    // A re-render with the same caller client keeps everything in place.
    const second = await harness.renderClient(caller);
    expect(second.rpc).toBe(caller);
    expect(caller.closed).toBe(false);

    const dataClosed = waiterOutcome(second.data);
    await harness.unmount();

    expect(caller.closed).toBe(false);
    await expect(caller.rpcRaw("listRuns", {})).resolves.toBeDefined();
    expect(await dataClosed).toBe("closed");

    caller.close();
  });

  test("survives StrictMode's effect double-invoke", async () => {
    const harness = await mountHarness();
    const gateway = await harness.renderOptions(
      { baseUrl: "http://gateway.test", fetch: streamFailingFetch([]) },
      true,
    );

    // The remount-in-place pair (cleanup then setup on the same instance) must
    // not dispose a client the tree is still using.
    expect(gateway.rpc.closed).toBe(false);
    await expect(gateway.rpc.rpcRaw("listRuns", {})).resolves.toBeDefined();
    expect(await waiterOutcome(gateway.data)).toBe("open");

    await harness.unmount();
    expect(gateway.rpc.closed).toBe(true);
  });
});
