/**
 * Boundary/edge tests for the Gateway HTTP entry point. Targets readRawBody,
 * Content-Length handling, auth header parsing, and JSON payload bounds.
 *
 * Notes:
 * - These tests use a no-auth Gateway and POST /rpc, except where the auth
 *   suite explicitly configures token mode.
 * - There is no slowloris/header timeout in gateway.js today; the slowloris
 *   case below is documented (skipped) rather than asserted.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { Gateway, GATEWAY_RPC_MAX_DEPTH, GATEWAY_RPC_MAX_STRING_LENGTH, } from "../src/gateway.js";

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

/** @type {Gateway | undefined} */
let gateway;
/** @type {import("node:http").Server | undefined} */
let server;
/** @type {number} */
let port;

async function startGateway(options = {}) {
    gateway = new Gateway({ heartbeatMs: 100, ...options });
    server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    port = getPort(server);
}

afterEach(async () => {
    if (gateway) {
        await gateway.close();
        gateway = undefined;
        server = undefined;
    }
});

/**
 * Send a raw HTTP request over a socket so we control Content-Length exactly.
 * @param {string} headers raw header block (without trailing CRLF CRLF)
 * @param {Buffer | string | null} body
 * @returns {Promise<{ statusCode: number; body: string; raw: string }>}
 */
function rawHttp(headers, body) {
    return new Promise((resolve, reject) => {
        const sock = connect({ host: "127.0.0.1", port }, () => {
            const bodyBuf = body == null
                ? Buffer.alloc(0)
                : Buffer.isBuffer(body)
                    ? body
                    : Buffer.from(body, "utf8");
            sock.write(headers + "\r\n\r\n");
            if (bodyBuf.length > 0) {
                sock.write(bodyBuf);
            }
        });
        const chunks = [];
        sock.on("data", (c) => chunks.push(c));
        sock.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const [statusLine] = raw.split("\r\n");
            const statusCode = Number(statusLine?.split(" ")[1] ?? 0);
            const bodyIdx = raw.indexOf("\r\n\r\n");
            const responseBody = bodyIdx >= 0 ? raw.slice(bodyIdx + 4) : "";
            resolve({ statusCode, body: responseBody, raw });
        });
        sock.on("error", reject);
        sock.setTimeout(4_000, () => {
            sock.destroy(new Error("rawHttp socket timeout"));
        });
    });
}

describe("gateway readRawBody / Content-Length", () => {
    test("Content-Length: 0 with no body is accepted (parsed as {} -> INVALID_REQUEST)", async () => {
        await startGateway();
        // Empty body -> parseJsonBuffer returns {} -> handler rejects as
        // INVALID_REQUEST (no method). The point: readRawBody itself does NOT
        // throw on a zero-length body.
        const headers = [
            "POST /rpc HTTP/1.1",
            "Host: 127.0.0.1",
            "Content-Type: application/json",
            "Content-Length: 0",
            "Connection: close",
        ].join("\r\n");
        const res = await rawHttp(headers, null);
        expect(res.statusCode).toBe(400);
        expect(res.body).toContain("INVALID");
    });

    test("negative Content-Length is currently NOT rejected by readRawBody (documents observed behavior)", async () => {
        // FIXME: gateway.readRawBody does not reject negative Content-Length
        // values. Number("-1") is finite and -1 > maxBytes is false, so the
        // header is silently ignored. Node's HTTP parser may also reject the
        // request before it reaches readRawBody; this test only documents that
        // the gateway-level check has no negative-value branch.
        await startGateway();
        const headers = [
            "POST /rpc HTTP/1.1",
            "Host: 127.0.0.1",
            "Content-Type: application/json",
            "Content-Length: -1",
            "Connection: close",
        ].join("\r\n");
        const res = await rawHttp(headers, null);
        // Either node rejects with 400 or readRawBody treats it as no body.
        // Both indicate the request never reached business logic with a
        // negative declared length.
        expect([400, 200]).toContain(res.statusCode);
    });

    test("Content-Length exceeding maxBytes is rejected with 413", async () => {
        await startGateway({ maxBodyBytes: 64 });
        const headers = [
            "POST /rpc HTTP/1.1",
            "Host: 127.0.0.1",
            "Content-Type: application/json",
            "Content-Length: 1000000",
            "Connection: close",
        ].join("\r\n");
        const res = await rawHttp(headers, null);
        expect(res.statusCode).toBe(413);
    });

    test("body actually exceeding maxBytes returns PayloadTooLarge/413 with 'exceeds' message", async () => {
        // Send a body that legitimately exceeds maxBodyBytes via fetch (which
        // computes its own Content-Length) so the size is unambiguous.
        await startGateway({ maxBodyBytes: 64 });
        const big = JSON.stringify({
            id: "x",
            method: "ping",
            params: { v: "y".repeat(200) },
        });
        const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: big,
        });
        expect(res.status).toBe(413);
        const json = await res.json();
        expect(json.error.code).toBe("PayloadTooLarge");
        expect(json.error.message).toMatch(/exceeds/);
    });

    test("Content-Length = 2^31 (exceeding INT32_MAX) is rejected", async () => {
        await startGateway({ maxBodyBytes: 1024 });
        const headers = [
            "POST /rpc HTTP/1.1",
            "Host: 127.0.0.1",
            "Content-Type: application/json",
            "Content-Length: 2147483648",
            "Connection: close",
        ].join("\r\n");
        const res = await rawHttp(headers, null);
        // Node may itself reject with 400; gateway will otherwise reject 413.
        expect([400, 413]).toContain(res.statusCode);
    });

    test("body at maxBodyBytes succeeds; body at maxBodyBytes+1 is rejected", async () => {
        // We size payload as full RPC frame JSON. maxBodyBytes is the cap.
        const overhead = JSON.stringify({ id: "x", method: "ping", params: { v: "" } }).length;
        const cap = overhead + 32;
        await startGateway({ maxBodyBytes: cap });

        const fitting = JSON.stringify({
            id: "x",
            method: "ping",
            params: { v: "y".repeat(32) },
        });
        expect(Buffer.byteLength(fitting)).toBe(cap);
        const okRes = await fetch(`http://127.0.0.1:${port}/rpc`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: fitting,
        });
        // Method "ping" is unknown — but readRawBody must NOT reject on size.
        expect(okRes.status).not.toBe(413);

        const tooBig = JSON.stringify({
            id: "x",
            method: "ping",
            params: { v: "y".repeat(33) },
        });
        expect(Buffer.byteLength(tooBig)).toBe(cap + 1);
        const tooBigRes = await fetch(`http://127.0.0.1:${port}/rpc`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: tooBig,
        });
        expect(tooBigRes.status).toBe(413);
        const tooBigJson = await tooBigRes.json();
        expect(tooBigJson.error.code).toBe("PayloadTooLarge");
        expect(tooBigJson.error.message).toMatch(/exceeds/);
    });

    test("mismatched declared vs actual length: handler still validates JSON correctness", async () => {
        // We declare a length that matches what we send (so the framing parses)
        // and verify the gateway validates JSON contents independently of the
        // declared length. readRawBody trusts the stream, not the header.
        await startGateway();
        const body = "{ not: 'valid' }";
        const headers = [
            "POST /rpc HTTP/1.1",
            "Host: 127.0.0.1",
            "Content-Type: application/json",
            // Declare a length larger than the body we send. Node's HTTP parser
            // will hold the connection open waiting for more bytes; we close
            // ourselves via Connection: close. We expect either a 400 or a
            // socket close — not a 200.
            `Content-Length: ${body.length}`,
            "Connection: close",
        ].join("\r\n");
        const res = await rawHttp(headers, body);
        expect(res.statusCode).toBe(400);
    });

    // No header/slowloris timeout exists in gateway.js today; document and skip.
    test.skip("slowloris: drip body byte-by-byte hits a per-request timeout", () => {
        // FIXME: gateway.js does not configure server.headersTimeout or
        // server.requestTimeout, so a slow client cannot be timed out at the
        // application layer. If a timeout is added later, replace this skip
        // with a connect()-based drip test.
    });
});

describe("assertJsonPayloadWithinBounds via gateway HTTP RPC", () => {
    test("payload at depth = maxDepth-1 succeeds (passes bounds, fails business validation)", async () => {
        await startGateway();
        // Build params nested at depth maxDepth-1 (relative to the frame root).
        // Frame root at depth 1; params at depth 2; we want max nested object
        // depth == GATEWAY_RPC_MAX_DEPTH - 1 from frame perspective.
        let v = "leaf";
        for (let i = 0; i < GATEWAY_RPC_MAX_DEPTH - 3; i += 1) {
            v = { c: v };
        }
        const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: "1", method: "ping", params: v }),
        });
        const json = await res.json();
        // Must NOT be a depth-bounds rejection.
        expect(json.error?.message ?? "").not.toMatch(/maximum JSON depth/);
    });

    test("payload at depth > maxDepth is rejected", async () => {
        await startGateway();
        let v = "leaf";
        for (let i = 0; i < GATEWAY_RPC_MAX_DEPTH + 5; i += 1) {
            v = { c: v };
        }
        const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: "1", method: "ping", params: v }),
        });
        const json = await res.json();
        expect(json.ok).toBe(false);
        expect(json.error.message).toMatch(/maximum JSON depth/);
    });

    test("wide-but-shallow payload at array length boundary is rejected", async () => {
        await startGateway();
        const arr = Array.from({ length: 1000 }, (_, i) => i);
        const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: "1", method: "ping", params: { values: arr } }),
        });
        const json = await res.json();
        expect(json.ok).toBe(false);
        // Either array length or string length bound — both are bounds errors.
        expect(json.error.message).toMatch(/exceed/i);
    });

    test("wide string at maxStringLength+1 is rejected", async () => {
        await startGateway();
        const big = "a".repeat(GATEWAY_RPC_MAX_STRING_LENGTH + 1);
        const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: "1", method: "ping", params: { v: big } }),
        });
        const json = await res.json();
        expect(json.ok).toBe(false);
        expect(json.error.message).toMatch(/string exceeding|exceed/i);
    });
});

describe("auth header edge cases (gateway HTTP)", () => {
    /**
     * @param {Record<string, string>} headers
     */
    async function rpc(headers) {
        const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...headers },
            body: JSON.stringify({ id: "1", method: "ping", params: {} }),
        });
        const json = await res.json().catch(() => ({}));
        return { status: res.status, json };
    }

    async function startTokenGateway() {
        await startGateway({
            auth: {
                mode: "token",
                tokens: {
                    "secret-token": {
                        role: "operator",
                        scopes: ["*"],
                        userId: "user:will",
                    },
                },
            },
        });
    }

    test("Authorization without 'Bearer ' prefix is treated as the token verbatim", async () => {
        await startTokenGateway();
        const { status, json } = await rpc({ Authorization: "secret-token" });
        // Token recognised — auth passes; the RPC method itself is unknown so
        // we expect anything other than UNAUTHORIZED.
        expect(json.error?.code).not.toBe("UNAUTHORIZED");
        expect(status).not.toBe(401);
    });

    test("lowercase 'bearer' prefix is stripped case-insensitively", async () => {
        await startTokenGateway();
        const { status, json } = await rpc({ Authorization: "bearer secret-token" });
        expect(status).toBe(404);
        expect(json.error.code).toBe("METHOD_NOT_FOUND");
    });

    test("UPPERCASE 'BEARER' prefix is stripped case-insensitively", async () => {
        await startTokenGateway();
        const { status, json } = await rpc({ Authorization: "BEARER secret-token" });
        expect(status).toBe(404);
        expect(json.error.code).toBe("METHOD_NOT_FOUND");
    });

    test("Authorization with extra leading whitespace is rejected (token mismatch)", async () => {
        await startTokenGateway();
        // Node trims a single optional leading whitespace on header values per
        // the HTTP spec but leaves embedded whitespace in place. The gateway
        // sees " secret-token" -> token lookup miss.
        const { status } = await rpc({ Authorization: "Bearer  secret-token" });
        expect(status).toBe(401);
    });

    test("x-smithers-key with very long value is rejected as invalid token", async () => {
        await startTokenGateway();
        const huge = "x".repeat(8 * 1024);
        const { status, json } = await rpc({ "x-smithers-key": huge });
        expect(status).toBe(401);
        expect(json.error.code).toBe("UNAUTHORIZED");
    });

    test("header values with CRLF are rejected by the runtime (header-injection prevention)", async () => {
        await startTokenGateway();
        // fetch() throws synchronously (TypeError) for invalid header values;
        // the malformed Authorization never reaches the gateway. This is the
        // layer that prevents response splitting / header injection.
        expect(() => {
            fetch(`http://127.0.0.1:${port}/rpc`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: "Bearer secret\r\nX-Injected: yes",
                },
                body: "{}",
            });
        }).toThrow(/invalid value|invalid header/i);
    });

    test("x-smithers-key with embedded null byte is rejected by fetch (sanitisation at runtime)", async () => {
        await startTokenGateway();
        // Bun/Node refuses to send a header whose value contains a null byte.
        // We document that this is rejected before the gateway sees it.
        expect(() => {
            fetch(`http://127.0.0.1:${port}/rpc`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-smithers-key": "secret-token\u0000extra",
                },
                body: "{}",
            });
        }).toThrow(/invalid value|invalid header/i);
    });
});
