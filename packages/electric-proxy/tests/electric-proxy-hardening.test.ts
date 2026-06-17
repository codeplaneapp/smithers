import { describe, expect, test } from "bun:test";
import {
  createSmithersElectricProxy,
  emitSmithersElectricEvent,
  smithersElectricCatalogWithOutputTables,
  type SmithersElectricAuthContext,
  type SmithersElectricProxyEvent,
  type SmithersElectricProxySpan,
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

describe("proxy scoping fails closed", () => {
  test("a run:read principal with NO grants cannot supply an arbitrary run_id where", async () => {
    let upstreamHits = 0;
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      // Authenticated, run:read, but no grantedRunIds derived.
      authenticate: () => auth({ grantedRunIds: undefined }),
      fetchClient: async () => {
        upstreamHits += 1;
        return new Response("[]");
      },
    });

    const response = await proxy.fetch(
      new Request("http://proxy.local/v1/shape?table=_smithers_events&where=run_id+%3D+%27run-99%27"),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("scoping grants are required");
    expect(upstreamHits).toBe(0);
  });

  test("a run:read principal with NO grants and no where is rejected (cannot fill template)", async () => {
    let upstreamHits = 0;
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      authenticate: () => auth({ grantedRunIds: undefined }),
      fetchClient: async () => {
        upstreamHits += 1;
        return new Response("[]");
      },
    });

    const response = await proxy.fetch(new Request("http://proxy.local/v1/shape?table=_smithers_runs"));
    expect(response.status).toBe(400);
    expect(upstreamHits).toBe(0);
  });

  test("an explicitly unscoped single-tenant principal opens the full table", async () => {
    let forwardedWhere: string | null = "unset";
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      authenticate: () => auth({ grantedRunIds: undefined, unscoped: true }),
      fetchClient: async (url) => {
        forwardedWhere = new URL(String(url)).searchParams.get("where");
        return new Response("[]");
      },
    });

    const response = await proxy.fetch(new Request("http://proxy.local/v1/shape?table=_smithers_runs"));
    expect(response.status).toBe(200);
    expect(forwardedWhere).toBeNull();
  });
});

describe("output tables are an explicit allowlist, not a regex catch-all", () => {
  test("an arbitrary identifier-named table is NOT a shape by default", async () => {
    let upstreamHits = 0;
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      authenticate: () => auth(),
      fetchClient: async () => {
        upstreamHits += 1;
        return new Response("[]");
      },
    });

    const response = await proxy.fetch(new Request("http://proxy.local/v1/shape?table=secrets_table"));
    expect(response.status).toBe(404);
    expect(upstreamHits).toBe(0);
  });

  test("an allowlisted output table is reachable and run-scoped", async () => {
    let forwardedWhere = "";
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      authenticate: () => auth({ grantedRunIds: ["run-1"] }),
      outputTables: ["deploy_outputs"],
      fetchClient: async (url) => {
        forwardedWhere = new URL(String(url)).searchParams.get("where") ?? "";
        return new Response("[]");
      },
    });

    const response = await proxy.fetch(new Request("http://proxy.local/v1/shape?table=deploy_outputs"));
    expect(response.status).toBe(200);
    expect(forwardedWhere).toBe("run_id IN ('run-1')");
  });

  test("smithersElectricCatalogWithOutputTables drops invalid table names", () => {
    const catalog = smithersElectricCatalogWithOutputTables(["good_table", "bad-name", "good_table"]);
    const outputs = catalog.filter((shape) => shape.name.startsWith("output:"));
    expect(outputs.map((shape) => shape.table)).toEqual(["good_table"]);
  });
});

describe("active shape limiter reclaims abandoned slots after a TTL", () => {
  test("a slot whose body never drains is reclaimed so the principal is not self-DoSed", async () => {
    let clock = 0;
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      authenticate: () => auth(),
      rateLimits: { openPerMinute: 100, activeMax: 1 },
      activeTtlMs: 1_000,
      now: () => clock,
      fetchClient: async () =>
        new Response(
          // A body that is never read: the slot would leak without a TTL.
          new ReadableStream<Uint8Array>({ pull() {} }),
        ),
    });

    const first = await proxy.fetch(new Request("http://proxy.local/v1/shape?table=_smithers_runs"));
    expect(first.status).toBe(200);

    // Second open while the first slot is still held -> 429.
    const blocked = await proxy.fetch(new Request("http://proxy.local/v1/shape?table=_smithers_runs"));
    expect(blocked.status).toBe(429);

    // Advance past the TTL: the abandoned (never-drained) slot is reclaimed.
    clock = 5_000;
    const reclaimed = await proxy.fetch(new Request("http://proxy.local/v1/shape?table=_smithers_runs"));
    expect(reclaimed.status).toBe(200);
  });
});

describe("the Electric proxy emits structured events + OTLP spans", () => {
  test("an authorized shape open emits an open span; a scope rejection emits a rejected span", async () => {
    const events: SmithersElectricProxyEvent[] = [];
    const spans: SmithersElectricProxySpan[] = [];
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      authenticate: () => auth(),
      observer: {
        event: (event) => events.push(event),
        span: (span) => spans.push(span),
      },
      fetchClient: async () => new Response("event: up\ndata: {}\n\n", { headers: { "content-type": "text/event-stream" } }),
    });

    const ok = await proxy.fetch(new Request("http://proxy.local/v1/shape?table=_smithers_runs"));
    await ok.text();
    expect(events.some((event) => event.type === "electric.shape.open")).toBe(true);
    expect(spans.some((span) => span.name === "smithers.electric.shape.open")).toBe(true);
    // The drained body emits a forwarded span carrying the byte count.
    expect(spans.some((span) => span.name === "smithers.electric.shape.forwarded")).toBe(true);

    const forbidden = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      authenticate: () => auth({ scopes: ["approval:submit"] }),
      observer: { event: (event) => events.push(event), span: (span) => spans.push(span) },
      fetchClient: async () => new Response("[]"),
    });
    const denied = await forbidden.fetch(new Request("http://proxy.local/v1/shape?table=_smithers_runs"));
    expect(denied.status).toBe(403);
    expect(spans.some((span) => span.name === "smithers.electric.shape.rejected")).toBe(true);
  });

  test("emitSmithersElectricEvent also fans out to the global telemetry sink and never throws", () => {
    const spans: SmithersElectricProxySpan[] = [];
    const host = globalThis as { __smithersElectricTelemetry?: unknown };
    const previous = host.__smithersElectricTelemetry;
    host.__smithersElectricTelemetry = {
      span: (span: SmithersElectricProxySpan) => spans.push(span),
      event: () => {
        throw new Error("a throwing sink must not break the path");
      },
    };
    try {
      emitSmithersElectricEvent(undefined, { type: "electric.write.commit", principalId: "p", txid: 42 });
      expect(spans.some((span) => span.name === "smithers.electric.write.commit")).toBe(true);
    } finally {
      host.__smithersElectricTelemetry = previous;
    }
  });
});
