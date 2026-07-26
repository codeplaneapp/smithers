import { afterEach, describe, expect, test } from "bun:test";
import { Gateway } from "../src/light-gateway.js";

/**
 * @param {import("node:http").Server} server
 * @returns {number}
 */
function getPort(server) {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return addr.port;
}

/** @type {Gateway[]} */
const started = [];

async function listen(options) {
  const gw = new Gateway(options?.ctor ?? {});
  started.push(gw);
  const server = await gw.listen(options?.listen ?? { port: 0, host: "127.0.0.1" });
  return { gw, server, port: getPort(server) };
}

afterEach(async () => {
  while (started.length) {
    const gw = started.pop();
    try {
      await gw?.close();
    } catch {}
  }
});

describe("light-gateway", () => {
  test("constructor applies defaults", () => {
    const gw = new Gateway();
    expect(gw.protocol).toBe(1);
    expect(gw.features).toEqual(["http", "rpc", "routes"]);
    expect(gw.routes).toBeNull();
    expect(gw.identity).toBeNull();
    expect(gw.workspaceRoot).toBe(process.cwd());
    expect(gw.headersTimeout).toBe(30_000);
    expect(gw.requestTimeout).toBe(60_000);
    expect(gw.maxBodyBytes).toBe(1_048_576);
    expect(typeof gw.startedAtMs).toBe("number");
    expect(gw.server).toBeNull();
  });

  test("constructor honours explicit options", () => {
    const routesFn = () => false;
    const gw = new Gateway({
      protocol: 2,
      features: ["http"],
      routes: routesFn,
      identity: { kind: "custom", extra: 9 },
      workspaceRoot: "/tmp",
      headersTimeout: 111,
      requestTimeout: 222,
      maxBodyBytes: 333,
    });
    expect(gw.protocol).toBe(2);
    expect(gw.features).toEqual(["http"]);
    expect(gw.routes).toBe(routesFn);
    expect(gw.identity).toEqual({ kind: "custom", extra: 9 });
    expect(gw.workspaceRoot).toBe("/tmp");
    expect(gw.headersTimeout).toBe(111);
    expect(gw.requestTimeout).toBe(222);
    expect(gw.maxBodyBytes).toBe(333);
  });

  test("non-function routes option is coerced to null", () => {
    const gw = new Gateway({ routes: "not-a-function" });
    expect(gw.routes).toBeNull();
  });

  test("buildIdentity merges identity object and ignores non-object identity", () => {
    const withIdentity = new Gateway({ identity: { region: "us" }, workspaceRoot: "/ws" });
    const id = withIdentity.buildIdentity();
    expect(id.kind).toBe("gateway");
    expect(id.pid).toBe(process.pid);
    expect(id.workspaceRoot).toBe("/ws");
    expect(id.region).toBe("us");
    expect(typeof id.startedAtMs).toBe("number");

    const stringIdentity = new Gateway({ identity: "nope" });
    const id2 = stringIdentity.buildIdentity();
    expect(id2.kind).toBe("gateway");
    expect(id2).not.toHaveProperty("0");
  });

  test("GET /health returns identity and features", async () => {
    const { port } = await listen({ ctor: { protocol: 3, features: ["http", "rpc"] } });
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.protocol).toBe(3);
    expect(json.features).toEqual(["http", "rpc"]);
    expect(json.identity.kind).toBe("gateway");
  });

  test("GET /workflows returns empty list", async () => {
    const { port } = await listen();
    const res = await fetch(`http://127.0.0.1:${port}/workflows`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workflows: [] });
  });

  test("GET /metrics returns empty prometheus body", async () => {
    const { port } = await listen();
    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("");
  });

  test("GET / returns the landing document", async () => {
    const { port } = await listen();
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.message).toBe("Smithers Gateway");
    expect(json.identity.kind).toBe("gateway");
  });

  test("unknown route returns 404", async () => {
    const { port } = await listen();
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error.code).toBe("NOT_FOUND");
  });

  test("POST /rpc health returns identity payload with body id", async () => {
    const { port } = await listen();
    const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "req-1", method: "health" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.id).toBe("req-1");
    expect(json.apiVersion).toBe("v1");
    expect(json.payload.protocol).toBe(1);
    expect(typeof json.payload.uptimeMs).toBe("number");
  });

  test("POST /rpc without id falls back to the request id header", async () => {
    const { port } = await listen();
    const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "hdr-9" },
      body: JSON.stringify({ method: "health" }),
    });
    const json = await res.json();
    expect(json.id).toBe("hdr-9");
    expect(json.ok).toBe(true);
  });

  test("POST /v1/rpc/:method uses the forced method from the path", async () => {
    const { port } = await listen();
    const res = await fetch(`http://127.0.0.1:${port}/v1/rpc/health`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "x" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.payload.identity.kind).toBe("gateway");
  });

  test("unknown rpc method returns METHOD_NOT_FOUND", async () => {
    const { port } = await listen();
    const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "frobnicate" }),
    });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("METHOD_NOT_FOUND");
    expect(json.error.message).toContain("frobnicate");
  });

  test("rpc with no method reports empty method name", async () => {
    const { port } = await listen();
    const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error.message).toContain("Unknown method:");
  });

  test("invalid JSON body yields INVALID_JSON 400", async () => {
    const { port } = await listen();
    const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("INVALID_JSON");
  });

  test("empty body is treated as an empty object (unknown method)", async () => {
    const { port } = await listen();
    const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    // No method in an empty object → 404 METHOD_NOT_FOUND
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error.code).toBe("METHOD_NOT_FOUND");
  });

  test("custom routes handler can short-circuit a request", async () => {
    const { port } = await listen({
      ctor: {
        routes: async (req, res, ctx) => {
          if (ctx.url.pathname === "/custom") {
            res.statusCode = 201;
            res.end("custom-ok");
            return true;
          }
          return false;
        },
      },
    });
    const handled = await fetch(`http://127.0.0.1:${port}/custom`);
    expect(handled.status).toBe(201);
    expect(await handled.text()).toBe("custom-ok");

    // A path the routes handler declines falls through to the 404 branch.
    const declined = await fetch(`http://127.0.0.1:${port}/other`);
    expect(declined.status).toBe(404);
  });

  test("listen returns the same server when already listening", async () => {
    const { gw, server } = await listen();
    const again = await gw.listen({ port: 0 });
    expect(again).toBe(server);
  });

  test("listen binds to an explicit host+port", async () => {
    const gw = new Gateway();
    started.push(gw);
    const server = await gw.listen({ port: 0, host: "127.0.0.1" });
    expect(getPort(server)).toBeGreaterThan(0);
  });

  test("listen binds to a port with no host", async () => {
    const gw = new Gateway();
    started.push(gw);
    const server = await gw.listen({ port: 0 });
    const res = await fetch(`http://127.0.0.1:${getPort(server)}/health`);
    expect(res.status).toBe(200);
  });

  test("listen binds to a unix socket path", async () => {
    const gw = new Gateway();
    started.push(gw);
    const socketPath = `/tmp/smithers-light-gw-${Math.random().toString(36).slice(2)}.sock`;
    const server = await gw.listen({ path: socketPath });
    expect(server.listening).toBe(true);
    await gw.close();
  });

  test("listen rejects when the address is already in use", async () => {
    const first = new Gateway();
    started.push(first);
    const server = await first.listen({ port: 0, host: "127.0.0.1" });
    const usedPort = getPort(server);
    const second = new Gateway();
    started.push(second);
    await expect(second.listen({ port: usedPort, host: "127.0.0.1" })).rejects.toBeDefined();
  });

  test("close is a no-op when the server was never started", async () => {
    const gw = new Gateway();
    await expect(gw.close()).resolves.toBeUndefined();
  });

  test("close tears down the server and allows re-listen", async () => {
    const gw = new Gateway();
    started.push(gw);
    await gw.listen({ port: 0, host: "127.0.0.1" });
    await gw.close();
    expect(gw.server).toBeNull();
    // Fresh listen after close works.
    const server = await gw.listen({ port: 0, host: "127.0.0.1" });
    expect(server.listening).toBe(true);
  });

  test("sendJson skips header setup once headers are already sent", async () => {
    // Exercise the `headersSent === true` branch of sendJson: the routes
    // handler writes AND flushes headers but returns false, so control
    // falls through to the terminal sendJson(404) while headers are locked.
    const { port } = await listen({
      ctor: {
        routes: async (req, res) => {
          res.writeHead(200, { "content-type": "text/custom" });
          res.flushHeaders();
          return false;
        },
      },
    });
    const res = await fetch(`http://127.0.0.1:${port}/whatever`);
    // flushHeaders already committed status 200 + the custom content type;
    // the fallthrough sendJson could not override either.
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/custom");
    const body = await res.text();
    expect(body).toContain("NOT_FOUND");
  });

  describe("handleRpc error branches (fake req/res)", () => {
    function fakeRes() {
      return {
        headersSent: false,
        statusCode: 0,
        headers: {},
        body: null,
        setHeader(key, value) {
          this.headers[String(key).toLowerCase()] = value;
        },
        end(payload) {
          this.body = payload;
          this.headersSent = true;
        },
      };
    }
    function fakeReq(headers, iterate) {
      return { headers, [Symbol.asyncIterator]: iterate };
    }

    test("payload over the byte limit returns PAYLOAD_TOO_LARGE 413", async () => {
      const gw = new Gateway({ maxBodyBytes: 8 });
      const res = fakeRes();
      const req = fakeReq({}, async function* () {
        yield Buffer.from("x".repeat(64));
      });
      await gw.handleRpc(req, res);
      expect(res.statusCode).toBe(413);
      const json = JSON.parse(res.body);
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe("PAYLOAD_TOO_LARGE");
    });

    test("malformed JSON body returns INVALID_JSON 400", async () => {
      const gw = new Gateway();
      const res = fakeRes();
      const req = fakeReq({}, async function* () {
        yield Buffer.from("{ not valid");
      });
      await gw.handleRpc(req, res);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error.code).toBe("INVALID_JSON");
    });

    test("a non-syntax read failure returns SERVER_ERROR 500", async () => {
      const gw = new Gateway();
      const res = fakeRes();
      const req = fakeReq({ "x-request-id": "boom-1" }, async function* () {
        throw new Error("socket exploded");
      });
      await gw.handleRpc(req, res);
      expect(res.statusCode).toBe(500);
      const json = JSON.parse(res.body);
      expect(json.error.code).toBe("SERVER_ERROR");
      expect(json.error.message).toBe("socket exploded");
      expect(json.id).toBe("boom-1");
    });

    test("a thrown value without a message uses the fallback text", async () => {
      const gw = new Gateway();
      const res = fakeRes();
      const req = fakeReq({}, async function* () {
        // eslint-disable-next-line no-throw-literal
        throw { notAnError: true };
      });
      await gw.handleRpc(req, res);
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body).error.message).toBe("Gateway RPC failed");
    });

    test("multi-chunk body concatenates and parses successfully", async () => {
      const gw = new Gateway();
      const res = fakeRes();
      const req = fakeReq({}, async function* () {
        yield Buffer.from('{"method":');
        yield '"health"}'; // exercises the non-Buffer chunk branch
      });
      await gw.handleRpc(req, res);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).payload.protocol).toBe(1);
    });
  });
});
