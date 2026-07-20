import { afterEach, describe, expect, test } from "bun:test";
import {
  createSmithersElectricProxy,
  serveSmithersElectricProxy,
  type SmithersElectricAuthContext,
  type SmithersElectricProxy,
  type SmithersElectricProxyServer,
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

/** A run-scoped shape that requires a client `where` (no template auto-fill). */
const eventsShape: SmithersElectricShapeDefinition = {
  name: "events",
  table: "_smithers_events",
  requiredScope: "run:read",
  runIdColumn: "run_id",
  whereTemplate: "run_id IN ({run_ids})",
  description: "events",
};

function eventsProxy(): { proxy: SmithersElectricProxy; upstreamHits: () => number } {
  let hits = 0;
  const proxy = createSmithersElectricProxy({
    electricUrl: "http://electric.local/v1/shape",
    authenticate: () => auth({ grantedRunIds: ["run-1"] }),
    fetchClient: async () => {
      hits += 1;
      return new Response("[]");
    },
  });
  return { proxy, upstreamHits: () => hits };
}

async function whereResponse(where: string): Promise<Response> {
  const { proxy } = eventsProxy();
  return proxy.fetch(
    new Request(`http://proxy.local/v1/shape?table=_smithers_events&where=${encodeURIComponent(where)}`),
  );
}

describe("where-clause tokenizer rejections", () => {
  test("rejects a `--` line comment", async () => {
    const response = await whereResponse("run_id = 'run-1' -- sneaky");
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("comments are not allowed");
  });

  test("rejects a `/* */` block comment", async () => {
    const response = await whereResponse("run_id = 'run-1' /* sneaky */");
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("comments are not allowed");
  });

  test("tokenizes numeric literals in an extra predicate", async () => {
    // `n = 5` exercises the number-token branch; run_id stays within grants.
    const response = await whereResponse("run_id = 'run-1' and n = 5");
    expect(response.status).toBe(200);
    await response.text();
  });

  test("rejects an unexpected character", async () => {
    const response = await whereResponse("run_id = 'run-1' and n = @");
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("unexpected character");
  });

  test("rejects a keyword where a literal value is expected", async () => {
    const response = await whereResponse("run_id = and");
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("expected literal value");
  });

  test("rejects a clause that starts with a forbidden keyword", async () => {
    const response = await whereResponse("not run_id = 'run-1'");
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("NOT is not allowed");
  });

  test("accepts an `IS NULL` predicate alongside a scoped run_id", async () => {
    const response = await whereResponse("run_id in ('run-1') and c is null");
    expect(response.status).toBe(200);
    await response.text();
  });

  test("rejects an unsupported operator", async () => {
    const response = await whereResponse("run_id in ('run-1') and c like 'x'");
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("unsupported where operator");
  });
});

describe("shape lookup by explicit shape name", () => {
  test("resolves a shape via the `shape` query parameter", async () => {
    let forwardedWhere = "";
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      authenticate: () => auth({ grantedRunIds: ["run-1"] }),
      fetchClient: async (url) => {
        forwardedWhere = new URL(String(url)).searchParams.get("where") ?? "";
        return new Response("[]");
      },
    });
    const response = await proxy.fetch(
      new Request("http://proxy.local/v1/shape?table=_smithers_runs&shape=runs"),
    );
    expect(response.status).toBe(200);
    expect(forwardedWhere).toBe("run_id IN ('run-1')");
  });
});

describe("workspace-scoped shapes fill and enforce workspace grants", () => {
  const wsShape: SmithersElectricShapeDefinition = {
    name: "ws",
    table: "_smithers_ws",
    requiredScope: "run:read",
    workspaceIdColumn: "workspace_id",
    whereTemplate: "workspace_id IN ({workspace_ids})",
    description: "ws",
  };

  test("fills the workspace template from granted workspace ids and enforces them", async () => {
    let forwardedWhere = "";
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      catalog: [wsShape],
      authenticate: () => auth({ grantedWorkspaceIds: ["ws-1"], grantedRunIds: undefined }),
      fetchClient: async (url) => {
        forwardedWhere = new URL(String(url)).searchParams.get("where") ?? "";
        return new Response("[]");
      },
    });
    const response = await proxy.fetch(new Request("http://proxy.local/v1/shape?table=_smithers_ws"));
    expect(response.status).toBe(200);
    expect(forwardedWhere).toBe("workspace_id IN ('ws-1')");
  });

  test("a workspace-scoped principal with no workspace grants cannot fill the template", async () => {
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      catalog: [wsShape],
      authenticate: () => auth({ grantedWorkspaceIds: [], grantedRunIds: undefined }),
      fetchClient: async () => new Response("[]"),
    });
    const response = await proxy.fetch(new Request("http://proxy.local/v1/shape?table=_smithers_ws"));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("cannot be filled");
  });

  test("rejects a workspace predicate outside the granted workspace ids", async () => {
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      catalog: [wsShape],
      authenticate: () => auth({ grantedWorkspaceIds: ["ws-1"], grantedRunIds: undefined }),
      fetchClient: async () => new Response("[]"),
    });
    const response = await proxy.fetch(
      new Request("http://proxy.local/v1/shape?table=_smithers_ws&where=" + encodeURIComponent("workspace_id = 'ws-9'")),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("unauthorized value");
  });
});

describe("user-private shapes bind to the authenticated user", () => {
  const meShape: SmithersElectricShapeDefinition = {
    name: "me",
    table: "_smithers_me",
    requiredScope: "run:read",
    userPrivateColumn: "user_id",
    whereTemplate: "user_id = {user_id}",
    description: "me",
  };

  test("fills the user template from the authenticated user id", async () => {
    let forwardedWhere = "";
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      catalog: [meShape],
      authenticate: () => auth({ userId: "user-1", grantedRunIds: undefined }),
      fetchClient: async (url) => {
        forwardedWhere = new URL(String(url)).searchParams.get("where") ?? "";
        return new Response("[]");
      },
    });
    const response = await proxy.fetch(new Request("http://proxy.local/v1/shape?table=_smithers_me"));
    expect(response.status).toBe(200);
    expect(forwardedWhere).toBe("user_id = 'user-1'");
  });

  test("rejects a user predicate that does not match the authenticated user", async () => {
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      catalog: [meShape],
      authenticate: () => auth({ userId: "user-1", grantedRunIds: undefined }),
      fetchClient: async () => new Response("[]"),
    });
    const response = await proxy.fetch(
      new Request("http://proxy.local/v1/shape?table=_smithers_me&where=" + encodeURIComponent("user_id = 'someone-else'")),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("must match the authenticated user");
  });
});

describe("request routing edge cases", () => {
  test("answers a CORS preflight OPTIONS request", async () => {
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      authenticate: () => auth(),
      fetchClient: async () => new Response("[]"),
    });
    const response = await proxy.fetch(new Request("http://proxy.local/v1/shape", { method: "OPTIONS" }));
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toContain("GET");
  });

  test("rejects duplicate security query parameters", async () => {
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      authenticate: () => auth(),
      fetchClient: async () => new Response("[]"),
    });
    const response = await proxy.fetch(
      new Request("http://proxy.local/v1/shape?table=_smithers_runs&table=_smithers_events"),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("duplicate table");
  });

  test("returns 401 when authentication fails", async () => {
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      authenticate: () => null,
      fetchClient: async () => new Response("[]"),
    });
    const response = await proxy.fetch(new Request("http://proxy.local/v1/shape?table=_smithers_runs"));
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("authentication required");
  });
});

describe("upstream body forwarding edge cases", () => {
  test("forwards a null-body upstream response (e.g. 204) and releases the slot", async () => {
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      authenticate: () => auth(),
      fetchClient: async () => new Response(null, { status: 204 }),
    });
    const response = await proxy.fetch(new Request("http://proxy.local/v1/shape?table=_smithers_runs"));
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect(proxy.metrics.snapshot().activeShapes).toBe(0);
  });

  test("surfaces an upstream stream error while draining the body", async () => {
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      authenticate: () => auth(),
      fetchClient: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new Error("upstream mid-stream failure"));
            },
          }),
        ),
    });
    const response = await proxy.fetch(new Request("http://proxy.local/v1/shape?table=_smithers_runs"));
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow();
  });

  test("counts CRLF-delimited frames independently (CR-only gap between newlines)", async () => {
    const encoder = new TextEncoder();
    // Frames separated by a CR-only gap: "a\r\n\r\nb\r\n\r\n". The blank line
    // between frames is a lone CR, so the per-frame counter resets and neither
    // frame trips the bound even though the running total exceeds it.
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      authenticate: () => auth(),
      maxFrameBytes: 6,
      fetchClient: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode("a\r\n\r\nb\r\n\r\n"));
              controller.close();
            },
          }),
        ),
    });
    const response = await proxy.fetch(new Request("http://proxy.local/v1/shape?table=_smithers_runs"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("a\r\n\r\nb\r\n\r\n");
    expect(proxy.metrics.snapshot().largeFrames).toBe(0);
  });
});

describe("reader.cancel rejections on teardown are swallowed", () => {
  const encoder = new TextEncoder();

  test("client-side body cancel swallows a throwing upstream cancel", async () => {
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      authenticate: () => auth(),
      fetchClient: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(encoder.encode("data\n\n"));
            },
            cancel() {
              throw new Error("upstream refuses to cancel");
            },
          }),
        ),
    });
    const response = await proxy.fetch(new Request("http://proxy.local/v1/shape?table=_smithers_runs"));
    expect(response.status).toBe(200);
    // Cancelling the client body tears down the upstream reader whose cancel
    // throws; the proxy must swallow that rejection rather than surface it.
    await expect(response.body?.cancel()).resolves.toBeUndefined();
  });

  test("frame-exceeded teardown swallows a throwing upstream cancel", async () => {
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      authenticate: () => auth(),
      maxFrameBytes: 4,
      fetchClient: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(encoder.encode("data: too-big\n\n"));
            },
            cancel() {
              throw new Error("upstream refuses to cancel");
            },
          }),
        ),
    });
    const response = await proxy.fetch(new Request("http://proxy.local/v1/shape?table=_smithers_runs"));
    await expect(response.text()).rejects.toThrow("Electric frame exceeded");
    expect(proxy.metrics.snapshot().largeFrames).toBe(1);
  });

  test("TTL-reclaim teardown swallows a throwing upstream cancel", async () => {
    let clock = 0;
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      authenticate: () => auth(),
      rateLimits: { openPerMinute: 100, activeMax: 1 },
      activeTtlMs: 1_000,
      now: () => clock,
      fetchClient: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {},
            cancel() {
              throw new Error("upstream refuses to cancel");
            },
          }),
        ),
    });
    const first = await proxy.fetch(new Request("http://proxy.local/v1/shape?table=_smithers_runs"));
    expect(first.status).toBe(200);
    // Advance past the TTL: reclaiming the abandoned slot cancels the upstream
    // reader whose cancel throws; the reclaim must not blow up.
    clock = 5_000;
    const reclaimed = await proxy.fetch(new Request("http://proxy.local/v1/shape?table=_smithers_runs"));
    expect(reclaimed.status).toBe(200);
  });
});

describe("serveSmithersElectricProxy error handling", () => {
  let running: SmithersElectricProxyServer | undefined;

  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  test("writes an empty body for a null-body proxy response (OPTIONS preflight)", async () => {
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      authenticate: () => auth(),
      fetchClient: async () => new Response("[]"),
    });
    running = await serveSmithersElectricProxy({ proxy, host: "127.0.0.1" });
    const response = await fetch(`http://127.0.0.1:${running.port}/v1/shape`, { method: "OPTIONS" });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  test("returns 502 when the proxy fetch rejects", async () => {
    // The server wrapper's job is to convert a proxy failure into a 502; drive
    // that path with a proxy whose fetch rejects.
    running = await serveSmithersElectricProxy({
      host: "127.0.0.1",
      proxy: {
        metrics: createSmithersElectricProxy({
          electricUrl: "http://electric.local/v1/shape",
          authenticate: () => null,
        }).metrics,
        fetch: async () => {
          throw new Error("proxy exploded");
        },
      },
    });
    const response = await fetch(`http://127.0.0.1:${running.port}/v1/shape`);
    expect(response.status).toBe(502);
    expect((await response.json()).error).toContain("proxy exploded");
  });

  test("destroys the response when the proxy body errors mid-stream", async () => {
    const proxy = createSmithersElectricProxy({
      electricUrl: "http://electric.local/v1/shape",
      authenticate: () => auth(),
      fetchClient: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new Error("upstream mid-stream failure"));
            },
          }),
        ),
    });
    running = await serveSmithersElectricProxy({ proxy, host: "127.0.0.1" });
    await expect(
      (async () => {
        const response = await fetch(`http://127.0.0.1:${running!.port}/v1/shape?table=_smithers_runs`);
        await response.text();
      })(),
    ).rejects.toThrow();
  });
});
