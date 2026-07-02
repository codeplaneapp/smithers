import { afterEach, describe, expect, test } from "bun:test";
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
