import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { Gateway } from "../src/gateway.js";

/**
 * DNS-rebinding / Host-header defense (spec decision 16a). An unauthenticated
 * daemon (the autostart default) grants operator scope to every request, so a
 * browser page at a name rebound to 127.0.0.1 could drive launchRun. The
 * browser sends the rebound name in `Host`, so an unauthenticated gateway must
 * reject a non-loopback Host — even though its Origin allow-list is permissive.
 */

function req(host, origin) {
    const headers = {};
    if (host !== undefined) headers.host = host;
    if (origin !== undefined) headers.origin = origin;
    return { headers, socket: {} };
}

/** @type {Gateway[]} */
const gateways = [];
function makeGateway(options) {
    const gateway = new Gateway(options ?? {});
    gateways.push(gateway);
    return gateway;
}

afterEach(async () => {
    for (const gateway of gateways.splice(0)) {
        try {
            await gateway.close?.();
        }
        catch {}
    }
});

describe("gateway — Host-header / DNS-rebinding defense", () => {
    test("unauthenticated: a non-loopback Host is rejected (rebinding blocked)", async () => {
        const gateway = makeGateway({});
        for (const host of ["evil.com", "evil.com:7331", "attacker.example:80", "10.0.0.5:7331", "169.254.169.254"]) {
            const res = await gateway.authenticateRequest(req(host), null);
            expect(res.ok).toBe(false);
            expect(res.code).toBe("UNAUTHORIZED");
            expect(res.message).toBe("Host is not allowed");
        }
    });

    test("unauthenticated: loopback Host variants are allowed as operator", async () => {
        const gateway = makeGateway({});
        for (const host of [
            "127.0.0.1:7331",
            "localhost:7331",
            "localhost",
            "[::1]:7331",
            "[::1]",
            "::1",
            "127.0.0.1",
            "sub.localhost:7331",
            "127.5.5.5:9999",
            undefined,
            "",
        ]) {
            const res = await gateway.authenticateRequest(req(host), null);
            expect(res.ok).toBe(true);
            expect(res.role).toBe("operator");
        }
    });

    test("authenticated: token gates access; a remote (non-loopback) Host is allowed with a valid token", async () => {
        const gateway = makeGateway({
            auth: { mode: "token", tokens: { "secret-token": { role: "operator", scopes: ["*"], userId: "user:test" } } },
        });
        const ok = await gateway.authenticateRequest(req("smithers.example.com"), "secret-token");
        expect(ok.ok).toBe(true);
        // An invalid token is still rejected regardless of a loopback Host.
        const bad = await gateway.authenticateRequest(req("127.0.0.1:7331"), "wrong-token");
        expect(bad.ok).toBe(false);
    });

    test("escape hatch: SMITHERS_GATEWAY_TRUST_ANY_HOST=1 allows a non-loopback Host unauthenticated", async () => {
        const saved = process.env.SMITHERS_GATEWAY_TRUST_ANY_HOST;
        try {
            process.env.SMITHERS_GATEWAY_TRUST_ANY_HOST = "1";
            const gateway = makeGateway({});
            const res = await gateway.authenticateRequest(req("evil.com"), null);
            expect(res.ok).toBe(true);
        }
        finally {
            if (saved === undefined) delete process.env.SMITHERS_GATEWAY_TRUST_ANY_HOST;
            else process.env.SMITHERS_GATEWAY_TRUST_ANY_HOST = saved;
        }
    });

    test("isHostAllowed matcher: loopback accepted, everything else rejected (unauthenticated)", () => {
        const gateway = makeGateway({});
        for (const host of ["127.0.0.1", "127.0.0.1:7331", "localhost:80", "[::1]:7331", "[::1]", "::1", "x.localhost"]) {
            expect(gateway.isHostAllowed(req(host))).toBe(true);
        }
        for (const host of ["evil.com", "evil.com:7331", "10.0.0.5:7331", "notlocalhost.com", "127.0.0.1.evil.com"]) {
            expect(gateway.isHostAllowed(req(host))).toBe(false);
        }
    });
});

/**
 * Cross-origin CSRF / WS-hijack defense (#446). An unauthenticated daemon grants
 * operator scope to every request, so a drive-by browser page that points a
 * `fetch`/`WebSocket` straight at `http://127.0.0.1:<port>` — Host is loopback,
 * NO DNS rebinding — must still be rejected on any present cross-origin Origin.
 * The Host-header gate above cannot see this attack because the Host is honest.
 */
describe("gateway — cross-origin Origin defense (unauthenticated)", () => {
    test("a present cross-origin Origin is rejected even with a loopback Host", async () => {
        const gateway = makeGateway({});
        for (const origin of ["https://evil.com", "http://evil.com:8080", "http://attacker.example", "https://app.evil.io"]) {
            const res = await gateway.authenticateRequest(req("127.0.0.1:7331", origin), null);
            expect(res.ok).toBe(false);
            expect(res.code).toBe("UNAUTHORIZED");
            expect(res.message).toBe("Origin is not allowed");
        }
    });

    test("absent, null, and loopback Origins are allowed as operator", async () => {
        const gateway = makeGateway({});
        for (const origin of [
            undefined,
            "",
            "null",
            "http://localhost:5173",
            "http://127.0.0.1:7331",
            "http://localhost",
            "https://[::1]:7331",
            "http://sub.localhost:3000",
        ]) {
            const res = await gateway.authenticateRequest(req("127.0.0.1:7331", origin), null);
            expect(res.ok).toBe(true);
            expect(res.role).toBe("operator");
        }
    });

    test("a malformed Origin is rejected (fails closed)", async () => {
        const gateway = makeGateway({});
        const res = await gateway.authenticateRequest(req("127.0.0.1:7331", "not-a-url"), null);
        expect(res.ok).toBe(false);
        expect(res.message).toBe("Origin is not allowed");
    });

    test("isRequestOriginAllowed matcher: loopback/absent/null accepted, cross-origin rejected", () => {
        const gateway = makeGateway({});
        for (const origin of [undefined, "", "null", "http://localhost:5173", "http://127.0.0.1:9", "http://x.localhost"]) {
            expect(gateway.isRequestOriginAllowed(req("127.0.0.1", origin))).toBe(true);
        }
        for (const origin of ["https://evil.com", "http://10.0.0.5", "http://notlocalhost.com", "garbage"]) {
            expect(gateway.isRequestOriginAllowed(req("127.0.0.1", origin))).toBe(false);
        }
    });

    test("TRUST_ANY_HOST escape hatch also bypasses the Origin gate", async () => {
        const saved = process.env.SMITHERS_GATEWAY_TRUST_ANY_HOST;
        try {
            process.env.SMITHERS_GATEWAY_TRUST_ANY_HOST = "1";
            const gateway = makeGateway({});
            const res = await gateway.authenticateRequest(req("127.0.0.1:7331", "https://evil.com"), null);
            expect(res.ok).toBe(true);
        }
        finally {
            if (saved === undefined) delete process.env.SMITHERS_GATEWAY_TRUST_ANY_HOST;
            else process.env.SMITHERS_GATEWAY_TRUST_ANY_HOST = saved;
        }
    });

    test("authenticated with an empty allow-list stays permissive (token is the gate)", async () => {
        const gateway = makeGateway({
            auth: { mode: "token", tokens: { "t": { role: "operator", scopes: ["*"], userId: "u" } } },
        });
        // A cross-origin browser with a valid token is allowed: the allow-list is
        // empty so the token gates access. This preserves prior behavior — the
        // stricter same-origin rule is ONLY for the unauthenticated path.
        const res = await gateway.authenticateRequest(req("smithers.example.com", "https://evil.com"), "t");
        expect(res.ok).toBe(true);
    });

    test("authenticated with a configured allow-list still rejects a disallowed Origin", async () => {
        const gateway = makeGateway({
            auth: {
                mode: "token",
                tokens: { "t": { role: "operator", scopes: ["*"], userId: "u" } },
                allowedOrigins: ["https://app.smithers.example"],
            },
        });
        const bad = await gateway.authenticateRequest(req("smithers.example.com", "https://evil.com"), "t");
        expect(bad.ok).toBe(false);
        expect(bad.message).toBe("Origin is not allowed");
        const good = await gateway.authenticateRequest(req("smithers.example.com", "https://app.smithers.example"), "t");
        expect(good.ok).toBe(true);
    });
});

function b64url(obj) {
    return Buffer.from(JSON.stringify(obj)).toString("base64url");
}
function makeJwt(secret, claims) {
    const header = b64url({ alg: "HS256", typ: "JWT" });
    const payload = b64url(claims);
    const sig = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
    return `${header}.${payload}.${sig}`;
}

/**
 * JWT signature verification must be constant-time: a plain `!==` on the encoded
 * signature short-circuits on the first differing byte (a timing oracle) and
 * makes the timingSafeEqual compare dead code. These lock in that a tampered
 * signature is still rejected and a valid one accepted through the sole
 * constant-time path.
 */
describe("gateway — JWT signature verification", () => {
    const secret = "super-secret-hmac-key";
    const baseClaims = () => ({
        iss: "https://issuer.example",
        aud: "smithers",
        exp: Math.floor(Date.now() / 1000) + 3600,
    });
    function jwtGateway() {
        return makeGateway({
            auth: { mode: "jwt", secret, issuer: "https://issuer.example", audience: "smithers" },
        });
    }

    test("a valid HS256 token is accepted", async () => {
        const gateway = jwtGateway();
        const token = makeJwt(secret, baseClaims());
        const res = await gateway.authenticateRequest(req("127.0.0.1:7331"), token);
        expect(res.ok).toBe(true);
    });

    test("a token with a tampered signature is rejected", async () => {
        const gateway = jwtGateway();
        const token = makeJwt(secret, baseClaims());
        const [h, p] = token.split(".");
        const forged = makeJwt("wrong-secret", baseClaims());
        const tampered = `${h}.${p}.${forged.split(".")[2]}`;
        const res = await gateway.authenticateRequest(req("127.0.0.1:7331"), tampered);
        expect(res.ok).toBe(false);
        expect(res.code).toBe("UNAUTHORIZED");
    });

    test("a signature of a different length is rejected without throwing", async () => {
        const gateway = jwtGateway();
        const token = makeJwt(secret, baseClaims());
        const [h, p] = token.split(".");
        const res = await gateway.authenticateRequest(req("127.0.0.1:7331"), `${h}.${p}.deadbeef`);
        expect(res.ok).toBe(false);
    });
});

/**
 * Trusted-proxy auth must FAIL CLOSED when the proxy omits the user-scopes
 * header: falling back to a hard-coded ["*"] would grant full operator scope to
 * any request that reaches the gateway without the header. An explicitly
 * configured defaultScopes is the operator's own choice and is honored.
 */
describe("gateway — trusted-proxy scope fail-closed", () => {
    test("missing scopes header with no defaultScopes is rejected (no implicit '*')", async () => {
        const gateway = makeGateway({ auth: { mode: "trusted-proxy" } });
        const res = await gateway.authenticateRequest(req("127.0.0.1:7331"), null);
        expect(res.ok).toBe(false);
        expect(res.code).toBe("UNAUTHORIZED");
    });

    test("an explicitly-configured defaultScopes is honored when the header is absent", async () => {
        const gateway = makeGateway({ auth: { mode: "trusted-proxy", defaultScopes: ["runs:read"] } });
        const res = await gateway.authenticateRequest(req("127.0.0.1:7331"), null);
        expect(res.ok).toBe(true);
        expect(res.scopes).toEqual(["runs:read"]);
    });

    test("a present scopes header is parsed and used", async () => {
        const gateway = makeGateway({ auth: { mode: "trusted-proxy" } });
        const headers = { host: "127.0.0.1:7331", "x-user-scopes": "runs:read runs:write" };
        const res = await gateway.authenticateRequest({ headers, socket: {} }, null);
        expect(res.ok).toBe(true);
        expect(res.scopes).toEqual(["runs:read", "runs:write"]);
    });
});
