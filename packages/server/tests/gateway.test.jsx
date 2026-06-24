/** @jsxImportSource smithers-orchestrator */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { z } from "zod";
import { createSmithers } from "smithers-orchestrator";
import { Gateway } from "../src/gateway.js";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { sleep } from "../../smithers/tests/helpers.js";
/**
 * @param {Record<string, unknown>} value
 */
function base64UrlJson(value) {
    return Buffer.from(JSON.stringify(value)).toString("base64url");
}
/**
 * @param {Record<string, unknown>} payload
 * @param {string} secret
 * @param {Record<string, unknown>} [header]
 */
function createJwtToken(payload, secret, header = { alg: "HS256", typ: "JWT" }) {
    const encodedHeader = base64UrlJson(header);
    const encodedPayload = base64UrlJson(payload);
    const signature = createHmac("sha256", secret)
        .update(`${encodedHeader}.${encodedPayload}`)
        .digest("base64url");
    return `${encodedHeader}.${encodedPayload}.${signature}`;
}
/**
 * @param {Server} server
 * @returns {number}
 */
function getPort(server) {
    const addr = server.address();
    if (!addr || typeof addr === "string") {
        throw new Error("Gateway server did not expose a port");
    }
    return addr.port;
}
/**
 * @param {string} name
 */
function makeDbPath(name) {
    return join(tmpdir(), `smithers-gateway-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}
/**
 * @param {string} dbPath
 */
function createValueWorkflow(dbPath) {
    const { smithers, Workflow, Task, outputs } = createSmithers({
        outputA: z.object({ value: z.number() }),
    }, { dbPath });
    return smithers((ctx) => (<Workflow name="gateway-basic">
      <Task id="task1" output={outputs.outputA}>
        {{ value: Number(ctx.input.value ?? 1) }}
      </Task>
    </Workflow>));
}
/**
 * @param {string} dbPath
 */
function createSchemaInputValueWorkflow(dbPath) {
    const { smithers, Workflow, Task, outputs } = createSmithers({
        input: z.object({ value: z.number().optional() }),
        outputA: z.object({ value: z.number() }),
    }, { dbPath });
    return smithers((ctx) => (<Workflow name="gateway-basic">
      <Task id="task1" output={outputs.outputA}>
        {{ value: Number(ctx.input.value ?? 1) }}
      </Task>
    </Workflow>));
}
/**
 * @param {string} dbPath
 */
function createApprovalWorkflow(dbPath) {
    const api = createSmithers({
        selection: z.object({
            selected: z.string(),
            notes: z.string().nullable(),
        }),
        result: z.object({
            selected: z.string(),
        }),
    }, { dbPath });
    const workflow = api.smithers((ctx) => {
        const selection = ctx.outputMaybe("selection", { nodeId: "pick-plan" });
        return (<api.Workflow name="gateway-approval">
        <api.Sequence>
          <api.Approval id="pick-plan" mode="select" output={api.outputs.selection} request={{
                title: "Pick a plan",
                summary: "Choose the best option.",
            }} options={[
                { key: "light", label: "Light" },
                { key: "balanced", label: "Balanced" },
            ]} allowedScopes={["approve"]} allowedUsers={["user:will"]}/>
          {selection ? (<api.Task id="record" output={api.outputs.result}>
              {{ selected: selection.selected }}
            </api.Task>) : null}
        </api.Sequence>
      </api.Workflow>);
    });
    return { workflow, db: api.db, tables: api.tables };
}
/**
 * @param {string} dbPath
 */
function createAuthWorkflow(dbPath) {
    const api = createSmithers({
        authOutput: z.object({
            triggeredBy: z.string(),
            role: z.string(),
            scopes: z.array(z.string()),
        }),
    }, { dbPath });
    const workflow = api.smithers((ctx) => (<api.Workflow name="gateway-auth">
      <api.Task id="auth-task" output={api.outputs.authOutput}>
        {{
            triggeredBy: ctx.auth?.triggeredBy ?? "unknown",
            role: ctx.auth?.role ?? "unknown",
            scopes: ctx.auth?.scopes ?? [],
        }}
      </api.Task>
    </api.Workflow>));
    return { workflow, db: api.db, tables: api.tables };
}
/**
 * @param {string} dbPath
 */
function createSignalHostWorkflow(dbPath) {
    const api = createSmithers({
        done: z.object({ ok: z.boolean() }),
    }, { dbPath });
    const workflow = api.smithers(() => (<api.Workflow name="gateway-signal-host">
      <api.Task id="noop" output={api.outputs.done}>
        {{ ok: true }}
      </api.Task>
    </api.Workflow>));
    return { workflow, db: api.db };
}
/**
 * @param {string} dbPath
 * @param {string} runId
 */
function readValueOutput(dbPath, runId) {
    const db = new Database(dbPath, { readonly: true });
    try {
        return db
            .query("SELECT value FROM output_a WHERE run_id = ? AND node_id = 'task1' LIMIT 1")
            .get(runId)?.value;
    }
    finally {
        db.close();
    }
}
class GatewayClient {
    ws;
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
   * @param {(message: GatewayMessage) => boolean} predicate
   * @returns {Promise<GatewayMessage>}
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
        throw new Error(`Timed out waiting for gateway message. Saw: ${JSON.stringify(this.messages.map((message) => ({
            type: message.type,
            event: message.event,
            id: message.id,
            payload: message.payload,
        })))}`);
    }
    /**
   * @param {string} method
   * @param {unknown} [params]
   */
    async request(method, params) {
        const id = `${method}-${Math.random().toString(36).slice(2)}`;
        this.ws.send(JSON.stringify({
            type: "req",
            id,
            method,
            params,
        }));
        return this.waitFor((message) => message.type === "res" && message.id === id);
    }
    async close() {
        if (this.ws.readyState === this.ws.CLOSED) {
            return;
        }
        await new Promise((resolve) => {
            this.ws.once("close", () => resolve());
            this.ws.close();
        });
    }
}
/**
 * @param {number} port
 * @param {string} token
 */
async function connectGateway(port, token) {
    const { client, hello } = await connectGatewayRaw(port, { token });
    expect(hello.ok).toBe(true);
    return { client, hello };
}
/**
 * @param {number} port
 * @param {{ token?: string; headers?: Record<string, string> }} [options]
 */
async function connectGatewayRaw(port, options = {}) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: options.headers,
    });
    await new Promise((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
    });
    const client = new GatewayClient(ws);
    const challenge = await client.waitFor((message) => message.type === "event" && message.event === "connect.challenge");
    expect(challenge.payload.nonce).toBeDefined();
    const hello = await client.request("connect", {
        minProtocol: 1,
        maxProtocol: 1,
        client: {
            id: "test-client",
            version: "1.0.0",
            platform: "bun-test",
        },
        ...(options.token !== undefined ? { auth: { token: options.token } } : {}),
    });
    return { client, hello };
}
/**
 * Attempt a bare WebSocket upgrade (no connect handshake) and report whether the
 * socket actually opened. A gateway that rejects the Origin at the upgrade ends
 * the socket with `403`, which the client surfaces as a failed connection rather
 * than `open`. (We assert non-open rather than the 403 status line because bun's
 * client does not deliver the raw upgrade-rejection body.) (#446)
 * @param {number} port
 * @param {Record<string, string>} [headers]
 * @returns {Promise<boolean>}
 */
function wsConnectionOpens(port, headers) {
    return new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
        // Swallow late errors so a post-resolution `error` can't crash the suite.
        ws.on("error", () => {});
        let settled = false;
        const finish = (opened) => {
            if (settled) {
                return;
            }
            settled = true;
            try {
                ws.close();
            }
            catch {
                /* already closing */
            }
            resolve(opened);
        };
        ws.once("open", () => finish(true));
        ws.once("error", () => finish(false));
        ws.once("close", () => finish(false));
    });
}
/**
 * @param {GatewayClient} client
 * @param {string} runId
 * @param {string[]} statuses
 */
async function waitForRunStatus(client, runId, statuses, timeoutMs = 5_000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const response = await client.request("runs.get", { runId });
        if (response.ok && statuses.includes(response.payload.status)) {
            return response.payload;
        }
        await sleep(25);
    }
    throw new Error(`Timed out waiting for run ${runId} to reach ${statuses.join(", ")}`);
}
describe("Gateway", () => {
    let gateway;
    let server;
    let dbPaths = [];
    beforeEach(() => {
        dbPaths = [];
    });
    afterEach(async () => {
        if (gateway) {
            await gateway.close();
        }
        for (const dbPath of dbPaths) {
            try {
                rmSync(dbPath, { force: true });
                rmSync(`${dbPath}-shm`, { force: true });
                rmSync(`${dbPath}-wal`, { force: true });
            }
            catch { }
        }
        gateway = undefined;
        server = undefined;
        dbPaths = [];
    });
    test("performs the connect handshake, enforces scopes, and exposes health", async () => {
        const dbPath = makeDbPath("token");
        dbPaths.push(dbPath);
        gateway = new Gateway({
            protocol: 1,
            features: ["approvals", "streaming", "runs"],
            heartbeatMs: 100,
            auth: {
                mode: "token",
                tokens: {
                    "op-token": {
                        role: "operator",
                        scopes: ["*"],
                        userId: "user:will",
                    },
                    "viewer-token": {
                        role: "viewer",
                        scopes: ["health", "runs.list", "runs.get"],
                        userId: "user:viewer",
                    },
                },
            },
        });
        gateway.register("basic", createValueWorkflow(dbPath));
        server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        const port = getPort(server);
        const { client: operator, hello } = await connectGateway(port, "op-token");
        expect(hello.payload.protocol).toBe(1);
        expect(hello.payload.snapshot.runs).toEqual([]);
        expect(hello.payload.snapshot.approvals).toEqual([]);
        expect(hello.payload.auth.userId).toBe("user:will");
        const { client: viewer } = await connectGateway(port, "viewer-token");
        const health = await viewer.request("health");
        expect(health.ok).toBe(true);
        expect(health.payload.protocol).toBe(1);
        expect(health.payload.features).toEqual(["approvals", "streaming", "runs"]);
        const forbidden = await viewer.request("runs.create", {
            workflow: "basic",
            input: { value: 2 },
        });
        expect(forbidden.ok).toBe(false);
        expect(forbidden.error.code).toBe("FORBIDDEN");
        await operator.close();
        await viewer.close();
    });
    test("rejects revoked token grants during the connect handshake", async () => {
        const dbPath = makeDbPath("token-revoked");
        dbPaths.push(dbPath);
        gateway = new Gateway({
            protocol: 1,
            features: ["runs"],
            heartbeatMs: 100,
            auth: {
                mode: "token",
                tokens: {
                    "revoked-token": {
                        role: "operator",
                        scopes: ["*"],
                        userId: "user:revoked",
                        revokedAtMs: Date.now() - 1_000,
                    },
                    "future-revoked-token": {
                        role: "operator",
                        scopes: ["*"],
                        userId: "user:still-valid",
                        revokedAtMs: Date.now() + 60_000,
                    },
                },
            },
        });
        gateway.register("basic", createValueWorkflow(dbPath));
        server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        const port = getPort(server);

        const rejected = await connectGatewayRaw(port, { token: "revoked-token" });
        expect(rejected.hello.ok).toBe(false);
        expect(rejected.hello.error.code).toBe("UNAUTHORIZED");
        expect(rejected.hello.error.message).toContain("revoked");
        await rejected.client.close();

        const accepted = await connectGatewayRaw(port, { token: "future-revoked-token" });
        expect(accepted.hello.ok).toBe(true);
        expect(accepted.hello.payload.auth.userId).toBe("user:still-valid");
        await accepted.client.close();
    });
    test("validates JWT connect tokens and extracts auth claims", async () => {
        const dbPath = makeDbPath("jwt");
        dbPaths.push(dbPath);
        const secret = "super-secret";
        gateway = new Gateway({
            protocol: 1,
            features: ["runs"],
            heartbeatMs: 100,
            auth: {
                mode: "jwt",
                issuer: "https://auth.example.com",
                audience: "smithers",
                secret,
                scopesClaim: "permissions",
            },
        });
        gateway.register("basic", createValueWorkflow(dbPath));
        server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        const port = getPort(server);
        const validToken = createJwtToken({
            iss: "https://auth.example.com",
            aud: "smithers",
            sub: "user:jwt",
            role: "operator",
            permissions: ["runs.create", "runs.get"],
            exp: Math.floor(Date.now() / 1_000) + 300,
        }, secret);
        const { client, hello } = await connectGateway(port, validToken);
        expect(hello.payload.auth.userId).toBe("user:jwt");
        expect(hello.payload.auth.role).toBe("operator");
        expect(hello.payload.auth.scopes).toEqual(["runs.create", "runs.get"]);
        const created = await client.request("runs.create", {
            workflow: "basic",
            input: { value: 4 },
        });
        expect(created.ok).toBe(true);
        await waitForRunStatus(client, created.payload.runId, ["finished"]);
        const invalidAudienceToken = createJwtToken({
            iss: "https://auth.example.com",
            aud: "other-service",
            sub: "user:jwt",
            permissions: ["runs.create"],
            exp: Math.floor(Date.now() / 1_000) + 300,
        }, secret);
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        await new Promise((resolve, reject) => {
            ws.once("open", () => resolve());
            ws.once("error", reject);
        });
        const rejected = new GatewayClient(ws);
        await rejected.waitFor((message) => message.type === "event" && message.event === "connect.challenge");
        const helloRejected = await rejected.request("connect", {
            minProtocol: 1,
            maxProtocol: 1,
            client: {
                id: "jwt-client",
                version: "1.0.0",
                platform: "bun-test",
            },
            auth: { token: invalidAudienceToken },
        });
        expect(helloRejected.ok).toBe(false);
        expect(helloRejected.error.code).toBe("UNAUTHORIZED");
        await client.close();
        await rejected.close();
    });
    test("rejects JWT algorithm confusion, tampering, wrong issuer, and future nbf", async () => {
        const dbPath = makeDbPath("jwt-rejects");
        dbPaths.push(dbPath);
        const secret = "super-secret";
        gateway = new Gateway({
            protocol: 1,
            features: ["runs"],
            heartbeatMs: 100,
            auth: {
                mode: "jwt",
                issuer: "https://auth.example.com",
                audience: "smithers",
                secret,
                scopesClaim: "permissions",
                clockSkewSeconds: 0,
            },
        });
        gateway.register("basic", createValueWorkflow(dbPath));
        server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        const port = getPort(server);
        const basePayload = {
            iss: "https://auth.example.com",
            aud: "smithers",
            sub: "user:jwt",
            permissions: ["runs.create"],
            exp: Math.floor(Date.now() / 1_000) + 300,
        };
        const valid = createJwtToken(basePayload, secret);
        const cases = [
            {
                token: createJwtToken(basePayload, secret, { alg: "none", typ: "JWT" }),
                message: "algorithm",
            },
            {
                token: `${valid.slice(0, -1)}${valid.endsWith("a") ? "b" : "a"}`,
                message: "signature",
            },
            {
                token: createJwtToken({ ...basePayload, iss: "https://evil.example.com" }, secret),
                message: "issuer",
            },
            {
                token: createJwtToken({ ...basePayload, nbf: Math.floor(Date.now() / 1_000) + 3_600 }, secret),
                message: "not active",
            },
        ];

        for (const jwtCase of cases) {
            const { client, hello } = await connectGatewayRaw(port, { token: jwtCase.token });
            expect(hello.ok).toBe(false);
            expect(hello.error.code).toBe("UNAUTHORIZED");
            expect(hello.error.message.toLowerCase()).toContain(jwtCase.message);
            await client.close();
        }
    });
    test("trusted-proxy mode enforces allowed origins and maps trusted headers", async () => {
        const dbPath = makeDbPath("trusted-proxy");
        dbPaths.push(dbPath);
        gateway = new Gateway({
            protocol: 1,
            features: ["runs"],
            heartbeatMs: 100,
            auth: {
                mode: "trusted-proxy",
                allowedOrigins: ["https://app.example.com"],
                trustedHeaders: ["x-user-id", "x-user-scopes", "x-user-role"],
                defaultRole: "viewer",
                defaultScopes: ["run:read"],
            },
        });
        gateway.register("basic", createValueWorkflow(dbPath));
        server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        const port = getPort(server);

        // Disallowed Origin is rejected at the WS upgrade itself — the socket
        // never opens (#446).
        const evilOpens = await wsConnectionOpens(port, {
            Origin: "https://evil.example.com",
            "x-user-id": "user:proxy",
            "x-user-scopes": "run:read",
        });
        expect(evilOpens).toBe(false);

        const accepted = await connectGatewayRaw(port, {
            headers: {
                Origin: "https://app.example.com",
                "x-user-id": "user:proxy",
                "x-user-scopes": "run:read approval:submit",
                "x-user-role": "operator",
                "x-smithers-token-id": "proxy-token",
            },
        });
        expect(accepted.hello.ok).toBe(true);
        expect(accepted.hello.payload.auth.userId).toBe("user:proxy");
        expect(accepted.hello.payload.auth.role).toBe("operator");
        expect(accepted.hello.payload.auth.scopes).toEqual(["run:read", "approval:submit"]);
        expect(accepted.hello.payload.auth.tokenId).toBe("proxy-token");
        await accepted.client.close();

        const defaulted = await connectGatewayRaw(port, {
            headers: {
                Origin: "https://app.example.com",
                "x-user-id": "user:defaulted",
            },
        });
        expect(defaulted.hello.ok).toBe(true);
        expect(defaulted.hello.payload.auth.role).toBe("viewer");
        expect(defaulted.hello.payload.auth.scopes).toEqual(["run:read"]);
        await defaulted.client.close();
    });
    test("token mode enforces allowedOrigins on the WS upgrade path (#446)", async () => {
        const dbPath = makeDbPath("token-origin-ws");
        dbPaths.push(dbPath);
        gateway = new Gateway({
            protocol: 1,
            features: ["runs"],
            heartbeatMs: 100,
            auth: {
                mode: "token",
                allowedOrigins: ["https://app.example.com"],
                tokens: {
                    "op-token": { role: "operator", scopes: ["*"], userId: "user:op" },
                },
            },
        });
        gateway.register("basic", createValueWorkflow(dbPath));
        server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        const port = getPort(server);

        // Disallowed Origin → rejected at the WS upgrade; the socket never opens,
        // even with a valid token.
        const evilOpens = await wsConnectionOpens(port, { Origin: "https://evil.example.com" });
        expect(evilOpens).toBe(false);

        // Allowed Origin → accepted.
        const accepted = await connectGatewayRaw(port, {
            token: "op-token",
            headers: { Origin: "https://app.example.com" },
        });
        expect(accepted.hello.ok).toBe(true);
        await accepted.client.close();

        // No Origin header (server-to-server / CLI) → allowed.
        const noOrigin = await connectGatewayRaw(port, { token: "op-token" });
        expect(noOrigin.hello.ok).toBe(true);
        await noOrigin.client.close();
    });
    test("token mode enforces allowedOrigins on the HTTP /rpc path (#446)", async () => {
        const dbPath = makeDbPath("token-origin-http");
        dbPaths.push(dbPath);
        gateway = new Gateway({
            protocol: 1,
            features: ["runs"],
            heartbeatMs: 100,
            auth: {
                mode: "token",
                allowedOrigins: ["https://app.example.com"],
                tokens: {
                    "op-token": { role: "operator", scopes: ["*"], userId: "user:op" },
                },
            },
        });
        gateway.register("basic", createValueWorkflow(dbPath));
        server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        const port = getPort(server);

        const rpc = (origin) => fetch(`http://127.0.0.1:${port}/rpc`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: "Bearer op-token",
                ...(origin ? { origin } : {}),
            },
            body: JSON.stringify({ method: "runs.list", params: {} }),
        });

        const rejected = await rpc("https://evil.example.com");
        expect(rejected.status).toBe(401);
        const rejectedBody = await rejected.json();
        expect(rejectedBody.ok).toBe(false);
        expect(rejectedBody.error.code).toBe("UNAUTHORIZED");
        expect(rejectedBody.error.message).toContain("Origin");

        const accepted = await rpc("https://app.example.com");
        expect(accepted.status).toBe(200);
        expect((await accepted.json()).ok).toBe(true);

        // No Origin header → allowed.
        const noOrigin = await rpc(undefined);
        expect(noOrigin.status).toBe(200);
        expect((await noOrigin.json()).ok).toBe(true);
    });
    test("jwt mode enforces allowedOrigins, and unset allows any Origin (#446)", async () => {
        const secret = "super-secret-origin";
        const payload = {
            iss: "https://auth.example.com",
            aud: "smithers",
            sub: "user:jwt",
            scope: "runs.list",
            exp: Math.floor(Date.now() / 1_000) + 300,
        };
        const token = createJwtToken(payload, secret);
        const jwtAuth = (allowedOrigins) => ({
            mode: "jwt",
            issuer: "https://auth.example.com",
            audience: "smithers",
            secret,
            ...(allowedOrigins ? { allowedOrigins } : {}),
        });

        // (a) allow-list configured → non-matching Origin rejected, matching accepted.
        const dbPath = makeDbPath("jwt-origin");
        dbPaths.push(dbPath);
        gateway = new Gateway({
            protocol: 1,
            features: ["runs"],
            heartbeatMs: 100,
            auth: jwtAuth(["https://app.example.com"]),
        });
        gateway.register("basic", createValueWorkflow(dbPath));
        server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        let port = getPort(server);

        const evilOpens = await wsConnectionOpens(port, { Origin: "https://evil.example.com" });
        expect(evilOpens).toBe(false);

        const accepted = await connectGatewayRaw(port, {
            token,
            headers: { Origin: "https://app.example.com" },
        });
        expect(accepted.hello.ok).toBe(true);
        await accepted.client.close();
        await gateway.close();

        // (b) no allow-list → any Origin accepted (unchanged behavior).
        const dbPath2 = makeDbPath("jwt-origin-unset");
        dbPaths.push(dbPath2);
        gateway = new Gateway({
            protocol: 1,
            features: ["runs"],
            heartbeatMs: 100,
            auth: jwtAuth(undefined),
        });
        gateway.register("basic", createValueWorkflow(dbPath2));
        server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        port = getPort(server);
        const anyOrigin = await connectGatewayRaw(port, {
            token,
            headers: { Origin: "https://anywhere.example.com" },
        });
        expect(anyOrigin.hello.ok).toBe(true);
        await anyOrigin.client.close();
    });
    test("token mode enforces allowedOrigins over both HTTP and WS", async () => {
        const dbPath = makeDbPath("token-origin");
        dbPaths.push(dbPath);
        gateway = new Gateway({
            protocol: 1,
            features: ["runs"],
            heartbeatMs: 100,
            auth: {
                mode: "token",
                tokens: {
                    "op-token": {
                        role: "operator",
                        scopes: ["*"],
                        userId: "user:op",
                    },
                },
                allowedOrigins: ["https://app.example.com"],
            },
        });
        gateway.register("basic", createValueWorkflow(dbPath));
        server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        const port = getPort(server);

        // WS: wrong origin rejected at the upgrade itself (socket never opens).
        expect(await wsConnectionOpens(port, { Origin: "https://evil.example.com" })).toBe(false);

        // WS: correct origin accepted
        const wsAccepted = await connectGatewayRaw(port, {
            token: "op-token",
            headers: { Origin: "https://app.example.com" },
        });
        expect(wsAccepted.hello.ok).toBe(true);
        await wsAccepted.client.close();

        // WS: no Origin header accepted (server-to-server / CLI)
        const wsNoOrigin = await connectGatewayRaw(port, { token: "op-token" });
        expect(wsNoOrigin.hello.ok).toBe(true);
        await wsNoOrigin.client.close();

        // HTTP RPC: wrong origin rejected
        const httpRejected = await fetch(`http://127.0.0.1:${port}/rpc`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: "Bearer op-token",
                Origin: "https://evil.example.com",
            },
            body: JSON.stringify({ method: "runs.list", params: {} }),
        });
        expect(httpRejected.status).toBe(401);
        const rejBody = await httpRejected.json();
        expect(rejBody.ok).toBe(false);
        expect(rejBody.error.code).toBe("UNAUTHORIZED");

        // HTTP RPC: correct origin accepted
        const httpAccepted = await fetch(`http://127.0.0.1:${port}/rpc`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: "Bearer op-token",
                Origin: "https://app.example.com",
            },
            body: JSON.stringify({ method: "runs.list", params: {} }),
        });
        expect(httpAccepted.status).toBe(200);

        // HTTP RPC: no Origin header accepted (CLI / server-to-server)
        const httpNoOrigin = await fetch(`http://127.0.0.1:${port}/rpc`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: "Bearer op-token",
            },
            body: JSON.stringify({ method: "runs.list", params: {} }),
        });
        expect(httpNoOrigin.status).toBe(200);

        // Token mode without allowedOrigins: any origin allowed
        await gateway.close();
        const dbPath2 = makeDbPath("token-any-origin");
        dbPaths.push(dbPath2);
        gateway = new Gateway({
            protocol: 1,
            features: ["runs"],
            heartbeatMs: 100,
            auth: {
                mode: "token",
                tokens: {
                    "op-token": {
                        role: "operator",
                        scopes: ["*"],
                        userId: "user:op",
                    },
                },
            },
        });
        gateway.register("basic", createValueWorkflow(dbPath2));
        server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        const port2 = getPort(server);
        const wsAny = await connectGatewayRaw(port2, {
            token: "op-token",
            headers: { Origin: "https://any.example.com" },
        });
        expect(wsAny.hello.ok).toBe(true);
        await wsAny.client.close();
    });
    test("jwt mode enforces allowedOrigins over both HTTP and WS", async () => {
        const dbPath = makeDbPath("jwt-origin");
        dbPaths.push(dbPath);
        const jwtSecret = "test-origin-secret";
        const validToken = createJwtToken({
            iss: "https://auth.example.com",
            aud: "smithers",
            sub: "user:jwt",
            role: "operator",
            scope: "*",
            exp: Math.floor(Date.now() / 1_000) + 300,
        }, jwtSecret);
        gateway = new Gateway({
            protocol: 1,
            features: ["runs"],
            heartbeatMs: 100,
            auth: {
                mode: "jwt",
                issuer: "https://auth.example.com",
                audience: "smithers",
                secret: jwtSecret,
                allowedOrigins: ["https://app.example.com"],
            },
        });
        gateway.register("basic", createValueWorkflow(dbPath));
        server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        const port = getPort(server);

        // WS: wrong origin rejected at the upgrade itself (socket never opens).
        expect(await wsConnectionOpens(port, { Origin: "https://evil.example.com" })).toBe(false);

        // WS: correct origin accepted
        const wsAccepted = await connectGatewayRaw(port, {
            token: validToken,
            headers: { Origin: "https://app.example.com" },
        });
        expect(wsAccepted.hello.ok).toBe(true);
        await wsAccepted.client.close();

        // WS: no Origin header accepted (server-to-server / CLI)
        const wsNoOrigin = await connectGatewayRaw(port, { token: validToken });
        expect(wsNoOrigin.hello.ok).toBe(true);
        await wsNoOrigin.client.close();

        // HTTP RPC: wrong origin rejected
        const httpRejected = await fetch(`http://127.0.0.1:${port}/rpc`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: `Bearer ${validToken}`,
                Origin: "https://evil.example.com",
            },
            body: JSON.stringify({ method: "runs.list", params: {} }),
        });
        expect(httpRejected.status).toBe(401);
        const rejBody = await httpRejected.json();
        expect(rejBody.ok).toBe(false);
        expect(rejBody.error.code).toBe("UNAUTHORIZED");

        // HTTP RPC: correct origin accepted
        const httpAccepted = await fetch(`http://127.0.0.1:${port}/rpc`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: `Bearer ${validToken}`,
                Origin: "https://app.example.com",
            },
            body: JSON.stringify({ method: "runs.list", params: {} }),
        });
        expect(httpAccepted.status).toBe(200);

        // HTTP RPC: no Origin header accepted (CLI / server-to-server)
        const httpNoOrigin = await fetch(`http://127.0.0.1:${port}/rpc`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: `Bearer ${validToken}`,
            },
            body: JSON.stringify({ method: "runs.list", params: {} }),
        });
        expect(httpNoOrigin.status).toBe(200);
    });
    test("supports HTTP /rpc fallback for stateless callers", async () => {
        const dbPath = makeDbPath("http-rpc");
        dbPaths.push(dbPath);
        gateway = new Gateway({
            protocol: 1,
            features: ["runs"],
            heartbeatMs: 100,
            auth: {
                mode: "token",
                tokens: {
                    "op-token": {
                        role: "operator",
                        scopes: ["*"],
                        userId: "user:http",
                    },
                },
            },
        });
        gateway.register("basic", createValueWorkflow(dbPath));
        server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        const port = getPort(server);
        const createRes = await fetch(`http://127.0.0.1:${port}/rpc`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: "Bearer op-token",
            },
            body: JSON.stringify({
                method: "runs.create",
                params: {
                    workflow: "basic",
                    input: { value: 12 },
                },
            }),
        });
        expect(createRes.status).toBe(200);
        const created = await createRes.json();
        expect(created.ok).toBe(true);
        const runId = created.payload.runId;
        let run = null;
        for (let attempt = 0; attempt < 50; attempt += 1) {
            const runRes = await fetch(`http://127.0.0.1:${port}/rpc`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-smithers-key": "op-token",
                },
                body: JSON.stringify({
                    method: "runs.get",
                    params: { runId },
                }),
            });
            const payload = await runRes.json();
            if (runRes.status === 404) {
                await sleep(25);
                continue;
            }
            expect(runRes.status).toBe(200);
            expect(payload.ok).toBe(true);
            run = payload.payload;
            if (run?.status === "finished") {
                break;
            }
            await sleep(25);
        }
        expect(run?.status).toBe("finished");
        expect(run?.workflowKey).toBe("basic");
    });
    test("creates runs, streams gateway events, and exposes frames, attempts, and diffs", async () => {
        const dbPath = makeDbPath("basic");
        dbPaths.push(dbPath);
        gateway = new Gateway({
            protocol: 1,
            features: ["approvals", "streaming", "runs"],
            heartbeatMs: 100,
            auth: {
                mode: "token",
                tokens: {
                    "op-token": {
                        role: "operator",
                        scopes: ["*"],
                        userId: "user:will",
                    },
                },
            },
        });
        gateway.register("basic", createValueWorkflow(dbPath));
        server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        const port = getPort(server);
        const { client } = await connectGateway(port, "op-token");
        const first = await client.request("runs.create", {
            workflow: "basic",
            input: { value: 2 },
        });
        expect(first.ok).toBe(true);
        const runId = first.payload.runId;
        expect(typeof runId).toBe("string");
        const nodeEvent = await client.waitFor((message) => message.type === "event" &&
            (message.event === "node.started" || message.event === "node.finished") &&
            message.payload.runId === runId);
        const runCompleted = await client.waitFor((message) => message.type === "event" &&
            message.event === "run.completed" &&
            message.payload.runId === runId);
        expect(nodeEvent.seq).toBeLessThan(runCompleted.seq);
        expect(nodeEvent.stateVersion).toBeLessThan(runCompleted.stateVersion);
        const run = await client.request("runs.get", { runId });
        expect(run.ok).toBe(true);
        expect(run.payload.runId).toBe(runId);
        expect(run.payload.status).toBe("finished");
        const runs = await client.request("runs.list", { limit: 10 });
        expect(runs.ok).toBe(true);
        expect(runs.payload.some((entry) => entry.runId === runId)).toBe(true);
        const frames = await client.request("frames.list", { runId, limit: 10 });
        expect(frames.ok).toBe(true);
        expect(frames.payload.length).toBeGreaterThan(0);
        const frame = await client.request("frames.get", { runId });
        expect(frame.ok).toBe(true);
        expect(frame.payload.runId).toBe(runId);
        expect(frame.payload.frameNo).toBeGreaterThan(0);
        const attempts = await client.request("attempts.list", { runId });
        expect(attempts.ok).toBe(true);
        expect(attempts.payload.length).toBeGreaterThan(0);
        const attempt = await client.request("attempts.get", {
            runId,
            nodeId: "task1",
            iteration: 0,
            attempt: 1,
        });
        expect(attempt.ok).toBe(true);
        expect(attempt.payload.runId).toBe(runId);
        expect(attempt.payload.nodeId).toBe("task1");
        const second = await client.request("runs.create", {
            workflow: "basic",
            input: { value: 7 },
        });
        const secondRunId = second.payload.runId;
        await waitForRunStatus(client, secondRunId, ["finished"]);
        const diff = await client.request("runs.diff", {
            leftRunId: runId,
            rightRunId: secondRunId,
        });
        expect(diff.ok).toBe(true);
        expect(diff.payload.outputsChanged.length).toBeGreaterThan(0);
        await client.close();
    });
    test("reruns with the original schema-backed input row", async () => {
        const dbPath = makeDbPath("rerun-input");
        dbPaths.push(dbPath);
        gateway = new Gateway({
            protocol: 1,
            features: ["runs"],
            heartbeatMs: 100,
            auth: {
                mode: "token",
                tokens: {
                    "op-token": {
                        role: "operator",
                        scopes: ["*"],
                        userId: "user:will",
                    },
                },
            },
        });
        gateway.register("basic", createSchemaInputValueWorkflow(dbPath));
        server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        const port = getPort(server);
        const { client } = await connectGateway(port, "op-token");
        const first = await client.request("runs.create", {
            workflow: "basic",
            input: { value: 42 },
        });
        expect(first.ok).toBe(true);
        const sourceRunId = first.payload.runId;
        await waitForRunStatus(client, sourceRunId, ["finished"]);
        const rerun = await client.request("runs.rerun", {
            runId: sourceRunId,
            newRunId: "rerun-schema-input",
        });
        expect(rerun.ok).toBe(true);
        await waitForRunStatus(client, "rerun-schema-input", ["finished"]);
        const output = await client.request("getNodeOutput", {
            runId: "rerun-schema-input",
            nodeId: "task1",
            iteration: 0,
        });
        expect(output.ok).toBe(true);
        expect(output.payload.row).toMatchObject({ value: 42 });
        await client.close();
    });
    test("enforces approval-level scopes/users and returns rich pending approval metadata", async () => {
        const dbPath = makeDbPath("approval");
        dbPaths.push(dbPath);
        const approval = createApprovalWorkflow(dbPath);
        gateway = new Gateway({
            protocol: 1,
            features: ["approvals", "streaming", "runs", "cron"],
            heartbeatMs: 100,
            auth: {
                mode: "token",
                tokens: {
                    "operator-token": {
                        role: "operator",
                        scopes: ["*"],
                        userId: "user:operator",
                    },
                    "approver-token": {
                        role: "approver",
                        scopes: ["approve", "approvals.list", "runs.get"],
                        userId: "user:will",
                    },
                    "blocked-token": {
                        role: "approver",
                        scopes: ["approve", "approvals.list", "runs.get"],
                        userId: "user:blocked",
                    },
                },
            },
        });
        gateway.register("approval", approval.workflow);
        server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        const port = getPort(server);
        const { client: operator } = await connectGateway(port, "operator-token");
        const create = await operator.request("runs.create", {
            workflow: "approval",
            input: {},
        });
        expect(create.ok).toBe(true);
        const runId = create.payload.runId;
        await operator.waitFor((message) => message.type === "event" &&
            message.event === "approval.requested" &&
            message.payload.runId === runId);
        const approvals = await operator.request("approvals.list");
        expect(approvals.ok).toBe(true);
        expect(approvals.payload).toEqual([
            expect.objectContaining({
                workflowKey: "approval",
                runId,
                nodeId: "pick-plan",
                requestTitle: "Pick a plan",
                requestSummary: "Choose the best option.",
                approvalMode: "select",
                allowedScopes: ["approve"],
                allowedUsers: ["user:will"],
                options: [
                    { key: "light", label: "Light" },
                    { key: "balanced", label: "Balanced" },
                ],
            }),
        ]);
        const stableApprovals = await operator.request("listApprovals", {
            filter: { workflow: "approval", limit: 1 },
        });
        expect(stableApprovals.ok).toBe(true);
        expect(stableApprovals.payload).toEqual([
            expect.objectContaining({
                workflowKey: "approval",
                runId,
                nodeId: "pick-plan",
            }),
        ]);
        const { client: blocked } = await connectGateway(port, "blocked-token");
        const forbidden = await blocked.request("approvals.decide", {
            runId,
            nodeId: "pick-plan",
            iteration: 0,
            approved: true,
            decision: {
                selected: "balanced",
                notes: "best fit",
            },
        });
        expect(forbidden.ok).toBe(false);
        expect(forbidden.error.code).toBe("FORBIDDEN");
        const { client: approver } = await connectGateway(port, "approver-token");
        const decided = await approver.request("approvals.decide", {
            runId,
            nodeId: "pick-plan",
            iteration: 0,
            approved: true,
            decision: {
                selected: "balanced",
                notes: "best fit",
            },
        });
        expect(decided.ok).toBe(true);
        const duplicate = await approver.request("approvals.decide", {
            runId,
            nodeId: "pick-plan",
            iteration: 0,
            approved: true,
            decision: {
                selected: "balanced",
                notes: "best fit",
            },
        });
        expect(duplicate.ok).toBe(false);
        expect(duplicate.error.code).toBe("AlreadyDecided");
        const completed = await operator.waitFor((message) => message.type === "event" &&
            message.event === "run.completed" &&
            message.payload.runId === runId);
        expect(completed.payload.status).toBe("finished");
        const adapter = new SmithersDb(approval.db);
        const approvalRow = await adapter.getApproval(runId, "pick-plan", 0);
        expect(approvalRow?.decisionJson).toEqual(JSON.stringify({ selected: "balanced", notes: "best fit" }));
        await operator.close();
        await blocked.close();
        await approver.close();
    });
    test("rejects non-boolean approvals.decide approved values", async () => {
        const dbPath = makeDbPath("approval-invalid-approved");
        dbPaths.push(dbPath);
        const approval = createApprovalWorkflow(dbPath);
        gateway = new Gateway({
            protocol: 1,
            features: ["approvals", "runs"],
            heartbeatMs: 100,
            auth: {
                mode: "token",
                tokens: {
                    "operator-token": {
                        role: "operator",
                        scopes: ["*"],
                        userId: "user:operator",
                    },
                    "approver-token": {
                        role: "approver",
                        scopes: ["approve", "approvals.list", "runs.get"],
                        userId: "user:will",
                    },
                },
            },
        });
        gateway.register("approval", approval.workflow);
        server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        const port = getPort(server);
        const { client: operator } = await connectGateway(port, "operator-token");
        const create = await operator.request("runs.create", {
            workflow: "approval",
            input: {},
        });
        expect(create.ok).toBe(true);
        const runId = create.payload.runId;
        await operator.waitFor((message) => message.type === "event" &&
            message.event === "approval.requested" &&
            message.payload.runId === runId);
        const { client: approver } = await connectGateway(port, "approver-token");
        const decided = await approver.request("approvals.decide", {
            runId,
            nodeId: "pick-plan",
            iteration: 0,
            approved: "false",
            decision: {
                selected: "balanced",
            },
        });
        expect(decided.ok).toBe(false);
        expect(decided.error.code).toBe("INVALID_REQUEST");
        const adapter = new SmithersDb(approval.db);
        const approvalRow = await adapter.getApproval(runId, "pick-plan", 0);
        expect(approvalRow?.status).toBe("requested");
        await operator.close();
        await approver.close();
    });
    test("manages cron schedules through gateway methods", async () => {
        const dbPath = makeDbPath("cron");
        dbPaths.push(dbPath);
        gateway = new Gateway({
            protocol: 1,
            features: ["approvals", "streaming", "runs", "cron"],
            heartbeatMs: 100,
            auth: {
                mode: "token",
                tokens: {
                    "operator-token": {
                        role: "operator",
                        scopes: ["*"],
                        userId: "user:will",
                    },
                },
            },
        });
        gateway.register("basic", createValueWorkflow(dbPath));
        server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        const port = getPort(server);
        const { client } = await connectGateway(port, "operator-token");
        const added = await client.request("cron.add", {
            workflow: "basic",
            pattern: "0 8 * * 5",
        });
        expect(added.ok).toBe(true);
        expect(added.payload.workflow).toBe("basic");
        expect(typeof added.payload.cronId).toBe("string");
        const listed = await client.request("cron.list");
        expect(listed.ok).toBe(true);
        expect(listed.payload).toEqual([
            expect.objectContaining({
                cronId: added.payload.cronId,
                workflow: "basic",
                pattern: "0 8 * * 5",
            }),
        ]);
        const triggered = await client.request("cron.trigger", {
            cronId: added.payload.cronId,
            input: { value: 9 },
        });
        expect(triggered.ok).toBe(true);
        expect(typeof triggered.payload.runId).toBe("string");
        await waitForRunStatus(client, triggered.payload.runId, ["finished"]);
        expect(readValueOutput(dbPath, triggered.payload.runId)).toBe(9);
        const aliasTriggered = await client.request("cronRun", {
            workflow: "basic",
            input: { value: 14 },
        });
        expect(aliasTriggered.ok).toBe(true);
        expect(typeof aliasTriggered.payload.runId).toBe("string");
        await waitForRunStatus(client, aliasTriggered.payload.runId, ["finished"]);
        expect(readValueOutput(dbPath, aliasTriggered.payload.runId)).toBe(14);
        const removed = await client.request("cron.remove", {
            cronId: added.payload.cronId,
        });
        expect(removed.ok).toBe(true);
        const empty = await client.request("cron.list");
        expect(empty.ok).toBe(true);
        expect(empty.payload).toEqual([]);
        await client.close();
    });
    test("supports hijackRun and reruns a finished run with the original input", async () => {
        const dbPath = makeDbPath("rerun");
        dbPaths.push(dbPath);
        gateway = new Gateway({
            protocol: 1,
            features: ["runs"],
            heartbeatMs: 100,
            auth: {
                mode: "token",
                tokens: {
                    "operator-token": {
                        role: "operator",
                        scopes: ["*"],
                        userId: "user:will",
                    },
                },
            },
        });
        gateway.register("basic", createValueWorkflow(dbPath));
        server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        const port = getPort(server);
        const { client } = await connectGateway(port, "operator-token");
        const created = await client.request("runs.create", {
            workflow: "basic",
            input: { value: 12 },
        });
        expect(created.ok).toBe(true);
        await waitForRunStatus(client, created.payload.runId, ["finished"]);
        const hijacked = await client.request("hijackRun", {
            runId: created.payload.runId,
        });
        expect(hijacked.ok).toBe(true);
        expect(hijacked.payload).toMatchObject({
            runId: created.payload.runId,
            status: "hijack-ready",
        });
        expect(typeof hijacked.payload.sessionId).toBe("string");
        const rerunId = "rerun-copy";
        const rerun = await client.request("runs.rerun", {
            runId: created.payload.runId,
            newRunId: rerunId,
        });
        expect(rerun.ok).toBe(true);
        expect(rerun.payload.runId).toBe(rerunId);
        await waitForRunStatus(client, rerunId, ["finished"]);
        expect(readValueOutput(dbPath, rerunId)).toBe(12);
        await client.close();
    });
    test("delivers signals through both gateway signal RPC method names", async () => {
        const dbPath = makeDbPath("signals");
        dbPaths.push(dbPath);
        const signalHost = createSignalHostWorkflow(dbPath);
        gateway = new Gateway({
            protocol: 1,
            features: ["runs"],
            heartbeatMs: 100,
            auth: {
                mode: "token",
                tokens: {
                    "operator-token": {
                        role: "operator",
                        scopes: ["*"],
                        userId: "user:will",
                    },
                },
            },
        });
        gateway.register("signal-host", signalHost.workflow);
        server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        const port = getPort(server);
        const { client } = await connectGateway(port, "operator-token");
        const adapter = new SmithersDb(signalHost.db);
        const runId = "gateway-signal-run";
        await adapter.insertRun({
            runId,
            workflowName: "signal-host",
            status: "waiting-event",
            createdAtMs: Date.now(),
        });
        const sent = await client.request("signals.send", {
            runId,
            signalName: "deploy.ready",
            data: { ok: true },
            correlationId: "ticket-42",
        });
        expect(sent.ok).toBe(true);
        expect(sent.payload).toMatchObject({
            runId,
            signalName: "deploy.ready",
            correlationId: "ticket-42",
        });
        const submitted = await client.request("submitSignal", {
            runId,
            correlationKey: "manual.resume",
            payload: { ok: "alias" },
        });
        expect(submitted.ok).toBe(true);
        expect(submitted.payload).toMatchObject({
            runId,
            signalName: "manual.resume",
            correlationId: "manual.resume",
        });
        const deploySignals = await adapter.listSignals(runId, { signalName: "deploy.ready" });
        expect(deploySignals).toHaveLength(1);
        expect(JSON.parse(deploySignals[0].payloadJson)).toEqual({ ok: true });
        expect(deploySignals[0].receivedBy).toBe("user:will");
        const aliasSignals = await adapter.listSignals(runId, { signalName: "manual.resume" });
        expect(aliasSignals).toHaveLength(1);
        expect(JSON.parse(aliasSignals[0].payloadJson)).toEqual({ ok: "alias" });
        await client.close();
    });
    test("propagates gateway auth context into workflow tasks", async () => {
        const dbPath = makeDbPath("auth");
        dbPaths.push(dbPath);
        const authWorkflow = createAuthWorkflow(dbPath);
        gateway = new Gateway({
            protocol: 1,
            features: ["runs"],
            heartbeatMs: 100,
            auth: {
                mode: "token",
                tokens: {
                    "operator-token": {
                        role: "operator",
                        scopes: ["runs.create", "runs.get"],
                        userId: "user:will",
                    },
                },
            },
        });
        gateway.register("auth", authWorkflow.workflow);
        server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        const port = getPort(server);
        const { client } = await connectGateway(port, "operator-token");
        const created = await client.request("runs.create", {
            workflow: "auth",
            input: {},
        });
        expect(created.ok).toBe(true);
        const runId = created.payload.runId;
        await waitForRunStatus(client, runId, ["finished"]);
        const rows = await authWorkflow.db
            .select()
            .from(authWorkflow.tables.authOutput);
        expect(rows).toEqual([
            {
                runId,
                nodeId: "auth-task",
                iteration: 0,
                triggeredBy: "user:will",
                role: "operator",
                scopes: ["runs.create", "runs.get"],
            },
        ]);
        await client.close();
    });
    test("rejects token-mode bearer tokens that collide with Object prototype keys", async () => {
        const dbPath = makeDbPath("proto-token");
        dbPaths.push(dbPath);
        gateway = new Gateway({
            protocol: 1,
            features: ["runs"],
            heartbeatMs: 100,
            auth: {
                mode: "token",
                tokens: {
                    "op-token": {
                        role: "operator",
                        scopes: ["*"],
                        userId: "user:will",
                    },
                },
            },
        });
        gateway.register("basic", createValueWorkflow(dbPath));
        server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        const port = getPort(server);
        // Magic prototype keys resolve to truthy inherited members on a plain
        // object, so a direct `tokens[token]` lookup would treat them as valid
        // grants. They must be rejected as unauthorized instead.
        for (const magicToken of ["toString", "__proto__", "constructor", "hasOwnProperty"]) {
            const ws = new WebSocket(`ws://127.0.0.1:${port}`);
            await new Promise((resolve, reject) => {
                ws.once("open", () => resolve());
                ws.once("error", reject);
            });
            const attacker = new GatewayClient(ws);
            await attacker.waitFor((message) => message.type === "event" && message.event === "connect.challenge");
            const hello = await attacker.request("connect", {
                minProtocol: 1,
                maxProtocol: 1,
                client: {
                    id: "proto-client",
                    version: "1.0.0",
                    platform: "bun-test",
                },
                auth: { token: magicToken },
            });
            expect(hello.ok).toBe(false);
            expect(hello.error.code).toBe("UNAUTHORIZED");
            await attacker.close();
        }
    });
    test("rejects validly-signed JWTs that omit the exp claim", async () => {
        const dbPath = makeDbPath("jwt-no-exp");
        dbPaths.push(dbPath);
        const secret = "super-secret";
        gateway = new Gateway({
            protocol: 1,
            features: ["runs"],
            heartbeatMs: 100,
            auth: {
                mode: "jwt",
                issuer: "https://auth.example.com",
                audience: "smithers",
                secret,
                scopesClaim: "permissions",
            },
        });
        gateway.register("basic", createValueWorkflow(dbPath));
        server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        const port = getPort(server);
        // Same issuer/audience/signature as a valid token, but with no exp claim.
        // Such a token would never expire, so it must be rejected outright.
        const noExpToken = createJwtToken({
            iss: "https://auth.example.com",
            aud: "smithers",
            sub: "user:jwt",
            role: "operator",
            permissions: ["runs.create", "runs.get"],
        }, secret);
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        await new Promise((resolve, reject) => {
            ws.once("open", () => resolve());
            ws.once("error", reject);
        });
        const rejected = new GatewayClient(ws);
        await rejected.waitFor((message) => message.type === "event" && message.event === "connect.challenge");
        const hello = await rejected.request("connect", {
            minProtocol: 1,
            maxProtocol: 1,
            client: {
                id: "jwt-client",
                version: "1.0.0",
                platform: "bun-test",
            },
            auth: { token: noExpToken },
        });
        expect(hello.ok).toBe(false);
        expect(hello.error.code).toBe("UNAUTHORIZED");
        await rejected.close();
    });
    test("removes the runRegistry entry after a run completes", async () => {
        const dbPath = makeDbPath("run-registry");
        dbPaths.push(dbPath);
        gateway = new Gateway({
            protocol: 1,
            features: ["streaming", "runs"],
            heartbeatMs: 100,
            auth: {
                mode: "token",
                tokens: {
                    "op-token": {
                        role: "operator",
                        scopes: ["*"],
                        userId: "user:will",
                    },
                },
            },
        });
        gateway.register("basic", createValueWorkflow(dbPath));
        server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        const port = getPort(server);
        const { client } = await connectGateway(port, "op-token");
        const created = await client.request("runs.create", {
            workflow: "basic",
            input: { value: 3 },
        });
        expect(created.ok).toBe(true);
        const runId = created.payload.runId;
        // The registry holds the run while it is active.
        expect(gateway.runRegistry.has(runId)).toBe(true);
        await waitForRunStatus(client, runId, ["finished"]);
        // The entry is deleted in the run promise's .finally(), which runs just
        // after the run.completed broadcast, so poll briefly for the cleanup.
        const started = Date.now();
        while (gateway.runRegistry.has(runId) && Date.now() - started < 5_000) {
            await sleep(10);
        }
        expect(gateway.runRegistry.has(runId)).toBe(false);
        await client.close();
    });
    test("streams persisted events from detached runs through the built-in bridge", async () => {
        const dbPath = makeDbPath("detached-events");
        dbPaths.push(dbPath);
        const workflow = createValueWorkflow(dbPath);
        gateway = new Gateway({
            protocol: 1,
            features: ["streaming", "runs"],
            heartbeatMs: 100,
            outOfProcessEventBridgePollMs: 25,
            auth: {
                mode: "token",
                tokens: {
                    "op-token": {
                        role: "operator",
                        scopes: ["*"],
                        userId: "user:will",
                    },
                },
            },
        });
        gateway.register("basic", workflow);
        const adapter = gateway.adapterForWorkflow(workflow);
        await adapter.insertRun({
            runId: "detached-run",
            workflowName: "gateway-basic",
            status: "running",
            createdAtMs: Date.now(),
        });
        server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        const port = getPort(server);
        const { client } = await connectGateway(port, "op-token");
        const subscribed = await client.request("streamRunEvents", { runId: "detached-run" });
        expect(subscribed.ok).toBe(true);
        await adapter.insertEventWithNextSeq({
            runId: "detached-run",
            timestampMs: Date.now(),
            type: "NodeStarted",
            payloadJson: JSON.stringify({
                type: "NodeStarted",
                runId: "detached-run",
                nodeId: "task1",
            }),
        });
        const event = await client.waitFor((message) => message.type === "event" && message.event === "node.started");
        expect(event.payload.runId).toBe("detached-run");
        expect(event.payload.nodeId).toBe("task1");
        await client.close();
    });
    test("does not replay persisted copies for in-process runs after registry cleanup", async () => {
        const dbPath = makeDbPath("in-process-bridge-skip");
        dbPaths.push(dbPath);
        const workflow = createValueWorkflow(dbPath);
        gateway = new Gateway({ heartbeatMs: 100 });
        gateway.register("basic", workflow);
        const adapter = gateway.adapterForWorkflow(workflow);
        await adapter.insertRun({
            runId: "in-process-run",
            workflowName: "gateway-basic",
            status: "running",
            createdAtMs: Date.now(),
        });
        await adapter.insertEventWithNextSeq({
            runId: "in-process-run",
            timestampMs: Date.now(),
            type: "NodeStarted",
            payloadJson: JSON.stringify({
                type: "NodeStarted",
                runId: "in-process-run",
                nodeId: "task1",
            }),
        });
        let fed = 0;
        gateway.handleSmithersEvent = () => {
            fed += 1;
        };
        gateway.runRegistry.set("in-process-run", {});
        await gateway.pollOutOfProcessRunEvents();
        gateway.runRegistry.delete("in-process-run");
        await adapter.updateRun("in-process-run", { status: "finished" });
        await gateway.pollOutOfProcessRunEvents();
        expect(fed).toBe(0);
    });
});
