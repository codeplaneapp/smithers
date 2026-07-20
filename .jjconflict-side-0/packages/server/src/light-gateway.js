import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

const DEFAULT_PROTOCOL = 1;
const DEFAULT_HEADERS_TIMEOUT = 30_000;
const DEFAULT_REQUEST_TIMEOUT = 60_000;
const DEFAULT_MAX_BODY_BYTES = 1_048_576;

function sendJson(res, status, payload) {
    if (!res.headersSent) {
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.setHeader("x-content-type-options", "nosniff");
    }
    res.statusCode = status;
    res.end(`${JSON.stringify(payload)}\n`);
}

async function readBody(req, maxBytes) {
    let total = 0;
    const chunks = [];
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > maxBytes) {
            const error = new Error("payload too large");
            error.status = 413;
            throw error;
        }
        chunks.push(buffer);
    }
    if (!chunks.length) return {};
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function responseOk(id, payload) {
    return { type: "res", id, ok: true, apiVersion: "v1", payload };
}

function responseError(id, code, message) {
    return { type: "res", id, ok: false, apiVersion: "v1", error: { version: "v1", code, message } };
}

/**
 * Node-safe Gateway HTTP shell for hosts that need the Gateway listener
 * contract but do not execute Smithers workflows in-process. The full Gateway
 * class still owns workflow execution, websocket streams, cron, and durable DB
 * integration. This light entry keeps embedding apps off Express while the
 * Bun-backed workflow runtime remains lazy/out-of-process.
 */
export class Gateway {
    protocol;
    features;
    routes;
    identity;
    workspaceRoot;
    headersTimeout;
    requestTimeout;
    maxBodyBytes;
    startedAtMs = Date.now();
    server = null;

    constructor(options = {}) {
        this.protocol = options.protocol ?? DEFAULT_PROTOCOL;
        this.features = [...(options.features ?? ["http", "rpc", "routes"])];
        this.routes = typeof options.routes === "function" ? options.routes : null;
        this.identity = options.identity ?? null;
        this.workspaceRoot = options.workspaceRoot ? resolve(options.workspaceRoot) : process.cwd();
        this.headersTimeout = options.headersTimeout ?? DEFAULT_HEADERS_TIMEOUT;
        this.requestTimeout = options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT;
        this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    }

    buildIdentity() {
        return {
            kind: "gateway",
            pid: process.pid,
            workspaceRoot: this.workspaceRoot,
            startedAtMs: this.startedAtMs,
            ...(this.identity && typeof this.identity === "object" ? this.identity : {}),
        };
    }

    async handleRpc(req, res, forcedMethod) {
        const requestId = req.headers["x-request-id"] || randomUUID();
        try {
            const body = await readBody(req, this.maxBodyBytes);
            const method = forcedMethod || body.method;
            const id = typeof body.id === "string" ? body.id : requestId;
            if (method === "health") {
                return sendJson(res, 200, responseOk(id, {
                    protocol: this.protocol,
                    features: this.features,
                    uptimeMs: Date.now() - this.startedAtMs,
                    identity: this.buildIdentity(),
                }));
            }
            return sendJson(res, 404, responseError(id, "METHOD_NOT_FOUND", `Unknown method: ${method || ""}`));
        } catch (error) {
            const status = error?.status === 413 ? 413 : error instanceof SyntaxError ? 400 : 500;
            const code = status === 413 ? "PAYLOAD_TOO_LARGE" : status === 400 ? "INVALID_JSON" : "SERVER_ERROR";
            return sendJson(res, status, responseError(String(requestId), code, error?.message || "Gateway RPC failed"));
        }
    }

    async listen(options = {}) {
        if (this.server) return this.server;
        const server = createServer(async (req, res) => {
            const url = new URL(req.url || "/", "http://127.0.0.1");
            const method = req.method || "GET";
            const rpcMatch = url.pathname.match(/^\/v1\/rpc\/([^/]+)$/);
            if (method === "GET" && url.pathname === "/health") {
                return sendJson(res, 200, {
                    ok: true,
                    protocol: this.protocol,
                    features: this.features,
                    identity: this.buildIdentity(),
                });
            }
            if (method === "GET" && url.pathname === "/workflows") {
                return sendJson(res, 200, { workflows: [] });
            }
            if (method === "GET" && url.pathname === "/metrics") {
                res.setHeader("content-type", "text/plain; version=0.0.4; charset=utf-8");
                res.end("");
                return;
            }
            if (method === "POST" && rpcMatch) {
                return this.handleRpc(req, res, decodeURIComponent(rpcMatch[1]));
            }
            if (method === "POST" && url.pathname === "/rpc") {
                return this.handleRpc(req, res);
            }
            if (this.routes && await this.routes(req, res, { gateway: this, url })) {
                return;
            }
            if (method === "GET" && url.pathname === "/") {
                return sendJson(res, 200, {
                    ok: true,
                    message: "Smithers Gateway",
                    identity: this.buildIdentity(),
                });
            }
            return sendJson(res, 404, { error: { code: "NOT_FOUND", message: "Route not found" } });
        });
        server.headersTimeout = this.headersTimeout;
        server.requestTimeout = this.requestTimeout;
        await new Promise((resolveListen, rejectListen) => {
            const onError = (error) => rejectListen(error);
            server.once("error", onError);
            const onListening = () => {
                server.removeListener("error", onError);
                resolveListen();
            };
            if (options.path !== undefined) {
                server.listen(options.path, onListening);
            } else if (options.host === undefined) {
                server.listen(options.port ?? 7331, onListening);
            } else {
                server.listen(options.port ?? 7331, options.host, onListening);
            }
        });
        this.server = server;
        return server;
    }

    async close() {
        if (!this.server) return;
        const server = this.server;
        this.server = null;
        await new Promise((resolveClose) => server.close(resolveClose));
    }
}
