import { afterEach, describe, expect, test } from "bun:test";
import {
  createSmithersElectricProxy,
  serveSmithersElectricProxy,
  type SmithersElectricProxyServer,
} from "../src/index.ts";

describe("serveSmithersElectricProxy (runnable HTTP server)", () => {
  let running: SmithersElectricProxyServer | undefined;

  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  test("serves shape reads over real HTTP, stripping Authorization upstream", async () => {
    let upstreamAuth: string | null = "unset";
    let forwardedWhere = "";
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      authenticate: () => ({ principalId: "p", scopes: ["run:read"], grantedRunIds: ["run-1"] }),
      fetchClient: async (url, init) => {
        upstreamAuth = new Headers(init?.headers).get("authorization");
        forwardedWhere = new URL(String(url)).searchParams.get("where") ?? "";
        return new Response("event: up\ndata: {}\n\n", { headers: { "content-type": "text/event-stream" } });
      },
    });
    running = await serveSmithersElectricProxy({ proxy, host: "127.0.0.1" });

    const response = await fetch(`http://127.0.0.1:${running.port}/v1/shape?table=_smithers_runs`, {
      headers: { authorization: "Bearer secret" },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("event: up");
    expect(upstreamAuth).toBeNull();
    expect(forwardedWhere).toBe("run_id IN ('run-1')");
  });

  test("serves /healthz and /metrics", async () => {
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      authenticate: () => null,
    });
    running = await serveSmithersElectricProxy({ proxy, host: "127.0.0.1" });

    const health = await fetch(`http://127.0.0.1:${running.port}/healthz`);
    expect(health.status).toBe(200);
    expect((await health.json()).status).toBe("ok");

    const metrics = await fetch(`http://127.0.0.1:${running.port}/metrics`);
    expect(metrics.status).toBe(200);
    expect(await metrics.text()).toContain("smithers_electric_shape_opens_total");
  });
});
