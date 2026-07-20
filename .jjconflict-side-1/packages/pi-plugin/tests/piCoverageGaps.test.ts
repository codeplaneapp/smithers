import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { createSmithersAgentContract } from "@smithers-orchestrator/agents/agent-contract";
import { buildSmithersPiSystemPrompt } from "../src/buildSmithersPiSystemPrompt.js";
import { SmithersPiHttpClient } from "../src/api/SmithersPiHttpClient.js";
import { DevToolsClient } from "../src/runtime/DevToolsClient.js";

describe("buildSmithersPiSystemPrompt typical-workflow branches", () => {
  test("run-only contract, debug tools, and revert produce their guidance steps", () => {
    // run_workflow WITHOUT list_workflows -> the `else if (run)` step.
    // get_node_detail -> the Debug step. revert_attempt -> the Revert step.
    const contract = createSmithersAgentContract({
      serverName: "smithers",
      toolSurface: "semantic",
      tools: [
        { name: "run_workflow", description: "Start a discovered workflow directly through the engine." },
        { name: "get_node_detail", description: "Show enriched node details for debugging." },
        { name: "revert_attempt", description: "Destructive: revert the workspace to a previous attempt." },
      ],
    });

    const prompt = buildSmithersPiSystemPrompt("Base\n", undefined, contract);

    // else-if branch: run present, discover absent.
    expect(prompt).toContain("**Run it** -> Use `smithers_run_workflow` to launch the workflow.");
    expect(prompt).not.toContain("to find workflow IDs");
    // Debug branch.
    expect(prompt).toContain("**Debug** -> Use `smithers_get_node_detail`");
    // Revert branch.
    expect(prompt).toContain("**Revert** -> Use `smithers_revert_attempt`");
    expect(prompt).toContain("roll back or time travel");
  });

  test("active-run context surfaces recent errors", () => {
    const contract = createSmithersAgentContract({ serverName: "smithers", toolSurface: "semantic", tools: [] });
    const prompt = buildSmithersPiSystemPrompt("Base\n", undefined, contract, {
      runId: "run-1",
      workflowName: "deploy",
      status: "failed",
      nodeStates: [],
      errors: ["boom-1", "boom-2", "boom-3", "boom-4"],
    });
    // Only the last three errors are shown.
    expect(prompt).toContain("Recent errors: boom-2; boom-3; boom-4");
    expect(prompt).not.toContain("boom-1");
  });
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("SmithersPiHttpClient.json", () => {
  test("GET returns parsed json and sends no auth header without an apiKey", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return { ok: true, json: async () => ({ hello: "world" }) };
    }) as unknown as typeof fetch;

    const client = new SmithersPiHttpClient({ baseUrl: "http://gw" });
    const out = await client.json("/status");

    expect(out).toEqual({ hello: "world" });
    expect(seen?.url).toBe("http://gw/status");
    expect(seen?.init.method).toBe("GET");
    expect((seen?.init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect((seen?.init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });

  test("POST with a body sets JSON + bearer headers and serializes the body", async () => {
    let seen: { init: RequestInit } | undefined;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seen = { init };
      return { ok: true, json: async () => ({ ok: true }) };
    }) as unknown as typeof fetch;

    const client = new SmithersPiHttpClient({ baseUrl: "http://gw", apiKey: "secret" });
    await client.json("/run", { method: "POST", body: { a: 1 } });

    const headers = seen?.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization).toBe("Bearer secret");
    expect(seen?.init.body).toBe(JSON.stringify({ a: 1 }));
  });

  test("a non-ok response throws PI_HTTP_ERROR including the response text", async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 503,
      text: async () => "gateway down",
    })) as unknown as typeof fetch;

    const client = new SmithersPiHttpClient({ baseUrl: "http://gw" });
    const err = (await client.json("/status").then(
      () => undefined,
      (error) => error,
    )) as { code?: string; message?: string } | undefined;
    expect(err?.code).toBe("PI_HTTP_ERROR");
    expect(err?.message).toContain("Smithers HTTP 503: gateway down");
  });

  test("when reading the error body itself fails, the message omits the detail", async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 500,
      // text() rejects -> the `.catch(() => "")` fallback yields an empty detail.
      text: async () => {
        throw new Error("body read failed");
      },
    })) as unknown as typeof fetch;

    const client = new SmithersPiHttpClient({ baseUrl: "http://gw" });
    const err = (await client.json("/status").then(
      () => undefined,
      (error) => error,
    )) as { code?: string; message?: string } | undefined;
    expect(err?.code).toBe("PI_HTTP_ERROR");
    // No detail suffix because the body read failed and fell back to "".
    expect(err?.message).toContain("Smithers HTTP 500");
    expect(err?.message).not.toContain("Smithers HTTP 500:");
  });

  test("events swallows a reader.cancel() rejection in the finally block", async () => {
    let read = false;
    const body = {
      getReader() {
        return {
          read: async () => {
            if (!read) {
              read = true;
              return { done: false, value: new TextEncoder().encode('data: {"n":1}\n\n') };
            }
            return { done: true, value: undefined };
          },
          // The finally block awaits cancel().catch(() => {}); a rejection here
          // must be swallowed rather than surface out of the generator.
          cancel: async () => {
            throw new Error("cancel failed");
          },
          releaseLock: () => {},
        };
      },
    };
    globalThis.fetch = (async () => ({ ok: true, body })) as unknown as typeof fetch;

    const client = new SmithersPiHttpClient({ baseUrl: "http://gw" });
    const received: unknown[] = [];
    for await (const event of client.events("/stream")) {
      received.push(event);
    }
    expect(received).toEqual([{ n: 1 }]);
  });
});

async function rpcFixture(handler: (method: string, params: any) => unknown) {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const payload = handler(body.method, body.params);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "res", id: body.id, ok: true, payload }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) {
    throw new Error("expected TCP server address");
  }
  return { server, baseUrl: `http://127.0.0.1:${(address as { port: number }).port}` };
}

describe("DevToolsClient RPC mutation wrappers", () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.close();
    }
  });

  test("node output/diff, approve/deny, signal and rewind hit their RPC methods", async () => {
    const methods: string[] = [];
    const fixture = await rpcFixture((method, params) => {
      methods.push(method);
      if (method === "devtools.getNodeOutput") {
        return { output: { value: params.nodeId } };
      }
      if (method === "devtools.getNodeDiff") {
        return { diff: "patch" };
      }
      if (method === "devtools.jumpToFrame") {
        return { result: { audit_row_id: "rw-1" }, frameNo: params.frameNo };
      }
      // approvals.decide / signals.send -> audit envelope.
      return { result: { audit_row_id: "a1" } };
    });
    servers.push(fixture.server);
    const client = new DevToolsClient({ baseUrl: fixture.baseUrl });

    expect(await client.getNodeOutput("run", "task:a", 2)).toEqual({ output: { value: "task:a" } });
    expect(await client.getNodeDiff("run", "task:a")).toEqual({ diff: "patch" });
    expect(await client.approve("run", "task:a", 0, "lgtm")).toEqual({ auditRowId: "a1" });
    expect(await client.deny("run", "task:a")).toEqual({ auditRowId: "a1" });
    expect(await client.signal("run", "go", { k: 1 }, "corr-1")).toEqual({ auditRowId: "a1" });

    const rewound = await client.rewind("run", 3, true);
    expect(rewound).toMatchObject({ auditRowId: "rw-1", frameNo: 3 });

    expect(methods).toEqual([
      "devtools.getNodeOutput",
      "devtools.getNodeDiff",
      "approvals.decide",
      "approvals.decide",
      "signals.send",
      "devtools.jumpToFrame",
    ]);
  });

  test("resume returns the audit id when runs.resume is supported", async () => {
    const fixture = await rpcFixture((method) => {
      expect(method).toBe("runs.resume");
      return { result: { audit_row_id: "res-1" } };
    });
    servers.push(fixture.server);
    const client = new DevToolsClient({ baseUrl: fixture.baseUrl });
    expect(await client.resume("run")).toEqual({ auditRowId: "res-1" });
  });
});

describe("DevToolsClient rpc error-body fallback", () => {
  test("a non-ok rpc whose body read fails still throws PI_GATEWAY_HTTP_ERROR", async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 500,
      // text() rejects -> the rpc `.catch(() => "")` fallback keeps the throw path alive.
      text: async () => {
        throw new Error("body read failed");
      },
    })) as unknown as typeof fetch;

    const client = new DevToolsClient({ baseUrl: "http://gw" });
    const err = (await client.cancel("run").then(
      () => undefined,
      (error) => error,
    )) as { code?: string; message?: string } | undefined;
    expect(err?.code).toBe("PI_GATEWAY_HTTP_ERROR");
    expect(err?.message).toContain("Gateway HTTP 500");
  });
});
