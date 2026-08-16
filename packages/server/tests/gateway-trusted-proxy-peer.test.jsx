import { afterEach, describe, expect, test } from "bun:test";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { Gateway } from "../src/gateway.js";

/**
 * #785: in trusted-proxy mode the gateway authenticates from `x-user-id`,
 * `x-user-scopes`, `x-user-role`, and `x-smithers-token-id` headers, all of
 * which any client can set. It therefore honors them only when the IMMEDIATE
 * TRANSPORT PEER — `req.socket.remoteAddress`, the far end of the socket that
 * is connected to this process, never an `X-Forwarded-For` hop — matches the
 * configured `trustedProxies` boundary.
 *
 * These suites drive the real listener over real sockets (no mocked auth),
 * covering the HTTP RPC path and the WebSocket connect path, which
 * authenticate through different code, plus a Unix-domain listener and the
 * fail-closed startup behavior.
 */

/** @type {(() => unknown)[]} */
const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch {
      /* best effort */
    }
  }
});

const PROXY_HEADERS = {
  "x-user-id": "user:proxy",
  "x-user-scopes": "run:read",
  "x-user-role": "operator",
  "x-smithers-token-id": "proxy-token",
};

/**
 * @param {string[]} trustedProxies
 */
async function listenTcp(trustedProxies) {
  const gateway = new Gateway({
    protocol: 1,
    features: ["runs"],
    heartbeatMs: 100,
    auth: { mode: "trusted-proxy", trustedProxies },
  });
  const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
  cleanups.push(() => gateway.close());
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Gateway did not expose a port");
  }
  return { gateway, port: address.port };
}

/**
 * @param {number} port
 * @param {Record<string, string>} headers
 */
async function rpcOverTcp(port, headers) {
  const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ id: "rpc-1", method: "health", params: {} }),
  });
  return { status: response.status, body: await response.json() };
}

/**
 * `fetch` cannot address a Unix-domain socket portably, so drive the same
 * `POST /rpc` route through node:http with `socketPath`.
 * @param {string} socketPath
 * @param {Record<string, string>} headers
 */
function rpcOverUnix(socketPath, headers) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ id: "rpc-1", method: "health", params: {} });
    const req = httpRequest(
      {
        socketPath,
        path: "/rpc",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/**
 * Open a WebSocket and run the `connect` handshake, reporting whether the
 * socket even opened (a rejected upgrade never does) and the hello frame.
 * @param {number} port
 * @param {Record<string, string>} headers
 */
function wsConnect(port, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
    ws.on("error", () => {});
    let settled = false;
    /** @param {{ opened: boolean; hello?: unknown }} outcome */
    const finish = (outcome) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      resolve(outcome);
    };
    ws.once("close", () => finish({ opened: false }));
    ws.once("error", () => finish({ opened: false }));
    ws.once("open", () => {
      ws.send(
        JSON.stringify({
          type: "req",
          id: "connect-1",
          method: "connect",
          params: {
            minProtocol: 1,
            maxProtocol: 1,
            client: { id: "test-client", version: "1.0.0", platform: "bun-test" },
          },
        }),
      );
    });
    ws.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === "res" && message.id === "connect-1") {
        finish({ opened: true, hello: message });
      }
    });
    setTimeout(() => finish({ opened: false }), 5_000).unref?.();
  });
}

describe("gateway — trusted-proxy peer boundary over the real listener (#785)", () => {
  test("HTTP RPC: forged identity headers from an untrusted peer are rejected", async () => {
    // The listener is on loopback but loopback is NOT a configured proxy, so a
    // direct client is exactly the bypass path the issue describes.
    const { port } = await listenTcp(["10.4.0.0/24"]);
    const forged = await rpcOverTcp(port, { ...PROXY_HEADERS, "x-user-scopes": "*" });
    expect(forged.status).toBe(403);
    expect(forged.body.error?.code ?? forged.body.code).toBe("UNTRUSTED_PROXY_PEER");
    // An X-Forwarded-For claiming the trusted address must not help: the peer
    // is the transport peer, not a header-supplied address.
    const spoofed = await rpcOverTcp(port, { ...PROXY_HEADERS, "x-forwarded-for": "10.4.0.7" });
    expect(spoofed.status).toBe(403);
    expect(spoofed.body.error?.code ?? spoofed.body.code).toBe("UNTRUSTED_PROXY_PEER");
    // No credential at all is refused the same way; the mode has no anonymous
    // fallback that a rejected header set could quietly become.
    const anonymous = await rpcOverTcp(port, {});
    expect(anonymous.status).toBe(403);
  });

  test("HTTP RPC: the same headers are honored from a configured trusted peer", async () => {
    const { port } = await listenTcp(["127.0.0.1", "::1"]);
    const accepted = await rpcOverTcp(port, PROXY_HEADERS);
    expect(accepted.status).toBe(200);
    expect(accepted.body.ok).toBe(true);
  });

  test("WebSocket connect: an untrusted peer is refused at the upgrade", async () => {
    const { port } = await listenTcp(["10.4.0.0/24"]);
    const outcome = await wsConnect(port, { ...PROXY_HEADERS, "x-user-scopes": "*" });
    expect(outcome.opened).toBe(false);
  });

  test("WebSocket connect: a trusted peer authenticates with the proxied identity", async () => {
    const { port } = await listenTcp(["127.0.0.1", "::1"]);
    const outcome = await wsConnect(port, PROXY_HEADERS);
    expect(outcome.opened).toBe(true);
    expect(outcome.hello.ok).toBe(true);
    expect(outcome.hello.payload.auth.userId).toBe("user:proxy");
    expect(outcome.hello.payload.auth.role).toBe("operator");
    expect(outcome.hello.payload.auth.scopes).toEqual(["run:read"]);
    expect(outcome.hello.payload.auth.tokenId).toBe("proxy-token");
  });

  test("a Unix-domain listener trusts its peers only with an explicit 'unix' entry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-gateway-unix-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const socketPath = join(dir, "gateway.sock");
    const gateway = new Gateway({
      protocol: 1,
      features: ["runs"],
      heartbeatMs: 100,
      auth: { mode: "trusted-proxy", trustedProxies: ["unix"] },
    });
    await gateway.listen({ path: socketPath });
    cleanups.push(() => gateway.close());
    const accepted = await rpcOverUnix(socketPath, PROXY_HEADERS);
    expect(accepted.status).toBe(200);
    expect(accepted.body.ok).toBe(true);
  });
});

describe("gateway — trusted-proxy startup is fail-closed (#785)", () => {
  test("constructing trusted-proxy mode without a trust boundary throws", () => {
    expect(() => new Gateway({ auth: { mode: "trusted-proxy" } })).toThrow(/trustedProxies/);
    expect(() => new Gateway({ auth: { mode: "trusted-proxy", trustedProxies: [] } })).toThrow(/trustedProxies/);
    expect(() => new Gateway({ auth: { mode: "trusted-proxy", trustedProxies: ["10.0.0"] } })).toThrow(
      /trustedProxies/,
    );
  });

  test("a boundary that cannot apply to the bound socket fails the listen", async () => {
    const unixOnly = new Gateway({ auth: { mode: "trusted-proxy", trustedProxies: ["unix"] } });
    cleanups.push(() => unixOnly.close());
    await expect(unixOnly.listen({ port: 0, host: "127.0.0.1" })).rejects.toThrow(/peer IP or CIDR/);

    const dir = mkdtempSync(join(tmpdir(), "smithers-gateway-unix-mismatch-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const addressOnly = new Gateway({ auth: { mode: "trusted-proxy", trustedProxies: ["127.0.0.1"] } });
    cleanups.push(() => addressOnly.close());
    await expect(addressOnly.listen({ path: join(dir, "gateway.sock") })).rejects.toThrow(/must include "unix"/);
  });
});
