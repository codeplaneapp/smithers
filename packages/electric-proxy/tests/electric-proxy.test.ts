import { describe, expect, test } from "bun:test";
import {
  createSmithersElectricProxy,
  type SmithersElectricAuthContext,
  type SmithersElectricScopeDecision,
} from "../src/index.ts";

function auth(overrides: Partial<SmithersElectricAuthContext> = {}): SmithersElectricAuthContext {
  return {
    principalId: "user-1",
    userId: "user-1",
    scopes: ["run:read"],
    grantedRunIds: ["run-1", "run-2"],
    ...overrides,
  };
}

async function text(response: Response): Promise<string> {
  return await response.text();
}

describe("createSmithersElectricProxy", () => {
  test("authorizes a run-scoped shape and strips Authorization before forwarding", async () => {
    let upstreamAuth: string | null = "unset";
    let upstreamQuery = "";
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      authenticate: () => auth(),
      fetchClient: async (url, init) => {
        upstreamQuery = new URL(String(url)).searchParams.toString();
        upstreamAuth = new Headers(init?.headers).get("authorization");
        return new Response("event: up\ndata: {}\n\n", {
          headers: {
            "content-type": "text/event-stream",
            "electric-handle": "h1",
            "electric-offset": "1_0",
          },
        });
      },
    });

    const response = await proxy.fetch(
      new Request("http://proxy.local/v1/shape?table=_smithers_events&where=run_id+%3D+%27run-1%27", {
        headers: { authorization: "Bearer secret" },
      }),
    );

    expect(response.status).toBe(200);
    expect(await text(response)).toContain("event: up");
    expect(upstreamAuth).toBeNull();
    expect(new URLSearchParams(upstreamQuery).get("where")).toBe("run_id = 'run-1'");
    expect(proxy.metrics.snapshot().shapeOpens).toBe(1);
  });

  test("fills the shape where template from granted run ids", async () => {
    let forwardedWhere = "";
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      authenticate: () => auth({ grantedRunIds: ["run-a", "run-b"] }),
      fetchClient: async (url) => {
        forwardedWhere = new URL(String(url)).searchParams.get("where") ?? "";
        return new Response("[]");
      },
    });

    const response = await proxy.fetch(new Request("http://proxy.local/v1/shape?table=_smithers_runs"));

    expect(response.status).toBe(200);
    expect(forwardedWhere).toBe("run_id IN ('run-a','run-b')");
  });

  test("rejects missing run:read before forwarding and logs the scope decision", async () => {
    let upstreamHits = 0;
    const decisions: SmithersElectricScopeDecision[] = [];
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      authenticate: () => auth({ scopes: ["approval:submit"] }),
      log: (decision) => decisions.push(decision),
      fetchClient: async () => {
        upstreamHits += 1;
        return new Response("[]");
      },
    });

    const response = await proxy.fetch(new Request("http://proxy.local/v1/shape?table=_smithers_runs"));

    expect(response.status).toBe(403);
    expect(upstreamHits).toBe(0);
    expect(decisions[0]).toMatchObject({ allowed: false, reason: "missing required scope" });
  });

  test("rejects a where clause that broadens outside granted run ids", async () => {
    let upstreamHits = 0;
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      authenticate: () => auth({ grantedRunIds: ["run-1"] }),
      fetchClient: async () => {
        upstreamHits += 1;
        return new Response("[]");
      },
    });

    const response = await proxy.fetch(
      new Request("http://proxy.local/v1/shape?table=_smithers_events&where=run_id+IN+%28%27run-1%27%2C%27run-2%27%29"),
    );

    expect(response.status).toBe(400);
    expect(await text(response)).toContain("unauthorized value");
    expect(upstreamHits).toBe(0);
  });

  test("rejects unsafe OR where clauses before forwarding", async () => {
    let upstreamHits = 0;
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      authenticate: () => auth(),
      fetchClient: async () => {
        upstreamHits += 1;
        return new Response("[]");
      },
    });

    const response = await proxy.fetch(
      new Request("http://proxy.local/v1/shape?table=_smithers_events&where=run_id+%3D+%27run-1%27+OR+run_id+%3D+%27run-2%27"),
    );

    expect(response.status).toBe(400);
    expect(upstreamHits).toBe(0);
  });

  test("enforces open-rate and active shape backpressure before upstream", async () => {
    let upstreamHits = 0;
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      authenticate: () => auth(),
      rateLimits: { openPerMinute: 1, activeMax: 1 },
      fetchClient: async () => {
        upstreamHits += 1;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("event: up\ndata: {}\n\n"));
          },
        }));
      },
    });

    const first = await proxy.fetch(new Request("http://proxy.local/v1/shape?table=_smithers_runs"));
    expect(first.status).toBe(200);
    const activeRejected = await proxy.fetch(new Request("http://proxy.local/v1/shape?table=_smithers_runs"));
    expect(activeRejected.status).toBe(429);
    expect(upstreamHits).toBe(1);

    await first.body?.cancel();
    const rateRejected = await proxy.fetch(new Request("http://proxy.local/v1/shape?table=_smithers_runs"));
    expect(rateRejected.status).toBe(429);
    expect(upstreamHits).toBe(1);
  });

  test("bounds a single Electric frame at 4 MiB and records the large-frame metric", async () => {
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      authenticate: () => auth(),
      maxFrameBytes: 8,
      fetchClient: async () => new Response("data: 123456789\n\n"),
    });

    const response = await proxy.fetch(new Request("http://proxy.local/v1/shape?table=_smithers_runs"));
    await expect(response.text()).rejects.toThrow("Electric frame exceeded 8 bytes");
    expect(proxy.metrics.snapshot().largeFrames).toBe(1);
  });

  test("serves metrics and counts replay-gap responses", async () => {
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      authenticate: () => auth(),
      fetchClient: async () => new Response("gap", { status: 409, headers: { "x-electric-lag-ms": "42" } }),
    });

    const response = await proxy.fetch(new Request("http://proxy.local/v1/shape?table=_smithers_runs"));
    expect(response.status).toBe(409);
    await response.text();
    const metrics = await proxy.fetch(new Request("http://proxy.local/metrics"));
    const body = await metrics.text();
    expect(body).toContain("smithers_electric_replay_gaps_total 1");
    expect(body).toContain("smithers_electric_sync_lag_ms 42");
  });
});
