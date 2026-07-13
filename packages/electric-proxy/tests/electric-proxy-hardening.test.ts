import { describe, expect, test } from "bun:test";
import {
  createSmithersElectricProxy,
  emitSmithersElectricEvent,
  smithersElectricCatalogWithOutputTables,
  type SmithersElectricAuthContext,
  type SmithersElectricProxyEvent,
  type SmithersElectricProxySpan,
  type SmithersElectricShapeDefinition,
} from "../src/index.js";

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

describe("an unscopable shape (no row-level scoping) is fail-closed to scoped principals", () => {
  // Regression: the `docs` shape (table `_smithers_docs`) has no run_id column
  // and no whereTemplate, so the old empty-where guard (which keys off scoping
  // columns) was skipped and the whole table was forwarded UNFILTERED to any
  // run:read principal — every ticket/plan/spec/proposal readable by anyone
  // granted a single run.
  test("a run:read principal cannot read the docs shape (no where)", async () => {
    let upstreamHits = 0;
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      authenticate: () => auth(), // has grantedRunIds, but docs has no run_id to scope by
      fetchClient: async () => {
        upstreamHits += 1;
        return new Response("[]");
      },
    });

    const response = await proxy.fetch(new Request("http://proxy.local/v1/shape?table=_smithers_docs"));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("no row-level scoping");
    expect(upstreamHits).toBe(0);
  });

  test("a run:read principal cannot bypass it with a client-supplied where", async () => {
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
      new Request("http://proxy.local/v1/shape?table=_smithers_docs&where=kind+%3D+%27spec%27"),
    );
    expect(response.status).toBe(400);
    expect(upstreamHits).toBe(0);
  });

  test("an explicitly unscoped single-tenant principal may read the docs shape", async () => {
    let forwardedWhere: string | null = "unset";
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      authenticate: () => auth({ unscoped: true }),
      fetchClient: async (url) => {
        forwardedWhere = new URL(String(url)).searchParams.get("where");
        return new Response("[]");
      },
    });

    const response = await proxy.fetch(new Request("http://proxy.local/v1/shape?table=_smithers_docs"));
    expect(response.status).toBe(200);
    expect(forwardedWhere).toBeNull();
  });
});

describe("a template-only shape treats its whereTemplate as authoritative", () => {
  // Regression: a shape whose ONLY scoping mechanism is `whereTemplate` (no
  // runIdColumn/workspaceIdColumn/userPrivateColumn) counted as row-scoped, but
  // a client-supplied `where` replaced the template outright and none of the
  // ensureValuesAllowed checks applied — the template's scoping was silently
  // bypassed after nothing but syntactic parsing.
  const templateOnlyShape: SmithersElectricShapeDefinition = {
    name: "template-only",
    table: "_smithers_template_only",
    requiredScope: "run:read",
    whereTemplate: "run_id IN ({run_ids})",
    description: "template-only fixture",
  };

  test("a scoped principal cannot replace the template with a client where", async () => {
    let upstreamHits = 0;
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      catalog: [templateOnlyShape],
      authenticate: () => auth(),
      fetchClient: async () => {
        upstreamHits += 1;
        return new Response("[]");
      },
    });

    const response = await proxy.fetch(
      new Request("http://proxy.local/v1/shape?table=_smithers_template_only&where=run_id+%3D+%27run-99%27"),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("scoped only by its where template");
    expect(upstreamHits).toBe(0);
  });

  test("a scoped principal without a client where gets the filled template", async () => {
    let forwardedWhere = "";
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      catalog: [templateOnlyShape],
      authenticate: () => auth(),
      fetchClient: async (url) => {
        forwardedWhere = new URL(String(url)).searchParams.get("where") ?? "";
        return new Response("[]");
      },
    });

    const response = await proxy.fetch(new Request("http://proxy.local/v1/shape?table=_smithers_template_only"));
    expect(response.status).toBe(200);
    expect(forwardedWhere).toBe("run_id IN ('run-1','run-2')");
  });

  test("a scoped principal whose template cannot be filled is rejected, not given the whole table", async () => {
    let upstreamHits = 0;
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      catalog: [templateOnlyShape],
      authenticate: () => auth({ grantedRunIds: undefined }),
      fetchClient: async () => {
        upstreamHits += 1;
        return new Response("[]");
      },
    });

    const response = await proxy.fetch(new Request("http://proxy.local/v1/shape?table=_smithers_template_only"));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("cannot be filled");
    expect(upstreamHits).toBe(0);
  });

  test("an explicitly unscoped single-tenant principal may still supply its own where", async () => {
    let forwardedWhere = "";
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      catalog: [templateOnlyShape],
      authenticate: () => auth({ grantedRunIds: undefined, unscoped: true }),
      fetchClient: async (url) => {
        forwardedWhere = new URL(String(url)).searchParams.get("where") ?? "";
        return new Response("[]");
      },
    });

    const response = await proxy.fetch(
      new Request("http://proxy.local/v1/shape?table=_smithers_template_only&where=run_id+%3D+%27run-99%27"),
    );
    expect(response.status).toBe(200);
    expect(forwardedWhere).toBe("run_id = 'run-99'");
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

  test("reclaiming a TTL-expired slot cancels the upstream Electric stream so activeMax bounds real connections", async () => {
    let clock = 0;
    let upstreamOpened = 0;
    let upstreamCancelled = 0;
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      authenticate: () => auth(),
      rateLimits: { openPerMinute: 100, activeMax: 1 },
      activeTtlMs: 1_000,
      now: () => clock,
      fetchClient: async () => {
        upstreamOpened += 1;
        // Never produces a byte (so the slot never drains) and records when the
        // proxy tears the upstream stream down.
        return new Response(
          new ReadableStream<Uint8Array>({
            pull() {},
            cancel() {
              upstreamCancelled += 1;
            },
          }),
        );
      },
    });

    const first = await proxy.fetch(new Request("http://proxy.local/v1/shape?table=_smithers_runs"));
    expect(first.status).toBe(200);
    expect(upstreamOpened).toBe(1);
    expect(upstreamCancelled).toBe(0);

    // Past the TTL the abandoned slot is reclaimed on the next acquire -> the
    // still-open upstream stream must be cancelled, not just the local slot.
    clock = 5_000;
    const reclaimed = await proxy.fetch(new Request("http://proxy.local/v1/shape?table=_smithers_runs"));
    expect(reclaimed.status).toBe(200);
    expect(upstreamCancelled).toBe(1);
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

  test("a forwarded event reports bytes for its own shape stream", async () => {
    const events: SmithersElectricProxyEvent[] = [];
    let upstreamCalls = 0;
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      authenticate: () => auth(),
      observer: { event: (event) => events.push(event) },
      fetchClient: async () => {
        upstreamCalls += 1;
        return new Response("x".repeat(upstreamCalls * 10));
      },
    });

    const first = await proxy.fetch(new Request("http://proxy.local/v1/shape?table=_smithers_runs"));
    const second = await proxy.fetch(new Request("http://proxy.local/v1/shape?table=_smithers_runs"));
    await first.arrayBuffer();
    await second.arrayBuffer();

    const forwarded = events
      .filter((event) => event.type === "electric.shape.forwarded")
      .map((event) => event.forwardedBytes);
    expect(forwarded).toEqual([10, 20]);
  });

  test("an upstream outage emits a structured error event + span with the reason and bumps the metric", async () => {
    const events: SmithersElectricProxyEvent[] = [];
    const spans: SmithersElectricProxySpan[] = [];
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      authenticate: () => auth(),
      observer: {
        event: (event) => events.push(event),
        span: (span) => spans.push(span),
      },
      fetchClient: async () => {
        throw new Error("ECONNREFUSED electric.local:5133");
      },
    });

    const response = await proxy.fetch(new Request("http://proxy.local/v1/shape?table=_smithers_runs"));
    expect(response.status).toBe(502);

    const upstreamEvent = events.find((event) => event.type === "electric.upstream.error");
    expect(upstreamEvent).toBeDefined();
    expect(upstreamEvent?.reason).toContain("ECONNREFUSED");
    expect(upstreamEvent?.table).toBe("_smithers_runs");
    expect(upstreamEvent?.principalId).toBe("user-1");
    expect(spans.some((span) => span.name === "smithers.electric.upstream.error")).toBe(true);
    expect(proxy.metrics.snapshot().upstreamErrors).toBe(1);
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

describe("the frame-bound scanner counts each SSE frame independently", () => {
  const encoder = new TextEncoder();
  const streamOf = (chunks: readonly string[]): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });

  test("the per-frame byte bound resets at each blank line so many sub-limit frames stream past a cumulative total over the bound", async () => {
    // 20 frames, each far under the 10-byte bound but ~120 bytes in total. If the
    // scanner did not reset per frame the running count would blow the bound; the
    // whole stream must forward with no large-frame trip.
    const frames = Array.from({ length: 20 }, () => "data\n\n");
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      authenticate: () => auth(),
      maxFrameBytes: 10,
      fetchClient: async () => new Response(streamOf(frames)),
    });

    const response = await proxy.fetch(new Request("http://proxy.local/v1/shape?table=_smithers_runs"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(frames.join(""));
    expect(proxy.metrics.snapshot().largeFrames).toBe(0);
    expect(proxy.metrics.snapshot().forwardedBytes).toBe(120);
  });

  test("the reset does not disable the bound: a single oversized frame after several small ones still trips", async () => {
    // Three tiny frames reset the counter to zero, then one genuinely oversized
    // frame (no delimiter) must still exceed the per-frame bound.
    const chunks = ["ok\n\n", "ok\n\n", "ok\n\n", "X".repeat(50)];
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      authenticate: () => auth(),
      maxFrameBytes: 10,
      fetchClient: async () => new Response(streamOf(chunks)),
    });

    const response = await proxy.fetch(new Request("http://proxy.local/v1/shape?table=_smithers_runs"));
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow("Electric frame exceeded 10 bytes");
    expect(proxy.metrics.snapshot().largeFrames).toBe(1);
  });
});
