/**
 * Server-side WebSocket authentication deadline (#1007).
 *
 * Gateway WS connections are registered (and hold a `maxConnections` slot)
 * as soon as the upgrade completes, but authentication only happens on the
 * `connect` RPC. A silent socket must be terminated once `authDeadlineMs`
 * elapses — releasing its slot for the next client — while a socket that
 * authenticates in time must survive the deadline, and every cleanup path
 * must clear the timer.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { WebSocket } from "ws";
import { Gateway } from "../src/gateway.js";

const TOKEN = "op-token";

const TOKEN_AUTH = {
    mode: "token",
    tokens: {
        [TOKEN]: {
            role: "operator",
            scopes: ["*"],
            userId: "user:test",
        },
    },
};

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
 * @param {() => boolean} predicate
 * @param {string} label
 * @param {number} [timeoutMs]
 */
async function waitUntil(predicate, label, timeoutMs = 5_000) {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > timeoutMs) {
            throw new Error(`Timed out waiting for ${label}`);
        }
        await sleep(10);
    }
}

/**
 * @param {number} port
 * @returns {Promise<WebSocket>}
 */
async function openSocket(port) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("error", () => {});
    await new Promise((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
    });
    return ws;
}

/**
 * Send a `connect` RPC over an open socket and return the response frame.
 * @param {WebSocket} ws
 * @param {string | null} token
 */
async function sendConnect(ws, token) {
    const id = `connect-${Math.random().toString(36).slice(2)}`;
    const response = new Promise((resolve, reject) => {
        const onMessage = (raw) => {
            const message = JSON.parse(String(raw));
            if (message.type === "res" && message.id === id) {
                ws.off("message", onMessage);
                resolve(message);
            }
        };
        ws.on("message", onMessage);
        ws.once("close", () => reject(new Error("Socket closed before connect response")));
    });
    ws.send(JSON.stringify({
        type: "req",
        id,
        method: "connect",
        params: {
            minProtocol: 1,
            maxProtocol: 1,
            client: { id: "ws-auth-deadline-test", version: "1.0.0", platform: "bun-test" },
            ...(token === null ? {} : { auth: { token } }),
        },
    }));
    return response;
}

/** @type {Gateway | undefined} */
let gateway;

afterEach(async () => {
    if (gateway) {
        await gateway.close();
        gateway = undefined;
    }
});

describe("gateway WS authentication deadline", () => {
    test("silent socket is terminated at the deadline, releasing its slot for an authenticated client", async () => {
        gateway = new Gateway({
            heartbeatMs: 100,
            maxConnections: 1,
            authDeadlineMs: 300,
            auth: TOKEN_AUTH,
        });
        const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        const port = getPort(server);

        // Occupy the single slot with a socket that never sends `connect`.
        const silent = await openSocket(port);
        expect(gateway.connections.size).toBe(1);
        const closed = new Promise((resolve) => silent.once("close", resolve));

        // The gateway must terminate the silent socket at the deadline and
        // release its slot — no client-side action of any kind.
        await closed;
        const g = gateway;
        await waitUntil(() => g.connections.size === 0, "silent socket slot release");

        // The freed slot must be usable by a subsequent authenticated client.
        const ws = await openSocket(port);
        const hello = await sendConnect(ws, TOKEN);
        expect(hello.ok).toBe(true);
        expect(hello.payload.auth.role).toBe("operator");
        expect(gateway.connections.size).toBe(1);
        expect([...gateway.connections][0].authenticated).toBe(true);
        ws.close();
    });

    test("socket that fails authentication is still terminated at the deadline", async () => {
        gateway = new Gateway({
            heartbeatMs: 100,
            authDeadlineMs: 300,
            auth: TOKEN_AUTH,
        });
        const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        const port = getPort(server);

        const ws = await openSocket(port);
        const closed = new Promise((resolve) => ws.once("close", resolve));
        const response = await sendConnect(ws, "wrong-token").catch(() => null);
        // The failed connect leaves the connection unauthenticated…
        if (response) {
            expect(response.ok).toBe(false);
        }
        // …so the deadline still evicts it.
        await closed;
        const g = gateway;
        await waitUntil(() => g.connections.size === 0, "failed-auth socket slot release");
    });

    test("socket that authenticates before the deadline survives it and clears the timer", async () => {
        gateway = new Gateway({
            heartbeatMs: 100,
            authDeadlineMs: 300,
            auth: TOKEN_AUTH,
        });
        const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        const port = getPort(server);

        const ws = await openSocket(port);
        const connection = [...gateway.connections][0];
        expect(connection.authDeadlineTimer).not.toBe(null);
        const hello = await sendConnect(ws, TOKEN);
        expect(hello.ok).toBe(true);
        // Successful auth clears the deadline…
        expect(connection.authDeadlineTimer).toBe(null);
        // …so the socket outlives it.
        await sleep(500);
        expect(ws.readyState).toBe(WebSocket.OPEN);
        expect(gateway.connections.size).toBe(1);
        ws.close();
    });

    test("client disconnect before authenticating clears the deadline timer", async () => {
        gateway = new Gateway({
            heartbeatMs: 100,
            authDeadlineMs: 60_000,
            auth: TOKEN_AUTH,
        });
        const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        const port = getPort(server);

        const ws = await openSocket(port);
        const connection = [...gateway.connections][0];
        expect(connection.authDeadlineTimer).not.toBe(null);
        ws.close();
        const g = gateway;
        await waitUntil(() => g.connections.size === 0, "unauthenticated socket cleanup");
        expect(connection.authDeadlineTimer).toBe(null);
    });
});
