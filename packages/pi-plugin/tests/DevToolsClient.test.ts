import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { WebSocketServer } from "ws";
import { DevToolsClient } from "../src/runtime/DevToolsClient.js";
import type { DevToolsNode, DevToolsSnapshot } from "@smithers-orchestrator/protocol";

function node(id: number, nodeId: string, state = "running"): DevToolsNode {
  return {
    id,
    type: "task",
    name: nodeId,
    props: { state },
    task: { nodeId, kind: "compute", label: nodeId, iteration: 0 },
    children: [],
    depth: 1,
  };
}

function snapshot(seq: number): DevToolsSnapshot {
  return {
    version: 1,
    runId: "run-client",
    frameNo: seq,
    seq,
    root: {
      id: 1,
      type: "workflow",
      name: "Workflow",
      props: { state: "running" },
      children: [node(2, "task:a")],
      depth: 0,
    },
  };
}

async function httpFixture(handler: (body: any, request: Request) => Response | Promise<Response>) {
  const requests: Array<{ body: any; authorization: string | undefined }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push({ body, authorization: req.headers.authorization });
    const response = await handler(body, new Request(`http://fixture${req.url}`));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) {
    throw new Error("expected TCP server address");
  }
  return { server, requests, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function next<T>(generator: AsyncGenerator<T>) {
  const result = await generator.next();
  if (result.done) {
    throw new Error("expected generator value");
  }
  return result.value;
}

async function expectSmithersError(promise: Promise<unknown>, code: string, message: string) {
  try {
    await promise;
  } catch (error) {
    expect(error).toHaveProperty("code", code);
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.message : String(error)).toContain(message);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("DevToolsClient", () => {
  const servers: Array<Server | WebSocketServer> = [];

  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.close();
    }
  });

  test("sends authenticated snapshot RPCs and records the latest seq", async () => {
    const fixture = await httpFixture((body) => {
      expect(body.method).toBe("getDevToolsSnapshot");
      expect(body.params).toEqual({ runId: "run-client", frameNo: 7 });
      return Response.json({ type: "res", id: body.id, ok: true, payload: snapshot(7) });
    });
    servers.push(fixture.server);
    const client = new DevToolsClient({ baseUrl: fixture.baseUrl, apiKey: "srk_test" });

    const result = await client.getDevToolsSnapshot("run-client", 7);

    expect(result.seq).toBe(7);
    expect(client.lastSeqSeen("run-client")).toBe(7);
    expect(fixture.requests[0]?.authorization).toBe("Bearer srk_test");
  });

  test("falls back to workflowRuns.resume when runs.resume is unsupported", async () => {
    const methods: string[] = [];
    const fixture = await httpFixture((body) => {
      methods.push(body.method);
      if (body.method === "runs.resume") {
        return Response.json({
          type: "res",
          id: body.id,
          ok: false,
          error: { code: "METHOD_NOT_FOUND", message: "method not found" },
        });
      }
      return Response.json({
        type: "res",
        id: body.id,
        ok: true,
        payload: { result: { audit_row_id: "audit-123" } },
      });
    });
    servers.push(fixture.server);
    const client = new DevToolsClient({ baseUrl: fixture.baseUrl });

    await expect(client.resume("run-client")).resolves.toEqual({ auditRowId: "audit-123" });
    expect(methods).toEqual(["runs.resume", "workflowRuns.resume"]);
  });

  test("surfaces HTTP and RPC failures with Smithers error codes", async () => {
    const httpFailure = await httpFixture(() => new Response("nope", { status: 503 }));
    servers.push(httpFailure.server);
    await expectSmithersError(
      new DevToolsClient({ baseUrl: httpFailure.baseUrl }).cancel("run-client"),
      "PI_GATEWAY_HTTP_ERROR",
      "Gateway HTTP 503",
    );

    const rpcFailure = await httpFixture((body) => Response.json({
      type: "res",
      id: body.id,
      ok: false,
      error: { code: "RUN_LOCKED", message: "run is locked" },
    }));
    servers.push(rpcFailure.server);
    await expectSmithersError(
      new DevToolsClient({ baseUrl: rpcFailure.baseUrl }).cancel("run-client"),
      "RUN_LOCKED",
      "run is locked",
    );
  });

  test("normalizes stream events, ignores other stream ids, and emits a gap resync for stale cursors", async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    servers.push(server);
    server.on("connection", (ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: {} }));
      ws.on("message", (raw) => {
        const frame = JSON.parse(String(raw));
        if (frame.method === "connect") {
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: {} }));
          return;
        }
        if (frame.method === "streamDevTools" && frame.params.afterSeq === 10) {
          ws.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: false,
            error: { code: "SeqOutOfRange", message: "stale" },
          }));
          return;
        }
        if (frame.method === "streamDevTools") {
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { streamId: "wanted" } }));
          ws.send(JSON.stringify({
            type: "event",
            event: "devtools.event",
            payload: { streamId: "other", event: { type: "snapshot", ...snapshot(1) } },
          }));
          ws.send(JSON.stringify({
            type: "event",
            event: "devtools.event",
            payload: { streamId: "wanted", event: { type: "snapshot", ...snapshot(2) } },
          }));
        }
      });
    });
    const address = server.address();
    if (typeof address === "string" || address === null) {
      throw new Error("expected TCP server address");
    }
    const abort = new AbortController();
    const client = new DevToolsClient({ baseUrl: `http://127.0.0.1:${address.port}` });
    const stream = client.streamDevTools("run-client", 10, abort.signal);

    expect(await next(stream)).toEqual({ version: 1, kind: "gapResync", gapResync: { fromSeq: 10, toSeq: 10 } });
    const event = await next(stream);
    expect(event.kind).toBe("snapshot");
    expect(event.kind === "snapshot" ? event.snapshot.seq : undefined).toBe(2);
    expect(client.lastSeqSeen("run-client")).toBe(2);
    abort.abort();
  });

  test("throws devtools stream errors for the active stream", async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    servers.push(server);
    server.on("connection", (ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: {} }));
      ws.on("message", (raw) => {
        const frame = JSON.parse(String(raw));
        if (frame.method === "connect") {
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: {} }));
        }
        if (frame.method === "streamDevTools") {
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { streamId: "stream-1" } }));
          ws.send(JSON.stringify({
            type: "event",
            event: "devtools.error",
            payload: { streamId: "stream-1", error: { code: "BROKEN", message: "broken stream" } },
          }));
        }
      });
    });
    const address = server.address();
    if (typeof address === "string" || address === null) {
      throw new Error("expected TCP server address");
    }
    const stream = new DevToolsClient({ baseUrl: `http://127.0.0.1:${address.port}` })
      .streamDevTools("run-client");

    await expectSmithersError(stream.next(), "BROKEN", "broken stream");
  });
});
