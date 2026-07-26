/**
 * Pre-auth websocket capacity isolation (#1008).
 *
 * Pre-authenticated sockets (upgraded but not yet past a successful `connect`)
 * are tracked separately from authenticated connections: they are bounded by
 * `maxPreAuthConnections` instead of consuming `maxConnections` slots, a
 * successful `connect` promotes them into authenticated capacity, and both
 * forms of accounting are released on close or failed authentication.
 *
 * All servers here are real Gateways listening on real sockets — no mocks.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { WebSocket } from "ws";
import { Gateway } from "../src/gateway.js";

/**
 * @param {import("node:http").Server} server
 * @returns {number}
 */
function getPort(server) {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Gateway did not expose a port");
  }
  return address.port;
}

/**
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll until `check` is true. Accounting updates ride on server-side socket
 * events, so size assertions after a close must wait for propagation.
 * @param {() => boolean} check
 */
async function waitUntil(check, timeoutMs = 5_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) {
      return;
    }
    await sleep(10);
  }
  throw new Error("Timed out waiting for condition");
}

/** Minimal RPC client over a raw websocket (mirrors gateway.test.jsx). */
class WsClient {
  ws;
  /** @type {Record<string, unknown>[]} */
  messages = [];
  /**
   * @param {WebSocket} ws
   */
  constructor(ws) {
    this.ws = ws;
    ws.on("message", (raw) => {
      this.messages.push(JSON.parse(String(raw)));
    });
  }
  /**
   * @param {(message: Record<string, unknown>) => boolean} predicate
   */
  async waitFor(predicate, timeoutMs = 5_000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const index = this.messages.findIndex(predicate);
      if (index >= 0) {
        return this.messages.splice(index, 1)[0];
      }
      await sleep(10);
    }
    throw new Error(`Timed out waiting for gateway message. Saw: ${JSON.stringify(this.messages)}`);
  }
  /**
   * @param {string} method
   * @param {unknown} [params]
   */
  async request(method, params) {
    const id = `${method}-${Math.random().toString(36).slice(2)}`;
    this.ws.send(JSON.stringify({ type: "req", id, method, params }));
    return this.waitFor((message) => message.type === "res" && message.id === id);
  }
}

/**
 * Open a websocket (no connect handshake yet) and wait for the upgrade. The
 * message listener is attached before returning so frames that arrive while
 * the test is busy elsewhere (e.g. the `connect.challenge` landing during a
 * second socket's handshake) are never dropped.
 * @param {number} port
 * @returns {Promise<WsClient>}
 */
async function openSocket(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const client = new WsClient(ws);
  await new Promise((resolve, reject) => {
    ws.once("open", () => resolve(undefined));
    ws.once("error", reject);
  });
  // Swallow late errors (e.g. server-side close) so they can't crash the suite.
  ws.on("error", () => {});
  return client;
}

/**
 * Attempt an upgrade and report whether the socket opened. A gateway that is
 * at capacity ends the socket with 503, which the client surfaces as a failed
 * connection rather than `open`.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function upgradeOpens(port) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("error", () => {});
    let settled = false;
    const finish = (opened) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        ws.close();
      } catch {}
      resolve(opened);
    };
    ws.once("open", () => finish(true));
    ws.once("error", () => finish(false));
    ws.once("close", () => finish(false));
    setTimeout(() => finish(false), 3_000);
  });
}

/**
 * Send the `connect` RPC on an already-open socket.
 * @param {WsClient} client
 * @param {string} [token]
 */
async function requestConnect(client, token) {
  await client.waitFor((message) => message.type === "event" && message.event === "connect.challenge");
  return client.request("connect", {
    minProtocol: 1,
    maxProtocol: 1,
    client: { id: "preauth-test", version: "1.0.0", platform: "bun-test" },
    ...(token !== undefined ? { auth: { token } } : {}),
  });
}

/**
 * @param {WebSocket} ws
 * @returns {Promise<number>} the close code
 */
function waitForClose(ws) {
  if (ws.readyState === ws.CLOSED) {
    return Promise.resolve(0);
  }
  return new Promise((resolve) => {
    ws.once("close", (code) => resolve(code));
  });
}

/** @type {Gateway | undefined} */
let gateway;
/** @type {WebSocket[]} */
let sockets = [];

/**
 * @param {ConstructorParameters<typeof Gateway>[0]} options
 */
async function startGateway(options) {
  gateway = new Gateway({ heartbeatMs: 100, ...options });
  const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
  return getPort(server);
}

afterEach(async () => {
  for (const ws of sockets) {
    try {
      ws.close();
    } catch {}
  }
  sockets = [];
  if (gateway) {
    await gateway.close();
    gateway = undefined;
  }
});

describe("pre-auth websocket capacity isolation (#1008)", () => {
  test("bare sockets are capped by maxPreAuthConnections and release their slot on close", async () => {
    const port = await startGateway({ maxConnections: 5, maxPreAuthConnections: 2 });

    // Two never-authenticating sockets fill the pre-auth pool without
    // touching authenticated capacity.
    const ws1 = (await openSocket(port)).ws;
    const ws2 = (await openSocket(port)).ws;
    sockets.push(ws1, ws2);
    await waitUntil(() => gateway.preAuthConnections.size === 2);
    expect(gateway.connections.size).toBe(2);
    expect(gateway.authenticatedConnectionCount()).toBe(0);

    // The pre-auth pool is full: a third upgrade is rejected even though
    // maxConnections (authenticated capacity) has 5 free slots.
    expect(await upgradeOpens(port)).toBe(false);
    expect(gateway.preAuthConnections.size).toBe(2);

    // Closing a pre-auth socket releases its slot and admits a new upgrade.
    ws1.close();
    await waitUntil(() => gateway.preAuthConnections.size === 1);
    expect(await upgradeOpens(port)).toBe(true);
  });

  test("a successful connect promotes the socket out of the pre-auth pool", async () => {
    const port = await startGateway({ maxConnections: 2, maxPreAuthConnections: 1 });

    const client1 = await openSocket(port);
    sockets.push(client1.ws);
    await waitUntil(() => gateway.preAuthConnections.size === 1);

    // Pre-auth pool full: no further upgrades while ws1 has not connected.
    expect(await upgradeOpens(port)).toBe(false);

    const hello = await requestConnect(client1);
    expect(hello.ok).toBe(true);

    // Promotion moved the socket into authenticated capacity and freed the
    // pre-auth slot for the next handshake.
    expect(gateway.preAuthConnections.size).toBe(0);
    expect(gateway.connections.size).toBe(1);
    expect(gateway.authenticatedConnectionCount()).toBe(1);
    expect(await upgradeOpens(port)).toBe(true);
  });

  test("promotion is refused when the authenticated pool is full", async () => {
    const port = await startGateway({ maxConnections: 1, maxPreAuthConnections: 2 });

    const client1 = await openSocket(port);
    const client2 = await openSocket(port);
    sockets.push(client1.ws, client2.ws);
    await waitUntil(() => gateway.preAuthConnections.size === 2);

    const hello1 = await requestConnect(client1);
    expect(hello1.ok).toBe(true);
    expect(gateway.authenticatedConnectionCount()).toBe(1);

    // The single authenticated slot is taken: ws2's connect is refused and
    // the gateway closes the socket so its pre-auth slot frees immediately.
    const closed2 = waitForClose(client2.ws);
    const hello2 = await requestConnect(client2);
    expect(hello2.ok).toBe(false);
    expect(hello2.error.code).toBe("CONNECTION_LIMIT");
    expect(await closed2).toBe(1013);
    await waitUntil(() => gateway.preAuthConnections.size === 0 && gateway.connections.size === 1);
    expect(gateway.authenticatedConnectionCount()).toBe(1);
  });

  test("failed authentication releases the pre-auth slot", async () => {
    const port = await startGateway({
      maxPreAuthConnections: 1,
      auth: {
        mode: "token",
        tokens: {
          "op-token": { role: "operator", scopes: ["*"], userId: "user:test" },
        },
      },
    });

    const client1 = await openSocket(port);
    sockets.push(client1.ws);
    await waitUntil(() => gateway.preAuthConnections.size === 1);

    // A bad token gets the error response, then the gateway closes the
    // socket — the client cannot camp on bounded pre-auth capacity.
    const closed1 = waitForClose(client1.ws);
    const hello1 = await requestConnect(client1, "wrong-token");
    expect(hello1.ok).toBe(false);
    expect(hello1.error.code).toBe("UNAUTHORIZED");
    expect(await closed1).toBe(1008);
    await waitUntil(() => gateway.preAuthConnections.size === 0 && gateway.connections.size === 0);

    // The released slot admits a fresh client, which can authenticate.
    const client2 = await openSocket(port);
    sockets.push(client2.ws);
    const hello2 = await requestConnect(client2, "op-token");
    expect(hello2.ok).toBe(true);
    expect(gateway.authenticatedConnectionCount()).toBe(1);
  });

  test("closing an authenticated connection releases authenticated capacity", async () => {
    const port = await startGateway({ maxConnections: 1, maxPreAuthConnections: 1 });

    const client1 = await openSocket(port);
    sockets.push(client1.ws);
    const hello1 = await requestConnect(client1);
    expect(hello1.ok).toBe(true);
    expect(gateway.authenticatedConnectionCount()).toBe(1);

    // Authenticated pool full: upgrades are turned away at the door.
    expect(await upgradeOpens(port)).toBe(false);

    client1.ws.close();
    await waitUntil(() => gateway.connections.size === 0);

    const client2 = await openSocket(port);
    sockets.push(client2.ws);
    const hello2 = await requestConnect(client2);
    expect(hello2.ok).toBe(true);
    expect(gateway.authenticatedConnectionCount()).toBe(1);
  });
});
